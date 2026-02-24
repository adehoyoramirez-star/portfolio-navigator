// src/lib/optimizer.ts
/**
 * Multiplicación matriz-vector manual (evita problemas de tipos con mathjs)
 */
function matVecMult(matrix: number[][], vector: number[]): number[] {
  const result: number[] = [];
  for (let i = 0; i < matrix.length; i++) {
    let sum = 0;
    for (let j = 0; j < matrix[i].length; j++) {
      sum += matrix[i][j] * vector[j];
    }
    result.push(sum);
  }
  return result;
}

/**
 * Optimización convexa de media-varianza con penalización de turnover.
 * @param mu Vector de retornos esperados (diarios)
 * @param cov Matriz de covarianza (diaria)
 * @param lambda Parámetro de aversión al riesgo (mayor = más conservador)
 * @param prevWeights Pesos anteriores (para penalizar turnover)
 * @param turnoverPenalty Factor de penalización por turnover
 * @returns Vector de pesos óptimos
 */
export function optimizeMeanVariance(
  mu: number[],
  cov: number[][],
  lambda: number = 3,
  prevWeights?: number[],
  turnoverPenalty: number = 0.1
): number[] {
  const n = mu.length;
  let w = Array(n).fill(1 / n); // inicialización uniforme

  for (let iter = 0; iter < 500; iter++) {
    // Gradiente: -mu + 2 * lambda * cov * w
    const covW = matVecMult(cov, w);
    const gradRisk = covW.map(v => 2 * lambda * v);
    const grad = mu.map((m, i) => -m + gradRisk[i]);

    // Añadir penalización por turnover si hay pesos anteriores
    if (prevWeights) {
      for (let i = 0; i < n; i++) {
        grad[i] += turnoverPenalty * (w[i] - prevWeights[i]);
      }
    }

    // Actualizar pesos en dirección contraria al gradiente
    w = w.map((wi, i) => wi - 0.01 * grad[i]);

    // Proyección al simplex con límites 0.02 - 0.4
    // Límite inferior
    w = w.map(v => Math.max(0.02, v));
    // Normalizar a suma 1
    const sumW = w.reduce((a, b) => a + b, 0);
    w = w.map(v => v / sumW);
    // Límite superior: redistribuir si algún peso excede 0.4
    const maxW = 0.4;
    let over = w.map(v => Math.max(0, v - maxW));
    let excess = over.reduce((a, b) => a + b, 0);
    if (excess > 0) {
      const underCount = w.filter(v => v < maxW).length;
      w = w.map((v, i) => {
        if (v > maxW) return maxW;
        else return v + over[i] * (excess / underCount);
      });
    }
  }
  return w;
}