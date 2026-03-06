export interface KellyInput {
  expectedReturn: number;
  volatility: number;
}

export interface KellyResult {
  kellyFraction: number;
  rawKelly: number;
}

export function calculateKelly(input: KellyInput): KellyResult {
  const { expectedReturn, volatility } = input;
  const variance = volatility * volatility;
  const rawKelly = variance > 0 ? expectedReturn / variance : 0;
  const cappedKelly = Math.max(0, Math.min(0.5, rawKelly));
  return { kellyFraction: cappedKelly, rawKelly };
}