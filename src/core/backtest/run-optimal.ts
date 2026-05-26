// ===============================================
// ARCHIVO: src/core/backtest/run-optimal.ts
// WALK-FORWARD TEST — Configuracion Optima
// nWindows=5, trainRatio=0.65 (recomendado por sensibilidad)
// Guarda resultados detallados en CSV
// Ejecutar: npx tsx src/core/backtest/run-optimal.ts
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

console.log('');
console.log('Datos: ' + minLen + ' dias | ' + lines[1]?.split(',')[0] + ' -> ' + lines[lines.length-1]?.split(',')[0]);
console.log('');

// ── 2. Ejecutar walk-forward con config optima ───
console.log('='.repeat(60));
console.log('  WALK-FORWARD TEST — CONFIGURACION OPTIMA');
console.log('  nWindows=5 | trainRatio=0.65 | MasterRegime Completo');
console.log('='.repeat(60));
console.log('');

const wfResult = runWalkForwardTest({
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: 252,
  rebalanceDays: 63,
  initialCapital: 10_000,
  transactionCostBps: 15,
}, {
  nWindows: 5,
  trainRatio: 0.65,
});

// ── 3. Mostrar resultado formateado ────────────
console.log(formatWFResult(wfResult));

// ── 4. Seccion detallada por ventana ───────────
console.log('');
console.log('='.repeat(70));
console.log('  DETALLE COMPLETO POR VENTANA');
console.log('='.repeat(70));

const bestW = wfResult.windows.reduce((a, b) => a.consistencyScore > b.consistencyScore ? a : b);
const worstW = wfResult.windows.reduce((a, b) => a.consistencyScore < b.consistencyScore ? a : b);

for (const w of wfResult.windows) {
  const is = w.inSample.metrics;
  const oos = w.outOfSample.metrics;
  const isOptimal = w.window.windowIndex === bestW.window.windowIndex ? ' ★' : '';
  const isWorst = w.window.windowIndex === worstW.window.windowIndex ? ' ⚠' : '';
  const tag = isOptimal || isWorst;
  const emoji = w.consistencyScore >= 0.80 ? 'GREEN' : w.consistencyScore >= 0.65 ? 'YELLOW' : 'RED';

  console.log('');
  console.log('  V' + (w.window.windowIndex + 1) + tag + ' ' + emoji + ' | Consistencia: ' + (w.consistencyScore * 100).toFixed(1) + '%');
  console.log('  ' + '-'.repeat(55));
  console.log('  Periodo OOS:     dia ' + w.window.testStart + ' -> ' + w.window.testEnd + ' (' + w.window.testDays + ' dias)');
  console.log('  Train/Test:      ' + w.window.trainDays + 'd / ' + w.window.testDays + 'd');

  const sharpeArrow = is.sharpe <= oos.sharpe ? 'UP' : 'DOWN';
  console.log('  Sharpe:          ' + sharpeArrow + ' IS ' + is.sharpe.toFixed(3) + ' -> OOS ' + oos.sharpe.toFixed(3) + ' (degrad: ' + w.sharpeDegradation.toFixed(3) + ')');

  const cagrDelta = (oos.cagr - is.cagr) * 100;
  const cagrArrow = cagrDelta >= -2 ? 'UP' : cagrDelta >= -5 ? 'WARN' : 'DOWN';
  console.log('  CAGR:            ' + cagrArrow + ' IS ' + (is.cagr * 100).toFixed(2) + '% -> OOS ' + (oos.cagr * 100).toFixed(2) + '% (delta: ' + cagrDelta.toFixed(2) + 'pp)');

  const ddDelta = (oos.maxDrawdown - is.maxDrawdown) * 100;
  const ddArrow = ddDelta >= 0 ? 'UP' : ddDelta >= -5 ? 'WARN' : 'DOWN';
  console.log('  MaxDD:           ' + ddArrow + ' IS ' + (is.maxDrawdown * 100).toFixed(2) + '% -> OOS ' + (oos.maxDrawdown * 100).toFixed(2) + '% (delta: ' + ddDelta.toFixed(2) + 'pp)');

  const wrDelta = (oos.winRate - is.winRate) * 100;
  const wrArrow = wrDelta >= -5 ? 'UP' : 'DOWN';
  console.log('  Win Rate:        ' + wrArrow + ' IS ' + (is.winRate * 100).toFixed(1) + '% -> OOS ' + (oos.winRate * 100).toFixed(1) + '% (delta: ' + wrDelta.toFixed(1) + 'pp)');

  console.log('  Volatilidad:     IS ' + (is.volatility * 100).toFixed(2) + '% -> OOS ' + (oos.volatility * 100).toFixed(2) + '%');
  console.log('  Calmar:          IS ' + is.calmar.toFixed(3) + ' -> OOS ' + oos.calmar.toFixed(3));
  console.log('  Capital Final:   IS EUR ' + is.finalValue.toFixed(2) + ' -> OOS EUR ' + oos.finalValue.toFixed(2));
}

