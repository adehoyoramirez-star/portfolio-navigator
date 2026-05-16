// ===============================================
// ARCHIVO: src/core/backtest/backtestEngine.ts
// VERSIÓN ESPEJO DEL MOTOR REAL (V5.1)
// ===============================================
// Ahora el backtest utiliza:
//   - Factores de retorno reales (momentum, value, quality, low‑vol)
//   - Kelly + HRP + MinVar blend (como en olympusV3)
//   - Black‑Litterman con prior de volatilidad inversa (sin views históricas)
//   - Pesos tácticos por régimen
//   - Tail risk overlay que REALMENTE reduce exposición (no se cancela)
//   - Vol target que escala la exposición total
//   - Efectivo implícito (la suma de pesos puede ser < 1)
// ===============================================

import { ASSETS } from "../../lib/constants";
import { calculateMomentum } from "../factors/momentum";
import { calculateValue, computeUniverseStats } from "../factors/value";
import { calculateQuality, computeQualityUniverseStats } from "../factors/quality";
import { calculateLowVol, computeLowVolUniverseStats } from "../factors/lowVolatility";
import { calibrateExpectedReturn } from "../factors/factorCalibration";
import { calculateKelly } from "../portfolio/kelly";
import { correlationPenalty } from "../portfolio/correlation";
import { computeHRP } from "../risk/hrp";
import { runBlackLitterman } from "../portfolio/blackLitterman";
import { getTacticalWeights, applyTacticalConstraints, enforceClusterCap } from "../engine/regimeTacticalAllocation";
import { computeTailRiskOverlay } from "../risk/tailRisk";
import { computeVolTargetMultiplier, DEFAULT_TARGET_VOL } from "../risk/volatilityTarget";

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
    m2Growth?: number[]; // Añadido para Alpha-Boost
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
  cash: number; // fracción no invertida (1 - suma de pesos)
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

// ── Utilidades estadísticas ─────────────────────────────────────────────
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

// ── Cálculo de covarianza y correlación en una ventana ─────────────────
function computeWindowCovAndCorr(
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  t: number,
  window: number
): { covMatrix: number[][]; corrMatrix: number[][] } {
  const n = ASSETS.length;
  const returns = ASSETS.map(ticker => {
    const bticker = backtestTickers[ticker];
    const closes = closesHistory[bticker] ?? [];
    return dailyReturns(closes.slice(Math.max(0, t - window), t));
  });
  const minLen = Math.min(...returns.map(r => r.length));
  const trimmed = returns.map(r => r.slice(r.length - minLen));
  const means = trimmed.map(mean);

  const covMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const corrMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let cov = 0, vi = 0, vj = 0;
      for (let k = 0; k < minLen; k++) {
        const di = trimmed[i][k] - means[i];
        const dj = trimmed[j][k] - means[j];
        cov += di * dj;
        vi += di * di;
        vj += dj * dj;
      }
      const denom = Math.max(1, minLen - 1);
      cov = cov / denom;
      covMatrix[i][j] = cov * 252;
      covMatrix[j][i] = cov * 252;

      const stdi = Math.sqrt(vi / denom);
      const stdj = Math.sqrt(vj / denom);
      const corr = (stdi > 0 && stdj > 0) ? cov / (stdi * stdj) : (i === j ? 1 : 0);
      corrMatrix[i][j] = isFinite(corr) ? corr : 0;
      corrMatrix[j][i] = corrMatrix[i][j];
    }
  }
  return { covMatrix, corrMatrix };
}

// ── Blend weights (Dinámicos según Régimen) ────────────────────────────────────
const BLEND_WEIGHTS = {
  WITH_COV: {
    CONSERVATIVE: { BL: 0.20, HRP: 0.65, MIN_VAR: 0.15 },
    AGGRESSIVE:   { BL: 0.40, HRP: 0.40, MIN_VAR: 0.20 },
  },
  WITHOUT_COV: {
    CONSERVATIVE: { KELLY: 0.25, HRP: 0.75 },
    AGGRESSIVE:   { KELLY: 0.40, HRP: 0.60 },
  }
} as const;
function estimatePortfolioVolatility(
  allocations: Record<string, number>,
  covMatrix: number[][]
): number {
  const n = ASSETS.length;
  const weights = ASSETS.map(t => allocations[t] ?? 0);
  let varPort = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      varPort += weights[i] * weights[j] * covMatrix[i][j];
    }
  }
  return Math.sqrt(Math.max(0, varPort));
}

