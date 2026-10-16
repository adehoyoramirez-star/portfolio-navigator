// ============================================================
// src/test/optionsVolShadow.test.ts
// OPT-SHADOW v1.0.0 — tests del módulo sombra y de sus invariantes (preregistro §1).
// ============================================================
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  OPT_SHADOW_SPEC,
  OPT_SHADOW_CSV_COLUMNS,
  computeOptionsShadowRow,
  optionsShadowCsvHeader,
  optionsShadowCsvLine,
  realizedVolPct,
  zScore,
  type ShadowSeries,
} from "../core/risk/optionsVolShadow";

// ── Generadores deterministas ────────────────────────────────────────────
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296; // [0,1)
  };
}

function isoDates(n: number, start = "2025-01-01"): string[] {
  const out: string[] = [];
  const t0 = Date.parse(start + "T00:00:00Z");
  for (let i = 0; i < n; i++) out.push(new Date(t0 + i * 86400_000).toISOString().slice(0, 10));
  return out;
}

/** Mercado tranquilo: VIX≈15, VIX3M≈17 (contango), VVIX≈85, SKEW≈120, SPX y BTC con ruido pequeño. */
function calmSeries(n: number, seed = 7): ShadowSeries {
  const r = lcg(seed);
  const dates = isoDates(n);
  const vix: number[] = [];
  const vix3m: number[] = [];
  const vvix: number[] = [];
  const skew: number[] = [];
  const spx: number[] = [];
  const btc: number[] = [];
  const dvol: number[] = [];
  let sp = 5000;
  let bt = 60000;
  for (let i = 0; i < n; i++) {
    vix.push(15 + (r() - 0.5));
    vix3m.push(17 + (r() - 0.5));
    vvix.push(85 + 4 * (r() - 0.5));
    skew.push(120 + 4 * (r() - 0.5));
    sp *= Math.exp(0.0005 + 0.004 * (r() - 0.5));
    bt *= Math.exp(0.0005 + 0.01 * (r() - 0.5));
    spx.push(sp);
    btc.push(bt);
    dvol.push(50 + 4 * (r() - 0.5));
  }
  return { dates, vix, vix3m, vvix, skew, spx, btc, dvol };
}

const clone = (s: ShadowSeries): ShadowSeries => ({
  dates: [...s.dates],
  vix: [...s.vix], vix3m: [...s.vix3m], vvix: [...s.vvix], skew: [...s.skew],
  spx: [...s.spx], btc: [...s.btc], dvol: [...s.dvol],
});

// ── Matemática base ──────────────────────────────────────────────────────
describe("zScore / realizedVolPct", () => {
  it("zScore devuelve null con dispersión 0 o historia insuficiente", () => {
    expect(zScore(5, [3, 3, 3, 3])).toBeNull();
    expect(zScore(5, [3])).toBeNull();
  });

  it("zScore usa desviación muestral (n-1)", () => {
    const hist = [1, 2, 3, 4, 5];
    const sd = Math.sqrt(10 / 4); // sum((x-3)^2)=10, n-1=4
    expect(zScore(5, hist)).toBeCloseTo((5 - 3) / sd, 12);
  });

  it("realizedVolPct coincide con la fórmula (retornos ±1%, n-1, √252)", () => {
    const rets = [0.01, -0.01, 0.01, -0.01];
    const closes = [100];
    for (const r of rets) closes.push(closes[closes.length - 1] * Math.exp(r));
    const expected = Math.sqrt(4e-4 / 3) * Math.sqrt(252) * 100;
    expect(realizedVolPct(closes, 252)).toBeCloseTo(expected, 10);
  });
});

