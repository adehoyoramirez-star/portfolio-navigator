// src/lib/risk.ts
import * as math from 'mathjs';

/**
 * Ledoit-Wolf shrinkage covariance estimator
 * Mezcla la covarianza muestral con una matriz objetivo (diagonal de varianzas)
 * para obtener una estimación más robusta, especialmente con pocos datos.
 *
 * @param returns Matriz de retornos históricos (filas = tiempo, columnas = activos)
 * @returns Matriz de covarianza shrinkeada
 */
export function ledoitWolfCovariance(returns: number[][]): number[][] {
  const n = returns.length;        // número de observaciones (días)
  const p = returns[0].length;      // número de activos

  // 1. Calcular covarianza muestral
 const sampleCov = (math as any).cov(returns) as number[][];

  // 2. Calcular la matriz objetivo (diagonal con la media de varianzas)
  //    Extraemos las varianzas de la diagonal
  const variances = sampleCov.map((row, i) => row[i]);
  const meanVariance = variances.reduce((a, b) => a + b, 0) / p;

  // Matriz objetivo: diagonal con meanVariance, ceros fuera de la diagonal
  const target: number[][] = Array(p).fill(0).map((_, i) =>
    Array(p).fill(0).map((__, j) => i === j ? meanVariance : 0)
  );

  // 3. Calcular el shrinkage intensity (phi - rho) / gamma
  //    Este cálculo sigue la fórmula de Ledoit-Wolf
  let phi = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      phi += (sampleCov[i][j] - target[i][j]) ** 2;
    }
  }

  // gamma: suma de cuadrados de la covarianza muestral
  let gamma = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      gamma += sampleCov[i][j] ** 2;
    }
  }

  // kappa = phi / gamma (truncado entre 0 y 1 / n)
  const kappa = phi / gamma;
  const shrinkage = Math.max(0, Math.min(1, kappa / n));

  // 4. Covarianza shrinkeada = shrinkage * target + (1 - shrinkage) * sample
  const shrunk: number[][] = Array(p).fill(0).map(() => Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      shrunk[i][j] = shrinkage * target[i][j] + (1 - shrinkage) * sampleCov[i][j];
    }
  }

  return shrunk;
}