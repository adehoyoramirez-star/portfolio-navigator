// ============================================================
// scripts/validation/ks_abc.ts
// FASE 2B · TEST 3 — Kill switch A/B/C (criterio PREREGISTRADO §7):
//   A actual · B sin kill switch (umbrales → 99) · C umbrales ×0.5.
//   A se justifica vs B si (MaxDD_B − MaxDD_A) ≥ 5pp Y CVaR95(A) mejor Y CAGR_A ≥ CAGR_B − 2pp.
//   Override SOLO en memoria (TAIL_RISK_CONFIG.KILL_SWITCH); src/ intacto.
// Ejecutar: npx tsx scripts/validation/ks_abc.ts
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, metrics, pct, CFG } from './sim_core';
import { TAIL_RISK_CONFIG } from '../../src/core/config/engineConfig';

const KS = TAIL_RISK_CONFIG.KILL_SWITCH as any;
const ORIG = JSON.parse(JSON.stringify(KS));
type Variant = 'A' | 'B' | 'C';
function setVariant(v: Variant) {
  const mul = v === 'C' ? 0.5 : 1;
  const off = v === 'B';
  for (const key of ['L1', 'L1_5', 'L2', 'L3', 'L4', 'L5']) {
    KS[key].threshold = off ? 99 : ORIG[key].threshold * mul;
  }
}
const SPLIT = '2023-10-28';
const WINDOWS: [string, string, string][] = [['2018-Q4', '2018-10-01', '2018-12-31'], ['COVID-2020', '2020-02-01', '2020-03-31'], ['2022', '2022-01-01', '2022-12-31']];
function twrVals(twr: number[]): number[] { const vv = [1]; for (const r of twr) vv.push(vv[vv.length - 1] * (1 + r)); return vv; }
function sliceM(twr: number[], dt: string[], from: string, to: string) {
  const rs: number[] = []; const ds2: string[] = [];
  for (let i = 0; i < twr.length; i++) { const d = dt[i + 1]; if (d >= from && d <= to) { rs.push(twr[i]); ds2.push(d); } }
  const vals = [1]; for (const r of rs) vals.push(vals[vals.length - 1] * (1 + r));
  return metrics(rs, vals, [from, ...ds2]);
}

(async () => {
  const ds = await loadLongDataset();
  if (!validate(ds).valid) { console.log('TEST 3 — dataset inválido → NO CONCLUYENTE'); return; }
  const runs: Record<Variant, ReturnType<typeof runEngine>> = {} as any;
  for (const v of ['A', 'B', 'C'] as Variant[]) { setVariant(v); runs[v] = runEngine(ds); }
  setVariant('A');
  console.log('='.repeat(112));
  console.log('  TEST 3 — KILL SWITCH A/B/C (dataset largo, umbrales override en memoria)');
  console.log('='.repeat(112));

  const rows: [string, Variant, string, string][] = [];
  for (const v of ['A', 'B', 'C'] as Variant[]) rows.push([`KS-${v} FULL`, v, '2000-01-01', '2030-01-01']);
  for (const [wn, from, to] of WINDOWS) for (const v of ['A', 'B'] as Variant[]) rows.push([`KS-${v} ${wn}`, v, from, to]);
  console.log(`  ${'Serie'.padEnd(20)} ${'CAGR'.padStart(9)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95m'.padStart(8)} ${'vol'.padStart(7)} ${'cash>50%'.padStart(9)}`);
  console.log('  ' + '-'.repeat(76));
  const res: Record<string, ReturnType<typeof sliceM>> = {};
  for (const [label, v, from, to] of rows) {
    const r = runs[v];
    const m = sliceM(r.twr, r.dates, from, to);
    res[label] = m;
    let c50 = 0, n = 0;
    for (let i = 0; i < r.recs.length; i++) { const d = r.dates[i]; if (d < from || d > to) continue; n++; if (r.recs[i].cash >= 0.5) c50++; }
    console.log(`  ${label.padEnd(20)} ${pct(m.cagr).padStart(9)} ${m.sharpe.toFixed(3).padStart(7)} ${pct(m.maxDD, 1).padStart(8)} ${pct(m.cvar95).padStart(8)} ${pct(m.vol, 1).padStart(7)} ${pct(c50 / Math.max(1, n), 1).padStart(9)}`);
  }

  // ── Criterio preregistrado ──
  const crit = (label: string, a: ReturnType<typeof sliceM>, b: ReturnType<typeof sliceM>) => {
    const d1 = b.maxDD - a.maxDD; const d2 = a.cvar95 > b.cvar95; const d3 = a.cagr >= b.cagr - 0.02;
    console.log(`  ${label.padEnd(14)} ΔMaxDD(B−A) ${pct(d1, 1)} (≥5pp: ${d1 >= 0.05 ? 'SÍ' : 'NO'}) · CVaR95(A) ${pct(a.cvar95)} vs ${pct(b.cvar95)} (mejor: ${d2 ? 'SÍ' : 'NO'}) · CAGR A ${pct(a.cagr)} vs B ${pct(b.cagr)} (≥B−2pp: ${d3 ? 'SÍ' : 'NO'})`);
    return d1 >= 0.05 && d2 && d3;
  };
  console.log('\n── CRITERIO (A justificado vs B) ──');
  const fullOk = crit('FULL', res['KS-A FULL'], res['KS-B FULL']);
  for (const [wn] of WINDOWS) crit(wn, res[`KS-A ${wn}`], res[`KS-B ${wn}`]);
  console.log(`  VEREDICTO: ${fullOk ? 'MANTENER kill switch' : 'NO SE JUSTIFICA en FULL con el criterio preregistrado'}`);

  // ── Coste de timing (A vs B): episodios = rachas de rebalanceos con KS≥1 en A ──
  console.log('\n── COSTE DE TIMING (episodios de de-risk de A vs B, mismas fechas) ──');
  const A = runs['A'], B = runs['B'];
  const rebIdx = A.recs.map((r, i) => (r.day % CFG.rebalanceDays === 0 ? i : -1)).filter(i => i >= 0);
  const lvl = (dd: number): number => { const x = Math.abs(dd); if (x >= 0.32) return 5; if (x >= 0.25) return 4; if (x >= 0.20) return 3; if (x >= 0.15) return 2; if (x >= 0.135) return 1.5; if (x >= 0.12) return 1; return 0; };
  const active = rebIdx.filter(i => lvl(A.recs[i].drawdown) >= 1);
  let epStart: number | null = null; const episodes: [number, number][] = [];
  for (let j = 0; j < rebIdx.length; j++) {
    const i = rebIdx[j]; const isActive = active.includes(i);
    if (isActive && epStart === null) epStart = i;
    if (!isActive && epStart !== null) { episodes.push([epStart, i]); epStart = null; }
  }
  if (epStart !== null) episodes.push([epStart, rebIdx[rebIdx.length - 1]]);
  let totalCost = 0;
  console.log(`  Episodios: ${episodes.length}`);
  for (const [i0, i1] of episodes) {
    const rA = A.values[i1] / A.values[i0] - 1; const rB = B.values[i1] / B.values[i0] - 1;
    const cost = rB - rA; totalCost += cost;
    console.log(`    ${A.dates[i0]} → ${A.dates[i1]}  A ${pct(rA)} · B ${pct(rB)} · coste timing ${pct(cost)}`);
  }
  console.log(`  Coste de timing TOTAL (suma de episodios): ${pct(totalCost)} (positivo = el KS costó rentabilidad; negativo = la ahorró)`);
})();
