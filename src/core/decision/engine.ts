// ===============================================
// INSTITUTIONAL MACRO DECISION ENGINE
// ===============================================

export type DecisionInput = {
  erp: number
  liquidity: number
  regimeScore: number
}

export type DecisionOutput = {
  action: "BUY" | "HOLD" | "TRIM"
  conviction: number
  explanation: string
}

export function generateDecision(
  input: DecisionInput
): DecisionOutput {

  const { erp, liquidity, regimeScore } = input

  let action: "BUY" | "HOLD" | "TRIM" = "HOLD"

  // Conviction score 0–100
  const rawScore =
    (erp * 0.4) +
    (liquidity * 0.3) +
    (regimeScore * 0.3)

  const conviction =
    Math.max(0, Math.min(100, rawScore * 100))

  // Decision logic
  if (erp > 0.05 && liquidity > 0.6) {
    action = "BUY"
  } else if (erp < 0.03 || liquidity < 0.4) {
    action = "TRIM"
  }

  const explanation =
    action === "BUY"
      ? "Risk premium attractive and liquidity supportive. Pro-cyclical positioning justified."
      : action === "TRIM"
      ? "Compressed ERP or deteriorating liquidity. Defensive bias recommended."
      : "Neutral macro regime. Maintain exposure without leverage."

  return {
    action,
    conviction,
    explanation
  }
}