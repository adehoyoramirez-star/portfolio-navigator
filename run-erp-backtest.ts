// ===============================================
// run-erp-backtest.ts
// Backtest con ERP Trigger + Correlation Panic:
// verifica que el sistema reduce exposición cuando
// ERP < 2.5% o correlaciones > 0.85
// ===============================================
// Ejecutar: npx tsx run-erp-backtest.ts
// ===============================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest } from './src/core/backtest/backtestEngine';
import { ASSETS } from './src/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH = path.join(__dirname, 'historical_data_daily.csv');
const ERP_TRIGGER_THRESHOLD = 0.025;
const ERP_CRITICAL_THRESHOLD = 0.010;
const CORR_PANIC_THRESHOLD = 0.85;
const CORR_CRITICAL_THRESHOLD = 0.95;

console.log('📂 Cargando datos historicos...');
const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

const priceColumns = ASSETS;
const vixCol = '^VIX';
const tnxCol = '^TNX';
const irxCol = '^IRX';

const dates: string[] = [];
const closesHistory: Record<string, number[]> = {};
const vixHistory: number[] = [];
const tnxHistory: number[] = [];
const irxHistory: number[] = [];

for (const col of priceColumns) closesHistory[col] = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const parts = line.split(',');
  if (parts.length < headers.length) continue;
  dates.push(parts[0]);
  for (let j = 0; j < priceColumns.length; j++) {
    const idx = headers.indexOf(priceColumns[j]);
    if (idx !== -1) closesHistory[priceColumns[j]].push(isNaN(parseFloat(parts[idx])) ? 0 : parseFloat(parts[idx]));
  }
  const vIdx = headers.indexOf(vixCol);
  if (vIdx !== -1) vixHistory.push(isNaN(parseFloat(parts[vIdx])) ? 0 : parseFloat(parts[vIdx]));
  const tIdx = headers.indexOf(tnxCol);
  if (tIdx !== -1) tnxHistory.push(isNaN(parseFloat(parts[tIdx])) ? 0 : parseFloat(parts[tIdx]));
  const iIdx = headers.indexOf(irxCol);
  if (iIdx !== -1) irxHistory.push(isNaN(parseFloat(parts[iIdx])) ? 0 : parseFloat(parts[iIdx]));
}

const totalDays = dates.length;
console.log('   ' + totalDays + ' dias (' + dates[0] + ' -> ' + dates[totalDays-1] + ')');
console.log('📊 Calculando proxy de ERP y correlacion...');

// ── PROXY DE ERP ────────────────────────────────────────────────
// Earnings yield contra-cíclico basado en desviación de retorno 3Y
function computeERPProxy(priceHistory: number[], riskFree: number[]): number[] {
  const n = Math.min(priceHistory.length, riskFree.length);
  const erpValues: number[] = [];
  const LONG_TERM_EY = 0.055;
  for (let t = 0; t < n; t++) {
    const rf = riskFree[t] ?? 0.04;
    if (t < 756) {
      erpValues.push(LONG_TERM_EY - rf);
      continue;
    }
    const p3yAgo = priceHistory[t - 756] ?? priceHistory[0];
    const pNow = priceHistory[t];
    if (p3yAgo <= 0 || pNow <= 0) { erpValues.push(LONG_TERM_EY - rf); continue; }
    const total3yReturn = pNow / p3yAgo - 1;
    const expected3yReturn = 0.075 * 3;
    const deviation = total3yReturn - expected3yReturn;
    const adjustment = Math.max(-0.03, Math.min(0.03, -deviation * 0.15));
    const earningsYield = LONG_TERM_EY + adjustment;
    const erp = earningsYield - rf;
    erpValues.push(Math.max(-0.05, Math.min(0.10, erp)));
  }
  return erpValues;
}

const wlgPrices = closesHistory['0P00000WLG.F'] ?? Array(totalDays).fill(200);
const riskFreeDecimal = tnxHistory.map(v => v / 100);
const erpProxy = computeERPProxy(wlgPrices, riskFreeDecimal);

