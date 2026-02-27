// src/core/macro/erp.ts

export interface ERPResult {
  equityRiskPremium: number
  commentary: string
}

export function calculateERP(
  earningsYield: number,
  riskFreeRate: number
): ERPResult {
  const erp = earningsYield - riskFreeRate

  return {
    equityRiskPremium: erp,
    commentary:
      erp > 0
        ? "Equity risk premium positive. Risk assets compensated."
        : "Equity risk premium negative. Risk compensation deteriorating."
  }
}