console.log('');
console.log('='.repeat(70));
console.log('  MEJOR VENTANA: V' + (bestW.window.windowIndex + 1) + ' (consistencia ' + (bestW.consistencyScore * 100).toFixed(1) + '%)');
console.log('  PEOR VENTANA:  V' + (worstW.window.windowIndex + 1) + ' (consistencia ' + (worstW.consistencyScore * 100).toFixed(1) + '%)');
console.log('='.repeat(70));

// ── 5. Guardar resultados en CSV ───────────────
const csvOut: string[] = [
  'Ventana,DiasIS,DiasOOS,FechaInicioOOS,FechaFinOOS,' +
  'Sharpe_IS,Sharpe_OOS,Sharpe_Degradacion,' +
  'CAGR_IS_PCT,CAGR_OOS_PCT,CAGR_Degradacion_PP,' +
  'MaxDD_IS_PCT,MaxDD_OOS_PCT,MaxDD_Delta_PP,' +
  'WinRate_IS_PCT,WinRate_OOS_PCT,WinRate_Delta_PP,' +
  'Vol_IS_PCT,Vol_OOS_PCT,' +
  'Calmar_IS,Calmar_OOS,' +
  'FinalValue_IS,FinalValue_OOS,' +
  'Consistencia_PCT'
];

for (const w of wfResult.windows) {
  const is = w.inSample.metrics;
  const oos = w.outOfSample.metrics;
  csvOut.push([
    w.window.windowIndex + 1,
    w.window.trainDays,
    w.window.testDays,
    w.window.testStart,
    w.window.testEnd,
    is.sharpe.toFixed(4),
    oos.sharpe.toFixed(4),
    w.sharpeDegradation.toFixed(4),
    (is.cagr * 100).toFixed(4),
    (oos.cagr * 100).toFixed(4),
    (w.cagrDegradation * 100).toFixed(4),
    (is.maxDrawdown * 100).toFixed(4),
    (oos.maxDrawdown * 100).toFixed(4),
    (w.maxDdDegradation * 100).toFixed(4),
    (is.winRate * 100).toFixed(2),
    (oos.winRate * 100).toFixed(2),
    (w.winRateDegradation * 100).toFixed(4),
    (is.volatility * 100).toFixed(4),
    (oos.volatility * 100).toFixed(4),
    is.calmar.toFixed(4),
    oos.calmar.toFixed(4),
    is.finalValue.toFixed(2),
    oos.finalValue.toFixed(2),
    (w.consistencyScore * 100).toFixed(2),
  ].join(','));
}

// Fila de resumen global
csvOut.push([
  'GLOBAL',
  wfResult.totalDataDays, '', '', '',
  wfResult.sharpeIsAvg.toFixed(4),
  wfResult.sharpeOosAvg.toFixed(4),
  wfResult.avgSharpeDegradation.toFixed(4),
  (wfResult.cagrIsAvg * 100).toFixed(4),
  (wfResult.cagrOosAvg * 100).toFixed(4),
  (wfResult.avgCagrDegradation * 100).toFixed(4),
  '', '', '',
  '', '', '',
  '', '', '', '', '', '',
  (wfResult.overallConsistency * 100).toFixed(2),
].join(','));

const outPath = path.join(process.cwd(), 'walkforward_optimal_v5plus.csv');
fs.writeFileSync(outPath, csvOut.join('\n'));
console.log('');
console.log('CSV guardado: ' + outPath);
console.log('Columnas: Ventana, Sharpe IS/OOS/Degrad, CAGR IS/OOS/Degrad, MaxDD IS/OOS/Delta, WinRate IS/OOS/Delta, Consistencia');
