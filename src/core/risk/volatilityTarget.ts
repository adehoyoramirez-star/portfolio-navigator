// ===============================================
// ARCHIVO: src/core/risk/volatilityTarget.ts
// FIX-VOL-TARGET-01: target vol subido 18% → 20%
// ===============================================
// ANTES: DEFAULT_TARGET_VOL = 0.18 (18%)
//   Con BTC al 20-25% del portfolio, la vol natural es 20-22%.
//   El motor SIEMPRE veía vol > target y escalaba abajo constantemente.
//   Resultado: multiplicador crónico de 0.68-0.75 incluso sin crisis.
//
// AHORA: DEFAULT_TARGET_VOL = 0.20 (20%) — desde engineConfig.ts
//   El multiplicador solo baja cuando hay exceso de vol real sobre el objetivo.
//   En condiciones normales de mercado con BTC, el motor opera al 100%.
//
// El target ajustado por régimen sigue aplicando:
//   EXPANSION  (penalty=1.0): target efectivo = 20% × 1.0 = 20%
//   CONTRACTION(penalty=0.58): target efectivo = 20% × 0.73 = 14.6%
//   CRISIS     (penalty=0.40): target efectivo = 20% × 0.60 = 12%
//
// FIX-IMPORT-PATH:
//   volatilityTarget.ts está en src/core/risk/
//   engineConfig.ts está en src/core/config/
//   → subir UN nivel (risk → core) + entrar en config = ../config/
//   ANTES (INCORRECTO): "../../../config/engineConfig.ts"  (subía a PAPA/)
//   AHORA (CORRECTO):   "../config/engineConfig.ts"        (llega a src/core/config/)
// ===============================================

import { VOLATILITY_CONFIG } from "../config/engineConfig";

export interface VolTargetInput {
  targetVol: number;
  realizedVol: number;
  regimePenalty: number;
}

export interface VolTargetOutput {
  multiplier: number;
  effectiveVol: number;
  isScaledDown: boolean;
  isScaledUp: boolean;
}

export const DEFAULT_TARGET_VOL = VOLATILITY_CONFIG.DEFAULT_TARGET_VOL; // 0.20

const VOL_MULTIPLIER_MAX = VOLATILITY_CONFIG.MULTIPLIER_MAX; // 1.5
const VOL_MULTIPLIER_MIN = VOLATILITY_CONFIG.MULTIPLIER_MIN; // 0.3

export function computeVolTargetMultiplier(input: VolTargetInput): VolTargetOutput {
  const { targetVol, realizedVol, regimePenalty } = input;

  if (realizedVol <= 0) {
    return { multiplier: 1, effectiveVol: targetVol, isScaledDown: false, isScaledUp: false };
  }

  // Target ajustado por régimen: penalty [0.4, 1.0] → regimeFactor [0.60, 1.0]
  // FIX BUG-03 (mantenido): fórmula correcta sin la identidad algebraica
  const regimeFactor = 0.60 + (regimePenalty - 0.4) * (0.40 / 0.60);
  const adjustedTarget = targetVol * regimeFactor;

  const rawMultiplier = adjustedTarget / realizedVol;
  const multiplier = Math.max(VOL_MULTIPLIER_MIN, Math.min(VOL_MULTIPLIER_MAX, rawMultiplier));

  return {
    multiplier,
    effectiveVol: realizedVol * multiplier,
    isScaledDown: multiplier < 1,
    isScaledUp: multiplier > 1,
  };
}
