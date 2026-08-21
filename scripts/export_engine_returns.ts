// Exporta retornos diarios del motor Olympus a JSON para auditoría
// Ejecutar: npx tsx scripts/export_engine_returns.ts
// R11 (unificación): usa la ruta de macro CANÓNICA compartida con el panel
// (buildMacroHistoryFromCSV) y el config de producción (useDynamicCovariance:
// true → DCC-GARCH, triggers ERP y correlation-panic activos). Antes duplicaba
// una fórmula de credit spread propia (crédito A) y corría con Ledoit-Wolf sin
// ERP/panic → motor distinto al auditado.

import fs from 'fs';
import path from 'path';
import { runBacktest } from '../src/core/backtest/backtestEngine';
import { ASSETS } from '../src/lib/constants';
import { parseCSVFromText, buildMacroHistoryFromCSV } from '../src/lib/csvBacktestProvider';

const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
console.log('CSV:', csvPath);
const csvContent = fs.readFileSync(csvPath, 'utf8');
const csvData = parseCSVFromText(csvContent);
const dates = csvData.dates;
const closesHistory = csvData.closesHistory;
const macroHistory = buildMacroHistoryFromCSV(csvData, csvData.totalDays);
const vix = macroHistory.vix;

console.log(`Datos: ${csvData.totalDays} días, ${dates[0]} → ${dates[dates.length - 1]}`);

// Ejecutar backtest
console.log('Ejecutando backtest Olympus...');
const result = runBacktest({
  closesHistory,
  macroHistory,
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
  useDynamicCovariance: true,
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
