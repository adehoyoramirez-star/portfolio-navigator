// ===============================================
// ARCHIVO: src/core/backtest/run-sensitivity.ts
// SENSITIVITY ANALYSIS — Walk-Forward Test
// Varía trainRatio [0.60-0.80] y nWindows [3-10]
// Ejecutar: npx tsx src/core/backtest/run-sensitivity.ts
// ===============================================

import fs from 'fs';
import path from 'path';
import { runWalkForwardTest } from './walkForwardTest';
import { ASSETS } from '../../lib/constants';

// ── 1. Cargar CSV augmentado (una sola vez) ─────
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
  rebalanceDays: 63,
  initialCapital: 10_000,
  transactionCostBps: 15,
};

const fDate = lines[1]?.split(',')[0] ?? '?';
const lDate = lines[lines.length - 1]?.split(',')[0] ?? '?';
console.log(`Datos: ${minLen} dias | ${fDate} -> ${lDate}`);
console.log('');

// ── 2. Grid de parametros ─────────────────────
const trainRatios = [0.60, 0.65, 0.70, 0.75, 0.80];
const nWindowsArr = [3, 5, 7, 10];

// ── 3. Ejecutar grid ──────────────────────────
const SEP = '='.repeat(90);
console.log(SEP);
console.log('  ANALISIS DE SENSIBILIDAD - Walk-Forward Test (MasterRegime Completo)');
console.log(SEP);
console.log('');
console.log('Ventanas | Train% | Consist. | Grade | Overfit Risk | Sharpe IS->OOS   | CAGR IS->OOS    | MaxDegrad');
console.log('---------+--------+----------+-------+--------------+-----------------+----------------+------------');

const results: Array<{
  nw: number; tr: number; cons: number; grade: string; risk: string;
  sharpeIs: number; sharpeOos: number; cagrIs: number; cagrOos: number; maxDeg: number
}> = [];

for (const nw of nWindowsArr) {
  for (const tr of trainRatios) {
    const result = runWalkForwardTest(baseInput, {
      nWindows: nw,
      trainRatio: tr,
      lookbackDays: 252,
      rebalanceDays: 63,
    });

    const cons = result.overallConsistency;
    const grade = result.robustnessGrade;
    const risk = result.overfittingRisk;
    const sharpeIs = result.sharpeIsAvg;
    const sharpeOos = result.sharpeOosAvg;
    const cagrIs = result.cagrIsAvg;
    const cagrOos = result.cagrOosAvg;
    const maxDeg = Math.max(result.avgSharpeDegradation, result.avgCagrDegradation);

    results.push({ nw, tr, cons, grade, risk, sharpeIs, sharpeOos, cagrIs, cagrOos, maxDeg });

    const gradeEmoji = grade === 'A' ? '(A)' : grade === 'B' ? '(B)' : grade === 'C' ? '(C)' : grade === 'D' ? '(D)' : '(F)';
    const riskTxt = risk.padEnd(8);

    const si = sharpeIs.toFixed(2).padStart(5);
    const so = sharpeOos.toFixed(2).padStart(5);
    const ci = (cagrIs * 100).toFixed(1).padStart(5);
    const co = (cagrOos * 100).toFixed(1).padStart(5);
    const md = Math.abs(maxDeg).toFixed(3).padStart(7);

    console.log(
      '   ' + String(nw).padStart(2) + '     |  ' + (tr * 100).toFixed(0) + '%  | ' +
      (cons * 100).toFixed(1).padStart(5) + '%  |  ' + gradeEmoji + '  |  ' + riskTxt + ' | ' +
      si + '->' + so + '  | ' +
      ci + '%->' + co + '%  | ' + md
    );
  }
  console.log('---------+--------+----------+-------+--------------+-----------------+----------------+------------');
}

// ── 4. Mejor / Peor configuracion ─────────────
const best = results.reduce((a, b) => a.cons > b.cons ? a : b);
const worst = results.reduce((a, b) => a.cons < b.cons ? a : b);

