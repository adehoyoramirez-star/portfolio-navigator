export function correlationPenalty(correlationMatrix: number[][]): number {
  const n = correlationMatrix.length;
  if (n < 2) return 1;

  let totalCorr = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      totalCorr += correlationMatrix[i][j];
      count++;
    }
  }

  const avgCorr = count > 0 ? totalCorr / count : 0;

  if (avgCorr > 0.7) return 0.6;
  if (avgCorr > 0.5) return 0.8;
  return 1;
}