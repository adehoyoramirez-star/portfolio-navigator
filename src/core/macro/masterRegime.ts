// ===============================================
// ARCHIVO: src/core/macro/masterRegime.ts
// NIVEL 2: penalización continua vía regimeProbabilistic
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

export type MasterRegimeLabel = "EXPANSION" | "CONTRACTION" | "CRISIS";

export interface MasterRegimeInput {
  vix: number;
  yieldSpread: number;
  creditSpread: number;
  move: number;
  dxyTrend: number;
  btcVol: number;
  m2Growth: number; // NUEVO Nivel 2
}

export interface MasterRegimeOutput {
  regime: MasterRegimeLabel;
  regimePenalty: number;            // continuo [0.4, 1.0] ajustado por CEWS si disponible
  crisisDetail: CrisisResult;
  stressDetail: StressResult;
  regimeProbs: RegimeProbabilities;
  dominantSignal: "CRISIS_MODEL" | "STRESS_MODEL" | "PROBABILISTIC" | "CONSENSUS";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  cews?: import("./crisisEarlyWarning").CEWSOutput; // Early Warning — requiere historial
}

export function getMasterRegime(input: MasterRegimeInput, cewsHistory?: CEWSDataPoint[]): MasterRegimeOutput {
  const crisis = detectCrisis(input.vix, input.yieldSpread, input.creditSpread);
  const stress = computeGlobalStress({
    vix: input.vix,
    creditSpread: input.creditSpread,
    move: input.move,
    dxyTrend: input.dxyTrend,
    btcVol: input.btcVol,
  });
  const regimeProbs = detectRegimeProbabilistic(input.vix, input.yieldSpread, input.m2Growth);

  const crisisLabel = crisis.regime;
  const stressLabel = mapStressToMacro(stress.regime);
  const probLabel   = dominantRegime(regimeProbs);

  // El más conservador de los tres gana
  const regime = [crisisLabel, stressLabel, probLabel].reduce(resolveRegime);

  // NIVEL 2: blend 40% binario + 60% continuo → elimina escalones bruscos
  const binaryPenalty     = getBinaryPenalty(regime);
  const continuousPenalty = continuousRegimePenalty(regimeProbs);
  const regimePenalty     = Math.max(0.4, Math.min(1.0, 0.4 * binaryPenalty + 0.6 * continuousPenalty));

  const dominantSignal = getDominantSignal(crisisLabel, stressLabel, probLabel, regime);
  const confidence     = getConfidence(crisisLabel, stressLabel, probLabel);

  // CEWS: si hay historial, ajustar la penalización hacia abajo (más conservador)
  let finalPenalty = regimePenalty;
  let cews: import("./crisisEarlyWarning").CEWSOutput | undefined;
  if (cewsHistory && cewsHistory.length >= 2) {
    cews = computeCEWS(cewsHistory);
    finalPenalty = Math.max(0.4, Math.min(1.0, regimePenalty + cews.regimePenaltyAdjustment));
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