// ── PROXY DE CORRELACIÓN MEDIA ──────────────────────────────────
// Durante estrés de mercado, las correlaciones convergen a 1.
// Modelo simple: avgCorr = 0.30 + min(0.65, VIX/50 * 0.65)
// VIX=15 → 0.30+0.195=0.50  (baja correlación, diversificación normal)
// VIX=25 → 0.30+0.325=0.63  (correlación moderada)
// VIX=35 → 0.30+0.455=0.76  (correlación alta)
// VIX=45 → 0.30+0.585=0.89  (¡pánico! supera threshold 0.85)
// VIX=55 → 0.30+0.650=0.95  (¡crítico! supera 0.95)
// VIX=65 → 0.30+0.650=0.95  (saturado en 0.95)
function computeCorrelationProxy(vixHistory: number[]): number[] {
  return vixHistory.map(vix => {
    const raw = 0.30 + Math.min(0.65, (vix / 50) * 0.65);
    return Math.max(0.20, Math.min(0.95, raw));
  });
}

const avgCorrelationProxy = computeCorrelationProxy(vixHistory);

const yieldSpreadHistory: number[] = [];
const creditSpreadHistory: number[] = [];
for (let i = 0; i < totalDays; i++) {
  const tnx = tnxHistory[i];
  const irx = irxHistory[i];
  yieldSpreadHistory.push(isNaN(tnx - irx) ? 1.5 : tnx - irx);
  const cs = 2.5 + (vixHistory[i] / 20);
  creditSpreadHistory.push(Math.min(9.0, Math.max(1.0, cs)));
}

const baseMacro = {
  vix: vixHistory,
  yieldSpread: yieldSpreadHistory,
  creditSpread: creditSpreadHistory,
};

// ── BACKTEST 1: SIN TRIGGERS (baseline) ─────────────────────────
console.log('\nBacktest SIN triggers (baseline)...');
const resultBaseline = runBacktest({
  closesHistory, lookbackDays: 252, rebalanceDays: 21, initialCapital: 10000, transactionCostBps: 15,
  macroHistory: { ...baseMacro },
});
console.log('  CAGR: ' + (resultBaseline.metrics.cagr*100).toFixed(2) + '% | Sharpe: ' + resultBaseline.metrics.sharpe.toFixed(2) + ' | MaxDD: ' + (resultBaseline.metrics.maxDrawdown*100).toFixed(2) + '%');

// ── BACKTEST 2: SOLO ERP TRIGGER ────────────────────────────────
console.log('\nBacktest solo ERP trigger...');
const resultERP = runBacktest({
  closesHistory, lookbackDays: 252, rebalanceDays: 21, initialCapital: 10000, transactionCostBps: 15,
  macroHistory: { ...baseMacro, erpValue: erpProxy },
});
console.log('  CAGR: ' + (resultERP.metrics.cagr*100).toFixed(2) + '% | Sharpe: ' + resultERP.metrics.sharpe.toFixed(2) + ' | MaxDD: ' + (resultERP.metrics.maxDrawdown*100).toFixed(2) + '%');

// ── BACKTEST 3: ERP + CORRELATION PANIC ────────────────────────
console.log('\nBacktest ERP + Correlation Panic...');
const resultCombined = runBacktest({
  closesHistory, lookbackDays: 252, rebalanceDays: 21, initialCapital: 10000, transactionCostBps: 15,
  macroHistory: { ...baseMacro, erpValue: erpProxy, avgCorrelation: avgCorrelationProxy },
});
console.log('  CAGR: ' + (resultCombined.metrics.cagr*100).toFixed(2) + '% | Sharpe: ' + resultCombined.metrics.sharpe.toFixed(2) + ' | MaxDD: ' + (resultCombined.metrics.maxDrawdown*100).toFixed(2) + '%');

