export function correlationPenalty(correlationMatrix: number[][]): number {
  const n = correlationMatrix.length;
  if (n < 2) return 1;

  let totalCorrAbs = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      totalCorrAbs += Math.abs(correlationMatrix[i][j]);
      count++;
    }
  }

  // FIX-CORR-ABS (22-Jun-2026): usar valor absoluto de correlaciones.
  // Correlaciones negativas (ej: BTC↔oro = -0.05) reducían la media
  // artificialmente → penalización no se activaba cuando debía.
  // Con abs(), el promedio refleja la magnitud real de comovimiento.
  const avgCorr = count > 0
    ? totalCorrAbs / count
    : 0;

  if (avgCorr > 0.7) return 0.6;
  if (avgCorr > 0.5) return 0.8;
  return 1;
}