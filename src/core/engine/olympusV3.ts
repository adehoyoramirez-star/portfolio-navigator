// ===============================================
// ARCHIVO: src/core/engine/olympusV3.ts
// NIVEL 2 — Motor completo con todas las capas integradas
// ===============================================
// FIX REG-02:    Añadido ENGINE_VERSION para trazabilidad regulatoria (MiFID II).
//                Convención semver: MAJOR.MINOR.PATCH
//                  MAJOR: cambio de arquitectura (BL path, HRP method)
//                  MINOR: cambio de parámetros calibrados o nuevas capas
//                  PATCH: bugfixes sin cambio de comportamiento
// FIX MATH-NEW-02: regimeHistory pasado a getMasterRegime para que
//                  durationAdjustment afecte a allocations reales.
//
// CAPAS DE ASIGNACIÓN (en orden de aplicación):
//   1. FACTOR SCORES     → momentum + value + quality + lowVol
//   2. KELLY FRACTION    → half-kelly con retornos anualizados calibrados (AQR)
//   3. CORRELATION       → penalización si correlación media > 0.5
//   4. REGIME PENALTY    → continuo [0.4,1.0] con durationAdjustment conectado
//   5. BLEND 2-PATH:
//        CON covMatrix:  BL × 0.55 + HRP × 0.30 + MinVar × 0.15
//        SIN covMatrix:  Kelly × 0.50 + HRP × 0.50
//   6. VOL TARGET        → escalar a vol objetivo 14%
//   7. TAIL RISK OVERLAY → reducción en drawdown severo o crisis extrema
// ===============================================

// FIX REG-02: versión del motor — incluir en decision_log para reproducibilidad
export const ENGINE_VERSION = "v4.1.0";
// Changelog:
//   v4.1.0: OLYMPUS V4.1 PRO — Integración BTC Cycle + DCA Contracíclico:
//     1. computeBTCCycleOverlay: MVRV/Puell/RSI → score [0,1] integrado en core signal
//     2. computeDCAMultiplier: DCA intensity por régimen (60/35/15%) + boost BTC 1.4x
//     3. Core signal: 0.35*regime + 0.45*btc_numeric + 0.20*risk
//     4. Volatility rules: vol>25% → -25%, vol>30% → -40%
//     5. Max BTC weight: 70% cap
//   v4.0.0: FIX V4 — tres cambios estructurales:
//     1. BTC_CYCLE_OVERRIDE: señales on-chain ≥4/7 pueden comprar BTC en CRISIS macro
//     2. Kelly cap reducido 0.25→0.20 (per recomendación walk-forward overfitting HIGH)
//     3. Blend rebalanceado: HRP 0.30→0.45, BL 0.55→0.40 (mayor robustez out-of-sample)
//     4. VIX CEWS threshold 25→22 (detecta régimen actual VIX=25.6)
//   v3.5.1: Fix MATH-01 (crisis thresholds), MATH-02 (BL omega), MATH-03 (jump diffusion),
//           MATH-NEW-01 (RSI Wilder's EMA), MATH-NEW-02 (regimeDuration conectado),
//           SEC-02/03/04 (CORS + rate limit + input validation)
//   v3.5.0: Arquitectura 2-path BL+HRP, CEWS integrado, regimeDuration (desconectado — bug)
//   v3.0.0: Motor base con Kelly calibrado AQR, HRP, factores momentum/value/quality/lowVol

