// scripts/validation/fase3b_costs.ts — FASE 3B · CORRECCIÓN 1
// Reporta el coste de la cuenta simulada (canónico y largo) y el desglose de una orden de
// referencia, para comparar ANTES (medio spread) vs DESPUÉS (spread completo).
import { buildCanonicalDataset, simulate, pct } from './sim_core';
import { loadLongDataset } from './data_long';
import { computeTradeCost, ASSET_COST_PARAMS } from '../../src/core/validation/transactionCosts';

const ds = buildCanonicalDataset();
const S = simulate(ds);
console.log('='.repeat(96));
console.log('  CORRECCIÓN 1 — COSTE DE LA CUENTA SIMULADA');
console.log('='.repeat(96));
console.log(`  CANÓNICO: costes €${S.costs.toFixed(0)} · turnover €${S.turnoverEur.toFixed(0)} · órdenes ${S.orders} · CAGR ${pct(S.cagr)} · Sharpe ${S.sharpe.toFixed(3)} · MaxDD ${pct(S.maxDD, 1)}`);
console.log(`  (referencia 2A con medio spread: €524 · 23.39% · 1.244 · −12.5%)`);

console.log(`\n  Orden de referencia (turnover €10.000 = peso 10% de €100k):`);
console.log(`  ${'ticker'.padEnd(14)} ${'half bps'.padStart(9)} ${'spread'.padStart(10)} ${'impacto'.padStart(9)} ${'fijo'.padStart(6)} ${'total'.padStart(9)}`);
for (const t of Object.keys(ASSET_COST_PARAMS)) {
  const o = computeTradeCost({ ticker: t, oldWeight: 0, newWeight: 0.10, portfolioValueEur: 100_000, priceEur: 100 });
  console.log(`  ${t.padEnd(14)} ${String(ASSET_COST_PARAMS[t].halfSpreadBps).padStart(9)} ${('€' + o.breakdown.spreadCost.toFixed(2)).padStart(10)} ${('€' + o.breakdown.impactCost.toFixed(2)).padStart(9)} ${('€' + o.breakdown.fixedCost.toFixed(2)).padStart(6)} ${('€' + o.totalCostEur.toFixed(2)).padStart(9)}`);
}

(async () => {
  const long = await loadLongDataset();
  const SL = simulate(long);
  console.log(`\n  LARGO (2017-2026): costes €${SL.costs.toFixed(0)} · turnover €${SL.turnoverEur.toFixed(0)} · órdenes ${SL.orders}`);
  console.log(`  (referencia 2C/3A con medio spread: €1268 · XIRR 25.46%)`);
})();
