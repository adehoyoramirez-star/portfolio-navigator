// run-backtest-tactical.ts
// Backtest walk-forward del motor tactico Olympus (COMPLETO)
// Lee CSV en formato WIDE: Date,Asset1,Asset2,...,^VIX,...
// Ejecutar: npx tsx run-backtest-tactical.ts

import fs from 'fs';
import path from 'path';

import { calcIndicators, generateSignals, calcStopLoss } from './src/core/tactical/tacticalSignals.ts';
import type { OpportunityType } from './src/core/tactical/types.ts';

const CONFIG = {
  initialCapital:       10_000,
  riskPerTradePct:      0.01,
  maxCapitalPerTrade:   0.30,
  maxOpenPositions:     4,
  minScore:             38,
  minRiskReward:        1.3,
  trailingStop:         true,
};

interface BacktestPosition {
  ticker:       string;
  entryDay:     number;
  entryPrice:   number;
  shares:       number;
  invested:     number;
  stopLoss:     number;
  takeProfit1:  number;
  takeProfit2:  number;
  exitDay:      number;
  exitPrice:    number;
  pnl:          number;
  daysHeld:     number;
  exitReason:   string;
}

interface BacktestRegimeState {
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'HIGH_VOL';
  vixLevel: number;
}

// Activos reales en el CSV (columnas de precio)
const ASSETS = ['BTC-EUR', 'EMXC.DE', 'PPFB.DE', 'URNU.DE', 'VVSM.DE', '0P00000WLG.F', 'HYG', 'LQD'];

function detectBacktestRegime(vix: number, wlgCloses: number[]): BacktestRegimeState {
  const highVol = vix > 25;
  if (highVol) return { regime: 'HIGH_VOL', vixLevel: vix };
  if (!wlgCloses || wlgCloses.length < 50) return { regime: 'BULL', vixLevel: vix };
  const last = wlgCloses[wlgCloses.length - 1];
  const sma20 = wlgCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const sma50 = wlgCloses.slice(-50).reduce((a, b) => a + b, 0) / 50;
  if (last < sma50 * 0.95 && sma20 < sma50) return { regime: 'BEAR', vixLevel: vix };
  if (last > sma50 && sma20 > sma50) return { regime: 'BULL', vixLevel: vix };
  return { regime: 'SIDEWAYS', vixLevel: vix };
}

function isSignalAllowedByRegime(signalType: OpportunityType, regime: BacktestRegimeState): boolean {
  const r = regime.regime;
  if (r === 'BEAR' && ['MOMENTUM_BREAKOUT', 'TREND_FOLLOWING', 'BREAKOUT'].includes(signalType)) return false;
  if (r === 'HIGH_VOL' && ['MOMENTUM_BREAKOUT', 'BREAKOUT', 'TREND_FOLLOWING'].includes(signalType)) return false;
  return true;
}

function regimeScoreMultiplier(regime: BacktestRegimeState): number {
  return { BULL: 1.0, BEAR: 0.7, SIDEWAYS: 0.85, HIGH_VOL: 0.6 }[regime.regime] ?? 0.8;
}

function approximateATR(closes: number[]): number {
  if (!closes || closes.length < 3) return 0;
  let sum = 0;
  for (let i = 1; i < closes.length; i++) sum += Math.abs(closes[i] - closes[i - 1]);
  return sum / (closes.length - 1);
}

function syntheticHLC(closes: number[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const atr = approximateATR(closes.slice(Math.max(0, i - 20), i + 1));
    highs.push(closes[i] + atr * 1.5);
    lows.push(closes[i] - atr * 1.5);
  }
  return { highs, lows };
}

interface TradingStats { totalTrades: number; winRate: number; avgDaysHeld: number; totalFees: number; }

