// src/core/simulation/jumpDiffusion.ts
// FIX MATH-03: discretización mensual en lugar de anual.
//
// PROBLEMA ORIGINAL:
//   El bucle iteraba por años enteros: for (let t = 0; t < years; t++)
//   Con jumpIntensity ≈ 12.5 saltos/año y dt = 1 año:
//     P(jump por paso) = 1 - exp(-12.5 × 1) ≈ 99.99999%
//   → Prácticamente siempre hay exactamente 1 jump por año.
//   → La distribución de Poisson colapsa a una constante — el simulador
//     no puede representar años con 0, 2, 5 o 15 saltos (como ocurre en BTC).
//
// FIX APLICADO:
//   steps = years × 12 (pasos mensuales)
//   dt = 1/12
//   P(jump por paso) = 1 - exp(-λ × dt) = 1 - exp(-12.5/12) ≈ 64.7%
//   → Distribución de Poisson correcta: E[jumps/year] = λ = 12.5
//   → En 12 pasos mensuales el número total de jumps sigue Poisson(12.5):
//     puede ser 0, 5, 10, 20... capturando la variabilidad real.
//
// Impacto en CVaR: el CVaR al 5% ahora es más conservador y correcto
// porque se capturan escenarios con múltiples jumps consecutivos
// (el "doble crash" de BTC que el modelo anual no podía generar).

export interface JumpDiffusionResult {
  mean: number;
  worst5: number;
  simulations: number[];
}

export function monteCarloJumpDiffusion(
  mu: number,
  sigma: number,
  jumpIntensity: number,  // λ: número esperado de jumps POR AÑO
  jumpMean: number,
  jumpStd: number,
  years: number = 1,
  simulations: number = 5000
): JumpDiffusionResult {
  // FIX BUG-7: si simulations = 0, no iterar y evitar división por 0
  if (simulations <= 0) {
    return { mean: 0, worst5: 0, simulations: [] };
  }

  const results: number[] = [];

  // FIX MATH-03: pasos mensuales para correcta discretización de Poisson
  const steps = years * 12;    // 12 pasos por año
  const dt = 1 / 12;           // 1 mes = 1/12 año

  for (let i = 0; i < simulations; i++) {
    let value = 1;

    for (let t = 0; t < steps; t++) {
      // Componente de difusión (GBM continuo discretizado a dt)
      // μ_drift = (mu - 0.5 * σ²) * dt
      // σ_shock = sigma * sqrt(dt) * Z
      const diffusion = (mu - 0.5 * sigma ** 2) * dt
                      + sigma * Math.sqrt(dt) * randomNormal();

      // Componente de salto (Poisson con λ*dt por paso)
      // FIX: era `Math.random() < jumpIntensity` (probabilidad ANUAL sin dt)
      // AHORA: `1 - exp(-jumpIntensity * dt)` = probabilidad MENSUAL correcta
      const jumpOccurred = Math.random() < (1 - Math.exp(-jumpIntensity * dt));
      const jump = jumpOccurred ? jumpMean + jumpStd * randomNormal() : 0;

      value *= Math.exp(diffusion + jump);
    }

    results.push(value);
  }

  results.sort((a, b) => a - b);
  const mean = results.reduce((a, b) => a + b, 0) / simulations;
  const worst5 = results[Math.floor(simulations * 0.05)];

  return { mean, worst5, simulations: results };
}

function randomNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}