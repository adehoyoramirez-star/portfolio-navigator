// ===============================================
// ARCHIVO: src/core/portfolio/kelly.ts
// ===============================================
// ANTES: Math.min(0.5, rawKelly)
// → Cap al 50% por activo — demasiado agresivo para un portfolio real
// → Con 7 activos, permitir 50% en uno solo destruye la diversificación
//
// AHORA: Half-Kelly institucional con cap configurable (default 20%)
// → Half-Kelly (f* × 0.5): reduce volatilidad ~30% con pérdida mínima de retorno esperado
// → Cap default 0.20: con 7 activos, ninguno puede dominar más del 20% antes de normalización
// → capOverride: permite al motor pasar un cap distinto según régimen táctico
// → isCapped: flag para trazabilidad en el dashboard
//
// Referencia: Thorp, E.O. (2006) "The Kelly Criterion in Blackjack,
// Sports Betting, and the Stock Market" — recomienda half-kelly para mercados reales
// ===============================================

import { KELLY_CONFIG } from "../config/engineConfig";

export interface KellyInput {
  expectedReturn: number; // retorno esperado normalizado (output de olympusV3)
  volatility: number;     // volatilidad anualizada en decimal (ej: 0.60 = 60%)
  capOverride?: number;   // cap opcional por régimen táctico (undefined = usa KELLY_CONFIG.CAP)
}

export interface KellyResult {
  kellyFraction: number; // half-kelly con cap [0, KELLY_CAP] — usar esto en el motor
  rawKelly: number;      // kelly óptimo teórico sin ajustar — para trazabilidad
  halfKelly: number;     // rawKelly × 0.5 antes del cap — para trazabilidad
  isCapped: boolean;     // true si el cap estuvo activo
  effectiveCap: number;  // cap realmente usado (capOverride ?? KELLY_CONFIG.CAP)
}

// Cap institucional (desde config centralizada)
const KELLY_CAP = KELLY_CONFIG.CAP;
const KELLY_HALF_FRACTION = KELLY_CONFIG.HALF_FRACTION;

/**
 * Calcula la fracción de Kelly con ajuste institucional (half-Kelly).
 *
 * Fórmula Kelly continua: f* = μ / σ²
 * donde μ = retorno esperado, σ² = varianza
 *
 * @param input.capOverride — cap opcional del régimen táctico (ej: 0.15 en CRISIS)
 *                            Si no se pasa, se usa KELLY_CONFIG.CAP (default 20%)
 */
export function calculateKelly(input: KellyInput): KellyResult {
  const { expectedReturn, volatility, capOverride } = input;
  const effectiveCap = capOverride ?? KELLY_CAP;
  const variance = volatility * volatility;

  // Kelly óptimo teórico (puede ser >1, por eso necesita ajuste)
  const rawKelly = variance > 0 ? expectedReturn / variance : 0;

  // Half-Kelly: usar la mitad del óptimo teórico
  const halfKelly = rawKelly * KELLY_HALF_FRACTION;

  // Cap al effectiveCap, floor en 0 (nunca posición corta via Kelly)
  const cappedKelly = Math.max(0, Math.min(effectiveCap, halfKelly));

  const isCapped = halfKelly > effectiveCap && halfKelly > 0;

  return {
    kellyFraction: cappedKelly,
    rawKelly,
    halfKelly,
    isCapped,
    effectiveCap,
  };
}
