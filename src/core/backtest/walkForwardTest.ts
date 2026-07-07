// ===============================================
// ARCHIVO: src/core/backtest/walkForwardTest.ts
// Walk-Forward Test — Validación Out-of-Sample del Motor OlympusV5
// ===============================================
//
// PROBLEMA:
//   La auditoría externa señaló que el sistema carece de validación
//   out-of-sample. El backtest cubre 2015-2026 pero todo es in-sample:
//   no sabemos si los parámetros optimizados generalizan a datos no vistos.
//
// SOLUCIÓN:
//   Implementamos walk-forward testing sobre el motor real (runBacktest).
//   Para cada ventana cronológica:
//     1. IS (In-Sample): 70% datos históricos → entrenar/calibrar
//     2. OOS (Out-of-Sample): 30% restante → validar sin re-optimizar
//     3. Comparar Sharpe, CAGR, MaxDD, Win Rate IS vs OOS
//
//   Esto responde directamente: ¿el motor funciona igual en TODOS los
//   períodos o solo en el que se optimizó?
//
// METODOLOGÍA:
//   Dividir los datos en N ventanas solapadas (default 5).
//   Cada ventana usa trainRatio% (default 70%) para IS y el resto para OOS.
//   Las ventanas avanzan step días cada una, cubriendo todo el timeline.
//
//   Para cada ventana:
//     IS slice:  data[0 : trainEnd]
//     OOS slice: data[trainEnd - lookbackDays : testEnd]
//                (con lookback de burn-in desde el final del IS)
//
//   Las métricas OOS se miden SÓLO sobre el período out-of-sample real,
//   sin contaminación de datos futuros (look-ahead bias = 0).
//
// SALIDA:
//   - Por ventana: Sharpe IS vs OOS, CAGR IS vs OOS, consistencia
//   - Global: estabilidad media, degradación media, grado de robustez
//   - Pesos adaptativos: si hay overfitting, se ajustan los factores
//   - Recomendación accionable
//
// REFERENCIAS:
//   - Pardo, R. (2008) "The Evaluation and Optimization of Trading Strategies"
//   - Aronson, D. (2006) "Evidence-Based Technical Analysis"
//   - Bailey et al. (2014) "The Probability of Backtest Overfitting"
// ===============================================

import { runBacktest, BacktestInput, BacktestOutput, BacktestMetrics, PROXY_MAP } from './backtestEngine';
import { ASSETS } from '../../lib/constants';

// ── Configuración ─────────────────────────────────────────────────────────

export interface WFTestConfig {
  /** Número de ventanas walk-forward (default: 5) */
  nWindows: number;
  /** Fracción de datos para entrenamiento (default: 0.70 = 70% IS, 30% OOS) */
  trainRatio: number;
  /** Días de lookback para métricas (momentum, covarianza) */
  lookbackDays: number;
  /** Días entre rebalanceos */
  rebalanceDays: number;
  /** Capital inicial para cada ventana */
  initialCapital: number;
  /** Costes de transacción en bps */
  transactionCostBps: number;
}

export const DEFAULT_WF_CONFIG: WFTestConfig = {
  nWindows: 5,
  trainRatio: 0.70,
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
};

// ── Interfaces de resultado ───────────────────────────────────────────────

export interface WFWindowInfo {
  windowIndex: number;
  /** Índice de inicio del train IS (en el timeline original) */
  trainStart: number;
  /** Índice de fin del train IS */
  trainEnd: number;
  /** Índice de inicio del test OOS */
  testStart: number;
  /** Índice de fin del test OOS */
  testEnd: number;
  /** Días de entrenamiento (IS) */
  trainDays: number;
  /** Días de prueba (OOS) */
  testDays: number;
}

export interface WFWindowResult {
  window: WFWindowInfo;
  /** Backtest completo sobre datos IS */
  inSample: BacktestOutput;
  /** Backtest completo sobre datos OOS (con lookback de burn-in) */
  outOfSample: BacktestOutput;
  /** Benchmark Equal Weight en la misma ventana OOS */
  equalWeightBenchmark: BacktestOutput;
  /** Consistencia [0, 1] entre IS y OOS */
  consistencyScore: number;
  /** Degradación de Sharpe (IS - OOS). Positivo = overfitting */
  sharpeDegradation: number;
  /** Degradación de CAGR (IS - OOS). Positivo = overfitting */
  cagrDegradation: number;
  /** Degradación de MaxDD (OOS - IS). Positivo = OOS peor */
  maxDdDegradation: number;
  /** Degradación de Win Rate (IS - OOS) */
  winRateDegradation: number;
  /** ¿Esta ventana OOS cayó en un bull market de BTC >100%? (suerte, no skill) */
  bullMarketWindow: boolean;
  /** Si bullMarketWindow es true, cuánto subió BTC en esta ventana */
  btcReturnWindow: number;
}

