// ===============================================
// ARCHIVO: scripts/run-oos-validation.ts
// FIX-AUDIT-INST-03: Validacion Out-of-Sample.
// Divide datos en IS (primer 35%) y OOS (65% restante).
// Mide la degradacion IS->OOS en Sharpe, CAGR, MaxDD.
// NOTA: Los parametros del motor no se congelan (son const en engineConfig.ts).
// Esta prueba mide como de bien generaliza el motor cuando ve datos
// completamente nuevos, usando la misma configuracion de parametros.
// Ejecutar: npx tsx scripts/run-oos-validation.ts
// ===============================================

import fs from 'fs';
import path from 'path';
import { runBacktest } from '../src/core/backtest/backtestEngine';
import { ASSETS } from '../src/lib/constants';

const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
if (!fs.existsSync(csvPath)) { console.error('ERROR: CSV not found'); process.exit(1); }
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

const closesHistory: Record<string, number[]> = {};
for (const a of ASSETS) closesHistory[a] = [];
const vixArr: number[] = [], tnxArr: number[] = [], irxArr: number[] = [];
const hygArr: number[] = [], lqdArr: number[] = [];
const moveArr: number[] = [], dxyArr: number[] = [], btcVolArr: number[] = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim(); if (!line) continue;
  const parts = line.split(','); if (parts.length < headers.length) continue;
  for (const ticker of ASSETS) {
    const idx = headers.indexOf(ticker);
    if (idx !== -1) closesHistory[ticker].push(parseFloat(parts[idx]) || 0);
  }
  const vi = headers.indexOf('^VIX'); if (vi !== -1) vixArr.push(parseFloat(parts[vi]) || 0);
  const ti = headers.indexOf('^TNX'); if (ti !== -1) tnxArr.push(parseFloat(parts[ti]) || 0);
  const ii = headers.indexOf('^IRX'); if (ii !== -1) irxArr.push(parseFloat(parts[ii]) || 0);
  const hi = headers.indexOf('HYG'); if (hi !== -1) hygArr.push(parseFloat(parts[hi]) || 0);
  const li = headers.indexOf('LQD'); if (li !== -1) lqdArr.push(parseFloat(parts[li]) || 0);
  const mi = headers.indexOf('^MOVE'); if (mi !== -1) moveArr.push(parseFloat(parts[mi]) || 95);
  const di = headers.indexOf('DX-Y.NYB'); if (di !== -1) dxyArr.push(parseFloat(parts[di]) || 103);
}

const minLen = Math.min(...ASSETS.map(t => closesHistory[t].length), vixArr.length, tnxArr.length, irxArr.length, moveArr.length, dxyArr.length);
for (const t of ASSETS) closesHistory[t] = closesHistory[t].slice(0, minLen);
const vix = vixArr.slice(0, minLen), tnx = tnxArr.slice(0, minLen), irx = irxArr.slice(0, minLen);
const hyg = hygArr.slice(0, minLen), lqd = lqdArr.slice(0, minLen);
const move = moveArr.slice(0, minLen), dxy = dxyArr.slice(0, minLen), btcVol = btcVolArr.slice(0, minLen);

const yieldSpread = tnx.map((v, i) => v - irx[i]);
const creditSpread = hyg.map((v, i) => {
  if (v > 0 && lqd[i] > 0) { const hy = 0.045 + (1-v/100)*0.03; const ly = 0.035 + (1-lqd[i]/100)*0.02; return Math.max(1, Math.min(9, (hy-ly)*100)); }
  return 2.5 + vix[i]/20;
});
const dxyTrend: number[] = [];
for (let i = 0; i < minLen; i++) {
  if (i < 20) { dxyTrend.push(0); continue; }
  dxyTrend.push(dxy[i-20] > 0 ? ((dxy[i]-dxy[i-20])/dxy[i-20])*100 : 0);
}

console.log('Datos: ' + minLen + ' dias | ' + lines[1]?.split(',')[0] + ' -> ' + lines[lines.length-1]?.split(',')[0]);

