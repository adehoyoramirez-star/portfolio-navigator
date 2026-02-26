export interface LiquidityInput {
  m2Growth: number
  vix: number
  yieldCurveSpread: number
}

export function liquidityScore(input: LiquidityInput): number {
  let score = 0

  if (input.m2Growth > 6) score += 2
  else if (input.m2Growth > 3) score += 1
  else score -= 1

  if (input.vix < 18) score += 1
  if (input.vix > 25) score -= 2

  if (input.yieldCurveSpread > 0) score += 1
  else score -= 1

  return score
}