// ===============================================
// ARCHIVO: src/core/backtest/backtestEngine.ts
// VERSIÓN CORREGIDA CON TAIL RISK OVERLAY, MACRO HISTORY Y CAPA TÁCTICA
// ===============================================

import { ASSETS } from "@/lib/constants";
import { calculateMomentum } from "../factors/momentum";
import { calculateValue, computeUniverseStats } from "../factors/value";
import { calculateQuality, computeQualityUniverseStats } from "../factors/quality";
import { calculateLowVol, computeLowVolUniverseStats } from "../factors/lowVolatility";
import { calibrateExpectedReturn } from "../factors/factorCalibration";
import { calculateKelly } from "../portfolio/kelly";
import { correlationPenalty } from "../portfolio/correlation";
import { computeTailRiskOverlay } from "../risk/tailRisk";
import { getTacticalWeights, applyTacticalConstraints, enforceClusterCap } from "../engine/regimeTacticalAllocation";

export const PROXY_MAP: Record<string, string> = {
  'EMXC.DE': 'EEM',
  'IS3Q.DE': 'QUAL',
  'PPFB.DE': 'GLD',
  'URNU.DE': 'URA',
  'VVSM.DE': 'SMH',
  'XNAS.DE': 'QQQ',
  'BTC-EUR': 'BTC-EUR',
};

function getBacktestTicker(realTicker: string, closesHistory: Record<string, number[]>): string {
  const proxy = PROXY_MAP[realTicker];
  if (!proxy) return realTicker;
  const proxyLen = (closesHistory[proxy] ?? []).length;
  const realLen  = (closesHistory[realTicker] ?? []).length;
  return proxyLen > realLen ? proxy : realTicker;
}

export interface BacktestInput {
  closesHistory: Record<string, number[]>;
  covMatrix?: number[][];
  macroHistory: {
    vix: number[];
    yieldSpread: number[];
    creditSpread: number[];
  };
  lookbackDays?: number;
  rebalanceDays?: number;
  initialCapital?: number;
  transactionCostBps?: number;
}

export type BacktestRegime = "EXPANSION" | "CONTRACTION" | "CRISIS";

export interface DailyRecord {
  day: number;
  portfolioValue: number;
  drawdown: number;
  allocations: Record<string, number>;
  regime: BacktestRegime;
  rolling252Sharpe: number | null;
}

export interface BacktestMetrics {
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
  calmar: number;
  totalReturn: number;
  winRate: number;
  volatility: number;
  finalValue: number;
}

export interface RegimeMetrics {
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
  annualizedReturn: number;
  volatility: number;
  totalDays: number;
}

export interface RegimeConditionalMetrics {
  EXPANSION:   RegimeMetrics;
  CONTRACTION: RegimeMetrics;
  CRISIS:      RegimeMetrics;
}

export interface BacktestOutput {
  dailyRecords: DailyRecord[];
  metrics: BacktestMetrics;
  benchmarkMetrics: BacktestMetrics;
  regimeConditional: RegimeConditionalMetrics;
  regimeDays: Record<BacktestRegime, number>;
  daysWithProxies: number;
  daysWithRealData: number;
  transactionCostBps: number;
  totalTransactionCosts: number;
  rebalanceCount: number;
}

function ensureLength(arr: number[], targetLen: number): number[] {
  if (arr.length >= targetLen) return arr.slice(0, targetLen);
  const padded = [...arr];
  while (padded.length < targetLen) padded.push(padded[padded.length - 1] ?? 0);
  return padded;
}

function periodReturn(closes: number[], t: number, days: number): number {
  if (t < days || !closes[t - days] || closes[t - days] <= 0) return 0;
  const r = closes[t] / closes[t - days] - 1;
  return isFinite(r) ? r : 0;
}

function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      const ret = closes[i] / closes[i - 1] - 1;
      if (isFinite(ret)) r.push(ret);
    }
  }
  return r;
}

function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
}

function equalWeightAllocations(): Record<string, number> {
  const w = 1 / ASSETS.length;
  return Object.fromEntries(ASSETS.map(t => [t, w]));
}

function emptyBacktest(initialCapital: number): BacktestOutput {
  const emptyRM: RegimeMetrics = { cagr: 0, sharpe: 0, maxDrawdown: 0, annualizedReturn: 0, volatility: 0, totalDays: 0 };
  return {
    dailyRecords: [], daysWithProxies: 0, daysWithRealData: 0,
    metrics: emptyMetrics(initialCapital),
    benchmarkMetrics: emptyMetrics(initialCapital),
    regimeConditional: { EXPANSION: emptyRM, CONTRACTION: emptyRM, CRISIS: emptyRM },
    regimeDays: { EXPANSION: 0, CONTRACTION: 0, CRISIS: 0 },
    transactionCostBps: 15,
    totalTransactionCosts: 0,
    rebalanceCount: 0,
  };
}

