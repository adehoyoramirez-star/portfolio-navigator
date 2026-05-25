import sys
content = r'''// run-backtest-tactical-optimize.ts
// Grid Search: riskPerTradePct x minScore x maxOpenPositions
// Ejecutar: npx tsx run-backtest-tactical-optimize.ts

import fs from 'fs';
import path from 'path';
import { calcIndicators, generateSignals, calcStopLoss } from './src/core/tactical/tacticalSignals.ts';
import type { OpportunityType } from './src/core/tactical/types.ts';

const GRID_RISK = [0.005, 0.010, 0.015, 0.020];
const GRID_MIN_SCORE = [30, 35, 40, 45, 50];
const GRID_MAX_POSITIONS = [2, 3, 4, 5, 6];

const LOOKBACK = 252;
const INITIAL_CAPITAL = 10_000;
const MIN_RISK_REWARD = 1.3;

interface BacktestPosition {
  ticker: string;
  entryDay: number;
  entryPrice: number;
  shares: number;
  invested: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  exitDay: number;
  exitPrice: number;
  pnl: number;
  daysHeld: number;
  exitReason: string;
}

interface BacktestRegimeState {
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'HIGH_VOL';
  vixLevel: number;
}

interface BacktestResult {
  riskPerTradePct: number;
  minScore: number;
  maxOpenPositions: number;
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
  calmar: number;
  totalReturn: number;
  finalValue: number;
  trades: number;
  winRate: number;
  volatility: number;
  compositeScore: number;
}

function detectBacktestRegime(vix: number, is3qCloses: number[]): BacktestRegimeState {
  const highVol = vix > 25;
  if (highVol) return { regime: 'HIGH_VOL', vixLevel: vix };
  if (!is3qCloses || is3qCloses.length < 50) return { regime: 'BULL', vixLevel: vix };
  const last = is3qCloses[is3qCloses.length - 1];
  const sma20 = is3qCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const sma50 = is3qCloses.slice(-50).reduce((a, b) => a + b, 0) / 50;
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

interface DataCache {
  dates: string[];
  priceData: Record<string, number[]>;
  vixData: number[];
  hlcCache: Record<string, { highs: number[]; lows: number[] }>;
  assetCols: { name: string; idx: number }[];
}

function loadData(): DataCache {
  const csvPath = path.resolve(process.cwd(), 'historical_data_daily.csv');
  if (!fs.existsSync(csvPath)) throw new Error('CSV not found');
  const raw = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const headers = raw[0].split(',').map(h => h.trim());

  const assetCols: { name: string; idx: number }[] = [];
  let vixIdx = -1;
  for (let i = 1; i < headers.length; i++) {
    const h = headers[i].replace('\r', '');
    if (h === '^VIX') vixIdx = i;
  }
  for (let i = 1; i < headers.length; i++) {
    const h = headers[i].replace('\r', '');
    if (!h.startsWith('^')) assetCols.push({ name: h, idx: i });
  }

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

  const hlcCache: Record<string, { highs: number[]; lows: number[] }> = {};
  for (const ac of assetCols) {
    hlcCache[ac.name] = syntheticHLC(priceData[ac.name]);
  }

  return { dates, priceData, vixData, hlcCache, assetCols };
}

function runOptimizedBacktest(data: DataCache, config: { riskPerTradePct: number; minScore: number; maxOpenPositions: number }): BacktestResult {
  const { dates, priceData, vixData, hlcCache, assetCols } = data;
  const { riskPerTradePct, minScore, maxOpenPositions } = config;

  if (dates.length < LOOKBACK + 50) throw new Error('Not enough data');

  let cash = INITIAL_CAPITAL;
  const equityCurve: number[] = [INITIAL_CAPITAL];
  const closedPositions: BacktestPosition[] = [];
  const openPositions: BacktestPosition[] = [];
  let totalSignals = 0, filteredCount = 0;

  for (let t = LOOKBACK; t < dates.length; t++) {
    const windowStart = Math.max(0, t - LOOKBACK);
    const vix = vixData[t] ?? 15;
    const is3qCloses = priceData['IS3Q.DE']?.slice(windowStart, t + 1) ?? [];
    const regime = detectBacktestRegime(vix, is3qCloses);
    const scoreMul = regimeScoreMultiplier(regime);

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
        const halfShares = pos.shares / 2;
        cash += halfShares * pos.takeProfit1;
        pos.shares -= halfShares; pos.invested = pos.shares * pos.entryPrice;
        pos.takeProfit1 = Infinity;
    
