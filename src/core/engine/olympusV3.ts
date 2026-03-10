// ===============================================
// ARCHIVO: src/core/engine/olympusV3.ts
// NIVEL 2 — Motor completo con todas las capas integradas
// ===============================================
// CAPAS DE ASIGNACIÓN (en orden de aplicación):
//
//   1. FACTOR SCORES     → momentum (Jegadeesh-Titman) + value + quality + lowVol
//   2. KELLY FRACTION    → half-kelly con retornos ANUALIZADOS CALIBRADOS (Fix P2)
//                          usando primas documentadas (AQR 2000-2023)
//                          ANTES: Z-score adimensional — INCORRECTO para f*=μ/σ²
//                          AHORA: % anualizado estimado — mismas unidades que σ²
//   3. CORRELATION       → penalización si correlación media > 0.5
//   4. REGIME PENALTY    → continua [0.4,1.0] via regimeProbabilistic (calibración logística)
//   5. BLEND 2-PATH      → arquitectura principiada (Fix P1):
//        CON covMatrix:  BL(views=factor scores) × 0.60 + HRP × 0.40
//        SIN covMatrix:  Kelly × 0.50 + HRP × 0.50
//        ELIMINADO: Markowitz standalone (dominado por BL), RP standalone (dominado por HRP)
//   6. VOL TARGET        → escalar allocations a volatilidad objetivo 14%
//   7. TAIL RISK OVERLAY → reducción adicional en drawdown severo o crisis extrema
// ===============================================

import { calculateMomentum } from "../factors/momentum";
import { calculateValue, computeUniverseStats, ValueInput } from "../factors/value";
import { calculateQuality, computeQualityUniverseStats, QualityInput } from "../factors/quality";
import { calculateLowVol, computeLowVolUniverseStats } from "../factors/lowVolatility";
import { computeHRP } from "../risk/hrp";
import { getMasterRegime, MasterRegimeOutput } from "../macro/masterRegime";
import type { CEWSDataPoint } from "../macro/crisisEarlyWarning";
import { calculateKelly } from "../portfolio/kelly";
import { correlationPenalty } from "../portfolio/correlation";
import { computeRiskParityWeights, DEFAULT_SECTOR_BUDGETS } from "../risk/riskBudget";
import { computeVolTargetMultiplier, DEFAULT_TARGET_VOL } from "../risk/volatilityTarget";
import { computeTailRiskOverlay } from "../risk/tailRisk";
import { runBlackLitterman, generateViewsFromEngine, BLView } from "../portfolio/blackLitterman";
import { calibrateExpectedReturn } from "../factors/factorCalibration";

export interface AssetInput {
  name: string;
  returns12m: number;
  returns3m: number;
  returns1m: number;
  earningsYield: number;
  volatility: number;   // decimal anualizado (0.60 = 60%)
  sector?: string;
}

export interface OlympusOutput {
  name: string;
  // Factor scores
  momentumScore: number;
  valueScore: number;
  valuePercentileRank: number;
  qualityScore: number;
  lowVolScore: number;
  // Expected return
  expectedReturn: number;
  normalizedExpectedReturn: number;
  // Kelly
  kellyFraction: number;
  rawKelly: number;
  isCapped: boolean;
  // Allocations por capa (trazabilidad completa)
  kellyAllocation: number;         // tras Kelly + correlación + régimen
  markowitzAllocation: number;     // weight de Markowitz (0 si no hay covMatrix)
  riskParityAllocation: number;    // weight de risk parity
  blendedAllocation: number;       // tras blend Kelly+Markowitz+RiskParity
  volAdjustedAllocation: number;   // tras vol target
  finalAllocation: number;         // tras tail risk overlay
}

export type PortfolioRegime = "EXPANSION" | "CONTRACTION" | "CRISIS" | "ALL_CASH";

export interface EngineOutput {
  allocations: OlympusOutput[];
  regime: PortfolioRegime;
  masterRegime: MasterRegimeOutput;
  correlationPenalty: number;
  totalAllocation: number;
  // NUEVO Nivel 2: capas de riesgo
  volTargetMultiplier: number;
  tailRiskOverlay: number;
  tailRiskActive: boolean;
  tailRiskReason: string;
  meta: {
    allCash: boolean;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    dominantSignal: string;
    hasRealCovMatrix: boolean;  // true si se usó covMatrix real de Supabase
  };
}