function emptyMetrics(initialCapital: number): BacktestMetrics {
  return { cagr: 0, sharpe: 0, maxDrawdown: 0, calmar: 0, totalReturn: 0, winRate: 0, volatility: 0, finalValue: initialCapital };
}

function computeWindowCorrelation(
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  t: number,
  window: number
): number[][] {
  const n = ASSETS.length;
  const returns = ASSETS.map(ticker => {
    const bticker = backtestTickers[ticker];
    const closes = closesHistory[bticker] ?? [];
    return dailyReturns(closes.slice(Math.max(0, t - window), t));
  });
  const minLen = Math.min(...returns.map(r => r.length));
  const trimmed = returns.map(r => r.slice(r.length - minLen));
  const means = trimmed.map(mean);
  const corr: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (i === j) { corr[i][j] = 1; continue; }
      let num = 0, si = 0, sj = 0;
      for (let k = 0; k < minLen; k++) {
        const di = trimmed[i][k] - means[i];
        const dj = trimmed[j][k] - means[j];
        num += di * dj; si += di * di; sj += dj * dj;
      }
      const c = (si > 0 && sj > 0) ? num / Math.sqrt(si * sj) : 0;
      corr[i][j] = isFinite(c) ? c : 0;
      corr[j][i] = corr[i][j];
    }
  }
  return corr;
}

function estimatePortfolioVolatility(
  allocations: Record<string, number>,
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  t: number
): number {
  let weightedVar = 0;
  for (const ticker of ASSETS) {
    const w = allocations[ticker] ?? 0;
    if (w === 0) continue;
    const bticker = backtestTickers[ticker];
    const closes = closesHistory[bticker] ?? [];
    const rets = dailyReturns(closes.slice(Math.max(0, t - 63), t));
    if (rets.length < 10) continue;
    const vol = Math.sqrt(variance(rets) * 252);
    weightedVar += w * w * vol * vol;
  }
  return Math.sqrt(weightedVar);
}