// ── Split IS/OOS (35% / 65%) ──────────────────
const splitIdx = Math.floor(minLen * 0.35);

function sliceHistory(h: Record<string, number[]>): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const t of ASSETS) result[t] = h[t].slice(0, splitIdx);
  return result;
}

const isData = {
  closesHistory: sliceHistory(closesHistory),
  macroHistory: { vix: vix.slice(0, splitIdx), yieldSpread: yieldSpread.slice(0, splitIdx), creditSpread: creditSpread.slice(0, splitIdx), move: move.slice(0, splitIdx), dxyTrend: dxyTrend.slice(0, splitIdx), btcVol: btcVol.slice(0, splitIdx) },
};

const oosData = {
  closesHistory: (() => { const r: Record<string, number[]> = {}; for (const t of ASSETS) r[t] = closesHistory[t].slice(splitIdx); return r; })(),
  macroHistory: { vix: vix.slice(splitIdx), yieldSpread: yieldSpread.slice(splitIdx), creditSpread: creditSpread.slice(splitIdx), move: move.slice(splitIdx), dxyTrend: dxyTrend.slice(splitIdx), btcVol: btcVol.slice(splitIdx) },
};

console.log('IS:  ' + isData.macroHistory.vix.length + ' dias (35%)');
console.log('OOS: ' + oosData.macroHistory.vix.length + ' dias (65%)');
console.log('');

// ── Ejecutar backtests ────────────────────────
const SEP = '='.repeat(80);
console.log(SEP);
console.log('  VALIDACION OUT-OF-SAMPLE — Degradacion IS -> OOS');
console.log('  NOTA: Los parametros del motor son const en engineConfig.ts.');
console.log('  Esta prueba mide la generalizacion natural del motor.');
console.log(SEP);
console.log('');

console.log('Ejecutando FULL (datos completos)...');
const fullResult = runBacktest({ closesHistory, macroHistory:{vix,yieldSpread,creditSpread,move,dxyTrend,btcVol}, lookbackDays:252, rebalanceDays:21, initialCapital:10000, transactionCostBps:15 });
const fm = fullResult.metrics;
console.log('FULL: Sharpe=' + fm.sharpe.toFixed(3) + ' CAGR=' + (fm.cagr*100).toFixed(1) + '% MaxDD=' + (fm.maxDrawdown*100).toFixed(1) + '% Calmar=' + fm.calmar.toFixed(2));

console.log('');
console.log('Ejecutando IS (in-sample, primer 35%)...');
const isResult = runBacktest({ ...isData, lookbackDays:252, rebalanceDays:21, initialCapital:10000, transactionCostBps:15 });
const im = isResult.metrics;
console.log('IS:   Sharpe=' + im.sharpe.toFixed(3) + ' CAGR=' + (im.cagr*100).toFixed(1) + '% MaxDD=' + (im.maxDrawdown*100).toFixed(1) + '% Calmar=' + im.calmar.toFixed(2));

console.log('');
console.log('Ejecutando OOS (out-of-sample, 65% restante)...');
const oosResult = runBacktest({ ...oosData, lookbackDays:252, rebalanceDays:21, initialCapital:10000, transactionCostBps:15 });
const om = oosResult.metrics;
console.log('OOS:  Sharpe=' + om.sharpe.toFixed(3) + ' CAGR=' + (om.cagr*100).toFixed(1) + '% MaxDD=' + (om.maxDrawdown*100).toFixed(1) + '% Calmar=' + om.calmar.toFixed(2));

// ── Comparativa ───────────────────────────────
console.log('');
console.log(SEP);
console.log('  COMPARATIVA IS vs OOS');
console.log(SEP);
console.log('');

const fmt = (v: number, d: number) => v.toFixed(d).padStart(7);
const fmtPct = (v: number) => (v*100).toFixed(1).padStart(6) + '%';

console.log('Metrica         | IS (35%)  | OOS (65%) | Degradacion | Veredicto');
console.log('-'.repeat(75));

