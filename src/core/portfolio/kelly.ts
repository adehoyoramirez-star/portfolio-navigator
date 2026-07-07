// ===============================================
// ARCHIVO: src/core/portfolio/kelly.ts
// KELLY INSTITUCIONAL CON JAMES-STEIN SHRINKAGE EN μ
// ===============================================
// EVOLUCIÓN:
//   v1: Math.min(0.5, rawKelly) — cap agresivo al 50%
//   v2: Half-Kelly con cap 0.20 (Thorp 2006)
//   v3: Half-Kelly + James-Stein shrinkage en μ (Jun 2026)
//
// V3 — JAMES-STEIN SHRINKAGE EN EXPECTED RETURNS:
//   El Kelly clásico f* = μ/σ² es extremadamente sensible a errores
//   en la estimación de μ. Pequeños errores en expected returns se
//   magnifican en la fracción óptima. Esto es el problema más grave
//   del Kelly en producción (documentado por MacLean, Thorp & Ziemba 2011).
//
//   SOLUCIÓN: James-Stein shrinkage en μ ANTES de calcular f*.
//     μ_shrunk = (1 - φ) · μ_raw + φ · μ_prior
//   donde:
//     φ = 0.65 (James-Stein factor, calibrado para T≈500, k≈7 activos)
//     μ_prior = retorno esperado del activo "promedio" (0.08 anual)
//
//   EFECTO: reduce la dispersión de Kelly fractions entre activos.
//   Un activo con μ=35% y σ=60% → Kelly puro = 35/36 = 0.97 (absurdo)
//   Con shrinkage: μ_shrunk = 0.35×0.35 + 0.65×0.08 = 0.175 → f*=0.175/0.36=0.49
//   → Half-Kelly: 0.24 → dentro del cap de 0.20.
//
//   Esto hace que BTC no explote el Kelly en bull markets y mantiene
//   asignaciones defendibles ante un comité de inversión.
//
// Referencias:
//   - James & Stein (1961) "Estimation with Quadratic Loss"
//   - Jorion (1986) "Bayes-Stein Estimation for Portfolio Analysis"
//   - MacLean, Thorp & Ziemba (2011) "The Kelly Capital Growth Investment Criterion"
// ===============================================

import { KELLY_CONFIG } from "../config/engineConfig";

export interface KellyInput {
  expectedReturn: number; // retorno esperado en decimal (ej: 0.15 = 15%)
  volatility: number;     // volatilidad anualizada en decimal (ej: 0.60 = 60%)
  capOverride?: number;   // cap opcional por régimen táctico
  // James-Stein shrinkage params (opcionales, defaults from config)
  shrinkagePhi?: number;       // φ = factor de shrinkage [0,1], default 0.65
  priorReturn?: number;        // μ_prior = retorno esperado del "activo promedio", default 0.08
}

export interface KellyResult {
  kellyFraction: number; // half-kelly con James-Stein shrinkage + cap
  rawKelly: number;      // Kelly original sin shrinkage
  shrunkReturn: number;  // μ después del James-Stein shrinkage
  halfKelly: number;
  isCapped: boolean;
  isFloored: boolean;
  effectiveCap: number;
  shrinkageApplied: boolean;  // true si el shrinkage modificó μ significativamente
}

/**
 * Calcula la fracción de Kelly con:
 * 1. James-Stein shrinkage en expected returns (reduce sensibilidad a errores en μ)
 * 2. Half-Kelly (reduce volatilidad ~30%)
 * 3. Cap institucional (ningún activo > 20%)
 *
 * @param input.shrinkagePhi — factor de James-Stein (0 = sin shrinkage, 1 = solo prior)
 * @param input.priorReturn — μ_prior, retorno del "activo promedio" (default 0.08 = 8%)
 */
export function calculateKelly(input: KellyInput): KellyResult {
  const { expectedReturn, volatility, capOverride } = input;
  const phi = input.shrinkagePhi ?? 0.65;  // James-Stein φ calibrado (Jorion 1986)
  const muPrior = input.priorReturn ?? KELLY_CONFIG.PRIOR_RETURN; // FIX-AUDIT-C11: centralizado en config (antes 0.08 hardcodeado)
  const effectiveCap = capOverride ?? KELLY_CONFIG.CAP;
  const variance = volatility * volatility;

  // ── PASO 1: James-Stein shrinkage en μ ────────────────────────
  // μ_shrunk = (1 - φ) · μ_raw + φ · μ_prior
  // Con φ=0.65: 65% del peso va al prior, 35% al dato observado.
  // Esto es conservador pero necesario: los retornos esperados de
  // factores son notoriamente ruidosos (especialmente momentum).
  const shrunkReturn = (1 - phi) * expectedReturn + phi * muPrior;
  const shrinkageApplied = Math.abs(shrunkReturn - expectedReturn) > 0.01;

  // ── PASO 2: Kelly con μ shrinkage ────────────────────────────
  // Usamos μ_shrunk en vez de μ_raw para f*.
  // Esto evita que activos con μ estimado muy alto (BTC en bull)
  // reciban fracciones absurdas de Kelly.
  const rawKelly = variance < 1e-8 ? 0 : shrunkReturn / variance;

  // ── PASO 3: Half-Kelly ───────────────────────────────────────
  const halfKelly = rawKelly * KELLY_CONFIG.HALF_FRACTION;

  // ── PASO 4: Cap institucional + floor ────────────────────────
  const cappedKelly = Math.max(0, Math.min(effectiveCap, halfKelly));

  const isCapped = halfKelly > effectiveCap && halfKelly > 0;
  const isFloored = halfKelly < 0 && cappedKelly === 0;

  return {
    kellyFraction: cappedKelly,
    rawKelly,
    shrunkReturn,
    halfKelly,
    isCapped,
    isFloored,
    effectiveCap,
    shrinkageApplied,
  };
}
