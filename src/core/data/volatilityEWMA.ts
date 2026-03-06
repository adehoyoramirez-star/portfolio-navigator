export function calculateEWMAVolatility(
  returns: number[],
  lambda: number = 0.94
): number {
  if (returns.length === 0) return 0;

  let variance = 0;
  for (let i = 0; i < returns.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] ** 2;
  }
  return Math.sqrt(variance) * Math.sqrt(252);
}