// ── Estados renta variable ───────────────────────────────────────────────
describe("computeOptionsShadowRow — renta variable", () => {
  const N = 300;

  it("mercado tranquilo → CALM sin flags", () => {
    const s = calmSeries(N);
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.eqState).toBe("CALM");
    expect(row.flags.tsBackwardation).toBe(false);
    expect(row.missing).toEqual([]);
    expect(row.ts).toBeCloseTo((row.vix as number) / (row.vix3m as number), 12);
  });

  it("solo backwardation → WATCH", () => {
    const s = calmSeries(N);
    s.vix[N - 1] = 18;
    s.vix3m[N - 1] = 16.5; // ts = 1.09
    // vvix/vix baja (z negativo) y skew normal → sin otros flags
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.flags.tsBackwardation).toBe(true);
    expect(row.flags.vvixVixZ).toBe(false);
    expect(row.flags.skewZ).toBe(false);
    expect(row.flags.vrpNegativa).toBe(false);
    expect(row.eqState).toBe("WATCH");
  });

  it("backwardation + SKEW z>=2 → CONFIRM", () => {
    const s = calmSeries(N);
    s.vix[N - 1] = 18;
    s.vix3m[N - 1] = 16.5;
    s.skew[N - 1] = 140; // muy por encima de 120±2
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.skewZ as number).toBeGreaterThanOrEqual(OPT_SHADOW_SPEC.zThreshold);
    expect(row.eqState).toBe("CONFIRM");
  });

  it("SKEW alto sin backwardation → WATCH, no CONFIRM", () => {
    const s = calmSeries(N);
    s.skew[N - 1] = 140;
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.flags.tsBackwardation).toBe(false);
    expect(row.eqState).toBe("WATCH");
  });

  it("I3: serie ausente → NO_DATA y jamás CALM", () => {
    const s = calmSeries(N);
    s.vix3m[N - 1] = null;
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.eqState).toBe("NO_DATA");
    expect(row.missing).toContain("vix3m");
    expect(row.ts).toBeNull();
  });

  it("valores no positivos o no finitos cuentan como ausentes", () => {
    const s = calmSeries(N);
    s.vvix[N - 1] = 0;
    s.skew[N - 1] = Number.NaN;
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.eqState).toBe("NO_DATA");
    expect(row.missing).toEqual(expect.arrayContaining(["vvix", "skew"]));
  });

  it("historia insuficiente → INSUFFICIENT_HISTORY", () => {
    const s = calmSeries(100);
    const row = computeOptionsShadowRow(s, 99);
    expect(row.eqState).toBe("INSUFFICIENT_HISTORY");
    expect(row.vvixVixZ).toBeNull();
  });

  it("I5: añadir datos futuros no cambia la fila de la fecha t", () => {
    const base = calmSeries(N);
    const i = 280;
    const a = computeOptionsShadowRow(base, i);
    const future = clone(base);
    for (let k = i + 1; k < N; k++) {
      future.vix[k] = 80; future.vix3m[k] = 40; future.vvix[k] = 200;
      future.skew[k] = 180; future.spx[k] = 1; future.btc[k] = 1; future.dvol[k] = 300;
    }
    expect(computeOptionsShadowRow(future, i)).toEqual(a);
  });

  it("el z-score excluye el propio día t de su ventana", () => {
    const s = calmSeries(N);
    s.skew[N - 1] = 140;
    const row = computeOptionsShadowRow(s, N - 1);
    const hist = s.skew.slice(N - 1 - OPT_SHADOW_SPEC.zWindow, N - 1) as number[];
    expect(row.skewZ).toBeCloseTo(zScore(140, hist) as number, 12);
  });

  it("determinismo: dos llamadas idénticas dan resultado idéntico", () => {
    const s = calmSeries(N);
    expect(computeOptionsShadowRow(s, N - 1)).toEqual(computeOptionsShadowRow(s, N - 1));
  });

  it("errores de programación lanzan excepción", () => {
    const s = calmSeries(10);
    expect(() => computeOptionsShadowRow(s, 10)).toThrow();
    expect(() => computeOptionsShadowRow(s, -1)).toThrow();
    const bad = clone(s);
    bad.vix.pop();
    expect(() => computeOptionsShadowRow(bad, 5)).toThrow(/longitud/);
    const unsorted = clone(s);
    unsorted.dates[3] = unsorted.dates[2];
    expect(() => computeOptionsShadowRow(unsorted, 5)).toThrow(/ascendente/);
  });
});

