// ===============================================
// ARCHIVO: src/core/backtest/run-benchmark.ts
// RUNNER — Backtest Benchmark con nuevos parámetros
// Ejecutar: npx tsx src/core/backtest/run-benchmark.ts
// ===============================================

import fs from 'fs';
import path from 'path';
import { runBacktest } from './backtestEngine';
import { ASSETS } from '../../lib/constants';

// ── 1. Cargar CSV augmentado ──────────────────────
// Ejecutar desde la raíz del proyecto: npx tsx src/core/backtest/run-benchmark.ts
// Usamos el CSV augmentado con ^MOVE, DX-Y.NYB, BTC_VOL para activar masterRegime completo
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

// dxyTrend: 20-day rolling % change of DXY (forward-fill + trend)
const dxyTrend: number[] = [];
for (let i = 0; i < minLen; i++) {
  if (i < 20) { dxyTrend.push(0); continue; }
  const prev = dxy[i - 20];
  const curr = dxy[i];
  dxyTrend.push(prev > 0 ? ((curr - prev) / prev) * 100 : 0);
}

console.log(`\n📊 Datos cargados: ${minLen} días`);
console.log(`   Período: ${lines[1]?.split(',')[0]} → ${lines[lines.length-1]?.split(',')[0]}`);
console.log(`   VIX range: ${Math.min(...vix).toFixed(1)} – ${Math.max(...vix).toFixed(1)}`);
console.log(`   MOVE range: ${Math.min(...move).toFixed(1)} – ${Math.max(...move).toFixed(1)}`);
console.log(`   DXY range: ${Math.min(...dxy).toFixed(1)} – ${Math.max(...dxy).toFixed(1)}`);
console.log(`   BTC Vol range: ${Math.min(...btcVol).toFixed(1)}% – ${Math.max(...btcVol).toFixed(1)}%`);
console.log(`   Yield Spread range: ${Math.min(...yieldSpread).toFixed(2)} – ${Math.max(...yieldSpread).toFixed(2)}`);
console.log(`   Credit Spread range: ${Math.min(...creditSpread).toFixed(2)} – ${Math.max(...creditSpread).toFixed(2)}`);

// ── 5. Ejecutar backtest con masterRegime COMPLETO ───────────────────────
console.log('\n🚀 Ejecutando backtest con OLYMPUS V5+ (kill switch agresivo + MASTER REGIME COMPLETO)...');
console.log('   Datos macro: VIX + MOVE + DXY + BTC Vol + Yield/ Credit Spread → masterRegime.ts');

const result = runBacktest({
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: 252,
  rebalanceDays: 63,
  initialCapital: 10_000,
  transactionCostBps: 15,
});

// ── 6. Mostrar resultados ──────────────────────
const m = result.metrics;
const bm = result.benchmarkMetrics;

console.log('\n' + '='.repeat(60));
console.log('   📊 BACKTEST OLYMPUS V5+ — RESULTADOS');
console.log('='.repeat(60));
console.log(`   CAGR:                ${(m.cagr * 100).toFixed(2)}%`);
console.log(`   Sharpe Ratio:        ${m.sharpe.toFixed(2)}`);
console.log(`   Max Drawdown:        ${(m.maxDrawdown * 100).toFixed(2)}%`);
console.log(`   Calmar Ratio:        ${m.calmar.toFixed(2)}`);
console.log(`   Volatilidad:         ${(m.volatility * 100).toFixed(2)}%`);
console.log(`   Win Rate (mensual):  ${(m.winRate * 100).toFixed(1)}%`);
console.log(`   Total Return:        ${(m.totalReturn * 100).toFixed(1)}%`);
console.log(`   Capital Final:       €${m.finalValue.toLocaleString('es-ES', { minimumFractionDigits: 2 })}`);
console.log(`   Costes Transacción:  €${result.totalTransactionCosts.toFixed(2)}`);
console.log(`   Rebalanceos:         ${result.rebalanceCount}`);
console.log(`   Días con proxies:    ${result.daysWithProxies}`);
console.log(`   Días datos reales:   ${result.daysWithRealData}`);

const im = result.institutionalBenchmarkMetrics;

