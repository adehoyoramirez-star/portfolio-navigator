// src/lib/macroModel.ts

export interface MacroInputs {
  vix: number;
  tedSpread: number;
  m2Growth: number;
  erp: number;
}

export interface MacroRegimeResult {
  regime: string;
  riskScore: number;
  targetVol: number;
}

export function macroRegimeModel(inputs: MacroInputs): MacroRegimeResult {

  let score = 0;

  // VIX
  if (inputs.vix > 30) score -= 2;
  else if (inputs.vix > 20) score -= 1;
  else score += 1;

  // TED Spread
  if (inputs.tedSpread < 0) score -= 1;
  else if (inputs.tedSpread > 1) score += 1;

  // Liquidez M2
  if (inputs.m2Growth > 5) score += 1;
  else if (inputs.m2Growth < 2) score -= 1;

  // ERP
  if (inputs.erp > 0.04) score += 1;
  else if (inputs.erp < 0.02) score -= 1;

  let regime: string;
  let targetVol: number;

  if (score <= -2) {
    regime = "RISK_OFF";
    targetVol = 0.10;
  } else if (score >= 2) {
    regime = "RISK_ON";
    targetVol = 0.20;
  } else {
    regime = "NEUTRAL";
    targetVol = 0.14;
  }

  return {
    regime,
    riskScore: score,
    targetVol
  };
}