export interface WFTestResult {
  /** Configuración usada */
  config: WFTestConfig;
  /** Total de días de datos disponibles */
  totalDataDays: number;
  /** Resultados por ventana */
  windows: WFWindowResult[];
  /** Consistencia media [0, 1] */
  overallConsistency: number;
  /** Degradación media de Sharpe */
  avgSharpeDegradation: number;
  /** Degradación media de CAGR */
  avgCagrDegradation: number;
  /** Degradación media de MaxDD */
  avgMaxDdDegradation: number;
  /** Sharpe promedio IS (todas las ventanas) */
  sharpeIsAvg: number;
  /** Sharpe promedio OOS (todas las ventanas) */
  sharpeOosAvg: number;
  /** CAGR promedio IS */
  cagrIsAvg: number;
  /** CAGR promedio OOS */
  cagrOosAvg: number;
  /** Grado de robustez: A (muy robusto) a F (posible overfitting severo) */
  robustnessGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Riesgo de overfitting */
  overfittingRisk: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  /** Porcentaje de ventanas con Sharpe OOS positivo */
  pctWindowsPositiveSharpe: number;
  /** Porcentaje de ventanas con CAGR OOS positivo */
  pctWindowsPositiveCagr: number;
  /** Recomendación accionable */
  recommendation: string;
  /** Pesos adaptativos basados en el resultado */
  adaptiveFactorWeights: {
    momentum: number;
    value: number;
    quality: number;
    lowVol: number;
  };
  // FIX-AUDIT-R11: Deflated Sharpe Ratio (López de Prado 2014)
  /** Deflated Sharpe Ratio — corrige por múltiples comparaciones */
  deflatedSharpeRatio: number;
  /** Probabilistic Sharpe Ratio — P(SR > 0 | datos) */
  probabilisticSharpeRatio: number;
  /** Benchmark Equal Weight Sharpe promedio OOS */
  equalWeightSharpeOosAvg: number;
  /** ¿El motor bate al Equal Weight en OOS? */
  beatsEqualWeight: boolean;
  /** Porcentaje de ventanas OOS en bull market BTC (>100%) */
  pctBullMarketWindows: number;
}

// ── Construcción de ventanas walk-forward ────────────────────────────────

function buildWindows(
  totalLength: number,
  config: WFTestConfig
): WFWindowInfo[] {
  const { nWindows, trainRatio, lookbackDays } = config;
  const usableLength = totalLength - lookbackDays;
  if (usableLength < nWindows * 100) return [];

  // Cada ventana tiene un tamaño fijo y avanza step días
  const windowStep = Math.floor(usableLength / (nWindows + 1));
  const trainSize = Math.floor(windowStep * trainRatio);
  const testSize = windowStep - trainSize;
  if (testSize < 21) return [];

  const windows: WFWindowInfo[] = [];
  const lastWindowIdx = nWindows - 1;
  for (let w = 0; w < nWindows; w++) {
    const trainEnd = lookbackDays + (w + 1) * windowStep;
    const trainStart = Math.max(0, trainEnd - trainSize);
    const testStart = trainEnd;
    // La última ventana se extiende hasta el final de los datos disponibles
    const testEnd = w === lastWindowIdx
      ? totalLength - 1
      : Math.min(testStart + testSize, totalLength - 1);

    if (testEnd - testStart < 10) break;

    windows.push({
      windowIndex: w,
      trainStart, trainEnd,
      testStart, testEnd,
      trainDays: trainEnd - trainStart,
      testDays: testEnd - testStart,
    });
  }
  return windows;
}

// ── Slicing de datos históricos ──────────────────────────────────────────

function sliceClosesHistory(
  history: Record<string, number[]>,
  start: number,
  end: number
): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const ticker of Object.keys(history)) {
    result[ticker] = history[ticker].slice(start, end);
  }
  return result;
}

// ── Cálculo de consistencia IS vs OOS ──────────────────────────────────

function computeConsistency(is: BacktestMetrics, oos: BacktestMetrics): number {
  // Sharpe consistency (40%): qué tan cerca está OOS de IS
  // Penalización low-edge: si |IS Sharpe| < 0.2, el sistema no tiene edge real
  // y la consistencia aparente (ambos cerca de 0) es engañosa.
  const lowEdgePenalty = Math.abs(is.sharpe) < 0.2
    ? Math.abs(is.sharpe) / 0.2
    : 1.0;
  // Sharpe con penalización low-edge y consistencia integrada
  const sharpeConsistency = (Math.abs(is.sharpe) + 1) > 0
    ? Math.max(0, 1 - Math.abs(is.sharpe - oos.sharpe) / (Math.abs(is.sharpe) + 0.5))
    : 0.5;
  // penalizedSharpe = consistencia × penalización por bajo edge
  const penalizedSharpe = sharpeConsistency * lowEdgePenalty;

  // CAGR consistency (30%): qué proporción del CAGR IS se mantiene en OOS
  const absCagr = Math.abs(is.cagr) + 0.01;
  const cagrConsistency = Math.max(0, Math.min(1,
    (oos.cagr + absCagr) / (2 * absCagr)
  ));

  // MaxDD degradation (20%): OOS drawdown no debe ser mucho peor
  // maxDrawdown es ≤ 0, así que si OOS es más negativo: is - oos > 0
  const maxDdConsistency = Math.max(0, Math.min(1,
    1 - Math.max(0, is.maxDrawdown - oos.maxDrawdown) / 0.40
  ));

  // Win rate consistency (10%)
  const wrConsistency = Math.max(0, 1 - Math.abs(is.winRate - oos.winRate) * 1.5);

  return Math.max(0, Math.min(1,
    penalizedSharpe * 0.40 +
    cagrConsistency * 0.30 +
    maxDdConsistency * 0.20 +
    wrConsistency * 0.10
  ));
}

// ── Grading ─────────────────────────────────────────────────────────────

