// src/lib/risk.ts
import * as math from 'mathjs';

/**
 * Ledoit-Wolf shrinkage covariance estimator
 */
export function ledoitWolfCovariance(returns: number[][]): number[][] {
  const n = returns.length;
  const p = returns[0].length;

  // Usar (math as any) para evitar error de tipos con cov
  const sampleCov = (math as any).cov(returns) as number[][];

  // Calcular media de varianzas (para la matriz objetivo)
  const variances = sampleCov.map((row, i) => row[i]);
  const meanVariance = variances.reduce((a, b) => a + b, 0) / p;

  // Matriz objetivo (diagonal con la media de varianzas)
  const target: number[][] = Array(p).fill(0).map((_, i) =>
    Array(p).fill(0).map((__, j) => i === j ? meanVariance : 0)
  );

  // Calcular shrinkage intensity
  let phi = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      phi += (sampleCov[i][j] - target[i][j]) ** 2;
    }
  }
  let gamma = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      gamma += sampleCov[i][j] ** 2;
    }
  }
  const kappa = phi / gamma;
  const shrinkage = Math.max(0, Math.min(1, kappa / n));

  // Covarianza shrinkeada
  const shrunk: number[][] = Array(p).fill(0).map(() => Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      shrunk[i][j] = shrinkage * target[i][j] + (1 - shrinkage) * sampleCov[i][j];
    }
  }
  return shrunk;
}