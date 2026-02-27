export interface ExecutiveSummary {
  liquidityScore: number
  macroRegime: string
}

export function generateExecutiveSummary(): ExecutiveSummary {
  return {
    liquidityScore: 70,
    macroRegime: "Expansion"
  }
}
