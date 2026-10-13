// ===============================================
// ARCHIVO: src/core/backtest/run-walkforward.ts
// WALK-FORWARD TEST RUNNER — MasterRegime Completo
// Ejecutar: npx tsx src/core/backtest/run-walkforward.ts
// ===============================================

import fs from 'fs';
import path from 'path';
import { runWalkForwardTest, formatWFResult, DEFAULT_WF_CONFIG } from './walkForwardTest';
import { ASSETS } from '../../lib/constants';
import { computeGlobalStress } from '../macro/globalStress';

// ── 1. Cargar CSV augmentado ──────────────────────
// El archivo de public/ es la serie diaria canónica versionada para la app.
 // En la raíz existe una copia de trabajo con actualizaciones parciales y huecos;
 // no debe prevalecer sobre la fuente canónica aunque tenga fechas más recientes.
const csvCandidates = [
  path.join(process.cwd(), 'public', 'historical_data_daily_augmented.csv'),
  path.join(process.cwd(), 'historical_data_daily_augmented.csv'),
];
const csvPath = csvCandidates.find(candidate => fs.existsSync(candidate));
if (!csvPath) {
  throw new Error(
    `No se encontró historical_data_daily_augmented.csv. Rutas comprobadas:\n${csvCandidates.join('\n')}`
  );
}
console.log('CSV:', csvPath);
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].replace(/^\uFEFF/, '').split(',').map(h => h.trim());
const dataLines = lines.slice(1).map(line => line.trim()).filter(Boolean);
const requiredColumns = [
  'Date', ...ASSETS, '^VIX', '^TNX', '^IRX', 'HYG', 'LQD', '^MOVE', 'DX-Y.NYB', 'BTC_VOL',
];
const missingColumns = requiredColumns.filter(column => !headers.includes(column));
if (missingColumns.length) {
  throw new Error(`CSV sin columnas obligatorias: ${missingColumns.join(', ')}`);
}
if (dataLines.length === 0) throw new Error('CSV sin filas históricas.');

