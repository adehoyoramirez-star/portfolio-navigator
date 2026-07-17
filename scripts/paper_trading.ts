// Paper Trading Institucional — Olympus V5+
// Double tracking: motor activo (Olympus) vs congelado (do-nothing)
// Reset mark-to-market desde día 0 — sin sesgo de rebote
// Ejecutar: npx tsx scripts/paper_trading.ts

import fs from 'fs';
import path from 'path';
import { runBacktest } from '../src/core/backtest/backtestEngine';
import { ASSETS } from '../src/lib/constants';

// ── Cargar config de paper trading ──
const configPath = path.join(process.cwd(), 'paper_trading_config.json');
if (!fs.existsSync(configPath)) {
  console.log('ERROR: paper_trading_config.json not found. Create it first with real positions.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const paperStart = config.paper_trading_start;
const initialCash = config.initial_cash as number;
const positions: Record<string, { shares: number; avg_price_original: number }> = config.positions;
const mtmDay0: Record<string, number> = config.mark_to_market_day0;

// ── Cargar CSV ──
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

// ── Dia 0: mark-to-market ──
const cutoffIdx = dates.findIndex(d => d >= paperStart);
if (cutoffIdx < 0) {
  console.log('ERROR: paper trading start date ' + paperStart + ' not found in data');
  console.log('Available range: ' + dates[0] + ' -> ' + dates[minLen-1]);
  process.exit(1);
}

// Compute user's actual day-0 portfolio value (mark-to-market)
let equityDay0 = 0;
const legacyPnLByAsset: Record<string, number> = {};
for (const ticker of ASSETS) {
  const pos = positions[ticker];
  if (!pos || pos.shares <= 0) continue;
  const mtmPrice = mtmDay0[ticker];
  if (!mtmPrice || mtmPrice <= 0) {
    console.log('WARNING: no mark-to-market price for ' + ticker + ', using CSV close');
    // fallback: use CSV close at cutoff
    const csvClose = closesHistory[ticker][cutoffIdx];
    if (csvClose <= 0) continue;
    const currentVal = pos.shares * csvClose;
    equityDay0 += currentVal;
    const costBasis = pos.shares * pos.avg_price_original;
    legacyPnLByAsset[ticker] = currentVal - costBasis;
  } else {
    const currentVal = pos.shares * mtmPrice;
    equityDay0 += currentVal;
    const costBasis = pos.shares * pos.avg_price_original;
    legacyPnLByAsset[ticker] = currentVal - costBasis;
  }
}
const totalPortfolioDay0 = equityDay0 + initialCash;
const legacyPnL = Object.values(legacyPnLByAsset).reduce((a, b) => a + b, 0);

console.log('═══════════════════════════════════════════════');
console.log('PAPER TRADING INSTITUCIONAL — Olympus V5+');
console.log('═══════════════════════════════════════════════');
console.log('Día 0: ' + paperStart + ' (index ' + cutoffIdx + ')');
console.log('Rango datos: ' + dates[0] + ' -> ' + dates[minLen-1]);
console.log();
console.log('--- RESET MARK-TO-MARKET (Día 0) ---');
for (const ticker of ASSETS) {
  const pos = positions[ticker];
  if (!pos || pos.shares <= 0) continue;
  const mtm = mtmDay0[ticker];
  const val = pos.shares * mtm;
  const legacy = legacyPnLByAsset[ticker] || 0;
  console.log('  ' + ticker + ': ' + pos.shares + ' × €' + mtm.toFixed(2) + ' = €' + val.toFixed(0)
    + '  |  Legacy P&L: €' + (legacy >= 0 ? '+' : '') + legacy.toFixed(0));
}
console.log('  Cash: €' + initialCash.toFixed(0));
console.log('  ─────────────────────────────');
console.log('  TOTAL Día 0: €' + totalPortfolioDay0.toFixed(0));
console.log('  Legacy P&L acumulado: €' + (legacyPnL >= 0 ? '+' : '') + legacyPnL.toFixed(0));
console.log('  ⚠️  El P&L del paper trading empieza desde CERO.');
console.log('  ⚠️  Las pérdidas/ganancias anteriores quedan archivadas como "legacy".');
console.log();

// ── Run backtest (motor path) ──
console.log('Ejecutando backtest del motor...');
const result = runBacktest({
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
});

const backtestStart = 252;
let forwardStartRecordIdx = cutoffIdx - backtestStart;

if (forwardStartRecordIdx < 0) {
  console.log('ERROR: cutoff date too early — need at least ' + backtestStart + ' days of lookback data before ' + paperStart);
  console.log('First available date with enough lookback: ' + dates[backtestStart]);
  process.exit(1);
}

// Clamp to valid range: cutoff may be at the very end of data with zero forward days
const origForwardIdx = forwardStartRecordIdx;
if (forwardStartRecordIdx >= result.dailyRecords.length) {
  forwardStartRecordIdx = result.dailyRecords.length - 1;
  if (forwardStartRecordIdx < 0) {
    console.log('ERROR: not enough data for any forward period. Add more data to the CSV.');
    process.exit(1);
  }
}

const forwardRecords = result.dailyRecords.slice(forwardStartRecordIdx);

if (origForwardIdx >= result.dailyRecords.length) {
  console.log('⚠️  ADVERTENCIA: La fecha de corte (' + paperStart + ') está al borde de los datos.');
  console.log('⚠️  Solo hay ' + forwardRecords.length + ' día(s) de datos forward. El backtest necesita al menos 21-63 días para ser significativo.');
  console.log('⚠️  Ejecuta append_weekly_data.ts para añadir datos frescos y vuelve a correr paper_trading.ts.');
  console.log();
}

// Scale factor: backtest starts with 10_000 but the user has totalPortfolioDay0
// The backtest portfolio value at cutoff (first forward record) is our anchor
const btAnchor = forwardRecords[0].portfolioValue;
const scaleFactor = totalPortfolioDay0 / btAnchor;

console.log('Backtest anchor value at cutoff: €' + btAnchor.toFixed(2));
console.log('Scale factor: ' + scaleFactor.toFixed(4) + 'x');
console.log('Forward records: ' + forwardRecords.length);
console.log();

// ── Frozen Benchmark (do-nothing) ──
// Start with same initial shares × day-0 prices, never rebalance, never trade
const frozenShares: Record<string, number> = {};
for (const ticker of ASSETS) {
  frozenShares[ticker] = positions[ticker]?.shares ?? 0;
}
let frozenCash = initialCash;

// Pre-compute frozen path
const frozenValues: number[] = [];
for (let i = 0; i < forwardRecords.length; i++) {
  const csvIdx = cutoffIdx + i;
  if (csvIdx >= minLen) { frozenValues.push(frozenValues[frozenValues.length-1]); continue; }
  let equity = 0;
  for (const ticker of ASSETS) {
    const price = closesHistory[ticker][csvIdx];
    if (price > 0 && frozenShares[ticker] > 0) {
      equity += frozenShares[ticker] * price;
    }
  }
  frozenValues.push(equity + frozenCash);
}

// ── Motor path scaled ──
const motorValues = forwardRecords.map(r => r.portfolioValue * scaleFactor);

console.log('--- FORWARD PERIOD (' + dates[cutoffIdx] + ' -> ' + dates[Math.min(minLen-1, cutoffIdx + forwardRecords.length - 1)] + ') ---');
console.log('Days forward: ' + forwardRecords.length);
console.log();

// ── Compute forward metrics: Motor ──
const motorReturns: number[] = [];
for (let i = 1; i < motorValues.length; i++) {
  motorReturns.push(motorValues[i-1] > 0 ? motorValues[i] / motorValues[i-1] - 1 : 0);
}
const mMotor = motorReturns.length > 0 ? motorReturns.reduce((a,b)=>a+b,0)/motorReturns.length : 0;
const vMotor = motorReturns.length > 0 ? motorReturns.reduce((s,x)=>s+(x-mMotor)**2,0)/motorReturns.length : 0;
const sMotor = Math.sqrt(Math.max(1e-16, vMotor));
const sharpeMotor = (mMotor*252 - 0.04) / Math.max(0.01, sMotor*Math.sqrt(252));
let trMotor = 1.0;
for (const r of motorReturns) trMotor *= (1+r);
const yearsM = Math.max(0.01, motorReturns.length / 252);
const cagrMotor = trMotor ** (1/yearsM) - 1;
let peakM = motorValues[0], maxDDM = 0;
for (const v of motorValues) {
  if (v > peakM) peakM = v;
  const dd = (v - peakM) / peakM;
  if (dd < maxDDM) maxDDM = dd;
}

// ── Compute forward metrics: Frozen ──
const frozenReturns: number[] = [];
for (let i = 1; i < frozenValues.length; i++) {
  frozenReturns.push(frozenValues[i-1] > 0 ? frozenValues[i] / frozenValues[i-1] - 1 : 0);
}
const mFrozen = frozenReturns.length > 0 ? frozenReturns.reduce((a,b)=>a+b,0)/frozenReturns.length : 0;
const vFrozen = frozenReturns.length > 0 ? frozenReturns.reduce((s,x)=>s+(x-mFrozen)**2,0)/frozenReturns.length : 0;
const sFrozen = Math.sqrt(Math.max(1e-16, vFrozen));
const sharpeFrozen = (mFrozen*252 - 0.04) / Math.max(0.01, sFrozen*Math.sqrt(252));
let trFrozen = 1.0;
for (const r of frozenReturns) trFrozen *= (1+r);
const yearsF = Math.max(0.01, frozenReturns.length / 252);
const cagrFrozen = trFrozen ** (1/yearsF) - 1;
let peakF = frozenValues[0], maxDDF = 0;
for (const v of frozenValues) {
  if (v > peakF) peakF = v;
  const dd = (v - peakF) / peakF;
  if (dd < maxDDF) maxDDF = dd;
}

// ── Alpha (motor - frozen) ──
const alphaReturns: number[] = [];
for (let i = 1; i < Math.min(motorValues.length, frozenValues.length); i++) {
  const m = motorValues[i-1] > 0 ? motorValues[i] / motorValues[i-1] - 1 : 0;
  const f = frozenValues[i-1] > 0 ? frozenValues[i] / frozenValues[i-1] - 1 : 0;
  alphaReturns.push(m - f);
}
const mAlpha = alphaReturns.length > 0 ? alphaReturns.reduce((a,b)=>a+b,0)/alphaReturns.length : 0;
const sAlpha = Math.sqrt(Math.max(1e-16, alphaReturns.reduce((s,x)=>s+(x-mAlpha)**2,0)/alphaReturns.length));
const tStat = mAlpha / Math.max(1e-10, sAlpha / Math.sqrt(alphaReturns.length));
const alphaCagrDaily = mAlpha * 252; // annualized alpha
const alphaSignificant = Math.abs(tStat) > 1.96;

// ── Output ──
console.log('═══════════════════════════════════════════════');
console.log('RESULTADOS — Paper Trading vs Frozen Benchmark');
console.log('═══════════════════════════════════════════════');
console.log();
console.log('              MOTOR       FROZEN      ALPHA');
console.log('Sharpe:      ' + sharpeMotor.toFixed(3) + '       ' + sharpeFrozen.toFixed(3) + '       ' + (sharpeMotor - sharpeFrozen >= 0 ? '+' : '') + (sharpeMotor - sharpeFrozen).toFixed(3));
console.log('CAGR:        ' + (cagrMotor*100).toFixed(2) + '%      ' + (cagrFrozen*100).toFixed(2) + '%      ' + (alphaCagrDaily >= 0 ? '+' : '') + (alphaCagrDaily*100).toFixed(2) + '%');
console.log('MaxDD:       ' + (maxDDM*100).toFixed(2) + '%      ' + (maxDDF*100).toFixed(2) + '%      ' + (maxDDM - maxDDF >= 0 ? '+' : '') + ((maxDDM - maxDDF)*100).toFixed(2) + 'pp');
console.log('Final (€):   ' + motorValues[motorValues.length-1].toFixed(0) + '   ' + frozenValues[frozenValues.length-1].toFixed(0));
console.log();
console.log('Alpha annualized:  ' + (alphaCagrDaily >= 0 ? '+' : '') + (alphaCagrDaily*100).toFixed(2) + '%');
console.log('t-statistic:       ' + tStat.toFixed(3));
console.log('Significativo (95%): ' + (alphaSignificant ? '✅ SÍ' : '❌ NO'));
console.log();

// Regime distribution
const regimeCount: Record<string, number> = { EXPANSION: 0, CONTRACTION: 0, CRISIS: 0 };
for (const rec of forwardRecords) {
  regimeCount[rec.regime] = (regimeCount[rec.regime] || 0) + 1;
}
console.log('Regime: EXPANSION=' + regimeCount['EXPANSION'] + ' CONTRACTION=' + regimeCount['CONTRACTION'] + ' CRISIS=' + regimeCount['CRISIS']);

// ── Decision log (institucional) ──
const logPath = path.join(process.cwd(), 'paper_trading_log.csv');
const logLines: string[] = [
  'date,motorValue,frozenValue,motorDD,motorRegime,allocations,rebalanceDay,legacyPnL,alphaDaily'
];
for (let i = 0; i < forwardRecords.length; i++) {
  const rec = forwardRecords[i];
  const date = dates[backtestStart + forwardStartRecordIdx + i] || '';
  const allocs = ASSETS.map(t => t + ':' + ((rec.allocations[t]||0)*100).toFixed(1) + '%').join('|');
  const isReb = (i > 0 && forwardStartRecordIdx + i > 0 && (forwardStartRecordIdx + i) % 21 === 0) ? 'Y' : 'N';

  // Compute current legacy P&L based on current prices vs original cost basis
  const csvIdx = cutoffIdx + i;
  let currentLegacyPnL = legacyPnL; // start from day 0 legacy
  if (csvIdx < minLen) {
    currentLegacyPnL = 0;
    for (const ticker of ASSETS) {
      const pos = positions[ticker];
      if (!pos || pos.shares <= 0) continue;
      const price = closesHistory[ticker][csvIdx];
      if (price <= 0) continue;
      currentLegacyPnL += pos.shares * (price - pos.avg_price_original);
    }
  }

  // Alpha daily (excess return of motor over frozen)
  let alphaDaily = 0;
  if (i > 0 && motorValues[i-1] > 0 && frozenValues[i-1] > 0) {
    alphaDaily = (motorValues[i] / motorValues[i-1]) - (frozenValues[i] / frozenValues[i-1]);
  }

  logLines.push(
    date + ',' +
    motorValues[i].toFixed(2) + ',' +
    frozenValues[i].toFixed(2) + ',' +
    (rec.drawdown * 100).toFixed(2) + '%,' +
    rec.regime + ',' +
    allocs + ',' +
    isReb + ',' +
    currentLegacyPnL.toFixed(2) + ',' +
    alphaDaily.toFixed(6)
  );
}
fs.writeFileSync(logPath, logLines.join('\n'));
console.log('\nDecision log institucional: ' + logPath + ' (' + (logLines.length-1) + ' entries)');
console.log('Columnas: date | motorValue | frozenValue | motorDD | motorRegime | allocations | rebalanceDay | legacyPnL | alphaDaily');

// ── JSON summary ──
const summaryPath = path.join(process.cwd(), 'paper_trading_summary.json');
fs.writeFileSync(summaryPath, JSON.stringify({
  paper_trading_start: paperStart,
  last_date: dates[Math.min(minLen-1, cutoffIdx + forwardRecords.length - 1)],
  days_forward: forwardRecords.length,
  day0: {
    equity_mtm: equityDay0,
    cash: initialCash,
    total: totalPortfolioDay0,
    legacy_pnl: legacyPnL,
  },
  motor: {
    sharpe: sharpeMotor,
    cagr: cagrMotor,
    maxDD: maxDDM,
    final_value: motorValues[motorValues.length-1],
  },
  frozen: {
    sharpe: sharpeFrozen,
    cagr: cagrFrozen,
    maxDD: maxDDF,
    final_value: frozenValues[frozenValues.length-1],
  },
  alpha: {
    daily_cagr: alphaCagrDaily,
    t_statistic: tStat,
    significant_95pct: alphaSignificant,
    sharpe_diff: sharpeMotor - sharpeFrozen,
  },
  regime_distribution: regimeCount,
  institutional: {
    reset_mtm_day0: true,
    dual_tracking: 'motor vs frozen (do-nothing)',
    legacy_pnl_archived: true,
    benchmark_frozen: 'initial shares × daily closes — no rebalancing, no trades',
    notes: [
      'El P&L del paper trading comienza desde CERO el día 0.',
      'Legacy P&L = ganancias/pérdidas acumuladas DESDE el precio de compra original hasta el día 0.',
      'Forward P&L = ganancias/pérdidas DESDE el día 0 hacia delante.',
      'Alpha = rendimiento diario del motor - rendimiento diario del benchmark congelado.',
      'Si alpha > 0 y t-stat > 1.96, el motor añade valor estadísticamente significativo.',
    ],
  },
}, null, 2));
console.log('Summary JSON: ' + summaryPath);

console.log('\n═══════════════════════════════════════════════');
console.log('PAPER TRADING INSTITUCIONAL COMPLETADO');
console.log('═══════════════════════════════════════════════');
if (alphaSignificant && alphaCagrDaily > 0) {
  console.log('✅ El motor GENERA alpha positivo y significativo sobre el benchmark congelado.');
} else if (alphaSignificant && alphaCagrDaily < 0) {
  console.log('🔴 El motor DESTRUYE valor — alpha negativo y significativo.');
} else {
  console.log('🟡 Alpha no es estadísticamente significativo — se necesita más datos.');
}
console.log('Próximo paso: npx tsx scripts/monitor_v2.ts --monthly');
console.log('DONE');
