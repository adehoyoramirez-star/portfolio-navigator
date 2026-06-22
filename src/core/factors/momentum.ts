// ===============================================
// ARCHIVO: src/core/factors/momentum.ts
// FIX-MOMENTUM-DOC (22-Jun-2026): documentado que momentum12_1
// es una aproximación (returns12m - returns1m) del momentum
// canónico de Carhart (1997). El canónico excluye el último mes
// (t-12 a t-2) para evitar el efecto de reversión a corto plazo.
// La implementación actual usa (t-12 a t-1) que incluye el último
// mes → ligeramente más reactiva, más ruidosa en el margen.
// ===============================================
export interface MomentumInput {
  returns12m: number;
  returns1m: number;
  returns3m: number;
}

export interface MomentumResult {
  momentumScore: number;
  momentum12_1: number;
  momentum3m: number;
}

export function calculateMomentum(input: MomentumInput): MomentumResult {
  const { returns12m, returns1m, returns3m } = input;
  // Aproximación del momentum canónico (Carhart 1997).
  // Canónico: retorno de t-12 a t-2 (excluye último mes).
  // Nosotros: returns12m - returns1m ≈ retorno de t-12 a t-1 (incluye último mes).
  const momentum12_1 = returns12m - returns1m;
  const momentum3m = returns3m;
  const momentumScore = momentum12_1 * 0.7 + momentum3m * 0.3;
  return { momentumScore, momentum12_1, momentum3m };
}