function gradeResults(
  overallConsistency: number,
  avgSharpeDegradation: number,
  windows: WFWindowResult[]
): { robustnessGrade: WFTestResult['robustnessGrade']; overfittingRisk: WFTestResult['overfittingRisk'] } {
  let robustnessGrade: WFTestResult['robustnessGrade'];
  if (overallConsistency >= 0.80 && avgSharpeDegradation < 0.5) robustnessGrade = 'A';
  else if (overallConsistency >= 0.65 && avgSharpeDegradation < 0.8) robustnessGrade = 'B';
  else if (overallConsistency >= 0.50) robustnessGrade = 'C';
  else if (overallConsistency >= 0.35) robustnessGrade = 'D';
  else robustnessGrade = 'F';

  const negativeCagrWindows = windows.filter(w => w.outOfSample.metrics.cagr <= 0).length;
  const severeDegradationWindows = windows.filter(w => w.sharpeDegradation > 1.0).length;
  const ratioBad = negativeCagrWindows / Math.max(1, windows.length);

  let overfittingRisk: WFTestResult['overfittingRisk'];
  if (overallConsistency >= 0.80 && avgSharpeDegradation < 0.3 && ratioBad < 0.2) {
    overfittingRisk = 'LOW';
  } else if (overallConsistency >= 0.60 && avgSharpeDegradation < 0.6 && ratioBad < 0.4) {
    overfittingRisk = 'MODERATE';
  } else if (overallConsistency >= 0.40 || avgSharpeDegradation < 1.5) {
    overfittingRisk = 'HIGH';
  } else {
    overfittingRisk = 'CRITICAL';
  }

  return { robustnessGrade, overfittingRisk };
}

// ── Pesos adaptativos ───────────────────────────────────────────────────

function computeAdaptiveWeights(
  risk: WFTestResult['overfittingRisk']
): WFTestResult['adaptiveFactorWeights'] {
  switch (risk) {
    case 'CRITICAL':
      return { momentum: 0.25, value: 0.30, quality: 0.20, lowVol: 0.25 };
    case 'HIGH':
      return { momentum: 0.30, value: 0.28, quality: 0.21, lowVol: 0.21 };
    case 'MODERATE':
      return { momentum: 0.35, value: 0.26, quality: 0.20, lowVol: 0.19 };
    case 'LOW':
      return { momentum: 0.40, value: 0.25, quality: 0.20, lowVol: 0.15 };
  }
}

// ── Deflated Sharpe Ratio (López de Prado 2014) ──────────────────────────
// Corrige el Sharpe por el número de pruebas/ventanas.
// Cuantas más ventanas evaluamos, más probable es encontrar una
// con Sharpe alto por puro azar (sesgo de selección múltiple).
//
// DSR = (SR - E[max(SR)]) / σ[max(SR)]
//
// Donde E[max(SR)] y σ[max(SR)] son la media y desviación estándar
// del máximo Sharpe esperado bajo la hipótesis nula (SR=0),
// para N ventanas y T observaciones cada una.
//
// FIX-R2-A2 (auditoría institucional ronda 2):
//   ANTES: sharpeOosAvg llegaba anualizado (×√252) pero expectedMaxSR usaba
//     √(2 ln N) en escala no-anualizada → restar peras y manzanas → DSR siempre
//     negativo (~-4.8 con Sharpe 1.5, N=5, T=226).
//   AHORA: de-anualizamos sharpeOosAvg antes de la fórmula, y re-anualizamos
//     expectedMaxSR multiplicando por √252. Así DSR > 0 cuando el Sharpe OOS
//     supera lo esperado por azar. La σ[max(SR)] = √(Var[max]) = √(1/T) también
//     se anualiza para mantener consistencia de unidades.
//
// REFERENCIA: Bailey, D. H., & López de Prado, M. (2014).
//   "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest
//   Overfitting, and Non-Normality." Journal of Portfolio Management.
//
// DSR > 0: el Sharpe es mejor que lo esperado por azar
// DSR > 1: estadísticamente significativo al 68%
// DSR > 2: estadísticamente significativo al 95%

/**
 * Calcula el Deflated Sharpe Ratio (López de Prado 2014).
 *
 * @param sharpeOosAvg - Sharpe OOS promedio ANUALIZADO (×√252)
 * @param nWindows - Número de ventanas walk-forward
 * @param avgObsPerWindow - Observaciones promedio por ventana OOS (días)
 * @returns DSR value
 */
function deflatedSharpeRatio(
  sharpeOosAvg: number,
  nWindows: number,
  avgObsPerWindow: number
): number {
  if (nWindows <= 1 || avgObsPerWindow < 20) return sharpeOosAvg;

  // De-anualizar: el Sharpe diario es Sharpe_anual / √252
  const sharpeDaily = sharpeOosAvg / Math.sqrt(252);

  // FIX-DSR (09-Jul-2026): Expected max |SR| under null for N trials × T obs.
  //
  // ANTES: expectedMaxSRDaily = √(2 ln N) → daba ~1.79 para N=5, un Sharpe
  //   diario irreal (equivalente a Sharpe anual de ~28). Con el Sharpe real
  //   de ~0.07 diario, DSR = (0.07−1.79)/0.066 = −25.9. Inútil.
  //
  // AHORA: Cada ventana OOS tiene ~T observaciones. Bajo la hipótesis nula
  //   (SR=0), cada SR diario estimado se distribuye N(0, 1/T). El máximo
  //   esperado de N normales i.i.d. con varianza 1/T es:
  //
  //     E[max(SR_daily)] = √(1/T) × √(2 ln N) = √(2 ln N / T)
  //
  //   Bailey-López de Prado (2014) Eq. 6-7.
  //   Con N=5, T=226: √(2 ln 5 / 226) = √(3.218/226) ≈ 0.119 diario.
  //
  // Var[max(SR)] ≈ 1/T  (Eq. 8)
  const expectedMaxSRDaily = Math.sqrt(2 * Math.log(nWindows) / avgObsPerWindow);
  const stdMaxSR = Math.sqrt(1 / avgObsPerWindow);

  // DSR = (observed_daily - expected_max_daily) / std(max_daily)
  return (sharpeDaily - expectedMaxSRDaily) / (stdMaxSR + 1e-10);
}

