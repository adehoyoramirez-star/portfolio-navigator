// scripts/audit/audit_c_backtest.ts — TAREA E15 + F18-22 (adversarial)
// Backtest simplificado pero declarado:
//  - Cartera equal-weight de los 6 activos del cache (remuestreada a "semanal" cada 5 días
//    para simular la cadencia del detector: semanal es la mayor frecuencia de las señales RSI-W).
//  - "Trim" = por activo, reduce exposición efectiva del activo en (1-multiplier).
//  - Sin costes ni impuestos (SUPUESTO declarado: medimos señal, no coste de ejecución).
//  - Series activadas:
//      EMXC: DXY (real del cache) — el único detector calibrable sin proxy.
//      Gold: DFII10 PROXY = TNX − IRX − 1.7pp breakeven medio proxy (declarado).
//      BTC/WLG/Semis: RSI-W (70 días hábiles = 14 semanas).
//  - Variantes: BASELINE (detectores como están), DXY-only (deadband: trim=0 hasta score>=1),
//    HISTERESIS (entrada score>=1, salida score<=0.5), TOPE30 (trim cap 30pp), NO-TRIM (OFF).
//  - Métricas: CAGR, vol, MaxDD, Calmar (por separado para cada activo y portfolio).
import { writeFileSync } from "fs";
import raw from "../validation/data_long_cache.json";
const d = (raw as any).data;
const dates: string[] = d.dates;
const closes: Record<string, number[]> = d.closes;
const macro: Record<string, number[]> = d.macro;
const n = dates.length;

type TH = [number, number][];
function smoothScore(x: number, t: TH): number {
  if (t.length === 0) return 0;
  const s = [...t].sort((a, b) => a[0] - b[0]);
  if (x <= s[0][0]) return 0;
  if (x >= s[s.length - 1][0]) return s[s.length - 1][1];
  for (let i = 0; i < s.length - 1; i++) {
    const [t1, s1] = s[i], [t2, s2] = s[i + 1];
    if (x >= t1 && x <= t2) return s1 + (s2 - s1) * (x - t1) / (t2 - t1);
  }
  return 0;
}
const multiplierFromScore = (score: number) => {
  if (score <= 0) return 1.0;
  return Math.max(0.05, Math.min(1, smoothScore(score, [[0, 1.0], [0.5, 0.75], [1.5, 0.55], [2.5, 0.35], [3.5, 0.20], [5.0, 0.10]])));
};
function rsi14(prices: number[], idx: number, period = 70): number | undefined {
  if (idx < period) return undefined;
  let g = 0, l = 0, nan = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const diff = prices[i] - prices[i - 1];
    if (!Number.isFinite(diff)) { nan++; continue; }
    if (diff > 0) g += diff; else l -= diff;
  }
  if (nan > 0) return undefined;
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / period) / (l / period));
}

// ── Cadencia: weekly (step 5 días hábiles) ──────────────────────────────
const STEP = 5;
const WEEKLY: number[] = [];
for (let t = 70; t < n - 1; t += STEP) WEEKLY.push(t);

// ── Detector de trim por activo en cada t (variante base) ───────────────
const emxcTrimSeries = (t: number) => {
  const dxy = macro.dxy?.[t];
  if (!dxy || dxy <= 50) return 0;
  const pts = dxy > 115 ? 3 : dxy > 110 ? 2.5 : dxy > 106 ? 1.5 : dxy > 103 ? 0.75 : 0;
  return 1 - multiplierFromScore(pts);
};
const goldTrimSeries = (t: number) => {
  const tnx = macro.tnx?.[t], irx = macro.irx?.[t];
  if (!tnx || !irx) return 0;
  const realProxy = tnx - irx - 1.7; // SUPUESTO: breakeven proxy medio 1.7pp
  const m = realProxy <= 0 ? 1.0 : smoothScore(realProxy, [[0, 1.0], [0.5, 0.70], [1.5, 0.45], [2.5, 0.20]]);
  return 1 - Math.max(0.05, Math.min(1, m));
};
const rsiTrimSeries = (ticker: string, thresholds: TH) => (t: number) => {
  const r = rsi14(closes[ticker], t, 70);
  if (r === undefined) return 0;
  return 1 - multiplierFromScore(smoothScore(r, thresholds));
};
const btcTrimSeries = rsiTrimSeries("BTC-EUR", [[80, 0], [85, 2]]);
const wlgTrimSeries = rsiTrimSeries("0P00000WLG.F", [[75, 1.0], [80, 1.5], [85, 2.0]]);
const semisTrimSeries = rsiTrimSeries("VVSM.DE", [[80, 0], [85, 2]]);
// Uranio no calibrable (Spot/LT no disponible en el cache) → sin señal.

