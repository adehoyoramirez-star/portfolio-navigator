export function averageCorrelation(matrix: number[][]): number {
  let sum = 0, count = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = i + 1; j < matrix.length; j++) {
      sum += matrix[i][j];
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}