console.log('\n' + '-'.repeat(60));
console.log('   📈 BENCHMARK (Equal Weight 16.7% c/u)');
console.log('-'.repeat(60));
console.log(`   CAGR:                ${(bm.cagr * 100).toFixed(2)}%`);
console.log(`   Sharpe:              ${bm.sharpe.toFixed(2)}`);
console.log(`   Max Drawdown:        ${(bm.maxDrawdown * 100).toFixed(2)}%`);
console.log(`   Volatilidad:         ${(bm.volatility * 100).toFixed(2)}%`);
console.log(`   Calmar:              ${bm.calmar.toFixed(2)}`);
console.log(`   Capital Final:       €${bm.finalValue.toLocaleString('es-ES', { minimumFractionDigits: 2 })}`);

console.log('\n' + '-'.repeat(60));
console.log('   🏛️  INSTITUTIONAL BENCHMARK (Asset Registry)');
console.log('-'.repeat(60));
console.log('   Pesos: WLG 35% · PPFB 20% · VVSM 15% · BTC 10% · EMXC 10% · URNU 10%');
console.log(`   CAGR:                ${(im.cagr * 100).toFixed(2)}%`);
console.log(`   Sharpe:              ${im.sharpe.toFixed(2)}`);
console.log(`   Max Drawdown:        ${(im.maxDrawdown * 100).toFixed(2)}%`);
console.log(`   Volatilidad:         ${(im.volatility * 100).toFixed(2)}%`);
console.log(`   Calmar:              ${im.calmar.toFixed(2)}`);
console.log(`   Capital Final:       €${im.finalValue.toLocaleString('es-ES', { minimumFractionDigits: 2 })}`);

