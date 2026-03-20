// ===============================================
// ARCHIVO: src/core/macro/regimeProbabilistic.ts
// ===============================================
// ANTES: sin consumidor — código muerto
// AHORA: integrado en masterRegime.ts para suavizar las penalizaciones
//
// PROBLEMA que resuelve:
//   regimePenalty anterior era un escalón binario:
//   EXPANSION=1.0, CONTRACTION=0.7, CRISIS=0.4
//   Un cambio de régimen en la frontera podía mover el portfolio un 30%
//   de golpe sin justificación económica — señales de trading excesivamente reactivas
//
// SOLUCIÓN: penalización continua ponderada por probabilidades
//   penalty = expansion×1.0 + contraction×0.7 + crisis×0.4
//   El resultado es una curva suave, no un escalón
// ===============================================

export interface RegimeProbabilities {
  expansion: number;    // [0,1] — suman 1
  contraction: number;
  crisis: number;
}

/**
 * Calcula probabilidades continuas de régimen a partir de indicadores macro.
 *
 * Inputs:
 *   vix        — fear index (18=normal, 25=elevado, 35+=crisis)
 *   yieldSpread — 10y-2y en puntos (negativo = curva invertida)
 *   m2Growth   — crecimiento M2 en % (input manual del dashboard)
 *
 * Output: probabilidades [0,1] que suman 1 para cada régimen
 */
export function detectRegimeProbabilistic(
  vix: number,
  yieldSpread: number,
  m2Growth: number
): RegimeProbabilities {
  // ---- CRISIS ----
  // VIX alto + liquidez contractiva
  const crisisVix = Math.min(1, Math.max(0, (vix - 20) / 30));     // 0 en vix=20, 1 en vix=50
  const crisisLiquidity = m2Growth < 0 ? 0.6 : Math.max(0, (2 - m2Growth) / 10);
  const crisisRaw = 0.5 * crisisVix + 0.5 * crisisLiquidity;

  // ---- CONTRACCIÓN ----
  // Curva invertida + M2 bajo
  const contractionCurve = yieldSpread < 0
    ? Math.min(1, Math.abs(yieldSpread) / 2)   // máx penalización en -2% o más invertida
    : 0;
  const contractionLiquidity = m2Growth < 2
    ? Math.min(1, (2 - m2Growth) / 4)
    : 0;
  const contractionRaw = 0.6 * contractionCurve + 0.4 * contractionLiquidity;

  // ---- EXPANSIÓN ----
  // Residual con floor — si expansión pura, da probabilidad alta
  const expansionRaw = Math.max(0, 1 - crisisRaw - contractionRaw);

  // Normalizar para que sumen exactamente 1
  const total = crisisRaw + contractionRaw + expansionRaw;
  if (total === 0) return { expansion: 1, contraction: 0, crisis: 0 };

  return {
    crisis:      crisisRaw / total,
    contraction: contractionRaw / total,
    expansion:   expansionRaw / total,
  };
}

/**
 * Convierte probabilidades de régimen a una penalización continua [0.4, 1.0].
 * Reemplaza el if/else de escalón en masterRegime.
 *
 * penalty = expansion×1.0 + contraction×0.7 + crisis×0.4
 *
 * Ejemplos:
 *   100% expansion  → 1.00
 *   50/50 exp/cont  → 0.85
 *   100% crisis     → 0.40
 *   33/33/33        → 0.70
 */
export function continuousRegimePenalty(probs: RegimeProbabilities): number {
  const penalty = probs.expansion * 1.0 + probs.contraction * 0.7 + probs.crisis * 0.4;
  // Clamp por seguridad: nunca por debajo de 0.4 ni por encima de 1.0
  return Math.max(0.4, Math.min(1.0, penalty));
}

/**
 * Devuelve el régimen dominante (el de mayor probabilidad) como label.
 * Útil para mostrar en el dashboard.
 */
export function dominantRegime(probs: RegimeProbabilities): "EXPANSION" | "CONTRACTION" | "CRISIS" {
  if (probs.expansion >= probs.contraction && probs.expansion >= probs.crisis) return "EXPANSION";
  if (probs.contraction >= probs.crisis) return "CONTRACTION";
  return "CRISIS";
}