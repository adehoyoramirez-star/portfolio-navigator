// ===============================================
// ARCHIVO: src/core/engine/olympusV3.ts
// OLYMPUS ENGINE V5 — Motor Institucional Anti-Frágil
// ===============================================
// CAPAS DE ASIGNACIÓN (en orden de aplicación):
//   0. BTC CYCLE OVERLAY  → MVRV/Puell/RSI → btcNumeric [0,1]
//   1. META-INTELIGENCIA  → confidenceMultiplier [0.70, 1.0] si modelo falla
//   2. RÉGIMEN UNIFICADO  → masterRegime con penalty continuo [0.4, 1.0]
//   3. FACTOR SCORES      → momentum + value + quality + lowVol
//   4. KELLY FRACTION     → half-kelly cap 0.20, modulado por coreSignalScore
//   5. CORRELACIÓN        → penalización si correlación media > 0.5
//   6. BLEND 2-PATH       → BL×0.20 + HRP×0.65 + MinVar×0.15
//   7. VOL TARGET         → reduce exposición total (cash implícito preservado)
//   8. TAIL RISK V5       → kill switch 5 niveles DD 5/10/15/20/25%
//   9. BTC CAP            → máximo 20% sobre el tramo invertido
//  10. META-CONFIDENCE    → ajuste final por salud del modelo
// ===============================================
//
// HISTORIAL DE FIXES (esta versión):
//
// FIX-V5-1 (audit ronda 2): adjustedRegimePenalty — LÓGICA INVERTIDA
//   ANTES: Math.max(regimePenalty, regimePenalty / confidenceMultiplier)
//   Con confidence=0.70: 0.40/0.70=0.571 → penalización MÁS LAXA cuando modelo falla.
//   INTENCIÓN: confianza baja → más conservador (penalización más alta = inversión menor).
//   CORRECCIÓN: regimePenalty × confidenceMultiplier (reduce exposición si modelo degradado).
//
// FIX-V5-2 (audit ronda 2): volTarget y tailRisk CANCELADOS por renormalización
//   ANTES: final = blended × volMultiplier × tailOverlay → /totalFinal → siempre 100% invertido.
//   El kill switch y el vol target eran decorativos: nunca reducían la exposición real.
//   CORRECCIÓN: los pesos relativos se normalizan primero; luego se aplica la exposición
//   total (volMultiplier × tailOverlay) como fracción del portafolio. El resto es cash.
//
// FIX-V5-3 (audit ronda 2): minimumVarianceWeights llamada N veces dentro del map
//   ANTES: blendWeights = assets.map(() => { const minVarW = minimumVarianceWeights(...) })
//   Para N=7: 7 llamadas × 500 iters × 49 ops = 171,500 ops por recálculo.
//   CORRECCIÓN: llamar minimumVarianceWeights UNA vez antes del map (24,500 ops).
//
// FIX-V5-4 (audit ronda 2): computeScenarioProbabilities normalización incoherente
//   ANTES: pNeutral se calculaba usando pBull normalizado pero pBear SIN normalizar.
//   Resultado: probabilidades no sumaban 1.0 limpio antes de la segunda normalización.
//   CORRECCIÓN: normalización en un único paso claro con floor mínimo de 0.05.
//
// FIX-V5-5 (audit ronda 2): totalPortfolioValue ?? 0 → DCA siempre retorna 0
//   Si totalPortfolioValue no se pasa, el default 0 produce investAmount=0 siempre.
//   CORRECCIÓN: warning explícito en output + señal isDataMissing para el dashboard.
//
// FIX-V5-6 (audit ronda 2): REGIME_TACTICAL_ALLOCATIONS — import no usado (dead code)
//   CORRECCIÓN: eliminado de la lista de imports.
// ===============================================

export const ENGINE_VERSION = "v5.1.0";

// ── Imports ─────────────────────────────────────────────────────────────────
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
import { computeDCADecision } from "../dca/dcaEngine";
import { computeMetaIntelligence, loadPredictionHistory } from "../risk/metaIntelligence";
import { FACTOR_CONFIG } from "../config/engineConfig";
// FIX-V5-6: eliminado REGIME_TACTICAL_ALLOCATIONS del import (importado pero nunca usado en este archivo)
import {
  getTacticalWeights,
  applyTacticalConstraints,
  enforceClusterCap,
} from "./regimeTacticalAllocation";

