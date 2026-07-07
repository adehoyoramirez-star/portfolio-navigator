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
import { FACTOR_CONFIG } from "../config/engineConfig";
import { RISK_FREE_RATE_ANNUAL } from "../../lib/constants";

// Re-exportar para compatibilidad con código que importaba FACTOR_PREMIA directamente
// DEPRECATED: usar FACTOR_CONFIG.FACTOR_PREMIUMS en código nuevo
export const FACTOR_PREMIA = FACTOR_CONFIG.FACTOR_PREMIUMS;

// FIX-AUDIT-T1: tasa libre de riesgo unificada con constants.ts.
// ANTES: RISK_FREE_RATE_EUR = 0.025 hardcodeado → inconsistente con constants.ts (0.04).
// AHORA: importada de constants.ts → misma rf para expected returns y Sharpe ratio.
const RISK_FREE_RATE_EUR = RISK_FREE_RATE_ANNUAL; // 0.04 — fuente única de verdad en constants.ts

// ── FUNCIÓN PRINCIPAL ──────────────────────────────────────────────────────

export interface FactorScores {
  momentumScore: number;
  valueScore: number;
  qualityScore: number;
  lowVolScore: number;
}

export interface CalibratedReturn {
  expectedReturn: number;
  factorAlpha: number;
  breakdown: {
    momentumContrib: number;
    valueContrib: number;
    qualityContrib: number;
    lowVolContrib: number;
  };
}

function sigmoidBounded(zScore: number, maxVal: number): number {
  return maxVal * Math.tanh(zScore / 2);
}

export function calibrateExpectedReturn(
  scores: FactorScores,
  weights?: { momentum: number; value: number; quality: number; lowVol: number }
): CalibratedReturn {
  const w = weights ?? FACTOR_CONFIG.DEFAULT_WEIGHTS;
  const premia = FACTOR_CONFIG.FACTOR_PREMIUMS;
  const momentumContrib = sigmoidBounded(scores.momentumScore, premia.momentum) * w.momentum;
  const valueContrib    = sigmoidBounded(scores.valueScore,    premia.value)    * w.value;
  const qualityContrib  = sigmoidBounded(scores.qualityScore,  premia.quality)  * w.quality;
  const lowVolContrib   = sigmoidBounded(scores.lowVolScore,   premia.lowVol)   * w.lowVol;

  const factorAlpha = momentumContrib + valueContrib + qualityContrib + lowVolContrib;

  // FIX-AUDIT-B5: cap alineado con marketData.ts [-0.05, 0.30].
  // El cap +80% era irreal (implicaba alpha de 77.5%).
  const expectedReturn = Math.max(-0.05, Math.min(0.30, RISK_FREE_RATE_EUR + factorAlpha));

  return {
    expectedReturn,
    factorAlpha,
    breakdown: { momentumContrib, valueContrib, qualityContrib, lowVolContrib },
  };
}

export function getKellyExpectedReturn(scores: FactorScores): number {
  return calibrateExpectedReturn(scores).expectedReturn;
}
