import fs from 'fs';
import path from 'path';
import { runBacktest } from './backtestEngine';
import { runStressTests, formatStressResults } from '../validation/stressScenarios';
import { ASSETS } from '../../lib/constants';

const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
if (!fs.existsSync(csvPath)) {
  console.error('ERROR: No se encuentra ' + csvPath);
  process.exit(1);
}

const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

// Mapa de fallback: si el ticker de ASSETS no esta en el CSV, usar proxy
const CSV_FALLBACK: Record<string, string> = {
  '0P00000WLG.F': 'XNAS.DE',  // WLG no esta en CSV -> usar XNAS como proxy
};

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
    let colName: string = ticker;
    let idx = headers.indexOf(colName);
    if (idx === -1 && CSV_FALLBACK[ticker]) {
      colName = CSV_FALLBACK[ticker] as string;
      idx = headers.indexOf(colName);
    }
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

// Verificar datos cargados
console.log('Columnas CSV: ' + headers.join(','));
console.log('Tickers en ASSETS: ' + ASSETS.join(','));
for (const t of ASSETS) {
  console.log('  ' + t + ': ' + closesHistory[t].length + ' datos');
}

const minLen = Math.min(
  ...ASSETS.map(t => closesHistory[t].length || 999999),
  vixArr.length, tnxArr.length, irxArr.length,
  moveArr.length, dxyArr.length, btcVolArr.length
);

console.log('minLen after intersect: ' + minLen);

if (minLen < 100) {
  console.error('ERROR: Datos insuficientes (' + minLen + ' dias). Se necesitan al menos 100.');
  process.exit(1);
}

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

const fDate = lines[1]?.split(',')[0] ?? '?';
console.log('Datos: ' + minLen + ' dias | ' + fDate);
console.log('');

const SEP = '='.repeat(80);
console.log(SEP);
console.log('  EJECUTANDO BACKTEST COMPLETO...');
console.log(SEP);

const backtestInput = {
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
};

const startTime = Date.now();
const backtestOutput = runBacktest(backtestInput);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

console.log('  Backtest completado en ' + elapsed + 's');
console.log('  CAGR: ' + (backtestOutput.metrics.cagr * 100).toFixed(2) + '%');
console.log('  Sharpe: ' + backtestOutput.metrics.sharpe.toFixed(2));
console.log('  MaxDD: ' + (backtestOutput.metrics.maxDrawdown * 100).toFixed(1) + '%');
console.log('  Dias: ' + backtestOutput.dailyRecords.length);
console.log('');

console.log(SEP);
console.log('  EJECUTANDO STRESS TEST SOBRE BACKTEST...');
console.log(SEP);

const stressOutput = runStressTests(backtestInput, backtestOutput);
console.log(formatStressResults(stressOutput));

if (stressOutput.scenarios.length === 0) {
  console.log('WARN: No se pudieron ejecutar escenarios de estres - datos insuficientes.');
} else {
  const passedScenarios = stressOutput.scenarios.filter(
    s => s.resilienceScore >= 0.60
  ).length;
  console.log('--- VEREDICTO STRESS TEST ---');
  console.log('  ' + passedScenarios + '/' + stressOutput.scenarios.length + ' escenarios con resiliencia >= 60%');
  console.log('  Resiliencia global: ' + (stressOutput.overallResilience * 100).toFixed(0) + '%');
  console.log('  Peor escenario: ' + stressOutput.worstScenario);
  console.log('  Tail Risk efectividad: ' + (stressOutput.tailRiskEffectiveness * 100).toFixed(0) + '%');
  console.log('  CEWS warning rate: ' + (stressOutput.cewsWarningRate * 100).toFixed(0) + '%');
  const overallGrade = stressOutput.overallResilience >= 0.80 ? 'A (🟢)' :
    stressOutput.overallResilience >= 0.60 ? 'B (🟡)' :
    stressOutput.overallResilience >= 0.40 ? 'C (🟠)' : 'D (🔴)';
  console.log('  NOTA FINAL STRESS: ' + overallGrade);
}
