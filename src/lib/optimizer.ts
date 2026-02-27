// src/lib/optimizer.ts
import * as math from 'mathjs';

export function meanVarianceOptimize(
  mu: number[],
  cov: number[][],
  lambda: number
): number[] {

  const muVec = math.matrix(mu);
  const covMat = math.matrix(cov);

  const invCov = math.inv(covMat) as math.MathType;

  const rawWeights = math.multiply(
    1 / lambda,
    math.multiply(invCov, muVec)
  ) as math.MathType;

  const weightsArray = (rawWeights as any).toArray();

  // Normalizar a 1
  const sum = weightsArray.reduce((a: number, b: number) => a + b, 0);

  return weightsArray.map((w: number) => w / sum);
}