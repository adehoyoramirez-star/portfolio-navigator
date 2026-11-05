// scripts/validation/dsr_pbo.ts — FASE 2A · DSR y PBO con el nº REAL de ejecuciones.
//
// FIX-AUDIT-PBO: el bloque "CSCV" anterior barajaba índices de UNA sola serie de
// retornos y remuestreaba IS/OOS con reemplazo. Sin matriz configuraciones ×
// tiempo eso NO mide sobreajuste de selección: medía ruido de bootstrap sobre la
// misma serie. El PBO se ha trasladado a pbo_real.ts (CSCV de verdad sobre la
// rejilla del motor). Aquí ya no se emite ningún número inventado.
//
// FIX-AUDIT-ANNUALIZATION: 252 sesiones por año, no 365.
import { simulateAccount } from './account_core';

const DAYS_PER_YEAR = 252;
const N_EXECUTIONS = Number(process.env.N_EXEC ?? 55);
const base = simulateAccount({ costScale: 1 });
const ret = base.twr;
const n = ret.length;

const obsSharpe = base.sharpe;
console.log('='.repeat(96));
console.log('  DSR / PBO RECALCULADOS CON EL NÚMERO REAL DE EJECUCIONES');
console.log('='.repeat(96));
console.log(`  Serie usada          : retorno diario TWR de la CUENTA REAL (${n} observaciones)`);
console.log(`  Sharpe observado     : ${obsSharpe.toFixed(4)}`);
console.log(`  Nº TOTAL de ejecuciones del motor (Fase 1 + Fase 2A): ${N_EXECUTIONS}`);

// ── DSR (Bailey & López de Prado) ───────────────────────────────────────────
// E[max SR] ≈ sqrt(2 ln N) · SE(SR), con SE(SR) = sqrt(días_por_año / n).
const expMaxSR = (N: number) => Math.sqrt(2 * Math.log(Math.max(1, N))) * Math.sqrt(DAYS_PER_YEAR / n);
const seSR = 1 / Math.sqrt(n / DAYS_PER_YEAR);

function ncdf(x: number) {
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429], p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  return 0.5 * (1 + sign * (1 - ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t * Math.exp(-z * z)));
}

console.log('\n── Deflated Sharpe Ratio ──');
console.log(`  ${'N'.padStart(6)} ${'E[max SR]'.padStart(11)} ${'DSR'.padStart(9)} ${'p-valor'.padStart(9)}  veredicto`);
for (const N of [10, 40, N_EXECUTIONS, 100, 500, 1000]) {
  const e = expMaxSR(N), dsr = (obsSharpe - e) / seSR, pv = 1 - ncdf(dsr);
  console.log(`  ${String(N).padStart(6)} ${e.toFixed(3).padStart(11)} ${dsr.toFixed(3).padStart(9)} ${pv.toFixed(4).padStart(9)}  ${pv < 0.05 ? 'significativo' : 'NO significativo (posible sobreajuste)'}`);
}
console.log(`  E[max SR] con N=${N_EXECUTIONS} = ${expMaxSR(N_EXECUTIONS).toFixed(3)} → Sharpe observado ${obsSharpe.toFixed(3)}`);

// ── PBO ─────────────────────────────────────────────────────────────────────
console.log('\n── PBO (Probability of Backtest Overfitting) ──');
console.log('  NO COMPUTABLE con una sola serie de retornos.');
console.log('  CSCV exige una matriz configuraciones × tiempo (C(S, S/2) particiones IS/OOS).');
console.log('  Implementación real: scripts/validation/cscv.ts · ejecución: npx tsx scripts/validation/pbo_real.ts');
console.log('  El valor que imprimía este script (remuestreo bootstrap de una única serie) no era un PBO.');

console.log('\n' + '='.repeat(96));
