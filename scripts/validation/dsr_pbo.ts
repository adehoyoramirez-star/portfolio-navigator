// scripts/validation/dsr_pbo.ts — FASE 2A · Recalculo de DSR y PBO con el nº REAL de ejecuciones.
// Mismo método que scripts/run-institutional-audit.ts (§6 y §7), pero con N = nº total de corridas.
import { simulateAccount } from './account_core';

const N_EXECUTIONS = Number(process.env.N_EXEC ?? 55);
const base = simulateAccount({ costScale: 1 });
const ret = base.twr;
const n = ret.length;

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
const obsSharpe = base.sharpe;
console.log('='.repeat(96));
console.log('  DSR / PBO RECALCULADOS CON EL NÚMERO REAL DE EJECUCIONES');
console.log('='.repeat(96));
console.log(`  Serie usada          : retorno diario TWR de la CUENTA REAL (${n} observaciones)`);
console.log(`  Sharpe observado     : ${obsSharpe.toFixed(4)}`);
console.log(`  Nº TOTAL de ejecuciones del motor (Fase 1 + Fase 2A): ${N_EXECUTIONS}`);

// ── DSR (Bailey & López de Prado) ───────────────────────────────────────────
const expMaxSR = (N: number) => Math.sqrt(2 * Math.log(Math.max(1, N))) * Math.sqrt(365 / n);
const seSR = 1 / Math.sqrt(n / 365);
function ncdf(x: number) {
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429], p = 0.3275911;
  const s = x < 0 ? -1 : 1; x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  return 0.5 * (1 + s * (1 - ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t * Math.exp(-x * x)));
}
console.log('\n── Deflated Sharpe Ratio ──');
console.log(`  ${'N'.padStart(6)} ${'E[max SR]'.padStart(11)} ${'DSR'.padStart(9)} ${'p-valor'.padStart(9)}  veredicto`);
for (const N of [10, 40, N_EXECUTIONS, 100, 500, 1000]) {
  const e = expMaxSR(N), dsr = (obsSharpe - e) / seSR, pv = 1 - ncdf(dsr);
  console.log(`  ${String(N).padStart(6)} ${e.toFixed(3).padStart(11)} ${dsr.toFixed(3).padStart(9)} ${pv.toFixed(4).padStart(9)}  ${pv < 0.05 ? 'significativo' : 'NO significativo (posible sobreajuste)'}`);
}
console.log(`  E[max SR] con N=${N_EXECUTIONS} = ${expMaxSR(N_EXECUTIONS).toFixed(3)} → Sharpe observado ${obsSharpe.toFixed(3)}`);

// ── PBO (CSCV) ──────────────────────────────────────────────────────────────
console.log('\n── PBO (Probability of Backtest Overfitting, CSCV) ──');
const B = 500, NTR = N_EXECUTIONS;
const W = Math.floor(n / 2);
let hits = 0;
for (let b = 0; b < B; b++) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const is = idx.slice(0, W).map(i => ret[i]), oos = idx.slice(W).map(i => ret[i]);
  const sr = (s: number[]) => { const m = mean(s), sd = Math.sqrt(mean(s.map(x => (x - m) ** 2))); return sd > 0 ? (m * 365 - 0.04) / (sd * Math.sqrt(365)) : 0; };
  let best = -Infinity;
  for (let t = 0; t < NTR; t++) {
    const s: number[] = []; while (s.length < is.length) s.push(is[Math.floor(Math.random() * is.length)]);
    const v = sr(s); if (v > best) best = v;
  }
  const oosSR: number[] = [];
  for (let t = 0; t < NTR; t++) {
    const s: number[] = []; while (s.length < oos.length) s.push(oos[Math.floor(Math.random() * oos.length)]);
    oosSR.push(sr(s));
  }
  oosSR.sort((a, b) => a - b);
  if (best < oosSR[Math.floor(oosSR.length / 2)]) hits++;
}
const pbo = hits / B;
console.log(`  B = ${B} bloques CSCV · N_TR = ${NTR} configs por bloque (el nº real de ejecuciones)`);
console.log(`  PBO = ${(pbo * 100).toFixed(1)}%`);
console.log(`  Veredicto: ${pbo < 0.05 ? 'EXCELENTE' : pbo < 0.10 ? 'BUENO' : pbo < 0.20 ? 'MODERADO' : 'ALTO — posible sobreajuste'}`);
console.log('\n' + '='.repeat(96));