const dSharpe = im.sharpe - om.sharpe;
const dCagr = im.cagr - om.cagr;
const dMaxDD = im.maxDrawdown - om.maxDrawdown;
const pSharpe = im.sharpe > 0.01 ? dSharpe / im.sharpe : 0;
const pCagr = im.cagr > 0.01 ? dCagr / im.cagr : 0;

const verdict = (pct: number, threshold: number, metric: string) =>
  pct < threshold ? '✅ OK' : pct < threshold * 2 ? '🟡 WARN' : '🔴 HIGH';

console.log('Sharpe          | ' + fmt(im.sharpe,3) + '  | ' + fmt(om.sharpe,3) + '  | ' + (pSharpe*100).toFixed(1).padStart(5) + '%      | ' + verdict(pSharpe, 0.15, 'Sharpe'));
console.log('CAGR            | ' + fmtPct(im.cagr) + '  | ' + fmtPct(om.cagr) + '  | ' + (pCagr*100).toFixed(1).padStart(5) + '%      | ' + verdict(pCagr, 0.20, 'CAGR'));
console.log('MaxDD           | ' + fmtPct(im.maxDrawdown) + '  | ' + fmtPct(om.maxDrawdown) + '  | ' + (dMaxDD*100).toFixed(1).padStart(5) + 'pp     | ' + (Math.abs(dMaxDD) < 0.10 ? '✅ OK' : '🟡 WARN'));
console.log('Calmar          | ' + fmt(im.calmar,2) + '  | ' + fmt(om.calmar,2));
console.log('Volatilidad     | ' + (im.volatility*100).toFixed(1).padStart(6) + '%  | ' + (om.volatility*100).toFixed(1).padStart(6) + '%');
console.log('Win Rate        | ' + (im.winRate*100).toFixed(0).padStart(6) + '%  | ' + (om.winRate*100).toFixed(0).padStart(6) + '%');
console.log('Sortino         | ' + fmt(im.sortino,2) + '  | ' + fmt(om.sortino,2));

// ── Veredicto ──────────────────────────────────
console.log('');
console.log(SEP);
console.log('  VEREDICTO OOS');
console.log(SEP);
console.log('');

const sharpeDegradation = pSharpe;
const cagrDegradation = pCagr;

if (sharpeDegradation < 0.15 && cagrDegradation < 0.20) {
  console.log('✅ GENERALIZACION SOLIDA');
  console.log('   Degradacion Sharpe IS->OOS: ' + (sharpeDegradation * 100).toFixed(1) + '% (< 15%)');
  console.log('   Degradacion CAGR   IS->OOS: ' + (cagrDegradation * 100).toFixed(1) + '% (< 20%)');
  console.log('   El motor mantiene rendimiento comparable fuera de muestra.');
} else if (sharpeDegradation < 0.30 && cagrDegradation < 0.35) {
  console.log('🟡 GENERALIZACION MODERADA');
  console.log('   Degradacion Sharpe IS->OOS: ' + (sharpeDegradation * 100).toFixed(1) + '% (15-30%)');
  console.log('   Degradacion CAGR   IS->OOS: ' + (cagrDegradation * 100).toFixed(1) + '% (20-35%)');
  console.log('   El motor muestra cierta degradacion OOS pero se mantiene funcional.');
} else {
  console.log('🔴 POSIBLE OVERFITTING');
  console.log('   Degradacion Sharpe IS->OOS: ' + (sharpeDegradation * 100).toFixed(1) + '% (> 30%)');
  console.log('   Degradacion CAGR   IS->OOS: ' + (cagrDegradation * 100).toFixed(1) + '% (> 35%)');
  console.log('   Revisar parametros y considerar simplificar el modelo.');
}

console.log('');
console.log('Nota: Los parametros del motor (kellyCap, volTarget, tailRiskL1, etc.)');
console.log('      son constantes definidas en engineConfig.ts. No se recalibran entre');
console.log('      IS y OOS. La diferencia IS->OOS refleja cambios en el REGIMEN DE MERCADO,');
console.log('      no cambios en los parametros del motor.');
console.log(SEP);
