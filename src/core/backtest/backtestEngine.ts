// ===============================================
// ARCHIVO: src/core/backtest/backtestEngine.ts
// NIVEL 4 — Backtest con métricas condicionales por régimen
// ===============================================
// CAMBIO RESPECTO A NIVEL 3:
//   ANTES: métricas globales (CAGR, Sharpe, MaxDD del período completo)
//   AHORA: métricas condicionales por régimen
//     ¿Cuánto protege el motor en periodos de crisis vs expansión?
//     Esta es la pregunta que cualquier auditor institucional hace primero.
//
// NUEVA FUNCIONALIDAD:
//   regimeConditionalMetrics: {
//     EXPANSION: { cagr, sharpe, maxDrawdown, periods }
//     CONTRACTION: { cagr, sharpe, maxDrawdown, periods }
//     CRISIS: { cagr, sharpe, maxDrawdown, periods }
//   }
//   rollingMetrics: DailyRecord ahora incluye rolling252Sharpe y regime
//
// PROXIES AMERICANOS (sin cambio):
//   EMXC.DE + IS3Q.DE → EEM  (MSCI EM, 20 años)
//   PPFB.DE           → GLD  (Oro, 20 años)
//   URNU.DE           → URA  (Uranio, 14 años)
//   VVSM.DE           → SMH  (Semis, 24 años)
//   ZPRR.DE           → VNQ  (REITs, 22 años)
//   BTC-EUR           → BTC-EUR (directo, 10 años)
// ===============================================

import { ASSETS } from "@/lib/constants";
import { calculateMomentum } from "../factors/momentum";
import { calculateValue, computeUniverseStats } from "../factors/value";
import { calculateKelly } from "../portfolio/kelly";
import { correlationPenalty } from "../portfolio/correlation";

// ==================== MAPA DE PROXIES ====================

export const PROXY_MAP: Record<string, string> = {
  'EMXC.DE': 'EEM',
  'IS3Q.DE': 'EEM',
  'PPFB.DE': 'GLD',
  'URNU.DE': 'URA',
  'VVSM.DE': 'SMH',
  'ZPRR.DE': 'VNQ',
  'BTC-EUR': 'BTC-EUR',
};

function getBacktestTicker(realTicker: string, closesHistory: Record<string, number[]>): string {
  const proxy = PROXY_MAP[realTicker];
  if (!proxy) return realTicker;
  const proxyLen = (closesHistory[proxy] ?? []).length;
  const realLen  = (closesHistory[realTicker] ?? []).length;
  return proxyLen > realLen ? proxy : realTicker;
}

// ==================== INTERFACES ====================

export interface BacktestInput {
  closesHistory: Record<string, number[]>;
  covMatrix?: number[][];
  macro: { vix: number; creditSpread: number };
  lookbackDays?: number;
  rebalanceDays?: number;
  initialCapital?: number;
  // Costes de transacción — hacen el backtest realista
  // Xetra ETFs: spread ~0.05-0.15%, comisión broker ~0.05-0.10%
  // Default 15bps (0.15%) por operación — conservador pero realista
  transactionCostBps?: number;
}

export type BacktestRegime = "EXPANSION" | "CONTRACTION" | "CRISIS";

