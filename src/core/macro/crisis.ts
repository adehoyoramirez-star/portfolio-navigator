export type MacroRegime = "EXPANSION" | "CONTRACTION" | "CRISIS";

export interface CrisisResult {
  crisisProbability: number;
  regime: MacroRegime;
}

export function detectCrisis(
  vix: number,
  yieldSpread: number,
  creditSpread: number
): CrisisResult {
  const vixComponent = vix;
  // creditSpread y yieldSpread llegan en tanto por uno (0.04 = 4%)
  const creditComponent = creditSpread * 300;
  const curveComponent = Math.max(0, -yieldSpread) * 100;

  const crisisScore = vixComponent * 0.4 + creditComponent * 0.4 + curveComponent * 0.2;

  let regime: MacroRegime = "EXPANSION";
  if (crisisScore > 25) regime = "CRISIS";
  else if (crisisScore > 15) regime = "CONTRACTION";

  return {
    crisisProbability: Math.min(100, Math.max(0, crisisScore)),
    regime,
  };
}