// ===============================================
// ARCHIVO: src/core/engine/olympusV3.ts
// OLYMPUS ENGINE V5 — Motor Institucional Anti-Frágil
// ===============================================
// CAPAS DE ASIGNACIÓN (en orden de aplicación):
//   0. BTC CYCLE OVERLAY  → MVRV/Puell/RSI → btcNumeric [0,1]
//   1. META-INTELIGENCIA  → confidenceMultiplier [0.70, 1.0] si modelo falla
//   2. RÉGIMEN UNIFICADO  → masterRegime con penalty continuo [0.4, 1.0]
//   3. FACTOR SCORES      → momentum + value + quality + lowVol
//   4. KELLY FRACTION     → half-kelly cap 0.20
//   5. CORRELACIÓN        → penalización si correlación media > 0.5
//   6. BLEND 2-PATH       → BL×0.40 + HRP×0.45 + MinVar×0.15
//   7. VOL TARGET         → escalar a vol objetivo 18%
//   8. TAIL RISK V5       → kill switch 5 niveles DD 5/10/15/20/25%
//   9. BTC CAP            → máximo 20% (no 70% de V4.1)
//  10. META-CONFIDENCE    → ajuste final por salud del modelo
// ===============================================

export const ENGINE_VERSION = "v5.0.0";

// ── Imports (todos al inicio) ─────────────────────────────────────────────
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
import { computeBTCCycleOverlay, BTCCycleInput } from "../crypto/btcCycleOverlay";
import { computeDCADecision } from "../dca/dcaEngine";  // ✅ CORREGIDO: import al inicio
import { computeMetaIntelligence, loadPredictionHistory } from "../risk/metaIntelligence";
// FIX-CRÍTICO-2: ÚNICA fuente de verdad para pesos de factores.
// Antes: triple hardcode en engineConfig.ts, factorCalibration.ts, y aquí.
// Ahora: todos importan de engineConfig → un solo punto de cambio.
import { FACTOR_CONFIG } from "../config/engineConfig";
import {
  getTacticalWeights,
  applyTacticalConstraints,
  enforceClusterCap,
  REGIME_TACTICAL_ALLOCATIONS,
} from "./regimeTacticalAllocation";


// ==================== INTERFACES ====================
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

export interface ScenarioProbabilities {
  bull: number;
  neutral: number;
  bear: number;
  expectedExposure: number;
}

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
  engineVersion: string;
  meta: {
    allCash: boolean;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    dominantSignal: string;
    hasRealCovMatrix: boolean;
  };
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
  scenarioProbabilities: ScenarioProbabilities;
  metaIntelligence: {
    modelHealth: 'RELIABLE' | 'DEGRADED' | 'UNRELIABLE';
    confidenceMultiplier: number;
    consecutiveErrors: number;
    recommendation: string;
  };
  killSwitchLevel: 0 | 1 | 2 | 3 | 4 | 5;
  killSwitchName: string;
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
  regimeHistory?: RegimeHistoryEntry[];
  adaptiveFactorWeights?: {
    momentum: number;
    value: number;
    quality: number;
    lowVol: number;
  };
  btcOnChain?: {
    mvrvRatio?: number;
    puellMultiple?: number;
    rsiWeekly?: number;
  };
  availableCash?: number;
  totalPortfolioValue?: number;
  avgCorrelation?: number;
}

// ── ESCENARIOS PROBABILÍSTICOS V5 ─────────────────────────────────────────
function computeScenarioProbabilities(
  regimeProbs: { expansion: number; contraction: number; crisis: number },
  btcNumeric: number,
  liquidityGrowth: number
): ScenarioProbabilities {
  let pBull = regimeProbs.expansion;
  let pNeutral = regimeProbs.contraction;
  let pBear = regimeProbs.crisis;

  const btcAdjustment = (btcNumeric - 0.5) * 0.40;
  pBull = Math.max(0.05, Math.min(0.90, pBull + btcAdjustment));
  pBear = Math.max(0.05, Math.min(0.90, pBear - btcAdjustment));

  if (liquidityGrowth < 0) {
    const liquidityPenalty = Math.min(0.15, Math.abs(liquidityGrowth) / 10);
    pBull = Math.max(0.05, pBull - liquidityPenalty);
    pBear = Math.min(0.90, pBear + liquidityPenalty);
  } else if (liquidityGrowth > 5) {
    const liquidityBoost = Math.min(0.10, (liquidityGrowth - 5) / 20);
    pBull = Math.min(0.90, pBull + liquidityBoost);
    pBear = Math.max(0.05, pBear - liquidityBoost);
  }

  const total = pBull + pNeutral + pBear;
  pBull /= total;
  pNeutral = Math.max(0.05, 1 - pBull - pBear);
  pBear /= total;
  const total2 = pBull + pNeutral + pBear;
  pBull /= total2;
  pNeutral /= total2;
  pBear /= total2;

  const expectedExposure = pBull * 1.0 + pNeutral * 0.60 + pBear * 0.20;
  return { bull: pBull, neutral: pNeutral, bear: pBear, expectedExposure };
}

