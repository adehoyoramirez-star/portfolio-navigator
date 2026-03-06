import { MacroInputs, Regime } from "../types";

export function detectRegime(input: MacroInputs): { regime: Regime; probability: number } {
  const { m2Growth, yieldSpread, vix } = input;
  if (vix > 35) return { regime: "Crisis", probability: 0.85 };
  if (yieldSpread < 0 && m2Growth < 0) return { regime: "Contraction", probability: 0.7 };
  if (m2Growth < 2) return { regime: "Slowdown", probability: 0.6 };
  return { regime: "Expansion", probability: 0.75 };
}