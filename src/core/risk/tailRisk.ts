export function tailRiskOverlay(
  drawdown: number,
  vix: number,
  creditSpread: number
): number {
  if (drawdown < -0.2) return 0.5;
  if (vix > 35 && creditSpread > 2) return 0.4;
  return 1;
}