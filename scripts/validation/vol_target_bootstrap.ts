// ============================================================
// scripts/validation/vol_target_bootstrap.ts
// ¿La diferencia entre objetivos de vol es real o ruido?
// Bootstrap pareado por bloques de 21d sobre ΔSharpe (mismo criterio que ablation.ts).
// Ejecutar: npx tsx scripts/validation/vol_target_bootstrap.ts
// ============================================================

import { runBacktest } from '../../src/core/backtest/backtestEngine';
import { buildCanonicalDataset, deriveMacro, CFG } from './sim_core';
import { VOLATILITY_CONFIG } from '../../src/core/config/engineConfig';

const ds = buildCanonicalDataset();
const { yieldSpread, creditSpread, dxyTrend } = deriveMacro(ds);
const base = {
  closesHistory: ds.closes,
  macroHistory: { vix: ds.macro.vix, yieldSpread, creditSpread, move: ds.macro.move, dxyTrend, btcVol: ds.macro.btcVol },
  lookbackDays: CFG.lookbackDays, rebalanceDays: CFG.rebalanceDays,
  initialCapital: CFG.initialCapital, transactionCostBps: 15,
};
const cfg = VOLATILITY_CONFIG as unknown as { DEFAULT_TARGET_VOL: number };

function returns(t: number): number[] {
  cfg.DEFAULT_TARGET_VOL = t;
  const recs = runBacktest(base).dailyRecords;
  const r: number[] = [];
  for (let i = 1; i < recs.length; i++) r.push(recs[i].portfolioValue / recs[i - 1].portfolioValue - 1);
  return r;
}
function sharpe(x: number[]): number {
  const mu = x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
  const sd = Math.sqrt(x.reduce((s, v) => s + (v - mu) ** 2, 0) / Math.max(1, x.length));
  return sd > 0 ? (mu * CFG.dpy - CFG.rf) / (sd * Math.sqrt(CFG.dpy)) : 0;
}
const D = 21, B = 10000;
let seed = 42; const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function paired(a: number[], b: number[]) {
  const m = Math.min(a.length, b.length);
  const obs = sharpe(a) - sharpe(b);
  const ds2: number[] = [];
  for (let k = 0; k < B; k++) {
    const sa: number[] = [], sb: number[] = []; let total = 0;
    while (total < m) { const st = Math.floor(rand() * (m - D)); for (let j = 0; j < D && total < m; j++, total++) { sa.push(a[st + j]); sb.push(b[st + j]); } }
    ds2.push(sharpe(sa) - sharpe(sb));
  }
  ds2.sort((x, y) => x - y);
  return { obs, lo: ds2[Math.floor(B * 0.025)], hi: ds2[Math.floor(B * 0.975)], med: ds2[Math.floor(B * 0.5)] };
}

const r14 = returns(0.14), r20 = returns(0.20), r30 = returns(0.30);
cfg.DEFAULT_TARGET_VOL = 0.20;

const pairs: [string, number[], number[]][] = [
  ['30% − 20%', r30, r20],
  ['14% − 20%', r14, r20],
  ['14% − 30%', r14, r30],
];
console.log('='.repeat(92));
console.log('  BOOTSTRAP PAREADO ΔSharpe (bloques 21d, 10.000 remuestreos, semilla 42)');
console.log('='.repeat(92));
console.log(`  ${'contraste'.padEnd(12)} ${'Δ obs'.padStart(9)} ${'mediana'.padStart(9)} ${'IC95 inf'.padStart(10)} ${'IC95 sup'.padStart(10)}   veredicto`);
console.log('  ' + '-'.repeat(86));
for (const [n, a, b] of pairs) {
  const p = paired(a, b);
  const signif = (p.lo > 0 || p.hi < 0) ? 'excluye 0 → REAL' : 'incluye 0 → RUIDO';
  console.log(`  ${n.padEnd(12)} ${p.obs.toFixed(3).padStart(9)} ${p.med.toFixed(3).padStart(9)} ${p.lo.toFixed(3).padStart(10)} ${p.hi.toFixed(3).padStart(10)}   ${signif}`);
}
console.log('='.repeat(92));