// ── Blend weights (única fuente de verdad) ───────────────────────────────────
const BLEND_WEIGHTS = {
  WITH_COV:    { BL: 0.20, HRP: 0.65, MIN_VAR: 0.15 },
  WITHOUT_COV: { KELLY: 0.25, HRP: 0.75 },
} as const;

// ── Interfaces ───────────────────────────────────────────────────────────────
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
  // FIX-V5-2: ahora refleja la exposición real invertida (< 1.0 cuando tail/vol activos)
  totalInvested: number;
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
    // FIX-V5-5: flag cuando totalPortfolioValue no fue proporcionado
    dcaDataMissing: boolean;
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
  blendWeights?: {
    kelly: number;
    markowitz: number;
    hrp: number;
  };
}

// ── ESCENARIOS PROBABILÍSTICOS ────────────────────────────────────────────────
function computeScenarioProbabilities(
  regimeProbs: { expansion: number; contraction: number; crisis: number },
  btcNumeric: number,
  liquidityGrowth: number
): ScenarioProbabilities {
  let pBull    = regimeProbs.expansion;
  let pNeutral = regimeProbs.contraction;
  let pBear    = regimeProbs.crisis;

  // Ajuste por BTC on-chain
  const btcAdjustment = (btcNumeric - 0.5) * 0.40;
  pBull = Math.max(0.05, Math.min(0.90, pBull + btcAdjustment));
  pBear = Math.max(0.05, Math.min(0.90, pBear - btcAdjustment));

  // Ajuste por liquidez M2
  if (liquidityGrowth < 0) {
    const penalty = Math.min(0.15, Math.abs(liquidityGrowth) / 10);
    pBull = Math.max(0.05, pBull - penalty);
    pBear = Math.min(0.90, pBear + penalty);
  } else if (liquidityGrowth > 5) {
    const boost = Math.min(0.10, (liquidityGrowth - 5) / 20);
    pBull = Math.min(0.90, pBull + boost);
    pBear = Math.max(0.05, pBear - boost);
  }

  // FIX-V5-4: normalización coherente en un único paso.
  // ANTES: pNeutral se calculaba usando pBull ya normalizado pero pBear aún sin normalizar.
  //   → resultado: pBull/total - pBear_original en lugar de pBear/total
  //   → total2 ≠ 1.0 limpio → segunda normalización necesaria para compensar
  // AHORA: normalizar los tres simultáneamente, luego aplicar floor de 0.05 a cada uno,
  //   luego una única renormalización final. Sin mezclar normalizados/no-normalizados.
  const total = pBull + pNeutral + pBear;
  if (total > 0) {
    pBull    /= total;
    pNeutral /= total;
    pBear    /= total;
  }
  // Floor mínimo: ninguna probabilidad puede ser < 5%
  pBull    = Math.max(0.05, pBull);
  pNeutral = Math.max(0.05, pNeutral);
  pBear    = Math.max(0.05, pBear);
  // Normalización final
  const total2 = pBull + pNeutral + pBear;
  pBull    /= total2;
  pNeutral /= total2;
  pBear    /= total2;

  const expectedExposure = pBull * 1.0 + pNeutral * 0.60 + pBear * 0.20;
  return { bull: pBull, neutral: pNeutral, bear: pBear, expectedExposure };
}

