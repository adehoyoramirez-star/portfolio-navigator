// ===============================================
// ARCHIVO: src/core/macro/globalStress.ts
// ===============================================

export interface StressInputs {
  vix: number;
  creditSpread: number;
  move: number;          // MOVE index
  dxyTrend: number;      // tendencia del dólar (en tanto por uno)
  btcVol: number;        // volatilidad de Bitcoin (anualizada en tanto por uno)
}

export type StressRegime = "NORMAL" | "HIGH_RISK" | "CRISIS";

export interface StressResult {
  score: number;
  regime: StressRegime;
}

export function computeGlobalStress(inputs: StressInputs): StressResult {
  let score = 0;

  if (inputs.vix > 25) score += 2;
  else if (inputs.vix > 18) score += 1;

  if (inputs.creditSpread > 5) score += 2;
  else if (inputs.creditSpread > 3) score += 1;

  if (inputs.move > 140) score += 2;
  else if (inputs.move > 110) score += 1;

  if (inputs.dxyTrend > 0.02) score += 1;

  if (inputs.btcVol > 0.8) score += 1;

  let regime: StressRegime = "NORMAL";
  if (score >= 6) regime = "CRISIS";
  else if (score >= 3) regime = "HIGH_RISK";

  return { score, regime };
}