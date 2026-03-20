// src/core/macro/liquidity.ts

interface LiquidityInput {
  m2Growth: number;      // crecimiento de M2 en %
  vix: number;           // nivel de VIX
  yieldCurveSpread: number; // spread de curva (ej. 10y-2y)
}

/**
 * Calcula un score de liquidez (0-1) basado en datos macro.
 * M2 alto, VIX bajo y curva positiva aumentan el score.
 */
export function liquidityScore(input: LiquidityInput): number {
  const { m2Growth, vix, yieldCurveSpread } = input;
  
  // Normalización simple (ajusta los rangos según tu criterio)
  const m2Score = Math.min(1, Math.max(0, (m2Growth - 2) / 8)); // 2% -> 0, 10% -> 1
  const vixScore = Math.min(1, Math.max(0, (30 - vix) / 20));   // 30 -> 0, 10 -> 1
  const curveScore = Math.min(1, Math.max(0, (yieldCurveSpread + 1) / 2)); // -1% -> 0, 1% -> 1
  
  // Combinación lineal (puedes cambiar pesos)
  const score = m2Score * 0.4 + vixScore * 0.3 + curveScore * 0.3;
  
  return Math.min(1, Math.max(0, score));
}