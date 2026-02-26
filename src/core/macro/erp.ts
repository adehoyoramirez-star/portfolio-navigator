export interface ERPInput {
  forwardPER: number
  tenYearYield: number
  earningsGrowth: number
}

export function calculateERP(input: ERPInput): number {
  const earningsYield = 1 / input.forwardPER
  const adjustedYield = earningsYield + input.earningsGrowth
  return adjustedYield - input.tenYearYield
}