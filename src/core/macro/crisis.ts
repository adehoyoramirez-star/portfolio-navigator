// src/core/macro/crisis.ts
// FIX MATH-02: Credit multiplier reducido 3→2 y umbral CONTRACTION subido 10→12.
// PROBLEMA: Con credit=2.71% y VIX=20, el modelo daba CONTRACTION (score 11.26>10)
// cuando los otros 2 modelos (probabilístico: 100% EXP, stress: EXP) votaban EXPANSION.
// CAUSA RAÍZ: multiplier 3 sobrepesaba credit spread — 2.71% contribuía 3.25pts = VIX~20.
// SOLUCIÓN: multiplier 2 (proporcional) + umbral 12 (buffer anti falsos positivos).
// Con datos de hoy (VIX 20, credit 2.71%): score = 8.01+2.17 = 10.18 < 12 → EXPANSION.
// Con contracción real (VIX 28, credit 4.5%): score = 11.2+3.6 = 14.8 > 12 → CONTRACTION.
// Con crisis (VIX 35, credit 8%): score = 14+6.4 = 20.4 → CONTRACTION fuerte.
// Fuente original: calibración con NBER recession dates 1990-2023.

import { REGIME_CONFIG } from "../config/engineConfig";

export type MacroRegime = "EXPANSION" | "CONTRACTION" | "CRISIS";

export interface CrisisResult {
  crisisProbability: number;
  regime: MacroRegime;
  crisisScore: number; // expuesto para trazabilidad en dashboard
}

export function detectCrisis(
  vix: number,
  yieldSpread: number,
  creditSpread: number
): CrisisResult {
  const vixComponent = vix;
  // creditSpread y yieldSpread llegan en PORCENTAJE (ej: 2.82 = 2.82%, no 0.0282).
  // Confirmado: los umbrales de globalStress usan >3, >5 — consistente con porcentaje.
  // ADVERTENCIA: nunca normalizar a decimal antes de pasar a esta función.
  const creditComponent = creditSpread * 2;
  // FIX-CURVE-01: yieldSpread está en puntos porcentuales (ej: -0.50 para -50bp).
  // El *100 original normalizaba al rango de VIX (10-50), pero era demasiado agresivo:
  //   -50bp → curveComponent=50 → crisisScore +10pts (equivalente a VIX=26).
  // Sin escalar, la curva era irrelevante (contribución <0.5pts incluso a -200bp).
  // CORRECCIÓN: *10 como compromiso — inversión severa (-200bp) contribuye 4pts.
  //   -50bp → 0.5pts | -100bp → 2.0pts | -200bp → 4.0pts (señal real, no falso positivo).
  const curveComponent = Math.max(0, -yieldSpread) * 10;

  const crisisScore = vixComponent * 0.4 + creditComponent * 0.4 + curveComponent * 0.2;

  let regime: MacroRegime = "EXPANSION";
  if (crisisScore > REGIME_CONFIG.CRISIS_SCORE_THRESHOLD) regime = "CRISIS";
  // FIX MATH-02: era >10, ahora >12 (buffer anti falsos positivos con credit×2)
  else if (crisisScore > REGIME_CONFIG.CONTRACTION_THRESHOLD) regime = "CONTRACTION";

  return {
    crisisProbability: Math.min(100, Math.max(0, crisisScore)),
    regime,
    crisisScore,
  };
}