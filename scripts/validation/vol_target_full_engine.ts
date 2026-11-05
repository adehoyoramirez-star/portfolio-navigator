// ============================================================
// scripts/validation/vol_target_full_engine.ts
// Barrido de DEFAULT_TARGET_VOL con el MOTOR COMPLETO (runBacktest:
// BL + HRP + Kelly + régimen + tail risk + vol target), dataset canónico.
// El config se muta SOLO en memoria del proceso: src/ no se modifica.
// Ejecutar: npx tsx scripts/validation/vol_target_full_engine.ts
// ============================================================

import { runBacktest } from '../../src/core/backtest/backtestEngine';
import { buildCanonicalDataset, deriveMacro, metrics, pct, CFG } from './sim_core';
import { VOLATILITY_CONFIG } from '../../src/core/config/engineConfig';

const TARGETS = [0.14, 0.16, 0.18, 0.20, 0.22, 0.25, 0.30];
const SPLIT = '2023-10-28';

const ds = buildCanonicalDataset();
const { yieldSpread, creditSpread, dxyTrend } = deriveMacro(ds);
const base = {
  closesHistory: ds.closes,
  macroHistory: { vix: ds.macro.vix, yieldSpread, creditSpread, move: ds.macro.move, dxyTrend, btcVol: ds.macro.btcVol },
  lookbackDays: CFG.lookbackDays, rebalanceDays: CFG.rebalanceDays,
  initialCapital: CFG.initialCapital, transactionCostBps: 15,
};

const cfg = VOLATILITY_CONFIG as unknown as { DEFAULT_TARGET_VOL: number };
const original = cfg.DEFAULT_TARGET_VOL;

function twrVals(twr: number[]): number[] { const vv = [1]; for (const r of twr) vv.push(vv[vv.length - 1] * (1 + r)); return vv; }
function slice(twr: number[], dt: string[], from: string, to: string) {
  const rs: number[] = []; const ds2: string[] = [];
  for (let i = 0; i < twr.length; i++) { const d = dt[i + 1]; if (d && d >= from && d <= to) { rs.push(twr[i]); ds2.push(d); } }
  const vals = [1]; for (const r of rs) vals.push(vals[vals.length - 1] * (1 + r));
  return metrics(rs, vals, [from, ...ds2]);
}

console.log('='.repeat(120));
console.log('  OBJETIVO DE VOLATILIDAD — MOTOR COMPLETO (runBacktest, costes 15bps, rebal 21d)');
console.log('  ' + ds.dates[0] + ' → ' + ds.dates[ds.dates.length - 1] + ' · split OOS ' + SPLIT);
console.log('='.repeat(120));
console.log(`  ${'target'.padStart(7)} ${'inv.medio'.padStart(10)} ${'días<95%'.padStart(10)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95'.padStart(8)} ${'OOS CAGR'.padStart(9)} ${'OOS Sh'.padStart(7)} ${'OOS DD'.padStart(8)} ${'Costes'.padStart(9)}`);
console.log('  ' + '-'.repeat(114));

for (const t of TARGETS) {
  cfg.DEFAULT_TARGET_VOL = t;
  const bt = runBacktest(base);
  const recs = bt.dailyRecords;
  const dates = ds.dates.slice(CFG.lookbackDays, CFG.lookbackDays + recs.length);
  const twr: number[] = [];
  for (let i = 1; i < recs.length; i++) twr.push(recs[i].portfolioValue / recs[i - 1].portfolioValue - 1);
  const vals = recs.map(r => r.portfolioValue);
  const full = metrics(twr, vals, dates);
  const oos = slice(twr, dates, SPLIT, '2030-01-01');
  const inv = recs.map(r => 1 - (r.cash ?? 0));
  const meanInv = inv.reduce((a, b) => a + b, 0) / inv.length;
  const daysBelow = inv.filter(x => x < 0.95).length / inv.length;
  console.log(`  ${(t * 100).toFixed(0).padStart(6)}% ${pct(meanInv, 1).padStart(10)} ${pct(daysBelow, 1).padStart(10)} ${pct(full.cagr).padStart(8)} ${full.sharpe.toFixed(3).padStart(7)} ${pct(full.maxDD, 1).padStart(8)} ${pct(full.cvar95).padStart(8)} ${pct(oos.cagr).padStart(9)} ${oos.sharpe.toFixed(3).padStart(7)} ${pct(oos.maxDD, 1).padStart(8)} ${('€' + bt.totalTransactionCosts.toFixed(0)).padStart(9)}`);
}
cfg.DEFAULT_TARGET_VOL = original;
console.log('='.repeat(120));
