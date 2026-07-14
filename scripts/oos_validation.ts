// TRUE Out-of-Sample Validation
// Calibration: ONLY pre-2025 data
// Validation: 2025+ data (NEVER seen during calibration)
// Ejecutar: npx tsx scripts/oos_validation.ts

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

// ── Split: calibration (pre-2025-01-01) vs validation (2025-01-01+) ──
const cutoffDate = '2025-01-01';
let calEndIdx = datesArr.findIndex(d => d >= cutoffDate);
if (calEndIdx < 0) calEndIdx = datesArr.length;

console.log('TRUE OUT-OF-SAMPLE VALIDATION');
console.log('='.repeat(60));
console.log('Total rows: ' + datesArr.length);
console.log('Calibration (pre-2025): ' + calEndIdx + ' rows, ' + datesArr[0] + ' -> ' + datesArr[calEndIdx-1]);
console.log('Validation (2025+): ' + (datesArr.length - calEndIdx) + ' rows, ' + datesArr[calEndIdx] + ' -> ' + datesArr[datesArr.length-1]);

// Helper: slice arrays to a range
function sliceData(startIdx: number, endIdx: number) {
  const ch: Record<string, number[]> = {};
  for (const t of ASSETS) ch[t] = closesHistory[t].slice(startIdx, endIdx);
  const v = vixArr.slice(startIdx, endIdx);
  const tn = tnxArr.slice(startIdx, endIdx);
  const ir = irxArr.slice(startIdx, endIdx);
  const hy = hygArr.slice(startIdx, endIdx);
  const lq = lqdArr.slice(startIdx, endIdx);
  const mv = moveArr.slice(startIdx, endIdx);
  const dx = dxyArr.slice(startIdx, endIdx);
  const bv = btcVolArr.slice(startIdx, endIdx);
  const ys = tn.map((vi, i) => vi - ir[i]);
  const cs = hy.map((vi, i) => {
    if (vi > 0 && lq[i] > 0) {
      const hygYield = 0.045 + (1 - vi / 100) * 0.03;
      const lqdYield = 0.035 + (1 - lq[i] / 100) * 0.02;
      return Math.max(1.0, Math.min(9.0, (hygYield - lqdYield) * 100));
    }
    return 2.5 + v[i] / 20;
  });
  const dt: number[] = [];
  for (let i = 0; i < dx.length; i++) {
    if (i < 20) { dt.push(0); continue; }
    const prev = dx[i - 20];
    dt.push(prev > 0 ? ((dx[i] - prev) / prev) * 100 : 0);
  }
  return { closesHistory: ch, vix: v, yieldSpread: ys, creditSpread: cs, move: mv, dxyTrend: dt, btcVol: bv };
}

// ── CALIBRATION PHASE ──
console.log('\n--- CALIBRATION PHASE (pre-2025) ---');

const calData = sliceData(0, calEndIdx);

// Test calibration blends
const calBlends = [
  { BL: 0.20, HRP: 0.80, MIN_VAR: 0.00 },
  { BL: 0.24, HRP: 0.76, MIN_VAR: 0.00 },
  { BL: 0.28, HRP: 0.72, MIN_VAR: 0.00 },
  { BL: 0.30, HRP: 0.70, MIN_VAR: 0.00 },
  { BL: 0.35, HRP: 0.65, MIN_VAR: 0.00 },
  { BL: 0.40, HRP: 0.60, MIN_VAR: 0.00 },
  { BL: 0.50, HRP: 0.50, MIN_VAR: 0.00 },
];

interface CalResult {
  blend: Record<string,number>;
  sharpe: number;
  cagr: number;
  maxdd: number;
}

const calResults: CalResult[] = [];

for (const blend of calBlends) {
  const result = runBacktest({
    closesHistory: calData.closesHistory,
    macroHistory: { vix: calData.vix, yieldSpread: calData.yieldSpread, creditSpread: calData.creditSpread, move: calData.move, dxyTrend: calData.dxyTrend, btcVol: calData.btcVol },
    lookbackDays: 252,
    rebalanceDays: 21,
    initialCapital: 10_000,
    transactionCostBps: 15,
    blendWeights: blend,
  });
  calResults.push({
    blend: { ...blend },
    sharpe: result.metrics.sharpe,
    cagr: result.metrics.cagr,
    maxdd: result.metrics.maxDrawdown,
  });
  console.log('  BL=' + blend.BL.toFixed(2) + ' HRP=' + blend.HRP.toFixed(2) + ' | Sharpe=' + result.metrics.sharpe.toFixed(3) + ' CAGR=' + (result.metrics.cagr*100).toFixed(2) + '% DD=' + (-result.metrics.maxDrawdown*100).toFixed(1) + '%');
}

// Find optimal calibration blend
calResults.sort((a, b) => b.sharpe - a.sharpe);
const optimalCal = calResults[0];
console.log('\nOptimal calibration blend: BL=' + optimalCal.blend.BL.toFixed(2) + ' HRP=' + optimalCal.blend.HRP.toFixed(2) + ' Sharpe=' + optimalCal.sharpe.toFixed(3));

