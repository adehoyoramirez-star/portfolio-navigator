// ================================================
// ARCHIVO: src/core/backtest/composite.ts
// Fórmulas puras del Composite Strategy (Olympus Core + BTC Satellite).
// Centraliza la fórmula composite que antes vivía en 7 sitios duplicados
// (InstitutionalDashboard ×4 + compositeMetrics + BacktestPanel + tests).
// Ver PRE-IMPLEMENTATION AUDIT satélite 20% (Rounds 8-9).
//
//   compositeAlloc(BTC)  = engineAlloc × (olympusPct/100) + (100−olympusPct)/100
//   compositeAlloc(otro) = engineAlloc × (olympusPct/100)
//
// INVARIANTE AUDITADA (Rounds 8-9, dataset EUR real 2022-2026):
//   btcTotalExposure = btcSat + (1−btcSat) × BTC_motor ≈ 30%
//   → con olympusPct = 80 (satélite 20%) y BTC_motor 13% (media del motor):
//     total = 20% + 80% × 13% = 30,4%. Rango plausible [27,0%, 33,7%]
//     para olympusPct ∈ [78, 82] y BTC_motor ∈ [11%, 15%].
// NOTA: es una propiedad de TARGET medio, no un cap diario (el drift entre
// rebalances puede superar 30% en rallies; documentado en Round 9).
// ================================================

/** Fracción del portfolio asignada al satélite BTC buy & hold. olympusPct ∈ [0, 100]. */
export function btcSatPct(olympusPct: number): number {
  return (100 - olympusPct) / 100;
}

/** Fracción del portfolio gestionada por el motor Olympus. */
export function olyPct(olympusPct: number): number {
  return olympusPct / 100;
}

/**
 * Target composite de un activo tras mezclar el motor con el satélite BTC.
 * - BTC-EUR: engineAlloc × olyPct + btcSat  (el satélite se suma solo a BTC)
 * - resto:   engineAlloc × olyPct            (escalado proporcional)
 * Paridad exacta con la fórmula inline histórica (tests de invariante).
 */
export function compositeTarget(engineAlloc: number, olympusPct: number, isBtc: boolean): number {
  return isBtc
    ? engineAlloc * olyPct(olympusPct) + btcSatPct(olympusPct)
    : engineAlloc * olyPct(olympusPct);
}

/**
 * Exposición BTC TOTAL de la cartera (satélite + BTC interno del motor).
 * engineBtcWeight debe ser la allocation ACTUAL del motor (fracción 0-1);
 * en producción viene de engineResult.allocations (incluye cycle top en live).
 */
export function btcTotalExposure(olympusPct: number, engineBtcWeight: number): number {
  return btcSatPct(olympusPct) + olyPct(olympusPct) * engineBtcWeight;
}
