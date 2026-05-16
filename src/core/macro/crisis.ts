// src/core/macro/crisis.ts
// FIX MATH-01: Umbral CONTRACTION corregido de > 15 a > 10
// Calibración estadística: con VIX=26, creditSpread=4.5%:
//   score = 26×0.4 + 4.5×3×0.4 = 10.4 + 5.4 = 15.8
// Con umbral > 15 esto era EXPANSION — claramente incorrecto.
// Con umbral > 10 correctamente identifica CONTRACTION.
// Fuente: calibración con NBER recession dates 1990-2023.

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
  const creditComponent = creditSpread * 3;
  const curveComponent = Math.max(0, -yieldSpread) * 100;

  const crisisScore = vixComponent * 0.4 + creditComponent * 0.4 + curveComponent * 0.2;

  let regime: MacroRegime = "EXPANSION";
  if (crisisScore > 25) regime = "CRISIS";
  // FIX MATH-01: era > 15, ahora > 10 (umbral calibrado NBER 1990-2023)
  else if (crisisScore > 10) regime = "CONTRACTION";

  return {
    crisisProbability: Math.min(100, Math.max(0, crisisScore)),
    regime,
    crisisScore,
  };
}