// ── BTC ──────────────────────────────────────────────────────────────────
describe("computeOptionsShadowRow — BTC", () => {
  const N = 300;

  it("DVOL z>=2 y VRP BTC negativa → CONFIRM", () => {
    const s = calmSeries(N);
    s.dvol[N - 1] = 90;
    // últimos 31 cierres con movimientos ±6% diarios → RV30 ≈ 114 > 90
    let px = 60000;
    for (let k = N - 31; k < N; k++) {
      px *= Math.exp(k % 2 === 0 ? 0.06 : -0.06);
      s.btc[k] = px;
    }
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.dvolZ as number).toBeGreaterThanOrEqual(OPT_SHADOW_SPEC.zThreshold);
    expect(row.vrpBtc as number).toBeLessThan(0);
    expect(row.btcState).toBe("CONFIRM");
  });

  it("solo una condición → WATCH; ninguna → CALM", () => {
    const s = calmSeries(N);
    expect(computeOptionsShadowRow(s, N - 1).btcState).toBe("CALM");
    s.dvol[N - 1] = 90; // z alto, RV30 pequeña → VRP positiva
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.flags.dvolZ).toBe(true);
    expect(row.flags.vrpBtcNegativa).toBe(false);
    expect(row.btcState).toBe("WATCH");
  });

  it("DVOL ausente → btc NO_DATA pero renta variable sigue calculándose", () => {
    const s = calmSeries(N);
    s.dvol[N - 1] = null;
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.btcState).toBe("NO_DATA");
    expect(row.eqState).toBe("CALM");
    expect(row.missing).toEqual(["dvol"]);
  });

  it("DVOL con poca historia → INSUFFICIENT_HISTORY", () => {
    const s = calmSeries(N);
    for (let k = 0; k < N - 100; k++) s.dvol[k] = null;
    const row = computeOptionsShadowRow(s, N - 1);
    expect(row.btcState).toBe("INSUFFICIENT_HISTORY");
  });
});

// ── CSV ──────────────────────────────────────────────────────────────────
describe("CSV", () => {
  it("la línea tiene tantas celdas como columnas de la cabecera y null → vacío", () => {
    const s = calmSeries(100);
    s.vix3m[99] = null;
    const row = computeOptionsShadowRow(s, 99);
    const line = optionsShadowCsvLine(row, "abc123", "2026-10-16T21:30:00.000Z");
    expect(line.split(",").length).toBe(OPT_SHADOW_CSV_COLUMNS.length);
    expect(optionsShadowCsvHeader().split(",").length).toBe(OPT_SHADOW_CSV_COLUMNS.length);
    expect(line.startsWith(row.asOf + "," + OPT_SHADOW_SPEC.version + ",abc123,vix3m,")).toBe(true);
    expect(line).toContain("NO_DATA");
  });
});

// ── I1: aislamiento ──────────────────────────────────────────────────────
describe("I1 aislamiento del motor", () => {
  const SRC = path.resolve(__dirname, "..");
  const MODULE = path.join(SRC, "core/risk/optionsVolShadow.ts");
  const ALLOWED = new Set([
    MODULE,
    path.join(SRC, "test/optionsVolShadow.test.ts"),
    path.join(SRC, "test/optionsShadowParsers.test.ts"),
    path.join(SRC, "test/optShadowStats.test.ts"),
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("ningún archivo de src/ (salvo el módulo y sus tests) importa optionsVolShadow", () => {
    const offenders = walk(SRC)
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => /optionsVolShadow/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("el módulo no importa nada (es una librería pura)", () => {
    const code = fs.readFileSync(MODULE, "utf8");
    expect(/^\s*import\s/m.test(code)).toBe(false);
    expect(/\brequire\(/.test(code)).toBe(false);
  });
});