// ── COMPARATIVA COMPLETA ───────────────────────────────────────
console.log('\n=== COMPARATIVA COMPLETA ===');
console.log('  Metric         | Sin triggers   | Solo ERP       | ERP+Corr       | Mejoria');
console.log('  ' + '-'.repeat(90));
console.log('  CAGR:          | ' + (resultBaseline.metrics.cagr*100).toFixed(2) + '%' + '          | ' + (resultERP.metrics.cagr*100).toFixed(2) + '%' + '          | ' + (resultCombined.metrics.cagr*100).toFixed(2) + '%' + '          | ' + ((resultCombined.metrics.cagr-resultBaseline.metrics.cagr)*100).toFixed(2) + 'pp');
console.log('  Sharpe:        | ' + resultBaseline.metrics.sharpe.toFixed(4) + '    | ' + resultERP.metrics.sharpe.toFixed(4) + '    | ' + resultCombined.metrics.sharpe.toFixed(4) + '    | +' + (resultCombined.metrics.sharpe-resultBaseline.metrics.sharpe).toFixed(4));
console.log('  MaxDD:         | ' + (resultBaseline.metrics.maxDrawdown*100).toFixed(2) + '%' + '          | ' + (resultERP.metrics.maxDrawdown*100).toFixed(2) + '%' + '          | ' + (resultCombined.metrics.maxDrawdown*100).toFixed(2) + '%' + '          | ' + ((resultCombined.metrics.maxDrawdown-resultBaseline.metrics.maxDrawdown)*100).toFixed(2) + 'pp');
console.log('  Vol:           | ' + (resultBaseline.metrics.volatility*100).toFixed(2) + '%' + '          | ' + (resultERP.metrics.volatility*100).toFixed(2) + '%' + '          | ' + (resultCombined.metrics.volatility*100).toFixed(2) + '%' + '          | ' + ((resultCombined.metrics.volatility-resultBaseline.metrics.volatility)*100).toFixed(2) + 'pp');

// ── ANÁLISIS DE CORRELACIÓN PANIC ──────────────────────────────
console.log('\n=== DIAS CON CORRELATION PANIC ACTIVO ===');
let panicDays = 0;
let criticalCorrDays = 0;
for (let i = 0; i < totalDays; i++) {
  if (avgCorrelationProxy[i] > CORR_PANIC_THRESHOLD) {
    panicDays++;
    if (avgCorrelationProxy[i] > CORR_CRITICAL_THRESHOLD) criticalCorrDays++;
  }
}
console.log('  Dias con correlacion > 0.85: ' + panicDays + ' (' + (panicDays/totalDays*100).toFixed(1) + '%)');
console.log('  Dias con correlacion > 0.95: ' + criticalCorrDays + ' (' + (criticalCorrDays/totalDays*100).toFixed(1) + '%)');

// Muestras de exposicion cuando correlation panic esta activo
let panicSamples = 0;
for (let i = 252; i < Math.min(totalDays, resultCombined.dailyRecords.length + 252); i++) {
  if (avgCorrelationProxy[i] > CORR_PANIC_THRESHOLD && panicSamples < 10) {
    const di = i - 252;
    if (di < resultCombined.dailyRecords.length) {
      const expBase = Object.values(resultBaseline.dailyRecords[di]?.allocations ?? {}).reduce((s, v) => s + v, 0);
      const expComb = Object.values(resultCombined.dailyRecords[di]?.allocations ?? {}).reduce((s, v) => s + v, 0);
      if (Math.abs(expComb - expBase) > 0.001) {
        console.log('  ' + dates[i] + ' | Corr=' + (avgCorrelationProxy[i]*100).toFixed(1) + '% | VIX=' + (vixHistory[i]?.toFixed(0) ?? '?') + ' | Exp base: ' + (expBase*100).toFixed(1) + '% -> Exp panic: ' + (expComb*100).toFixed(1) + '%');
        panicSamples++;
      }
    }
  }
}

// ── PERIODOS HISTÓRICOS CLAVE ──────────────────────────────────
console.log('\n=== ANALISIS POR PERIODOS ===');
const periods = [
  { name: '2021 Q4 (pico bull)', start: '2021-10-01', end: '2021-12-31' },
  { name: '2022 Q1 (inicio bear)', start: '2022-01-01', end: '2022-03-31' },
  { name: '2022 completo', start: '2022-01-01', end: '2022-12-31' },
  { name: 'COVID Crash 2020', start: '2020-02-01', end: '2020-04-30' },
];

