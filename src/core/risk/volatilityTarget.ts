// ===============================================
// ARCHIVO: src/core/risk/volatilityTarget.ts
// NIVEL 2: Volatility targeting integrado en el motor
// ===============================================
// ANTES: función suelta sin consumidor
// AHORA: integrada en olympusV3 para escalar allocations
//        cuando la volatilidad realizada se aleja del target
//
// Target vol institucional: 12-15% anual para portfolio mixto
// Si vol realizada > target: reducir exposición
// Si vol realizada < target: aumentar exposición (hasta cap)
// ===============================================

import { VOLATILITY_CONFIG } from "@/core/config/engineConfig";

export interface VolTargetInput {
  targetVol: number;    // volatilidad objetivo en decimal (ej: 0.14 = 14%)
  realizedVol: number;  // volatilidad realizada de la cartera en decimal
  regimePenalty: number; // penalización de régimen del masterRegime [0.4, 1.0]
}

export interface VolTargetOutput {
  multiplier: number;     // multiplicador de exposición [0.3, 1.5]
  effectiveVol: number;   // vol esperada post-ajuste
  isScaledDown: boolean;  // true si se está reduciendo exposición
  isScaledUp: boolean;    // true si se está aumentando exposición
}

// Volatilidad objetivo del portfolio (desde config centralizada)
export const DEFAULT_TARGET_VOL = VOLATILITY_CONFIG.DEFAULT_TARGET_VOL;

// Caps institucionales (desde config centralizada)
const VOL_MULTIPLIER_MAX = VOLATILITY_CONFIG.MULTIPLIER_MAX;
const VOL_MULTIPLIER_MIN = VOLATILITY_CONFIG.MULTIPLIER_MIN;

/**
 * Calcula el multiplicador de volatility targeting para escalar allocations.
 *
 * En régimen de crisis, el target vol se reduce automáticamente:
 *   regimePenalty=1.0 (expansion)  → target = targetVol × 1.0
 *   regimePenalty=0.7 (contraction) → target = targetVol × 0.85
 *   regimePenalty=0.4 (crisis)      → target = targetVol × 0.60
 *
 * Esto hace que en crisis, incluso si la vol realizada es baja,
 * el sistema no incremente exposición.
 *
 * @example uso en olympusV3.ts:
 *   const volTarget = computeVolTargetMultiplier({
 *     targetVol: DEFAULT_TARGET_VOL,
 *     realizedVol: portfolioRealizedVol,
 *     regimePenalty: masterRegime.regimePenalty,
 *   });
 *   // Escalar todas las allocations finales:
 *   allocation.finalAllocation *= volTarget.multiplier;
 */
export function computeVolTargetMultiplier(input: VolTargetInput): VolTargetOutput {
  const { targetVol, realizedVol, regimePenalty } = input;

  if (realizedVol <= 0) {
    return { multiplier: 1, effectiveVol: targetVol, isScaledDown: false, isScaledUp: false };
  }

  // Target ajustado por régimen: en crisis queremos menos riesgo incluso con vol baja
  // Remapeo lineal: penalty [0.4, 1.0] → regimeFactor [0.60, 1.0]
  //   penalty=1.0 (expansion)   → regimeFactor=1.0  → targetVol × 1.0  (sin penalización)
  //   penalty=0.7 (contraction) → regimeFactor=0.80 → targetVol × 0.80
  //   penalty=0.4 (crisis)      → regimeFactor=0.60 → targetVol × 0.60
  //
  // FIX BUG-03: la fórmula anterior `0.4 + (penalty-0.4)*(0.6/0.6)` se simplificaba
  // algebraicamente a `regimeFactor = regimePenalty` (identidad matemática, rango [0.4,1.0]).
  // Resultado incorrecto: CONTRACTION daba 12.6% target (debería ser 14.4%),
  // CRISIS daba 7.2% (debería ser 10.8%) — motor 33-50% más conservador de lo diseñado.
  const regimeFactor = 0.60 + (regimePenalty - 0.4) * (0.40 / 0.60);
  const adjustedTarget = targetVol * regimeFactor;

  // Multiplicador base
  const rawMultiplier = adjustedTarget / realizedVol;

  // Clamp institucional
  const multiplier = Math.max(VOL_MULTIPLIER_MIN, Math.min(VOL_MULTIPLIER_MAX, rawMultiplier));

  return {
    multiplier,
    effectiveVol: realizedVol * multiplier,
    isScaledDown: multiplier < 1,
    isScaledUp: multiplier > 1,
  };
}