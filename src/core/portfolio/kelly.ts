// ===============================================
// ARCHIVO: src/core/portfolio/kelly.ts
// ===============================================
// ANTES: Math.min(0.5, rawKelly)
// → Cap al 50% por activo — demasiado agresivo para un portfolio real
// → Con 7 activos, permitir 50% en uno solo destruye la diversificación
//
// AHORA: Half-Kelly institucional con cap a 25%
// → Half-Kelly (f* × 0.5): reduce volatilidad ~30% con pérdida mínima de retorno esperado
// → Cap 0.25: con 7 activos, ninguno puede dominar más del 25% antes de normalización
// → isCapped: flag para trazabilidad en el dashboard
//
// Referencia: Thorp, E.O. (2006) "The Kelly Criterion in Blackjack,
// Sports Betting, and the Stock Market" — recomienda half-kelly para mercados reales
// ===============================================

import { KELLY_CONFIG } from "../config/engineConfig";

export interface KellyInput {
  expectedReturn: number; // retorno esperado normalizado (output de olympusV3)
  volatility: number;     // volatilidad anualizada en decimal (ej: 0.60 = 60%)
}

export interface KellyResult {
  kellyFraction: number; // half-kelly con cap [0, 0.25] — usar esto en el motor
  rawKelly: number;      // kelly óptimo teórico sin ajustar — para trazabilidad
  halfKelly: number;     // rawKelly × 0.5 antes del cap — para trazabilidad
  isCapped: boolean;     // true si el cap de 0.25 estuvo activo
}

// Cap institucional (desde config centralizada)
const KELLY_CAP = KELLY_CONFIG.CAP;
const KELLY_HALF_FRACTION = KELLY_CONFIG.HALF_FRACTION;

/**
 * Calcula la fracción de Kelly con ajuste institucional (half-Kelly).
 *
 * Fórmula Kelly continua: f* = μ / σ²
 * donde μ = retorno esperado, σ² = varianza
 */
export function calculateKelly(input: KellyInput): KellyResult {
  const { expectedReturn, volatility } = input;
  const variance = volatility * volatility;

  // Kelly óptimo teórico (puede ser >1, por eso necesita ajuste)
  const rawKelly = variance > 0 ? expectedReturn / variance : 0;

  // Half-Kelly: usar la mitad del óptimo teórico
  const halfKelly = rawKelly * KELLY_HALF_FRACTION;

  // Cap a 25% máximo, floor en 0 (nunca posición corta via Kelly)
  const cappedKelly = Math.max(0, Math.min(KELLY_CAP, halfKelly));

  const isCapped = halfKelly > KELLY_CAP && halfKelly > 0;

  return {
    kellyFraction: cappedKelly,
    rawKelly,
    halfKelly,
    isCapped,
  };
}
