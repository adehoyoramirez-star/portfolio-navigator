export function calculateKellyFraction(
  expectedReturn: number,
  variance: number,
  maxFraction: number = 0.5
): number {
  if (variance === 0) return 0;
  const kelly = expectedReturn / variance;
  return Math.max(0, Math.min(maxFraction, kelly));
}