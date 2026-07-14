// Exporta retornos diarios del motor Olympus a JSON para auditoría
// Ejecutar: npx tsx scripts/export_engine_returns.ts

import fs from 'fs';
import path from 'path';
import { runBacktest } from '../src/core/backtest/backtestEngine';
import { ASSETS } from '../src/lib/constants';

const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
console.log('CSV:', csvPath);
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

// Inicializar arrays
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

// Recortar a longitud común
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

// Computar macro
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

console.log(`Datos: ${minLen} días, ${dates[0]} → ${dates[minLen-1]}`);

// Ejecutar backtest
console.log('Ejecutando backtest Olympus...');
const result = runBacktest({
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
});

const m = result.metrics;
console.log(`Olympus CAGR: ${(m.cagr*100).toFixed(2)}%, Sharpe: ${m.sharpe.toFixed(3)}, MaxDD: ${(m.maxDrawdown*100).toFixed(2)}%`);

// Extraer datos forenses diarios del motor (para auditoria de crisis)
const backtestStart = 252;
const engineReturns: number[] = [];
const engineValues: number[] = [];
const engineAllocations: Record<string, number[]> = {};
for (const a of ASSETS) engineAllocations[a] = [];
const engineRegimes: string[] = [];
const engineDrawdowns: number[] = [];
const rebalanceFlags: boolean[] = [];

for (let i = 0; i < result.dailyRecords.length; i++) {
  const rec = result.dailyRecords[i];
  if (i > 0) {
    const prev = result.dailyRecords[i-1].portfolioValue;
    engineReturns.push(prev > 0 ? rec.portfolioValue / prev - 1 : 0);
    engineValues.push(rec.portfolioValue);
  }
  for (const a of ASSETS) {
    engineAllocations[a].push(rec.allocations[a] ?? 0);
  }
  engineRegimes.push(rec.regime);
  engineDrawdowns.push(rec.drawdown);
  rebalanceFlags.push(rec.day % 21 === 0);
}

// Los dailyRecords empiezan en backtestStart=252
// Para alinear: las fechas de dailyRecords[0] corresponden a dates[backtestStart]
const forensicDatesFull = dates.slice(backtestStart, backtestStart + result.dailyRecords.length);
// Para returns (empiezan en i=1), las fechas son dates[backtestStart+1..]
const engineDates = dates.slice(backtestStart + 1, backtestStart + 1 + engineReturns.length);
// Datos forenses completos (incluyendo dia 0 para ver estado inicial)
const forensicDates = dates.slice(backtestStart, backtestStart + result.dailyRecords.length);

// Extraer BTC returns para el mismo rango de fechas
const btcCloses = closesHistory['BTC-EUR'] ?? [];
const btcReturns: number[] = [];
for (let i = backtestStart + 1; i < backtestStart + 1 + engineReturns.length && i < btcCloses.length; i++) {
  const prev = btcCloses[i - 1];
  const curr = btcCloses[i];
  btcReturns.push(prev > 0 ? curr / prev - 1 : 0);
}
console.log(`BTC returns extraidos: ${btcReturns.length}`);

// Guardar a JSON
const output = {
  dates: engineDates,
  engineReturns,
  btcReturns,
  engineValues,
  // Datos forenses (para auditoria de crisis)
  forensicDates,
  forensicAllocations: engineAllocations,
  forensicRegimes: engineRegimes,
  forensicDrawdowns: engineDrawdowns,
  forensicRebalanceFlags: rebalanceFlags,
  // VIX y macro en las fechas del backtest (para entender deteccion de regimen)
  vixLevels: dates.slice(backtestStart, backtestStart + result.dailyRecords.length).map((_, i) => vix[backtestStart + i] ?? 0),
  metrics: {
    cagr: m.cagr,
    sharpe: m.sharpe,
    sortino: m.sortino,
    maxDrawdown: m.maxDrawdown,
    calmar: m.calmar,
    volatility: m.volatility,
    totalReturn: m.totalReturn,
    winRate: m.winRate,
  },
  benchmarkMetrics: {
    cagr: result.benchmarkMetrics.cagr,
    sharpe: result.benchmarkMetrics.sharpe,
    maxDrawdown: result.benchmarkMetrics.maxDrawdown,
    calmar: result.benchmarkMetrics.calmar,
    volatility: result.benchmarkMetrics.volatility,
  },
};

const outPath = path.join(process.cwd(), 'engine_returns.json');
fs.writeFileSync(outPath, JSON.stringify(output));
console.log(`JSON exportado: ${outPath} (${engineReturns.length} retornos)`);
console.log('Hecho.');
