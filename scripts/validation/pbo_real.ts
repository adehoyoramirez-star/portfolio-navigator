// ============================================================
// scripts/validation/pbo_real.ts
// FIX-AUDIT-PBO: PBO sobre una matriz REAL configuraciones × tiempo.
//
// Rejilla: lookback ∈ {126, 252, 378} × rebalanceo ∈ {10, 21, 42} → 9
// configuraciones del MOTOR (misma data, mismo coste, misma caja remunerada).
// Es exactamente la decisión que PBO debe auditar: ¿la configuración ganadora
// en la mitad de las ventanas sigue siéndolo fuera de muestra?
//
// Ejecutar: npx tsx scripts/validation/pbo_real.ts
// ============================================================

import { buildCanonicalDataset } from './sim_core';
import { runBacktest } from '../../src/core/backtest/backtestEngine';
import { cscvPbo, sharpeOf } from './cscv';

const ds = buildCanonicalDataset();
const lookbacks = [126, 252, 378];
const rebalances = [10, 21, 42];

const retsByConfig: number[][] = [];
const labels: string[] = [];

for (const lookbackDays of lookbacks) {
  for (const rebalanceDays of rebalances) {
    const out = runBacktest({
      closesHistory: ds.closes,
      macroHistory: {
        vix: ds.macro.vix,
        yieldSpread: ds.macro.tnx.map(v => v),
        creditSpread: ds.macro.hyg.map((h, i) => {
          const l = ds.macro.lqd[i];
          return h > 0 && l > 0 ? Math.max(0, (l / h - 1) * 100) : 2.5;
        }),
        move: ds.macro.move,
        dxyTrend: ds.macro.dxy.map((v, i) => (i >= 21 && ds.macro.dxy[i - 21] > 0 ? v / ds.macro.dxy[i - 21] - 1 : 0)),
        btcVol: ds.macro.btcVol,
      },
      lookbackDays,
      rebalanceDays,
      initialCapital: 10_000,
      transactionCostBps: 15,
    });
    const pv = out.dailyRecords.map(r => r.portfolioValue);
    const rets: number[] = [];
    for (let i = 1; i < pv.length; i++) rets.push(pv[i] / pv[i - 1] - 1);
    retsByConfig.push(rets);
    labels.push(`lb${lookbackDays}/rb${rebalanceDays}`);
  }
}

const T = Math.min(...retsByConfig.map(r => r.length));
const matrix: number[][] = [];
for (let t = 0; t < T; t++) matrix.push(retsByConfig.map(r => r[t]));

console.log('='.repeat(96));
console.log('  PBO REAL (CSCV) — matriz configuraciones × tiempo del MOTOR');
console.log('='.repeat(96));
console.log(`  Configuraciones : ${labels.length} (${labels.join(' · ')})`);
console.log(`  Observaciones   : ${T}`);
console.log('  Sharpe FULL por configuración (252 sesiones/año):');
labels.forEach((l, i) => {
  const r = retsByConfig[i].slice(0, T);
  console.log(`    ${l.padEnd(10)} ${sharpeOf(r).toFixed(3)}`);
});

const res = cscvPbo(matrix, 12);
console.log('\n── CSCV ──');
console.log(`  Particiones IS/OOS : ${res.partitions} (${res.blocks} bloques contiguos)`);
console.log(`  PBO                : ${(res.pbo * 100).toFixed(1)}%`);
console.log(`  PBO veredicto      : ${res.pbo < 0.05 ? 'EXCELENTE' : res.pbo < 0.10 ? 'BUENO' : res.pbo < 0.20 ? 'MODERADO' : 'ALTO — selección inestable'}`);
console.log('\n  Estabilidad por configuración (Sharpe medio IS → OOS):');
labels.forEach((l, i) => {
  console.log(`    ${l.padEnd(10)} IS ${res.meanIsSharpe[i].toFixed(3)}  OOS ${res.meanOosSharpe[i].toFixed(3)}  Δ ${(res.meanOosSharpe[i] - res.meanIsSharpe[i]).toFixed(3)}`);
});
console.log('\n' + '='.repeat(96));
