// ============================================================
// scripts/validation/ablation.ts
// FASE 2B · TEST 2 — Ablación vs alternativas simples (criterio PREREGISTRADO §6):
//   V5 se justifica solo si Sharpe_OOS(V5) > Sharpe_OOS(V3) Y MaxDD_OOS(V5) mejor
//   Y el IC95 del ΔSharpe (bootstrap bloques 21d pareado) excluye 0.
//   V1 equal · V2 HRP estático · V3 HRP+volTarget · V4 V3+tailRisk · V5 motor
//   V5' shadow del motor (control) · V6 B&H equal-weight con costes.
// Ejecutar: npx tsx scripts/validation/ablation.ts
// ============================================================

import { buildCanonicalDataset, runEngine, shadowSim, metrics, pct, CFG, deriveMacro } from './sim_core';
import { computeHRP } from '../../src/core/risk/hrp';
import { computeVolTargetMultiplier } from '../../src/core/risk/volatilityTarget';
import { computeTailRiskOverlay } from '../../src/core/risk/tailRisk';
import { ASSETS } from '../../src/lib/constants';

const ds = buildCanonicalDataset();
const R = runEngine(ds);
const { dates, closes } = ds;
const N = ASSETS.length;
const SPLIT = '2023-10-28';
const { creditSpread } = deriveMacro(ds);
const REC = R.recs.length;

function retWindow(a: string, di: number, w: number): number[] {
  const r: number[] = [];
  for (let i = Math.max(1, di - w + 1); i <= di; i++) r.push(closes[a][i] / closes[a][i - 1] - 1);
  return r;
}
function covAt(di: number, w: number): number[][] {
  const rs = ASSETS.map(a => retWindow(a, di, w));
  const m = rs[0].length;
  const means = rs.map(x => x.reduce((s, v) => s + v, 0) / m);
  const C: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { let s = 0; for (let k = 0; k < m; k++) s += (rs[i][k] - means[i]) * (rs[j][k] - means[j]); C[i][j] = s / m; }
  return C;
}
function portVolAt(weights: number[], di: number, w: number): number {
  const C = covAt(di, w); let v = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) v += weights[i] * weights[j] * C[i][j];
  return Math.sqrt(Math.max(0, v) * CFG.dpy);
}
function avgCorrAt(di: number, w: number): number {
  const C = covAt(di, w); let s = 0, c = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const d = Math.sqrt(C[i][i] * C[j][j]); if (d > 0) { s += C[i][j] / d; c++; } }
  return c ? s / c : 0;
}
const mkTarget = (w: number[], mult = 1): Record<string, number> => { const t: Record<string, number> = {}; ASSETS.forEach((a, i) => t[a] = w[i] * mult); return t; };

// ── V1 / V2 / V3 / V4 targets ──
const t1: Record<string, number>[] = new Array(REC).fill(0).map(() => mkTarget(new Array(N).fill(1 / N)));
const hrp0 = computeHRP(covAt(CFG.lookbackDays, 252), N).weights;
const t2: Record<string, number>[] = new Array(REC).fill(0).map(() => mkTarget(hrp0));
const t3: Record<string, number>[] = []; const t4: Record<string, number>[] = [];
let idx4 = 1, peak4 = 1;
let cur3: Record<string, number> | null = null, cur4: Record<string, number> | null = null;
for (let k = 0; k < REC; k++) {
  const di = CFG.lookbackDays + k;
  if (k % 21 === 0) {
    const w = computeHRP(covAt(di, 252), N).weights;
    const vt = computeVolTargetMultiplier({ targetVol: 0.20, realizedVol: portVolAt(w, di, 63), regimePenalty: 1.0 }).multiplier;
    cur3 = mkTarget(w, vt);
    const dd4 = idx4 / peak4 - 1;
    const tr = computeTailRiskOverlay({ drawdown: dd4, vix: ds.macro.vix[di], creditSpread: creditSpread[di], stressScore: 0, portfolioVolatility: portVolAt(w, di, 63), avgCorrelation: avgCorrAt(di, 63) });
    cur4 = mkTarget(w, vt * tr.overlay);
  }
  t3.push({ ...cur3! }); t4.push({ ...cur4! });
  if (k > 0) {
    const r = ASSETS.reduce((s, a) => s + (t4[k][a] ?? 0) * (closes[a][di] / closes[a][di - 1] - 1), 0);
    idx4 *= (1 + r); if (idx4 > peak4) peak4 = idx4;
  }
}

// ── Shadow-sims ──
const s1 = shadowSim(ds, t1); const s2 = shadowSim(ds, t2); const s3 = shadowSim(ds, t3); const s4 = shadowSim(ds, t4);
const s5p = shadowSim(ds, R.recs.map(r => r.allocations as Record<string, number>));
const s6 = shadowSim(ds, t1, { rebalanceEvery: 1_000_000_000 });

