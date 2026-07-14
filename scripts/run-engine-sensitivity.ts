// ===============================================
// ARCHIVO: scripts/run-engine-sensitivity.ts
// FIX-AUDIT-INST-01: Sensitivity Analysis — Elasticidad paramétrica
// Varía parámetros del backtest ±20% y mide impacto en Sharpe, CAGR, MaxDD.
//
// NOTA: Los parámetros internos del motor (kellyCap, volTarget, tailRiskL1, etc.)
// están definidos como `const` en engineConfig.ts. Para variarlos se requiere
// modificar ese archivo antes de ejecutar. Este script testea los parámetros
// que pueden variarse a través de BacktestInput.
//
// Ejecutar: npx tsx scripts/run-engine-sensitivity.ts
// ===============================================

import fs from 'fs';
import path from 'path';
import { runBacktest, BacktestOutput } from '../src/core/backtest/backtestEngine';
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

const baseInput = { closesHistory, macroHistory:{vix,yieldSpread,creditSpread,move,dxyTrend,btcVol}, lookbackDays:252, rebalanceDays:21, initialCapital:10000, transactionCostBps:15 };

// ── Parámetros testables (±20%) ───────────────
interface Param {
  name: string;
  base: number;
  low: number;
  high: number;
  desc: string;
  apply: (input: any, value: number) => any;
}

const PARAMS: Param[] = [
  {
    name: 'rebalanceDays', base: 21, low: 17, high: 25,
    desc: 'Frecuencia de rebalanceo (días)',
    apply: (inp, v) => ({ ...inp, rebalanceDays: Math.round(v) }),
  },
  {
    name: 'lookbackDays', base: 252, low: 200, high: 300,
    desc: 'Ventana de lookback (días)',
    apply: (inp, v) => ({ ...inp, lookbackDays: Math.round(v) }),
  },
  {
    name: 'transactionCostBps', base: 15, low: 12, high: 18,
    desc: 'Costes de transacción (bps)',
    apply: (inp, v) => ({ ...inp, transactionCostBps: Math.round(v) }),
  },
];

// ── Engine-internal params (require engineConfig.ts modification) ──
const ENGINE_PARAMS = [
  { name: 'kellyCap', base: 0.30, config: 'KELLY_CONFIG.CAP' },
  { name: 'volTarget', base: 0.20, config: 'VOLATILITY_CONFIG.DEFAULT_TARGET_VOL' },
  { name: 'tailRiskL1', base: 0.12, config: 'TAIL_RISK_CONFIG.KILL_SWITCH.L1.threshold' },
  { name: 'btcCapExpansion', base: 0.35, config: 'BTC_CAPS_BY_REGIME.EXPANSION' },
  { name: 'erpTrigger', base: 0.025, config: 'ERP_CONFIG.TRIGGER_THRESHOLD' },
  { name: 'corrPanicThr', base: 0.85, config: 'CORRELATION_PANIC_CONFIG.PANIC_THRESHOLD' },
  { name: 'regimeBlendBinary', base: 0.40, config: 'REGIME_CONFIG.BINARY_WEIGHT' },
];

console.log('Datos: ' + minLen + ' dias | ' + lines[1]?.split(',')[0] + ' -> ' + lines[lines.length-1]?.split(',')[0]);
console.log('');

// ── Baseline ───────────────────────────────────
console.log('Computando baseline...');
const baseline = runBacktest(baseInput);
const bm = baseline.metrics;
console.log('Baseline: Sharpe=' + bm.sharpe.toFixed(3) + ' | CAGR=' + (bm.cagr*100).toFixed(1) + '% | MaxDD=' + (bm.maxDrawdown*100).toFixed(1) + '% | Calmar=' + bm.calmar.toFixed(2));
console.log('');

// ── Sensibilidad de parámetros testables ────────
console.log('='.repeat(85));
console.log('  SENSITIVITY ANALYSIS — Backtest-level parameters');
console.log('='.repeat(85));
console.log('');
console.log('Param              | Base   | dSharpe  | dCAGR    | dMaxDD   | dCalmar  | Elasticidad');
console.log('-'.repeat(85));

