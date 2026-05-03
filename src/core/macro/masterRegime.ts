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

// ── HYSTERESIS CONSTANTS ───────────────────────────────────────────────────
// PROBLEMA AUDITADO: el usuario modifica datos manualmente (bond yields, VIX override,
// M2, etc.) inmediatamente después de abrir la app, provocando múltiples cambios de
// régimen en minutos (CRISIS→CONTRACTION→EXPANSION→CONTRACTION en 24h con VIX=17).
// Esto es señal de INESTABILIDAD del detector, no de cambio macro real.
//
// SOLUCIÓN — Hysteresis de dos niveles:
//   Nivel 1 (SOFT): si el nuevo régimen es menos severo que el anterior Y han pasado
//     menos de HYSTERESIS_DOWNGRADE_HOURS horas → mantener el anterior, bajar confianza.
//     "Downgrade" = CRISIS→CONTRACTION o CONTRACTION→EXPANSION (mejora del entorno)
//     Justificación: los mercados no mejoran en horas; si el VIX bajó de 19 a 17,
//     la macro no ha cambiado — probablemente fue un ajuste manual.
//
//   Nivel 2 (HARD): si el nuevo régimen es más severo (upgrade de riesgo: CRISIS)
//     → aplicar SIEMPRE, sin hysteresis. Las crisis sí pueden ocurrir rápido.
//
// STORAGE: localStorage con key 'olympus_regime_hysteresis_v1'
// RESET: se limpia automáticamente si han pasado más de HYSTERESIS_MAX_HOURS horas.
//
const HYSTERESIS_DOWNGRADE_HOURS = 6;  // mínimas horas para downgrade (si no hay refresh manual)
const HYSTERESIS_MAX_HOURS = 72;        // reset completo después de 3 días

// ── BYPASS: cuando el usuario pulsa "Actualizar datos", la hysteresis se salta ──
// Lógica: datos manuales actualizados INTENCIONALMENTE = foto real del mercado ahora.
// La hysteresis solo protege contra recálculos automáticos en background.
// El botón de refresh escribe esta clave ANTES de llamar a fetchRealMarketData().
export const HYSTERESIS_BYPASS_KEY = 'olympus_manual_refresh_v1';
const BYPASS_VALID_MS = 120_000; // 2 minutos — ventana tras pulsar el botón

function isManualRefreshActive(): boolean {
  try {
    const ts = parseInt(localStorage.getItem(HYSTERESIS_BYPASS_KEY) ?? '0');
    return (Date.now() - ts) < BYPASS_VALID_MS;
  } catch { return false; }
}

export function signalManualRefresh(): void {
  try { localStorage.setItem(HYSTERESIS_BYPASS_KEY, Date.now().toString()); } catch {}
}

interface HysteresisState {
  lastRegime: string;
  lastTimestamp: number;
  penaltyAtChange: number;
}

function loadHysteresisState(): HysteresisState | null {
  try {
    const raw = localStorage.getItem('olympus_regime_hysteresis_v1');
    if (!raw) return null;
    const state = JSON.parse(raw) as HysteresisState;
    const hoursElapsed = (Date.now() - state.lastTimestamp) / 3_600_000;
    if (hoursElapsed > HYSTERESIS_MAX_HOURS) {
      localStorage.removeItem('olympus_regime_hysteresis_v1');
      return null;
    }
    return state;
  } catch { return null; }
}

function saveHysteresisState(state: HysteresisState): void {
  try {
    localStorage.setItem('olympus_regime_hysteresis_v1', JSON.stringify(state));
  } catch { /* silencio */ }
}

const REGIME_SEVERITY: Record<string, number> = { EXPANSION: 0, CONTRACTION: 1, CRISIS: 2 };

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

  // ── HYSTERESIS: estabilizar régimen contra cambios manuales rápidos ──────
  // Aplicar SOLO a downgrades (mejoras de régimen). Las alertas de crisis nunca
  // se suavizan — si el modelo dice CRISIS, es CRISIS inmediatamente.
  const hysteresis = loadHysteresisState();
  let effectiveRegime = regime;
  let effectivePenalty = finalPenalty;
  let hysteresisActive = false;

  if (hysteresis) {
    const hoursElapsed = (Date.now() - hysteresis.lastTimestamp) / 3_600_000;
    const prevSeverity = REGIME_SEVERITY[hysteresis.lastRegime] ?? 0;
    const currSeverity = REGIME_SEVERITY[regime] ?? 0;
    const isDowngrade = currSeverity < prevSeverity;
    // Si el usuario pulsó "Actualizar datos" en los últimos 2 min → bypass total
    const bypassActive = isManualRefreshActive();

    if (isDowngrade && hoursElapsed < HYSTERESIS_DOWNGRADE_HOURS && !bypassActive) {
      // Mantener el régimen anterior — solo suavizar la penalización hacia el nuevo
      effectiveRegime = hysteresis.lastRegime as MasterRegimeLabel;
      // Interpolar penalización: avanzar 30% hacia el nuevo valor por hora transcurrida
      const lerpFactor = Math.min(1, hoursElapsed / HYSTERESIS_DOWNGRADE_HOURS);
      effectivePenalty = hysteresis.penaltyAtChange * (1 - lerpFactor) + finalPenalty * lerpFactor;
      effectivePenalty = Math.max(0.4, Math.min(1.0, effectivePenalty));
      hysteresisActive = true;
    } else {
      // Actualizar hysteresis state con el nuevo régimen
      saveHysteresisState({
        lastRegime: regime,
        lastTimestamp: Date.now(),
        penaltyAtChange: finalPenalty,
      });
    }
  } else {
    // Primera vez — guardar estado actual
    saveHysteresisState({
      lastRegime: regime,
      lastTimestamp: Date.now(),
      penaltyAtChange: finalPenalty,
    });
  }

  return {
    regime: effectiveRegime,
    regimePenalty: effectivePenalty,
    crisisDetail: crisis,
    stressDetail: stress,
    regimeProbs,
    dominantSignal,
    // Bajar confianza si hysteresis está activa — el dashboard puede mostrarlo
    confidence: hysteresisActive ? 'LOW' : confidence,
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