console.log('');
console.log(SEP);
console.log('  MEJOR CONFIGURACION');
console.log(SEP);
console.log('  nWindows=' + best.nw + ' | trainRatio=' + (best.tr * 100).toFixed(0) + '% -> Consistencia=' + (best.cons * 100).toFixed(1) + '% | Grade=' + best.grade + ' | Risk=' + best.risk);
console.log('  Sharpe IS->OOS: ' + best.sharpeIs.toFixed(3) + ' -> ' + best.sharpeOos.toFixed(3));
console.log('  CAGR IS->OOS: ' + (best.cagrIs * 100).toFixed(2) + '% -> ' + (best.cagrOos * 100).toFixed(2) + '%');
console.log('');
console.log(SEP);
console.log('  PEOR CONFIGURACION');
console.log(SEP);
console.log('  nWindows=' + worst.nw + ' | trainRatio=' + (worst.tr * 100).toFixed(0) + '% -> Consistencia=' + (worst.cons * 100).toFixed(1) + '% | Grade=' + worst.grade + ' | Risk=' + worst.risk);
console.log('  Sharpe IS->OOS: ' + worst.sharpeIs.toFixed(3) + ' -> ' + worst.sharpeOos.toFixed(3));
console.log('  CAGR IS->OOS: ' + (worst.cagrIs * 100).toFixed(2) + '% -> ' + (worst.cagrOos * 100).toFixed(2) + '%');

// ── 5. Estadisticas agregadas ──────────────────
console.log('');
console.log(SEP);
console.log('  ESTADISTICAS AGREGADAS (' + results.length + ' ejecuciones)');
console.log(SEP);

const avgCons = results.reduce((s, r) => s + r.cons, 0) / results.length;
const minCons = Math.min(...results.map(r => r.cons));
const maxCons = Math.max(...results.map(r => r.cons));
const stdCons = Math.sqrt(results.reduce((s, r) => s + (r.cons - avgCons) ** 2, 0) / results.length);

const aCount = results.filter(r => r.grade === 'A').length;
const bCount = results.filter(r => r.grade === 'B').length;
const cCount = results.filter(r => r.grade === 'C').length;
const dCount = results.filter(r => r.grade === 'D').length;
const fCount = results.filter(r => r.grade === 'F').length;
const lowRiskCount = results.filter(r => r.risk === 'LOW').length;

const avgSharpeOos = results.reduce((s, r) => s + r.sharpeOos, 0) / results.length;
const avgCagrOos = results.reduce((s, r) => s + r.cagrOos, 0) / results.length;

console.log('  Consistencia media:     ' + (avgCons * 100).toFixed(1) + '%');
console.log('  Consistencia minima:    ' + (minCons * 100).toFixed(1) + '%');
console.log('  Consistencia maxima:    ' + (maxCons * 100).toFixed(1) + '%');
console.log('  Desviacion estandar:    ' + (stdCons * 100).toFixed(2) + 'pp');
console.log('  Grade A:               ' + aCount + '/' + results.length + ' (' + (aCount / results.length * 100).toFixed(0) + '%)');
console.log('  Grade B:               ' + bCount + '/' + results.length + ' (' + (bCount / results.length * 100).toFixed(0) + '%)');
console.log('  Grade C:               ' + cCount + '/' + results.length + ' (' + (cCount / results.length * 100).toFixed(0) + '%)');
console.log('  Grade D:               ' + dCount + '/' + results.length + ' (' + (dCount / results.length * 100).toFixed(0) + '%)');
console.log('  Grade F:               ' + fCount + '/' + results.length + ' (' + (fCount / results.length * 100).toFixed(0) + '%)');
console.log('  Risk LOW:              ' + lowRiskCount + '/' + results.length + ' (' + (lowRiskCount / results.length * 100).toFixed(0) + '%)');
console.log('  Sharpe OOS medio:      ' + avgSharpeOos.toFixed(3));
console.log('  CAGR OOS medio:        ' + (avgCagrOos * 100).toFixed(2) + '%');

// ── 6. Analisis por dimension ──────────────────
console.log('');
console.log(SEP);
console.log('  CONSISTENCIA PROMEDIO POR DIMENSION');
console.log(SEP);
console.log('');
console.log('  Por nWindows:');
for (const nw of nWindowsArr) {
  const subset = results.filter(r => r.nw === nw);
  const avg = subset.reduce((s, r) => s + r.cons, 0) / subset.length;
  console.log('    nWindows=' + nw + ': ' + (avg * 100).toFixed(1) + '% (promedio ' + subset.length + ' trainRatios)');
}
console.log('');
console.log('  Por trainRatio:');
for (const tr of trainRatios) {
  const subset = results.filter(r => r.tr === tr);
  const avg = subset.reduce((s, r) => s + r.cons, 0) / subset.length;
  console.log('    trainRatio=' + (tr * 100).toFixed(0) + '%: ' + (avg * 100).toFixed(1) + '% (promedio ' + subset.length + ' nWindows)');
}
