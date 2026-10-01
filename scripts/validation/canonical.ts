// ============================================================
// scripts/validation/canonical.ts
// RUNNER CANÓNICO ÚNICO — Fase 1 · validación forense Olympus
// READ-ONLY sobre src/. No modifica el motor.
// Ejecutar: npx tsx scripts/validation/canonical.ts
//
// Objetivo: una sola definición de configuración (datos, warm-up,
// lookback, cadencia, costes, universo) y métricas homogéneas para
// FULL / IS / OOS, corrigiendo el warm-up reiniciado de los scripts
// legacy (que pierden 252 días por tramo).
// ============================================================

import fs from 'fs';
import path from 'path';
import { runBacktest, DailyRecord } from '../../src/core/backtest/backtestEngine';
import { ASSETS } from '../../src/lib/constants';

// ── CONFIGURACIÓN CONGELADA (no optimizar) ──────────────────────────────────
export const CFG = {
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,   // declarado; ver nota NO-APLICA abajo
  splitRatio: 0.35,
  RF_ANNUAL: 0.04,
  DAYS_PER_YEAR: 365,       // TRADING_DAYS_PER_YEAR en src/lib/constants.ts
} as const;

// ── CARGA DE DATOS (idéntica a scripts/run-oos-validation.ts) ───────────────
const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter(l => l.trim());
const headers = lines[0].split(',');

const closesHistory: Record<string, number[]> = {};
for (const a of ASSETS) closesHistory[a] = [];
const vixArr: number[] = [], tnxArr: number[] = [], irxArr: number[] = [],
      hygArr: number[] = [], lqdArr: number[] = [], moveArr: number[] = [],
      dxyArr: number[] = [], btcVolArr: number[] = [], datesArr: string[] = [];

for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split(',');
  if (parts.length < headers.length) continue;
  datesArr.push(parts[0]);
  for (const t of ASSETS) {
    const idx = headers.indexOf(t);
    if (idx !== -1) closesHistory[t].push(parseFloat(parts[idx]) || 0);
  }
  const g = (n: string, d: number) => {
    const i = headers.indexOf(n);
    return i === -1 ? d : parseFloat(parts[i]) || d;
  };
  vixArr.push(g('^VIX', 0)); tnxArr.push(g('^TNX', 0)); irxArr.push(g('^IRX', 0));
  hygArr.push(g('HYG', 0)); lqdArr.push(g('LQD', 0));
  moveArr.push(g('^MOVE', 95)); dxyArr.push(g('DX-Y.NYB', 103)); btcVolArr.push(g('BTC_VOL', 30));
}

const minLen = Math.min(
  ...ASSETS.map(t => closesHistory[t].length), vixArr.length, tnxArr.length,
  irxArr.length, moveArr.length, dxyArr.length
);
for (const t of ASSETS) closesHistory[t] = closesHistory[t].slice(0, minLen);
const vix = vixArr.slice(0, minLen), tnx = tnxArr.slice(0, minLen), irx = irxArr.slice(0, minLen);
const hyg = hygArr.slice(0, minLen), lqd = lqdArr.slice(0, minLen);
const move = moveArr.slice(0, minLen), dxy = dxyArr.slice(0, minLen);
const btcVol = btcVolArr.slice(0, minLen);
const dates = datesArr.slice(0, minLen);

const yieldSpread = tnx.map((v, i) => v - irx[i]);
const creditSpread = hyg.map((v, i) => {
  if (v > 0 && lqd[i] > 0) {
    const hy = 0.045 + (1 - v / 100) * 0.03, ly = 0.035 + (1 - lqd[i] / 100) * 0.02;
    return Math.max(1, Math.min(9, (hy - ly) * 100));
  }
  return 2.5 + vix[i] / 20;
});
const dxyTrend = dxy.map((_, i) => (i < 20 ? 0 : (dxy[i - 20] > 0 ? ((dxy[i] - dxy[i - 20]) / dxy[i - 20]) * 100 : 0)));

type Input = {
  closesHistory: Record<string, number[]>;
  macroHistory: Record<string, number[]>;
  lookbackDays: number; rebalanceDays: number;
  initialCapital: number; transactionCostBps: number;
};

const baseInput: Input = {
  closesHistory, macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: CFG.lookbackDays, rebalanceDays: CFG.rebalanceDays,
  initialCapital: CFG.initialCapital, transactionCostBps: CFG.transactionCostBps,
};

