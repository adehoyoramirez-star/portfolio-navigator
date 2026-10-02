// ============================================================
// scripts/validation/bl_absolute_impl.cts
// FASE 2B · TEST 5 — BL absoluto A/B (criterio PREREGISTRADO §9):
//   se adopta solo si mejora MaxDD Y CVaR95 en crisis sin bajar el Sharpe OOS.
// Ejecutado por bl_absolute.cjs (intercepción en memoria).
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, metrics, pct } from './sim_core';
import { generateViewsExternal } from '../../src/core/portfolio/blackLitterman';

const g = globalThis as any;
const SPLIT = '2023-10-28';
const WINDOWS: [string, string, string][] = [['2018-Q4', '2018-10-01', '2018-12-31'], ['COVID-2020', '2020-02-01', '2020-03-31'], ['2022', '2022-01-01', '2022-12-31']];
function sliceM(twr: number[], dt: string[], from: string, to: string) {
  const rs: number[] = []; const ds2: string[] = [];
  for (let i = 0; i < twr.length; i++) { const d = dt[i + 1]; if (d >= from && d <= to) { rs.push(twr[i]); ds2.push(d); } }
  const vals = [1]; for (const r of rs) vals.push(vals[vals.length - 1] * (1 + r));
  return metrics(rs, vals, [from, ...ds2]);
}

(async () => {
  console.log('='.repeat(112));
  console.log('  TEST 5 — BL ABSOLUTO A/B (confianza × max(0.25, breadth_pos))');
  console.log('='.repeat(112));

  // ── Probe de fórmula: cartera sintética con TODO el universo en negativo ──
  const synth = ['A', 'B', 'C', 'D', 'E', 'F'].map((t, i) => ({ name: t, ticker: t, returns12m: -0.10 - i * 0.01, earningsYield: 0.05, volatility: 0.25 }));
  g.__BL_ON = false;
  const vOff = generateViewsExternal(synth, 'EXPANSION', 6);
  g.__BL_ON = true;
  const vOn = generateViewsExternal(synth, 'EXPANSION', 6);
  console.log('  PROBE (universo 100% negativo, breadth_pos=0):');
  console.log(`    confianzas OFF: [${vOff.map(v => v.confidence.toFixed(3)).join(', ')}] · spreads: [${vOff.map(v => v.expectedReturn.toFixed(3)).join(', ')}]`);
  console.log(`    confianzas ON : [${vOn.map(v => v.confidence.toFixed(3)).join(', ')}] · spreads: [${vOn.map(v => v.expectedReturn.toFixed(3)).join(', ')}]`);
  console.log(`    → la confianza cae ×4 (0.25 → 0.0625); el spread cross-sectional NO cambia (idéntico OFF/ON).`);
  const synthMix = ['A', 'B', 'C', 'D', 'E', 'F'].map((t, i) => ({ name: t, ticker: t, returns12m: i < 3 ? 0.05 : -0.05, earningsYield: 0.05, volatility: 0.25 }));
  g.__BL_ON = true;
  const vMix = generateViewsExternal(synthMix, 'EXPANSION', 6);
  console.log(`    mercado mixto (breadth_pos=0.50): confianza momentum ${vMix[0].confidence.toFixed(3)} (0.25×0.50)`);

  const ds = await loadLongDataset();
  if (!validate(ds).valid) { console.log('  TEST 5 — dataset inválido → NO CONCLUYENTE'); return; }

  g.__BL_ON = false; g.__BL_STATE = null;
  const A = runEngine(ds);
  const integA = g.__BL_STATE !== null;
  g.__BL_ON = true; g.__BL_STATS = { calls: 0, reduced: 0, sumMult: 0 };
  const B = runEngine(ds);
  const stats = g.__BL_STATS;
  console.log(`\n  Integración: función interceptada invocada por el motor: ${integA ? 'SÍ' : 'NO'} · llamadas en B: ${stats.calls} · con confianza reducida: ${stats.reduced} (${pct(stats.reduced / Math.max(1, stats.calls), 1)}) · multiplicador medio ${(stats.sumMult / Math.max(1, stats.calls)).toFixed(3)}`);
  if (!integA) { console.log('  → NO VERIFICADO: la intercepción no llegó al motor.'); return; }

  const rows: [string, string, ReturnType<typeof runEngine>][] = [];
  for (const [n, r] of [['A actual', A], ['B absoluto', B]] as [string, ReturnType<typeof runEngine>][]) {
    const full = metrics(r.twr, (() => { const vv = [1]; for (const x of r.twr) vv.push(vv[vv.length - 1] * (1 + x)); return vv; })(), r.dates);
    const oos = sliceM(r.twr, r.dates, SPLIT, '2030-01-01');
    console.log(`\n  ${n}: FULL CAGR ${pct(full.cagr)} · Sharpe ${full.sharpe.toFixed(3)} · MaxDD ${pct(full.maxDD, 1)} · CVaR95m ${pct(full.cvar95)} · OOS Sharpe ${oos.sharpe.toFixed(3)} · OOS MaxDD ${pct(oos.maxDD, 1)}`);
    for (const [wn, from, to] of WINDOWS) {
      const m = sliceM(r.twr, r.dates, from, to);
      console.log(`      ${wn.padEnd(12)} CAGR ${pct(m.cagr).padStart(9)} · Sharpe ${m.sharpe.toFixed(3).padStart(6)} · MaxDD ${pct(m.maxDD, 1).padStart(7)} · CVaR95m ${pct(m.cvar95).padStart(7)}`);
    }
    rows.push([n, n, r]);
  }
  void rows;

  // ── Criterio preregistrado ──
  const fullA = metrics(A.twr, (() => { const vv = [1]; for (const x of A.twr) vv.push(vv[vv.length - 1] * (1 + x)); return vv; })(), A.dates);
  const fullB = metrics(B.twr, (() => { const vv = [1]; for (const x of B.twr) vv.push(vv[vv.length - 1] * (1 + x)); return vv; })(), B.dates);
  const oosA = sliceM(A.twr, A.dates, SPLIT, '2030-01-01');
  const oosB = sliceM(B.twr, B.dates, SPLIT, '2030-01-01');
  const crisisOK = WINDOWS.every(([, from, to]) => {
    const a = sliceM(A.twr, A.dates, from, to); const b = sliceM(B.twr, B.dates, from, to);
    return b.maxDD >= a.maxDD && b.cvar95 >= a.cvar95;
  });
  const sharpeOK = oosB.sharpe >= oosA.sharpe;
  console.log(`\n── CRITERIO ──`);
  console.log(`  Crisis (MaxDD y CVaR95 mejoran en TODAS las ventanas): ${crisisOK ? 'SÍ' : 'NO'}`);
  console.log(`  Sharpe OOS no baja: A ${oosA.sharpe.toFixed(3)} vs B ${oosB.sharpe.toFixed(3)} → ${sharpeOK ? 'SÍ' : 'NO'}`);
  console.log(`  FULL MaxDD: A ${pct(fullA.maxDD, 1)} vs B ${pct(fullB.maxDD, 1)} · CVaR95: A ${pct(fullA.cvar95)} vs B ${pct(fullB.cvar95)}`);
  console.log(`  VEREDICTO: ${crisisOK && sharpeOK ? 'ADOPTAR' : 'DESCARTAR / NO CONCLUYENTE'}`);
})();
