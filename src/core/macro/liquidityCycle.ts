// ===============================================
// ARCHIVO: src/core/macro/liquidityCycle.ts
// ===============================================

export interface LiquidityInput {
  fedBalance: number;   // billones USD
  ecbBalance: number;   // billones EUR
  bojBalance: number;   // billones JPY
  dxy: number;          // Dollar index
}

export type LiquidityRegime = "EXPANSION" | "NEUTRAL" | "CONTRACTION";

export interface LiquidityOutput {
  liquidityGrowth: number;
  dxyTrend: number;
  regime: LiquidityRegime;
}

export function globalLiquiditySignal(input: LiquidityInput): LiquidityOutput {
  const { fedBalance, ecbBalance, bojBalance, dxy } = input;

  // Simulación de crecimiento de liquidez (valores mock)
  const fedGrowth = 0.02;   // +2%
  const ecbGrowth = 0.01;
  const bojGrowth = 0.005;
  const liquidityGrowth = (fedGrowth * 0.5 + ecbGrowth * 0.3 + bojGrowth * 0.2) * 100;

  // Tendencia del dólar (simulada)
  const dxyTrend = (dxy - 100) / 100; // simplificación

  let regime: LiquidityRegime = "NEUTRAL";
  if (liquidityGrowth > 2.5 && dxyTrend < -0.01) {
    regime = "EXPANSION";
  } else if (liquidityGrowth < 0 || dxyTrend > 0.02) {
    regime = "CONTRACTION";
  }

  return { liquidityGrowth, dxyTrend, regime };
}