function parseRequiredNumber(raw: string, column: string, date: string): number {
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Dato inválido para ${column} en ${date}: ${JSON.stringify(raw)}`);
  }
  return value;
}

const dateIndex = headers.indexOf('Date');
const dates = dataLines.map(line => line.split(',')[dateIndex]?.trim() ?? '');
for (let i = 0; i < dates.length; i++) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dates[i]) || Number.isNaN(Date.parse(dates[i]))) {
    throw new Error(`Fecha inválida en fila CSV ${i + 2}: ${JSON.stringify(dates[i])}`);
  }
  if (i > 0 && dates[i] <= dates[i - 1]) {
    throw new Error(`Fechas duplicadas o no ordenadas: ${dates[i - 1]} → ${dates[i]}`);
  }
  if (i > 0) {
    const previousDay = Date.parse(`${dates[i - 1]}T00:00:00Z`);
    const currentDay = Date.parse(`${dates[i]}T00:00:00Z`);
    const gapDays = Math.round((currentDay - previousDay) / 86_400_000);
    // El dataset conserva filas diarias (incluidos fines de semana forward-filled).
    // Un hueco de calendario implica que no podemos tratar índices como días consecutivos.
    if (gapDays !== 1) {
      throw new Error(`Hueco temporal en CSV: ${dates[i - 1]} → ${dates[i]} (${gapDays} días). Repara/recupera las fechas ausentes antes del WFO.`);
    }
  }
}
const firstDate = dates[0];
const lastDate = dates[dates.length - 1];
const staleDays = Math.floor((Date.now() - Date.parse(`${lastDate}T00:00:00Z`)) / 86_400_000);

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

for (const line of dataLines) {
  const parts = line.split(',');
  if (parts.length !== headers.length) {
    throw new Error(`Número de columnas incorrecto en ${parts[dateIndex] ?? 'fecha desconocida'}: ${parts.length} frente a ${headers.length}`);
  }
  const date = parts[dateIndex].trim();
  for (const ticker of ASSETS) {
    closesHistory[ticker].push(parseRequiredNumber(parts[headers.indexOf(ticker)], ticker, date));
  }
  vixArr.push(parseRequiredNumber(parts[headers.indexOf('^VIX')], '^VIX', date));
  tnxArr.push(parseRequiredNumber(parts[headers.indexOf('^TNX')], '^TNX', date));
  irxArr.push(parseRequiredNumber(parts[headers.indexOf('^IRX')], '^IRX', date));
  hygArr.push(parseRequiredNumber(parts[headers.indexOf('HYG')], 'HYG', date));
  lqdArr.push(parseRequiredNumber(parts[headers.indexOf('LQD')], 'LQD', date));
  moveArr.push(parseRequiredNumber(parts[headers.indexOf('^MOVE')], '^MOVE', date));
  dxyArr.push(parseRequiredNumber(parts[headers.indexOf('DX-Y.NYB')], 'DX-Y.NYB', date));
  btcVolArr.push(parseRequiredNumber(parts[headers.indexOf('BTC_VOL')], 'BTC_VOL', date));
}

// ── 3. Recortar a longitud común ───────────────
const minLen = Math.min(
  ...ASSETS.map(t => closesHistory[t].length),
  vixArr.length, tnxArr.length, irxArr.length,
  hygArr.length, lqdArr.length, moveArr.length, dxyArr.length, btcVolArr.length
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
  dxyTrend.push(prev > 0 ? (curr - prev) / prev : 0); // decimal return: 0.02 = +2%, contract with globalStress.ts
}

console.log(`\n📊 Datos cargados: ${minLen} días`);
console.log(`   Período: ${firstDate} → ${lastDate}`);
console.log(`   Antigüedad del último dato: ${staleDays} días`);
if (staleDays > 7) console.warn('   ADVERTENCIA: CSV histórico desactualizado; resultados solo describen el período disponible.');
console.warn('   ADVERTENCIA METODOLÓGICA: creditSpread es un proxy sintético derivado de HYG/LQD, no un spread histórico observado.');
console.warn('   COBERTURA MACRO INCOMPLETA: el WFO no carga series históricas de Brent/WTI, cbLiquidityGrowth (balances Fed+BCE) ni M2; M2 usa el fallback fijo de 2 y no aporta variación histórica.');
console.warn('   DXY sí se incluye, pero solo como variación porcentual a 20 días; no se prueban aún ventanas 60/90 días ni una ablación que mida su contribución incremental.');
console.warn('   Por tanto, estos resultados NO validan el bloque macro completo. No interpretar las métricas WFO como validación de petróleo, liquidez de bancos centrales o crédito observado.');
console.log(`   VIX: ${Math.min(...vix).toFixed(1)}–${Math.max(...vix).toFixed(1)}`);
console.log(`   MOVE: ${Math.min(...move).toFixed(1)}–${Math.max(...move).toFixed(1)}`);
console.log(`   DXY Trend (20d): ${(Math.min(...dxyTrend) * 100).toFixed(2)}%–${(Math.max(...dxyTrend) * 100).toFixed(2)}%`);
// btcVol is annualized volatility in decimal form (0.50 = 50%), as expected by globalStress.ts.
console.log(`   BTC Vol: ${(Math.min(...btcVol) * 100).toFixed(0)}%–${(Math.max(...btcVol) * 100).toFixed(0)}%`);

// ── 4b. Diagnóstico causal intermedio del DXY ─────────────────────────
// Separa tres cosas: días que activan el umbral, cambio en stress score y
// cambio de etiqueta NORMAL/HIGH_RISK/CRISIS. No presume impacto en allocations.
let dxyThresholdDays = 0;
let dxyStressScoreChangedDays = 0;
let dxyStressRegimeChangedDays = 0;
let dxyTotalScoreDelta = 0;
for (let i = 0; i < minLen; i++) {
  const commonStressInputs = {
    vix: vix[i],
    creditSpread: creditSpread[i],
    move: move[i],
    btcVol: btcVol[i],
  };
  const withDxy = computeGlobalStress({ ...commonStressInputs, dxyTrend: dxyTrend[i] });
  const withoutDxy = computeGlobalStress({ ...commonStressInputs, dxyTrend: 0 });
  if (dxyTrend[i] > 0.02) dxyThresholdDays++;
  if (withDxy.score !== withoutDxy.score) {
    dxyStressScoreChangedDays++;
    dxyTotalScoreDelta += withDxy.score - withoutDxy.score;
  }
  if (withDxy.regime !== withoutDxy.regime) dxyStressRegimeChangedDays++;
}
console.log('\n🔬 DXY EFFECT DIAGNOSTICS — stress-score layer only');
console.log(`   DXY > +2% over 20d: ${dxyThresholdDays}/${minLen} days (${(100 * dxyThresholdDays / minLen).toFixed(2)}%)`);
console.log(`   Stress score changed vs DXY=0: ${dxyStressScoreChangedDays}/${minLen} days`);
console.log(`   Stress regime label changed: ${dxyStressRegimeChangedDays}/${minLen} days`);
console.log(`   Sum of daily score deltas: ${dxyTotalScoreDelta.toFixed(2)}`);
console.log('   Scope: isolated computeGlobalStress only; does not measure downstream allocation changes.');


// ── 5. Ejecutar walk-forward con masterRegime completo ─────────────────
console.log('\n🚀 Ejecutando WALK-FORWARD TEST con masterRegime completo...');
console.log(`   Ventanas: 3 | Train 70% / OOS 30% | Lookback 252d | Rebalanceo 63d\n`);

const wfConfig = {
  ...DEFAULT_WF_CONFIG,
  nWindows: 3,
  trainRatio: 0.70,
  lookbackDays: 252,
  rebalanceDays: 63,
  initialCapital: 10_000,
};
const wfResult = runWalkForwardTest({
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: wfConfig.lookbackDays,
  rebalanceDays: wfConfig.rebalanceDays,
  initialCapital: wfConfig.initialCapital,
}, wfConfig);
if (wfResult.windows.length !== wfConfig.nWindows) {
  throw new Error(
    `WFO inválido: se esperaban ${wfConfig.nWindows} ventanas OOS y se obtuvieron ${wfResult.windows.length}. No se publicarán métricas parciales.`
  );
}

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

/*
 * PAIRED ABLATION — DXY
 * Same prices, windows, rebalance schedule, covariance, and transaction costs.
 * Only dxyTrend is neutralized. This is diagnostic, not a parameter optimization.
 */
console.log('\n' + '='.repeat(72));
console.log('   DXY ABLATION — baseline vs identical WFO with dxyTrend = 0');
console.log('='.repeat(72));
const noDxyResult = runWalkForwardTest({
  closesHistory,
  macroHistory: {
    vix, yieldSpread, creditSpread, move,
    dxyTrend: Array<number>(minLen).fill(0),
    btcVol,
  },
  lookbackDays: wfConfig.lookbackDays,
  rebalanceDays: wfConfig.rebalanceDays,
  initialCapital: wfConfig.initialCapital,
}, wfConfig);
if (noDxyResult.windows.length !== wfConfig.nWindows ||
    noDxyResult.windows.length !== wfResult.windows.length) {
  throw new Error('DXY ablation inválida: el número de ventanas no coincide.');
}
console.log('Δ = DXY activo − DXY neutral | mismo dataset y costes');
console.log('Ventana | Sharpe OOS ON/OFF/Δ | CAGR OOS ON/OFF/Δ | MaxDD ON/OFF/Δ');
for (let i = 0; i < wfResult.windows.length; i++) {
  const on = wfResult.windows[i].outOfSample.metrics;
  const off = noDxyResult.windows[i].outOfSample.metrics;
  console.log(
    `V${i + 1} | ${on.sharpe.toFixed(3)} / ${off.sharpe.toFixed(3)} / ${(on.sharpe - off.sharpe).toFixed(3)} | ` +
    `${(on.cagr * 100).toFixed(2)}% / ${(off.cagr * 100).toFixed(2)}% / ${((on.cagr - off.cagr) * 100).toFixed(2)} pp | ` +
    `${(on.maxDrawdown * 100).toFixed(2)}% / ${(off.maxDrawdown * 100).toFixed(2)}% / ${((on.maxDrawdown - off.maxDrawdown) * 100).toFixed(2)} pp`
  );
}
const onMeanSharpe = wfResult.windows.reduce((sum, w) => sum + w.outOfSample.metrics.sharpe, 0) / wfResult.windows.length;
const offMeanSharpe = noDxyResult.windows.reduce((sum, w) => sum + w.outOfSample.metrics.sharpe, 0) / noDxyResult.windows.length;
const onMeanCagr = wfResult.windows.reduce((sum, w) => sum + w.outOfSample.metrics.cagr, 0) / wfResult.windows.length;
const offMeanCagr = noDxyResult.windows.reduce((sum, w) => sum + w.outOfSample.metrics.cagr, 0) / noDxyResult.windows.length;
console.log(`Media ventanas OOS — Sharpe: ${onMeanSharpe.toFixed(3)} vs ${offMeanSharpe.toFixed(3)} (Δ ${(onMeanSharpe - offMeanSharpe).toFixed(3)})`);
console.log(`Media ventanas OOS — CAGR: ${(onMeanCagr * 100).toFixed(2)}% vs ${(offMeanCagr * 100).toFixed(2)}% (Δ ${((onMeanCagr - offMeanCagr) * 100).toFixed(2)} pp)`);
console.log('NOTA: una sola configuración histórica no prueba causalidad ni valida el motor completo.');
