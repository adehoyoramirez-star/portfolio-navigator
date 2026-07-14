// PBO recalculation on simplified architecture (sin MinVar)
// Varies blendWeights, rebalanceDays, lookbackDays across 36 configs
// CSCV algorithm: Bailey & Lopez de Prado (2014)
// Ejecutar: npx tsx scripts/pbo_recalc.ts

import fs from 'fs';
import path from 'path';
import { runBacktest } from '../src/core/backtest/backtestEngine';
import { ASSETS } from '../src/lib/constants';

const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
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

console.log('Datos: ' + minLen + ' dias');

// Generate 36 configurations
const blendVariants = [
  { BL: 0.20, HRP: 0.80 },
  { BL: 0.24, HRP: 0.76 },  // baseline
  { BL: 0.30, HRP: 0.70 },
  { BL: 0.35, HRP: 0.65 },
  { BL: 0.40, HRP: 0.60 },
  { BL: 0.50, HRP: 0.50 },
];
const rebalanceDays = [14, 21, 28];
const lookbackDaysV = [126, 252, 504];

interface Config {
  id: number;
  blend: Record<string, number>;
  rebDays: number;
  lbDays: number;
  dailyReturns: number[];
  sharpe: number;
}

const configs: Config[] = [];
let configId = 0;

for (const blend of blendVariants) {
  for (const rebDays of rebalanceDays) {
    for (const lbDays of lookbackDaysV) {
      if (lbDays > minLen / 2) continue; // skip if lookback too large
      if (rebDays > lbDays / 2) continue; // skip if rebalance too frequent for lookback
      configId++;
      const blendW = { ...blend, MIN_VAR: 0.00 };
      configs.push({ id: configId, blend: blendW, rebDays, lbDays, dailyReturns: [], sharpe: 0 });
    }
  }
}

console.log('Configuraciones: ' + configs.length);

// Run each config
for (let c = 0; c < configs.length; c++) {
  const cfg = configs[c];
  const result = runBacktest({
    closesHistory,
    macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
    lookbackDays: cfg.lbDays,
    rebalanceDays: cfg.rebDays,
    initialCapital: 10_000,
    transactionCostBps: 15,
    blendWeights: cfg.blend,
  });
  cfg.sharpe = result.metrics.sharpe;
  
  // Extract daily returns from records
  for (let i = 1; i < result.dailyRecords.length; i++) {
    const prev = result.dailyRecords[i-1].portfolioValue;
    const curr = result.dailyRecords[i].portfolioValue;
    cfg.dailyReturns.push(prev > 0 ? curr / prev - 1 : 0);
  }
  
  console.log('  Config ' + cfg.id + ': BL=' + cfg.blend.BL.toFixed(2) + ' HRP=' + cfg.blend.HRP.toFixed(2) + ' reb=' + cfg.rebDays + ' lb=' + cfg.lbDays + ' Sharpe=' + cfg.sharpe.toFixed(3) + ' rets=' + cfg.dailyReturns.length);
}

// ── CSCV Algorithm ──
console.log('\n' + '='.repeat(70));
console.log('  PBO — Bailey & Lopez de Prado CSCV');
console.log('='.repeat(70));

const M = 2000; // bootstraps
const S = Math.min(...configs.map(c => c.dailyReturns.length));
const S_half = Math.floor(S / 2);

console.log('Configs: ' + configs.length + ', Bootstrap samples: ' + M + ', Min returns: ' + S);

// Truncate all to min length
for (const cfg of configs) {
  cfg.dailyReturns = cfg.dailyReturns.slice(0, S);
}

function sharpe(r: number[]): number {
  if (r.length < 20) return 0;
  const m = r.reduce((a,b)=>a+b,0)/r.length;
  const v = r.reduce((s,x)=>s+(x-m)**2,0)/r.length;
  const std = Math.sqrt(Math.max(1e-16, v));
  return (m*252 - 0.04) / (std*Math.sqrt(252));
}

let pboCount = 0;
let wBar = 0; // mean rank logits

for (let b = 0; b < M; b++) {
  // Random split
  const indices = Array.from({length: S}, (_, i) => i);
  // Fisher-Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  
  const isIdx = new Set(indices.slice(0, S_half));
  
  let bestIsConfig = -1;
  let bestIsSharpe = -Infinity;
  
  // Find best IS config
  for (let c = 0; c < configs.length; c++) {
    const isRets = configs[c].dailyReturns.filter((_, i) => isIdx.has(i));
    const isSr = sharpe(isRets);
    if (isSr > bestIsSharpe) {
      bestIsSharpe = isSr;
      bestIsConfig = c;
    }
  }
  
  // Get OOS Sharpe of best IS config
  const bestIsOOS = configs[bestIsConfig].dailyReturns.filter((_, i) => !isIdx.has(i));
  const bestIsOOSSharpe = sharpe(bestIsOOS);
  
  // Count configs with better OOS Sharpe
  let oosBetter = 0;
  let rankSum = 0.0;
  for (let c = 0; c < configs.length; c++) {
    if (c === bestIsConfig) continue;
    const oosRets = configs[c].dailyReturns.filter((_, i) => !isIdx.has(i));
    const oosSr = sharpe(oosRets);
    if (oosSr > bestIsOOSSharpe) {
      oosBetter++;
    }
  }
  
  // Logit of relative rank
  const w = oosBetter / (configs.length - 1);
  if (w > 0 && w < 1) {
    wBar += Math.log(w / (1 - w));
  }
  
  if (oosBetter > 0) pboCount++;
  
  if (b % 500 === 0) {
    console.log('  Bootstrap ' + b + '/' + M + ' — PBO so far: ' + (pboCount/(b+1)*100).toFixed(1) + '%');
  }
}

const pbo = pboCount / M;
const pboSe = Math.sqrt(pbo * (1 - pbo) / M);
const pboCiLow = Math.max(0, pbo - 1.96 * pboSe);
const pboCiHigh = Math.min(1, pbo + 1.96 * pboSe);

console.log('\n--- PBO RESULTS ---');
console.log('N configuraciones: ' + configs.length);
console.log('M bootstraps: ' + M);
console.log('Min returns per config: ' + S);
console.log('PBO: ' + (pbo*100).toFixed(1) + '%');
console.log('95% CI: [' + (pboCiLow*100).toFixed(1) + '%, ' + (pboCiHigh*100).toFixed(1) + '%]');

// Find winning configs (highest Sharpe)
const sortedConfigs = [...configs].sort((a, b) => b.sharpe - a.sharpe);
console.log('\nTop 3 configuraciones:');
for (let i = 0; i < Math.min(3, sortedConfigs.length); i++) {
  const c = sortedConfigs[i];
  console.log('  #' + (i+1) + ': BL=' + c.blend.BL.toFixed(2) + ' HRP=' + c.blend.HRP.toFixed(2) + ' reb=' + c.rebDays + ' lb=' + c.lbDays + ' Sharpe=' + c.sharpe.toFixed(3));
}
console.log('\nVeredicto: ' + (pbo < 0.35 ? 'PBO ACEPTABLE (<35%)' : pbo < 0.50 ? 'PBO ELEVADO (35-50%)' : 'PBO MUY ALTO (>50%)'));
fs.writeFileSync(path.join(process.cwd(), 'pbo_results.json'), JSON.stringify({ configs: sortedConfigs.map(c => ({ id: c.id, blend: c.blend, rebDays: c.rebDays, lbDays: c.lbDays, sharpe: c.sharpe })), pbo, pboCiLow, pboCiHigh }, null, 2));
console.log('\nDONE');
