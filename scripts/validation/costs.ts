// scripts/validation/costs.ts — FASE 2A · TEST B
// Costes y slippage reales escalados EN MEMORIA (sin tocar src/).
// Criterio fijado ANTES de correr: robusto si con costes ×2 el Sharpe NO cae más de 0.15.
import { simulateAccount, pct } from './account_core';

console.log('='.repeat(100));
console.log('  TEST B — COSTES Y SLIPPAGE REALES (override en memoria de ASSET_COST_PARAMS)');
console.log('='.repeat(100));
console.log('  Escala applied a halfSpreadBps e impactCoefficient de los 6 activos.');
console.log('  computeTradeCost = FIXED + spread(half) + impacto(raíz-cuadrada).');
console.log('  Criterio (fijado antes): robusto si Sharpe(×2) >= Sharpe(×1) - 0.15\n');

console.log(`  ${'Escala'.padEnd(10)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(8)} ${'MaxDD'.padStart(8)} ${'Turnover'.padStart(11)} ${'Órdenes'.padStart(8)} ${'Coste €'.padStart(9)} ${'Coste %cap'.padStart(11)}`);
console.log('  ' + '-'.repeat(80));
const base = simulateAccount({ costScale: 1 });
let rows = 0;
const res: Record<number, ReturnType<typeof simulateAccount>> = {};
for (const s of [0, 1, 2, 3]) {
  const r = s === 1 ? base : simulateAccount({ costScale: s });
  res[s] = r; rows++;
  const costPct = (r.costs / (r.finalValue + r.contributions)) * 100;
  console.log(`  ×${String(s).padEnd(8)} ${pct(r.cagr).padStart(8)} ${r.sharpe.toFixed(3).padStart(8)} ${pct(r.maxDD, 1).padStart(8)} ${('€' + r.turnoverEur.toFixed(0)).padStart(11)} ${String(r.orders).padStart(8)} ${('€' + r.costs.toFixed(0)).padStart(9)} ${(costPct.toFixed(2) + '%').padStart(11)}`);
}
const d2c = res[1].cagr - res[2].cagr, d2s = res[1].sharpe - res[2].sharpe;
console.log(`\n  Degradación ×1 → ×2 : CAGR ${(d2c * 100).toFixed(2)}pp · Sharpe ${d2s.toFixed(3)}`);
console.log(`  Criterio (ΔSharpe ≤ 0.15): ${d2s <= 0.15 ? 'CUMPLIDO — robusto a ×2' : 'NO CUMPLIDO — frágil a ×2'}`);
const d3s = res[1].sharpe - res[3].sharpe;
console.log(`  Degradación ×1 → ×3 : CAGR ${((res[1].cagr - res[3].cagr) * 100).toFixed(2)}pp · Sharpe ${d3s.toFixed(3)}`);
console.log(`  Ejecuciones de motor: ${rows} (una por escala)`);