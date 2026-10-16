// ============================================================
// scripts/shadow/options_shadow_snapshot.ts
// OPT-SHADOW v1.0.0 — snapshot diario de la capa de opciones (SOLO OBSERVABILIDAD).
// Especificación: scripts/validation/PREREGISTRO_OPCIONES_SOMBRA.md
//
// Qué hace: descarga Yahoo (^VIX ^VIX3M ^VVIX ^SKEW ^GSPC BTC-USD) y Deribit (DVOL),
// calcula la fila con src/core/risk/optionsVolShadow.ts y la AÑADE a
// shadow_logs/options_shadow_log.csv. No toca el motor.
//
// Política:
//   · I3  Serie que falla o sin barra en la fecha exacta → NO_DATA (nunca relleno).
//   · I4  Append-only e idempotente: si la fecha ya está en el log, no se reescribe.
//   · Solo se registran jornadas COMPLETAS (la barra de "hoy" se descarta hasta
//         las 21:00 UTC; ejecutar tras el cierre de EE. UU., ≥ 23:30 Madrid).
//
// Uso:
//   npx tsx scripts/shadow/options_shadow_snapshot.ts             # última jornada completa
//   npx tsx scripts/shadow/options_shadow_snapshot.ts --dry       # no escribe, solo imprime
//   npx tsx scripts/shadow/options_shadow_snapshot.ts --date 2026-10-15 --dry
//
// Códigos de salida: 0 OK (o fecha ya registrada) · 2 log con cabecera incompatible ·
//                    3 no se pudo determinar la fecha (^VIX no descargado)
// ============================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  OPT_SHADOW_SPEC,
  computeOptionsShadowRow,
  optionsShadowCsvHeader,
  optionsShadowCsvLine,
  type ShadowSeries,
} from "../../src/core/risk/optionsVolShadow";
import { parseYahooChart, parseDeribitDvol, type Bars } from "./optionsShadowParsers";

const ROOT = process.cwd();
const PREREGISTRO = path.join(ROOT, "scripts/validation/PREREGISTRO_OPCIONES_SOMBRA.md");
const LOG_PATH = path.join(ROOT, "shadow_logs/options_shadow_log.csv");
const UA = "Mozilla/5.0 (options-shadow snapshot)";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const dateArgIdx = args.indexOf("--date");
const DATE_ARG = dateArgIdx >= 0 ? args[dateArgIdx + 1] : null;

