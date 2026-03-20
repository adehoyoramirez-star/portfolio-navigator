// ===============================================
// ARCHIVO: src/core/crypto/btcSignal.ts
// ===============================================

export interface BTCSignalInput {
  rsi: number;
  zScore: number;
  return1m: number;  // retorno mensual en tanto por uno
}

export type BTCSignal = "NONE" | "WATCH" | "BUY" | "STRONG_BUY";

export interface BTCSignalOutput {
  score: number;
  signal: BTCSignal;
}

export function btcTacticalSignal(input: BTCSignalInput): BTCSignalOutput {
  let score = 0;

  if (input.rsi < 35) score++;
  if (input.zScore < -1.5) score++;
  if (input.return1m < -0.08) score++;

  let signal: BTCSignal = "NONE";
  if (score === 1) signal = "WATCH";
  else if (score === 2) signal = "BUY";
  else if (score === 3) signal = "STRONG_BUY";

  return { score, signal };
}