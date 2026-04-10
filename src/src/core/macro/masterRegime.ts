// ===============================================
// ARCHIVO: src/core/macro/masterRegime.ts
// NIVEL 2: penalización continua vía regimeProbabilistic
// ===============================================
// FIX MATH-NEW-02: regimeDuration.durationAdjustment ahora se aplica
//   a la penalización final del motor.
//
//   ANTES: computeRegimeDuration() se calculaba pero masterRegime.ts
//     no lo importaba ni lo usaba en ninguna línea. El ajuste ±0.10
//     aparecía en el dashboard visualmente pero no afectaba ninguna
//     allocación real. Una crisis de 6 meses y una de 1 semana
//     producían exactamente las mismas allocations — INCORRECTO.
//
//   AHORA: durationAdjustment se aplica sobre finalPenalty antes de
//     los caps/floors:
//       finalPenalty = clamp(finalPenalty + durationAdjustment, 0.4, 1.0)
//
//   Ejemplos con el fix:
//     - Crisis YOUNG (1 semana):  durationAdjustment = -0.10 → más conservador
//     - Crisis MATURE (3 meses):  durationAdjustment = -0.05 → conservador normal
//     - Crisis OLD (>6 meses):    durationAdjustment = +0.08 → preparar ataque
//     - Expansion YOUNG (1 mes):  durationAdjustment = +0.05 → más agresivo
// ===============================================

import { detectCrisis, CrisisResult } from "./crisis";
import { computeGlobalStress, StressResult, StressRegime } from "./globalStress";
import {
  detectRegimeProbabilistic,
  continuousRegimePenalty,
  dominantRegime,
  RegimeProbabilities,
} from "./regimeProbabilistic";
import { computeCEWS, CEWSDataPoint } from "./crisisEarlyWarning";
// FIX MATH-NEW-02: importar computeRegimeDuration y detectRegimeStartDate
import {
  computeRegimeDuration,
  detectRegimeStartDate,
  RegimeDurationOutput,
} from "./regimeDuration";

export type MasterRegimeLabel = "EXPANSION" | "CONTRACTION" | "CRISIS";

export interface MasterRegimeInput {
  vix: number;
  yieldSpread: number;
  creditSpread: number;
  move: number;
  dxyTrend: number;
  btcVol: number;
  m2Growth: number;
  wtiOil?: number;
}

// FIX MATH-NEW-02: el output ahora expone regimeDuration para el dashboard
export interface MasterRegimeOutput {
  regime: MasterRegimeLabel;
  regimePenalty: number;            // continuo [0.4, 1.0]
  crisisDetail: CrisisResult;
  stressDetail: StressResult;
  regimeProbs: RegimeProbabilities;
  dominantSignal: "CRISIS_MODEL" | "STRESS_MODEL" | "PROBABILISTIC" | "CONSENSUS";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  cews?: import("./crisisEarlyWarning").CEWSOutput;
  // FIX MATH-NEW-02: ahora conectado y activo en el cálculo
  regimeDuration?: RegimeDurationOutput;
}

export interface RegimeHistoryEntry {
  timestamp: string;
  regime: string;
}