import { calculateMomentum } from "../factors/momentum";
import { calculateValue, computeUniverseStats, ValueInput } from "../factors/value";
import { calculateQuality, computeQualityUniverseStats, QualityInput } from "../factors/quality";
import { calculateLowVol, computeLowVolUniverseStats } from "../factors/lowVolatility";
import { computeHRP } from "../risk/hrp";
import { getMasterRegime, MasterRegimeOutput, RegimeHistoryEntry } from "../macro/masterRegime";
import type { CEWSDataPoint } from "../macro/crisisEarlyWarning";
import { calculateKelly } from "../portfolio/kelly";
import { correlationPenalty } from "../portfolio/correlation";
import { computeRiskParityWeights, DEFAULT_SECTOR_BUDGETS } from "../risk/riskBudget";
import { computeVolTargetMultiplier, DEFAULT_TARGET_VOL } from "../risk/volatilityTarget";
import { computeTailRiskOverlay } from "../risk/tailRisk";
import { runBlackLitterman, generateViewsFromEngine, BLView } from "../portfolio/blackLitterman";
import { calibrateExpectedReturn } from "../factors/factorCalibration";
// V4.1 PRO imports
import { computeBTCCycleOverlay, BTCCycleInput } from "../crypto/btcCycleOverlay";
import { computeDCAMultiplier } from "../dca/dcaEngine";

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
  momentumScore: number;
  valueScore: number;
  valuePercentileRank: number;
  qualityScore: number;
  lowVolScore: number;
  expectedReturn: number;
  normalizedExpectedReturn: number;
  kellyFraction: number;
  rawKelly: number;
  isCapped: boolean;
  kellyAllocation: number;
  markowitzAllocation: number;
  riskParityAllocation: number;
  blendedAllocation: number;
  volAdjustedAllocation: number;
  finalAllocation: number;
}

export type PortfolioRegime = "EXPANSION" | "CONTRACTION" | "CRISIS" | "ALL_CASH";

export interface EngineOutput {
  allocations: OlympusOutput[];
  regime: PortfolioRegime;
  masterRegime: MasterRegimeOutput;
  correlationPenalty: number;
  totalAllocation: number;
  volTargetMultiplier: number;
  tailRiskOverlay: number;
  tailRiskActive: boolean;
  tailRiskReason: string;
  // FIX REG-02: exponer versión del motor en cada output para decision_log
  engineVersion: string;
  meta: {
    allCash: boolean;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    dominantSignal: string;
    hasRealCovMatrix: boolean;
  };
  // V4.1 PRO: BTC Cycle + DCA
  btcCycle?: {
    btcScore: number;
    btcNumeric: number;
    signal: 'STRONG_BUY' | 'BUY' | 'ACCUMULATE' | 'HOLD' | 'REDUCE';
    boostActive: boolean;
    breakdown: { mvrvScore: number; puellScore: number; rsiScore: number };
  };
  dca?: {
    investPercent: number;
    investAmount: number;
    frequency: 'weekly' | 'biweekly' | 'monthly';
    boostMultiplier: number;
    effectiveIntensity: number;
  };
  coreSignal: {
    regimeComponent: number;
    btcComponent: number;
    riskComponent: number;
    finalScore: number;
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
    m2Growth: number;
    wtiOil?: number;
  };
  covMatrix?: number[][];
  portfolioDrawdown?: number;
  portfolioRealizedVol?: number;
  targetVol?: number;
  erpValue?: number;
  blViews?: BLView[];
  liquidityGrowth?: number;
  cewsHistory?: CEWSDataPoint[];
  // FIX MATH-NEW-02: pasar historial de régimen para conectar durationAdjustment
  regimeHistory?: RegimeHistoryEntry[];
  adaptiveFactorWeights?: {
    momentum: number;
    value:    number;
    quality:  number;
    lowVol:   number;
  };
  // V4.1 PRO: BTC On-Chain Metrics (manuales o desde API)
  btcOnChain?: {
    mvrvRatio?: number;       // MVRV Z-score o ratio
    puellMultiple?: number;   // Puell Multiple
    rsiWeekly?: number;       // RSI semanal de BTC
  };
  // Capital disponible para DCA
  availableCash?: number;
  totalPortfolioValue?: number;
}

