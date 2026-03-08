// ===============================================
// ARCHIVO: src/core/engine/olympusV3.ts
// NIVEL 2 — Motor completo con todas las capas integradas
// ===============================================
// CAPAS DE ASIGNACIÓN (en orden de aplicación):
//
//   1. FACTOR SCORES     → momentum (Jegadeesh-Titman) + value (cross-sectional z-score)
//   2. KELLY FRACTION    → half-kelly con cap 0.25 sobre expected return normalizado
//   3. CORRELATION       → penalización si correlación media > 0.5
//   4. REGIME PENALTY    → continua [0.4,1.0] via regimeProbabilistic (Nivel 2)
//   5. MARKOWITZ BLEND   → blend 50/50 Kelly + Markowitz si covMatrix disponible (Nivel 2)
//   6. RISK PARITY BLEND → blend adicional con ERC si sector budgets (Nivel 2)
//   7. VOL TARGET        → escalar allocations a volatilidad objetivo 14% (Nivel 2)
//   8. TAIL RISK OVERLAY → reducción adicional en drawdown severo o crisis extrema (Nivel 2)
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

    // Blend de 4 factores — pesos calibrados empíricamente
    // Momentum: 40% (fuerte señal de continuación)
    // Value:    25% (contrarian signal)
    // Quality:  20% (defensivo, protege en crisis)
    // LowVol:   15% (anomalía documentada, especialmente útil en CONTRACTION/CRISIS)
    const rawExpectedReturn =
      momentum.momentumScore * 0.40 +
      value.valueScore       * 0.25 +
      quality.qualityScore   * 0.20 +
      (lowVol.lowVolScore + lowVol.downsideVolPenalty) * 0.15;

    return { asset, momentum, value, quality, lowVol, rawExpectedReturn };
  });

  // Z-normalizar expectedReturn del universo
  const allRaw = rawScores.map(s => s.rawExpectedReturn);
  const rawMean = allRaw.reduce((a, b) => a + b, 0) / allRaw.length;
  const rawStd = Math.sqrt(allRaw.reduce((s, v) => s + (v - rawMean) ** 2, 0) / allRaw.length) || 1;

  // ====== CAPA 3: KELLY ======
  const kellyAllocations = rawScores.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn }) => {
    const normalizedExpectedReturn = (rawExpectedReturn - rawMean) / rawStd;
    const kelly = calculateKelly({ expectedReturn: normalizedExpectedReturn, volatility: asset.volatility });
    // ERP ajusta solo activos de renta variable — oro y BTC no tienen earnings yield
    // por lo que su relación con el ERP del S&P500 es indirecta (actúan como alternativa)
    const isEquity = asset.earningsYield > 0;
    const erpAdj = isEquity ? erpMultiplier : (erpRaw < -0.005 ? 1.03 : 1.0); // gold/BTC ligero boost si ERP muy negativo
    const kellyAlloc = kelly.kellyFraction * corrPenalty * masterRegime.regimePenalty * erpAdj;
    return { asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn, kelly, kellyAlloc };
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

  // ====== CAPA 4: MARKOWITZ BLEND (Nivel 2) ======
  let markowitzWeights: number[] = assets.map(() => 1 / assets.length); // fallback: equal weight
  if (hasRealCovMatrix && input.covMatrix) {
    try {
      markowitzWeights = minimumVarianceWeights(input.covMatrix, assets.length);
    } catch {
      // Si la matriz es singular u otro error, fallback a equal weight
      markowitzWeights = assets.map(() => 1 / assets.length);
    }
  }

  // ====== CAPA 5: RISK PARITY + HRP BLEND ======
  const rpInputs = assets.map(a => ({
    name: a.name,
    volatility: a.volatility,
    riskBudget: DEFAULT_SECTOR_BUDGETS[a.sector ?? ""] ?? 1,
  }));
  const rpResult = computeRiskParityWeights(rpInputs);
  const rpWeights = assets.map(a => rpResult.find(r => r.name === a.name)?.weight ?? 1 / assets.length);

  // HRP: usa covMatrix real si disponible, sino fallback a igual peso
  const hrpResult = computeHRP(hasRealCovMatrix ? input.covMatrix! : [], assets.length);
  const hrpWeights = hrpResult.weights;

  // ====== CAPA 5B: BLACK-LITTERMAN ======
  // Genera views automáticas desde los factor scores del motor si no se pasan explícitamente.
  // Las views mezclan el equilibrio de mercado (covarianza implícita) con las señales del motor.
  let blWeights: number[] = assets.map(() => 1 / assets.length); // fallback: equal weight
  if (hasRealCovMatrix && input.covMatrix) {
    try {
      const blViews = input.blViews ?? generateViewsFromEngine(
        rawScores.map(s => ({
          name: s.asset.name,
          // FIX BUG-01: AssetInput has no ticker field — use name as the identifier.
          // Previously `s.asset.ticker` was always `undefined`, making the P matrix
          // all-zeros → omega=0 → division by zero → silent catch → equal-weight fallback.
          ticker: s.asset.name,
          momentumScore: s.momentum.momentumScore,
          valuePercentileRank: s.value.percentileRank,
        })),
        masterRegime.regime,
        input.liquidityGrowth ?? 0
      );
      // Pesos de mercado actuales = pesos blendNorm actuales (antes de BL) o equal weight
      const marketWeights = assets.map(() => 1 / assets.length);
      const blResult = runBlackLitterman({
        // FIX BUG-01: use name (not ticker) as the asset identifier — consistent with views above.
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

  // ====== BLEND FINAL: Kelly 35% + Markowitz 15% + RiskParity 10% + HRP 20% + BL 20% ======
  // HRP reemplaza parte del Risk Parity estándar (más robusto out-of-sample)
  // Con covMatrix real: blend completo. Sin ella: Kelly + RP + HRP igual pesos
  const blendWeights = assets.map((_, i) => {
    if (hasRealCovMatrix) {
      // Con covMatrix real: blend completo con Black-Litterman
      // BL añade 20% — reduce Markowitz y Kelly ligeramente para cederle espacio
      return kellyNorm[i].kellyNormalized * 0.35
           + markowitzWeights[i]           * 0.15
           + rpWeights[i]                  * 0.10
           + hrpWeights[i]                 * 0.20
           + blWeights[i]                  * 0.20;
    } else {
      // Sin covMatrix: Kelly + RP + HRP (BL necesita covMatrix real)
      return kellyNorm[i].kellyNormalized * 0.40
           + rpWeights[i]                  * 0.30
           + hrpWeights[i]                 * 0.30;
    }
  });

  // Normalizar blend a suma=1
  const totalBlend = blendWeights.reduce((s, w) => s + w, 0) || 1;
  const blendNorm = blendWeights.map(w => w / totalBlend);

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