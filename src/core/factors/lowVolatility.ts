// ===============================================
// ARCHIVO: src/core/factors/lowVolatility.ts
// Factor LOW VOLATILITY — el factor más contraintuitivo de las finanzas
// ===============================================
// La anomalía de baja volatilidad: activos con menor volatilidad
// generan mejores retornos ajustados al riesgo que los de alta volatilidad.
//
// Documentado en literature desde 1972 (Black, Jensen, Scholes).
// Persiste en todos los mercados estudiados durante 50 años.
// Explicación conductual: inversores sobreestiman activos "emocionantes"
// (alta vol) y subestiman los "aburridos" (baja vol).
//
// Para tu portfolio (6 activos, Jul 2026):
//   Oro (PPFB.DE) → vol ~15%, factor muy positivo
//   Vanguard Global (WLG) → vol ~15%, factor positivo por baja vol
//   BTC → vol ~60%, factor muy negativo (compensado por otros factores)
//   Uranio (URNU.DE) → vol ~35%, factor neutral
//   Semis (VVSM.DE) → vol ~30%, factor neutral-negativo
//   Emergentes (EMXC.DE) → vol ~22%, factor neutral
//
// Score: z-score INVERTIDO de la volatilidad del universo
// Alta vol → score negativo (penalización)
// Baja vol → score positivo (prima)
// ===============================================

export interface LowVolInput {
  volatility: number;       // decimal anualizado
  returns12m: number;       // para calcular vol downside
  returns3m: number;
}

export interface LowVolResult {
  lowVolScore: number;          // z-score invertido [-2, +2]
  volRank: number;              // posición en el universo [0=más vol, 1=menos vol]
  downsideVolPenalty: number;   // penalización adicional si vol downside > upside
}

export interface LowVolUniverseStats {
  vols: number[];
  meanVol: number;
  stdVol: number;
}

export function computeLowVolUniverseStats(assets: LowVolInput[]): LowVolUniverseStats {
  const vols = assets.map(a => a.volatility);
  const meanVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const stdVol = Math.sqrt(
    vols.reduce((s, v) => s + (v - meanVol) ** 2, 0) / vols.length
  ) || 1;
  return { vols, meanVol, stdVol };
}

export function calculateLowVol(
  input: LowVolInput,
  stats: LowVolUniverseStats
): LowVolResult {
  // Z-score de vol, INVERTIDO: menor vol = score positivo
  const volZ = -((input.volatility - stats.meanVol) / stats.stdVol);
  const lowVolScore = Math.max(-2, Math.min(2, volZ));

  // Rank: posición en el universo (1 = menor vol = mejor)
  const sortedVols = [...stats.vols].sort((a, b) => a - b);
  const closestVol = sortedVols.reduce((prev, curr) =>
    Math.abs(curr - input.volatility) < Math.abs(prev - input.volatility) ? curr : prev
  );
  const rank = 1 - sortedVols.indexOf(closestVol) / Math.max(1, stats.vols.length - 1);

  // Penalización por asimetría negativa:
  // Si el activo cae mucho más rápido de lo que sube, penalizar
  // Proxy: retorno negativo en 3m con alta vol = asimetría mala
  const downsideVolPenalty = (input.returns3m < -0.05 && input.volatility > stats.meanVol)
    ? -0.3
    : 0;

  return {
    lowVolScore,
    volRank: rank,
    downsideVolPenalty,
  };
}