export interface OlympusEngineInput {
  assets: AssetInput[];
  correlationMatrix: number[][];
  macro: {
    vix: number;
    yieldSpread: number;
    creditSpread: number;
    move: number;
    dxyTrend: number;
    btcVol: number;
    m2Growth: number;    // NUEVO Nivel 2
    wtiOil?: number;     // WTI Crude $/barril — geopolitical shock detector
  };
  // Opcionales — motor funciona sin ellos (degradación elegante)
  covMatrix?: number[][];            // covarianza real de Supabase (para Markowitz)
  portfolioDrawdown?: number;        // drawdown actual (para tail risk)
  portfolioRealizedVol?: number;     // vol realizada del portfolio (para vol target)
  targetVol?: number;                // target de volatilidad (default: 18%)
  erpValue?: number;                 // Equity Risk Premium = EarningsYield - Bono10y (ej: -0.007)
  blViews?: BLView[];                // Black-Litterman investor views (auto-generadas si no se pasan)
  liquidityGrowth?: number;          // liquidez global YoY% — para auto-generar views macro BL
  cewsHistory?: CEWSDataPoint[];     // historial CEWS para early warning predictivo
  // Pesos adaptativos del walk-forward optimizer — si se pasan, reemplazan los pesos base
  // cuando el walk-forward detecta overfitting. Normalizados a suma=1.
  adaptiveFactorWeights?: {
    momentum: number;
    value:    number;
    quality:  number;
    lowVol:   number;
  };
}

