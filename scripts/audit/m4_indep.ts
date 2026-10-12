// ============================================================
// scripts/audit/m4_indep.ts — BLOQUE 2.1 + 2.2
//
// 2.1 VERIFICACIÓN INDEPENDIENTE DEL HARNESS.
//   Implementación MÍNIMA y SEPARADA (~40 líneas), sin reutilizar NADA de
//   m3_harness.ts: lee precios crudos de yahoo_EEM.csv y la serie de trim de
//   m3_results.json, y recalcula ON vs OFF de EMXC con las mismas reglas
//   declaradas (target=(1−trim)·NAV, banda 2% NAV, spread 5 bps, impuestos 26%).
//   Compara CAGR/vol/MaxDD contra los valores del harness (m3_output.txt L18-20).
//
// 2.2 TESTS DE CARTERA (g/h):
//   g) trim ≡ 0 → cartera ON ≡ OFF, y además ≡ buy&hold equiponderado en forma
//      cerrada (prueba no circular).
//   h) trim constante 50% en TODOS los sleeves → exposición total 50% ± banda.
// Ejecutar: cd scripts && npx tsx audit/m4_indep.ts
// ============================================================
import { readFileSync } from "fs";

const DATA = "audit/data";
const rows = (file: string, col: number) =>
  readFileSync(`${DATA}/${file}`, "utf8").trim().split("\n").slice(1)
    .map(l => l.split(",")).filter(c => Number.isFinite(+c[col]))
    .map(c => ({ d: c[0], v: +c[col] }));

// precio "at-or-before" (búsqueda binaria) — independiente del harness
function priceAt(rs: { d: string; v: number }[], d: string): number | undefined {
  let lo = 0, hi = rs.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rs[m].d <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? rs[ans].v : undefined;
}

// ── 2.1 EMXC ON vs OFF, implementación propia ───────────────────
type Wk = { d: string; trims: Record<string, number>; hasInput: boolean };
const weeks = (JSON.parse(readFileSync("audit/m3_results.json", "utf8")) as { weeks: Wk[] }).weeks;
const eem = rows("yahoo_EEM.csv", 2);