const TICKERS = ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"];
const trimSeries: Record<string, (t: number) => number> = {
  "BTC-EUR": btcTrimSeries, "EMXC.DE": emxcTrimSeries, "PPFB.DE": goldTrimSeries,
  "VVSM.DE": semisTrimSeries, "0P00000WLG.F": wlgTrimSeries, "URNU.DE": () => 0,
};

// ── Variantes ───────────────────────────────────────────────────────────
type Variant = { name: string; apply: (trim: number) => number };
const VARIANTS: Variant[] = [
  { name: "OFF", apply: () => 0 },
  { name: "BASE", apply: t => t },
  { name: "DEADBAND(score>=1)", apply: t => (t <= 0.35 ? 0 : t) }, // score 0.5-0.75 → trim 25-30% aprox; deadband aprox score>=1
  { name: "TOPE30", apply: t => Math.min(t, 0.30) },
  { name: "TOPE40", apply: t => Math.min(t, 0.40) },
];

// ── Simulación ──────────────────────────────────────────────────────────
function simulate(variant: Variant) {
  const w = 1 / 6;
  // holdings (unidades) por activo; recompute weights con trim a cada step
  const shares = TICKERS.map(() => 0);
  const values: number[] = [];
  const trimsByTicker: Record<string, number[]> = {};
  let cash = 10000;
  const invested = 0;
  for (const tick of TICKERS) trimsByTicker[tick] = [];
  for (const t of WEEKLY) {
    const p = TICKERS.map(k => closes[k][t]);
    // aplicar trim: vender fracción (trim) del valor del activo a precio actual
    for (let i = 0; i < 6; i++) {
      const trim = variant.apply(trimSeries[TICKERS[i]](t));
      trimsByTicker[TICKERS[i]].push(trim);
      if (trim > 0 && shares[i] * p[i] > 0) {
        const sell = shares[i] * trim;
        cash += sell * p[i];
        shares[i] -= sell;
      }
    }
    // recompra proporcional del cash a equal weight (rebalanceo semanal simplificado)
    const pv = cash + shares.reduce((s, sh, i) => s + sh * p[i], 0);
    const targetPerAsset = pv / 6;
    for (let i = 0; i < 6; i++) {
      const cur = shares[i] * p[i];
      const diff = targetPerAsset - cur;
      if (diff > 0) {
        const buy = Math.min(diff, cash);
        shares[i] += buy / p[i];
        cash -= buy;
      } else if (diff < 0) {
        const sell = Math.min(-diff, shares[i] * p[i]);
        shares[i] -= sell / p[i];
        cash += sell;
      }
    }
    values.push(cash + shares.reduce((s, sh, i) => s + sh * p[i], 0));
  }
  // métricas
  const rets: number[] = [];
  for (let i = 1; i < values.length; i++) rets.push(values[i] / values[i - 1] - 1);
  const weeklyMean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const weeklySd = Math.sqrt(rets.reduce((s, r) => s + (r - weeklyMean) ** 2, 0) / rets.length);
  const cagr = Math.pow(values[values.length - 1] / values[0], 52 / rets.length) - 1;
  const vol = weeklySd * Math.sqrt(52);
  let peak = values[0], maxdd = 0;
  for (const v of values) { peak = Math.max(peak, v); maxdd = Math.min(maxdd, v / peak - 1); }
  const turnover = TICKERS.reduce((s, k) => s + trimsByTicker[k].filter(x => x > 0).length, 0);
  return { name: variant.name, cagr, vol, maxdd, calmar: cagr / Math.abs(maxdd), turnover, final: values[values.length - 1] };
}

console.log("=== E15: Backtest simplificado ON vs OFF (€10k, equal-weight 6 activos, weekly, sin costes) ===");
console.log("PROXY declarado: DFII10 → TNX-IRX-1.7pp; P/E, MVRV, Puell, Spot/LT NO disponibles → solo 3 activos activos + RSI-W en 3.");
console.log("");
const results = VARIANTS.map(simulate);
console.log("variante | CAGR | vol | MaxDD | Calmar | rebalanceos con trim>0 | final €");
for (const r of results) {
  console.log(`${r.name.padEnd(22)} | ${(r.cagr * 100).toFixed(2)}% | ${(r.vol * 100).toFixed(2)}% | ${(r.maxdd * 100).toFixed(2)}% | ${r.calmar.toFixed(2)} | ${r.turnover} | ${r.final.toFixed(0)}`);
}

