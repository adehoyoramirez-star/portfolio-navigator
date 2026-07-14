// Paper Trading Setup: engine forward-testing desde cutoff date
// Registra decisiones diarias en un log CSV
// Ejecutar: npx tsx scripts/paper_trading.ts

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
const datesArr: string[] = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const parts = line.split(',');
  if (parts.length < headers.length) continue;
  datesArr.push(parts[0]);
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
const dates = datesArr.slice(0, minLen);

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

// ── Paper trading cutoff: test from 2025-01-01 forward ──
const cutoffDate = '2025-01-01';
const cutoffIdx = dates.findIndex(d => d >= cutoffDate);

if (cutoffIdx < 0) {
  console.log('ERROR: cutoff date ' + cutoffDate + ' not found in data');
  process.exit(1);
}

console.log('Paper Trading Setup');
console.log('Cutoff: ' + cutoffDate + ' (index ' + cutoffIdx + ')');
console.log('Data: ' + dates[0] + ' -> ' + dates[minLen-1]);
console.log('Forward period: ' + dates[cutoffIdx] + ' -> ' + dates[minLen-1]);
console.log();

// Run full backtest
const result = runBacktest({
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
});

// Extract forward period
const backtestStart = 252;
const forwardStartRecordIdx = cutoffIdx - backtestStart;

if (forwardStartRecordIdx < 0 || forwardStartRecordIdx >= result.dailyRecords.length) {
  console.log('ERROR: forward start index ' + forwardStartRecordIdx + ' out of range [0, ' + (result.dailyRecords.length-1) + ']');
  process.exit(1);
}

const forwardRecords = result.dailyRecords.slice(forwardStartRecordIdx);
console.log('Forward records: ' + forwardRecords.length);

// Compute forward metrics
const forwardReturns: number[] = [];
for (let i = 1; i < forwardRecords.length; i++) {
  const prev = forwardRecords[i-1].portfolioValue;
  const curr = forwardRecords[i].portfolioValue;
  forwardReturns.push(prev > 0 ? curr / prev - 1 : 0);
}

const m = forwardReturns.reduce((a,b)=>a+b,0)/forwardReturns.length;
const v = forwardReturns.reduce((s,x)=>s+(x-m)**2,0)/forwardReturns.length;
const s = Math.sqrt(Math.max(1e-16, v));
const forwardSharpe = (m*252 - 0.04) / (s*Math.sqrt(252));

// CAGR
let tr = 1.0;
for (const r of forwardReturns) tr *= (1+r);
const years = forwardReturns.length / 252;
const forwardCagr = tr ** (1/years) - 1;

// MaxDD
let peak = forwardRecords[0].portfolioValue;
let maxDD = 0;
for (const rec of forwardRecords) {
  if (rec.portfolioValue > peak) peak = rec.portfolioValue;
  const dd = (rec.portfolioValue - peak) / peak;
  if (dd < maxDD) maxDD = dd;
}

console.log('\n--- FORWARD METRICS (' + dates[cutoffIdx] + ' -> ' + dates[minLen-1] + ') ---');
console.log('Days: ' + forwardRecords.length);
console.log('Sharpe: ' + forwardSharpe.toFixed(3));
console.log('CAGR: ' + (forwardCagr*100).toFixed(2) + '%');
console.log('MaxDD: ' + (maxDD*100).toFixed(2) + '%');
console.log('Final value: EUR ' + forwardRecords[forwardRecords.length-1].portfolioValue.toFixed(2));
console.log('Start value: EUR ' + forwardRecords[0].portfolioValue.toFixed(2));

// Regime distribution
const regimeCount: Record<string, number> = { EXPANSION: 0, CONTRACTION: 0, CRISIS: 0 };
for (const rec of forwardRecords) {
  regimeCount[rec.regime] = (regimeCount[rec.regime] || 0) + 1;
}
console.log('Regime: EXPANSION=' + regimeCount['EXPANSION'] + ' CONTRACTION=' + regimeCount['CONTRACTION'] + ' CRISIS=' + regimeCount['CRISIS']);

// Decision log
const logPath = path.join(process.cwd(), 'paper_trading_log.csv');
const logLines: string[] = ['date,portfolioValue,drawdown,regime,allocations,rebalanceDay'];
for (let i = 0; i < forwardRecords.length; i++) {
  const rec = forwardRecords[i];
  const date = dates[backtestStart + forwardStartRecordIdx + i] || '';
  const allocs = ASSETS.map(t => t + ':' + ((rec.allocations[t]||0)*100).toFixed(1) + '%').join('|');
  const isReb = (i > 0 && forwardStartRecordIdx + i > 0 && (forwardStartRecordIdx + i) % 21 === 0) ? 'Y' : 'N';
  logLines.push(date + ',' + rec.portfolioValue.toFixed(2) + ',' + (rec.drawdown*100).toFixed(2) + '%,' + rec.regime + ',' + allocs + ',' + isReb);
}
fs.writeFileSync(logPath, logLines.join('\n'));
console.log('\nDecision log: ' + logPath + ' (' + (logLines.length-1) + ' entries)');

console.log('\nDONE');