function sliceInput(s: number, e: number): Input {
  const ch: Record<string, number[]> = {};
  for (const t of ASSETS) ch[t] = closesHistory[t].slice(s, e);
  return {
    closesHistory: ch,
    macroHistory: {
      vix: vix.slice(s, e), yieldSpread: yieldSpread.slice(s, e), creditSpread: creditSpread.slice(s, e),
      move: move.slice(s, e), dxyTrend: dxyTrend.slice(s, e), btcVol: btcVol.slice(s, e),
    },
    lookbackDays: CFG.lookbackDays, rebalanceDays: CFG.rebalanceDays,
    initialCapital: CFG.initialCapital, transactionCostBps: CFG.transactionCostBps,
  };
}

// ── MÉTRICAS HOMOGÉNEAS ─────────────────────────────────────────────────────
interface Metrics {
  n: number; cagr: number; sharpe: number; sortino: number; maxDD: number;
  vol: number; cvar95: number; turnoverAnn: number; cashPct: number;
  rebalances: number; start: string; end: string; finalValue: number;
}

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);

function metrics(records: DailyRecord[], first: number): Metrics {
  // records ya viene recortado; `first` = índice del registro en la serie completa
  if (records.length < 2) {
    return { n: records.length, cagr: 0, sharpe: 0, sortino: 0, maxDD: 0, vol: 0,
      cvar95: 0, turnoverAnn: 0, cashPct: 0, rebalances: 0, start: '-', end: '-', finalValue: 0 };
  }
  const vals = records.map(r => r.portfolioValue);
  const rets: number[] = [];
  for (let i = 1; i < records.length; i++) rets.push(vals[i] / vals[i - 1] - 1);

  const n = rets.length;
  const years = n / CFG.DAYS_PER_YEAR;
  const totalRet = vals[vals.length - 1] / vals[0];
  const cagr = Math.pow(Math.max(0.0001, totalRet), 1 / Math.max(0.001, years)) - 1;
  const mu = mean(rets);
  const sd = Math.sqrt(mean(rets.map(r => (r - mu) ** 2)));
  const sharpe = sd > 0 ? (mu * CFG.DAYS_PER_YEAR - CFG.RF_ANNUAL) / (sd * Math.sqrt(CFG.DAYS_PER_YEAR)) : 0;
  const downside = rets.filter(r => r < 0);
  const dd_ = Math.sqrt(mean(downside.map(r => r * r)));
  const sortino = dd_ > 0 ? (mu * CFG.DAYS_PER_YEAR - CFG.RF_ANNUAL) / (dd_ * Math.sqrt(CFG.DAYS_PER_YEAR)) : 0;

  let peak = vals[0], maxDD = 0;
  for (const v of vals) { if (v > peak) peak = v; const d = v / peak - 1; if (d < maxDD) maxDD = d; }

  // CVaR 95% mensual
  const byMonth = new Map<string, number[]>();
  records.forEach((r, i) => {
    const di = first + i;
    const d = dates[di + CFG.lookbackDays];
    if (!d) return;
    byMonth.set(d.slice(0, 7), [...(byMonth.get(d.slice(0, 7)) ?? []), r.portfolioValue]);
  });
  const monthly = [...byMonth.values()].map(a => a[a.length - 1] / a[0] - 1).sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(monthly.length * 0.05));
  const cvar95 = monthly.length ? mean(monthly.slice(0, k)) : 0;

  // Turnover anualizado + nº de rebalanceos reales
  let toSum = 0, toCount = 0;
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1].allocations, b = records[i].allocations;
    let d = 0;
    for (const t of ASSETS) d += Math.abs((b[t] ?? 0) - (a[t] ?? 0));
    if (d > 1e-9) { toSum += d; toCount++; }
  }
  const rebalances = toCount;
  const turnoverAnn = toCount ? (toSum / toCount) * (CFG.DAYS_PER_YEAR / CFG.rebalanceDays) : 0;

  const cashPct = mean(records.map(r => r.cash));
  const di0 = first + CFG.lookbackDays, di1 = first + records.length - 1 + CFG.lookbackDays;

  return { n: records.length, cagr, sharpe, sortino, maxDD, vol: sd * Math.sqrt(CFG.DAYS_PER_YEAR),
    cvar95, turnoverAnn, cashPct, rebalances, start: dates[di0] ?? '?', end: dates[di1] ?? '?',
    finalValue: vals[vals.length - 1] };
}

