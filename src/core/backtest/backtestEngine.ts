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

import { ASSETS, RISK_FREE_RATE_DAILY, RISK_FREE_RATE_ANNUAL } from "../../lib/constants";
import { dailyReturns, tradingDayReturns, mean, variance } from "../../lib/stats";
import { getProxyUS, getEarningsYield } from "../../lib/assetRegistry";
import { covarianceMatrix } from "../../lib/marketData";
// FIX-R2-A3: DCC-GARCH integration for backtest-live alignment
import { getDynamicCovMatrix } from "../risk/dccGarch";
import { CEWSDataPoint } from "../macro/crisisEarlyWarning";
import { runOlympusEngine } from "../engine/olympusV3";
import type { AssetInput } from "../engine/olympusV3";
import { sortino, beta as computeBeta, alpha as computeAlpha, hhi } from "../../lib/riskMetrics";

// FIX-AUDIT-R8 3.5: PROXY_MAP now derived from assetRegistry (single source of truth).
// BAYN.DE removed — not in current portfolio.
export const PROXY_MAP: Record<string, string> = Object.fromEntries(
  ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"].map(t => [t, getProxyUS(t)])
);

function getBacktestTicker(realTicker: string, closesHistory: Record<string, number[]>): string {
  const proxy = PROXY_MAP[realTicker];
  if (!proxy) return realTicker;
  const proxyLen = (closesHistory[proxy] ?? []).length;
  const realLen  = (closesHistory[realTicker] ?? []).length;
  return proxyLen > realLen ? proxy : realTicker;
}