/**
 * Calcula el Probabilistic Sharpe Ratio (PSR).
 * PSR = probabilidad de que el Sharpe real sea > 0 dado el Sharpe observado.
 *
 * FIX-R2-A2 (auditoría institucional ronda 2):
 *   ANTES: usaba sharpeOosAvg anualizado con √T diario → z inflado.
 *     Ej: Sharpe=1.5, T=226 → z = 1.5×√226 = 22.5 → PSR ≈ 1.0 siempre.
 *   AHORA: de-anualiza a frecuencia diaria antes de calcular z.
 *     z = (sharpeDaily - SR_benchmark) / √(1/T).
 *     Con SR_benchmark=0 (hipótesis nula): z = sharpeDaily × √T.
 *   También reemplaza la aproximación logística por la CDF normal canónica
 *   usando la función error (erf), que es más precisa en las colas.
 *
 * REFERENCIA: Bailey & López de Prado (2014), Eq. 9-11.
 *
 * @param sharpeOosAvg - Sharpe OOS promedio ANUALIZADO
 * @param avgObsPerWindow - Observaciones promedio por ventana OOS (días)
 * @returns PSR [0, 1]
 */
function probabilisticSharpeRatio(
  sharpeOosAvg: number,
  avgObsPerWindow: number
): number {
  if (avgObsPerWindow < 20) return 0.5;

  // De-anualizar: Sharpe_daily = Sharpe_anual / √252
  const sharpeDaily = sharpeOosAvg / Math.sqrt(252);

  // z = (SR_obs - SR_benchmark) / √(1/T)
  // Under null SR_benchmark = 0, so z = SR_obs × √T
  const z = sharpeDaily * Math.sqrt(avgObsPerWindow);

  // CDF of standard normal using error function (exact, not logistic approximation)
  // Φ(z) = 0.5 × (1 + erf(z / √2))
  const cdf = 0.5 * (1 + erf(z / Math.SQRT2));
  return Math.max(0, Math.min(1, cdf));
}

/**
 * Error function approximation (Abramowitz & Stegun 7.1.26).
 * Maximum error: 1.5×10⁻⁷ — suitable for PSR calculation.
 */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

