// ===============================================
// ARCHIVO: src/core/engine/olympusX.ts
// OLYMPUS X — Motor de Siguiente Nivel
// ===============================================
// Capa de integración que conecta los upgrades institucionales:
//
//   HMM Regime      → Reemplaza/augmenta el régimen probabilístico estático
//   CVaR Optimizer  → Constraina las allocaciones con tail risk real
//   Kalman Weights  → Pesos de factores adaptativos
//
// FILOSOFÍA DE INTEGRACIÓN:
//   No reemplazamos OlympusV3 — lo AUGMENTAMOS.
//   OlympusV3 sigue siendo el motor base (probado, auditado).
//   OlympusX añade 3 capas sobre el output de V3:
//
//   PIPELINE COMPLETO:
//   [DATA] → [OLYMPUS V3] → [HMM REGIME OVERRIDE] → [CVaR OPTIMIZER] → [OUTPUT]
//                               ↑                         ↑
//                        runHMMRegime()           optimizeCVaR()
//                               ↑
//                    updateKalmanFactorWeights()
//
// DEGRADACIÓN ELEGANTE:
//   Si el HMM no tiene historial suficiente (<4 semanas) → usa V3 regime
//   Si el CVaR optimizer no converge → usa las allocaciones de V3
//   Si Kalman no está calibrado (<12 updates) → usa DEFAULT_WEIGHTS de engineConfig
//
// VERSION BUMP: X.0.0 (sobre V5.0.0)
// ===============================================

import { runOlympusEngine, EngineOutput, OlympusEngineInput } from './olympusV3';
import { runHMMRegime, hmmProbsToRegimePenalty, HMMObservation } from '../macro/hmmRegime';
import {
  optimizeCVaR,
  generateCVaRScenarios,
  computePortfolioCVaR,
  CVaROptimizerOutput,
} from '../risk/cvarOptimizer';
import {
  getCurrentKalmanWeights,
  updateKalmanFactorWeights,
  FactorObservation,
  loadKalmanState,
} from '../factors/kalmanFactorWeights';
import { VOLATILITY_CONFIG } from '../config/engineConfig';

export const OLYMPUS_X_VERSION = 'X.0.0';

// ── INPUT EXTENDIDO ───────────────────────────────────────────────────────────

export interface OlympusXInput extends OlympusEngineInput {
  // Historial de observaciones macro para el HMM (últimas 4-52 semanas)
  // Orden cronológico: [semana_más_antigua, ..., semana_actual]
  macroHistory?: HMMObservation[];

  // Observación de factores de esta semana (para Kalman update)
  factorObservation?: FactorObservation;

  // Target CVaR para el optimizer (default: 0.15 = pérdida máx 15%)
  cvarTarget?: number;

  // Si false, omite el CVaR optimizer (más rápido, mismo behavior que V3)
  useCVarOptimizer?: boolean;

  // Si false, omite el HMM (usa V3 regime detection)
  useHMM?: boolean;

  // Si false, omite el Kalman (usa pesos estáticos)
  useKalman?: boolean;
}

// ── OUTPUT EXTENDIDO ──────────────────────────────────────────────────────────

export interface OlympusXOutput extends EngineOutput {
  engineVersion: string; // override con OLYMPUS_X_VERSION

  // Regime del HMM (si activo)
  hmmRegime?: {
    state: 'EXPANSION' | 'CONTRACTION' | 'CRISIS';
    probabilities: { expansion: number; contraction: number; crisis: number };
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    transitionProbability: number;
    logLikelihood: number;
    overrodeV3Regime: boolean;
  };

  // Output del CVaR optimizer (si activo)
  cvarOptimizer?: {
    active: boolean;
    achievedCVaR: number;
    cvarTarget: number;
    cvarSlack: number;
    isBindingConstraint: boolean;
    converged: boolean;
    cvarContributions: { asset: string; contribution: number }[];
    allocationAdjustmentApplied: boolean;
  };

  // Estado del Kalman (si activo)
  kalmanWeights?: {
    active: boolean;
    weights: { momentum: number; value: number; quality: number; lowVol: number };
    modelHealth: 'CALIBRATED' | 'LEARNING' | 'UNCERTAIN';
    nUpdates: number;
  };

  // Diagnostics comparando X vs V3
  upgradeImpact: {
    regimePenaltyDelta: number;  // cuánto cambió la penalización de régimen
    allocationShiftMax: number;  // máxima diferencia de allocation vs V3
    cvarImprovement: number;     // reducción de CVaR vs portfolio sin optimizer
    activeUpgrades: string[];    // qué upgrades están activos
  };
}

// ── MOTOR PRINCIPAL OLYMPUS X ─────────────────────────────────────────────────

