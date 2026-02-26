export interface DecisionContext {
  erp: number
  liquidity: number
  regimeScore: number
}

export interface DecisionOutput {
  action: "BUY" | "SELL" | "HOLD"
  conviction: number
  explanation: string
}

export function generateDecision(ctx: DecisionContext): DecisionOutput {
  const score = ctx.erp * 5 + ctx.liquidity + ctx.regimeScore

  if (score > 6)
    return {
      action: "BUY",
      conviction: Math.min(95, score * 10),
      explanation:
        "Liquidez expansiva, prima de riesgo atractiva y régimen constructivo."
    }

  if (score < -3)
    return {
      action: "SELL",
      conviction: Math.min(95, Math.abs(score) * 10),
      explanation:
        "Compresión de prima de riesgo, deterioro macro y tensión de liquidez."
    }

  return {
    action: "HOLD",
    conviction: 50,
    explanation:
      "Entorno mixto sin ventaja estadística clara."
  }
}