export interface BacktestInput {
  closesHistory: Record<string, number[]>;
  // FIX-AUDIT-R8 3.2: optional timestamps for weekend filtering in backtest.
  // When provided, tradingDayReturns filters Sat/Sun forward-filled transitions.
  timestampsHistory?: Record<string, number[]>;
  covMatrix?: number[][];
  // FIX-R2-A3 (auditoría institucional ronda 2):
  //   Si true, el backtest usa DCC-GARCH (covarianza dinámica) en lugar de
  //   Ledoit-Wolf estático. Esto alinea el backtest con el motor en producción
  //   (InstitutionalDashboard.tsx usa getDynamicCovMatrix).
  //   Si false/undefined (default), usa Ledoit-Wolf para backward compatibility.
  //   ⚠️  DCC-GARCH con calibración MLE por ventana es ~5-10× más lento.
  useDynamicCovariance?: boolean;
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
  sortino: number;
  maxDrawdown: number;
  calmar: number;
  totalReturn: number;
  winRate: number;
  volatility: number;
  finalValue: number;
  betaVsBenchmark: number;
  alphaVsBenchmark: number;
  hhi: number;
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
  return { cagr: 0, sharpe: 0, sortino: 0, maxDrawdown: 0, calmar: 0, totalReturn: 0, winRate: 0, volatility: 0, finalValue: initialCapital, betaVsBenchmark: 1, alphaVsBenchmark: 0, hhi: 0 };
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
  window: number,
  timestampsHistory?: Record<string, number[]>,
  useDynamicCovariance?: boolean
): { covMatrix: number[][]; corrMatrix: number[][] } {
  const n = ASSETS.length;
  // FIX-AUDIT-R8 3.2: use tradingDayReturns when timestamps are available.
  // Filters weekend forward-filled transitions that dilute volatility ~15-17%.
  const returns = ASSETS.map(ticker => {
    const bticker = backtestTickers[ticker];
    const closes = closesHistory[bticker] ?? [];
    const slice = closes.slice(Math.max(0, t - window), t);
    const timestamps = timestampsHistory?.[bticker];
    if (timestamps && timestamps.length >= closes.length && ticker !== 'BTC-EUR') {
      const tsSlice = timestamps.slice(Math.max(0, t - window), t);
      return tradingDayReturns(slice, tsSlice);
    }
    return dailyReturns(slice);
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

  // Matriz de covarianza
  // FIX-R2-A3 (auditoría institucional ronda 2):
  //   Si useDynamicCovariance=true, usa DCC-GARCH (mismo que el motor live en el dashboard)
  //   en lugar de Ledoit-Wolf estático. Esto alinea el backtest con producción.
  //   Si false/undefined, usa Ledoit-Wolf canónico (comportamiento actual, backward compatible).
  let covMatrix: number[][];
  if (useDynamicCovariance) {
    // Construir closesHistory para la ventana actual (t-window hasta t)
    const windowCloses: Record<string, number[]> = {};
    for (const ticker of ASSETS) {
      const bticker = backtestTickers[ticker];
      const closes = closesHistory[bticker] ?? [];
      windowCloses[ticker] = closes.slice(Math.max(0, t - window), t);
    }
    // Usar DCC-GARCH (misma función que el dashboard live)
    // getDynamicCovMatrix necesita al menos 60 días para calibrar;
    // si la ventana es menor, fallback a Ledoit-Wolf automáticamente.
    const staticCov = covarianceMatrix(returns);
    const { covMatrix: dccCov } = getDynamicCovMatrix(
      [...ASSETS], windowCloses, staticCov
    );
    covMatrix = dccCov;
  } else {
    covMatrix = covarianceMatrix(returns);
  }

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
// FIX-CEWS-TIMESTAMP (22-Jun-2026): antes usaba new Date() del presente
// para TODOS los puntos históricos, rompiendo computeWeeksInWarning
// (todos los timestamps iguales → 0 semanas consecutivas siempre).
// AHORA: usa dayIndex (relativo, empieza en 0) como offset de días hacia
// atrás desde hoy. El punto más antiguo (dayIndex=0) recibe un timestamp
// de hace ~totalDays, el más reciente recibe un timestamp de hoy.
// Se necesita backtestDuration (total de días del backtest) para anclar
// correctamente la escala temporal.
function buildCEWSPoint(
  vix: number,
  yieldSpread: number,
  creditSpread: number,
  m2Growth: number,
  dayIndex: number,        // índice relativo (0 = primer día del backtest)
  backtestDuration: number  // total de días en el backtest (backtestEnd - backtestStart)
): CEWSDataPoint {
  const now = Date.now();
  // Mapear dayIndex a un timestamp real: dayIndex=0 → hace backtestDuration días
  // dayIndex=backtestDuration → ahora. Sin timestamps futuros.
  const daysAgo = backtestDuration - dayIndex;
  const pointDate = new Date(now - daysAgo * 24 * 3600 * 1000);
  return {
    timestamp: pointDate.toISOString(),
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
  lookbackDays: number,
  timestampsHistory?: Record<string, number[]>
) {
  const bticker = backtestTickers[ticker];
  const closes = closesHistory[bticker] ?? [];
  const r12m = periodReturn(closes, t, 252);
  const r3m  = periodReturn(closes, t, 63);
  const r1m  = periodReturn(closes, t, 21);
  const window = closes.slice(Math.max(0, t - lookbackDays), t);
  // FIX-AUDIT-R8 3.2: filter weekends when timestamps available
  const timestamps = timestampsHistory?.[bticker];
  const dailyRet = (timestamps && timestamps.length >= closes.length && ticker !== 'BTC-EUR')
    ? tradingDayReturns(window, timestamps.slice(Math.max(0, t - lookbackDays), t))
    : dailyReturns(window);
  const annualFactor = ticker === 'BTC-EUR' ? 365 : 252;
  const vol = dailyRet.length > 20 ? Math.sqrt(Math.max(0, variance(dailyRet) * annualFactor)) : 0.25;
  // FIX-EY-01: earningsYield ya NO es 0 para todos los activos.
  // Usamos constantes por clase de activo para que Value factor y ERP trigger funcionen en backtest.
  // Sin esto, el backtest era ciego al factor Value y al ERP equity cap.
  // FIX-AUDIT-R8 3.5: earningsYield now from assetRegistry (single source of truth).
  const earningsYield = getEarningsYield(ticker);
  return { returns12m: r12m, returns3m: r3m, returns1m: r1m, volatility: vol, earningsYield, ticker, name: ticker };
}

// ── Asignación táctica real (usando runOlympusEngine) ──────────────────
// BUG-D FIX: Ahora delega al motor real en vez de duplicar la lógica.
// El backtest siempre refleja fielmente el comportamiento del motor.
// Para macro data faltante (move/dxyTrend/btcVol), usa proxies razonables
// para que el masterRegime siempre opere en modo completo.
function computeAllocationsWithRegime(
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  t: number,
  backtestStart: number,
  backtestDuration: number,
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
  regimeHistory?: { timestamp: string; regime: string }[],
  timestampsHistory?: Record<string, number[]>,
  useDynamicCovariance?: boolean
): {
  allocations: Record<string, number>;
  regime: BacktestRegime;
  cash: number;
  regimePenalty: number;
  stressScore: number;
  cewsPoint?: CEWSDataPoint;
} {
  // ── 1. Construir AssetInput[] desde datos históricos ──
  const n = ASSETS.length;
  const assets: AssetInput[] = ASSETS.map(ticker => {
    const fact = computeAssetFactors(ticker, closesHistory, backtestTickers, t, lookbackDays, timestampsHistory);
    return {
      name: ticker,
      ticker,
      returns12m: fact.returns12m,
      returns3m: fact.returns3m,
      returns1m: fact.returns1m,
      earningsYield: fact.earningsYield,
      volatility: fact.volatility,
    };
  });

  // ── 2. Covarianza y correlación ──
  const { covMatrix, corrMatrix } = computeWindowCovAndCorr(closesHistory, backtestTickers, t, 63, timestampsHistory, useDynamicCovariance);

  // ── 3. Portfolio vol estimada (para engine) ──
  const equalW = assets.map(() => 1 / n);
  const portfolioVol = estimatePortfolioVolatility(
    Object.fromEntries(ASSETS.map((t, i) => [t, equalW[i]])),
    covMatrix
  );

  // ── 4. CEWS point para tracking ──
  const dayIndex = t - backtestStart;
  const cewsPoint = buildCEWSPoint(
    macro.vix, macro.yieldSpread, macro.creditSpread, macro.m2Growth ?? 2,
    dayIndex, backtestDuration
  );
  const updatedCews = cewsHistory
    ? [...cewsHistory, cewsPoint].slice(-168)
    : [cewsPoint];

  // ── 5. Ejecutar motor real — runOlympusEngine ──
  // Esto reemplaza TODO el código duplicado: factor scores, Kelly, HRP, BL,
  // MinVar, blend, weights tácticos con blendToTacticalRatio dinámico,
  // cluster cap, vol target, tail risk, Alpha-Boost, ERP trigger,
  // correlation panic, BTC cap dinámico, etc.
  const engineOutput = runOlympusEngine({
    assets,
    correlationMatrix: corrMatrix,
    macro: {
      vix: macro.vix,
      yieldSpread: macro.yieldSpread,
      creditSpread: macro.creditSpread,
      move: macro.move ?? (macro.vix * 4.5 + 20),
      dxyTrend: macro.dxyTrend ?? 0,
      btcVol: macro.btcVol ?? 0.5,
      m2Growth: macro.m2Growth ?? 2,
      wtiOil: macro.wtiOil,
    },
    covMatrix: covMatrix.length > 0 ? covMatrix : undefined,
    portfolioDrawdown,
    portfolioRealizedVol: portfolioVol,
    erpValue: macro.erpValue,
    // FIX-HYSTERESIS: las llamadas del backtest ocurren en ms → saltar hysteresis
    bypassHysteresis: true,
    cewsHistory: updatedCews,
    regimeHistory,
    avgCorrelation: macro.avgCorrelation,
  });

  // ── 6. Extraer allocations del engine output ──
  const allocations: Record<string, number> = {};
  engineOutput.allocations.forEach(a => {
    allocations[a.name] = a.finalAllocation;
  });

  return {
    allocations,
    regime: engineOutput.regime as BacktestRegime,
    cash: Math.max(0, 1 - engineOutput.totalInvested),
    regimePenalty: engineOutput.masterRegime.regimePenalty,
    stressScore: engineOutput.masterRegime.stressDetail.score,
    cewsPoint,
  };
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
  // FIX-BT-1 (look-ahead bias): las nuevas allocations entran en vigor
  // el día SIGUIENTE del rebalanceo, no el mismo día.
  // ANTES: currentAllocations se actualizaba en día t y se aplicaba a
  //   retorno t (closes[t] vs closes[t-1]) → captura el cierre de hoy
  //   antes de la decisión → inflación sistemática del Sharpe.
  // AHORA: pendingNewAllocations se calcula en día t pero se aplica
  //   al retorno del día t+1 (closes[t+1] vs closes[t]).
  let pendingNewAllocations: Record<string, number> | null = null;
  let pendingNewCash = 0;
  let pendingNewRegime: BacktestRegime | null = null;

  // FIX-BENCH-EQ-REBAL: Equal Weight with periodic rebalancing (same frequency as engine).
  // Weights drift with prices between rebalancing events.
  // At each rebalanceDay, reset to 1/N and apply turnover costs (same txCostRate as engine).
  // This is a true equal-weight benchmark, not a buy-and-hold (which gets dominated by BTC).
  const eqWeight = 1 / ASSETS.length;
  let benchmarkWeights: Record<string, number> = equalWeightAllocations();
  let benchmarkValue = initialCapital;

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

    // FIX-BT-1: aplicar las allocations pendientes del rebalanceo ANTERIOR
    // al retorno de hoy (closes[t] vs closes[t-1]). Sin esto estaríamos
    // mirando el cierre de hoy antes de decidir cuánto asignar.
    if (pendingNewAllocations) {
      currentAllocations = pendingNewAllocations;
      currentRegime = pendingNewRegime ?? currentRegime;
      currentCash = pendingNewCash;
      pendingNewAllocations = null;
      pendingNewRegime = null;
    }

    if (dayIndex % rebalanceDays === 0) {
      const vix = vixArray[t];
      const yieldSpread = yieldSpreadArray[t];
      const creditSpread = creditSpreadArray[t];
      const drawdown = portfolioValue < peakValue ? (portfolioValue - peakValue) / peakValue : 0;

      const erpAtT = input.macroHistory.erpValue?.[t];
      const avgCorrAtT = input.macroHistory.avgCorrelation?.[t];
    const result = computeAllocationsWithRegime(
        closesHistory, backtestTickers, t, backtestStart, backtestEnd - backtestStart, lookbackDays,
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
        regimeHistory,
        input.timestampsHistory,
        input.useDynamicCovariance
      );
      // FIX-REGIME-TRACKING (22-Jun-2026): añadir en cada rebalanceo.
      // Usar dayIndex (relativo) para generar timestamps secuenciales sin futuro.
      const daysAgo = (backtestEnd - backtestStart) - dayIndex;
      const ts = new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString();
      regimeHistory.push({ timestamp: ts, regime: result.regime });
      // Mantener max 50 entradas
      if (regimeHistory.length > 50) regimeHistory.splice(0, regimeHistory.length - 50);
      if (result.cewsPoint) {
        cewsHistory.push(result.cewsPoint);
        if (cewsHistory.length > 168) cewsHistory.splice(0, cewsHistory.length - 168);
      }

      // FIX-BT-1: guardar allocations como PENDIENTES (siguiente día).
      // El día de rebalanceo (t) sigue usando las allocations del rebalanceo
      // anterior para calcular su retorno.
      const oldAllocations = { ...currentAllocations };
      pendingNewAllocations = result.allocations;
      pendingNewRegime = result.regime;
      pendingNewCash = result.cash;

      // Costes de transacción: se aplican en el momento del rebalanceo
      // (cuando se decide girar la cartera), no en el día siguiente.
      let turnover = 0;
      for (const ticker of ASSETS) {
        const newWeight = pendingNewAllocations[ticker] ?? 0;
        const oldWeight = oldAllocations[ticker] ?? 0;
        turnover += Math.abs(newWeight - oldWeight);
      }
      const costThisRebalance = portfolioValue * txCostRate * turnover;
      portfolioValue -= costThisRebalance;
      totalTransactionCosts += costThisRebalance;

      // ── Benchmark rebalance ──
      // Reset to equal weights. Apply the same transaction costs for fair comparison.
      let benchTurnover = 0;
      for (const ticker of ASSETS) {
        benchTurnover += Math.abs(eqWeight - (benchmarkWeights[ticker] ?? 0));
      }
      const benchCost = benchmarkValue * txCostRate * benchTurnover;
      benchmarkValue -= benchCost;
      benchmarkWeights = equalWeightAllocations();

      rebalanceCount++;
    }

    // Retorno diario: suma de retornos ponderados por pesos (que pueden sumar < 1)
    let portfolioReturn = 0;
    let benchmarkReturn = 0;
    let activeWeight = 0;

    // FIX-USINGPROXY (22-Jun-2026): documentado. Esta fórmula clasifica días
    // donde al menos un activo depende de su proxy americano (ej: URTH para WLG).
    // maxLen = máximo de días en todos los activos; minProxyLen = mínimo.
    // Los activos con menos historia usan proxy durante los primeros
    // (maxLen - minProxyLen) días del backtest (más el lookback inicial).
    const usingProxy = t < (maxLen - minProxyLen + lookbackDays);
    if (usingProxy) daysWithProxies++; else daysWithRealData++;

    // Benchmark: Equal Weight with periodic rebalancing.
    // Weights drift between rebalances; reset to 1/N at each rebalanceDay.
    for (const ticker of ASSETS) {
      const bticker = backtestTickers[ticker];
      const closes = closesHistory[bticker] ?? [];
      const c0 = closes[t];
      const c1 = closes[t - 1];
      if (c0 != null && c1 != null && isFinite(c0) && isFinite(c1) && c1 > 0 && c0 > 0) {
        const dailyRet = c0 / c1 - 1;
        if (isFinite(dailyRet)) {
          portfolioReturn += (currentAllocations[ticker] ?? 0) * dailyRet;
          activeWeight += (currentAllocations[ticker] ?? 0);
          benchmarkReturn += (benchmarkWeights[ticker] ?? 0) * dailyRet;
        }
      }
    }

    // Añadir retorno del efectivo (0%)
    portfolioReturn += currentCash * 0;

    if (!isFinite(portfolioReturn)) portfolioReturn = 0;
    if (!isFinite(benchmarkReturn)) benchmarkReturn = 0;

    portfolioValue *= (1 + portfolioReturn);
    benchmarkValue *= (1 + benchmarkReturn);

    // Benchmark weight drift (between rebalances): each weight evolves with its asset return
    let bwSum = 0;
    for (const ticker of ASSETS) {
      const bticker = backtestTickers[ticker];
      const closes = closesHistory[bticker] ?? [];
      const c0 = closes[t], c1 = closes[t - 1];
      const dailyRet = (c0 != null && c1 != null && isFinite(c0) && isFinite(c1) && c1 > 0 && c0 > 0)
        ? c0 / c1 - 1 : 0;
      benchmarkWeights[ticker] = (benchmarkWeights[ticker] ?? 0) * (1 + dailyRet);
      bwSum += benchmarkWeights[ticker] ?? 0;
    }
    if (bwSum > 0) {
      for (const ticker of ASSETS) benchmarkWeights[ticker] = (benchmarkWeights[ticker] ?? 0) / bwSum;
    } else {
      benchmarkWeights = equalWeightAllocations();
    }

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
    metrics:          computeMetrics(strategyDailyReturns, initialCapital, portfolioValue, benchmarkDailyReturns),
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
  // FIX-AUDIT-R3 R3-03: rfDaily centralizado desde src/lib/constants (R2 users may forget to update here)
  const rfDaily = RISK_FREE_RATE_DAILY;
  const excess = window.map(r => r - rfDaily);
  const m = mean(excess);
  const s = Math.sqrt(variance(excess.map(r => r - m)));
  const sharpe = s > 0 ? (m / s) * Math.sqrt(252) : 0;
  return isFinite(sharpe) ? sharpe : 0;
}

function computeMetrics(dailyRets: number[], initialCapital: number, finalValue: number, benchmarkRets?: number[]): BacktestMetrics {
  const clean = dailyRets.filter(r => isFinite(r));
  if (clean.length === 0) return emptyMetrics(initialCapital);
  const years = clean.length / 252;
  const totalReturn = isFinite(finalValue) && finalValue > 0 ? finalValue / initialCapital - 1 : 0;
  const cagr = years > 0 ? ((1 + totalReturn) > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : -1) : 0;
  const dailyMean = mean(clean);
  const vol = Math.sqrt(variance(clean.map(r => r - dailyMean)) * 252);
  const rfDaily = RISK_FREE_RATE_DAILY;
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
  // FIX-AUDIT-R10: métricas institucionales adicionales
  const sortinoValue = sortino(clean, RISK_FREE_RATE_ANNUAL, 0);
  const betaValue = benchmarkRets && benchmarkRets.length > 20 ? computeBeta(clean, benchmarkRets) : 1;
  const alphaValue = benchmarkRets && benchmarkRets.length > 20 ? computeAlpha(clean, benchmarkRets, RISK_FREE_RATE_ANNUAL) : 0;
  const hhiValue = 0; // se calcula por ventana, aquí placeholder — el valor real se actualiza en runBacktest
  return {
    cagr: isFinite(cagr) ? cagr : 0,
    sharpe: isFinite(sharpe) ? sharpe : 0,
    sortino: isFinite(sortinoValue) ? sortinoValue : 0,
    maxDrawdown: isFinite(maxDD) ? maxDD : 0,
    calmar: isFinite(calmar) ? calmar : 0,
    totalReturn: isFinite(totalReturn) ? totalReturn : 0,
    winRate: months > 0 ? wins / months : 0,
    volatility: isFinite(vol) ? vol : 0,
    finalValue: isFinite(finalValue) ? finalValue : initialCapital,
    betaVsBenchmark: isFinite(betaValue) ? betaValue : 1,
    alphaVsBenchmark: isFinite(alphaValue) ? alphaValue : 0,
    hhi: isFinite(hhiValue) ? hhiValue : 0,
  };
}

function computeRegimeMetrics(dailyRets: number[]): RegimeMetrics {
  const clean = dailyRets.filter(r => isFinite(r));
  if (clean.length < 10) {
    return { cagr: 0, sharpe: 0, maxDrawdown: 0, annualizedReturn: 0, volatility: 0, totalDays: 0 };
  }
  const years = clean.length / 252;
  const totalRet = clean.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const cagr = years > 0 ? ((1 + totalRet) > 0 ? Math.pow(1 + totalRet, 1 / years) - 1 : -1) : 0;
  const dailyMean = mean(clean);
  const vol = Math.sqrt(variance(clean.map(r => r - dailyMean)) * 252);
  // FIX-AUDIT-R3 R3-03: rfDaily centralizado desde src/lib/constants (R2 users may forget to update here)
  const rfDaily = RISK_FREE_RATE_DAILY;
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