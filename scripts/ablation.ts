// Ablation Study: mide contribucion marginal de cada modulo
// Ejecutar: npx tsx scripts/ablation.ts

import fs from 'fs';
import path from 'path';
import { runBacktest } from '../src/core/backtest/backtestEngine';
import { ASSETS } from '../src/lib/constants';

const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

const closesHistory: Record<string, number[]> = {};
for (const a of ASSETS) closesHistory[a] = [];
const vixArr: number[] = [];
const tnxArr: number[] = [];
const irxArr: number[] = [];
const hygArr: number[] = [];
const lqdArr: number[] = [];
const moveArr: number[] = [];
const dxyArr: number[] = [];
const btcVolArr: number[] = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const parts = line.split(',');
  if (parts.length < headers.length) continue;
  for (const ticker of ASSETS) {
    const idx = headers.indexOf(ticker);
    if (idx !== -1) closesHistory[ticker].push(parseFloat(parts[idx]) || 0);
  }
  const vi = headers.indexOf('^VIX');
  if (vi !== -1) vixArr.push(parseFloat(parts[vi]) || 0);
  const ti = headers.indexOf('^TNX');
  if (ti !== -1) tnxArr.push(parseFloat(parts[ti]) || 0);
  const ii = headers.indexOf('^IRX');
  if (ii !== -1) irxArr.push(parseFloat(parts[ii]) || 0);
  const hi = headers.indexOf('HYG');
  if (hi !== -1) hygArr.push(parseFloat(parts[hi]) || 0);
  const li = headers.indexOf('LQD');
  if (li !== -1) lqdArr.push(parseFloat(parts[li]) || 0);
  const mi = headers.indexOf('^MOVE');
  if (mi !== -1) moveArr.push(parseFloat(parts[mi]) || 95);
  const di = headers.indexOf('DX-Y.NYB');
  if (di !== -1) dxyArr.push(parseFloat(parts[di]) || 103);
  const bi = headers.indexOf('BTC_VOL');
  if (bi !== -1) btcVolArr.push(parseFloat(parts[bi]) || 30);
}

const minLen = Math.min(
  ...ASSETS.map(t => closesHistory[t].length),
  vixArr.length, tnxArr.length, irxArr.length,
  moveArr.length, dxyArr.length, btcVolArr.length
);
for (const t of ASSETS) closesHistory[t] = closesHistory[t].slice(0, minLen);
const vix = vixArr.slice(0, minLen);
const tnx = tnxArr.slice(0, minLen);
const irx = irxArr.slice(0, minLen);
const hyg = hygArr.slice(0, minLen);
const lqd = lqdArr.slice(0, minLen);
const move = moveArr.slice(0, minLen);
const dxy = dxyArr.slice(0, minLen);
const btcVol = btcVolArr.slice(0, minLen);

const yieldSpread = tnx.map((v, i) => v - irx[i]);
const creditSpread = hyg.map((v, i) => {
  if (v > 0 && lqd[i] > 0) {
    const hygYield = 0.045 + (1 - v / 100) * 0.03;
    const lqdYield = 0.035 + (1 - lqd[i] / 100) * 0.02;
    return Math.max(1.0, Math.min(9.0, (hygYield - lqdYield) * 100));
  }
  return 2.5 + vix[i] / 20;
});
const dxyTrend: number[] = [];
for (let i = 0; i < minLen; i++) {
  if (i < 20) { dxyTrend.push(0); continue; }
  const prev = dxy[i - 20];
  const curr = dxy[i];
  dxyTrend.push(prev > 0 ? ((curr - prev) / prev) * 100 : 0);
}

const baseInput = {
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
};

// Baseline blend weights (from olympusV3 BLEND_WEIGHTS CONSERVATIVE WITH_COV)
const BASELINE_BLEND = { BL: 0.20, HRP: 0.65, MIN_VAR: 0.15 };

// Configuraciones de ablacion:
// Para cada modulo, ponemos su peso a 0 y redistribuimos a los otros
const configs: { name: string; blendWeights: Record<string,number> }[] = [
  { name: 'BASELINE', blendWeights: { ...BASELINE_BLEND } },
  { name: 'NO_HRP', blendWeights: { BL: 0.57, HRP: 0, MIN_VAR: 0.43 } },
  { name: 'NO_BL', blendWeights: { BL: 0, HRP: 0.81, MIN_VAR: 0.19 } },
  { name: 'NO_MINVAR', blendWeights: { BL: 0.24, HRP: 0.76, MIN_VAR: 0 } },
  { name: 'HRP_ONLY', blendWeights: { BL: 0, HRP: 1.0, MIN_VAR: 0 } },
  { name: 'BL_ONLY', blendWeights: { BL: 1.0, HRP: 0, MIN_VAR: 0 } },
  { name: 'MINVAR_ONLY', blendWeights: { BL: 0, HRP: 0, MIN_VAR: 1.0 } },
];

