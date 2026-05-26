// ===============================================
// ARCHIVO: src/core/backtest/run-walkforward.ts
// WALK-FORWARD TEST RUNNER — MasterRegime Completo
// Ejecutar: npx tsx src/core/backtest/run-walkforward.ts
// ===============================================

import fs from 'fs';
import path from 'path';
import { runWalkForwardTest, formatWFResult } from './walkForwardTest';
import { ASSETS } from '../../lib/constants';

// ── 1. Cargar CSV augmentado ──────────────────────
const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
console.log('CSV:', csvPath);
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

// ── 2. Inicializar arrays ──────────────────────
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

// ── 3. Recortar a longitud común ───────────────
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

// ── 4. Computar macro ──────────────────────────
const yieldSpread = tnx.map((v, i) => v - irx[i]);
const creditSpread = hyg.map((v, i) => {
  if (v > 0 && lqd[i] > 0) {
    const hygYield = 0.045 + (1 - v / 100) * 0.03;
    const lqdYield = 0.035 + (1 - lqd[i] / 100) * 0.02;
    return Math.max(1.0, Math.min(9.0, (hygYield - lqdYield) * 100));
  }
  return 2.5 + vix[i] / 20;
});

// dxyTrend: 20-day rolling % change of DXY
const dxyTrend: number[] = [];
for (let i = 0; i < minLen; i++) {
  if (i < 20) { dxyTrend.push(0); continue; }
  const prev = dxy[i - 20];
  const curr = dxy[i];
  dxyTrend.push(prev > 0 ? ((curr - prev) / prev) * 100 : 0);
}

console.log(`\n📊 Datos cargados: ${minLen} días`);
console.log(`   Período: ${lines[1]?.split(',')[0]} → ${lines[lines.length-1]?.split(',')[0]}`);
console.log(`   VIX: ${Math.min(...vix).toFixed(1)}–${Math.max(...vix).toFixed(1)}`);
console.log(`   MOVE: ${Math.min(...move).toFixed(1)}–${Math.max(...move).toFixed(1)}`);
console.log(`   DXY Trend: ${Math.min(...dxyTrend).toFixed(2)}%–${Math.max(...dxyTrend).toFixed(2)}%`);
console.log(`   BTC Vol: ${Math.min(...btcVol).toFixed(1)}%–${Math.max(...btcVol).toFixed(1)}%`);

// ── 5. Ejecutar walk-forward con masterRegime completo ─────────────────
console.log('\n🚀 Ejecutando WALK-FORWARD TEST con masterRegime completo...');
console.log(`   Ventanas: 5 | Train 70% / OOS 30% | Lookback 252d\n`);

const wfResult = runWalkForwardTest({
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: 252,
  rebalanceDays: 63,
  initialCapital: 10_000,
  transactionCostBps: 15,
});

// ── 6. Mostrar resultados ──────────────────────
console.log(formatWFResult(wfResult));

// ── 7. Tabla detallada por ventana ─────────────
console.log('\n' + '='.repeat(60));
console.log('   📋 DETALLE POR VENTANA (IS → OOS)');
console.log('='.repeat(60));
for (const w of wfResult.windows) {
  const is = w.inSample.metrics;
  const oos = w.outOfSample.metrics;
  console.log(`\n   V${w.window.windowIndex + 1}:`);
  console.log(`     Período OOS: día ${w.window.testStart} → ${w.window.testEnd} (${w.window.testDays} días)`);
  console.log(`     Sharpe:      IS ${is.sharpe.toFixed(3)} → OOS ${oos.sharpe.toFixed(3)} | Degrad: ${w.sharpeDegradation.toFixed(3)}`);
  console.log(`     CAGR:        IS ${(is.cagr * 100).toFixed(2)}% → OOS ${(oos.cagr * 100).toFixed(2)}% | Degrad: ${(w.cagrDegradation * 100).toFixed(2)}%`);
  console.log(`     MaxDD:       IS ${(is.maxDrawdown * 100).toFixed(2)}% → OOS ${(oos.maxDrawdown * 100).toFixed(2)}% | Degrad: ${(w.maxDdDegradation * 100).toFixed(2)}%`);
  console.log(`     Consistencia: ${(w.consistencyScore * 100).toFixed(1)}% ${w.consistencyScore >= 0.70 ? '✅' : w.consistencyScore >= 0.50 ? '⚠️' : '❌'}`);
  console.log(`     Win Rate:     IS ${(is.winRate * 100).toFixed(1)}% → OOS ${(oos.winRate * 100).toFixed(1)}% | Degrad: ${(w.winRateDegradation * 100).toFixed(1)}%`);
}

console.log('\n' + '='.repeat(60));
console.log('   📊 RESUMEN GLOBAL');
console.log('='.repeat(60));
console.log(`   Consistencia media:      ${(wfResult.overallConsistency * 100).toFixed(1)}%`);
console.log(`   Sharpe IS medio:         ${wfResult.sharpeIsAvg.toFixed(3)}`);
console.log(`   Sharpe OOS medio:        ${wfResult.sharpeOosAvg.toFixed(3)}`);
console.log(`   Degradación Sharpe:      ${wfResult.avgSharpeDegradation.toFixed(3)}`);
console.log(`   CAGR IS medio:           ${(wfResult.cagrIsAvg * 100).toFixed(2)}%`);
console.log(`   CAGR OOS medio:          ${(wfResult.cagrOosAvg * 100).toFixed(2)}%`);
console.log(`   Degradación CAGR:        ${(wfResult.avgCagrDegradation * 100).toFixed(2)}%`);
console.log(`   Grados de robustez:      ${wfResult.robustnessGrade}`);
console.log(`   Riesgo overfitting:      ${wfResult.overfittingRisk}`);
console.log(`   Ventanas Sharpe OOS >0:  ${(wfResult.pctWindowsPositiveSharpe * 100).toFixed(0)}%`);
console.log(`   Ventanas CAGR OOS >0:    ${(wfResult.pctWindowsPositiveCagr * 100).toFixed(0)}%`);
console.log(`   Pesos adaptativos:`);
console.log(`     Momentum: ${(wfResult.adaptiveFactorWeights.momentum * 100).toFixed(0)}%`);
console.log(`     Value:    ${(wfResult.adaptiveFactorWeights.value * 100).toFixed(0)}%`);
console.log(`     Quality:  ${(wfResult.adaptiveFactorWeights.quality * 100).toFixed(0)}%`);
console.log(`     LowVol:   ${(wfResult.adaptiveFactorWeights.lowVol * 100).toFixed(0)}%`);
