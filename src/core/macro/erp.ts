export interface ERPResult {
  equityRiskPremium: number
  signal: "RISK_ON" | "RISK_OFF"
}

export function calculateERP(
  earningsYield: number,
  riskFreeRate: number
): ERPResult {
  const erp = earningsYield - riskFreeRate

  return {
    equityRiskPremium: erp,
    signal: erp > 0 ? "RISK_ON" : "RISK_OFF"
  }
}