export interface DailyRecord {
  day: number;
  portfolioValue: number;
  drawdown: number;
  allocations: Record<string, number>;
  regime: BacktestRegime;           // NUEVO: régimen detectado ese día
  rolling252Sharpe: number | null;  // NUEVO: Sharpe móvil 252 días (null si insuficientes datos)
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

// NUEVO Nivel 4: métricas por régimen
export interface RegimeMetrics {
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
  annualizedReturn: number;
  volatility: number;
  totalDays: number;  // días en este régimen
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
  // Transaction costs
  transactionCostBps: number;        // costes aplicados en bps
  totalTransactionCosts: number;     // coste total acumulado en € (sobre capital inicial)
  rebalanceCount: number;            // número de rebalanceos realizados
}

// ==================== MOTOR PRINCIPAL ====================

export function runBacktest(input: BacktestInput): BacktestOutput {
  const {
    closesHistory,
    macro,
    lookbackDays = 252,
    rebalanceDays = 21,
    initialCapital = 10_000,
    transactionCostBps = 15,  // 15bps = 0.15% por rebalanceo — realista para Xetra ETFs
  } = input;
  const txCostRate = transactionCostBps / 10_000; // convertir bps a decimal
  let totalTransactionCosts = 0;
  let rebalanceCount = 0;

  const backtestTickers = Object.fromEntries(
    ASSETS.map(t => [t, getBacktestTicker(t, closesHistory)])
  );

  const lengths = ASSETS.map(t => (closesHistory[backtestTickers[t]] ?? []).length);
  const maxLen  = Math.max(...lengths);

  if (maxLen < lookbackDays + rebalanceDays * 2) {
    if (maxLen < 90) return emptyBacktest(initialCapital);
    return runBacktest({ ...input, lookbackDays: Math.floor(maxLen * 0.6) });
  }

  const minProxyLen      = Math.min(...lengths);
  const backtestStart    = lookbackDays;
  const backtestEnd      = maxLen - 1;

  const dailyRecords: DailyRecord[] = [];
  let portfolioValue = initialCapital;
  let peakValue      = initialCapital;
  let currentAllocations = equalWeightAllocations();
  let currentRegime: BacktestRegime = "EXPANSION";

  let benchmarkValue = initialCapital;
  const benchmarkAlloc = equalWeightAllocations();

  const strategyDailyReturns: number[] = [];
  const benchmarkDailyReturns: number[] = [];

  // Por régimen
  const regimeReturns: Record<BacktestRegime, number[]> = {
    EXPANSION: [], CONTRACTION: [], CRISIS: [],
  };
  const regimeDays: Record<BacktestRegime, number> = {
    EXPANSION: 0, CONTRACTION: 0, CRISIS: 0,
  };

  let daysWithProxies  = 0;
  let daysWithRealData = 0;

  for (let t = backtestStart; t < backtestEnd; t++) {
    const dayIndex = t - backtestStart;

    // Rebalanceo — incluye detección de régimen y costes de transacción
    if (dayIndex % rebalanceDays === 0) {
      const result = computeAllocationsWithRegime(
        closesHistory, backtestTickers, macro, t, lookbackDays
      );
      currentAllocations = result.allocations;
      currentRegime = result.regime;
      rebalanceCount++;

      // Coste de transacción: se aplica sobre el valor del portfolio en el día de rebalanceo
      // Modelamos el coste como una reducción directa del valor del portfolio
      // En la práctica representa: spread bid-ask + comisión del broker por cada activo
      const activeTickers = Object.values(currentAllocations).filter(w => w > 0.01).length;
      const costThisRebalance = portfolioValue * txCostRate * activeTickers;
      portfolioValue -= costThisRebalance;
      totalTransactionCosts += costThisRebalance;
    }

    // Retorno diario
    let portfolioReturn = 0;
    let benchmarkReturn = 0;
    let activeWeight    = 0;

    const usingProxy = t < (maxLen - minProxyLen + lookbackDays);
    if (usingProxy) daysWithProxies++; else daysWithRealData++;

    for (const ticker of ASSETS) {
      const bticker = backtestTickers[ticker];
      const closes  = closesHistory[bticker] ?? [];
      const c0 = closes[t];
      const c1 = closes[t - 1];

      if (c0 != null && c1 != null && isFinite(c0) && isFinite(c1) && c1 > 0 && c0 > 0) {
        const dailyRet = c0 / c1 - 1;
        if (isFinite(dailyRet)) {
          portfolioReturn += (currentAllocations[ticker] ?? 0) * dailyRet;
          benchmarkReturn += (benchmarkAlloc[ticker] ?? 0) * dailyRet;
          activeWeight    += (currentAllocations[ticker] ?? 0);
        }
      }
    }

    if (activeWeight > 0 && activeWeight < 0.99) portfolioReturn = portfolioReturn / activeWeight;
    if (!isFinite(portfolioReturn)) portfolioReturn = 0;
    if (!isFinite(benchmarkReturn)) benchmarkReturn = 0;

    portfolioValue *= (1 + portfolioReturn);
    benchmarkValue *= (1 + benchmarkReturn);
    peakValue       = Math.max(peakValue, portfolioValue);

    const drawdown = peakValue > 0 ? (portfolioValue - peakValue) / peakValue : 0;

    strategyDailyReturns.push(portfolioReturn);
    benchmarkDailyReturns.push(benchmarkReturn);

    // Acumular por régimen
    regimeReturns[currentRegime].push(portfolioReturn);
    regimeDays[currentRegime]++;

    // Rolling Sharpe 252 días (Nivel 4)
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

  // Métricas por régimen
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

// ==================== ALLOCATIONS + RÉGIMEN ====================

function computeAllocationsWithRegime(
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  _macro: { vix: number; creditSpread: number },
  t: number,
  lookbackDays: number
): { allocations: Record<string, number>; regime: BacktestRegime } {

  // Régimen local: usa VIX del último período observable
  // (en backtest real se podría usar VIX histórico — con datos de macro que no tenemos)
  const vixProxy = estimateLocalVix(closesHistory, backtestTickers, t, 21);
  const regime: BacktestRegime = vixProxy > 35 ? "CRISIS" : vixProxy > 25 ? "CONTRACTION" : "EXPANSION";
  const regimePenalty = regime === "CRISIS" ? 0.4 : regime === "CONTRACTION" ? 0.7 : 1.0;

  const assetFactors = ASSETS.map(ticker => {
    const bticker = backtestTickers[ticker];
    const closes  = closesHistory[bticker] ?? [];

    const ret12m = periodReturn(closes, t, 252);
    const ret3m  = periodReturn(closes, t, 63);
    const ret1m  = periodReturn(closes, t, 21);

    const momentum = calculateMomentum({ returns12m: ret12m, returns3m: ret3m, returns1m: ret1m });

    const window   = closes.slice(Math.max(0, t - lookbackDays), t);
    const dailyRet = dailyReturns(window);
    const vol = dailyRet.length > 20
      ? Math.sqrt(Math.max(0, variance(dailyRet) * 252))
      : 0.25;

    return { ticker, momentum, vol, earningsYield: 0 };
  });

  const universeStats = computeUniverseStats(
    assetFactors.map(a => ({ earningsYield: a.earningsYield }))
  );

  const corrMatrix = computeWindowCorrelation(closesHistory, backtestTickers, t, 63);
  const corrPen    = correlationPenalty(corrMatrix);

  const rawExpected = assetFactors.map(({ momentum, earningsYield }) => {
    const value = calculateValue({ earningsYield }, universeStats);
    return momentum.momentumScore * 0.6 + value.valueScore * 0.4;
  });

  const retMean = mean(rawExpected);
  const retStd  = Math.sqrt(Math.max(0, variance(rawExpected.map(r => r - retMean)))) || 1;

  const raw: Record<string, number> = {};
  let totalRaw = 0;

  assetFactors.forEach(({ ticker, vol }, i) => {
    const normRet = (rawExpected[i] - retMean) / retStd;
    const kelly   = calculateKelly({ expectedReturn: normRet, volatility: vol });
    const alloc   = kelly.kellyFraction * corrPen * regimePenalty;
    raw[ticker]   = Math.max(0, isFinite(alloc) ? alloc : 0);
    totalRaw     += raw[ticker];
  });

  if (totalRaw === 0) return { allocations: equalWeightAllocations(), regime };

  const allocations = Object.fromEntries(ASSETS.map(t => [t, raw[t] / totalRaw]));
  return { allocations, regime };
}

// ==================== MÉTRICAS POR RÉGIMEN ====================

function computeRegimeMetrics(dailyRets: number[]): RegimeMetrics {
  const clean = dailyRets.filter(r => isFinite(r));
  if (clean.length < 10) {
    return { cagr: 0, sharpe: 0, maxDrawdown: 0, annualizedReturn: 0, volatility: 0, totalDays: 0 };
  }

  const years     = clean.length / 252;
  const totalRet  = clean.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const cagr       = years > 0 ? Math.pow(Math.max(0.001, 1 + totalRet), 1 / years) - 1 : 0;
  const dailyMean = mean(clean);
  const vol        = Math.sqrt(variance(clean.map(r => r - dailyMean)) * 252);
  const rfDaily    = 0.04 / 252;
  const excess     = clean.map(r => r - rfDaily);
  const exMean     = mean(excess);
  const exStd      = Math.sqrt(variance(excess.map(r => r - exMean)) * 252);
  const sharpe     = exStd > 0 ? (exMean * 252) / exStd : 0;

  let peak = 1, val = 1, maxDD = 0;
  for (const r of clean) {
    val *= (1 + r);
    if (val > peak) peak = val;
    const dd = (val - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  return {
    cagr:             isFinite(cagr) ? cagr : 0,
    sharpe:           isFinite(sharpe) ? sharpe : 0,
    maxDrawdown:      isFinite(maxDD) ? maxDD : 0,
    annualizedReturn: isFinite(dailyMean * 252) ? dailyMean * 252 : 0,
    volatility:       isFinite(vol) ? vol : 0,
    totalDays:        clean.length,
  };
}

function computeRollingSharpe(window: number[]): number {
  if (window.length < 21) return 0;
  const rfDaily = 0.04 / 252;
  const excess  = window.map(r => r - rfDaily);
  const m       = mean(excess);
  const s       = Math.sqrt(variance(excess.map(r => r - m)));
  const sharpe  = s > 0 ? (m / s) * Math.sqrt(252) : 0;
  return isFinite(sharpe) ? sharpe : 0;
}

// ==================== MÉTRICAS GLOBALES ====================

function computeMetrics(dailyRets: number[], initialCapital: number, finalValue: number): BacktestMetrics {
  const clean = dailyRets.filter(r => isFinite(r));
  if (clean.length === 0) return emptyMetrics(initialCapital);

  const years       = clean.length / 252;
  const totalReturn = isFinite(finalValue) && finalValue > 0 ? finalValue / initialCapital - 1 : 0;
  const cagr        = years > 0 ? Math.pow(Math.max(0.001, 1 + totalReturn), 1 / years) - 1 : 0;

  const dailyMean = mean(clean);
  const vol       = Math.sqrt(variance(clean.map(r => r - dailyMean)) * 252);

  const rfDaily    = 0.04 / 252;
  const excess     = clean.map(r => r - rfDaily);
  const excessMean = mean(excess);
  const excessStd  = Math.sqrt(variance(excess.map(r => r - excessMean)) * 252);
  const sharpe     = excessStd > 0 ? (excessMean * 252) / excessStd : 0;

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
    cagr:        isFinite(cagr)        ? cagr        : 0,
    sharpe:      isFinite(sharpe)      ? sharpe      : 0,
    maxDrawdown: isFinite(maxDD)       ? maxDD       : 0,
    calmar:      isFinite(calmar)      ? calmar      : 0,
    totalReturn: isFinite(totalReturn) ? totalReturn : 0,
    winRate:     months > 0 ? wins / months : 0,
    volatility:  isFinite(vol)         ? vol         : 0,
    finalValue:  isFinite(finalValue)  ? finalValue  : initialCapital,
  };
}

// ==================== HELPERS ====================

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

/**
 * Estima el VIX local usando la volatilidad realizada de la cartera en el período t.
 * Como proxy de VIX histórico (que no tenemos en el backtest).
 * Convierte vol diaria → escala VIX (×100 para indexar igual que VIX).
 */
function estimateLocalVix(
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  t: number,
  window: number
): number {
  const btcTicker = backtestTickers['BTC-EUR'] ?? 'BTC-EUR';
  const spxTicker = backtestTickers['VVSM.DE'] ?? 'SMH'; // mejor proxy de risk-on
  const closes = closesHistory[btcTicker] ?? closesHistory[spxTicker] ?? [];
  if (closes.length < window + 1) return 18; // default neutral

  const slice = closes.slice(Math.max(0, t - window), t);
  const rets  = dailyReturns(slice);
  if (rets.length < 5) return 18;

  const realizedVol = Math.sqrt(variance(rets.map(r => r - mean(rets))) * 252) * 100;
  // Mapear vol realizada (%) a escala VIX:
  // vol 15% → VIX ~15; vol 25% → VIX ~25; vol 60% → VIX ~40+ (cap en 80)
  return Math.min(80, Math.max(8, realizedVol));
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
    const closes  = closesHistory[bticker] ?? [];
    return dailyReturns(closes.slice(Math.max(0, t - window), t));
  });

  const minLen  = Math.min(...returns.map(r => r.length));
  const trimmed = returns.map(r => r.slice(r.length - minLen));
  const means   = trimmed.map(mean);

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