async function fetchJson(url: string): Promise<any> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchYahoo(ticker: string, now: Date): Promise<Bars> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`;
  return parseYahooChart(await fetchJson(url), now);
}

/** DVOL con paginación por `continuation` (docs.deribit.com): máx. 20 páginas. */
async function fetchDvol(now: Date): Promise<Bars> {
  const start = now.getTime() - 800 * 86400_000;
  let end = now.getTime();
  const all: Bars = new Map();
  for (let page = 0; page < 20; page++) {
    const url =
      "https://www.deribit.com/api/v2/public/get_volatility_index_data" +
      `?currency=BTC&start_timestamp=${start}&end_timestamp=${end}&resolution=1D`;
    const { bars, continuation } = parseDeribitDvol(await fetchJson(url), now);
    for (const [d, v] of bars) all.set(d, v);
    if (continuation === null || continuation <= start || continuation >= end) break;
    end = continuation;
  }
  return all;
}

function toSeries(bars: Record<string, Bars>): ShadowSeries {
  const all = new Set<string>();
  for (const b of Object.values(bars)) for (const d of b.keys()) all.add(d);
  const dates = [...all].sort();
  const col = (name: string) => dates.map((d) => bars[name].get(d) ?? null);
  return {
    dates,
    vix: col("vix"),
    vix3m: col("vix3m"),
    vvix: col("vvix"),
    skew: col("skew"),
    spx: col("spx"),
    btc: col("btc"),
    dvol: col("dvol"),
  };
}

async function main(): Promise<void> {
  const now = new Date();
  const preregSha = crypto
    .createHash("sha256")
    .update(fs.readFileSync(PREREGISTRO))
    .digest("hex")
    .slice(0, 16);

  const sources: Array<[string, () => Promise<Bars>]> = [
    ["vix", () => fetchYahoo("^VIX", now)],
    ["vix3m", () => fetchYahoo("^VIX3M", now)],
    ["vvix", () => fetchYahoo("^VVIX", now)],
    ["skew", () => fetchYahoo("^SKEW", now)],
    ["spx", () => fetchYahoo("^GSPC", now)],
    ["btc", () => fetchYahoo("BTC-USD", now)],
    ["dvol", () => fetchDvol(now)],
  ];

  const bars: Record<string, Bars> = {};
  const fetchErrors: string[] = [];
  const results = await Promise.allSettled(sources.map(([, f]) => f()));
  results.forEach((r, i) => {
    const name = sources[i][0];
    if (r.status === "fulfilled") bars[name] = r.value;
    else {
      bars[name] = new Map(); // I3: serie ausente, no se inventa nada
      fetchErrors.push(`${name}: ${(r.reason as Error)?.message ?? r.reason}`);
    }
  });

  // Fecha objetivo: la última jornada completa con cierre de ^VIX (o la pedida).
  const vixDays = [...bars.vix.keys()].sort();
  const asOf = DATE_ARG ?? vixDays[vixDays.length - 1];
  if (!asOf) {
    console.error("No se pudo determinar la fecha: ^VIX no descargado.", fetchErrors);
    process.exit(3);
  }

  const series = toSeries(bars);
  let idx = series.dates.indexOf(asOf);
  if (idx < 0) {
    // La fecha pedida no tiene barra en ninguna serie: se añade con todo null → NO_DATA.
    series.dates.push(asOf);
    series.dates.sort();
    const n = series.dates.length;
    for (const k of ["vix", "vix3m", "vvix", "skew", "spx", "btc", "dvol"] as const) {
      series[k] = new Array(n).fill(null);
    }
    idx = series.dates.indexOf(asOf);
  }

  const row = computeOptionsShadowRow(series, idx);
  const line = optionsShadowCsvLine(row, preregSha, now.toISOString());

  console.log(`OPT-SHADOW v${OPT_SHADOW_SPEC.version} · ${row.asOf} · prereg ${preregSha}`);
  console.log(
    `  renta variable: ${row.eqState}` +
      (row.ts !== null ? ` (VIX/VIX3M=${row.ts.toFixed(3)}` : " (") +
      (row.vrp !== null ? ` VRP=${row.vrp.toFixed(2)}` : "") +
      (row.vvixVixZ !== null ? ` zVVIX/VIX=${row.vvixVixZ.toFixed(2)}` : "") +
      (row.skewZ !== null ? ` zSKEW=${row.skewZ.toFixed(2)}` : "") +
      ")",
  );
  console.log(
    `  BTC: ${row.btcState}` +
      (row.dvol !== null ? ` (DVOL=${row.dvol.toFixed(1)}` : " (") +
      (row.vrpBtc !== null ? ` VRP=${row.vrpBtc.toFixed(2)}` : "") +
      (row.dvolZ !== null ? ` zDVOL=${row.dvolZ.toFixed(2)}` : "") +
      ")",
  );
  if (row.missing.length) console.log(`  series ausentes: ${row.missing.join(", ")}`);
  if (fetchErrors.length) console.log(`  errores de descarga: ${fetchErrors.join(" · ")}`);

  if (DRY) {
    console.log("  --dry: no se escribe el log.");
    return;
  }

  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const header = optionsShadowCsvHeader();
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, header + "\n");
  } else {
    const existing = fs.readFileSync(LOG_PATH, "utf8").split("\n");
    if (existing[0] !== header) {
      console.error("La cabecera del log no coincide con la especificación vigente; no se escribe.");
      process.exit(2);
    }
    if (existing.some((l) => l.startsWith(row.asOf + ","))) {
      console.log(`  ${row.asOf} ya está registrada (append-only): no se reescribe.`);
      return;
    }
  }
  fs.appendFileSync(LOG_PATH, line + "\n");
  console.log(`  añadida a ${path.relative(ROOT, LOG_PATH)}`);
}

main().catch((e) => {
  console.error("options_shadow_snapshot falló:", e);
  process.exit(1);
});
