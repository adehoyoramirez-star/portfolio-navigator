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

// Volatilidad objetivo del portfolio. 14% es un nivel típico para un
// portfolio multi-activo con exposición a cripto moderada.
export const DEFAULT_TARGET_VOL = 0.14;

// Caps institucionales: nunca apalancar >1.5x ni reducir <0.3x
const VOL_MULTIPLIER_MAX = 1.5;
const VOL_MULTIPLIER_MIN = 0.3;

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
  // Mapeo: penalty 1.0→factor 1.0, 0.7→0.85, 0.4→0.60
  const regimeFactor = 0.4 + (regimePenalty - 0.4) * (0.6 / 0.6);
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