function computeMetrics(equityCurve: number[], initialCapital: number) {
  const clean = equityCurve.filter(v => isFinite(v) && v > 0);
  if (clean.length < 21) return { cagr: 0, sharpe: 0, maxDrawdown: 0, calmar: 0, volatility: 0, totalReturn: 0, finalValue: initialCapital };
  const years = (clean.length - 1) / 252;
  const finalValue = clean[clean.length - 1];
  const totalReturn = (finalValue / initialCapital) - 1;
  const cagr = years > 0 ? Math.pow(Math.max(0.001, finalValue / initialCapital), 1 / years) - 1 : 0;
  const dailyRets: number[] = [];
  for (let i = 1; i < clean.length; i++) dailyRets.push(clean[i] / clean[i - 1] - 1);
  const meanRet = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
  const variance = dailyRets.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (dailyRets.length - 1);
  const vol = Math.sqrt(Math.max(0, variance * 252));
  const sharpe = vol > 0 ? (meanRet - 0.04 / 252) / vol * Math.sqrt(252) : 0;
  let maxDD = 0, peak = clean[0];
  for (const val of clean) { if (val > peak) peak = val; const dd = (peak - val) / peak; if (dd > maxDD) maxDD = dd; }
  return { cagr, sharpe, maxDrawdown: maxDD, calmar: maxDD > 0 ? cagr / maxDD : 0, volatility: vol, totalReturn, finalValue };
}

function computeTradingStats(positions: BacktestPosition[]): TradingStats {
  if (positions.length === 0) return { totalTrades: 0, winRate: 0, avgDaysHeld: 0, totalFees: 0 };
  const wins = positions.filter(p => p.pnl > 0).length;
  const avgDays = positions.reduce((s, p) => s + p.daysHeld, 0) / positions.length;
  const fees = positions.reduce((s, p) => s + p.invested * 0.001, 0);
  return { totalTrades: positions.length, winRate: wins / positions.length, avgDaysHeld: avgDays, totalFees: fees };
}

