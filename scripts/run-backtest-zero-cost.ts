// run-backtest-zero-cost.ts (versión ES module, compatible con "type": "module")

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest } from './src/core/backtest/backtestEngine.ts';
import { ASSETS } from './src/lib/constants.ts';

// Obtener __dirname en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Cargar el CSV
const csvPath = path.join(__dirname, 'historical_data_daily.csv');
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

// 2. Identificar columnas
const priceColumns = ASSETS;
const vixCol = '^VIX';
const tnxCol = '^TNX';
const irxCol = '^IRX';
const hygCol = 'HYG';
const lqdCol = 'LQD';

// 3. Parsear datos
const dates: string[] = [];
const closesHistory: Record<string, number[]> = {};
const vixHistory: number[] = [];
const tnxHistory: number[] = [];
const irxHistory: number[] = [];
const hygHistory: number[] = [];
const lqdHistory: number[] = [];

for (const col of priceColumns) {
  closesHistory[col] = [];
}

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const parts = line.split(',');
  if (parts.length < headers.length) continue;

  const date = parts[0];
  dates.push(date);

  // Precios
  for (let j = 0; j < priceColumns.length; j++) {
    const col = priceColumns[j];
    const idx = headers.indexOf(col);
    if (idx !== -1) {
      const val = parseFloat(parts[idx]);
      closesHistory[col].push(isNaN(val) ? 0 : val);
    }
  }

  // Macro
  const vixIdx = headers.indexOf(vixCol);
  if (vixIdx !== -1) {
    const v = parseFloat(parts[vixIdx]);
    vixHistory.push(isNaN(v) ? 0 : v);
  }
  const tnxIdx = headers.indexOf(tnxCol);
  if (tnxIdx !== -1) {
    const v = parseFloat(parts[tnxIdx]);
    tnxHistory.push(isNaN(v) ? 0 : v);
  }
  const irxIdx = headers.indexOf(irxCol);
  if (irxIdx !== -1) {
    const v = parseFloat(parts[irxIdx]);
    irxHistory.push(isNaN(v) ? 0 : v);
  }
  const hygIdx = headers.indexOf(hygCol);
  if (hygIdx !== -1) {
    const v = parseFloat(parts[hygIdx]);
    hygHistory.push(isNaN(v) ? 0 : v);
  }
  const lqdIdx = headers.indexOf(lqdCol);
  if (lqdIdx !== -1) {
    const v = parseFloat(parts[lqdIdx]);
    lqdHistory.push(isNaN(v) ? 0 : v);
  }
}

// 4. Calcular yieldSpread y creditSpread
const yieldSpreadHistory: number[] = [];
const creditSpreadHistory: number[] = [];

for (let i = 0; i < dates.length; i++) {
  const tnx = tnxHistory[i];
  const irx = irxHistory[i];
  const yieldSpread = tnx - irx;
  yieldSpreadHistory.push(isNaN(yieldSpread) ? 0 : yieldSpread);

  // Credit spread proxy usando VIX (simple)
  let creditSpread = 2.5 + (vixHistory[i] / 20);
  creditSpread = Math.min(9.0, Math.max(1.0, creditSpread));
  creditSpreadHistory.push(creditSpread);
}

// 5. Construir macroHistory
const macroHistory = {
  vix: vixHistory,
  yieldSpread: yieldSpreadHistory,
  creditSpread: creditSpreadHistory,
};

// 6. Ejecutar backtest con costos de transacción cero
console.log('Ejecutando backtest con costo de transacción = 0...');
console.log(`Datos: ${dates.length} días`);

const result = runBacktest({
  closesHistory,
  macroHistory,
  lookbackDays: 252,
  rebalanceDays: 63,
  initialCapital: 10000,
  transactionCostBps: 0, // <-- Costo cero
});

// 7. Mostrar resultadosconsole.log('\n=== RESULTADOS DEL BACKTEST (COSTO DE TRANSACCIÓN = 0) ===\n');

console.log('── ENGINE (Motor Olympus) ──');
console.log(`CAGR: ${(result.metrics.cagr * 100).toFixed(2)}%`);
console.log(`Sharpe: ${result.metrics.sharpe.toFixed(2)}`);
console.log(`Max Drawdown: ${(result.metrics.maxDrawdown * 100).toFixed(2)}%`);
console.log(`Calmar: ${result.metrics.calmar.toFixed(2)}`);
console.log(`Volatilidad: ${(result.metrics.volatility * 100).toFixed(2)}%`);
console.log(`Win Rate mensual: ${(result.metrics.winRate * 100).toFixed(2)}%`);
console.log(`Capital final: €${result.metrics.finalValue.toFixed(2)}`);
console.log(`Costes totales: €${result.totalTransactionCosts.toFixed(2)}`);
console.log(`Rebalanceos: ${result.rebalanceCount}`);

console.log('');
console.log('── BENCHMARK (Equal Weight 1/n) ──');
console.log(`CAGR: ${(result.benchmarkMetrics.cagr * 100).toFixed(2)}%`);
console.log(`Sharpe: ${result.benchmarkMetrics.sharpe.toFixed(2)}`);
console.log(`Max Drawdown: ${(result.benchmarkMetrics.maxDrawdown * 100).toFixed(2)}%`);
console.log(`Calmar: ${result.benchmarkMetrics.calmar.toFixed(2)}`);
console.log(`Volatilidad: ${(result.benchmarkMetrics.volatility * 100).toFixed(2)}%`);
console.log(`Win Rate mensual: ${(result.benchmarkMetrics.winRate * 100).toFixed(2)}%`);
console.log(`Capital final: €${result.benchmarkMetrics.finalValue.toFixed(2)}`);

console.log('');
const outperformance = result.metrics.cagr - result.benchmarkMetrics.cagr;
console.log(`📊 OUTPERFORMANCE DEL ENGINE: ${(outperformance * 100).toFixed(2)}% anual`);

console.log('\n--- Métricas por régimen ---');
for (const regime of ['EXPANSION', 'CONTRACTION', 'CRISIS'] as const) {
  const m = result.regimeConditional[regime];
  console.log(`${regime}: CAGR=${(m.cagr * 100).toFixed(2)}% | Sharpe=${m.sharpe.toFixed(2)} | MaxDD=${(m.maxDrawdown * 100).toFixed(2)}% | Días=${m.totalDays}`);
}

// 8. Guardar resultados (opcional)
const outputPath = path.join(__dirname, 'backtest_result_zero_cost.csv');
const outputLines = ['Día,Valor,Drawdown,Régimen'];
result.dailyRecords.forEach(rec => {
  outputLines.push(`${rec.day},${rec.portfolioValue.toFixed(2)},${(rec.drawdown * 100).toFixed(2)},${rec.regime}`);
});
fs.writeFileSync(outputPath, outputLines.join('\n'));
console.log(`\nResultados diarios guardados en: ${outputPath}`);