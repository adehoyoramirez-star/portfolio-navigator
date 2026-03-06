export function volatilityMultiplier(targetVol: number, realizedVol: number): number {
  if (realizedVol === 0) return 1;
  const multiplier = targetVol / realizedVol;
  return Math.max(0.3, Math.min(1.5, multiplier));
}