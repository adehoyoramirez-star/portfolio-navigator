// ============================================================
// scripts/validation/opt_shadow_backtest.ts
// OPT-SHADOW v1.0.0 — backtest en histórico largo (criterios A1–A4, K1–K2).
// Especificación CONGELADA: scripts/validation/PREREGISTRO_OPCIONES_SOMBRA.md §5.
//
// NO reoptimiza nada: usa los umbrales de §3 tal cual. Si el resultado no gusta,
// la respuesta no es tocar un umbral (preregistro §9): es versión nueva + evidencia nueva.
//
// Datos: Yahoo chart API (^VIX ^VIX3M ^VVIX ^SKEW ^GSPC) desde 2006-01-01, sin relleno.
// Cache: scripts/validation/opt_shadow_cache.json (re-ejecutar sin red; borrar para refrescar).
// Cartera de referencia para A4: engine_returns.json (engineValues).
//
// Uso:   npx tsx scripts/validation/opt_shadow_backtest.ts
// Salida: tabla en consola + scripts/validation/opt_shadow_backtest_results.json
// ============================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { ShadowSeries } from "../../src/core/risk/optionsVolShadow";
import { parseYahooChart, type Bars } from "../shadow/optionsShadowParsers";
import { BT_SPEC, evaluateOptShadow, type BacktestResult, type EngineCurve, type LiftResult } from "./optShadowStats";

const ROOT = process.cwd();
const PREREGISTRO = path.join(ROOT, "scripts/validation/PREREGISTRO_OPCIONES_SOMBRA.md");
const CACHE = path.join(ROOT, "scripts/validation/opt_shadow_cache.json");
const ENGINE = path.join(ROOT, "engine_returns.json");
const OUT = path.join(ROOT, "scripts/validation/opt_shadow_backtest_results.json");
const PERIOD1 = 1136073600; // 2006-01-01
const UA = "Mozilla/5.0 (opt-shadow backtest)";

const TICKERS: Record<string, string> = {
  vix: "^VIX", vix3m: "^VIX3M", vvix: "^VVIX", skew: "^SKEW", spx: "^GSPC",
};

