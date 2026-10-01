// scripts/validation/robustness.ts — FASE 2A · TEST C
// (a) 36 offsets de inicio cada 10 días durante 12 meses
// (b) Bootstrap por bloques (21d) del retorno diario de la cuenta
// Criterio fijado ANTES: robusto si P5 del Sharpe > 0.5.
import { simulateAccount, pct, type SimResult } from './account_core';

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

console.log('='.repeat(100));
console.log('  TEST C — ROBUSTEZ A LA FECHA DE INICIO');
console.log('='.repeat(100));

console.log('\n── (a) 36 OFFSETS, uno cada 10 días durante 12 meses ──');
const runs: SimResult[] = [];
const startDate = (r: SimResult) => r.dates[0];
const rows: string[] = [];
for (let o = 0; o < 360; o += 10) {
  const r = simulateAccount({ startOffset: o });
  runs.push(r);
  rows.push(`  +${String(o).padStart(3)}d  inicio ${r.dates[0]}  ${pct(r.cagr).padStart(7)}  ${r.sharpe.toFixed(3).padStart(6)}  ${pct(r.maxDD, 1).padStart(7)}  ${pct(r.maxDD - r.engineMaxDD, 1).padStart(8)}`);
}
console.log(rows.join('\n'));

const cagrs = runs.map(r => r.cagr), sharpes = runs.map(r => r.sharpe), mdds = runs.map(r => r.maxDD);
const row = (n: string, a: number[], f: (x: number) => string) =>
  `  ${n.padEnd(10)} ${f(q(a, 0.05)).padStart(10)} ${f(q(a, 0.5)).padStart(10)} ${f(q(a, 0.95)).padStart(10)} ${f(Math.min(...a)).padStart(10)} ${f(Math.max(...a)).padStart(10)}`;
console.log('\n  ' + 'métrica'.padEnd(10) + 'P5'.padStart(10) + 'mediana'.padStart(10) + 'P95'.padStart(10) + 'min'.padStart(10) + 'max'.padStart(10));
console.log('  ' + '-'.repeat(60));
console.log(row('CAGR', cagrs, x => pct(x)));
console.log(row('Sharpe', sharpes, x => x.toFixed(3)));
console.log(row('MaxDD', mdds, x => pct(x, 1)));

const p5s = q(sharpes, 0.05);
console.log(`\n  Criterio (P5 Sharpe > 0.5): ${p5s > 0.5 ? 'CUMPLIDO — robusto' : `NO CUMPLIDO — P5=${p5s.toFixed(3)}`}`);
console.log(`  Corridas de motor ejecutadas: ${runs.length} (offsets 0..350, paso 10)`);

console.log('\n── (b) BOOTSTRAP POR BLOQUES (bloque=21d, 10.000 remuestreos) ──');
const base = runs[0];
const ret = base.twr;
const NB = 10000, blk = 21;
const bS: number[] = [], bC: number[] = [];
for (let b = 0; b < NB; b++) {
  const samp: number[] = [];
  while (samp.length < ret.length) {
    const st = Math.floor(Math.random() * Math.max(1, ret.length - blk));
    for (let k = 0; k < blk; k++) samp.push(ret[st + k]);
  }
  const s = samp.slice(0, ret.length);
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((x, r) => x + (r - m) ** 2, 0) / s.length);
  bS.push(sd > 0 ? (m * 365 - 0.04) / (sd * Math.sqrt(365)) : 0);
  let g = 1; for (const r of s) g *= (1 + r);
  bC.push(Math.pow(Math.max(1e-6, g), 365 / s.length) - 1);
}
const show = (n: string, a: number[], f: (x: number) => string) =>
  `  ${n.padEnd(8)} P5 ${f(q(a, 0.05)).padStart(9)} | P25 ${f(q(a, 0.25)).padStart(9)} | P50 ${f(q(a, 0.5)).padStart(9)} | P75 ${f(q(a, 0.75)).padStart(9)} | P95 ${f(q(a, 0.95)).padStart(9)}`;
console.log(show('Sharpe', bS, x => x.toFixed(3)));
console.log(show('CAGR', bC, x => pct(x)));
console.log(`  IC 95% Sharpe : [${q(bS, 0.025).toFixed(3)}, ${q(bS, 0.975).toFixed(3)}]  · observado ${base.sharpe.toFixed(3)}`);
console.log(`  IC 95% CAGR   : [${pct(q(bC, 0.025))}, ${pct(q(bC, 0.975))}]  · observado ${pct(base.cagr)}`);
console.log(`  Nº total de EJECUCIONES del motor en esta fase (Fase 1 + 2A) se reporta en el informe.`);