const pct = (x: number, d = 2) => (x * 100).toFixed(d) + '%';
function row(label: string, m: Metrics) {
  console.log(
    `${label.padEnd(22)} ${String(m.n).padStart(5)}  ${pct(m.cagr).padStart(8)} ${m.sharpe.toFixed(3).padStart(7)} ` +
    `${m.sortino.toFixed(3).padStart(7)} ${pct(m.maxDD, 1).padStart(8)} ${pct(m.vol, 1).padStart(7)} ` +
    `${pct(m.cvar95, 2).padStart(8)} ${(m.turnoverAnn * 100).toFixed(0).padStart(5)}% ${pct(m.cashPct, 1).padStart(7)}`
  );
}
const HDR = `${'Ventana'.padEnd(22)} ${'n'.padStart(5)}  ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ` +
            `${'Sortino'.padStart(7)} ${'MaxDD'.padStart(8)} ${'Vol'.padStart(7)} ${'CVaR95m'.padStart(8)} ` +
            `${'Turn'.padStart(5)} ${'%Cash'.padStart(7)}`;

// ── EJECUCIÓN ───────────────────────────────────────────────────────────────
const splitIdx = Math.floor(minLen * CFG.splitRatio);
const splitDate = dates[splitIdx];

console.log('='.repeat(112));
console.log('  RUNNER CANÓNICO ÚNICO — OLYMPUS');
console.log('='.repeat(112));
console.log(`  Datos        : ${minLen} filas | ${dates[0]} -> ${dates[minLen - 1]}`);
console.log(`  Universo     : ${ASSETS.join(', ')}`);
console.log(`  Lookback     : ${CFG.lookbackDays} d   Rebalance: ${CFG.rebalanceDays} d   Capital: €${CFG.initialCapital}`);
console.log(`  Costes       : ${CFG.transactionCostBps} bps declarados (NOTA: el motor usa ASSET_COST_PARAMS por activo; el bps global es no-op)`);
console.log(`  Split IS/OOS : idx ${splitIdx} (${splitDate}) → IS ${(CFG.splitRatio * 100).toFixed(0)}% / OOS ${(100 - CFG.splitRatio * 100).toFixed(0)}%`);

console.log('\n── 0. RUN ÚNICO FULL (fuente de verdad para todo lo demás) ──');
const t0 = Date.now();
const full = runBacktest(baseInput);
const recs = full.dailyRecords;
const fullM = metrics(recs, 0);
console.log(`  Tiempo: ${((Date.now() - t0) / 1000).toFixed(1)}s | registros: ${recs.length} | rebalanceCount: ${full.rebalanceCount}`);
console.log(`  Métricas del MOTOR  : CAGR ${pct(full.metrics.cagr)} | Sharpe ${full.metrics.sharpe.toFixed(3)} | Sortino ${full.metrics.sortino.toFixed(3)} | MaxDD ${pct(full.metrics.maxDrawdown, 1)} | Vol ${pct(full.metrics.volatility, 1)}`);
console.log(`  Costes totales      : €${full.totalTransactionCosts.toFixed(2)} | ${full.transactionCostBps} bps declarados`);
console.log(`  Cross-check propio  : CAGR ${pct(fullM.cagr)} | Sharpe ${fullM.sharpe.toFixed(3)} | MaxDD ${pct(fullM.maxDD, 1)}  (debe coincidir)`);
console.log(`  Regímenes           : ${JSON.stringify(full.regimeDays)}`);
console.log(`  Días con proxies    : ${full.daysWithProxies} | con datos reales: ${full.daysWithRealData}`);

console.log('\n── 1. FULL / IS / OOS — MÉTODO CANÓNICO (warm-up NO reiniciado) ──');
console.log(HDR);
row('FULL', fullM);
const iSplit = recs.findIndex((_, i) => (dates[i + CFG.lookbackDays] ?? '') >= splitDate);
const canonIS = metrics(recs.slice(0, iSplit), 0);
const canonOOS = metrics(recs.slice(iSplit), iSplit);
row('IS  (canónico)', canonIS);
row('OOS (canónico)', canonOOS);
console.log(`  IS : ${canonIS.start} -> ${canonIS.end}    OOS: ${canonOOS.start} -> ${canonOOS.end}`);