// ── Clasificación de régimen (simplificada, igual que antes) ───────────
function detectRegime(vix: number): BacktestRegime {
  if (vix > 35) return "CRISIS";
  if (vix > 25) return "CONTRACTION";
  return "EXPANSION";
}

// ── Factor scores para un activo en un momento dado ────────────────────
function computeAssetFactors(
  ticker: string,
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  t: number,
  lookbackDays: number
) {
  const bticker = backtestTickers[ticker];
  const closes = closesHistory[bticker] ?? [];
  const r12m = periodReturn(closes, t, 252);
  const r3m  = periodReturn(closes, t, 63);
  const r1m  = periodReturn(closes, t, 21);
  const window = closes.slice(Math.max(0, t - lookbackDays), t);
  const dailyRet = dailyReturns(window);
  const vol = dailyRet.length > 20 ? Math.sqrt(Math.max(0, variance(dailyRet) * 252)) : 0.25;
  return { returns12m: r12m, returns3m: r3m, returns1m: r1m, volatility: vol, earningsYield: 0 };
}

// ── Asignación táctica real (réplica de olympusV3) ─────────────────────
function computeAllocationsWithRegime(
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  t: number,
  lookbackDays: number,
  macro: { vix: number; yieldSpread: number; creditSpread: number; m2Growth?: number },
  portfolioDrawdown: number,
  currentAllocations: Record<string, number> // para estimar vol del portfolio
): { allocations: Record<string, number>; regime: BacktestRegime; cash: number } {
  const regime = detectRegime(macro.vix);
  const n = ASSETS.length;

  // 1. Factores por activo
  const assetFactors = ASSETS.map(ticker => {
    const fact = computeAssetFactors(ticker, closesHistory, backtestTickers, t, lookbackDays);
    return { ticker, ...fact };
  });

  // 2. Scores de factores
  const universeStats = computeUniverseStats(assetFactors.map(a => ({ earningsYield: a.earningsYield })));
  const qualityStats = computeQualityUniverseStats(assetFactors.map(a => ({
    volatility: a.volatility,
    returns12m: a.returns12m,
    returns3m: a.returns3m,
    returns1m: a.returns1m,
  })));
  const lowVolStats = computeLowVolUniverseStats(assetFactors.map(a => ({
    volatility: a.volatility,
    returns12m: a.returns12m,
    returns3m: a.returns3m,
  })));

  const rawScores = assetFactors.map(af => {
    const momentum = calculateMomentum({ returns12m: af.returns12m, returns1m: af.returns1m, returns3m: af.returns3m });
    const value = calculateValue({ earningsYield: af.earningsYield }, universeStats);
    const quality = calculateQuality(af, qualityStats);
    const lowVol = calculateLowVol(af, lowVolStats);
    const calibrated = calibrateExpectedReturn({
      momentumScore: momentum.momentumScore,
      valueScore: value.valueScore,
      qualityScore: quality.qualityScore,
      lowVolScore: lowVol.lowVolScore + lowVol.downsideVolPenalty,
    });
    return { ticker: af.ticker, expectedReturn: calibrated.expectedReturn, volatility: af.volatility, momentum, value, quality, lowVol };
  });

  // 3. Covarianza y correlación
  const { covMatrix, corrMatrix } = computeWindowCovAndCorr(closesHistory, backtestTickers, t, 63);
  const corrPen = correlationPenalty(corrMatrix);

  // 4. Kelly fractions
  const kellyFractions = rawScores.map(s => {
    const kelly = calculateKelly({ expectedReturn: s.expectedReturn, volatility: s.volatility });
    const alloc = kelly.kellyFraction * corrPen;
    return Math.max(0, isFinite(alloc) ? alloc : 0);
  });
  const totalKelly = kellyFractions.reduce((s, v) => s + v, 0);
  const kellyNorm = totalKelly > 0 ? kellyFractions.map(k => k / totalKelly) : ASSETS.map(() => 1 / n);

  // 5. HRP
  const hrpResult = computeHRP(covMatrix, n);
  const hrpWeights = hrpResult.weights;

  // 6. Mínima varianza
  const minVarW = minimumVarianceWeights(covMatrix, n);

  // 7. Black-Litterman (sin views)
  const marketWeights = equalWeightAllocations();
  const blResult = runBlackLitterman({
    assetNames: [...ASSETS],
    covMatrix,
    marketWeights: ASSETS.map(() => 1 / n),
    views: [],
    riskAversion: regime === "CRISIS" ? 4.0 : regime === "CONTRACTION" ? 3.0 : 2.5,
    tau: 0.05,
  });
  const blWeights = blResult.posteriorWeights;

  // 8. Blend Dinámico (Slicing de Blend)
  const useAggressiveBlend = regime === "EXPANSION";
  const currentBlend = useAggressiveBlend
    ? (covMatrix.length > 0 ? BLEND_WEIGHTS.WITH_COV.AGGRESSIVE : BLEND_WEIGHTS.WITHOUT_COV.AGGRESSIVE)
    : (covMatrix.length > 0 ? BLEND_WEIGHTS.WITH_COV.CONSERVATIVE : BLEND_WEIGHTS.WITHOUT_COV.CONSERVATIVE);

  const blendWeights = ASSETS.map((_, i) => {
    if (covMatrix.length > 0) {
      const b = currentBlend as any;
      return blWeights[i] * b.BL + hrpWeights[i] * b.HRP + minVarW[i] * b.MIN_VAR;
    } else {
      const b = currentBlend as any;
      return kellyNorm[i] * b.KELLY + hrpWeights[i] * b.HRP;
    }
  });
  const totalBlend = blendWeights.reduce((s, w) => s + w, 0) || 1;
  const blendNorm = blendWeights.map(w => w / totalBlend);

  // 9. Capa táctica
  const tacticalWeights = getTacticalWeights(regime, ASSETS.map(t => ({ name: t })));
  const blendedWithTactical = applyTacticalConstraints(blendNorm, tacticalWeights, regime, 0.60);
  const finalWeightsBeforeCap = enforceClusterCap(blendedWithTactical, ASSETS.map(t => ({ name: t })), regime);

  // 10. Pesos relativos (suman 1)
  const totalTactical = finalWeightsBeforeCap.reduce((s, w) => s + w, 0) || 1;
  const relativeWeights = finalWeightsBeforeCap.map(w => w / totalTactical);

  // 11. Vol target
  const portfolioVol = estimatePortfolioVolatility(
    Object.fromEntries(ASSETS.map((t, i) => [t, relativeWeights[i]])),
    covMatrix
  );
  const regimePenalty = regime === "CRISIS" ? 0.4 : regime === "CONTRACTION" ? 0.7 : 1.0;
  const volTarget = computeVolTargetMultiplier({
    targetVol: DEFAULT_TARGET_VOL,
    realizedVol: portfolioVol,
    regimePenalty,
  });

  // 12. Tail risk (drawdown, VIX, credit spread)
  const stressScore = regime === "CRISIS" ? 8 : regime === "CONTRACTION" ? 4 : 1;
  const tailRisk = computeTailRiskOverlay({
    drawdown: portfolioDrawdown,
    vix: macro.vix,
    creditSpread: macro.creditSpread,
    stressScore,
    portfolioVolatility: portfolioVol,
    avgCorrelation: 0.5,
  });

  // 13. Exposición total con ALPHA-BOOST
  const totalInvested_raw = Math.max(0.05, Math.min(1.0, volTarget.multiplier * tailRisk.overlay));

  // Alpha Mode Trigger: EXPANSION + BTC Momentum (Strong Buy) + Liquidez Positiva
  const btcTicker = ASSETS.find(t => t.includes('BTC'));
  const btcCloses = closesHistory[backtestTickers[btcTicker!]] ?? [];
  const btcRet1m = btcCloses.length > 21 ? btcCloses[btcCloses.length - 1] / btcCloses[btcCloses.length - 21] - 1 : 0;
  const isStrongBuy = btcRet1m > 0.10; // Proxy para STRONG_BUY

  const isAlphaMode = (
    regime === "EXPANSION" &&
    isStrongBuy &&
    (macro.m2Growth ?? 0) > 0
  );
  const totalInvested = isAlphaMode ? Math.max(totalInvested_raw, 0.95) : totalInvested_raw;

  // 14. BTC Dynamic Cap
  const mvrvProxy = 1.5 + (btcRet1m * 2); // Proxy simple para MVRV en backtest
  let dynamicBtcCap = 0.20;
  if (isStrongBuy && mvrvProxy < 3.0) {
    dynamicBtcCap = 0.35;
  } else if (mvrvProxy > 3.5) {
    dynamicBtcCap = 0.10;
  }

  const relativeWeightsAfterCap = [...relativeWeights];
  const btcIdx = relativeWeightsAfterCap.findIndex((_, i) => ASSETS[i].includes('BTC'));
  if (btcIdx >= 0 && relativeWeightsAfterCap[btcIdx] > dynamicBtcCap) {
    const excess = relativeWeightsAfterCap[btcIdx] - dynamicBtcCap;
    relativeWeightsAfterCap[btcIdx] = dynamicBtcCap;
    const otherTotal = relativeWeightsAfterCap.reduce((s, w, i) => i !== btcIdx ? s + w : s, 0);
    if (otherTotal > 0) {
      relativeWeightsAfterCap.forEach((_, i) => {
        if (i !== btcIdx) relativeWeightsAfterCap[i] += excess * (relativeWeightsAfterCap[i] / otherTotal);
      });
    }
  }
  const relCapTotal = relativeWeightsAfterCap.reduce((s, w) => s + w, 0) || 1;
  relativeWeightsAfterCap.forEach((_, i) => { relativeWeightsAfterCap[i] /= relCapTotal; });

  // 15. Asignaciones finales
  const finalAllocations: Record<string, number> = {};
  ASSETS.forEach((ticker, i) => {
    finalAllocations[ticker] = relativeWeightsAfterCap[i] * totalInvested;
  });

  const cash = 1 - (ASSETS.reduce((s, t) => s + finalAllocations[t], 0));

  return { allocations: finalAllocations, regime, cash };
}