console.log('ABLATION STUDY — Olympus Engine Modules');
console.log('='.repeat(80));
console.log();

const results: any[] = [];

for (const cfg of configs) {
  console.log(`Running: ${cfg.name}...`);
  const result = runBacktest({
    ...baseInput,
    blendWeights: cfg.blendWeights,
  });
  const m = result.metrics;
  results.push({
    name: cfg.name,
    sharpe: m.sharpe,
    sortino: m.sortino,
    cagr: m.cagr,
    maxdd: m.maxDrawdown,
    calmar: m.calmar,
    volatility: m.volatility,
  });
  console.log(`  Sharpe=${m.sharpe.toFixed(3)} CAGR=${(m.cagr*100).toFixed(2)}% MaxDD=${(m.maxDrawdown*100).toFixed(1)}%`);
}

// Table
console.log();
console.log('='.repeat(90));
console.log('  RESULTS: ABLATION STUDY');
console.log('='.repeat(90));
console.log();
console.log(`  {'Config':<15} {'Sharpe':>8} {'Sortino':>8} {'CAGR':>9} {'MaxDD':>9} {'Calmar':>8} {'Vol':>8} {'dSharpe':>8}`);
console.log('  ' + '-'.repeat(74));

const baseline = results[0];
for (const r of results) {
  const dSh = r.sharpe - baseline.sharpe;
  const dCg = (r.cagr - baseline.cagr) * 100;
  const dDd = (baseline.maxdd - r.maxdd) * 100;
  console.log(`  ${r.name.padEnd(15)} ${r.sharpe.toFixed(3).padStart(8)} ${r.sortino.toFixed(3).padStart(8)} ${(r.cagr*100).toFixed(2).padStart(8)}% ${(-r.maxdd*100).toFixed(1).padStart(8)}% ${r.calmar.toFixed(3).padStart(8)} ${(r.volatility*100).toFixed(1).padStart(7)}% ${(dSh>=0?'+':'')+dSh.toFixed(3).padStart(8)}`);
}

// Module contribution analysis
console.log();
console.log('='.repeat(80));
console.log('  MODULE CONTRIBUTION (marginal impact of removing each module)');
console.log('='.repeat(80));
console.log();
console.log(`  {'Module':<12} {'dSharpe':>8} {'dCAGR(pp)':>10} {'dMaxDD(pp)':>12} {'Verdict':>20}`);
console.log('  ' + '-'.repeat(62));

const modules = [
  { name: 'HRP', idx: 1 },
  { name: 'BL', idx: 2 },
  { name: 'MinVar', idx: 3 },
];

for (const mod of modules) {
  const r = results[mod.idx];
  const dSh = r.sharpe - baseline.sharpe;
  const dCg = (r.cagr - baseline.cagr) * 100;
  const dDd = (baseline.maxdd - r.maxdd) * 100;  // positive = baseline better (less drawdown)
  let verdict = '';
  if (dSh < -0.02) verdict = 'CRITICAL (+alpha)';
  else if (dSh < -0.005) verdict = 'SIGNIFICANT';
  else if (dSh > 0.01) verdict = 'HARMFUL (remove!)';
  else verdict = 'MARGINAL';
  console.log(`  ${mod.name.padEnd(12)} ${(dSh>=0?'+':'')+dSh.toFixed(3).padStart(8)} ${(dCg>=0?'+':'')+dCg.toFixed(2).padStart(10)} ${(dDd>=0?'+':'')+dDd.toFixed(1).padStart(12)} ${verdict.padEnd(20)}`);
}

// Single-module tests
console.log();
console.log('  SINGLE-MODULE TESTS (only that module active):');
console.log(`  {'Module':<12} {'Sharpe':>8} {'CAGR':>9} {'MaxDD':>9}`);
console.log('  ' + '-'.repeat(38));
for (let i = 4; i <= 6; i++) {
  const r = results[i];
  const moduleName = i === 4 ? 'HRP only' : i === 5 ? 'BL only' : 'MinVar only';
  console.log(`  ${moduleName.padEnd(12)} ${r.sharpe.toFixed(3).padStart(8)} ${(r.cagr*100).toFixed(2).padStart(8)}% ${(-r.maxdd*100).toFixed(1).padStart(8)}%`);
}

console.log();
console.log('DONE');
