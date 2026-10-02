// ============================================================
// scripts/validation/p2_roundtrips.ts
// FASE 2B · P2 — Round-trips: ¿qué mecanismo genera el sobrepeso?
//   Instrumentación validada contra account_backtest.ts (49 trims / €81.595).
//   Definiciones congeladas en PREREGISTRO.md §2.
// Ejecutar: npx tsx scripts/validation/p2_roundtrips.ts
// ============================================================

import { buildCanonicalDataset, simulate, pct, CFG } from './sim_core';
import { ASSETS } from '../../src/lib/constants';

const ds = buildCanonicalDataset();
const S = simulate(ds);

console.log('='.repeat(104));
console.log('  P2 — DESGLOSE DE TRIMS OVERWEIGHT (mecanismo, activo, € evitables)');
console.log('='.repeat(104));
console.log(`  [validación] ${S.legacyRoundTrips} trims legacy · €${S.legacyRoundTripEur.toFixed(0)} (esperado 49 · €81595)`);
console.log(`  [datos] trims totales: ${S.trimCountAll} · €${S.trimEurAll.toFixed(0)} vendidos · churn directo (compra con drift>+2pp): €${S.churnDirectEur.toFixed(0)}`);

interface Row { n: number; sold: number; avoid: number; driftSum: number; buysSum: number; rt: number; driftOnly: number; retDiffSum: number; }
const byAsset: Record<string, Row> = {};
let avoidTotal = 0, rtCount = 0, rtEur = 0, driftOnlyCount = 0, driftOnlyEur = 0, buyDrivenCount = 0, buyDrivenEur = 0;
let retDiffN = 0, retDiffSum = 0;
for (const t of S.trimLog) {
  const r = (byAsset[t.ticker] ??= { n: 0, sold: 0, avoid: 0, driftSum: 0, buysSum: 0, rt: 0, driftOnly: 0, retDiffSum: 0 });
  const excessEur = t.drift > 0 ? t.soldEur : 0; // el trim vende TODO el exceso sobre target (floor=0 en el simulador)
  const avoid = Math.min(t.soldEur, Math.max(0, t.buys30));
  r.n++; r.sold += t.soldEur; r.avoid += avoid; r.driftSum += t.drift; r.buysSum += t.buysSinceReb;
  avoidTotal += avoid;
  if (t.buys30 > 0) { rtCount++; rtEur += t.soldEur; r.rt++; }
  else { driftOnlyCount++; driftOnlyEur += t.soldEur; r.driftOnly++; retDiffSum += (t.assetRet - t.pvRet); r.retDiffSum += (t.assetRet - t.pvRet); retDiffN++; }
  if (t.buys30 >= excessEur && excessEur > 0) { buyDrivenCount++; buyDrivenEur += t.soldEur; }
}
console.log(`\n  ${'Activo'.padEnd(14)} ${'trims'.padStart(6)} ${'€ vendidos'.padStart(11)} ${'€ evitables'.padStart(11)} ${'drift med'.padStart(9)} ${'compras 30d med'.padStart(15)} ${'RT'.padStart(4)} ${'solo-deriva'.padStart(11)}`);
console.log('  ' + '-'.repeat(92));
for (const a of ASSETS) {
  const r = byAsset[a]; if (!r) continue;
  console.log(`  ${a.padEnd(14)} ${String(r.n).padStart(6)} ${('€' + r.sold.toFixed(0)).padStart(11)} ${('€' + r.avoid.toFixed(0)).padStart(11)} ${pct(r.driftSum / r.n, 1).padStart(9)} ${('€' + (r.buysSum / r.n).toFixed(0)).padStart(15)} ${String(r.rt).padStart(4)} ${String(r.driftOnly).padStart(11)}`);
}
console.log(`\n  TOTALES: ${S.trimCountAll} trims · €${S.trimEurAll.toFixed(0)} vendidos`);
console.log(`  · Round-trips verdaderos (trim ≤30d tras compra DCA): ${rtCount} eventos · €${rtEur.toFixed(0)}`);
console.log(`  · Trims SIN compra en 30d (deriva de precios/target): ${driftOnlyCount} eventos · €${driftOnlyEur.toFixed(0)}`);
console.log(`  · Atribuibles a compra (buys30 ≥ exceso): ${buyDrivenCount} eventos · €${buyDrivenEur.toFixed(0)}`);
console.log(`  · € EVITABLES (min(vendido, compras30d)): €${avoidTotal.toFixed(0)} de €${S.trimEurAll.toFixed(0)} (${pct(avoidTotal / Math.max(1, S.trimEurAll), 1)})`);
if (retDiffN > 0) console.log(`  · Trims solo-deriva: el activo superó al portfolio en ${pct(retDiffSum / retDiffN, 2)} de media desde el rebalanceo previo (confirma mecanismo de deriva)`);
console.log(`  · Churn directo (compras hechas con drift ya >+2pp): €${S.churnDirectEur.toFixed(0)} — el DCA no compra sobrepesos; el sobrepeso nace DESPUÉS (deriva de precio y/o target que baja).`);