function twrVals(twr: number[]): number[] { const vv = [1]; for (const r of twr) vv.push(vv[vv.length - 1] * (1 + r)); return vv; }
function slice(twr: number[], dt: string[], from: string, to: string) {
  const rs: number[] = []; const ds2: string[] = [];
  for (let i = 0; i < twr.length; i++) { const d = dt[i + 1]; if (d >= from && d <= to) { rs.push(twr[i]); ds2.push(d); } }
  const vals = [1]; for (const r of rs) vals.push(vals[vals.length - 1] * (1 + r));
  return metrics(rs, vals, [from, ...ds2]);
}
function table(twr: number[], dt: string[]) {
  return {
    full: metrics(twr, twrVals(twr), dt),
    is: slice(twr, dt, '2000-01-01', '2023-10-27'),
    oos: slice(twr, dt, SPLIT, '2030-01-01'),
  };
}
const variants: [string, number[], string[], number][] = [
  ['V1 equal-weight', s1.twr, s1.dates, s1.costs],
  ['V2 HRP estático', s2.twr, s2.dates, s2.costs],
  ['V3 HRP+volTarget', s3.twr, s3.dates, s3.costs],
  ['V4 V3+tailRisk/KS', s4.twr, s4.dates, s4.costs],
  ['V5 MOTOR (runBacktest)', R.twr, R.dates, 0],
  ["V5' shadow del motor", s5p.twr, s5p.dates, s5p.costs],
  ['V6 B&H equal (costes)', s6.twr, s6.dates, s6.costs],
];

console.log('='.repeat(122));
console.log('  TEST 2 — ABLACIÓN (harness común: €10k, rebalanceo 21d, costes reales, TWR)');
console.log('='.repeat(122));
console.log(`  ${'Variante'.padEnd(24)} ${'FULL CAGR'.padStart(10)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95'.padStart(8)} ${'IS Sh'.padStart(7)} ${'OOS Sh'.padStart(7)} ${'OOS CAGR'.padStart(9)} ${'OOS DD'.padStart(8)} ${'Costes'.padStart(8)}`);
console.log('  ' + '-'.repeat(118));
const tab: Record<string, ReturnType<typeof table>> = {};
for (const [n, twr, dt, c] of variants) {
  const t = table(twr, dt); tab[n] = t;
  console.log(`  ${n.padEnd(24)} ${pct(t.full.cagr).padStart(10)} ${t.full.sharpe.toFixed(3).padStart(7)} ${pct(t.full.maxDD, 1).padStart(8)} ${pct(t.full.cvar95).padStart(8)} ${t.is.sharpe.toFixed(3).padStart(7)} ${t.oos.sharpe.toFixed(3).padStart(7)} ${pct(t.oos.cagr).padStart(9)} ${pct(t.oos.maxDD, 1).padStart(8)} ${('€' + c.toFixed(0)).padStart(8)}`);
}

// ── Bootstrap pareado ΔSharpe (V5 − V3) en OOS ──
function sharpe(x: number[]): number {
  const mu = x.reduce((a, b) => a + b, 0) / x.length;
  const sd = Math.sqrt(x.reduce((s, r) => s + (r - mu) ** 2, 0) / x.length);
  return sd > 0 ? (mu * CFG.dpy - CFG.rf) / (sd * Math.sqrt(CFG.dpy)) : 0;
}
const oosStart = (dt: string[]) => dt.findIndex((d, i) => i > 0 && d >= SPLIT) - 1;
const r5 = R.twr.slice(oosStart(R.dates)); const r3 = s3.twr.slice(oosStart(s3.dates));
const D = 21, B = 10000;
let seed = 42; const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const m = Math.min(r5.length, r3.length);
const deltas: number[] = [];
for (let b = 0; b < B; b++) {
  const s5: number[] = [], s3b: number[] = []; let total = 0;
  while (total < m) { const st = Math.floor(rand() * (m - D)); for (let j = 0; j < D && total < m; j++, total++) { s5.push(r5[st + j]); s3b.push(r3[st + j]); } }
  deltas.push(sharpe(s5) - sharpe(s3b));
}
deltas.sort((a, b) => a - b);
const lo = deltas[Math.floor(B * 0.025)], hi = deltas[Math.floor(B * 0.975)];
const med = deltas[Math.floor(B * 0.5)];

const v5 = tab['V5 MOTOR (runBacktest)'], v3 = tab['V3 HRP+volTarget'];
const cond1 = v5.oos.sharpe > v3.oos.sharpe;
const cond2 = v5.oos.maxDD > v3.oos.maxDD;
const cond3 = lo > 0 || hi < 0;
console.log(`\n── CRITERIO PREREGISTRADO (V5 vs V3, OOS) ──`);
console.log(`  Sharpe OOS: V5 ${v5.oos.sharpe.toFixed(3)} vs V3 ${v3.oos.sharpe.toFixed(3)} → ${cond1 ? 'CUMPLE' : 'NO CUMPLE'}`);
console.log(`  MaxDD  OOS: V5 ${pct(v5.oos.maxDD, 1)} vs V3 ${pct(v3.oos.maxDD, 1)} → ${cond2 ? 'CUMPLE' : 'NO CUMPLE'}`);
console.log(`  Bootstrap ΔSharpe (V5−V3) OOS: mediana ${med.toFixed(3)} · IC95 [${lo.toFixed(3)}, ${hi.toFixed(3)}] → ${cond3 ? 'excluye 0 (CUMPLE)' : 'incluye 0 (NO CUMPLE)'}`);
console.log(`\n  VEREDICTO: ${cond1 && cond2 && cond3 ? 'ADOPTAR V5 (motor justificado)' : 'SIMPLIFICAR — V3 no es superado en los tres criterios'}`);
