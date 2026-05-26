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
import { dailyReturns, mean, variance } from "../../lib/stats";
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
import { ledoitWolfCovariance } from "../data/volatility";
import { getMasterRegime, MasterRegimeInput } from "../macro/masterRegime";
import { CEWSDataPoint } from "../macro/crisisEarlyWarning";

export const PROXY_MAP: Record<string, string> = {
  'EMXC.DE': 'EEM',
  'IS3Q.DE': 'QUAL',
  'PPFB.DE': 'GLD',
  'URNU.DE': 'URA',
  'VVSM.DE': 'SMH',
  'XNAS.DE': 'QQQ',
  'BAYN.DE': 'XBI',
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
    // Campos opcionales para masterRegime completo (si faltan, backtest
    // usa el modelo simplificado solo-VIX — compatible hacia atrás)
    move?: number[];       // CBOE MOVE index (volatilidad bonos)
    dxyTrend?: number[];   // Tendencia del DXY
    btcVol?: number[];     // Volatilidad realizada BTC (anualizada)
    wtiOil?: number[];     // WTI Crude Oil $/barril
    // ERP: Equity Risk Premium (decimal, ej: 0.03 = 3%)
    // Si no se provee, el ERP trigger se deshabilita
    erpValue?: number[];
    avgCorrelation?: number[];  // Correlación media entre activos (para panic trigger)
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

// Nota: dailyReturns, mean, variance importados desde @/lib/stats.ts

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
// Usa Ledoit-Wolf shrinkage (2004) para la matriz de covarianza,
// con target de correlación constante y oracle shrinkage intensity.
// Esto reduce el error de estimación (MSE) vs la muestra cruda,
// especialmente importante cuando T ≈ 63 (ventana de rebalanceo).
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

  // ── FIX: si algún activo tiene 0 retornos válidos, rellenar con un array
  // de ceros (retorno 0%) para evitar minLen=0 en LedoitWolf.
  // Esto ocurre cuando un activo (ej: BAYN.DE) tiene menos historia que
  // el inicio de la ventana de backtest.
  const hasEmpty = returns.some(r => r.filter(isFinite).length < 2);
  if (hasEmpty) {
    const maxLen = Math.max(...returns.map(r => r.length));
    for (let i = 0; i < returns.length; i++) {
      if (returns[i].filter(isFinite).length < 2) {
        const origLen = returns[i].length;
        // Rellenar con ceros (retorno diario 0%) para que LedoitWolf tenga datos
        returns[i] = new Array(Math.max(2, maxLen)).fill(0);
        console.debug('[Backtest] padded ' + (ASSETS[i] ?? 'asset-' + i) + ' returns (was ' + origLen + ') with zeros to prevent minLen=0');
      }
    }
  }

  // Matriz de covarianza con Ledoit-Wolf shrinkage (anualizada ×252 internamente)
  const covMatrix = ledoitWolfCovariance(returns);

  // Matriz de correlación derivada de la covarianza shrunk
  const corrMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const std_i = Math.sqrt(Math.max(1e-16, covMatrix[i][i]));
      const std_j = Math.sqrt(Math.max(1e-16, covMatrix[j][j]));
      const denom = std_i * std_j;
      const corr = denom > 0 ? covMatrix[i][j] / denom : (i === j ? 1 : 0);
      corrMatrix[i][j] = isFinite(corr) ? corr : (i === j ? 1 : 0);
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

// ── Construir CEWS data point para el backtest ─────────────────────
// Se genera un punto CEWS por cada rebalanceo (aprox. cada 21 días)
// a partir de los datos macro disponibles en ese momento.
function buildCEWSPoint(
  vix: number,
  yieldSpread: number,
  creditSpread: number,
  m2Growth: number
): CEWSDataPoint {
  const today = new Date();
  return {
    timestamp: today.toISOString(),
    vix,
    yieldSpread,
    creditSpread,
    m2Growth,
  };
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
// Mejorada: usa masterRegime completo (crisis.ts + globalStress +
// regimeProbabilistic + CEWS + hysteresis) en lugar de VIX-only.
// Si los campos opcionales (move, dxyTrend, btcVol, wtiOil) no están
// disponibles, fallback a VIX-only para compatibilidad hacia atrás.
function computeAllocationsWithRegime(
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  t: number,
  lookbackDays: number,
  macro: {
    vix: number;
    yieldSpread: number;
    creditSpread: number;
    m2Growth?: number;
    move?: number;
    dxyTrend?: number;
    btcVol?: number;
    wtiOil?: number;
    erpValue?: number;
    avgCorrelation?: number;
  },
  portfolioDrawdown: number,
  currentAllocations: Record<string, number>,
  // Estado tracking para masterRegime
  cewsHistory?: CEWSDataPoint[],
  regimeHistory?: { timestamp: string; regime: string }[]
): {
  allocations: Record<string, number>;
  regime: BacktestRegime;
  cash: number;
  regimePenalty: number;
  stressScore: number;
  cewsPoint?: CEWSDataPoint;
} {
  // Usar masterRegime completo si hay datos suficientes
  // Si faltan campos opcionales clave, fallback a VIX simplificado
  const hasFullMacro = macro.move !== undefined && macro.dxyTrend !== undefined &&
    macro.btcVol !== undefined;

  // ERP value for this timestep (for the ERP trigger)
  // Passed down so computeAllocationsWithRegime can apply the cap
  const erpValue = macro.erpValue;

  let regime: BacktestRegime;
  let regimePenalty: number;
  let stressScore: number;
  let cewsPoint: CEWSDataPoint | undefined;

  if (hasFullMacro) {
    const masterInput: MasterRegimeInput = {
      vix: macro.vix,
      yieldSpread: macro.yieldSpread,
      creditSpread: macro.creditSpread,
      move: macro.move!,
      dxyTrend: macro.dxyTrend!,
      btcVol: macro.btcVol!,
      m2Growth: macro.m2Growth ?? 2,
      wtiOil: macro.wtiOil,
    };
    // Construir CEWS point desde los datos actuales
    cewsPoint = buildCEWSPoint(
      macro.vix,
      macro.yieldSpread,
      macro.creditSpread,
      macro.m2Growth ?? 2
    );
    const updatedCews = cewsHistory
      ? [...cewsHistory, cewsPoint].slice(-168)
      : [cewsPoint];
    const masterResult = getMasterRegime(masterInput, updatedCews, regimeHistory);
    regime = masterResult.regime as BacktestRegime;
    regimePenalty = masterResult.regimePenalty;
    stressScore = masterResult.stressDetail.score;
  } else {
    // Fallback: VIX-only (compatible con datos antiguos)
    if (macro.vix > 35) regime = "CRISIS";
    else if (macro.vix > 25) regime = "CONTRACTION";
    else regime = "EXPANSION";
    regimePenalty = regime === "CRISIS" ? 0.4 : regime === "CONTRACTION" ? 0.7 : 1.0;
    stressScore = regime === "CRISIS" ? 8 : regime === "CONTRACTION" ? 4 : 1;
  }
  const n = ASSETS.length;

  // 1. Factores por activo
  const assetFactors = ASSETS.map(ticker => {
    const fact = computeAssetFactors(ticker, closesHistory, backtestTickers, t, lookbackDays);
    return { ticker, ...fact };
  });

  // 2. Scores de factores
  const universeStats = computeUniverseStats(assetFactors.map(a => ({ earningsYield: a.earningsYield })));
  const qualityInputs = assetFactors.map(a => ({
    volatility: a.volatility,
    returns12m: a.returns12m,
    returns3m: a.returns3m,
    returns1m: a.returns1m,
    // FIX BUG-3: IS3Q.DE (MSCI World Quality) recibe bonus de calidad explícito
    isQualityFactor: a.ticker === 'IS3Q.DE',
  }));
  const qualityStats = computeQualityUniverseStats(qualityInputs);
  const lowVolStats = computeLowVolUniverseStats(assetFactors.map(a => ({
    volatility: a.volatility,
    returns12m: a.returns12m,
    returns3m: a.returns3m,
  })));

  const rawScores = assetFactors.map((af, idx) => {
    const momentum = calculateMomentum({ returns12m: af.returns12m, returns1m: af.returns1m, returns3m: af.returns3m });
    const value = calculateValue({ earningsYield: af.earningsYield }, universeStats);
    const quality = calculateQuality(qualityInputs[idx], qualityStats);
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
  // FIX BUG-6: BL sin views con marketWeights = 1/n degenera a ejercico matemático
  // sin significado económico. Usamos pesos uniformes directamente.
  const blWeights = ASSETS.map(() => 1 / n);

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

  // 11. Vol target con regimePenalty desde masterRegime (continuo [0.4-1.0])
  const portfolioVol = estimatePortfolioVolatility(
    Object.fromEntries(ASSETS.map((t, i) => [t, relativeWeights[i]])),
    covMatrix
  );
  const volTarget = computeVolTargetMultiplier({
    targetVol: DEFAULT_TARGET_VOL,
    realizedVol: portfolioVol,
    regimePenalty, // ya calculado desde masterRegime arriba
  });

  // 12. Tail risk (drawdown, VIX, credit spread) con stressScore desde masterRegime
  const tailRisk = computeTailRiskOverlay({
    drawdown: portfolioDrawdown,
    vix: macro.vix,
    creditSpread: macro.creditSpread,
    stressScore, // ya calculado desde masterRegime arriba
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
  const totalInvested_alpha = isAlphaMode ? Math.max(totalInvested_raw, 0.95) : totalInvested_raw;

  // 📉 ERP TRIGGER: Equity Risk Premium comprimido
  // Solo se activa si hay datos de ERP disponibles
  const ERP_TRIGGER_THRESHOLD = 0.025;   // 2.5%
  const ERP_MAX_EXPOSURE = 0.60;          // 60% cap
  const ERP_CRITICAL_THRESHOLD = 0.010;   // 1.0% — peligro extremo
  const ERP_CRITICAL_EXPOSURE = 0.35;     // 35% cap
  const isERPTriggered = macro.erpValue !== undefined && macro.erpValue < ERP_TRIGGER_THRESHOLD;
  const isERPCritical = macro.erpValue !== undefined && macro.erpValue < ERP_CRITICAL_THRESHOLD;
  const erpMaxExposure = isERPCritical ? ERP_CRITICAL_EXPOSURE : ERP_MAX_EXPOSURE;
  const totalInvested_erp = isERPTriggered
    ? Math.min(totalInvested_alpha, erpMaxExposure)
    : totalInvested_alpha;

  // 📉 CORRELATION PANIC: convergencia de correlaciones
  // Misma lógica que olympusV3.ts CAPA 8c
  const CORR_PANIC_THRESHOLD = 0.85;
  const CORR_PANIC_EXPOSURE = 0.50;
  const CORR_CRITICAL_THRESHOLD = 0.95;
  const CORR_CRITICAL_EXPOSURE = 0.35;
  const isCorrelationPanic = macro.avgCorrelation !== undefined &&
    macro.avgCorrelation > CORR_PANIC_THRESHOLD;
  const isCorrelationCritical = macro.avgCorrelation !== undefined &&
    macro.avgCorrelation > CORR_CRITICAL_THRESHOLD;
  const corrMaxExposure = isCorrelationCritical
    ? CORR_CRITICAL_EXPOSURE
    : CORR_PANIC_EXPOSURE;
  const totalInvested = isCorrelationPanic
    ? Math.min(totalInvested_erp, corrMaxExposure)
    : totalInvested_erp;

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

  return { allocations: finalAllocations, regime, cash, regimePenalty, stressScore, cewsPoint };
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

  // Tracking arrays para masterRegime y CEWS
  const regimeHistory: { timestamp: string; regime: string }[] = [];
  const cewsHistory: CEWSDataPoint[] = [];

  // Pre-computar arrays macro opcionales (pueden ser undefined)
  const moveArray = macroHistory.move?.length ? ensureLength(macroHistory.move, maxLen) : undefined;
  const dxyTrendArray = macroHistory.dxyTrend?.length ? ensureLength(macroHistory.dxyTrend, maxLen) : undefined;
  const btcVolArray = macroHistory.btcVol?.length ? ensureLength(macroHistory.btcVol, maxLen) : undefined;
  const wtiOilArray = macroHistory.wtiOil?.length ? ensureLength(macroHistory.wtiOil, maxLen) : undefined;

  for (let t = backtestStart; t < backtestEnd; t++) {
    const dayIndex = t - backtestStart;

    if (dayIndex % rebalanceDays === 0) {
      const vix = vixArray[t];
      const yieldSpread = yieldSpreadArray[t];
      const creditSpread = creditSpreadArray[t];
      const drawdown = portfolioValue < peakValue ? (portfolioValue - peakValue) / peakValue : 0;

      const erpAtT = input.macroHistory.erpValue?.[t];
      const avgCorrAtT = input.macroHistory.avgCorrelation?.[t];
    const result = computeAllocationsWithRegime(
        closesHistory, backtestTickers, t, lookbackDays,
        {
          vix, yieldSpread, creditSpread,
          move: moveArray?.[t],
          dxyTrend: dxyTrendArray?.[t],
          btcVol: btcVolArray?.[t],
          wtiOil: wtiOilArray?.[t],
          m2Growth: input.macroHistory.m2Growth?.[t],
          erpValue: erpAtT,
          avgCorrelation: avgCorrAtT,
        },
        drawdown,
        currentAllocations,
        cewsHistory,
        regimeHistory
      );
      // Actualizar tracking para masterRegime y CEWS
      if (result.regime !== currentRegime || regimeHistory.length === 0) {
        const ts = new Date().toISOString();
        regimeHistory.push({ timestamp: ts, regime: result.regime });
        // Mantener max 50 entradas
        if (regimeHistory.length > 50) regimeHistory.splice(0, regimeHistory.length - 50);
      }
      if (result.cewsPoint) {
        cewsHistory.push(result.cewsPoint);
        if (cewsHistory.length > 168) cewsHistory.splice(0, cewsHistory.length - 168);
      }

      // ⚠️ FIX BUG-1: guardar oldAllocations ANTES de sobreescribir currentAllocations
      const oldAllocations = { ...currentAllocations };
      currentAllocations = result.allocations;
      currentRegime = result.regime;
      currentCash = result.cash;

      // Costes de transacción basados en el giro (turnover) de la cartera
      let turnover = 0;
      for (const ticker of ASSETS) {
        const newWeight = currentAllocations[ticker] ?? 0;
        const oldWeight = oldAllocations[ticker] ?? 0;
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