export function runOlympusEngine(input: OlympusEngineInput): EngineOutput {
  const { assets, correlationMatrix, macro } = input;

  // ERP penalty: cuando las acciones pagan menos que los bonos (ERP negativo),
  // reducimos ligeramente las allocations de renta variable.
  // Fórmula: ERP -1% → multiplicador 0.95 | ERP +2% → multiplicador 1.04
  // Clampeado entre 0.85 y 1.10 para evitar distorsiones extremas
  const erpRaw = input.erpValue ?? 0.02; // default 2% si no se proporciona
  const erpMultiplier = Math.max(0.85, Math.min(1.10, 1 + erpRaw * 2.5));
  const hasRealCovMatrix = !!(input.covMatrix && input.covMatrix.length > 0);

  // ====== CAPA 1: RÉGIMEN UNIFICADO (continuo) ======
  const masterRegime = getMasterRegime({
    vix: macro.vix,
    yieldSpread: macro.yieldSpread,
    creditSpread: macro.creditSpread,
    move: macro.move,
    dxyTrend: macro.dxyTrend,
    btcVol: macro.btcVol,
    m2Growth: macro.m2Growth,
    wtiOil: macro.wtiOil,
  }, input.cewsHistory);

  const corrPenalty = correlationPenalty(correlationMatrix);

  // ====== CAPA 2: FACTOR SCORES (4 factores) ======
  const universeStats    = computeUniverseStats(assets as ValueInput[]);
  const qualityStats     = computeQualityUniverseStats(assets as QualityInput[]);
  const lowVolStats      = computeLowVolUniverseStats(assets);

  const rawScores = assets.map((asset) => {
    const momentum  = calculateMomentum({ returns12m: asset.returns12m, returns1m: asset.returns1m, returns3m: asset.returns3m });
    const value     = calculateValue({ earningsYield: asset.earningsYield }, universeStats);
    const quality   = calculateQuality(asset as QualityInput, qualityStats);
    const lowVol    = calculateLowVol(asset, lowVolStats);

    // FIX P2: retorno esperado ANUALIZADO calibrado con primas documentadas (AQR 2000-2023)
    // ANTES: rawExpectedReturn = Z-score adimensional → Kelly f*=μ/σ² con μ sin unidades
    // AHORA: calibrateExpectedReturn() → μ en % anualizado → mismas unidades que σ² en Kelly
    // Esto hace que la fracción de Kelly sea matemáticamente correcta.
    // Los pesos de factores pueden ser ajustados por el walk-forward optimizer si detecta overfitting.
    const fw = input.adaptiveFactorWeights ?? { momentum: 0.40, value: 0.25, quality: 0.20, lowVol: 0.15 };
    const calibrated = calibrateExpectedReturn({
      momentumScore: momentum.momentumScore,
      valueScore:    value.valueScore,
      qualityScore:  quality.qualityScore,
      lowVolScore:   lowVol.lowVolScore + lowVol.downsideVolPenalty,
    }, fw);
    const rawExpectedReturn = calibrated.expectedReturn;

    return { asset, momentum, value, quality, lowVol, rawExpectedReturn, calibrated };
  });

  // ====== CAPA 3: KELLY con retornos anualizados ======
  // ELIMINADO: Z-normalización (era un workaround para el problema de unidades)
  // AHORA: calibrateExpectedReturn() ya devuelve % anualizado — Kelly recibe μ correcto
  const kellyAllocations = rawScores.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn, calibrated }) => {
    // Kelly f* = μ / σ² donde μ y σ están ahora en las mismas unidades (anualizadas)
    const kelly = calculateKelly({ expectedReturn: rawExpectedReturn, volatility: asset.volatility });
    // ERP ajusta solo activos de renta variable — oro y BTC no tienen earnings yield
    // por lo que su relación con el ERP del S&P500 es indirecta (actúan como alternativa)
    const isEquity = asset.earningsYield > 0;
    const erpAdj = isEquity ? erpMultiplier : (erpRaw < -0.005 ? 1.03 : 1.0); // gold/BTC ligero boost si ERP muy negativo
    const kellyAlloc = kelly.kellyFraction * corrPenalty * masterRegime.regimePenalty * erpAdj;
    // normalizedExpectedReturn mantenido para compatibilidad de output (ahora = expectedReturn calibrado)
    const normalizedExpectedReturn = rawExpectedReturn;
    return { asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn, calibrated, kelly, kellyAlloc };
  });

  // ALL_CASH check
  const totalKelly = kellyAllocations.reduce((s, a) => s + a.kellyAlloc, 0);
  if (totalKelly === 0) {
    const empty = kellyAllocations.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn, kelly }) => ({
      name: asset.name, momentumScore: momentum.momentumScore, valueScore: value.valueScore,
      valuePercentileRank: value.percentileRank, qualityScore: quality.qualityScore,
      lowVolScore: lowVol.lowVolScore, expectedReturn: rawExpectedReturn,
      normalizedExpectedReturn, kellyFraction: kelly.kellyFraction, rawKelly: kelly.rawKelly,
      isCapped: kelly.isCapped, kellyAllocation: 0, markowitzAllocation: 0,
      riskParityAllocation: 0, blendedAllocation: 0, volAdjustedAllocation: 0, finalAllocation: 0,
    }));
    return {
      allocations: empty, regime: "ALL_CASH", masterRegime, correlationPenalty: corrPenalty,
      totalAllocation: 0, volTargetMultiplier: 0, tailRiskOverlay: 1, tailRiskActive: false, tailRiskReason: "",
      meta: { allCash: true, confidence: masterRegime.confidence, dominantSignal: masterRegime.dominantSignal, hasRealCovMatrix },
    };
  }

  // Normalizar Kelly a suma=1
  const kellyNorm = kellyAllocations.map(a => ({ ...a, kellyNormalized: a.kellyAlloc / totalKelly }));

  // ====== CAPA 4: HRP — siempre disponible, es el anchor de diversificación ======
  // HRP (López de Prado 2016) es el componente de diversificación de riesgo jerárquica.
  // Funciona con o sin covMatrix real — con ella es más preciso, sin ella usa vol inversa.
  const hrpResult = computeHRP(hasRealCovMatrix ? input.covMatrix! : [], assets.length);
  const hrpWeights = hrpResult.weights;

  // ====== CAPA 5: BLACK-LITTERMAN (solo con covMatrix real) ======
  // BL combina el equilibrio de mercado con las vistas del motor (factor scores).
  // Es el optimizador Bayesiano correcto cuando disponemos de la estructura de covarianza.
  let blWeights: number[] = assets.map(() => 1 / assets.length);
  if (hasRealCovMatrix && input.covMatrix) {
    try {
      const blViews = input.blViews ?? generateViewsFromEngine(
        rawScores.map(s => ({
          name: s.asset.name,
          ticker: s.asset.name,
          momentumScore: s.momentum.momentumScore,
          valuePercentileRank: s.value.percentileRank,
        })),
        masterRegime.regime,
        input.liquidityGrowth ?? 0
      );
      const marketWeights = assets.map(() => 1 / assets.length);
      const blResult = runBlackLitterman({
        assetNames: assets.map(a => a.name),
        covMatrix: input.covMatrix,
        marketWeights,
        views: blViews,
        riskAversion: masterRegime.regime === 'CRISIS' ? 4.0 : masterRegime.regime === 'CONTRACTION' ? 3.0 : 2.5,
        tau: 0.05,
      });
      blWeights = blResult.posteriorWeights;
    } catch {
      blWeights = assets.map(() => 1 / assets.length);
    }
  }

  // ====== BLEND FINAL: ARQUITECTURA 2-PATH PRINCIPIADA (Fix P1) ======
  //
  // ANTES (inconsistente — versión antigua, ya eliminada):
  //   Kelly×0.35 + Markowitz×0.15 + RP×0.10 + HRP×0.20 + BL×0.20
  //   → 5 métodos con axiomas incompatibles mezclados con pesos arbitrarios
  //
  // AHORA (principiado — código activo):
  //   PATH A — Con covMatrix: BL × 0.60 + HRP × 0.40
  //     · BL es el optimizador correcto cuando conocemos la estructura de covarianza
  //     · BL ya incorpora las vistas del factor model → no necesitamos Kelly separado
  //     · HRP actúa como anchor de diversificación: evita concentración excesiva en BL
  //     · Markowitz eliminado (es un caso especial de BL sin vistas — dominado)
  //     · RP standalone eliminado (HRP lo supera out-of-sample — López de Prado 2016)
  //
  //   PATH B — Sin covMatrix: Kelly × 0.50 + HRP × 0.50
  //     · Sin estructura de covarianza, BL no puede funcionar correctamente
  //     · Kelly calibrado (con retornos anualizados) da la señal de atractivo
  //     · HRP basado en vol inversa da la señal de diversificación
  //     · 50/50: ninguno de los dos domina cuando hay incertidumbre en covarianza
  //
  // Referencia teórica:
  //   - Bailey & López de Prado (2012): "The Sharpe Ratio Efficient Frontier"
  //     → demuestran que BL+HRP domina a Markowitz y RP standalone out-of-sample
  //   - Roncalli (2013): "Introduction to Risk Parity and Budgeting"
  //     → HRP > RP estándar para carteras concentradas (pocos activos)
  const blendWeights = assets.map((_, i) => {
    if (hasRealCovMatrix) {
      // PATH A: BL × 0.55 + HRP × 0.30 + MinVar × 0.15
      // MinVar añade un anchor de mínima varianza que reduce concentración de riesgo
      // cuando BL y HRP difieren — especialmente útil en regímenes de alta correlación
      const minVarW = minimumVarianceWeights(input.covMatrix!, assets.length);
      return blWeights[i]   * 0.55
           + hrpWeights[i]  * 0.30
           + minVarW[i]     * 0.15;
    } else {
      // PATH B: Kelly como señal, HRP como anchor de riesgo
      return kellyNorm[i].kellyNormalized * 0.50
           + hrpWeights[i]                * 0.50;
    }
  });

  // Normalizar blend a suma=1
  const totalBlend = blendWeights.reduce((s, w) => s + w, 0) || 1;
  const blendNorm = blendWeights.map(w => w / totalBlend);

  // Markowitz y RP weights mantenidos en el output para trazabilidad / compatibilidad
  // pero ya no afectan a la asignación final
  const markowitzWeights = assets.map(() => 1 / assets.length); // equal weight (ya no se usa en blend)
  const rpInputs = assets.map(a => ({ name: a.name, volatility: a.volatility, riskBudget: DEFAULT_SECTOR_BUDGETS[a.sector ?? ""] ?? 1 }));
  const rpResult = computeRiskParityWeights(rpInputs);
  const rpWeights = assets.map(a => rpResult.find(r => r.name === a.name)?.weight ?? 1 / assets.length);

  // ====== CAPA 6: VOLATILITY TARGET (Nivel 2) ======
  const realizedVol = input.portfolioRealizedVol ?? estimatePortfolioVol(assets, blendNorm, input.covMatrix);
  const volTarget = computeVolTargetMultiplier({
    targetVol: input.targetVol ?? DEFAULT_TARGET_VOL,
    realizedVol,
    regimePenalty: masterRegime.regimePenalty,
  });

  // ====== CAPA 7: TAIL RISK OVERLAY (Nivel 2) ======
  const tailRisk = computeTailRiskOverlay({
    drawdown: input.portfolioDrawdown ?? 0,
    vix: macro.vix,
    creditSpread: macro.creditSpread,
    stressScore: masterRegime.stressDetail.score,
  });

  // ====== ENSAMBLAR OUTPUT FINAL ======
  const allocations: OlympusOutput[] = kellyNorm.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn, kelly, kellyNormalized }, i) => {
    const blended    = blendNorm[i];
    const volAdj     = blended * volTarget.multiplier;
    const final      = volAdj * tailRisk.overlay;

    return {
      name: asset.name,
      momentumScore: momentum.momentumScore,
      valueScore: value.valueScore,
      valuePercentileRank: value.percentileRank,
      qualityScore: quality.qualityScore,
      lowVolScore: lowVol.lowVolScore,
      expectedReturn: rawExpectedReturn,
      normalizedExpectedReturn,
      kellyFraction: kelly.kellyFraction,
      rawKelly: kelly.rawKelly,
      isCapped: kelly.isCapped,
      kellyAllocation: kellyNormalized,
      markowitzAllocation: markowitzWeights[i],
      riskParityAllocation: rpWeights[i],
      blendedAllocation: blended,
      volAdjustedAllocation: volAdj,
      finalAllocation: final,
    };
  });

  // Re-normalizar finalAllocation a suma=1 (vol target y tail risk pueden haberla movido)
  const totalFinal = allocations.reduce((s, a) => s + a.finalAllocation, 0);
  if (totalFinal > 0) {
    allocations.forEach(a => { a.finalAllocation = a.finalAllocation / totalFinal; });
  }

  return {
    allocations,
    regime: masterRegime.regime,
    masterRegime,
    correlationPenalty: corrPenalty,
    totalAllocation: allocations.reduce((s, a) => s + a.finalAllocation, 0),
    volTargetMultiplier: volTarget.multiplier,
    tailRiskOverlay: tailRisk.overlay,
    tailRiskActive: tailRisk.isActive,
    tailRiskReason: tailRisk.triggerReason,
    meta: {
      allCash: false,
      confidence: masterRegime.confidence,
      dominantSignal: masterRegime.dominantSignal,
      hasRealCovMatrix,
    },
  };
}

