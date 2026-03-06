import { Regime } from "../types";

export function dynamicExpectedReturn(
  baseReturn: number,
  erp: number,
  liquidity: number,
  regime: Regime
): number {
  const regimeAdj: Record<Regime, number> = {
    Expansion: 0.02,
    Slowdown: 0,
    Contraction: -0.03,
    Crisis: -0.06,
  };
  return baseReturn + erp + liquidity * 0.02 + regimeAdj[regime];
}