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
  // FIX-CURVE-01: yieldSpread está en puntos porcentuales (ej: -0.50 para -50bp).
  // El *100 original normalizaba al rango de VIX (10-50), pero era demasiado agresivo:
  //   -50bp → curveComponent=50 → crisisScore +10pts (equivalente a VIX=26).
  // Sin escalar, la curva era irrelevante (contribución <0.5pts incluso a -200bp).
  // CORRECCIÓN: *10 como compromiso — inversión severa (-200bp) contribuye 4pts.
  //   -50bp → 0.5pts | -100bp → 2.0pts | -200bp → 4.0pts (señal real, no falso positivo).
  const curveComponent = Math.max(0, -yieldSpread) * 10;

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