console.log('\n── 2. MÉTODO LEGACY (re-run con datos recortados, lookback reiniciado) ──');
const legIS = runBacktest(sliceInput(0, splitIdx));
const legOOS = runBacktest(sliceInput(splitIdx, minLen));
const legISm = metrics(legIS.dailyRecords, 0);
const legOOSm = metrics(legOOS.dailyRecords, 0);
console.log(HDR);
row('IS  (legacy)', legISm);
row('OOS (legacy)', legOOSm);
const legacyTraded = legIS.dailyRecords.length + legOOS.dailyRecords.length;
console.log(`  Días operados legacy : ${legacyTraded}  (IS ${legIS.dailyRecords.length} + OOS ${legOOS.dailyRecords.length})`);
console.log(`  Días operados FULL   : ${recs.length}`);
console.log(`  Hueco NO MEDIDO      : ${recs.length - legacyTraded} días`);

console.log('\n── 3. TEST 0b — LOS 252 DÍAS QUE IS Y OOS NO CUBREN ──');
console.log(`  Ventana muerta = primeros ${CFG.lookbackDays} días del tramo OOS (el legacy los usa como warm-up, sin operar)`);
const deadRecs = recs.slice(iSplit, iSplit + CFG.lookbackDays);
const deadM = metrics(deadRecs, iSplit);
row('OOS[0:252) muerta', deadM);
console.log(`  ${deadM.start} -> ${deadM.end}`);
console.log(`  Contribución de esa ventana al CAGR FULL: ${pct(deadM.cagr)} (anualizada de su propio tramo)`);
console.log(`  CAGR FULL                                        : ${pct(fullM.cagr)}`);
const wealth = (m: Metrics) => Math.pow(1 + m.cagr, m.n / CFG.DAYS_PER_YEAR);
console.log(`  Wealth IS                        : ${wealth(canonIS).toFixed(4)}x`);
console.log(`  Wealth OOS                       : ${wealth(canonOOS).toFixed(4)}x`);
console.log(`  Wealth concatenado IS×OOS        : ${(wealth(canonIS) * wealth(canonOOS)).toFixed(4)}x`);
console.log(`  Wealth FULL                      : ${(fullM.finalValue / CFG.initialCapital).toFixed(4)}x`);
console.log(`  → Con warm-up correcto, FULL == concatenado por construcción (mismo track record, sin 253 días perdidos).`);

console.log('\n── 4. TEST 0d — DEPENDENCIA DE LA FECHA DE INICIO (3 offsets) ──');
console.log(HDR);
for (const off of [0, 30, 60]) {
  const r = runBacktest(sliceInput(off, minLen));
  row(`FULL offset ${off}`, metrics(r.dailyRecords, 0));
}
console.log(`  Look-ahead: el motor aplica las nuevas alloc el día SIGUIENTE del rebalanceo`);
console.log(`  (FIX-BT-1, backtestEngine.ts:~668-672). No se observa look-ahead en el código.`);

console.log('\n── 5. CASH EN EL BACKTEST CANÓNICO ──');
const cashArr = recs.map(r => r.cash);
const sortedCash = [...cashArr].sort((a, b) => a - b);
const meanCash = mean(cashArr);
console.log(`  Cash medio        : ${pct(meanCash, 1)}   mediana: ${pct(sortedCash[Math.floor(cashArr.length / 2)], 1)}   p95: ${pct(sortedCash[Math.floor(cashArr.length * 0.95)], 1)}   max: ${pct(Math.max(...cashArr), 1)}`);
let maxRun = 0, run = 0, maxRunEnd = '';
for (let i = 0; i < cashArr.length; i++) {
  if (cashArr[i] >= 0.5) { run++; if (run > maxRun) { maxRun = run; maxRunEnd = dates[i + CFG.lookbackDays] ?? '?'; } }
  else run = 0;
}
let maxRunAny = 0, runAny = 0;
for (let i = 0; i < cashArr.length; i++) { if (cashArr[i] > 1e-6) { runAny++; if (runAny > maxRunAny) maxRunAny = runAny; } else runAny = 0; }
console.log(`  Racha máx con cash ≥50%      : ${maxRun} días (fin ${maxRunEnd})`);
console.log(`  Racha máx con cash > 0       : ${maxRunAny} días`);
console.log(`  Días con cash 0              : ${cashArr.filter(c => c <= 1e-6).length}`);

console.log('\n' + '='.repeat(112));
console.log('  Fin runner canónico · config congelada · read-only');
console.log('='.repeat(112));