interface Row { param: string; elasticity: number; dSharpe: number; dCagr: number; }
const rows: Row[] = [];

for (const p of PARAMS) {
  const lo = runBacktest(p.apply(baseInput, p.low));
  const hi = runBacktest(p.apply(baseInput, p.high));
  const dSharpe = hi.metrics.sharpe - lo.metrics.sharpe;
  const dCagr = hi.metrics.cagr - lo.metrics.cagr;
  const dMaxDD = hi.metrics.maxDrawdown - lo.metrics.maxDrawdown;
  const dCalmar = hi.metrics.calmar - lo.metrics.calmar;
  const pctP = (p.high - p.low) / p.base;
  const pctS = bm.sharpe > 0.01 ? dSharpe / bm.sharpe : 0;
  const elast = pctP > 0.001 ? pctS / pctP : 0;
  const absE = Math.abs(elast);
  const sens = absE > 0.5 ? '🔴 HIGH' : absE > 0.2 ? '🟡 MED' : '🟢 LOW';
  rows.push({ param: p.name, elasticity: elast, dSharpe, dCagr });
  console.log(p.name.padEnd(18) + ' | ' + p.base.toFixed(0).padStart(6) + ' | ' + dSharpe.toFixed(3).padStart(7) + ' | ' + (dCagr*100).toFixed(2).padStart(7) + '% | ' + (dMaxDD*100).toFixed(2).padStart(7) + '% | ' + dCalmar.toFixed(2).padStart(7) + ' | ' + elast.toFixed(3).padStart(5) + ' ' + sens);
}

console.log('-'.repeat(85));

const avgElast = rows.reduce((s, r) => s + Math.abs(r.elasticity), 0) / rows.length;
console.log('Elasticidad media: ' + avgElast.toFixed(3));
console.log(avgElast < 0.15 ? '✅ ROBUSTO a variaciones ±20% en parámetros de backtest' :
           avgElast < 0.30 ? '🟡 MODERADAMENTE SENSIBLE' : '🔴 ALTAMENTE SENSIBLE');

// ── Engine-level params (advisory) ──────────────
console.log('');
console.log('='.repeat(85));
console.log('  ENGINE-LEVEL PARAMETERS (require engineConfig.ts modification)');
console.log('='.repeat(85));
console.log('');
console.log('Estos parámetros están definidos como `const` en src/core/config/engineConfig.ts.');
console.log('Para testear su sensibilidad, modificar los valores en ese archivo y re-ejecutar.');
console.log('');
console.log('Param              | Config Path                          | Base Value');
console.log('-'.repeat(70));
for (const p of ENGINE_PARAMS) {
  console.log(p.name.padEnd(18) + ' | ' + p.config.padEnd(38) + ' | ' + p.base);
}

// ── CSV ────────────────────────────────────────
const csvOut = ['Param,Base,Low,High,DeltaSharpe,DeltaCAGR_PCT,Elasticity,Sensitivity,Type'];
for (const r of rows) {
  const p = PARAMS.find(x => x.name === r.param)!;
  csvOut.push([r.param, p.base, p.low, p.high, r.dSharpe.toFixed(4), (r.dCagr*100).toFixed(4), r.elasticity.toFixed(4), Math.abs(r.elasticity) > 0.5 ? 'HIGH' : Math.abs(r.elasticity) > 0.2 ? 'MEDIUM' : 'LOW', 'BACKTEST'].join(','));
}
for (const p of ENGINE_PARAMS) {
  csvOut.push([p.name, p.base, (p.base*0.8).toFixed(4), (p.base*1.2).toFixed(4), 'N/A', 'N/A', 'N/A', 'REQUIRES_CONFIG', 'ENGINE'].join(','));
}
fs.writeFileSync(path.join(process.cwd(), 'sensitivity_analysis.csv'), csvOut.join('\n'));
console.log('');
console.log('CSV: sensitivity_analysis.csv');
console.log('Done.');
