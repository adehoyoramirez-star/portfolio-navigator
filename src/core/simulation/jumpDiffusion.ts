export interface JumpDiffusionResult {
  mean: number;
  worst5: number;
  simulations: number[];
}

export function monteCarloJumpDiffusion(
  mu: number,
  sigma: number,
  jumpIntensity: number,
  jumpMean: number,
  jumpStd: number,
  years: number = 1,
  simulations: number = 5000
): JumpDiffusionResult {
  const results: number[] = [];

  for (let i = 0; i < simulations; i++) {
    let value = 1;
    // Simulamos cada año como un paso (simplificado, se podría hacer mensual)
    for (let t = 0; t < years; t++) {
      const diffusion = (mu - 0.5 * sigma ** 2) + sigma * randomNormal();
      const jumpOccurred = Math.random() < jumpIntensity;
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