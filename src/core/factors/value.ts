export interface ValueInput {
  earningsYield: number;
}

export interface ValueResult {
  valueScore: number;
}

export function calculateValue(input: ValueInput): ValueResult {
  return { valueScore: input.earningsYield };
}