export function runOlympusX(input: OlympusXInput): OlympusXOutput {
  const {
    macroHistory = [],
    factorObservation,
    cvarTarget = 0.15,
    useCVarOptimizer = true,
    useHMM = true,
    useKalman = true,
  } = input;

  const activeUpgrades: string[] = [];

  // ── STEP 1: KALMAN FACTOR WEIGHTS ────────────────────────────────────────
  // Actualizar y obtener pesos adaptativos de factores
  let adaptiveFactorWeights = input.adaptiveFactorWeights;
  let kalmanOutput: OlympusXOutput['kalmanWeights'];

  if (useKalman) {
    if (factorObservation) {
      // Tenemos observación nueva → actualizar Kalman
      const kalmanResult = updateKalmanFactorWeights(factorObservation);
      adaptiveFactorWeights = kalmanResult.weights;
      kalmanOutput = {
        active: true,
        weights: kalmanResult.weights,
        modelHealth: kalmanResult.diagnostics.modelHealth,
        nUpdates: kalmanResult.state.nUpdates,
      };
    } else {
      // Sin observación nueva → solo leer el estado actual
      const currentWeights = getCurrentKalmanWeights();
      const kalmanState = loadKalmanState();
      const nUpdates = kalmanState.nUpdates;

      // Solo usar si tiene al menos 4 semanas de historia
      if (nUpdates >= 4) {
        adaptiveFactorWeights = currentWeights;
        kalmanOutput = {
          active: true,
          weights: currentWeights,
          modelHealth: nUpdates >= 52 ? 'CALIBRATED' : nUpdates >= 12 ? 'LEARNING' : 'UNCERTAIN',
          nUpdates,
        };
      }
    }

    if (kalmanOutput?.active) activeUpgrades.push('KALMAN_WEIGHTS');
  }

  // ── STEP 2: EJECUTAR OLYMPUS V3 (con pesos adaptativos) ──────────────────
  const v3Input: OlympusEngineInput = {
    ...input,
    adaptiveFactorWeights,
  };

  const v3Output = runOlympusEngine(v3Input);
  const v3RegimePenalty = v3Output.masterRegime.regimePenalty;

  // ── STEP 3: HMM REGIME OVERRIDE ──────────────────────────────────────────
  let hmmOutput: OlympusXOutput['hmmRegime'];
  let finalRegimePenalty = v3RegimePenalty;
  let hmmOverrideActive = false;

  if (useHMM && macroHistory.length >= 4) {
    // Construir observación actual para el HMM
    const currentHMMObs: HMMObservation = {
      vix: input.macro.vix,
      yieldSpread: input.macro.yieldSpread,
      creditSpread: input.macro.creditSpread,
      m2Growth: input.macro.m2Growth,
    };

    const hmmResult = runHMMRegime(macroHistory, currentHMMObs, true);
    const hmmPenalty = hmmProbsToRegimePenalty(hmmResult.probabilities);

    // Blending: 60% HMM + 40% V3 (transición gradual)
    // El HMM gana más peso a medida que tiene más historia
    const hmmHistoryWeight = Math.min(0.60, macroHistory.length / 52 * 0.60);
    const v3Weight = 1 - hmmHistoryWeight;
    const blendedPenalty = hmmHistoryWeight * hmmPenalty + v3Weight * v3RegimePenalty;

    finalRegimePenalty = Math.max(0.4, Math.min(1.0, blendedPenalty));

    // El HMM ha "overridden" si la diferencia es significativa (>3%)
    hmmOverrideActive = Math.abs(finalRegimePenalty - v3RegimePenalty) > 0.03;

    hmmOutput = {
      state: hmmResult.state,
      probabilities: hmmResult.probabilities,
      confidence: hmmResult.confidence,
      transitionProbability: hmmResult.transitionProbability,
      logLikelihood: hmmResult.logLikelihood,
      overrodeV3Regime: hmmOverrideActive,
    };

    activeUpgrades.push('HMM_REGIME');
  }

  // Ajustar allocations con el nuevo regime penalty del HMM
  let adjustedAllocations = v3Output.allocations;
  if (hmmOverrideActive && finalRegimePenalty !== v3RegimePenalty) {
    const penaltyRatio = finalRegimePenalty / v3RegimePenalty;
    const rawAdjusted = adjustedAllocations.map(a => ({
      ...a,
      finalAllocation: a.finalAllocation * penaltyRatio,
    }));
    // Renormalizar
    const totalAdjusted = rawAdjusted.reduce((s, a) => s + a.finalAllocation, 0);
    if (totalAdjusted > 0) {
      adjustedAllocations = rawAdjusted.map(a => ({
        ...a,
        finalAllocation: a.finalAllocation / totalAdjusted,
      }));
    }
  }

  // ── STEP 4: CVaR OPTIMIZER ────────────────────────────────────────────────
  let cvarOptimizerOutput: OlympusXOutput['cvarOptimizer'];
  let finalAllocations = adjustedAllocations;
  let cvarImprovement = 0;

  if (useCVarOptimizer && input.covMatrix && input.covMatrix.length > 0) {
    const assetNames = input.assets.map(a => a.name);
    const vols = input.assets.map(a => a.volatility);
    const expectedReturns = adjustedAllocations.map(a => a.expectedReturn);

    // Detectar índice BTC
    const btcIdx = assetNames.findIndex(name =>
      name.toLowerCase().includes('btc') || name.toLowerCase().includes('bitcoin')
    );

    // Generar scenarios Monte Carlo para el CVaR optimizer
    const scenarios = generateCVaRScenarios(
      expectedReturns,
      vols,
      input.covMatrix,
      3000, // 3000 scenarios (balance velocidad/precisión)
      1    // horizonte 1 día
    );

    // CVaR del portfolio actual (sin optimizer) para medir el impacto
    // computePortfolioCVaR es síncrona — no necesita await
    const currentWeights = adjustedAllocations.map(a => a.finalAllocation);
    let baselineCVaR = cvarTarget;
    try {
      const { cvar } = computePortfolioCVaR(currentWeights, scenarios, 0.95);
      baselineCVaR = cvar;
    } catch { /* fallback al target si hay error */ }

    // Ejecutar el optimizer solo si el CVaR actual excede el target
    const cvarResult = baselineCVaR > cvarTarget
      ? optimizeCVaR({
          assetNames,
          scenarios,
          expectedReturns,
          cvarTarget,
          alpha: 0.95,
          minWeight: 0.01,
          maxWeight: 0.40,
          maxBtcWeight: 0.25,
          btcAssetIndex: btcIdx,
          maxIterations: 300,
        })
      : null;

    if (cvarResult && cvarResult.converged && baselineCVaR > cvarTarget) {
      // Aplicar los pesos del optimizer
      finalAllocations = adjustedAllocations.map((a, i) => ({
        ...a,
        finalAllocation: cvarResult.weights[i],
      }));

      cvarImprovement = baselineCVaR - cvarResult.achievedCVaR;
      activeUpgrades.push('CVAR_OPTIMIZER');

      cvarOptimizerOutput = {
        active: true,
        achievedCVaR: cvarResult.achievedCVaR,
        cvarTarget,
        cvarSlack: cvarResult.cvarSlack,
        isBindingConstraint: cvarResult.isBindingConstraint,
        converged: cvarResult.converged,
        cvarContributions: assetNames.map((name, i) => ({
          asset: name,
          contribution: cvarResult.cvarContributions[i],
        })),
        allocationAdjustmentApplied: true,
      };
    } else {
      cvarOptimizerOutput = {
        active: true,
        achievedCVaR: baselineCVaR,
        cvarTarget,
        cvarSlack: cvarTarget - baselineCVaR,
        isBindingConstraint: false,
        converged: true,
        cvarContributions: assetNames.map((name, _) => ({ asset: name, contribution: 0 })),
        allocationAdjustmentApplied: false,
      };
    }
  }

  // ── STEP 5: CALCULAR IMPACT METRICS ──────────────────────────────────────
  const regimePenaltyDelta = finalRegimePenalty - v3RegimePenalty;
  const maxAllocationShift = v3Output.allocations.reduce((maxDiff, v3a, i) => {
    const xAlloc = finalAllocations[i]?.finalAllocation ?? v3a.finalAllocation;
    return Math.max(maxDiff, Math.abs(xAlloc - v3a.finalAllocation));
  }, 0);

  // ── OUTPUT FINAL ──────────────────────────────────────────────────────────
  const xOutput: OlympusXOutput = {
    ...v3Output,
    allocations: finalAllocations,
    engineVersion: OLYMPUS_X_VERSION,
    hmmRegime: hmmOutput,
    cvarOptimizer: cvarOptimizerOutput,
    kalmanWeights: kalmanOutput,
    upgradeImpact: {
      regimePenaltyDelta,
      allocationShiftMax: maxAllocationShift,
      cvarImprovement,
      activeUpgrades,
    },
  };

  return xOutput;
}

/**
 * Versión sincrónica de OlympusX (sin CVaR optimizer async).
 * Para usar en contextos donde no se puede usar async/await.
 */
export function runOlympusXSync(input: OlympusXInput): OlympusXOutput {
  return runOlympusX({ ...input, useCVarOptimizer: false });
}