// ── Equal Weight Backtest (quick benchmark por ventana) ─────────────────
// FIX-EW-COSTS (09-Jul-2026): añadidos costes de transacción realistas al EW.
// ANTES: EW era un benchmark gratuito (0 bps) mientras el motor pagaba 15bps
//   por rebalanceo → comparación injusta que favorecía al EW.
// AHORA: EW rebalancea mensualmente (cada 21 días) con 15bps de coste.
//   Esto refleja el coste real de mantener una cartera equal-weight.
function equalWeightBenchmark(
  closesHistory: Record<string, number[]>,
  backtestTickers: Record<string, string>,
  start: number,
  end: number,
  initialCapital: number = 10000,
  rebalanceDays: number = 21,
  transactionCostBps: number = 15,
): { cagr: number; sharpe: number; maxDrawdown: number; finalValue: number; dailyRets: number[] } {
  const tickers = Object.keys(backtestTickers);
  const n = tickers.length;
  const w = 1 / n;
  const dailyRets: number[] = [];
  let value = initialCapital;
  let peak = initialCapital;
  let maxDD = 0;
  const txCostRate = transactionCostBps / 10_000;
  // FIX-AUDIT-T5: coste basado en turnover EXACTO como backtestEngine.ts.
  // ANTES: value * txCostRate * 0.05 (5% fijo) → inconsistente.
  // AHORA: calcula ∑|eqWeight - driftedWeight| (misma fórmula que backtestEngine).
  let currentBenchWeights: Record<string, number> = Object.fromEntries(tickers.map(t => [t, w]));
  let dayIndex = rebalanceDays;

  for (let t = start + 1; t <= end; t++) {
    let dayRet = 0;
    for (const ticker of tickers) {
      const bt = backtestTickers[ticker];
      const closes = closesHistory[bt] ?? [];
      if (t < closes.length) {
        const c0 = closes[t - 1];
        const c1 = closes[t];
        if (c0 > 0 && c1 > 0 && isFinite(c0) && isFinite(c1)) {
          dayRet += w * (c1 / c0 - 1);
        }
      }
    }
    if (isFinite(dayRet)) {
      // FIX-AUDIT-T5: coste basado en turnover EXACTO como backtestEngine.ts.
      // ANTES: value * txCostRate * 0.05 (5% fijo) → inconsistente.
      // AHORA: ∑|eqWeight - driftedWeight| cada rebalanceo.
      if (dayIndex > 0 && dayIndex % rebalanceDays === 0) {
        let benchTurnover = 0;
        for (const ticker of tickers) {
          benchTurnover += Math.abs(w - (currentBenchWeights[ticker] ?? 0));
        }
        value -= value * txCostRate * benchTurnover;
        currentBenchWeights = Object.fromEntries(tickers.map(t => [t, w]));
      }
      // Drift weights with daily returns
      let bwSum = 0;
      for (const ticker of tickers) {
        const bt = backtestTickers[ticker];
        const closes = closesHistory[bt] ?? [];
        if (t < closes.length) {
          const c0 = closes[t - 1];
          const c1 = closes[t];
          if (c0 > 0 && c1 > 0 && isFinite(c0) && isFinite(c1)) {
            currentBenchWeights[ticker] = (currentBenchWeights[ticker] ?? 0) * (c1 / c0);
            bwSum += currentBenchWeights[ticker] ?? 0;
          }
        }
      }
      if (bwSum > 0) {
        for (const ticker of tickers) currentBenchWeights[ticker] = (currentBenchWeights[ticker] ?? 0) / bwSum;
      } else {
        currentBenchWeights = Object.fromEntries(tickers.map(t => [t, w]));
      }
      dailyRets.push(dayRet);
      value *= (1 + dayRet);
      if (value > peak) peak = value;
      const dd = (value - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }
    dayIndex++;
  }

  const years = dailyRets.length / 252;
  const totalReturn = value / initialCapital - 1;
  const cagr = years > 0 && (1 + totalReturn) > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;
  const m = dailyRets.reduce((s, r) => s + r, 0) / dailyRets.length;
  const v = dailyRets.reduce((s, r) => s + (r - m) ** 2, 0) / (dailyRets.length - 1);
  const sharpe = v > 0 ? (m / Math.sqrt(v)) * Math.sqrt(252) : 0;

  return { cagr, sharpe, maxDrawdown: maxDD, finalValue: value, dailyRets };
}

// ── Bull Market Detection ───────────────────────────────────────────────
function isBullMarketWindow(
  closesHistory: Record<string, number[]>,
  start: number,
  end: number
): { isBull: boolean; btcReturn: number } {
  const btcCloses = closesHistory["BTC-EUR"] ?? closesHistory["BTC-USD"] ?? [];
  if (btcCloses.length <= end || btcCloses[start] <= 0) return { isBull: false, btcReturn: 0 };

  const btcStart = btcCloses[start];
  const btcEnd = btcCloses[end];
  const btcReturn = btcStart > 0 ? btcEnd / btcStart - 1 : 0;

  return { isBull: btcReturn > 1.0, btcReturn }; // >100% = bull market
}

// ── Recomendación ──────────────────────────────────────────────────────

function buildRecommendation(
  overallConsistency: number,
  avgSharpeDegradation: number,
  grade: WFTestResult['robustnessGrade'],
  windows: WFWindowResult[]
): string {
  const worst = windows.reduce((prev, w) =>
    w.consistencyScore < prev.consistencyScore ? w : prev,
    windows[0]
  );
  const best = windows.reduce((prev, w) =>
    w.consistencyScore > prev.consistencyScore ? w : prev,
    windows[0]
  );

  const gradeDescriptions: Record<string, string> = {
    A: `Motor muy robusto (estabilidad ${(overallConsistency * 100).toFixed(0)}%). Los parámetros generalizan bien en todos los períodos históricos. Confianza alta en las señales actuales. Degradación Sharpe media: ${avgSharpeDegradation.toFixed(2)}.`,
    B: `Robustez buena (${(overallConsistency * 100).toFixed(0)}%). La mayoría de ventanas mantienen rendimiento OOS aceptable. La ventana ${worst.window.windowIndex + 1} muestra divergencia (consistencia ${(worst.consistencyScore * 100).toFixed(0)}%). Degradación Sharpe: ${avgSharpeDegradation.toFixed(2)}. Mantener vigilancia.`,
    C: `Robustez moderada (${(overallConsistency * 100).toFixed(0)}%). Degradación Sharpe media de ${avgSharpeDegradation.toFixed(2)}. La ventana ${worst.window.windowIndex + 1} tuvo rendimiento OOS significativamente peor que IS. Considera reducir peso de momentum y aumentar value/lowVol.`,
    D: `Riesgo de overfitting (${(overallConsistency * 100).toFixed(0)}%). Degradación Sharpe de ${avgSharpeDegradation.toFixed(2)}. Varias ventanas OOS con rendimiento negativo o muy inferior al IS. Los parámetros pueden estar sobreoptimizados al período 2015-2020. Se recomienda: reducir momentum weight, aumentar lowVol, y validar con datos más recientes.`,
    F: `Overfitting severo (${(overallConsistency * 100).toFixed(0)}%). Degradación Sharpe crítica de ${avgSharpeDegradation.toFixed(2)}. El sistema NO generaliza a datos no vistos. Se recomienda FUERTEMENTE: (1) reducir número de parámetros libres, (2) añadir regularización vía Ledoit-Wolf más agresivo, (3) probar con menos activos, (4) considerar walk-forward con nWindows=3 para tener más datos OOS por ventana.`,
  };

  const gradeDesc = gradeDescriptions[grade] ?? gradeDescriptions['C'];
  const bestInfo = `Mejor ventana: ${best.window.windowIndex + 1} (IS Sharpe ${best.inSample.metrics.sharpe.toFixed(2)} → OOS ${best.outOfSample.metrics.sharpe.toFixed(2)})`;
  const worstInfo = `Peor ventana: ${worst.window.windowIndex + 1} (IS Sharpe ${worst.inSample.metrics.sharpe.toFixed(2)} → OOS ${worst.outOfSample.metrics.sharpe.toFixed(2)})`;

  return `${gradeDesc}\n${bestInfo}\n${worstInfo}`;
}

// ── Resultado por datos insuficientes ──────────────────────────────────

function insufficientDataResult(
  config: WFTestConfig,
  totalDataDays: number
): WFTestResult {
  return {
    config,
    totalDataDays,
    windows: [],
    overallConsistency: 0,
    avgSharpeDegradation: 0,
    avgCagrDegradation: 0,
    avgMaxDdDegradation: 0,
    sharpeIsAvg: 0,
    sharpeOosAvg: 0,
    cagrIsAvg: 0,
    cagrOosAvg: 0,
    robustnessGrade: 'F',
    overfittingRisk: 'HIGH',
    pctWindowsPositiveSharpe: 0,
    pctWindowsPositiveCagr: 0,
    recommendation: `Datos insuficientes para walk-forward. Se necesitan al menos ${config.nWindows * 100 + config.lookbackDays} días de datos; se tienen ${totalDataDays}.`,
    adaptiveFactorWeights: { momentum: 0.40, value: 0.25, quality: 0.20, lowVol: 0.15 },
    deflatedSharpeRatio: 0,
    probabilisticSharpeRatio: 0.5,
    equalWeightSharpeOosAvg: 0,
    beatsEqualWeight: false,
    pctBullMarketWindows: 0,
  };
}

// ── FUNCIÓN PRINCIPAL ──────────────────────────────────────────────────

/**
 * Ejecuta walk-forward testing sobre el motor OlympusV5 (runBacktest).
 *
 * Para cada ventana cronológica:
 *   1. Recorta closesHistory y macroHistory al segmento IS
 *   2. Ejecuta runBacktest completo sobre ese segmento
 *   3. Recorta datos al segmento OOS (con lookback de burn-in)
 *   4. Ejecuta runBacktest sobre el segmento OOS
 *   5. Compara métricas IS vs OOS → consistencia
 *
 * @param input - Misma entrada que runBacktest (closesHistory, macroHistory, etc.)
 * @param config - Configuración opcional (nWindows, trainRatio, etc.)
 * @returns WFTestResult con análisis completo
 */
export function runWalkForwardTest(
  input: BacktestInput,
  config: Partial<WFTestConfig> = {}
): WFTestResult {
  const cfg: WFTestConfig = { ...DEFAULT_WF_CONFIG, ...config };
  const { nWindows, lookbackDays } = cfg;

  // ── Determinar longitud total de datos ──────────────────────────────
  const lengths = ASSETS.map(t => {
    const bticker = PROXY_MAP[t] ?? t;
    return (input.closesHistory[bticker] ?? []).length;
  });
  const totalDataDays = Math.max(...lengths);
  if (totalDataDays < lookbackDays + nWindows * 63) {
    return insufficientDataResult(cfg, totalDataDays);
  }

  // ── Construir ventanas ──────────────────────────────────────────────
  const windows = buildWindows(totalDataDays, cfg);
  if (windows.length === 0) {
    return insufficientDataResult(cfg, totalDataDays);
  }

  // ── Ejecutar walk-forward por ventana ──────────────────────────────
  const results: WFWindowResult[] = [];

  // ── Backtest tickers (con proxy) ──
  // Usar PROXY_MAP como runBacktest para que el EW benchmark compare justo
  const backtestTickers: Record<string, string> = {};
  for (const ticker of ASSETS) {
    backtestTickers[ticker] = PROXY_MAP[ticker] ?? ticker;
  }

  // Helper para slicear macroHistory incluyendo campos opcionales
  function sliceMacro(macro: typeof input.macroHistory, start: number, end: number) {
    return {
      vix: macro.vix.slice(start, end),
      yieldSpread: macro.yieldSpread.slice(start, end),
      creditSpread: macro.creditSpread.slice(start, end),
      m2Growth: macro.m2Growth?.slice(start, end),
      move: macro.move?.slice(start, end),
      dxyTrend: macro.dxyTrend?.slice(start, end),
      btcVol: macro.btcVol?.slice(start, end),
      wtiOil: macro.wtiOil?.slice(start, end),
    };
  }

  for (const win of windows) {
    // ---- IN-SAMPLE: datos desde 0 hasta trainEnd ----
    const isCloses = sliceClosesHistory(input.closesHistory, 0, win.trainEnd);
    const isMacro = sliceMacro(input.macroHistory, 0, win.trainEnd);
    // FIX: destructure covMatrix out of input to avoid look-ahead bias.
    // Si input contiene una covMatrix precomputada sobre TODOS los datos,
    // al propagarla al IS/OOS estaríamos usando información futura.
    // runBacktest computa su propia covMatrix internamente.
    const { covMatrix: _omitCov, ...inputClean } = input;

    const isInput: BacktestInput = {
      ...inputClean,
      closesHistory: isCloses,
      macroHistory: isMacro,
      lookbackDays,
      rebalanceDays: cfg.rebalanceDays,
      initialCapital: cfg.initialCapital,
      transactionCostBps: cfg.transactionCostBps,
      useDynamicCovariance: true,
    };
    const isResult = runBacktest(isInput);

    // ---- OUT-OF-SAMPLE: datos desde (trainEnd - lookbackDays) hasta testEnd ----
    const oosStart = Math.max(0, win.trainEnd - lookbackDays);
    const oosCloses = sliceClosesHistory(input.closesHistory, oosStart, win.testEnd);
    const oosMacro = sliceMacro(input.macroHistory, oosStart, win.testEnd);
    const oosInput: BacktestInput = {
      ...inputClean,
      closesHistory: oosCloses,
      macroHistory: oosMacro,
      lookbackDays,
      rebalanceDays: cfg.rebalanceDays,
      initialCapital: cfg.initialCapital,
      transactionCostBps: cfg.transactionCostBps,
      useDynamicCovariance: true,
    };
    const oosResult = runBacktest(oosInput);

    // ---- Equal Weight Benchmark (misma ventana OOS) ----
    // FIX-EW-COSTS: EW ahora incluye costes de transacción igual que el motor
    const ewResult = equalWeightBenchmark(
      input.closesHistory, backtestTickers,
      oosStart, win.testEnd, cfg.initialCapital,
      cfg.rebalanceDays, cfg.transactionCostBps
    );

    // ---- Bull Market Detection ----
    const bullCheck = isBullMarketWindow(input.closesHistory, oosStart, win.testEnd);

    // ---- Métricas ----
    const consistencyScore = computeConsistency(isResult.metrics, oosResult.metrics);
    const sharpeDegradation = isResult.metrics.sharpe - oosResult.metrics.sharpe;
    const cagrDegradation = isResult.metrics.cagr - oosResult.metrics.cagr;
    const maxDdDegradation = oosResult.metrics.maxDrawdown - isResult.metrics.maxDrawdown;
    const winRateDegradation = isResult.metrics.winRate - oosResult.metrics.winRate;

    results.push({
      window: win,
      inSample: isResult,
      outOfSample: oosResult,
      equalWeightBenchmark: {
        metrics: {
          cagr: ewResult.cagr,
          sharpe: ewResult.sharpe,
          sortino: 0,
          maxDrawdown: ewResult.maxDrawdown,
          calmar: ewResult.maxDrawdown < 0 ? ewResult.cagr / Math.abs(ewResult.maxDrawdown) : 0,
          totalReturn: ewResult.finalValue / cfg.initialCapital - 1,
          winRate: 0,
          volatility: 0,
          finalValue: ewResult.finalValue,
          betaVsBenchmark: 1,
          alphaVsBenchmark: 0,
          hhi: 0,
        },
        dailyRecords: [],
        benchmarkMetrics: { cagr: 0, sharpe: 0, sortino: 0, maxDrawdown: 0, calmar: 0, totalReturn: 0, winRate: 0, volatility: 0, finalValue: 0, betaVsBenchmark: 1, alphaVsBenchmark: 0, hhi: 0 },
        regimeConditional: { EXPANSION: { cagr: 0, sharpe: 0, maxDrawdown: 0, annualizedReturn: 0, volatility: 0, totalDays: 0 }, CONTRACTION: { cagr: 0, sharpe: 0, maxDrawdown: 0, annualizedReturn: 0, volatility: 0, totalDays: 0 }, CRISIS: { cagr: 0, sharpe: 0, maxDrawdown: 0, annualizedReturn: 0, volatility: 0, totalDays: 0 } },
        regimeDays: { EXPANSION: 0, CONTRACTION: 0, CRISIS: 0 },
        daysWithProxies: 0, daysWithRealData: 0,
        transactionCostBps: 0, totalTransactionCosts: 0, rebalanceCount: 0,
      },
      consistencyScore,
      sharpeDegradation,
      cagrDegradation,
      maxDdDegradation,
      winRateDegradation,
      bullMarketWindow: bullCheck.isBull,
      btcReturnWindow: bullCheck.btcReturn,
    });
  }

  if (results.length === 0) {
    return insufficientDataResult(cfg, totalDataDays);
  }

  // ── Agregar resultados globales ─────────────────────────────────────
  const overallConsistency = results.reduce((s, r) => s + r.consistencyScore, 0) / results.length;
  const avgSharpeDegradation = results.reduce((s, r) => s + r.sharpeDegradation, 0) / results.length;
  const avgCagrDegradation = results.reduce((s, r) => s + r.cagrDegradation, 0) / results.length;
  const avgMaxDdDegradation = results.reduce((s, r) => s + r.maxDdDegradation, 0) / results.length;
  const sharpeIsAvg = results.reduce((s, r) => s + r.inSample.metrics.sharpe, 0) / results.length;
  const sharpeOosAvg = results.reduce((s, r) => s + r.outOfSample.metrics.sharpe, 0) / results.length;
  const cagrIsAvg = results.reduce((s, r) => s + r.inSample.metrics.cagr, 0) / results.length;
  const cagrOosAvg = results.reduce((s, r) => s + r.outOfSample.metrics.cagr, 0) / results.length;
  const pctWindowsPositiveSharpe = results.filter(r => r.outOfSample.metrics.sharpe > 0).length / results.length;
  const pctWindowsPositiveCagr = results.filter(r => r.outOfSample.metrics.cagr > 0).length / results.length;

  // FIX-AUDIT-R11: Deflated Sharpe Ratio + Equal Weight benchmark
  const ewSharpeOosAvg = results.reduce((s, r) => s + r.equalWeightBenchmark.metrics.sharpe, 0) / results.length;
  const beatsEW = sharpeOosAvg > ewSharpeOosAvg;
  const avgObsPerWindow = results.length > 0
    ? results.reduce((s, r) => s + r.window.testDays, 0) / results.length
    : 252;
  const dsr = deflatedSharpeRatio(sharpeOosAvg, results.length, avgObsPerWindow);
  const psr = probabilisticSharpeRatio(sharpeOosAvg, avgObsPerWindow);
  const pctBullWindows = results.filter(r => r.bullMarketWindow).length / results.length;

  const { robustnessGrade, overfittingRisk } = gradeResults(
    overallConsistency, avgSharpeDegradation, results
  );

  return {
    config: cfg,
    totalDataDays,
    windows: results,
    overallConsistency,
    avgSharpeDegradation,
    avgCagrDegradation,
    avgMaxDdDegradation,
    sharpeIsAvg,
    sharpeOosAvg,
    cagrIsAvg,
    cagrOosAvg,
    robustnessGrade,
    overfittingRisk,
    pctWindowsPositiveSharpe,
    pctWindowsPositiveCagr,
    recommendation: buildRecommendation(
      overallConsistency, avgSharpeDegradation, robustnessGrade, results
    ),
    adaptiveFactorWeights: computeAdaptiveWeights(overfittingRisk),
    deflatedSharpeRatio: dsr,
    probabilisticSharpeRatio: psr,
    equalWeightSharpeOosAvg: ewSharpeOosAvg,
    beatsEqualWeight: beatsEW,
    pctBullMarketWindows: pctBullWindows,
  };
}

// ── Formateo para display ──────────────────────────────────────────────

/**
 * Formatea el resultado del walk-forward test para mostrarlo
 * en consola o dashboard.
 */
export function formatWFResult(result: WFTestResult): string {
  const gradeEmoji: Record<string, string> = { A: '🟢', B: '🟢', C: '🟡', D: '🟠', F: '🔴' };
  const riskEmoji: Record<string, string> = {
    LOW: '🟢', MODERATE: '🟡', HIGH: '🟠', CRITICAL: '🔴',
  };

  const lines: string[] = [
    '',
    '═'.repeat(60),
    '  WALK-FORWARD TEST — Olympus V5',
    '═'.repeat(60),
    `  Ventanas:          ${result.windows.length}/${result.config.nWindows}`,
    `  Datos totales:     ${result.totalDataDays} días`,
    '',
    '─── RESULTADOS GLOBALES ───',
    `  Consistencia:      ${(result.overallConsistency * 100).toFixed(1)}%`,
    `  Grado:             ${gradeEmoji[result.robustnessGrade]} ${result.robustnessGrade}`,
    `  Overfitting Risk:  ${riskEmoji[result.overfittingRisk]} ${result.overfittingRisk}`,
    '',
    '─── RENDIMIENTO PROMEDIO ───',
    `  Sharpe IS:  ${result.sharpeIsAvg.toFixed(3)}`,
    `  Sharpe OOS: ${result.sharpeOosAvg.toFixed(3)} | Degradación: ${result.avgSharpeDegradation.toFixed(3)}`,
    `  CAGR IS:    ${(result.cagrIsAvg * 100).toFixed(2)}%`,
    `  CAGR OOS:   ${(result.cagrOosAvg * 100).toFixed(2)}% | Degradación: ${(result.avgCagrDegradation * 100).toFixed(2)}%`,
    `  MaxDD IS:   ${(result.windows.reduce((s, w) => Math.min(s, w.inSample.metrics.maxDrawdown), 0) * 100).toFixed(1)}%`,
    `  MaxDD OOS:  ${(result.windows.reduce((s, w) => Math.min(s, w.outOfSample.metrics.maxDrawdown), 0) * 100).toFixed(1)}%`,
    '',
    '─── ESTABILIDAD POR VENTANA ───',
    ...result.windows.map((w, i) => {
      const emoji = w.consistencyScore >= 0.70 ? '✅' : w.consistencyScore >= 0.50 ? '⚠️' : '❌';
      const bullTag = w.bullMarketWindow ? ` 🐂BTC+${(w.btcReturnWindow * 100).toFixed(0)}%` : '';
      const ewTag = `EW:${w.equalWeightBenchmark.metrics.sharpe.toFixed(2)}`;
      return `  V${i + 1}: Sharpe ${w.inSample.metrics.sharpe.toFixed(2)}→${w.outOfSample.metrics.sharpe.toFixed(2)} | CAGR ${(w.inSample.metrics.cagr * 100).toFixed(1)}%→${(w.outOfSample.metrics.cagr * 100).toFixed(1)}% | ${emoji} ${(w.consistencyScore * 100).toFixed(0)}% | ${ewTag}${bullTag}`;
    }),
    '',
    '─── DSR (Deflated Sharpe Ratio) ───',
    `  DSR:   ${result.deflatedSharpeRatio.toFixed(3)} ${result.deflatedSharpeRatio > 1 ? '🟢 p<0.32' : result.deflatedSharpeRatio > 0 ? '🟡' : '🔴'}`,
    `  PSR:   ${(result.probabilisticSharpeRatio * 100).toFixed(1)}% probabilidad de Sharpe > 0`,
    `  EW OOS: Sharpe ${result.equalWeightSharpeOosAvg.toFixed(3)} — Motor ${result.beatsEqualWeight ? '🟢 BATE' : '🔴 PIERDE'} vs Equal Weight`,
    `  Bull:   ${(result.pctBullMarketWindows * 100).toFixed(0)}% ventanas en bull market BTC (>100%)`,
    '',
    '─── PESOS ADAPTATIVOS ───',
    `  Momentum: ${(result.adaptiveFactorWeights.momentum * 100).toFixed(0)}%`,
    `  Value:    ${(result.adaptiveFactorWeights.value * 100).toFixed(0)}%`,
    `  Quality:  ${(result.adaptiveFactorWeights.quality * 100).toFixed(0)}%`,
    `  LowVol:   ${(result.adaptiveFactorWeights.lowVol * 100).toFixed(0)}%`,
    '',
    '─── RECOMENDACIÓN ───',
    `  ${result.recommendation}`,
    '═'.repeat(60),
    '',
  ];

  return lines.join('\n');
}