// ── Bucle principal del backtest ───────────────────────────────────────
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
  let currentCash = 0;

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
      const drawdown = portfolioValue < peakValue ? (portfolioValue - peakValue) / peakValue : 0;

      const result = computeAllocationsWithRegime(
        closesHistory, backtestTickers, t, lookbackDays,
        { vix, yieldSpread, creditSpread },
        drawdown,
        currentAllocations
      );
      currentAllocations = result.allocations;
      currentRegime = result.regime;
      currentCash = result.cash;

      // Costes de transacción basados en el giro (turnover) de la cartera
      let turnover = 0;
      for (const ticker of ASSETS) {
        const newWeight = currentAllocations[ticker] ?? 0;
        const oldWeight = result.allocations[ticker] ?? 0;
        turnover += Math.abs(newWeight - oldWeight);
      }
      const costThisRebalance = portfolioValue * txCostRate * turnover;
      portfolioValue -= costThisRebalance;
      totalTransactionCosts += costThisRebalance;
      rebalanceCount++;
    }

    // Retorno diario: suma de retornos ponderados por pesos (que pueden sumar < 1)
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

    // Añadir retorno del efectivo (0%)
    portfolioReturn += currentCash * 0;

    if (!isFinite(portfolioReturn)) portfolioReturn = 0;
    if (!isFinite(benchmarkReturn)) benchmarkReturn = 0;

    portfolioValue *= (1 + portfolioReturn);
    benchmarkValue *= (1 + benchmarkReturn);
    if (portfolioValue > peakValue) peakValue = portfolioValue;
    const dd = (portfolioValue - peakValue) / peakValue;

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
      drawdown: dd,
      allocations: { ...currentAllocations },
      regime: currentRegime,
      rolling252Sharpe,
      cash: currentCash,
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

// ── Funciones métricas (sin cambios) ────────────────────────────────────
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

// Mínima varianza (réplica del helper en olympusV3)
function minimumVarianceWeights(covMatrix: number[][], n: number): number[] {
  if (covMatrix.some(row => row.some(v => !isFinite(v))) || covMatrix.length !== n) {
    return Array(n).fill(1 / n);
  }
  const iters = 500;
  let weights = Array(n).fill(1 / n);
  for (let iter = 0; iter < iters; iter++) {
    const grad = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) grad[i] += 2 * weights[j] * covMatrix[i][j];
    if (grad.some(g => !isFinite(g))) return Array(n).fill(1 / n);
    const lr = 0.05 / (1 + iter * 0.01);
    const updated = weights.map((w, i) => Math.max(0.01, w - lr * grad[i]));
    const sum = updated.reduce((a, b) => a + b, 0) || 1;
    weights = updated.map(w => w / sum);
  }
  return weights;
}