// src/lib/risk.ts

/**
 * Calcula matriz de covarianza muestral manualmente
 */
function sampleCovarianceMatrix(returns: number[][]): number[][] {
  const n = returns.length;
  const p = returns[0].length;

  const means = Array(p).fill(0);

  // Calcular medias
  for (let j = 0; j < p; j++) {
    for (let i = 0; i < n; i++) {
      means[j] += returns[i][j];
    }
    means[j] /= n;
  }

  // Construir matriz covarianza
  const cov: number[][] = Array.from({ length: p }, () =>
    Array.from({ length: p }, () => 0)
  );

  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let sum = 0;
      for (let t = 0; t < n; t++) {
        sum +=
          (returns[t][i] - means[i]) *
          (returns[t][j] - means[j]);
      }
      const value = sum / (n - 1);
      cov[i][j] = value;
      cov[j][i] = value; // simétrica
    }
  }

  return cov;
}

/**
 * Ledoit-Wolf shrinkage covariance estimator
 */
export function ledoitWolfCovariance(
  returns: number[][]
): number[][] {

  if (!returns || returns.length === 0) {
    throw new Error("Returns matrix is empty");
  }

  const n = returns.length;
  const p = returns[0].length;

  const sampleCov = sampleCovarianceMatrix(returns);

  // Media de varianzas
  const variances = sampleCov.map((row, i) => row[i]);
  const meanVariance =
    variances.reduce((a, b) => a + b, 0) / p;

  // Matriz objetivo (diagonal)
  const target: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) =>
      i === j ? meanVariance : 0
    )
  );

  // Calcular phi
  let phi = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      phi += (sampleCov[i][j] - target[i][j]) ** 2;
    }
  }

  // Calcular gamma
  let gamma = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      gamma += sampleCov[i][j] ** 2;
    }
  }

  if (gamma === 0) {
    return sampleCov;
  }

  const kappa = phi / gamma;
  const shrinkage = Math.max(0, Math.min(1, kappa / n));

  const shrunk: number[][] = Array.from({ length: p }, () =>
    Array.from({ length: p }, () => 0)
  );

  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      shrunk[i][j] =
        shrinkage * target[i][j] +
        (1 - shrinkage) * sampleCov[i][j];
    }
  }

  return shrunk;
}