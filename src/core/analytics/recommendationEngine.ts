export interface LiquidityMetrics {
  vix: number
  dollarIndex: number
  fedBalanceSheet: number
  creditSpreads: number
}

export function calculateLiquidityScore(data: LiquidityMetrics): number {
  let score = 0

  if (data.vix < 20) score += 2
  if (data.vix > 30) score -= 2

  if (data.dollarIndex < 102) score += 1
  if (data.creditSpreads < 1.5) score += 2
  if (data.fedBalanceSheet > 8000000) score += 1

  return score
}
