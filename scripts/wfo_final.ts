// WFO FINAL: Motor Olympus old-blend vs new-blend (sin MinVar) en 8 ventanas
// Compara Sharpe/CAGR/MaxDD OOS por ventana. Incluye EW benchmark.
// Ejecutar: npx tsx scripts/wfo_final.ts

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

console.log('Datos: ' + minLen + ' dias, ' + dates[0] + ' -> ' + dates[minLen-1]);

const OLD_BLEND = { BL: 0.20, HRP: 0.65, MIN_VAR: 0.15 };
const NEW_BLEND = { BL: 0.24, HRP: 0.76, MIN_VAR: 0.00 };

const lookbackDays = 252;
const rebalanceDays = 21;
const windowIS = 297;
const windowOOS = 160;

const totalBacktestDays = minLen - lookbackDays - 1;
const windowSize = windowIS + windowOOS;
const numWindows = Math.floor(totalBacktestDays / windowSize);

console.log('Total backtest days: ' + totalBacktestDays);
console.log('Windows: ' + numWindows + ' (IS=' + windowIS + ', OOS=' + windowOOS + ')');

function runBacktestOnRange(startIdx: number, endIdx: number, blendWeights: Record<string, number>) {
  const rangeCloses: Record<string, number[]> = {};
  for (const t of ASSETS) rangeCloses[t] = closesHistory[t].slice(startIdx, endIdx);
  const rangeVix = vix.slice(startIdx, endIdx);
  const rangeYield = yieldSpread.slice(startIdx, endIdx);
  const rangeCredit = creditSpread.slice(startIdx, endIdx);
  const rangeMove = move.slice(startIdx, endIdx);
  const rangeDxy = dxyTrend.slice(startIdx, endIdx);
  const rangeBtcVol = btcVol.slice(startIdx, endIdx);

  const result = runBacktest({
    closesHistory: rangeCloses,
    macroHistory: { vix: rangeVix, yieldSpread: rangeYield, creditSpread: rangeCredit, move: rangeMove, dxyTrend: rangeDxy, btcVol: rangeBtcVol },
    lookbackDays,
    rebalanceDays,
    initialCapital: 10_000,
    transactionCostBps: 15,
    blendWeights,
  });
  const m = result.metrics;
  const bm = result.benchmarkMetrics;
  return { sharpe: m.sharpe, cagr: m.cagr, maxdd: m.maxDrawdown, sortino: m.sortino, calmar: m.calmar, vol: m.volatility, ewSharpe: bm.sharpe, ewCagr: bm.cagr, ewMaxdd: bm.maxDrawdown };
}

interface WinResult {
  w: number; sd: string; eis: string; eoos: string;
  oosOldS: number; oosOldC: number; oosOldD: number;
  oosNewS: number; oosNewC: number; oosNewD: number;
  oosEwS: number; oosEwC: number; oosEwD: number;
}

const results: WinResult[] = [];

for (let w = 0; w < numWindows && w < 8; w++) {
  const isStart = lookbackDays + w * windowSize;
  const isEnd = isStart + windowIS;
  const oosEnd = isEnd + windowOOS;
  if (oosEnd >= minLen) break;

  const sd = dates[isStart];
  const eis = dates[isEnd];
  const eoos = dates[oosEnd];
  console.log('\nWindow ' + (w+1) + ': ' + sd + ' -> IS ' + eis + ' -> OOS ' + eoos);

  const oosOld = runBacktestOnRange(isEnd, oosEnd, OLD_BLEND);
  console.log('  OLD: Sharpe=' + oosOld.sharpe.toFixed(3) + ' CAGR=' + (oosOld.cagr*100).toFixed(1) + '% DD=' + (-oosOld.maxdd*100).toFixed(1) + '% | EW Sharpe=' + oosOld.ewSharpe.toFixed(3));

  const oosNew = runBacktestOnRange(isEnd, oosEnd, NEW_BLEND);
  console.log('  NEW: Sharpe=' + oosNew.sharpe.toFixed(3) + ' CAGR=' + (oosNew.cagr*100).toFixed(1) + '% DD=' + (-oosNew.maxdd*100).toFixed(1) + '% | EW Sharpe=' + oosNew.ewSharpe.toFixed(3));

  results.push({
    w: w+1, sd, eis, eoos,
    oosOldS: oosOld.sharpe, oosOldC: oosOld.cagr, oosOldD: oosOld.maxdd,
    oosNewS: oosNew.sharpe, oosNewC: oosNew.cagr, oosNewD: oosNew.maxdd,
    oosEwS: oosOld.ewSharpe, oosEwC: oosOld.ewCagr, oosEwD: oosOld.ewMaxdd,
  });
}

console.log('\n' + '='.repeat(90));
console.log('  WFO 8 VENTANAS: Old Blend vs New Blend (sin MinVar)');
console.log('='.repeat(90));

for (const r of results) {
  const d = r.oosNewS - r.oosOldS;
  const s = d >= 0 ? '+' : '';
  console.log(' W' + r.w + ' | ' + r.sd + '->' + r.eoos + ' | OLD S=' + r.oosOldS.toFixed(3) + ' C=' + (r.oosOldC*100).toFixed(1) + '% DD=' + (-r.oosOldD*100).toFixed(1) + '% | NEW S=' + r.oosNewS.toFixed(3) + ' C=' + (r.oosNewC*100).toFixed(1) + '% DD=' + (-r.oosNewD*100).toFixed(1) + '% | EW S=' + r.oosEwS.toFixed(3) + ' | d=' + s + d.toFixed(3));
}

const meanOOSOld = results.reduce((s,r) => s+r.oosOldS, 0) / results.length;
const meanOOSNew = results.reduce((s,r) => s+r.oosNewS, 0) / results.length;
const meanOOSEW = results.reduce((s,r) => s+r.oosEwS, 0) / results.length;
const newBetter = results.filter(r => r.oosNewS > r.oosOldS).length;

console.log('\n--- AGGREGATES ---');
console.log('Mean OOS Sharpe OLD: ' + meanOOSOld.toFixed(3));
console.log('Mean OOS Sharpe NEW: ' + meanOOSNew.toFixed(3));
console.log('Mean OOS Sharpe EW:  ' + meanOOSEW.toFixed(3));
console.log('Delta NEW-OLD: ' + (meanOOSNew - meanOOSOld > 0 ? '+' : '') + (meanOOSNew - meanOOSOld).toFixed(3));
console.log('Windows NEW > OLD: ' + newBetter + '/' + results.length);

const diffs = results.map(r => r.oosNewS - r.oosOldS);
const md = diffs.reduce((s,d)=>s+d,0)/diffs.length;
const sd2 = Math.sqrt(diffs.reduce((s,d)=>s+(d-md)**2,0)/(diffs.length-1));
const t = md / (sd2 / Math.sqrt(diffs.length));
console.log('DM t-stat: ' + t.toFixed(3));

fs.writeFileSync(path.join(process.cwd(), 'wfo_final.json'), JSON.stringify({ results, aggregates: { meanOOSOld, meanOOSNew, meanOOSEW, diffs, tStat: t } }, null, 2));
console.log('\nDONE - wfo_final.json saved');