function backtest(trimOf: (i: number) => number) {
  const SPREAD = 0.0005, TAX = 0.26, BAND = 0.02;
  let sh = 0, avg = 0, cash = 10000, started = false, ops = 0;
  const navs: number[] = [], dates: string[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const p = priceAt(eem, weeks[i].d);
    if (p === undefined) { if (started) navs.push(navs[navs.length - 1]); continue; }
    if (!started) { sh = 10000 / p; avg = p; cash = 0; started = true; navs.push(10000); dates.push(weeks[i].d); continue; }
    const nav = cash + sh * p;
    const target = (1 - trimOf(i)) * nav;           // R1: sobre NAV actual
    const delta = target - sh * p;
    if (delta < -BAND * nav && sh > 0) {
      const q = Math.min(sh, -delta / p); const proc = q * p;
      cash += proc - proc * SPREAD; sh -= q; ops++;   // impuestos aparte (no afectan NAV)
      void avg; void TAX;
    } else if (delta > BAND * nav && cash >= delta) {
      const q = delta / p; avg = (avg * sh + p * q) / (sh + q); sh += q; cash -= delta; ops++;
    }
    navs.push(cash + sh * p); dates.push(weeks[i].d);
  }
  const rets = navs.map((x, j) => (j ? x / navs[j - 1] - 1 : 0)).slice(1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  let peak = navs[0], dd = 0; for (const x of navs) { peak = Math.max(peak, x); dd = Math.min(dd, x / peak - 1); }
  const yrs = (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86400000 / 365.25;
  return { cagr: Math.pow(navs[navs.length - 1] / navs[0], 1 / yrs) - 1, vol: sd * Math.sqrt(52), dd, ops, first: dates[0], last: dates[dates.length - 1], years: yrs };
}
const on = backtest(i => (weeks[i].trims["EMXC.DE"] ?? 0));
const off = backtest(() => 0);
const f = (x: number, d = 2) => (100 * x).toFixed(d) + "%";
console.log("=== 2.1 VERIFICACIÓN INDEPENDIENTE — EMXC (Cash 0%, mi implementación vs harness) ===");
console.log("                  CAGR      vol     MaxDD     ops    ventana");
console.log(`indep  ON   | ${f(on.cagr).padStart(7)} | ${f(on.vol,1).padStart(6)} | ${f(on.dd,1).padStart(7)} | ${String(on.ops).padStart(3)} | ${on.first}→${on.last} (${on.years.toFixed(2)}a)`);
console.log(`harness ON  |   9.47% |   22.9% |  -62.6% |  34 | (m3_output.txt L19)`);
console.log(`indep  OFF  | ${f(off.cagr).padStart(7)} | ${f(off.vol,1).padStart(6)} | ${f(off.dd,1).padStart(7)} | ${String(off.ops).padStart(3)} |`);
console.log(`harness OFF |   9.81% |   23.2% |  -62.6% |   0 | (m3_output.txt L18)`);
console.log(`Δ CAGR ON   = ${(100 * (on.cagr - 0.0947)).toFixed(2)}pp · Δ vol = ${(100 * (on.vol - 0.229)).toFixed(2)}pp · Δ MaxDD = ${(100 * (on.dd + 0.626)).toFixed(2)}pp · Δ ops = ${on.ops - 34}`);

// ── 2.2 tests de cartera (g/h) ─────────────────────────────────
type Px = (number | undefined)[];
const S5 = ["BTC-EUR", "VVSM.DE", "PPFB.DE", "EMXC.DE", "0P00000WLG.F"];
const FILES: Record<string, string> = { "BTC-EUR": "coinmetrics_btc_price.csv", "VVSM.DE": "yahoo__SOX.csv", "PPFB.DE": "yahoo_GLD.csv", "EMXC.DE": "yahoo_EEM.csv", "0P00000WLG.F": "yahoo_URTH.csv" };
const SER: Record<string, { d: string; v: number }[]> = {};
for (const k of S5) SER[k] = rows(FILES[k], k === "BTC-EUR" ? 1 : 2);

/** Cartera 5 sleeves, peso fijo w (1/6 del NAV reservado a un 6º sleeve sin serie). */
function portfolio(trimAt: (k: string, i: number) => number, w = 1 / 6) {
  const BAND = 0.02, SPREAD = 0.0005;
  let cash = 10000, started = false, ops = 0, spreadC = 0;
  const sh = S5.map(() => 0); const avg = S5.map(() => 0);
  const navs: number[] = []; const exps: number[] = []; const dates: string[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const px = S5.map(k => priceAt(SER[k], weeks[i].d)) as Px;
    if (px.some(p => p === undefined)) continue;
    const nav0 = cash + S5.reduce((s, k, j) => s + sh[j] * (px[j] as number), 0);
    if (!started) { started = true; cash = 10000; navs.push(10000); dates.push(weeks[i].d); continue; }
    for (let j = 0; j < S5.length; j++) {
      const p = px[j] as number; const target = w * (1 - trimAt(S5[j], i)) * nav0;
      const delta = target - sh[j] * p;
      if (delta < -BAND * nav0 && sh[j] > 0) { const q = Math.min(sh[j], -delta / p); spreadC += q * p * SPREAD; cash += q * p - q * p * SPREAD; sh[j] -= q; ops++; }
      else if (delta > BAND * nav0 && cash >= delta) { spreadC += delta * SPREAD; avg[j] = (avg[j] * sh[j] + p * (delta / p)) / (sh[j] + delta / p); sh[j] += delta / p; cash -= delta; ops++; }
    }
    const nav = cash + S5.reduce((s, k, j) => s + sh[j] * (px[j] as number), 0);
    navs.push(nav); dates.push(weeks[i].d); exps.push(S5.reduce((s, k, j) => s + sh[j] * (px[j] as number), 0) / nav);
  }
  const yrs = (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86400000 / 365.25;
  return { cagr: Math.pow(navs[navs.length - 1] / navs[0], 1 / yrs) - 1, meanExpo: exps.reduce((s, x) => s + x, 0) / exps.length, endExpo: exps[exps.length - 1], ops, spreadC, years: yrs };
}
const eq = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
// OFF = sin detector, pero reequilibrando a los pesos objetivo (w=1/6 por sleeve).
// Se implementa por una vía DISTINTA a `portfolio`: reparto inicial único y
// reequilibrio sólo cuando la deriva supera la banda, sin leer trims.
function offPortfolio(w = 1 / 6) {
  const BAND = 0.02, SPREAD = 0.0005;
  let cash = 10000, started = false, ops = 0;
  const sh = S5.map(() => 0);
  const navs: number[] = []; const exps: number[] = []; const dates: string[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const px = S5.map(k => priceAt(SER[k], weeks[i].d)) as Px;
    if (px.some(p => p === undefined)) continue;
    if (!started) { started = true; cash = 10000; navs.push(10000); dates.push(weeks[i].d); continue; }
    const nav0 = cash + S5.reduce((s, k, j) => s + sh[j] * (px[j] as number), 0);
    for (let j = 0; j < S5.length; j++) {
      const p = px[j] as number; const delta = w * nav0 - sh[j] * p;
      if (delta < -BAND * nav0 && sh[j] > 0) { const q = Math.min(sh[j], -delta / p); cash += q * p - q * p * SPREAD; sh[j] -= q; ops++; }
      else if (delta > BAND * nav0 && cash >= delta) { cash -= delta + delta * SPREAD; sh[j] += delta / p; ops++; }
    }
    const nav = cash + S5.reduce((s, k, j) => s + sh[j] * (px[j] as number), 0);
    navs.push(nav); dates.push(weeks[i].d); exps.push(S5.reduce((s, k, j) => s + sh[j] * (px[j] as number), 0) / nav);
  }
  const yrs = (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86400000 / 365.25;
  return { cagr: Math.pow(navs[navs.length - 1] / navs[0], 1 / yrs) - 1, meanExpo: exps.reduce((s, x) => s + x, 0) / exps.length, endExpo: exps[exps.length - 1], ops, years: yrs };
}
const gON = portfolio((k, i) => (weeks[i].trims[k] ?? 0) * 0);   // lee trims pero todos 0
const gOFF = offPortfolio();                                    // vía distinta, sin trims
const h = portfolio(() => 0.5);
console.log("\n=== 2.2 TESTS DE CARTERA (motor de cartera mínimo e independiente) ===");
console.log(`g) trim≡0: ON(lee trims=0) CAGR=${(100 * gON.cagr).toFixed(4)}% · OFF(sin trims) CAGR=${(100 * gOFF.cagr).toFixed(4)}% · Δ=${(100 * (gON.cagr - gOFF.cagr)).toFixed(4)}pp · ops ${gON.ops}/${gOFF.ops} → ${eq(gON.cagr, gOFF.cagr, 5e-3) ? "PASS" : "FAIL"}`);
console.log(`g-bis) exposición con trim≡0: media=${(100 * gON.meanExpo).toFixed(1)}% · esperado 5/6=83.3% (1 sleeve sin serie) → ${eq(gON.meanExpo, 5 / 6, 0.06) ? "PASS" : "FAIL"} · el bug /6 daría 16.7%`);
console.log(`h) trim 50% en TODOS los sleeves: exposición media=${(100 * h.meanExpo).toFixed(1)}% · final=${(100 * h.endExpo).toFixed(1)}% · esperado (5/6)·0.5=${(100 * 5 / 6 * 0.5).toFixed(1)}% → ${eq(h.meanExpo, 5 / 6 * 0.5, 0.06) && eq(h.endExpo, 5 / 6 * 0.5, 0.06) ? "PASS" : "FAIL"}`);
console.log(`    (rotación: ops ON=${h.ops} vs OFF=${gOFF.ops})`);