export function runOlympusEngine(input: OlympusEngineInput): EngineOutput {
  const { assets, correlationMatrix, macro } = input;

  const erpRaw = input.erpValue ?? 0.02;
  const erpMultiplier = Math.max(0.85, Math.min(1.10, 1 + erpRaw * 2.5));
  const hasRealCovMatrix = !!(input.covMatrix && input.covMatrix.length > 0);

  // ====== CAPA 0: BTC CYCLE OVERLAY (V4.1 PRO) ======
  // Spec V4.1 PRO: "el edge viene del BTC cycle + DCA contracíclico"
  const btcCycleInput: BTCCycleInput = {
    mvrvRatio: input.btcOnChain?.mvrvRatio,
    puellMultiple: input.btcOnChain?.puellMultiple,
    rsiWeekly: input.btcOnChain?.rsiWeekly,
  };
  const btcCycle = computeBTCCycleOverlay(btcCycleInput);

  // ====== CAPA 1: RÉGIMEN UNIFICADO ======
  // FIX MATH-NEW-02: pasar regimeHistory para que durationAdjustment sea real
  const masterRegime = getMasterRegime(
    {
      vix: macro.vix,
      yieldSpread: macro.yieldSpread,
      creditSpread: macro.creditSpread,
      move: macro.move,
      dxyTrend: macro.dxyTrend,
      btcVol: macro.btcVol,
      m2Growth: macro.m2Growth,
      wtiOil: macro.wtiOil,
    },
    input.cewsHistory,
    input.regimeHistory   // FIX MATH-NEW-02: antes no se pasaba → durationAdjustment ignorado
  );

  const corrPenalty = correlationPenalty(correlationMatrix);

  // ====== CORE SIGNAL (V4.1 PRO) ======
  // Spec: final_score = 0.35*regime + 0.45*btc + 0.20*risk
  // Convertir masterRegime.regimePenalty a regime_numeric [0.2, 1.0]
  const regimeNumeric = masterRegime.regimePenalty;  // ya está en [0.4, 1.0]
  const btcNumeric = btcCycle.btcNumeric;            // [0, 1]
  const riskNumeric = 1 - ((input.portfolioVolatility ?? 0.18) / 0.50);  // vol 18% → 0.64, vol 50% → 0

  const coreSignalScore = 0.35 * regimeNumeric + 0.45 * btcNumeric + 0.20 * Math.max(0, riskNumeric);

  // ====== CAPA 2: FACTOR SCORES ======
  const universeStats = computeUniverseStats(assets as ValueInput[]);
  const qualityStats  = computeQualityUniverseStats(assets as QualityInput[]);
  const lowVolStats   = computeLowVolUniverseStats(assets);

  const rawScores = assets.map((asset) => {
    const momentum = calculateMomentum({
      returns12m: asset.returns12m,
      returns1m:  asset.returns1m,
      returns3m:  asset.returns3m,
    });
    const value   = calculateValue({ earningsYield: asset.earningsYield }, universeStats);
    const quality = calculateQuality(asset as QualityInput, qualityStats);
    const lowVol  = calculateLowVol(asset, lowVolStats);

    const fw = input.adaptiveFactorWeights ?? { momentum: 0.40, value: 0.25, quality: 0.20, lowVol: 0.15 };
    const calibrated = calibrateExpectedReturn({
      momentumScore: momentum.momentumScore,
      valueScore:    value.valueScore,
      qualityScore:  quality.qualityScore,
      lowVolScore:   lowVol.lowVolScore + lowVol.downsideVolPenalty,
    }, fw);

    return { asset, momentum, value, quality, lowVol, rawExpectedReturn: calibrated.expectedReturn, calibrated };
  });

  // ====== CAPA 3: KELLY con retornos anualizados ======
  const kellyAllocations = rawScores.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn, calibrated }) => {
    const kelly = calculateKelly({ expectedReturn: rawExpectedReturn, volatility: asset.volatility });
    const isEquity = asset.earningsYield > 0;
    const erpAdj = isEquity ? erpMultiplier : (erpRaw < -0.005 ? 1.03 : 1.0);
    const kellyAlloc = kelly.kellyFraction * corrPenalty * masterRegime.regimePenalty * erpAdj;
    const normalizedExpectedReturn = rawExpectedReturn;
    return { asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn, calibrated, kelly, kellyAlloc };
  });

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
      totalAllocation: 0, volTargetMultiplier: 0, tailRiskOverlay: 1, tailRiskActive: false,
      tailRiskReason: "", engineVersion: ENGINE_VERSION,
      meta: { allCash: true, confidence: masterRegime.confidence, dominantSignal: masterRegime.dominantSignal, hasRealCovMatrix },
      // V4.1 PRO: BTC Cycle + DCA (incluso en ALL_CASH)
      btcCycle: {
        btcScore: btcCycle.btcScore,
        btcNumeric: btcCycle.btcNumeric,
        signal: btcCycle.signal,
        boostActive: btcCycle.boostActive,
        breakdown: btcCycle.breakdown,
      },
      dca: {
        investPercent: 0,
        investAmount: 0,
        frequency: 'monthly' as const,
        boostMultiplier: 1,
        effectiveIntensity: 0,
      },
      coreSignal: {
        regimeComponent: 0.35 * regimeNumeric,
        btcComponent: 0.45 * btcNumeric,
        riskComponent: 0.20 * Math.max(0, riskNumeric),
        finalScore: coreSignalScore,
      },
    };
  }

  const kellyNorm = kellyAllocations.map(a => ({ ...a, kellyNormalized: a.kellyAlloc / totalKelly }));

  // ====== CAPA 4: HRP ======
  const hrpResult  = computeHRP(hasRealCovMatrix ? input.covMatrix! : [], assets.length);
  const hrpWeights = hrpResult.weights;

  // ====== CAPA 5: BLACK-LITTERMAN (solo con covMatrix real) ======
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
        assetNames:    assets.map(a => a.name),
        covMatrix:     input.covMatrix,
        marketWeights,
        views:         blViews,
        riskAversion:  masterRegime.regime === "CRISIS" ? 4.0 : masterRegime.regime === "CONTRACTION" ? 3.0 : 2.5,
        tau:           0.05,
      });
      blWeights = blResult.posteriorWeights;
    } catch {
      blWeights = assets.map(() => 1 / assets.length);
    }
  }

  // ====== BLEND FINAL: ARQUITECTURA 2-PATH ======
  // FIX V4: aumentado peso HRP de 0.30→0.45 y reducido BL de 0.55→0.40
  // Justificación: walk-forward calificación C con overfitting 58%
  // HRP es más robusto out-of-sample (no necesita predecir retornos)
  // BL depende de covMatrix histórica que cambia en crisis → menos fiable
  const blendWeights = assets.map((_, i) => {
    if (hasRealCovMatrix) {
      const minVarW = minimumVarianceWeights(input.covMatrix!, assets.length);
      return blWeights[i]  * 0.40   // BL: 0.55→0.40 (menos dependencia de covMatrix)
           + hrpWeights[i] * 0.45   // HRP: 0.30→0.45 (más robusto out-of-sample)
           + minVarW[i]    * 0.15;  // MinVar: sin cambio
    } else {
      return kellyNorm[i].kellyNormalized * 0.40  // Kelly: 0.50→0.40
           + hrpWeights[i]               * 0.60; // HRP: 0.50→0.60
    }
  });

  const totalBlend = blendWeights.reduce((s, w) => s + w, 0) || 1;
  const blendNorm  = blendWeights.map(w => w / totalBlend);

  const markowitzWeights = assets.map(() => 1 / assets.length);
  const rpInputs = assets.map(a => ({
    name: a.name,
    volatility: a.volatility,
    riskBudget: DEFAULT_SECTOR_BUDGETS[a.sector ?? ""] ?? 1,
  }));
  const rpResult  = computeRiskParityWeights(rpInputs);
  const rpWeights = assets.map(a => rpResult.find(r => r.name === a.name)?.weight ?? 1 / assets.length);

  // ====== CAPA 6: VOL TARGET ======
  const realizedVol = input.portfolioRealizedVol ?? estimatePortfolioVol(assets, blendNorm, input.covMatrix);
  const volTarget   = computeVolTargetMultiplier({
    targetVol:    input.targetVol ?? DEFAULT_TARGET_VOL,
    realizedVol,
    regimePenalty: masterRegime.regimePenalty,
  });

  // ====== CAPA 7: TAIL RISK OVERLAY ======
  const tailRisk = computeTailRiskOverlay({
    drawdown:    input.portfolioDrawdown ?? 0,
    vix:         macro.vix,
    creditSpread: macro.creditSpread,
    stressScore: masterRegime.stressDetail.score,
    portfolioVolatility: input.portfolioRealizedVol,
  });

  // ====== CAPA 8: DCA CONTRACÍCLICO (V4.1 PRO) ======
  const dca = computeDCAMultiplier({
    regime: masterRegime.regime === 'ALL_CASH' ? 'CRISIS' : masterRegime.regime,
    btcCycle,
  });

  // ====== OUTPUT FINAL ======
  const allocations: OlympusOutput[] = kellyNorm.map(
    ({ asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn, kelly, kellyNormalized }, i) => {
      const blended = blendNorm[i];
      const volAdj  = blended * volTarget.multiplier;
      const final   = volAdj * tailRisk.overlay;

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
    }
  );

  const totalFinal = allocations.reduce((s, a) => s + a.finalAllocation, 0);
  if (totalFinal > 0) {
    allocations.forEach(a => { a.finalAllocation = a.finalAllocation / totalFinal; });
  }

  // V4.1 PRO: Max BTC Weight (70%)
  // Si BTC supera el 70% del portfolio, capar al 70% y redistribuir proporcionalmente
  const btcIndex = allocations.findIndex(a => a.name === 'BTC-EUR' || a.name.includes('BTC'));
  if (btcIndex >= 0) {
    const btcWeight = allocations[btcIndex].finalAllocation;
    const MAX_BTC_WEIGHT = 0.70;  // V4.1 PRO spec

    if (btcWeight > MAX_BTC_WEIGHT) {
      const excess = btcWeight - MAX_BTC_WEIGHT;
      allocations[btcIndex].finalAllocation = MAX_BTC_WEIGHT;

      // Redistribuir el exceso proporcionalmente entre los demás activos
      const otherTotal = allocations.filter((_, i) => i !== btcIndex).reduce((s, a) => s + a.finalAllocation, 0);
      if (otherTotal > 0) {
        allocations.forEach((a, i) => {
          if (i !== btcIndex) {
            a.finalAllocation += excess * (a.finalAllocation / otherTotal);
          }
        });
      }
    }
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
    engineVersion: ENGINE_VERSION,
    meta: {
      allCash: false,
      confidence: masterRegime.confidence,
      dominantSignal: masterRegime.dominantSignal,
      hasRealCovMatrix,
    },
    // V4.1 PRO: BTC Cycle + DCA
    btcCycle: {
      btcScore: btcCycle.btcScore,
      btcNumeric: btcCycle.btcNumeric,
      signal: btcCycle.signal,
      boostActive: btcCycle.boostActive,
      breakdown: btcCycle.breakdown,
    },
    dca: {
      investPercent: dca.effectiveIntensity,
      investAmount: (input.totalPortfolioValue ?? 0) * dca.effectiveIntensity,
      frequency: dca.frequency,
      boostMultiplier: dca.boostMultiplier,
      effectiveIntensity: dca.effectiveIntensity,
    },
    coreSignal: {
      regimeComponent: 0.35 * regimeNumeric,
      btcComponent: 0.45 * btcNumeric,
      riskComponent: 0.20 * Math.max(0, riskNumeric),
      finalScore: coreSignalScore,
    },
  };
}

// ==================== HELPERS INTERNOS ====================

function minimumVarianceWeights(covMatrix: number[][], n: number): number[] {
  const iters = 500;
  let weights = Array(n).fill(1 / n);

  for (let iter = 0; iter < iters; iter++) {
    const grad = Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        grad[i] += 2 * weights[j] * covMatrix[i][j];
      }
    }
    const lr = 0.05 / (1 + iter * 0.01);
    const updated = weights.map((w, i) => Math.max(0.01, w - lr * grad[i]));
    const sum = updated.reduce((a, b) => a + b, 0);
    weights = updated.map(w => w / sum);
  }

  return weights;
}

function estimatePortfolioVol(
  assets: AssetInput[],
  weights: number[],
  covMatrix?: number[][]
): number {
  if (covMatrix && covMatrix.length === assets.length) {
    let portfolioVar = 0;
    for (let i = 0; i < assets.length; i++) {
      for (let j = 0; j < assets.length; j++) {
        portfolioVar += weights[i] * weights[j] * covMatrix[i][j];
      }
    }
    return Math.sqrt(Math.max(0, portfolioVar));
  }
  return assets.reduce((sum, a, i) => sum + weights[i] * a.volatility, 0);
}