function runTacticalBacktest(lookbackDays: number, useRegimeFilter: boolean) {
  // Load CSV (wide format: Date, Asset1, Asset2, ..., ^VIX, ^TNX, ...)
  const csvPath = path.resolve(process.cwd(), 'historical_data_daily.csv');
  if (!fs.existsSync(csvPath)) throw new Error('CSV not found');
  const raw = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const headers = raw[0].split(',').map(h => h.trim());

  // Find column indices
  const dateIdx = 0;
  const assetCols: { name: string; idx: number }[] = [];
  let vixIdx = -1;
  let wlgIdx = -1;
  let hyGIdx = -1;
  let lqdIdx = -1;
  for (let i = 1; i < headers.length; i++) {
    const h = headers[i].replace('\r', '');
    if (h === '^VIX') vixIdx = i;
    else if (h === '0P00000WLG.F') wlgIdx = i;
    else if (h === 'HYG') hyGIdx = i;
    else if (h === 'LQD') lqdIdx = i;
  }
  // All tradable assets (exclude indices)
  for (let i = 1; i < headers.length; i++) {
    const h = headers[i].replace('\r', '');
    if (!h.startsWith('^')) assetCols.push({ name: h, idx: i });
  }

  // Parse rows
  const dates: string[] = [];
  const priceData: Record<string, number[]> = {};
  const vixData: number[] = [];
  for (const ac of assetCols) priceData[ac.name] = [];

  for (let r = 1; r < raw.length; r++) {
    const cols = raw[r].split(',').map(c => parseFloat(c.trim()));
    if (cols.length < 3 || isNaN(cols[0])) continue;
    dates.push(raw[r].split(',')[0].trim());
    for (const ac of assetCols) {
      priceData[ac.name].push(cols[ac.idx] ?? priceData[ac.name][priceData[ac.name].length - 1] ?? 0);
    }
    vixData.push(vixIdx >= 0 ? (cols[vixIdx] ?? 15) : 15);
  }

  if (dates.length < lookbackDays + 50) {
    console.error('Not enough data: ' + dates.length + ' days');
    return { metrics: computeMetrics([CONFIG.initialCapital, CONFIG.initialCapital], CONFIG.initialCapital), tradingStats: { totalTrades: 0, winRate: 0, avgDaysHeld: 0, totalFees: 0 }, totalSignals: 0, filteredCount: 0, positions: [] };
  }

  let cash = CONFIG.initialCapital;
  const equityCurve: number[] = [CONFIG.initialCapital];
  const closedPositions: BacktestPosition[] = [];
  const openPositions: BacktestPosition[] = [];
  let totalSignals = 0, filteredCount = 0;

  // Pre-compute synthetic HLC for all assets
  const hlcCache: Record<string, { highs: number[]; lows: number[] }> = {};
  for (const ac of assetCols) {
    hlcCache[ac.name] = syntheticHLC(priceData[ac.name]);
  }

  for (let t = lookbackDays; t < dates.length; t++) {
    const windowStart = Math.max(0, t - lookbackDays);
    const vix = vixData[t] ?? 15;

    // Detect regime using VIX and WLG trend
    const wlgCloses = priceData['0P00000WLG.F']?.slice(windowStart, t + 1) ?? [];
    const regime = detectBacktestRegime(vix, wlgCloses);
    const scoreMul = regimeScoreMultiplier(regime);

    // --- Check open positions ---
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const cp = priceData[pos.ticker]?.[t] ?? pos.entryPrice;
      const hlc = hlcCache[pos.ticker];
      const ch = hlc?.highs[t] ?? cp;
      const cl = hlc?.lows[t] ?? cp;

      if (cl <= pos.stopLoss) {
        pos.exitPrice = pos.stopLoss;
        pos.pnl = (pos.exitPrice - pos.entryPrice) * pos.shares;
        pos.daysHeld = t - pos.entryDay; pos.exitReason = 'STOP_LOSS';
        cash += pos.exitPrice * pos.shares;
        closedPositions.push(pos); openPositions.splice(pi, 1); continue;
      }
      if (ch >= pos.takeProfit2) {
        pos.exitPrice = pos.takeProfit2;
        pos.pnl = (pos.exitPrice - pos.entryPrice) * pos.shares;
        pos.daysHeld = t - pos.entryDay; pos.exitReason = 'TAKE_PROFIT_2';
        cash += pos.exitPrice * pos.shares;
        closedPositions.push(pos); openPositions.splice(pi, 1); continue;
      }
      if (ch >= pos.takeProfit1) {
        // Close half at TP1
        const halfShares = pos.shares / 2;
        cash += halfShares * pos.takeProfit1;
        pos.shares -= halfShares; pos.invested = pos.shares * pos.entryPrice;
        pos.takeProfit1 = Infinity;
      }
      // Timeout after 60 days
      if (t - pos.entryDay > 60) {
        pos.exitPrice = cp;
        pos.pnl = (cp - pos.entryPrice) * pos.shares;
        pos.daysHeld = t - pos.entryDay; pos.exitReason = 'TIMEOUT';
        cash += cp * pos.shares;
        closedPositions.push(pos); openPositions.splice(pi, 1);
      }
    }

    // --- Generate new signals ---
    interface Candidate { ticker: string; price: number; signalType: OpportunityType; score: number; stopLoss: number; tp1: number; tp2: number; rr: number; }
    const candidates: Candidate[] = [];

    for (const ac of assetCols) {
      const closes = priceData[ac.name]?.slice(windowStart, t + 1);
      if (!closes || closes.length < 50) continue;
      const hlc = hlcCache[ac.name];
      const highs = hlc.highs.slice(windowStart, t + 1);
      const lows = hlc.lows.slice(windowStart, t + 1);

      const indicators = calcIndicators(closes, closes, highs, lows); // closes como proxy de volumes
      const signals = generateSignals(indicators);

      for (const sig of signals) {
        totalSignals++;
        if (useRegimeFilter && !isSignalAllowedByRegime(sig.type, regime)) { filteredCount++; continue; }

        const price = closes[closes.length - 1];
        const score = sig.score * scoreMul;
        if (score < CONFIG.minScore) continue;

        const stopLoss = calcStopLoss(price, indicators.atr, sig.type, closes);
        const tpMul = sig.type === 'MOMENTUM_BREAKOUT' ? 1.8 : sig.type === 'OVERSOLD_BOUNCE' ? 1.3 : 1.5;
        const tp1 = price + (price - stopLoss) * tpMul;
        const tp2 = price + (price - stopLoss) * tpMul * 1.5;
        const rr = Math.abs((tp1 - price) / Math.max(0.0001, price - stopLoss));

        candidates.push({ ticker: ac.name, price, signalType: sig.type, score, stopLoss, tp1, tp2, rr });
      }
    }

    // Sort by score and trade
    candidates.sort((a, b) => b.score - a.score);
    const openTickers = new Set(openPositions.map(p => p.ticker));

    for (const cand of candidates) {
      if (openPositions.length >= CONFIG.maxOpenPositions) break;
      if (openTickers.has(cand.ticker)) continue;
      if (cand.rr < CONFIG.minRiskReward) continue;

      const posSize = Math.min(cash * CONFIG.maxCapitalPerTrade, CONFIG.riskPerTradePct * cash / Math.abs(1 - cand.stopLoss / Math.max(0.0001, cand.price)));
      if (posSize < cash * 0.01 || posSize > cash * 0.3) continue;

      const shares = posSize / cand.price;
      cash -= shares * cand.price;

      openPositions.push({
        ticker: cand.ticker, entryDay: t, entryPrice: cand.price, shares, invested: shares * cand.price,
        stopLoss: cand.stopLoss, takeProfit1: cand.tp1, takeProfit2: cand.tp2,
        exitDay: t, exitPrice: 0, pnl: 0, daysHeld: 0, exitReason: '',
      });
      openTickers.add(cand.ticker);
    }

    // Mark to market
    let pv = cash;
    for (const pos of openPositions) pv += (priceData[pos.ticker]?.[t] ?? pos.entryPrice) * pos.shares;
    equityCurve.push(pv);
  }

  // Close remaining at last price
  const lastIdx = dates.length - 1;
  for (const pos of openPositions) {
    const lp = priceData[pos.ticker]?.[lastIdx] ?? pos.entryPrice;
    pos.exitDay = lastIdx; pos.exitPrice = lp;
    pos.pnl = (lp - pos.entryPrice) * pos.shares;
    pos.daysHeld = lastIdx - pos.entryDay; pos.exitReason = 'MANUAL';
    closedPositions.push(pos);
  }

  return { metrics: computeMetrics(equityCurve, CONFIG.initialCapital), tradingStats: computeTradingStats(closedPositions), totalSignals, filteredCount, positions: closedPositions };
}

