// ===============================================
// ARCHIVO: src/core/factors/value.ts
// ===============================================
// ANTES: return { valueScore: input.earningsYield }
// → El score era el número crudo (ej: 0.034)
// → Sin contexto: 3.4% en cripto ≠ 3.4% en renta fija
// → Escala incompatible con momentumScore (que va de ~-0.5 a +0.5)
//
// AHORA: z-score cross-sectional dentro del universo de activos
// → Misma escala estadística que momentum
// → 0 = media del universo, +1 = 1 desviación por encima, etc.
// → Output clampado a [-2, +2] para que outliers no dominen Kelly
// ===============================================

export interface ValueInput {
  earningsYield: number; // en decimal: 0.034 = 3.4%
}

export interface ValueResult {
  valueScore: number;        // z-score normalizado [-2, +2]
  rawEarningsYield: number;  // valor original para trazabilidad en el dashboard
  percentileRank: number;    // posición dentro del universo [0, 1] — para mostrar en UI
}

export interface UniverseStats {
  mean: number;
  std: number;
  sortedYields: number[];
}

/**
 * Precalcula estadísticas del universo completo.
 * Llamar UNA vez fuera del loop de activos — no recalcular por activo.
 *
 * Uso en olympusV3.ts:
 *   const universeStats = computeUniverseStats(assets);
 *   for (const asset of assets) {
 *     const value = calculateValue({ earningsYield: asset.earningsYield }, universeStats);
 *   }
 */
export function computeUniverseStats(assets: ValueInput[]): UniverseStats {
  const yields = assets.map(a => a.earningsYield);
  const n = yields.length;

  if (n === 0) return { mean: 0, std: 1, sortedYields: [] };
  if (n === 1) return { mean: yields[0], std: 1, sortedYields: [...yields] };

  const mean = yields.reduce((a, b) => a + b, 0) / n;
  // FIX-VARIANCE (22-Jun-2026): usar n-1 (varianza muestral) en vez de n (poblacional).
  // Con n=6 activos, la diferencia es ~17% → z-scores menos sesgados.
  const variance = n > 1
    ? yields.reduce((sum, y) => sum + (y - mean) ** 2, 0) / (n - 1)
    : 0;
  const std = Math.sqrt(variance);
  const sortedYields = [...yields].sort((a, b) => a - b);

  return {
    mean,
    std: std > 0 ? std : 1, // evitar división por cero si todos los yields son iguales
    sortedYields,
  };
}

/**
 * Calcula el score de valor de un activo normalizado contra su universo.
 *
 * @param input   - El activo a evaluar
 * @param stats   - Estadísticas del universo (de computeUniverseStats)
 */
export function calculateValue(input: ValueInput, stats: UniverseStats): ValueResult {
  const rawZScore = (input.earningsYield - stats.mean) / stats.std;

  // Clamp a [-2, +2]: evita que un outlier (ej: BTC con yield 0 vs ETFs con yield 3-5%)
  // sea penalizado con -∞ y destruya su asignación en Kelly
  const valueScore = Math.max(-2, Math.min(2, rawZScore));

  const percentileRank = computePercentileRank(input.earningsYield, stats.sortedYields);

  return {
    valueScore,
    rawEarningsYield: input.earningsYield,
    percentileRank,
  };
}

// Percentil de un valor dentro de un array ya ordenado
function computePercentileRank(value: number, sortedArray: number[]): number {
  if (sortedArray.length === 0) return 0.5;
  const below = sortedArray.filter(v => v < value).length;
  return below / sortedArray.length;
}