function computeRegimeMetrics(dailyRets: number[]): RegimeMetrics {
  const clean = dailyRets.filter(r => isFinite(r));
  if (clean.length < 10) {
    return { cagr: 0, sharpe: 0, maxDrawdown: 0, annualizedReturn: 0, volatility: 0, totalDays: 0 };
  }
  const years = clean.length / 252;
  const totalRet = clean.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const cagr = years > 0 ? Math.pow(Math.max(0.001, 1 + totalRet), 1 / years) - 1 : 0;
  const dailyMean = mean(clean);
  const vol = Math.sqrt(variance(clean.map(r => r - dailyMean)) * 252);
  const rfDaily = 0.04 / 252;
  const excess = clean.map(r => r - rfDaily);
  const exMean = mean(excess);
  const exStd = Math.sqrt(variance(excess.map(r => r - exMean)) * 252);
  const sharpe = exStd > 0 ? (exMean * 252) / exStd : 0;
  let peak = 1, val = 1, maxDD = 0;
  for (const r of clean) {
    val *= (1 + r);
    if (val > peak) peak = val;
    const dd = (val - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return {
    cagr: isFinite(cagr) ? cagr : 0,
    sharpe: isFinite(sharpe) ? sharpe : 0,
    maxDrawdown: isFinite(maxDD) ? maxDD : 0,
    annualizedReturn: isFinite(dailyMean * 252) ? dailyMean * 252 : 0,
    volatility: isFinite(vol) ? vol : 0,
    totalDays: clean.length,
  };
}

function computeRollingSharpe(window: number[]): number {
  if (window.length < 21) return 0;
  const rfDaily = 0.04 / 252;
  const excess = window.map(r => r - rfDaily);
  const m = mean(excess);
  const s = Math.sqrt(variance(excess.map(r => r - m)));
  const sharpe = s > 0 ? (m / s) * Math.sqrt(252) : 0;
  return isFinite(sharpe) ? sharpe : 0;
}

function computeMetrics(dailyRets: number[], initialCapital: number, finalValue: number): BacktestMetrics {
  const clean = dailyRets.filter(r => isFinite(r));
  if (clean.length === 0) return emptyMetrics(initialCapital);
  const years = clean.length / 252;
  const totalReturn = isFinite(finalValue) && finalValue > 0 ? finalValue / initialCapital - 1 : 0;
  const cagr = years > 0 ? Math.pow(Math.max(0.001, 1 + totalReturn), 1 / years) - 1 : 0;
  const dailyMean = mean(clean);
  const vol = Math.sqrt(variance(clean.map(r => r - dailyMean)) * 252);
  const rfDaily = 0.04 / 252;
  const excess = clean.map(r => r - rfDaily);
  const excessMean = mean(excess);
  const excessStd = Math.sqrt(variance(excess.map(r => r - excessMean)) * 252);
  const sharpe = excessStd > 0 ? (excessMean * 252) / excessStd : 0;
  let peak = initialCapital, value = initialCapital, maxDD = 0;
  for (const r of clean) {
    value *= (1 + r);
    if (value > peak) peak = value;
    const dd = (value - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  const calmar = maxDD < 0 ? cagr / Math.abs(maxDD) : 0;
  let wins = 0, months = 0;
  for (let i = 0; i + 21 <= clean.length; i += 21) {
    if (clean.slice(i, i + 21).reduce((a, r) => a * (1 + r), 1) > 1) wins++;
    months++;
  }
  return {
    cagr: isFinite(cagr) ? cagr : 0,
    sharpe: isFinite(sharpe) ? sharpe : 0,
    maxDrawdown: isFinite(maxDD) ? maxDD : 0,
    calmar: isFinite(calmar) ? calmar : 0,
    totalReturn: isFinite(totalReturn) ? totalReturn : 0,
    winRate: months > 0 ? wins / months : 0,
    volatility: isFinite(vol) ? vol : 0,
    finalValue: isFinite(finalValue) ? finalValue : initialCapital,
  };
}

function computeAllocationsWithRegime(
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  t: number,
  lookbackDays: number,
  macro: { vix: number; yieldSpread: number; creditSpread: number }
): { allocations: Record<string, number>; regime: BacktestRegime } {
  let regime: BacktestRegime;
  if (macro.vix > 35) regime = "CRISIS";
  else if (macro.vix > 25) regime = "CONTRACTION";
  else regime = "EXPANSION";

  // En lugar de usar un multiplicador fijo, usaremos la capa táctica
  const returnCache = new Map<string, { r12m: number; r3m: number; r1m: number }>();
  const getReturns = (ticker: string) => {
    if (!returnCache.has(ticker)) {
      const closes = closesHistory[backtestTickers[ticker]] ?? [];
      returnCache.set(ticker, {
        r12m: periodReturn(closes, t, 252),
        r3m:  periodReturn(closes, t, 63),
        r1m:  periodReturn(closes, t, 21),
      });
    }
    console.log('Backtest Táctico - Pesos finales:', finalAllocations);
    return returnCache.get(ticker)!;
  };

  const assetFactors = ASSETS.map(ticker => {
    const bticker = backtestTickers[ticker];
    const closes = closesHistory[bticker] ?? [];
    const { r12m, r3m, r1m } = getReturns(ticker);
    const momentum = calculateMomentum({ returns12m: r12m, returns3m: r3m, returns1m: r1m });
    const window = closes.slice(Math.max(0, t - lookbackDays), t);
    const dailyRet = dailyReturns(window);
    const vol = dailyRet.length > 20 ? Math.sqrt(Math.max(0, variance(dailyRet) * 252)) : 0.25;
    return { ticker, momentum, vol, earningsYield: 0 };
  });

  const universeStats = computeUniverseStats(assetFactors.map(a => ({ earningsYield: a.earningsYield })));
  const qualityStats = computeQualityUniverseStats(
    assetFactors.map(a => {
      const { r12m, r3m, r1m } = getReturns(a.ticker);
      return { volatility: a.vol, returns12m: r12m, returns3m: r3m, returns1m: r1m };
    })
  );
  const lowVolStats = computeLowVolUniverseStats(
    assetFactors.map(a => {
      const { r12m, r3m } = getReturns(a.ticker);
      return { volatility: a.vol, returns12m: r12m, returns3m: r3m };
    })
  );
  const corrMatrix = computeWindowCorrelation(closesHistory, backtestTickers, t, 63);
  const corrPen = correlationPenalty(corrMatrix);

  const rawBase: Record<string, number> = {};
  let totalBase = 0;

  assetFactors.forEach(({ ticker, momentum, vol, earningsYield }) => {
    const { r12m, r3m, r1m } = getReturns(ticker);
    const value = calculateValue({ earningsYield }, universeStats);
    const quality = calculateQuality(
      { volatility: vol, returns12m: r12m, returns3m: r3m, returns1m: r1m },
      qualityStats
    );
    const lowVol = calculateLowVol(
      { volatility: vol, returns12m: r12m, returns3m: r3m },
      lowVolStats
    );
    const calibrated = calibrateExpectedReturn({
      momentumScore: momentum.momentumScore,
      valueScore:    value.valueScore,
      qualityScore:  quality.qualityScore,
      lowVolScore:   lowVol.lowVolScore + lowVol.downsideVolPenalty,
    });
    const kelly = calculateKelly({ expectedReturn: calibrated.expectedReturn, volatility: vol });
    // Pesos base = Kelly * penalización por correlación (sin penalización de régimen uniforme)
    const baseWeight = kelly.kellyFraction * corrPen;
    rawBase[ticker] = Math.max(0, isFinite(baseWeight) ? baseWeight : 0);
    totalBase += rawBase[ticker];
  });

  if (totalBase === 0) return { allocations: equalWeightAllocations(), regime };

  // Normalizar pesos base
  const baseNormalized = Object.fromEntries(ASSETS.map(t => [t, rawBase[t] / totalBase]));

  // Convertir a array en el orden de ASSETS
  const baseArray = ASSETS.map(t => baseNormalized[t]);

  // Obtener pesos tácticos para el régimen actual
  const tacticalWeights = getTacticalWeights(regime, ASSETS.map(t => ({ name: t })));

  // Mezclar optimización cuantitativa (60%) con pesos tácticos (40%)
  const blended = applyTacticalConstraints(baseArray, tacticalWeights, regime, 0.60);

  // Aplicar límite de cluster tecnológico
  const withClusterCap = enforceClusterCap(blended, ASSETS.map(t => ({ name: t })), regime);

  // Normalizar de nuevo
  const totalFinal = withClusterCap.reduce((s, w) => s + w, 0) || 1;
  const finalAllocations = Object.fromEntries(ASSETS.map((t, i) => [t, withClusterCap[i] / totalFinal]));

  return { allocations: finalAllocations, regime };
}

export function runBacktest(input: BacktestInput): BacktestOutput {
  const {
    closesHistory,
    macroHistory,
    lookbackDays = 252,
    rebalanceDays = 21,
    initialCapital = 10_000,
    transactionCostBps = 15,
  } = input;
  const txCostRate = transactionCostBps / 10_000;
  let totalTransactionCosts = 0;
  let rebalanceCount = 0;

  const backtestTickers = Object.fromEntries(
    ASSETS.map(t => [t, getBacktestTicker(t, closesHistory)])
  );

  const lengths = ASSETS.map(t => (closesHistory[backtestTickers[t]] ?? []).length);
  const maxLen = Math.max(...lengths);
  if (maxLen < lookbackDays + rebalanceDays * 2) {
    if (maxLen < 90) return emptyBacktest(initialCapital);
    return runBacktest({ ...input, lookbackDays: Math.floor(maxLen * 0.6) });
  }

  const minProxyLen = Math.min(...lengths);
  const backtestStart = lookbackDays;
  const backtestEnd = maxLen - 1;

  const dailyRecords: DailyRecord[] = [];
  let portfolioValue = initialCapital;
  let peakValue = initialCapital;
  let currentAllocations = equalWeightAllocations();
  let currentRegime: BacktestRegime = "EXPANSION";

  let benchmarkValue = initialCapital;
  const benchmarkAlloc = equalWeightAllocations();

  const strategyDailyReturns: number[] = [];
  const benchmarkDailyReturns: number[] = [];

  const regimeReturns: Record<BacktestRegime, number[]> = {
    EXPANSION: [], CONTRACTION: [], CRISIS: [],
  };
  const regimeDays: Record<BacktestRegime, number> = {
    EXPANSION: 0, CONTRACTION: 0, CRISIS: 0,
  };

  let daysWithProxies = 0;
  let daysWithRealData = 0;

  const vixArray = ensureLength(macroHistory.vix, maxLen);
  const yieldSpreadArray = ensureLength(macroHistory.yieldSpread, maxLen);
  const creditSpreadArray = ensureLength(macroHistory.creditSpread, maxLen);

  for (let t = backtestStart; t < backtestEnd; t++) {
    const dayIndex = t - backtestStart;

    if (dayIndex % rebalanceDays === 0) {
      const vix = vixArray[t];
      const yieldSpread = yieldSpreadArray[t];
      const creditSpread = creditSpreadArray[t];

      const result = computeAllocationsWithRegime(
        closesHistory, backtestTickers, t, lookbackDays,
        { vix, yieldSpread, creditSpread }
      );
      let allocations = result.allocations;
      let regime = result.regime;
      currentRegime = regime;

      const drawdown = (portfolioValue - peakValue) / peakValue;
      const portfolioVol = estimatePortfolioVolatility(allocations, closesHistory, backtestTickers, t);
      const stressScore = regime === "CRISIS" ? 8 : regime === "CONTRACTION" ? 4 : 1;
      const avgCorr = 0.5;

      const tailRisk = computeTailRiskOverlay({
        drawdown,
        vix,
        creditSpread,
        stressScore,
        portfolioVolatility: portfolioVol,
        avgCorrelation: avgCorr,
      });

      const totalWeight = Object.values(allocations).reduce((s, w) => s + w, 0);
      if (totalWeight > 0) {
        for (const ticker of ASSETS) {
          allocations[ticker] = (allocations[ticker] / totalWeight) * tailRisk.overlay;
        }
        const newTotal = Object.values(allocations).reduce((s, w) => s + w, 0);
        if (newTotal > 0) {
          for (const ticker of ASSETS) {
            allocations[ticker] /= newTotal;
          }
        }
      }

      currentAllocations = allocations;
      rebalanceCount++;

      const activeTickers = Object.values(currentAllocations).filter(w => w > 0.01).length;
      const costThisRebalance = portfolioValue * txCostRate * activeTickers;
      portfolioValue -= costThisRebalance;
      totalTransactionCosts += costThisRebalance;
    }

    let portfolioReturn = 0;
    let benchmarkReturn = 0;
    let activeWeight = 0;

    const usingProxy = t < (maxLen - minProxyLen + lookbackDays);
    if (usingProxy) daysWithProxies++; else daysWithRealData++;

    for (const ticker of ASSETS) {
      const bticker = backtestTickers[ticker];
      const closes = closesHistory[bticker] ?? [];
      const c0 = closes[t];
      const c1 = closes[t - 1];
      if (c0 != null && c1 != null && isFinite(c0) && isFinite(c1) && c1 > 0 && c0 > 0) {
        const dailyRet = c0 / c1 - 1;
        if (isFinite(dailyRet)) {
          portfolioReturn += (currentAllocations[ticker] ?? 0) * dailyRet;
          benchmarkReturn += (benchmarkAlloc[ticker] ?? 0) * dailyRet;
          activeWeight += (currentAllocations[ticker] ?? 0);
        }
      }
    }

    if (activeWeight > 0 && activeWeight < 0.99) portfolioReturn = portfolioReturn / activeWeight;
    if (!isFinite(portfolioReturn)) portfolioReturn = 0;
    if (!isFinite(benchmarkReturn)) benchmarkReturn = 0;

    portfolioValue *= (1 + portfolioReturn);
    benchmarkValue *= (1 + benchmarkReturn);
    if (portfolioValue > peakValue) peakValue = portfolioValue;
    const drawdown = (portfolioValue - peakValue) / peakValue;

    strategyDailyReturns.push(portfolioReturn);
    benchmarkDailyReturns.push(benchmarkReturn);

    regimeReturns[currentRegime].push(portfolioReturn);
    regimeDays[currentRegime]++;

    let rolling252Sharpe: number | null = null;
    if (strategyDailyReturns.length >= 252) {
      const window = strategyDailyReturns.slice(-252);
      rolling252Sharpe = computeRollingSharpe(window);
    }

    dailyRecords.push({
      day: dayIndex,
      portfolioValue,
      drawdown,
      allocations: { ...currentAllocations },
      regime: currentRegime,
      rolling252Sharpe,
    });
  }

  const regimeConditional: RegimeConditionalMetrics = {
    EXPANSION:   computeRegimeMetrics(regimeReturns.EXPANSION),
    CONTRACTION: computeRegimeMetrics(regimeReturns.CONTRACTION),
    CRISIS:      computeRegimeMetrics(regimeReturns.CRISIS),
  };

  return {
    dailyRecords,
    metrics:          computeMetrics(strategyDailyReturns, initialCapital, portfolioValue),
    benchmarkMetrics: computeMetrics(benchmarkDailyReturns, initialCapital, benchmarkValue),
    regimeConditional,
    regimeDays,
    daysWithProxies,
    daysWithRealData,
    transactionCostBps,
    totalTransactionCosts,
    rebalanceCount,
  };
}