export function getMasterRegime(
  input: MasterRegimeInput,
  cewsHistory?: CEWSDataPoint[],
  // FIX MATH-NEW-02: añadir parámetro regimeHistory para computar duración
  regimeHistory?: RegimeHistoryEntry[]
): MasterRegimeOutput {
  const crisis = detectCrisis(input.vix, input.yieldSpread, input.creditSpread);
  const stress = computeGlobalStress({
    vix: input.vix,
    creditSpread: input.creditSpread,
    move: input.move,
    dxyTrend: input.dxyTrend,
    btcVol: input.btcVol,
    wtiOil: input.wtiOil,
  });
  const regimeProbs = detectRegimeProbabilistic(input.vix, input.yieldSpread, input.m2Growth);

  const crisisLabel = crisis.regime;
  const stressLabel = mapStressToMacro(stress.regime);
  const probLabel   = dominantRegime(regimeProbs);

  // El más conservador de los tres modelos gana
  const regime = [crisisLabel, stressLabel, probLabel].reduce(resolveRegime);

  // NIVEL 2: blend 40% binario + 60% continuo → elimina escalones bruscos
  const binaryPenalty     = getBinaryPenalty(regime);
  const continuousPenalty = continuousRegimePenalty(regimeProbs);
  const regimePenalty     = Math.max(0.4, Math.min(1.0, 0.4 * binaryPenalty + 0.6 * continuousPenalty));

  const dominantSignal = getDominantSignal(crisisLabel, stressLabel, probLabel, regime);
  const confidence     = getConfidence(crisisLabel, stressLabel, probLabel);

  // CEWS: ajustar penalización si hay historial
  let finalPenalty = regimePenalty;
  let cews: import("./crisisEarlyWarning").CEWSOutput | undefined;
  if (cewsHistory && cewsHistory.length >= 2) {
    cews = computeCEWS(cewsHistory);
    finalPenalty = Math.max(0.4, Math.min(1.0, regimePenalty + cews.regimePenaltyAdjustment));
  }

  // FIX MATH-NEW-02: aplicar durationAdjustment al motor (era solo visual)
  // La madurez del régimen ajusta la penalización: una crisis de 6 meses
  // estadísticamente está cerca del fondo → reducir penalización para preparar ataque.
  let regimeDuration: RegimeDurationOutput | undefined;
  if (regimeHistory !== undefined) {
    const regimeStartDate = detectRegimeStartDate(regimeHistory, regime);
    regimeDuration = computeRegimeDuration({
      currentRegime: regime,
      regimeStartDate,
    });
    // Aplicar durationAdjustment sobre finalPenalty antes de los caps/floors
    finalPenalty = Math.max(0.4, Math.min(1.0,
      finalPenalty + regimeDuration.durationAdjustment
    ));
  }

  // WTI OIL: penalización geopolítica multiplicativa
  if (stress.wtiPenalty < 1.0) {
    finalPenalty = Math.max(0.4, finalPenalty * stress.wtiPenalty);
  }

  // En CRISIS el cap es 0.55 — nunca demasiado laxo aunque la crisis sea vieja
  // (el +0.08 de durationAdjustment puede llevarnos a 0.53, que es correcto)
  if (regime === "CRISIS") {
    finalPenalty = Math.min(finalPenalty, 0.55);
  }

  return {
    regime,
    regimePenalty: finalPenalty,
    crisisDetail: crisis,
    stressDetail: stress,
    regimeProbs,
    dominantSignal,
    confidence,
    cews,
    regimeDuration, // FIX MATH-NEW-02: ahora disponible en output Y activo en cálculo
  };
}

// ==================== HELPERS ====================
function mapStressToMacro(stress: StressRegime): MasterRegimeLabel {
  if (stress === "CRISIS")    return "CRISIS";
  if (stress === "HIGH_RISK") return "CONTRACTION";
  return "EXPANSION";
}

const PRIO: Record<MasterRegimeLabel, number> = { EXPANSION: 0, CONTRACTION: 1, CRISIS: 2 };

function resolveRegime(a: MasterRegimeLabel, b: MasterRegimeLabel): MasterRegimeLabel {
  return PRIO[a] >= PRIO[b] ? a : b;
}

function getBinaryPenalty(regime: MasterRegimeLabel): number {
  if (regime === "CRISIS")      return 0.4;
  if (regime === "CONTRACTION") return 0.7;
  return 1.0;
}

function getDominantSignal(
  c: MasterRegimeLabel, s: MasterRegimeLabel, p: MasterRegimeLabel, resolved: MasterRegimeLabel
): "CRISIS_MODEL" | "STRESS_MODEL" | "PROBABILISTIC" | "CONSENSUS" {
  if (c === resolved && s === resolved && p === resolved) return "CONSENSUS";
  if (c === resolved && s !== resolved && p !== resolved) return "CRISIS_MODEL";
  if (p === resolved && c !== resolved) return "PROBABILISTIC";
  return "STRESS_MODEL";
}

function getConfidence(a: MasterRegimeLabel, b: MasterRegimeLabel, c: MasterRegimeLabel): "HIGH" | "MEDIUM" | "LOW" {
  const vals = [a, b, c].map(r => PRIO[r]);
  const diff = Math.max(...vals) - Math.min(...vals);
  if (diff === 0) return "HIGH";
  if (diff === 1) return "MEDIUM";
  return "LOW";
}