// ===============================================
// ARCHIVO: src/core/dca/smartDCA.ts
// ===============================================

export interface SmartDCAInput {
  rsi: number;
  zScore: number;
  momentum: number;
  cash: number;
}

export type DCAAction = "WAIT" | "SMALL_BUY" | "BUY" | "FULL_BUY";

export interface SmartDCAOutput {
  score: number;
  buyFraction: number;
  action: DCAAction;
}

export function smartDCA(input: SmartDCAInput): SmartDCAOutput {
  let score = 0;

  if (input.momentum < 0) score++;
  if (input.rsi < 45) score++;
  if (input.zScore < -0.75) score++;

  let buyFraction = 0;
  let action: DCAAction = "WAIT";

  if (score === 1) {
    buyFraction = 0.25;
    action = "SMALL_BUY";
  } else if (score === 2) {
    buyFraction = 0.5;
    action = "BUY";
  } else if (score === 3) {
    buyFraction = 1;
    action = "FULL_BUY";
  }

  return { score, buyFraction, action };
}