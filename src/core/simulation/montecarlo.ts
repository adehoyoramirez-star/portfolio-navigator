export interface MonteCarloResult {
  expectedReturn: number
  volatility: number
}

export function runMonteCarlo(
  mean: number,
  stdDev: number
): MonteCarloResult {
  return {
    expectedReturn: mean,
    volatility: stdDev
  }
}