// ── MOTOR PRINCIPAL ───────────────────────────────────────────────────────
export function runOlympusEngine(input: OlympusEngineInput): EngineOutput {
  const { assets, correlationMatrix, macro } = input;

  const erpRaw = input.erpValue ?? 0.02;
  const erpMultiplier = Math.max(0.85, Math.min(1.10, 1 + erpRaw * 2.5));
  const hasRealCovMatrix = !!(input.covMatrix && input.covMatrix.length > 0);

  // ====== CAPA 0: BTC CYCLE OVERLAY ======
  const btcCycleInput: BTCCycleInput = {
    mvrvRatio: input.btcOnChain?.mvrvRatio,
    puellMultiple: input.btcOnChain?.puellMultiple,
    rsiWeekly: input.btcOnChain?.rsiWeekly,
  };
  const btcCycle = computeBTCCycleOverlay(btcCycleInput);

  // ====== CAPA 1: META-INTELIGENCIA ======
  const predictionHistory = loadPredictionHistory();
  const metaIntelligence = computeMetaIntelligence(predictionHistory);

  // ====== CAPA 2: RÉGIMEN UNIFICADO ======
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
    input.regimeHistory
  );

  const adjustedRegimePenalty = masterRegime.regime === 'CRISIS'
    ? Math.max(masterRegime.regimePenalty, masterRegime.regimePenalty / metaIntelligence.confidenceMultiplier)
    : masterRegime.regimePenalty;

  const corrPenalty = correlationPenalty(correlationMatrix);

  // ====== CORE SIGNAL ======
  const regimeNumeric = adjustedRegimePenalty;
  const btcNumeric = btcCycle.btcNumeric;
  const riskNumeric = 1 - ((input.portfolioRealizedVol ?? 0.18) / 0.50);
  // FIX-IMP-6: rebalancear pesos coreSignal.
  // PROBLEMA ANTERIOR: 0.45×btcNumeric + 0.35×regimeNumeric
  //   BTC on-chain dominaba más que el régimen macro global.
  //   En 2023: BTC bear + equity global en rally → el motor infraexponía equity innecesariamente.
  // CORRECCIÓN: régimen macro es el driver primario, BTC es señal secundaria proporcional a su cap (20%).
  //   0.45 × regimeNumeric  ← macro global es el sistema nervioso del portfolio
  //   0.35 × btcNumeric     ← BTC on-chain relevante pero no dominante
  //   0.20 × riskNumeric    ← vol del portfolio: sin cambio
  const coreSignalScore = 0.45 * regimeNumeric + 0.35 * btcNumeric + 0.20 * Math.max(0, riskNumeric);

  // ====== ESCENARIOS PROBABILÍSTICOS ======
  const scenarioProbabilities = computeScenarioProbabilities(
    masterRegime.regimeProbs,
    btcNumeric,
    input.liquidityGrowth ?? 0
  );

  // ====== CAPA 3: FACTOR SCORES ======
  const universeStats = computeUniverseStats(assets as ValueInput[]);
  const qualityStats = computeQualityUniverseStats(assets as QualityInput[]);
  const lowVolStats = computeLowVolUniverseStats(assets);

  const rawScores = assets.map((asset) => {
    const momentum = calculateMomentum({
      returns12m: asset.returns12m,
      returns1m: asset.returns1m,
      returns3m: asset.returns3m,
    });
    const value = calculateValue({ earningsYield: asset.earningsYield }, universeStats);
    const quality = calculateQuality(asset as QualityInput, qualityStats);
    const lowVol = calculateLowVol(asset, lowVolStats);

    // FIX-CRÍTICO-2: usar FACTOR_CONFIG.DEFAULT_WEIGHTS como fuente única.
    // Antes era { momentum: 0.40, value: 0.25, quality: 0.20, lowVol: 0.15 } hardcodeado.
    // Ahora cualquier cambio en engineConfig.ts se propaga automáticamente.
    const fw = input.adaptiveFactorWeights ?? FACTOR_CONFIG.DEFAULT_WEIGHTS;
    const calibrated = calibrateExpectedReturn({
      momentumScore: momentum.momentumScore,
      valueScore: value.valueScore,
      qualityScore: quality.qualityScore,
      lowVolScore: lowVol.lowVolScore + lowVol.downsideVolPenalty,
    }, fw);

    return { asset, momentum, value, quality, lowVol, rawExpectedReturn: calibrated.expectedReturn, calibrated };
  });

  // ====== CAPA 4: KELLY ======
  const kellyAllocations = rawScores.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn, calibrated }) => {
    const kelly = calculateKelly({ expectedReturn: rawExpectedReturn, volatility: asset.volatility });
    const isEquity = asset.earningsYield > 0;
    const erpAdj = isEquity ? erpMultiplier : (erpRaw < -0.005 ? 1.03 : 1.0);
    const kellyAlloc = kelly.kellyFraction * corrPenalty * adjustedRegimePenalty * erpAdj;
    return { asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn: rawExpectedReturn, calibrated, kelly, kellyAlloc };
  });

  const totalKelly = kellyAllocations.reduce((s, a) => s + a.kellyAlloc, 0);
  if (totalKelly === 0) {
    const empty = kellyAllocations.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn, kelly }) => ({
      name: asset.name, momentumScore: momentum.momentumScore, valueScore: value.valueScore,
      valuePercentileRank: value.percentileRank, qualityScore: quality.qualityScore,
      lowVolScore: lowVol.lowVolScore, expectedReturn: rawExpectedReturn,
      normalizedExpectedReturn: rawExpectedReturn, kellyFraction: kelly.kellyFraction, rawKelly: kelly.rawKelly,
      isCapped: kelly.isCapped, kellyAllocation: 0, markowitzAllocation: 0,
      riskParityAllocation: 0, blendedAllocation: 0, volAdjustedAllocation: 0, finalAllocation: 0,
    }));
    return {
      allocations: empty, regime: "ALL_CASH", masterRegime, correlationPenalty: corrPenalty,
      totalAllocation: 0, volTargetMultiplier: 0, tailRiskOverlay: 1, tailRiskActive: false,
      tailRiskReason: "", engineVersion: ENGINE_VERSION,
      meta: { allCash: true, confidence: masterRegime.confidence, dominantSignal: masterRegime.dominantSignal, hasRealCovMatrix },
      btcCycle: { btcScore: btcCycle.btcScore, btcNumeric: btcCycle.btcNumeric, signal: btcCycle.signal, boostActive: btcCycle.boostActive, breakdown: btcCycle.breakdown },
      dca: { investPercent: 0, investAmount: 0, frequency: 'monthly', boostMultiplier: 1, effectiveIntensity: 0 },
      coreSignal: { regimeComponent: 0.45 * regimeNumeric, btcComponent: 0.35 * btcNumeric, riskComponent: 0.20 * Math.max(0, riskNumeric), finalScore: coreSignalScore },
      scenarioProbabilities,
      metaIntelligence: { modelHealth: metaIntelligence.modelHealth, confidenceMultiplier: metaIntelligence.confidenceMultiplier, consecutiveErrors: metaIntelligence.consecutiveErrors, recommendation: metaIntelligence.recommendation },
      killSwitchLevel: 0, killSwitchName: 'SIN TRIGGER',
    };
  }

  const kellyNorm = kellyAllocations.map(a => ({ ...a, kellyNormalized: a.kellyAlloc / totalKelly }));

  // ====== CAPA 5: HRP ======
  const hrpResult = computeHRP(hasRealCovMatrix ? input.covMatrix! : [], assets.length);
  const hrpWeights = hrpResult.weights;

  // ====== CAPA 6: BLACK-LITTERMAN ======
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
        riskAversion: masterRegime.regime === "CRISIS" ? 4.0 : masterRegime.regime === "CONTRACTION" ? 3.0 : 2.5,
        tau: 0.05,
      });
      blWeights = blResult.posteriorWeights;
    } catch {
      blWeights = assets.map(() => 1 / assets.length);
    }
  }

    // ====== BLEND FINAL: BL×0.40 + HRP×0.45 + MinVar×0.15 ======
  const blendWeights = assets.map((_, i) => {
    if (hasRealCovMatrix) {
      const minVarW = minimumVarianceWeights(input.covMatrix!, assets.length);
      return blWeights[i] * 0.40 + hrpWeights[i] * 0.45 + minVarW[i] * 0.15;
    } else {
      return kellyNorm[i].kellyNormalized * 0.40 + hrpWeights[i] * 0.60;
    }
  });

  const totalBlend = blendWeights.reduce((s, w) => s + w, 0) || 1;
  const blendNorm = blendWeights.map(w => w / totalBlend);

  // ── CAPA TÁCTICA POR RÉGIMEN (NUEVO) ─────────────────────────────────
  const tacticalWeights = getTacticalWeights(masterRegime.regime, assets);
  const blendedWithTactical = applyTacticalConstraints(
    blendNorm,
    tacticalWeights,
    masterRegime.regime,
    0.60
  );
  const finalWeightsBeforeCap = enforceClusterCap(
    blendedWithTactical,
    assets,
    masterRegime.regime
  );
  const totalFinalWeights = finalWeightsBeforeCap.reduce((s, w) => s + w, 0) || 1;
  const finalBlendNorm = finalWeightsBeforeCap.map(w => w / totalFinalWeights);
  console.log('TACTICAL FINAL WEIGHTS', finalBlendNorm);

  // ── PESOS DE REFERENCIA (Markowitz y Risk Parity) ────────────────────
  const markowitzWeights = assets.map(() => 1 / assets.length);
  const rpInputs = assets.map(a => ({
    name: a.name,
    volatility: a.volatility,
    riskBudget: DEFAULT_SECTOR_BUDGETS[a.sector ?? ""] ?? 1,
  }));
  const rpResult = computeRiskParityWeights(rpInputs);
  const rpWeights = assets.map(a => rpResult.find(r => r.name === a.name)?.weight ?? 1 / assets.length);

  // ====== CAPA 7: VOL TARGET ======
  const realizedVol = input.portfolioRealizedVol ?? estimatePortfolioVol(assets, finalBlendNorm, input.covMatrix);
  const volTarget = computeVolTargetMultiplier({
    targetVol: input.targetVol ?? DEFAULT_TARGET_VOL,
    realizedVol,
    regimePenalty: adjustedRegimePenalty,
  });
  // ====== .CAPA 7: VOL TARGET ======
  // CORREGIDO: usamos finalBlendNorm para que el cálculo de volatilidad
  // refleje la composición real de la cartera tras los cambios tácticos.
  
  // ====== CAPA 8: TAIL RISK ======
  const tailRisk = computeTailRiskOverlay({
    drawdown: input.portfolioDrawdown ?? 0,
    vix: macro.vix,
    creditSpread: macro.creditSpread,
    stressScore: masterRegime.stressDetail.score,
    portfolioVolatility: input.portfolioRealizedVol,
    avgCorrelation: input.avgCorrelation,
  });

  // ====== CAPA 9: DCA CONTRACÍCLICO (CORREGIDO) ======
  const dcaDecision = computeDCADecision({
    regime: (masterRegime.regime as PortfolioRegime) === 'ALL_CASH' ? 'CRISIS' : masterRegime.regime,
    btcCycle,
    totalPortfolioValue: input.totalPortfolioValue ?? 0,
    availableCash: input.availableCash ?? 0,
    portfolioVolatility: input.portfolioRealizedVol ?? 0.18,
  });
  const dca = {
    investPercent: dcaDecision.effectiveIntensity,
    investAmount: dcaDecision.investAmount,
    frequency: dcaDecision.frequency,
    boostMultiplier: dcaDecision.boostMultiplier,
    effectiveIntensity: dcaDecision.effectiveIntensity,
  };

  // ====== OUTPUT FINAL ======
  const allocations: OlympusOutput[] = kellyNorm.map(
    ({ asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn, kelly, kellyNormalized }, i) => {
      const blended = finalBlendNorm[i];
      const volAdj = blended * volTarget.multiplier;
      const final = volAdj * tailRisk.overlay;

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

  // ====== CAPA 10: BTC CAP INSTITUCIONAL ======
  const MAX_BTC_WEIGHT_V5 = 0.20;
  const btcIdx = allocations.findIndex(a => a.name === 'BTC-EUR' || a.name.toLowerCase().includes('bitcoin') || a.name.toLowerCase().includes('btc'));
  if (btcIdx >= 0 && allocations[btcIdx].finalAllocation > MAX_BTC_WEIGHT_V5) {
    const excess = allocations[btcIdx].finalAllocation - MAX_BTC_WEIGHT_V5;
    allocations[btcIdx].finalAllocation = MAX_BTC_WEIGHT_V5;
    const otherTotal = allocations.filter((_, i) => i !== btcIdx).reduce((s, a) => s + a.finalAllocation, 0);
    if (otherTotal > 0) {
      allocations.forEach((a, i) => {
        if (i !== btcIdx) a.finalAllocation += excess * (a.finalAllocation / otherTotal);
      });
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
    btcCycle: {
      btcScore: btcCycle.btcScore,
      btcNumeric: btcCycle.btcNumeric,
      signal: btcCycle.signal,
      boostActive: btcCycle.boostActive,
      breakdown: btcCycle.breakdown,
    },
    dca,
    coreSignal: {
      regimeComponent: 0.45 * regimeNumeric,
      btcComponent: 0.35 * btcNumeric,
      riskComponent: 0.20 * Math.max(0, riskNumeric),
      finalScore: coreSignalScore,
    },
    scenarioProbabilities,
    metaIntelligence: {
      modelHealth: metaIntelligence.modelHealth,
      confidenceMultiplier: metaIntelligence.confidenceMultiplier,
      consecutiveErrors: metaIntelligence.consecutiveErrors,
      recommendation: metaIntelligence.recommendation,
    },
    killSwitchLevel: tailRisk.killSwitchLevel,
    killSwitchName: tailRisk.killSwitchName,
  };
}

// ==================== HELPERS INTERNOS ====================
function minimumVarianceWeights(covMatrix: number[][], n: number): number[] {
  // ── FIX NaN: validar covMatrix antes de cualquier operación ──────────────
  // Si covMatrix contiene NaN o Inf (ej: activo con datos insuficientes que
  // no fue protegido por el shrinkage adaptativo), la optimización producirá
  // grad[i]=NaN → weights=NaN → blendNorm=NaN → finalAllocation=NaN en cascade.
  // Fallback: igual weight es mejor que NaN — el motor puede continuar.
  const hasInvalidValues = covMatrix.some(row => row.some(v => !isFinite(v)));
  if (hasInvalidValues) {
    console.warn('[Olympus] minimumVarianceWeights: covMatrix contiene NaN/Inf → fallback equal weight');
    return Array(n).fill(1 / n);
  }

  // ── FIX NaN: si n no coincide con la dimensión de la matriz ─────────────
  if (covMatrix.length !== n || covMatrix.some(row => row.length !== n)) {
    console.warn('[Olympus] minimumVarianceWeights: dimensión n no coincide con covMatrix → fallback');
    return Array(n).fill(1 / n);
  }

  const iters = 500;
  let weights = Array(n).fill(1 / n);
  for (let iter = 0; iter < iters; iter++) {
    const grad = Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        grad[i] += 2 * weights[j] * covMatrix[i][j];
      }
    }

    // ── .FIX NaN: proteger contra grad con NaN (si covMatrix es mala a pesar del guard) ──
    if (grad.some(g => !isFinite(g))) {
      console.warn('[Olympus] minimumVarianceWeights: gradiente NaN en iteración', iter, '→ fallback');
      return Array(n).fill(1 / n);
    }

    const lr = 0.05 / (1 + iter * 0.01);
    const updated = weights.map((w, i) => Math.max(0.01, w - lr * grad[i]));
    const sum = updated.reduce((a, b) => a + b, 0);
    if (sum <= 0 || !isFinite(sum)) return Array(n).fill(1 / n);
    weights = updated.map(w => w / sum);
  }
  return weights;
}

function estimatePortfolioVol(assets: AssetInput[], weights: number[], covMatrix?: number[][]): number {
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