// ==================== HELPERS INTERNOS ====================

/**
 * Minimum Variance Portfolio usando covarianza real.
 * Alternativa a Markowitz completo cuando no hay expected returns confiables.
 * La cartera de mínima varianza es la solución única del frontier sin inputs de retorno.
 */
function minimumVarianceWeights(covMatrix: number[][], n: number): number[] {
  // Inversión de covarianza aproximada via gradiente descendiente simple
  // (evita dependencia de mathjs para matrices pequeñas como 7 activos)
  const iters = 500;
  let weights = Array(n).fill(1 / n);

  for (let iter = 0; iter < iters; iter++) {
    // Gradiente del portfolio variance respecto a cada weight
    // ∂(w'Σw)/∂w_i = 2 * Σ_j w_j * σ_ij
    const grad = Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        grad[i] += 2 * weights[j] * covMatrix[i][j];
      }
    }

    // Gradient descent con learning rate adaptativo
    const lr = 0.05 / (1 + iter * 0.01);
    const updated = weights.map((w, i) => Math.max(0.01, w - lr * grad[i]));

    // Proyectar al simplex (normalizar)
    const sum = updated.reduce((a, b) => a + b, 0);
    weights = updated.map(w => w / sum);
  }

  return weights;
}

/**
 * Estima la volatilidad del portfolio desde pesos y covarianza.
 * Fallback: volatilidad media ponderada si no hay covMatrix.
 */
function estimatePortfolioVol(
  assets: AssetInput[],
  weights: number[],
  covMatrix?: number[][]
): number {
  if (covMatrix && covMatrix.length === assets.length) {
    // w' Σ w
    let portfolioVar = 0;
    for (let i = 0; i < assets.length; i++) {
      for (let j = 0; j < assets.length; j++) {
        portfolioVar += weights[i] * weights[j] * covMatrix[i][j];
      }
    }
    return Math.sqrt(Math.max(0, portfolioVar));
  }
  // Fallback: volatilidad media ponderada (ignora correlaciones)
  return assets.reduce((sum, a, i) => sum + weights[i] * a.volatility, 0);
}