// ── Walk-Forward ──
function runWalkForward() {
  const windows = [126, 189, 252, 378, 504];
  return windows.map(w => {
    const r = runTacticalBacktest(w, true);
    return { window: w + 'd', cagr: r.metrics.cagr, sharpe: r.metrics.sharpe, maxDD: r.metrics.maxDrawdown, trades: r.tradingStats.totalTrades };
  });
}

// ── MAIN ──
function main() {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  BACKTEST MOTOR TACTICO OLYMPUS');
  console.log('══════════════════════════════════════════════');
  console.log('');

  console.log('─── CON FILTRO DE REGIMEN (252d) ───');
  const rf = runTacticalBacktest(252, true);
  console.log('CAGR:      ' + (rf.metrics.cagr * 100).toFixed(2) + '%');
  console.log('Sharpe:    ' + rf.metrics.sharpe.toFixed(2));
  console.log('MaxDD:     ' + (rf.metrics.maxDrawdown * 100).toFixed(2) + '%');
  console.log('Calmar:    ' + rf.metrics.calmar.toFixed(2));
  console.log('Vol:       ' + (rf.metrics.volatility * 100).toFixed(2) + '%');
  console.log('Total Ret: ' + (rf.metrics.totalReturn * 100).toFixed(2) + '%');
  console.log('Final:     EUR ' + rf.metrics.finalValue.toFixed(2));
  console.log('Trades:    ' + rf.tradingStats.totalTrades);
  console.log('Win Rate:  ' + (rf.tradingStats.winRate * 100).toFixed(1) + '%');
  console.log('Avg Days:  ' + rf.tradingStats.avgDaysHeld.toFixed(1));
  console.log('Filtered:  ' + rf.filteredCount + ' / ' + rf.totalSignals + ' (' + (rf.filteredCount / Math.max(1, rf.totalSignals) * 100).toFixed(1) + '%)');

  if (rf.tradingStats.totalTrades > 0) {
    console.log('');
    console.log('─── TOP POSITIONS ───');
    const sorted = [...rf.positions].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 5);
    for (const p of sorted) {
      console.log(p.ticker + ': ' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2) + ' (' + p.exitReason + ', ' + p.daysHeld + 'd)');
    }
  }

  console.log('');
  console.log('─── SIN FILTRO DE REGIMEN ───');
  const rn = runTacticalBacktest(252, false);
  console.log('CAGR:      ' + (rn.metrics.cagr * 100).toFixed(2) + '%');
  console.log('Sharpe:    ' + rn.metrics.sharpe.toFixed(2));
  console.log('MaxDD:     ' + (rn.metrics.maxDrawdown * 100).toFixed(2) + '%');
  console.log('Total Ret: ' + (rn.metrics.totalReturn * 100).toFixed(2) + '%');
  console.log('Final:     EUR ' + rn.metrics.finalValue.toFixed(2));
  console.log('Trades:    ' + rn.tradingStats.totalTrades);
  console.log('Win Rate:  ' + (rn.tradingStats.winRate * 100).toFixed(1) + '%');

  console.log('');
  console.log('─── WALK-FORWARD ───');
  const wf = runWalkForward();
  console.log('Ventana  | CAGR   | Sharpe | MaxDD  | Trades');
  for (const r of wf) console.log(r.window.padStart(8) + ' | ' + (r.cagr * 100).toFixed(2).padStart(5) + '% | ' + r.sharpe.toFixed(2).padStart(6) + ' | ' + (r.maxDD * 100).toFixed(2).padStart(5) + '% | ' + String(r.trades).padStart(6));
  const avgC = wf.reduce((s, r) => s + r.cagr, 0) / wf.length;
  const stdC = Math.sqrt(wf.reduce((s, r) => s + (r.cagr - avgC) ** 2, 0) / wf.length);
  console.log('Estabilidad CAGR: ' + (avgC * 100).toFixed(2) + '% ± ' + (stdC * 100).toFixed(2) + '%');

  console.log('');
  console.log('─── GAP ANALYSIS ───');
  const retGap = (rf.metrics.totalReturn - rn.metrics.totalReturn) * 100;
  const shpGap = rf.metrics.sharpe - rn.metrics.sharpe;
  const ddGap = (rf.metrics.maxDrawdown - rn.metrics.maxDrawdown) * 100;
  console.log('Ret diff: ' + (retGap >= 0 ? '+' : '') + retGap.toFixed(2) + '%');
  console.log('Sharpe:   ' + (shpGap >= 0 ? '+' : '') + shpGap.toFixed(3));
  console.log('MaxDD:    ' + (ddGap >= 0 ? '+' : '') + ddGap.toFixed(2) + '%');
  if (shpGap > 0 && ddGap < 0) console.log('✅ FILTRO VALIDADO');
  else if (shpGap > 0) console.log('⚠️ FILTRO MEJORA SHARPE');
  else console.log('❌ FILTRO NO VALIDADO');
}

try { main(); }
catch (e) { console.error('Backtest fallo:', e); process.exit(1); }