// ── Composite Strategy (80% Olympus Core + 20% BTC Satellite) ──
// Institutional product: Olympus manages risk, BTC captures upside
console.log('\n' + '-'.repeat(60));
console.log('   🎯 COMPOSITE STRATEGY (80% Olympus + 20% BTC)');
console.log('-'.repeat(60));
console.log('   Olympus as core position, BTC as satellite for asymmetric upside.');
// Approximate composite: 0.80 * Olympus + 0.20 * BTC (BTC column from closesHistory)
const btcCol = closesHistory['BTC-EUR'] ?? [];
// FIX-ALIGNMENT: backtest engine starts at lookbackDays (252). Account for offset.
const MAX_LEN = Math.max(...Object.values(closesHistory).map(c => c.length));
const backtestStartIdx = 252 + (btcCol.length - MAX_LEN);
const olympusRets = result.dailyRecords.map((r, i) => {
  const prev = i === 0 ? 10000 : result.dailyRecords[i-1].portfolioValue;
  return prev > 0 ? r.portfolioValue / prev - 1 : 0;
});
const btcRets: number[] = [];
for (let i = 0; i < result.dailyRecords.length; i++) {
  const idx = backtestStartIdx + i;
  if (idx > 0 && idx < btcCol.length && btcCol[idx-1] > 0) {
    btcRets.push(btcCol[idx] / btcCol[idx-1] - 1);
  } else {
    btcRets.push(0);
  }
}
const compositeRets = olympusRets.map((o, i) => 0.80 * o + 0.20 * (btcRets[i] ?? 0));
let compositeValue = 10000;
for (const r of compositeRets) compositeValue *= (1 + r);
// Calculate composite metrics using computeMetrics (same function as engine)
const compMetrics = (() => {
  const clean = compositeRets.filter(r => isFinite(r));
  if (clean.length === 0) return { cagr: 0, sharpe: 0, maxDrawdown: 0, calmar: 0, volatility: 0 };
  const years = clean.length / 252;
  const totalRet = compositeValue / 10000 - 1;
  const cagr = years > 0 && totalRet > -1 ? Math.pow(1 + totalRet, 1 / years) - 1 : 0;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const vol = Math.sqrt(clean.reduce((s, r) => s + (r - mean) ** 2, 0) / clean.length * 252);
  const rfDaily = 0.04 / 252;
  const excess = clean.map(r => r - rfDaily);
  const exMean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const exStd = Math.sqrt(excess.reduce((s, r) => s + (r - exMean) ** 2, 0) / excess.length * 252);
  const sharpe = exStd > 0 ? (exMean * 252) / exStd : 0;
  let peak = 10000, val = 10000, maxDD = 0;
  for (const r of clean) {
    val *= (1 + r);
    if (val > peak) peak = val;
    const dd = (val - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  const calmar = maxDD < 0 ? cagr / Math.abs(maxDD) : 0;
  return { cagr, sharpe, maxDrawdown: maxDD, calmar, volatility: vol };
})();
console.log(`   CAGR:                ${(compMetrics.cagr * 100).toFixed(2)}%`);
console.log(`   Sharpe:              ${compMetrics.sharpe.toFixed(2)}`);
console.log(`   Max Drawdown:        ${(compMetrics.maxDrawdown * 100).toFixed(2)}%`);
console.log(`   Volatilidad:         ${(compMetrics.volatility * 100).toFixed(2)}%`);
console.log(`   Calmar:              ${compMetrics.calmar.toFixed(2)}`);
console.log(`   Capital Final:       €${compositeValue.toLocaleString('es-ES', { minimumFractionDigits: 2 })}`);

console.log('\n' + '-'.repeat(60));
console.log('   🌡️  MÉTRICAS CONDICIONALES POR RÉGIMEN');
console.log('-'.repeat(60));
for (const r of ['EXPANSION', 'CONTRACTION', 'CRISIS'] as const) {
  const rm = result.regimeConditional[r];
  if (rm.totalDays > 0) {
    console.log(`   ${r.padEnd(12)} CAGR=${(rm.cagr * 100).toFixed(2)}% | Sharpe=${rm.sharpe.toFixed(2)} | MaxDD=${(rm.maxDrawdown * 100).toFixed(2)}% | Días=${rm.totalDays}`);
  } else {
    console.log(`   ${r.padEnd(12)} (sin datos en este régimen)`);
  }
}

console.log('\n' + '='.repeat(60));
console.log('   📋 COMPARATIVA INSTITUCIONAL');
console.log('='.repeat(60));
console.log('');
console.log('   ┌──────────────────────┬────────────┬────────────┬────────────┬────────────┐');
console.log('   │ Métrica              │ Olympus    │ EW (16.7%) │ Instit.    │ Comp 80/20 │');
console.log('   ├──────────────────────┼────────────┼────────────┼────────────┼────────────┤');
console.log(`   │ CAGR                 │ ${(m.cagr * 100).toFixed(2).padStart(9)}% │ ${(bm.cagr * 100).toFixed(2).padStart(9)}% │ ${(im.cagr * 100).toFixed(2).padStart(9)}% │ ${(compMetrics.cagr * 100).toFixed(2).padStart(9)}% │`);
console.log(`   │ Max Drawdown         │ ${(m.maxDrawdown * 100).toFixed(2).padStart(9)}% │ ${(bm.maxDrawdown * 100).toFixed(2).padStart(9)}% │ ${(im.maxDrawdown * 100).toFixed(2).padStart(9)}% │ ${(compMetrics.maxDrawdown * 100).toFixed(2).padStart(9)}% │`);
console.log(`   │ Calmar               │ ${m.calmar.toFixed(2).padStart(9)} │ ${bm.calmar.toFixed(2).padStart(9)} │ ${im.calmar.toFixed(2).padStart(9)} │ ${compMetrics.calmar.toFixed(2).padStart(9)} │`);
console.log(`   │ Sharpe               │ ${m.sharpe.toFixed(2).padStart(9)} │ ${bm.sharpe.toFixed(2).padStart(9)} │ ${im.sharpe.toFixed(2).padStart(9)} │ ${compMetrics.sharpe.toFixed(2).padStart(9)} │`);
console.log(`   │ Volatilidad          │ ${(m.volatility * 100).toFixed(2).padStart(9)}% │ ${(bm.volatility * 100).toFixed(2).padStart(9)}% │ ${(im.volatility * 100).toFixed(2).padStart(9)}% │ ${(compMetrics.volatility * 100).toFixed(2).padStart(9)}% │`);
console.log('   └──────────────────────┴────────────┴────────────┴────────────┴────────────┘');

// ── 7. Guardar resultados ──────────────────────
const outPath = path.join(process.cwd(), 'backtest_result_v5plus.csv');
const outLines = ['Día,Valor,Drawdown,Régimen,Sharpe252,Efectivo'];
for (const rec of result.dailyRecords) {
  outLines.push(`${rec.day},${rec.portfolioValue.toFixed(2)},${(rec.drawdown * 100).toFixed(2)},${rec.regime},${rec.rolling252Sharpe?.toFixed(2) ?? ''},${(rec.cash * 100).toFixed(1)}`);
}
fs.writeFileSync(outPath, outLines.join('\n'));
console.log(`\n💾 Resultados guardados: ${outPath}`);