// ── F18-F22: variantes de rediseño sobre EMXC (el activo con señal real más fuerte) ──
console.log("\n=== F18-22: variantes de rediseño sobre EMXC (DXY→trim real) ===");
function simulateEmxcOnly(variant: Variant) {
  const shares = 0;
  const cash0 = 10000;
  const emxcTrim = emxcTrimSeries;
  const prices = closes["EMXC.DE"];
  const values: number[] = [];
  let cash = cash0, sh = shares, trimCount = 0, sumTrim = 0;
  for (const t of WEEKLY) {
    const p = prices[t];
    // recompra semanal igual peso del cash disponible (deploy): 1/6 de la cartera por paso
    const pv0 = cash + sh * p;
    const deploy = Math.min(cash, pv0 / 6);
    sh += deploy / p; cash -= deploy;
    const trim = variant.apply(emxcTrim(t));
    if (trim > 0) { trimCount++; sumTrim += trim; }
    const pv = cash + sh * p;
    const targetVal = pv * (1 - trim);
    const assetVal = sh * p;
    if (assetVal > targetVal) {
      const sell = assetVal - targetVal;
      sh -= sell / p; cash += sell;
    }
    values.push(cash + sh * p);
  }
  const rets = values.map((v, i) => i === 0 ? 0 : v / values[i - 1] - 1).slice(1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const cagr = Math.pow(values[values.length - 1] / values[0], 52 / rets.length) - 1;
  const vol = sd * Math.sqrt(52);
  let peak = values[0], maxdd = 0;
  for (const v of values) { peak = Math.max(peak, v); maxdd = Math.min(maxdd, v / peak - 1); }
  return { name: variant.name, cagr, vol, maxdd, calmar: cagr / Math.abs(maxdd), n: trimCount, avgTrim: trimCount ? sumTrim / trimCount : 0 };
}
const vOff = { name: "OFF", apply: () => 0 };
const vBase = { name: "BASE", apply: t => t };
const vDead = { name: "DEADBAND", apply: t => (t <= 0.35 ? 0 : t) };
const vHyst = { name: "HISTERESIS-ON@1.0", apply: t => (t <= 0.35 ? 0 : t) }; // sin estado → aproximación
const vCap30 = { name: "TOPE30", apply: t => Math.min(t, 0.30) };
const vCap40 = { name: "TOPE40", apply: t => Math.min(t, 0.40) };
for (const v of [vOff, vBase, vDead, vCap30, vCap40]) {
  const r = simulateEmxcOnly(v);
  console.log(`EMXC ${r.name.padEnd(20)} | CAGR ${(r.cagr * 100).toFixed(2)}% | vol ${(r.vol * 100).toFixed(2)}% | MaxDD ${(r.maxdd * 100).toFixed(2)}% | Calmar ${r.calmar.toFixed(2)} | pasos trim>0: ${r.n} (media ${(r.avgTrim * 100).toFixed(1)}%)`);
}

// ── D14: rotación/trim cambios por año ─────────────────────────────────
console.log("\n=== D14: EMXC trim>0 por año (cadencia weekly) ===");
const byYear: Record<string, { active: number; total: number; avgTrim: number }> = {};
for (const t of WEEKLY) {
  const y = dates[t].slice(0, 4);
  byYear[y] ??= { active: 0, total: 0, avgTrim: 0 };
  const tr = emxcTrimSeries(t);
  byYear[y].total++;
  if (tr > 0) { byYear[y].active++; byYear[y].avgTrim += tr; }
}
console.log("año | pasos trim>0 / total | % tiempo activo | trim medio cuando activo");
for (const [y, s] of Object.entries(byYear)) {
  const pct = (100 * s.active / s.total).toFixed(0);
  const avg = s.active ? (100 * s.avgTrim / s.active).toFixed(0) : "0";
  console.log(`${y} | ${s.active}/${s.total} | ${pct}% | ${avg}%`);
}

writeFileSync("audit/audit_e_results.json", JSON.stringify({ portfolio: results, emxc: [vOff, vBase, vDead, vCap30, vCap40].map(simulateEmxcOnly), byYear }, null, 2));
console.log("\n[saved] scripts/audit/audit_e_results.json");
