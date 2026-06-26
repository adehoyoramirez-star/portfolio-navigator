// ===============================================
// ARCHIVO: src/lib/monteCarlo.ts
// Monte Carlo Jump-Diffusion + Cholesky Decomposition
// Extraido de InstitutionalDashboard.tsx — funciones puras,
// sin dependencias de React. Testeables de forma aislada.
// ===============================================

export function monteCarloJumpDiffusion(
  initialCapital: number,
  monthlyContribution: number,
  mu: number,
  sigma: number,
  jumpIntensity: number,
  jumpMean: number,
  jumpStd: number,
  years: number,
  simulations: number = 10000,
  multivariate?: {
    weights: number[];
    mus: number[];
    sigmas: number[];
    covMatrix: number[][];
    jumpIntensityBTC: number;
    jumpMean: number;
    jumpStd: number;
    btcIdx: number;
  },
  disableJumps?: boolean
): { mean: number; median: number; p25: number; p75: number; worst5: number; best95: number; simulations: number[]; muUsed: number } {
  const months = years * 12;
  const finalValues: number[] = [];

  if (multivariate && multivariate.covMatrix.length > 1 && multivariate.weights.length > 1) {
    const n = multivariate.weights.length;
    const monthlyMus = multivariate.mus.map(m => m / 12);
    const monthlySigmas = multivariate.sigmas.map(s => s / Math.sqrt(12));
    const monthlyCov = multivariate.covMatrix.map(row => row.map(v => v / 12));
    const L = choleskyDecomposition(monthlyCov, n);

    for (let sim = 0; sim < simulations; sim++) {
      const assetValues = multivariate.weights.map((w) => initialCapital * w);
      for (let m = 0; m < months; m++) {
        const z = Array.from({ length: n }, () => randomNormal());
        const correlated = Array.from({ length: n }, (_, i) =>
          L[i].reduce((s, lij, j) => s + lij * z[j], 0)
        );
        for (let i = 0; i < n; i++) {
          assetValues[i] += monthlyContribution * multivariate.weights[i];
          const gbmFactor = Math.exp(monthlyMus[i] - 0.5 * monthlySigmas[i] ** 2 + correlated[i]);
          let jumpFactor = 1;
          if (!disableJumps && multivariate.btcIdx >= 0 && i === multivariate.btcIdx) {
            const pJump = 1 - Math.exp(-multivariate.jumpIntensityBTC / 12);
            if (Math.random() < pJump) jumpFactor = 1 + multivariate.jumpMean + multivariate.jumpStd * randomNormal();
          }
          assetValues[i] = assetValues[i] * gbmFactor * Math.max(0, jumpFactor);
        }
      }
      finalValues.push(assetValues.reduce((s, v) => s + v, 0));
    }
  } else {
    const monthlyMu = mu / 12;
    const monthlySigma = sigma / Math.sqrt(12);
    for (let sim = 0; sim < simulations; sim++) {
      let value = initialCapital;
      for (let m = 0; m < months; m++) {
        value += monthlyContribution;
        const diffusion = monthlyMu - 0.5 * monthlySigma ** 2 + monthlySigma * randomNormal();
        const jumpMult = disableJumps ? 1 : (Math.random() < (1 - Math.exp(-jumpIntensity / 12)) ? (1 + jumpMean + jumpStd * randomNormal()) : 1);
        value = value * Math.exp(diffusion) * Math.max(0, jumpMult);
      }
      finalValues.push(value);
    }
  }

  finalValues.sort((a, b) => a - b);
  const nSim = finalValues.length;
  const mean = finalValues.reduce((a, b) => a + b, 0) / nSim;
  const median = finalValues[Math.floor(nSim * 0.50)];
  const p25 = finalValues[Math.floor(nSim * 0.25)];
  const p75 = finalValues[Math.floor(nSim * 0.75)];
  const worst5 = finalValues[Math.floor(nSim * 0.05)];
  const best95 = finalValues[Math.floor(nSim * 0.95)];
  return { mean, median, p25, p75, worst5, best95, simulations: finalValues, muUsed: mu };
}

export function choleskyDecomposition(A: number[][], n: number): number[][] {
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(sum, 1e-10));
      } else {
        L[i][j] = L[j][j] > 1e-12 ? sum / L[j][j] : 0;
      }
    }
  }
  return L;
}

export function randomNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
