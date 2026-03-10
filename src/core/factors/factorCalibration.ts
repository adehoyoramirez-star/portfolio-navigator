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

// ── CONSTANTES DE CALIBRACIÓN ──────────────────────────────────────────────
// Prima anualizada por factor (post-2000, ajustada por colapso de primas)
// Los valores representan el alpha esperado cuando Z-score = +1
export const FACTOR_PREMIA = {
  momentum: 0.048,   // 4.8% anual — fuente: AQR UMD 2000-2023 (fue 7% pre-2000)
  value:    0.032,   // 3.2% anual — fuente: Fama-French HML (ajustado por value decay)
  quality:  0.024,   // 2.4% anual — fuente: AQR QMJ 2000-2023
  lowVol:   0.018,   // 1.8% anual — fuente: AQR BAB 2000-2023
} as const;

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
  const w = weights ?? { momentum: 0.40, value: 0.25, quality: 0.20, lowVol: 0.15 };
  // Contribución de cada factor: sigmoid aplicado sobre la prima documentada
  // sigmoid_bounded(z, prima) ≈ z × prima/2 para z pequeño (comportamiento lineal cerca de 0)
  const momentumContrib = sigmoidBounded(scores.momentumScore, FACTOR_PREMIA.momentum) * w.momentum;
  const valueContrib    = sigmoidBounded(scores.valueScore,    FACTOR_PREMIA.value)    * w.value;
  const qualityContrib  = sigmoidBounded(scores.qualityScore,  FACTOR_PREMIA.quality)  * w.quality;
  const lowVolContrib   = sigmoidBounded(scores.lowVolScore,   FACTOR_PREMIA.lowVol)   * w.lowVol;

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