async function fetchBars(ticker: string): Promise<Bars> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${PERIOD1}&period2=9999999999&interval=1d`;
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseYahooChart(await res.json(), new Date());
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`${ticker}: ${(last as Error)?.message ?? last}`);
}

async function loadBars(): Promise<Record<string, Bars>> {
  if (fs.existsSync(CACHE)) {
    const raw = JSON.parse(fs.readFileSync(CACHE, "utf8")) as Record<string, Array<[string, number]>>;
    const out: Record<string, Bars> = {};
    for (const k of Object.keys(TICKERS)) out[k] = new Map(raw[k] ?? []);
    console.log(`Datos desde caché (${path.relative(ROOT, CACHE)}).`);
    return out;
  }
  const out: Record<string, Bars> = {};
  for (const [k, t] of Object.entries(TICKERS)) {
    out[k] = await fetchBars(t); // sin try/catch: una serie ausente invalida el backtest (I3)
    console.log(`  ${t}: ${out[k].size} barras`);
  }
  const raw: Record<string, Array<[string, number]>> = {};
  for (const k of Object.keys(out)) raw[k] = [...out[k].entries()];
  fs.writeFileSync(CACHE, JSON.stringify(raw));
  return out;
}

function buildSeries(bars: Record<string, Bars>): ShadowSeries {
  const dates = [...bars.spx.keys()].sort(); // calendario de ^GSPC
  const col = (k: string) => dates.map((d) => bars[k].get(d) ?? null);
  const nulls = () => new Array<number | null>(dates.length).fill(null);
  return {
    dates,
    vix: col("vix"), vix3m: col("vix3m"), vvix: col("vvix"), skew: col("skew"), spx: col("spx"),
    btc: nulls(), dvol: nulls(), // BTC fuera de alcance de este backtest (muestra corta)
  };
}

function loadEngine(): EngineCurve | undefined {
  if (!fs.existsSync(ENGINE)) {
    console.warn("engine_returns.json no encontrado: A4 quedará NO_CONCLUYENTE.");
    return undefined;
  }
  const j = JSON.parse(fs.readFileSync(ENGINE, "utf8"));
  if (!Array.isArray(j.dates) || !Array.isArray(j.engineValues) || j.dates.length !== j.engineValues.length) {
    throw new Error("engine_returns.json: dates/engineValues ausentes o desalineados");
  }
  return { dates: j.dates, values: j.engineValues };
}

const pct = (x: number | null, d = 1) => (x === null ? "—" : (x * 100).toFixed(d) + "%");
const f2 = (x: number | null) => (x === null ? "—" : x.toFixed(2));

function liftLine(name: string, r: LiftResult): string {
  return (
    `${name.padEnd(30)} n_estado=${String(r.nState).padStart(4)}/${String(r.nBase).padEnd(5)} ` +
    `P(E|estado)=${pct(r.pState).padStart(6)} P(E|base)=${pct(r.pBase).padStart(6)} ` +
    `lift=${f2(r.lift).padStart(5)} IC=[${f2(r.lo)}, ${f2(r.hi)}]`
  );
}

function printReport(r: BacktestResult): void {
  const s = r.sample;
  console.log("\n══ OPT-SHADOW v1.0.0 · BACKTEST HISTÓRICO LARGO ══");
  console.log(`Muestra: ${s.firstDate} → ${s.lastDate} · filas ${s.rows} · evaluables ${s.evaluable}`);
  console.log(`P(E) base = ${pct(s.baseRateE)} · días CONFIRM ${s.confirmDays} · episodios CONFIRM ${s.confirmEpisodes}`);
  console.log("Estados (% de filas): " + Object.entries(s.stateShare).map(([k, v]) => `${k} ${pct(v)}`).join(" · "));
  console.log("\nPRIMARIOS");
  console.log(`A1 ${r.a1.verdict.padEnd(15)} ${liftLine("CONFIRM", r.a1)}`);
  console.log(`A2 ${r.a2.verdict.padEnd(15)} ${liftLine("CONFIRM | VIX<25", r.a2)}`);
  console.log(`A3 ${r.a3.verdict.padEnd(15)} falsos positivos ${r.a3.falsePositives}/${r.a3.episodes} = ${pct(r.a3.rate)} (máx ${pct(BT_SPEC.falsePositiveMax, 0)})`);
  console.log(
    `A4 ${r.a4.verdict.padEnd(15)} cruces L1: ${r.a4.n} · mediana adelanto ${r.a4.medianLead ?? "—"} jornadas` +
      (r.a4.descriptiveOnly ? " (n<5: solo descriptivo)" : ""),
  );
  for (const c of r.a4.crossings) console.log(`     ${c.date}: ${c.warned ? `aviso con ${c.lead} jornadas` : "sin aviso"}`);
  console.log("\nEXPLORATORIOS (IC99, Bonferroni)");
  for (const [k, v] of Object.entries(r.exploratory)) console.log(liftLine(k, v));
  console.log(`\nKill: K1 (A2 falla) = ${r.kill.K1 ? "SÍ → descartar capa" : "no"} · K2 (A3 falla) = ${r.kill.K2 ? "SÍ → descartar capa" : "no"}`);
  console.log("Aviso: ventanas solapadas → IC por bootstrap de bloques; E es un evento raro, la potencia es limitada.");
}

async function main(): Promise<void> {
  const preregSha = crypto.createHash("sha256").update(fs.readFileSync(PREREGISTRO)).digest("hex").slice(0, 16);
  const bars = await loadBars();
  const series = buildSeries(bars);
  const engine = loadEngine();
  console.log(`Preregistro ${preregSha} · serie ${series.dates[0]} → ${series.dates[series.dates.length - 1]} (${series.dates.length} jornadas)`);
  const result = evaluateOptShadow(series, engine);
  printReport(result);
  fs.writeFileSync(OUT, JSON.stringify({ preregSha, spec: BT_SPEC, generatedAt: new Date().toISOString(), result }, null, 2));
  console.log(`\nResultados → ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error("opt_shadow_backtest falló:", e);
  process.exit(1);
});
