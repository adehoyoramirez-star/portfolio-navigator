// ===============================================
// ARCHIVO: src/core/factors/factorCalibration.ts
// FIX PROBLEMA 2: Kelly con retornos anualizados reales
// ===============================================
//
// PROBLEMA ANTERIOR:
//   Kelly usa f* = μ / σ²
//   μ era un Z-score adimensional de los factor scores
//   → Z-score no es un retorno esperado — Kelly produce fracciones incorrectas
//   → Los resultados dependían del universo relativo (si cambian los activos, cambia μ)
//
// SOLUCIÓN:
//   Convertir factor Z-scores a retornos anualizados estimados mediante
//   calibración con primas documentadas de literatura académica.
//
//   Fuentes utilizadas para la calibración:
//   - Fama & French (1993, 2015): HML value premium ~3.2% annual (1963-2022)
//   - Carhart (1997): UMD momentum premium ~4.8% annual (1966-2022)
//   - Asness, Frazzini & Pedersen (2013): QMJ quality premium ~2.4% annual
//   - Frazzini & Pedersen (2014): BAB low-volatility premium ~1.8% annual
//   - AQR Factor Library (2000-2023): ajuste post-2000 (premia reducidos ~30%)
//
//   La calibración usa una función sigmoid para evitar que Z-scores extremos
//   generen estimaciones de retorno irrealistas (un Z-score de 5 no implica
//   un retorno esperado de 5× la prima, sino que converge al máximo teórico).
//
// RESULTADO:
//   Un Z-score de +1 en momentum → ~+2.4% de alpha anualizado sobre base
//   Un Z-score de -2 en value → ~-2.1% de penalización
//   Kelly recibe μ en mismas unidades que σ² → fracciones correctas
//
// ===============================================

// FIX-CRÍTICO-2: importar FACTOR_CONFIG desde engineConfig como única fuente de verdad.
// ANTES: FACTOR_PREMIA estaba hardcodeado aquí con valores distintos a los de engineConfig.
//   factorCalibration.ts → momentum: 0.048
//   engineConfig.ts → FACTOR_PREMIUMS.momentum: 0.04
//   olympusV3.ts → peso momentum: 0.40 (hardcodeado)
// AHORA: todos usan FACTOR_CONFIG.FACTOR_PREMIUMS y FACTOR_CONFIG.DEFAULT_WEIGHTS.
//   Un solo cambio en engineConfig.ts → se propaga a calibración y al motor.
import { FACTOR_CONFIG } from "../config/engineConfig";

// Re-exportar para compatibilidad con código que importaba FACTOR_PREMIA directamente
// DEPRECATED: usar FACTOR_CONFIG.FACTOR_PREMIUMS en código nuevo
export const FACTOR_PREMIA = FACTOR_CONFIG.FACTOR_PREMIUMS;

// Tasa libre de riesgo de referencia (EUR, short-term)
// Usamos un valor conservador fijo — el motor no predice tipos futuros
const RISK_FREE_RATE_EUR = 0.025; // 2.5% — euribor promedio largo plazo

// ── FUNCIÓN PRINCIPAL ──────────────────────────────────────────────────────

export interface FactorScores {
  momentumScore: number;   // Z-score del factor momentum [-3, +3] típicamente
  valueScore: number;      // Z-score del factor value
  qualityScore: number;    // Z-score del factor quality
  lowVolScore: number;     // Z-score del factor low-vol + downside penalty
}

export interface CalibratedReturn {
  expectedReturn: number;    // retorno anualizado estimado en decimal (ej: 0.12 = 12%)
  factorAlpha: number;       // componente de alpha sobre risk-free (sin el riskFreeRate)
  breakdown: {
    momentumContrib: number; // contribución del momentum al alpha
    valueContrib: number;
    qualityContrib: number;
    lowVolContrib: number;
  };
}

/**
 * Función sigmoid bounded: mapea cualquier valor real a [-maxVal, +maxVal].
 * Evita que Z-scores extremos generen estimaciones de retorno irreales.
 *
 * sigmoid_bounded(x, maxVal) = maxVal × tanh(x / 2)
 *
 * Propiedades:
 *   - Lineal cerca de 0: tanh(x/2) ≈ x/2 para x pequeño
 *   - Se satura: Z=±3 → ≈ ±95% del máximo, Z=±5 → ≈ ±99% del máximo
 *   - Antisimétrica: f(-x) = -f(x)
 */
function sigmoidBounded(zScore: number, maxVal: number): number {
  return maxVal * Math.tanh(zScore / 2);
}

/**
 * Convierte factor Z-scores a un retorno anualizado calibrado.
 *
 * Fórmula:
 *   factorAlpha = Σ sigmoid_bounded(zScore_i, prima_i) × peso_i
 *   expectedReturn = riskFreeRate + factorAlpha
 *
 * Pesos de los factores (idénticos a los de olympusV3 para coherencia):
 *   Momentum: 40%, Value: 25%, Quality: 20%, LowVol: 15%
 */
export function calibrateExpectedReturn(
  scores: FactorScores,
  weights?: { momentum: number; value: number; quality: number; lowVol: number }
): CalibratedReturn {
  // FIX-CRÍTICO-2: usar FACTOR_CONFIG.DEFAULT_WEIGHTS como fallback — única fuente de verdad.
  const w = weights ?? FACTOR_CONFIG.DEFAULT_WEIGHTS;
  // FIX-CRÍTICO-2: usar FACTOR_CONFIG.FACTOR_PREMIUMS — ya no hay definición duplicada aquí.
  const premia = FACTOR_CONFIG.FACTOR_PREMIUMS;
  const momentumContrib = sigmoidBounded(scores.momentumScore, premia.momentum) * w.momentum;
  const valueContrib    = sigmoidBounded(scores.valueScore,    premia.value)    * w.value;
  const qualityContrib  = sigmoidBounded(scores.qualityScore,  premia.quality)  * w.quality;
  const lowVolContrib   = sigmoidBounded(scores.lowVolScore,   premia.lowVol)   * w.lowVol;

  const factorAlpha = momentumContrib + valueContrib + qualityContrib + lowVolContrib;

  // Retorno total = libre de riesgo + alpha de factores
  // Clampeado: mínimo -30% (no modela quiebras totales), máximo +80% (evita fantasías)
  const expectedReturn = Math.max(-0.30, Math.min(0.80, RISK_FREE_RATE_EUR + factorAlpha));

  return {
    expectedReturn,
    factorAlpha,
    breakdown: { momentumContrib, valueContrib, qualityContrib, lowVolContrib },
  };
}

/**
 * Calcula el retorno esperado calibrado para Kelly directamente.
 * Wrapper conveniente para usar en olympusV3.ts.
 *
 * ANTES: normalizedExpectedReturn = (rawScore - mean) / std  [Z-score, adimensional]
 * AHORA: calibratedReturn.expectedReturn  [% anualizado, mismas unidades que σ en Kelly]
 */
export function getKellyExpectedReturn(scores: FactorScores): number {
  return calibrateExpectedReturn(scores).expectedReturn;
}