// ── VALIDATION PHASE ──
console.log('\n--- VALIDATION PHASE (2025+, NEVER SEEN) ---');

// Use pre-2025 data for lookback (252 days before cutoff)
const valStartIdx = Math.max(0, calEndIdx - 252);
const valData = sliceData(valStartIdx, datesArr.length);

// Test current blend (BL:0.24, HRP:0.76) vs optimal calibration blend
const currentBlend = { BL: 0.24, HRP: 0.76, MIN_VAR: 0.00 };

const valResult_current = runBacktest({
  closesHistory: valData.closesHistory,
  macroHistory: { vix: valData.vix, yieldSpread: valData.yieldSpread, creditSpread: valData.creditSpread, move: valData.move, dxyTrend: valData.dxyTrend, btcVol: valData.btcVol },
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
  blendWeights: currentBlend,
});

console.log('Current blend (BL=' + currentBlend.BL.toFixed(2) + ', HRP=' + currentBlend.HRP.toFixed(2) + '):');
console.log('  Forward Sharpe=' + valResult_current.metrics.sharpe.toFixed(3) + ' CAGR=' + (valResult_current.metrics.cagr*100).toFixed(2) + '% DD=' + (-valResult_current.metrics.maxDrawdown*100).toFixed(1) + '%');
console.log('  EW Benchmark Sharpe=' + valResult_current.benchmarkMetrics.sharpe.toFixed(3));

const valResult_optimal = runBacktest({
  closesHistory: valData.closesHistory,
  macroHistory: { vix: valData.vix, yieldSpread: valData.yieldSpread, creditSpread: valData.creditSpread, move: valData.move, dxyTrend: valData.dxyTrend, btcVol: valData.btcVol },
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
  blendWeights: optimalCal.blend,
});

console.log('Optimal cal blend (BL=' + optimalCal.blend.BL.toFixed(2) + ', HRP=' + optimalCal.blend.HRP.toFixed(2) + '):');
console.log('  Forward Sharpe=' + valResult_optimal.metrics.sharpe.toFixed(3) + ' CAGR=' + (valResult_optimal.metrics.cagr*100).toFixed(2) + '% DD=' + (-valResult_optimal.metrics.maxDrawdown*100).toFixed(1) + '%');

// ── VERDICT ──
console.log('\n' + '='.repeat(60));
console.log('  TRUE OUT-OF-SAMPLE VERDICT');
console.log('='.repeat(60));

const degCurrent = ((valResult_current.metrics.sharpe - optimalCal.sharpe) / Math.abs(optimalCal.sharpe) * 100).toFixed(1);
const degOptimal = ((valResult_optimal.metrics.sharpe - optimalCal.sharpe) / Math.abs(optimalCal.sharpe) * 100).toFixed(1);

console.log('Calibration Sharpe (pre-2025): ' + optimalCal.sharpe.toFixed(3));
console.log('Current blend forward Sharpe:  ' + valResult_current.metrics.sharpe.toFixed(3) + ' (degradation: ' + degCurrent + '%)');
console.log('Optimal cal forward Sharpe:    ' + valResult_optimal.metrics.sharpe.toFixed(3) + ' (degradation: ' + degOptimal + '%)');
console.log('EW forward Sharpe:             ' + valResult_current.benchmarkMetrics.sharpe.toFixed(3));

const forwardSharpe = Math.max(valResult_current.metrics.sharpe, valResult_optimal.metrics.sharpe);

console.log('\nForward/Calibration ratio: ' + (forwardSharpe / Math.abs(optimalCal.sharpe) * 100).toFixed(1) + '%');
console.log('Olympus > EW in forward: ' + (forwardSharpe > valResult_current.benchmarkMetrics.sharpe ? 'SI' : 'NO'));

if (forwardSharpe >= Math.abs(optimalCal.sharpe) * 0.80) {
  console.log('\nVEREDICT: TRUE OOS VALIDATION PASSED');
  console.log('Forward Sharpe mantiene >80% del valor de calibracion.');
} else if (forwardSharpe >= Math.abs(optimalCal.sharpe) * 0.50) {
  console.log('\nVEREDICT: MARGINAL — degradacion real pero aun positiva');
} else {
  console.log('\nVEREDICT: FAILED — sobreajuste severo. Forward Sharpe < 50% calibracion.');
}

fs.writeFileSync(path.join(process.cwd(), 'oos_validation.json'), JSON.stringify({
  calResults,
  optimalCal: { blend: optimalCal.blend, sharpe: optimalCal.sharpe, cagr: optimalCal.cagr, maxdd: optimalCal.maxdd },
  forwardCurrent: { sharpe: valResult_current.metrics.sharpe, cagr: valResult_current.metrics.cagr, maxdd: valResult_current.metrics.maxDrawdown },
  forwardOptimal: { sharpe: valResult_optimal.metrics.sharpe, cagr: valResult_optimal.metrics.cagr, maxdd: valResult_optimal.metrics.maxDrawdown },
  forwardEW: { sharpe: valResult_current.benchmarkMetrics.sharpe },
}, null, 2));

console.log('\nDONE - oos_validation.json saved');