for (const p of periods) {
  const si = dates.findIndex(d => d >= p.start);
  const ei = dates.findIndex(d => d > p.end);
  if (si < 0 || ei < 0) { console.log('  ' + p.name + ': no en dataset'); continue; }

  const erpSlice = erpProxy.slice(si, ei+1);
  const corrSlice = avgCorrelationProxy.slice(si, ei+1);
  const erpAvg = erpSlice.reduce((s, v) => s + v, 0) / erpSlice.length;
  const corrAvg = corrSlice.reduce((s, v) => s + v, 0) / corrSlice.length;
  const erpTrig = erpSlice.filter(e => e < ERP_TRIGGER_THRESHOLD).length;
  const corrPanic = corrSlice.filter(c => c > CORR_PANIC_THRESHOLD).length;

  console.log('  ' + p.name + ':');
  console.log('    ERP medio ' + (erpAvg*100).toFixed(2) + '% | trigger ' + erpTrig + '/' + erpSlice.length + ' dias');
  console.log('    Corr media ' + (corrAvg*100).toFixed(1) + '% | panic ' + corrPanic + '/' + corrSlice.length + ' dias');

  // Drawdowns comparativos durante este periodo
  const baseStart = resultBaseline.dailyRecords.findIndex(r => r.day >= si - 252);
  const combStart = resultCombined.dailyRecords.findIndex(r => r.day >= si - 252);
  const baseEnd = resultBaseline.dailyRecords.findIndex(r => r.day > ei - 252);
  const combEnd = resultCombined.dailyRecords.findIndex(r => r.day > ei - 252);
  if (baseStart >= 0 && baseEnd > baseStart && combStart >= 0 && combEnd > combStart) {
    const baseDD = Math.min(...resultBaseline.dailyRecords.slice(baseStart, baseEnd).map(r => r.drawdown));
    const combDD = Math.min(...resultCombined.dailyRecords.slice(combStart, combEnd).map(r => r.drawdown));
    console.log('    MaxDD base: ' + (baseDD*100).toFixed(2) + '% | MaxDD comb: ' + (combDD*100).toFixed(2) + '% | mejora: ' + ((combDD - baseDD)*100).toFixed(2) + 'pp');
  }
}

// ── GUARDAR CSV ────────────────────────────────────────────────
console.log('\nGuardando resultados...');
const outputPath = path.join(__dirname, 'erp_backtest_results.csv');
const csvHeader = 'Date,ERP,Corr,ExpBase,ExpERP,ExpComb,DDBase,DDERP,DDComb,ERPTrigger,CorrPanic';
const csvRows: string[] = [csvHeader];
const maxRecords = Math.min(erpProxy.length, resultCombined.dailyRecords.length + 252, resultBaseline.dailyRecords.length + 252, totalDays);

for (let i = 252; i < maxRecords; i++) {
  const di = i - 252;
  if (di >= resultBaseline.dailyRecords.length || di >= resultCombined.dailyRecords.length) break;

  const totalBase = Object.values(resultBaseline.dailyRecords[di].allocations).reduce((s, v) => s + v, 0);
  const totalERP = di < resultERP.dailyRecords.length
    ? Object.values(resultERP.dailyRecords[di].allocations).reduce((s, v) => s + v, 0)
    : totalBase;
  const totalComb = Object.values(resultCombined.dailyRecords[di].allocations).reduce((s, v) => s + v, 0);

  csvRows.push(
    dates[i] + ',' +
    (erpProxy[i]*100).toFixed(2) + ',' +
    (avgCorrelationProxy[i]*100).toFixed(1) + ',' +
    (totalBase*100).toFixed(2) + ',' +
    (totalERP*100).toFixed(2) + ',' +
    (totalComb*100).toFixed(2) + ',' +
    ((resultBaseline.dailyRecords[di]?.drawdown??0)*100).toFixed(2) + ',' +
    ((resultERP.dailyRecords[di]?.drawdown??0)*100).toFixed(2) + ',' +
    ((resultCombined.dailyRecords[di]?.drawdown??0)*100).toFixed(2) + ',' +
    (erpProxy[i] < ERP_TRIGGER_THRESHOLD ? '1' : '0') + ',' +
    (avgCorrelationProxy[i] > CORR_PANIC_THRESHOLD ? '1' : '0')
  );
}
fs.writeFileSync(outputPath, csvRows.join('\n'));
console.log('Resultados guardados en: ' + outputPath);
console.log('Hecho.');