// ── MOTOR PRINCIPAL ───────────────────────────────────────────────────────────
export function runOlympusEngine(input: OlympusEngineInput): EngineOutput {
  const { assets, correlationMatrix, macro } = input;

  const erpRaw        = input.erpValue ?? 0.02;
  const erpMultiplier = Math.max(0.85, Math.min(1.10, 1 + erpRaw * 2.5));
  const hasRealCovMatrix = !!(input.covMatrix && input.covMatrix.length > 0);

  // ====== CAPA 0: BTC CYCLE OVERLAY ======
  const btcCycleInput: BTCCycleInput = {
    mvrvRatio:    input.btcOnChain?.mvrvRatio,
    puellMultiple: input.btcOnChain?.puellMultiple,
    rsiWeekly:    input.btcOnChain?.rsiWeekly,
  };
  const btcCycle = computeBTCCycleOverlay(btcCycleInput);

  // ====== CAPA 1: META-INTELIGENCIA ======
  const predictionHistory = loadPredictionHistory();
  const metaIntelligence  = computeMetaIntelligence(predictionHistory);

  // ====== CAPA 2: RÉGIMEN UNIFICADO ======
  const masterRegime = getMasterRegime(
    {
      vix:         macro.vix,
      yieldSpread: macro.yieldSpread,
      creditSpread: macro.creditSpread,
      move:        macro.move,
      dxyTrend:    macro.dxyTrend,
      btcVol:      macro.btcVol,
      m2Growth:    macro.m2Growth,
      wtiOil:      macro.wtiOil,
    },
    input.cewsHistory,
    input.regimeHistory
  );

  // FIX-V5-1: adjustedRegimePenalty — LÓGICA INVERTIDA CORREGIDA.
  // ANTES: Math.max(regimePenalty, regimePenalty / confidenceMultiplier)
  //   Con confidence=0.70 en CRISIS: 0.40/0.70=0.571 → penalty MÁS ALTA (menos reducción).
  //   Cuando el modelo falla, el motor era MÁS agresivo, no más conservador.
  // AHORA: regimePenalty × confidenceMultiplier
  //   confidence=0.70: 0.40×0.70=0.28 → penalty MÁS BAJA (más reducción de exposición).
  //   Modelo degradado → portafolio más conservador. Lógica correcta.
  const adjustedRegimePenalty = masterRegime.regime === 'CRISIS'
    ? masterRegime.regimePenalty * metaIntelligence.confidenceMultiplier
    : masterRegime.regimePenalty;

  const corrPenalty = correlationPenalty(correlationMatrix);

  // ====== CORE SIGNAL ======
  // coreSignalScore modula kellyAlloc directamente (no es decorativo).
  // Combina régimen (45%), BTC on-chain (35%) y vol de portafolio (20%).
  const regimeNumeric  = adjustedRegimePenalty;
  const btcNumeric     = btcCycle.btcNumeric;
  const riskNumeric    = 1 - ((input.portfolioRealizedVol ?? 0.18) / 0.50);
  const coreSignalScore = 0.45 * regimeNumeric
                        + 0.35 * btcNumeric
                        + 0.20 * Math.max(0, riskNumeric);

  // ====== ESCENARIOS PROBABILÍSTICOS ======
  const scenarioProbabilities = computeScenarioProbabilities(
    masterRegime.regimeProbs,
    btcNumeric,
    input.liquidityGrowth ?? 0
  );

  // ====== CAPA 3: FACTOR SCORES ======
  const universeStats  = computeUniverseStats(assets as ValueInput[]);
  const qualityStats   = computeQualityUniverseStats(assets as QualityInput[]);
  const lowVolStats    = computeLowVolUniverseStats(assets);

  const rawScores = assets.map((asset) => {
    const momentum = calculateMomentum({
      returns12m: asset.returns12m,
      returns1m:  asset.returns1m,
      returns3m:  asset.returns3m,
    });
    const value   = calculateValue({ earningsYield: asset.earningsYield }, universeStats);
    const quality = calculateQuality(asset as QualityInput, qualityStats);
    const lowVol  = calculateLowVol(asset, lowVolStats);

    const fw = input.adaptiveFactorWeights ?? FACTOR_CONFIG.DEFAULT_WEIGHTS;
    const calibrated = calibrateExpectedReturn({
      momentumScore: momentum.momentumScore,
      valueScore:    value.valueScore,
      qualityScore:  quality.qualityScore,
      lowVolScore:   lowVol.lowVolScore + lowVol.downsideVolPenalty,
    }, fw);

    return { asset, momentum, value, quality, lowVol, rawExpectedReturn: calibrated.expectedReturn, calibrated };
  });

  // ====== CAPA 4: KELLY ======
  // coreSignalScore integra régimen + BTC on-chain + vol-risk como modulador global.
  const kellyAllocations = rawScores.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn, calibrated }) => {
    const kelly   = calculateKelly({ expectedReturn: rawExpectedReturn, volatility: asset.volatility });
    const isEquity = asset.earningsYield > 0;
    const erpAdj  = isEquity ? erpMultiplier : (erpRaw < -0.005 ? 1.03 : 1.0);
    const kellyAlloc = kelly.kellyFraction * corrPenalty * coreSignalScore * erpAdj;
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
      totalAllocation: 0, totalInvested: 0, volTargetMultiplier: 0, tailRiskOverlay: 1,
      tailRiskActive: false, tailRiskReason: "", engineVersion: ENGINE_VERSION,
      meta: { allCash: true, confidence: masterRegime.confidence, dominantSignal: masterRegime.dominantSignal, hasRealCovMatrix, dcaDataMissing: !input.totalPortfolioValue },
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
  const hrpResult  = computeHRP(hasRealCovMatrix ? input.covMatrix! : [], assets.length);
  const hrpWeights = hrpResult.weights;

  // ====== CAPA 6: BLACK-LITTERMAN ======
  let blWeights: number[] = assets.map(() => 1 / assets.length);
  if (hasRealCovMatrix && input.covMatrix) {
    try {
      const blViews = input.blViews ?? generateViewsFromEngine(
        rawScores.map(s => ({
          name:               s.asset.name,
          ticker:             s.asset.name,
          momentumScore:      s.momentum.momentumScore,
          valuePercentileRank: s.value.percentileRank,
        })),
        masterRegime.regime,
        input.liquidityGrowth ?? 0
      );
      // Prior de mercado: volatilidad inversa (proxy de capitalización).
      // Activos de alta vol (BTC) → menor peso en prior → prior más defensivo.
      const invVols    = assets.map(a => 1 / Math.max(a.volatility, 0.05));
      const invVolSum  = invVols.reduce((s, v) => s + v, 0);
      const marketWeights = invVols.map(v => v / invVolSum);
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

  // ====== BLEND FINAL: BL×0.20 + HRP×0.65 + MinVar×0.15 ======
  // FIX-V5-3: minimumVarianceWeights se llamaba DENTRO del map (N=7 veces).
  // Para n=7: 7 × 500 iters × 49 ops = 171,500 operaciones por recálculo.
  // CORRECCIÓN: llamar UNA SOLA VEZ antes del map → 500 × 49 = 24,500 ops (7× más rápido).
  const minVarW = hasRealCovMatrix
    ? minimumVarianceWeights(input.covMatrix!, assets.length)
    : assets.map(() => 1 / assets.length);

  const blendWeights = assets.map((_, i) => {
    if (hasRealCovMatrix) {
      const weights = input.blendWeights ?? BLEND_WEIGHTS.WITH_COV;
      return blWeights[i]             * (weights.BL ?? weights.kelly ?? 0.20)
           + hrpWeights[i]            * (weights.HRP ?? weights.hrp ?? 0.65)
           + minVarW[i]               * (weights.MIN_VAR ?? weights.markowitz ?? 0.15);
    } else {
      const weights = input.blendWeights ?? BLEND_WEIGHTS.WITHOUT_COV;
      return kellyNorm[i].kellyNormalized * (weights.KELLY ?? weights.kelly ?? 0.25)
           + hrpWeights[i]               * (weights.HRP ?? weights.hrp ?? 0.75);
    }
  });

  const totalBlend = blendWeights.reduce((s, w) => s + w, 0) || 1;
  const blendNorm  = blendWeights.map(w => w / totalBlend);

  // ── CAPA TÁCTICA POR RÉGIMEN ────────────────────────────────────────────────
  const tacticalWeights   = getTacticalWeights(masterRegime.regime, assets);
  const blendedWithTactical = applyTacticalConstraints(
    blendNorm, tacticalWeights, masterRegime.regime, 0.60
  );
  const finalWeightsBeforeCap = enforceClusterCap(
    blendedWithTactical, assets, masterRegime.regime
  );
  const totalFinalWeights  = finalWeightsBeforeCap.reduce((s, w) => s + w, 0) || 1;
  // relativeWeights: pesos relativos normalizados a 1.0 (fracción del tramo invertido)
  const relativeWeights = finalWeightsBeforeCap.map(w => w / totalFinalWeights);

  // ── PESOS DE REFERENCIA ─────────────────────────────────────────────────────
  const markowitzWeights = assets.map(() => 1 / assets.length);
  const rpInputs  = assets.map(a => ({
    name:       a.name,
    volatility: a.volatility,
    riskBudget: DEFAULT_SECTOR_BUDGETS[a.sector ?? ""] ?? 1,
  }));
  const rpResult  = computeRiskParityWeights(rpInputs);
  const rpWeights = assets.map(a => rpResult.find(r => r.name === a.name)?.weight ?? 1 / assets.length);

  // ====== CAPA 7: VOL TARGET ======
  const realizedVol = input.portfolioRealizedVol ?? estimatePortfolioVol(assets, relativeWeights, input.covMatrix);
  const volTarget   = computeVolTargetMultiplier({
    targetVol:     input.targetVol ?? DEFAULT_TARGET_VOL,
    realizedVol,
    regimePenalty: adjustedRegimePenalty,
  });

  // ====== CAPA 8: TAIL RISK ======
  const tailRisk = computeTailRiskOverlay({
    drawdown:           input.portfolioDrawdown ?? 0,
    vix:                macro.vix,
    creditSpread:       macro.creditSpread,
    stressScore:        masterRegime.stressDetail.score,
    portfolioVolatility: input.portfolioRealizedVol,
    avgCorrelation:     input.avgCorrelation,
  });

  // FIX-V5-2: aplicación correcta de vol target y tail risk.
  // ANTES: final = blended × volMultiplier × tailOverlay → luego /totalFinal → ambos cancelados.
  //   El portafolio era 100% invertido siempre. Kill switch = decorativo.
  // AHORA: los pesos relativos (relativeWeights) ya están normalizados a 1.0.
  //   La exposición total (totalInvested) = volTarget × tailRisk, clamped a [0.05, 1.0].
  //   finalAllocation[i] = relativeWeight[i] × totalInvested
  //   La parte no invertida (1 - totalInvested) es cash implícito.
  const totalInvested = Math.max(0.05, Math.min(1.0, volTarget.multiplier * tailRisk.overlay));

  // ── BTC CAP (aplicado sobre pesos relativos, antes de escalar por totalInvested) ──
  // El cap se aplica sobre los pesos relativos para que el rebalanceo sea correcto.
  const relativeWeightsAfterCap = [...relativeWeights];
  const MAX_BTC_WEIGHT_V5 = 0.20;
  const btcIdx = relativeWeightsAfterCap.findIndex(
    (_, i) => {
      const name = assets[i].name.toLowerCase();
      return name.includes('btc') || name.includes('bitcoin');
    }
  );
  if (btcIdx >= 0 && relativeWeightsAfterCap[btcIdx] > MAX_BTC_WEIGHT_V5) {
    const excess    = relativeWeightsAfterCap[btcIdx] - MAX_BTC_WEIGHT_V5;
    relativeWeightsAfterCap[btcIdx] = MAX_BTC_WEIGHT_V5;
    const otherTotal = relativeWeightsAfterCap.reduce((s, w, i) => i !== btcIdx ? s + w : s, 0);
    if (otherTotal > 0) {
      relativeWeightsAfterCap.forEach((_, i) => {
        if (i !== btcIdx) {
          relativeWeightsAfterCap[i] += excess * (relativeWeightsAfterCap[i] / otherTotal);
        }
      });
    }
  }
  // Re-normalizar pesos relativos tras el cap (pueden no sumar 1.0 exacto por redondeo)
  const relCapTotal = relativeWeightsAfterCap.reduce((s, w) => s + w, 0) || 1;
  relativeWeightsAfterCap.forEach((_, i) => {
    relativeWeightsAfterCap[i] /= relCapTotal;
  });

  // ====== CAPA 9: DCA CONTRACÍCLICO ======
  // FIX-V5-5: warning cuando totalPortfolioValue no fue proporcionado.
  const dcaDataMissing = (input.totalPortfolioValue === undefined || input.totalPortfolioValue === null);
  const dcaDecision = computeDCADecision({
    regime:               (masterRegime.regime as PortfolioRegime) === 'ALL_CASH' ? 'CRISIS' : masterRegime.regime as 'EXPANSION' | 'CONTRACTION' | 'CRISIS',
    btcCycle,
    totalPortfolioValue:  input.totalPortfolioValue ?? 0,
    availableCash:        input.availableCash ?? 0,
    portfolioVolatility:  input.portfolioRealizedVol ?? 0.18,
    portfolioDrawdown:    input.portfolioDrawdown ?? 0,
  });
  const dca = {
    investPercent:      dcaDecision.effectiveIntensity,
    investAmount:       dcaDecision.investAmount,
    frequency:          dcaDecision.frequency,
    boostMultiplier:    dcaDecision.boostMultiplier,
    effectiveIntensity: dcaDecision.effectiveIntensity,
  };

  // ====== OUTPUT FINAL ======
  const allocations: OlympusOutput[] = kellyNorm.map(
    ({ asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn, kelly, kellyNormalized }, i) => {
      const relW   = relativeWeightsAfterCap[i];
      const volAdj = relW * volTarget.multiplier;        // para display (antes de tail)
      const final  = relW * totalInvested;               // FIX-V5-2: fracción real del portafolio total

      return {
        name:                     asset.name,
        momentumScore:            momentum.momentumScore,
        valueScore:               value.valueScore,
        valuePercentileRank:      value.percentileRank,
        qualityScore:             quality.qualityScore,
        lowVolScore:              lowVol.lowVolScore,
        expectedReturn:           rawExpectedReturn,
        normalizedExpectedReturn,
        kellyFraction:            kelly.kellyFraction,
        rawKelly:                 kelly.rawKelly,
        isCapped:                 kelly.isCapped,
        kellyAllocation:          kellyNormalized,
        markowitzAllocation:      markowitzWeights[i],
        riskParityAllocation:     rpWeights[i],
        blendedAllocation:        relW,
        volAdjustedAllocation:    volAdj,
        finalAllocation:          final,
      };
    }
  );

  return {
    allocations,
    regime:              masterRegime.regime,
    masterRegime,
    correlationPenalty:  corrPenalty,
    totalAllocation:     allocations.reduce((s, a) => s + a.finalAllocation, 0),
    totalInvested,       // FIX-V5-2: exposición real (< 1.0 cuando tail/vol activos)
    volTargetMultiplier: volTarget.multiplier,
    tailRiskOverlay:     tailRisk.overlay,
    tailRiskActive:      tailRisk.isActive,
    tailRiskReason:      tailRisk.triggerReason,
    engineVersion:       ENGINE_VERSION,
    meta: {
      allCash:         false,
      confidence:      masterRegime.confidence,
      dominantSignal:  masterRegime.dominantSignal,
      hasRealCovMatrix,
      dcaDataMissing,  // FIX-V5-5
    },
    btcCycle: {
      btcScore:   btcCycle.btcScore,
      btcNumeric: btcCycle.btcNumeric,
      signal:     btcCycle.signal,
      boostActive: btcCycle.boostActive,
      breakdown:  btcCycle.breakdown,
    },
    dca,
    coreSignal: {
      regimeComponent: 0.45 * regimeNumeric,
      btcComponent:    0.35 * btcNumeric,
      riskComponent:   0.20 * Math.max(0, riskNumeric),
      finalScore:      coreSignalScore,
    },
    scenarioProbabilities,
    metaIntelligence: {
      modelHealth:            metaIntelligence.modelHealth,
      confidenceMultiplier:   metaIntelligence.confidenceMultiplier,
      consecutiveErrors:      metaIntelligence.consecutiveErrors,
      recommendation:         metaIntelligence.recommendation,
    },
    killSwitchLevel: tailRisk.killSwitchLevel,
    killSwitchName:  tailRisk.killSwitchName,
  };
}

// ── HELPERS INTERNOS ──────────────────────────────────────────────────────────

function minimumVarianceWeights(covMatrix: number[][], n: number): number[] {
  // Guardia: NaN / Inf
  if (covMatrix.some(row => row.some(v => !isFinite(v)))) {
    console.warn('[Olympus] minimumVarianceWeights: covMatrix contiene NaN/Inf → fallback equal weight');
    return Array(n).fill(1 / n);
  }
  if (covMatrix.length !== n || covMatrix.some(row => row.length !== n)) {
    console.warn('[Olympus] minimumVarianceWeights: dimensión n no coincide con covMatrix → fallback');
    return Array(n).fill(1 / n);
  }

  // Gradient descent proyectado (500 iteraciones, convergencia suficiente para n≤10)
  const iters = 500;
  let weights = Array(n).fill(1 / n);
  for (let iter = 0; iter < iters; iter++) {
    const grad = Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        grad[i] += 2 * weights[j] * covMatrix[i][j];
      }
    }
    if (grad.some(g => !isFinite(g))) {
      console.warn('[Olympus] minimumVarianceWeights: gradiente NaN en iteración', iter, '→ fallback');
      return Array(n).fill(1 / n);
    }
    const lr = 0.05 / (1 + iter * 0.01);
    const updated = weights.map((w, i) => Math.max(0.01, w - lr * grad[i]));
    const sum     = updated.reduce((a, b) => a + b, 0);
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