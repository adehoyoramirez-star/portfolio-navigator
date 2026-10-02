// ============================================================
// scripts/validation/long_run.ts
// FASE 2B · TEST 1b — Runner canónico + cuenta real sobre el dataset largo
// (proxies reales, sin backfill): FULL/IS/OOS + ventanas 2018-Q4, COVID, 2022.
//   · Métricas de ventana sobre TWR (índice TWR, sin aportaciones).
//   · Niveles de kill switch: réplica exacta (P3) — diaria y engine-seen.
//   · Coste de timing venta→reentrada: se entrega en TEST 3 (A vs B, misma data).
// Ejecutar: npx tsx scripts/validation/long_run.ts
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, simulate, metrics, pct, CFG } from './sim_core';
import { TAIL_RISK_CONFIG } from '../../src/core/config/engineConfig';

const KS = TAIL_RISK_CONFIG.KILL_SWITCH;
function level(dd: number): number {
  const x = Math.abs(dd);
  if (x >= KS.L5.threshold) return 5;
  if (x >= KS.L4.threshold) return 4;
  if (x >= KS.L3.threshold) return 3;
  if (x >= KS.L2.threshold) return 2;
  if (x >= KS.L1_5.threshold) return 1.5;
  if (x >= KS.L1.threshold) return 1;
  return 0;
}
const SPLIT = '2023-10-28';
const WINDOWS: [string, string, string][] = [
  ['2018-Q4', '2018-10-01', '2018-12-31'],
  ['COVID-2020', '2020-02-01', '2020-03-31'],
  ['2022', '2022-01-01', '2022-12-31'],
];
function twrVals(twr: number[]): number[] { const vv = [1]; for (const r of twr) vv.push(vv[vv.length - 1] * (1 + r)); return vv; }
function sliceMetrics(twr: number[], dates: string[], from: string, to: string) {
  const rs: number[] = []; const ds2: string[] = [];
  for (let i = 0; i < twr.length; i++) { const d = dates[i + 1]; if (d >= from && d <= to) { rs.push(twr[i]); ds2.push(d); } }
  if (!rs.length) return null;
  const vals = [1]; for (const r of rs) vals.push(vals[vals.length - 1] * (1 + r));
  return { m: metrics(rs, vals, [from, ...ds2]), n: rs.length };
}

(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(116));
  console.log('  TEST 1b — DATASET LARGO: CANÓNICO + CUENTA REAL (proxies reales, sin backfill)');
  console.log('='.repeat(116));
  console.log(`  Dataset: ${ds.dates.length} filas · ${ds.dates[0]} → ${ds.dates[ds.dates.length - 1]} · gate: ${v.valid ? 'VÁLIDO' : 'INVÁLIDO'}`);
  if (!v.valid) { console.log('  NO VÁLIDO → no se concluye sobre crisis.'); return; }

  const R = runEngine(ds);
  const S = simulate(ds);
  const rows: [string, number[], string[], number[]][] = [
    ['MOTOR', R.twr, R.dates, R.recs.map(r => r.cash)],
    ['CUENTA', S.twr, S.dates, S.cashSeries],
  ];

  console.log(`\n── FULL / IS / OOS (split ${SPLIT}) — TWR ──`);
  console.log(`  ${'Serie'.padEnd(14)} ${'n'.padStart(5)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95m'.padStart(8)}`);
  for (const [n, twr, dt] of rows) {
    const m = metrics(twr, twrVals(twr), dt);
    console.log(`  ${n.padEnd(14)} ${String(twr.length).padStart(5)} ${pct(m.cagr).padStart(8)} ${m.sharpe.toFixed(3).padStart(7)} ${pct(m.maxDD, 1).padStart(8)} ${pct(m.cvar95).padStart(8)}`);
    for (const [tag, from, to] of [['IS', '2000-01-01', '2023-10-27'], ['OOS', SPLIT, '2030-01-01']] as [string, string, string][]) {
      const r = sliceMetrics(twr, dt, from, to)!;
      console.log(`  ${(n + ' ' + tag).padEnd(14)} ${String(r.n).padStart(5)} ${pct(r.m.cagr).padStart(8)} ${r.m.sharpe.toFixed(3).padStart(7)} ${pct(r.m.maxDD, 1).padStart(8)} ${pct(r.m.cvar95).padStart(8)}`);
    }
  }
  console.log(`\n  XIRR cuenta real (FULL): ${pct(S.xirr)} · aportaciones €${S.contributions.toFixed(0)} · final €${S.finalValue.toFixed(0)} · costes €${S.costs.toFixed(0)} · órdenes ${S.orders}`);

  console.log(`\n── VENTANAS DE CRISIS (métricas TWR de ventana) ──`);
  console.log(`  ${'Ventana'.padEnd(12)} ${'serie'.padEnd(7)} ${'n'.padStart(4)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95m'.padStart(8)} ${'reg EXP/CON/CRISIS'.padStart(20)} ${'KS diario'.padStart(14)} ${'KS rebal'.padStart(12)} ${'cash≥50%'.padStart(9)} ${'minExp'.padStart(8)}`);
  for (const [wn, from, to] of WINDOWS) {
    for (const [sn, twr, dt, cash] of rows) {
      const r = sliceMetrics(twr, dt, from, to);
      if (!r) { console.log(`  ${wn.padEnd(12)} ${sn.padEnd(7)} sin datos`); continue; }
      const regs = { EXPANSION: 0, CONTRACTION: 0, CRISIS: 0 };
      const ksD: Record<string, number> = {}; const ksS: Record<string, number> = {};
      let nDays = 0, cash50 = 0, cashSum = 0, minExp = 1;
      for (let i = 0; i < R.recs.length; i++) {
        const d = R.dates[i]; if (d < from || d > to) continue;
        nDays++; regs[R.recs[i].regime as keyof typeof regs]++;
        const l = level(R.recs[i].drawdown);
        if (l > 0) { ksD[String(l)] = (ksD[String(l)] ?? 0) + 1; if (R.recs[i].day % 21 === 0) ksS[String(l)] = (ksS[String(l)] ?? 0) + 1; }
        const e = R.recs[i].cash; if (e >= 0.5) cash50++; cashSum += e; if (1 - e < minExp) minExp = 1 - e;
      }
      void cash; // cash de la cuenta se usa vía S.cashSeries cuando sn==='CUENTA'
      let cash50acc = cash50, cashMean = cashSum / Math.max(1, nDays);
      if (sn === 'CUENTA') {
        let c50 = 0, cSum = 0, cN = 0;
        for (let i = 0; i < S.dates.length; i++) { const d = S.dates[i]; if (d < from || d > to) continue; cN++; cSum += cash[i]; if (cash[i] >= 0.5) c50++; }
        if (cN) { cash50acc = c50; cashMean = cSum / cN; }
      }
      const minExpShow = sn === 'MOTOR' ? pct(minExp, 1) : '—';
      const cash50Show = pct(cash50acc / Math.max(1, nDays), 1);
      console.log(`  ${wn.padEnd(12)} ${sn.padEnd(7)} ${String(r.n).padStart(4)} ${pct(r.m.cagr).padStart(8)} ${r.m.sharpe.toFixed(3).padStart(7)} ${pct(r.m.maxDD, 1).padStart(8)} ${pct(r.m.cvar95).padStart(8)} ${(`${regs.EXPANSION}/${regs.CONTRACTION}/${regs.CRISIS}`).padStart(20)} ${JSON.stringify(ksD).padStart(14)} ${JSON.stringify(ksS).padStart(12)} ${cash50Show.padStart(9)} ${minExpShow.padStart(8)}`);
      void cashMean;
    }
  }
  console.log(`\n  "KS diario" = nivel por día (serie completa); "KS rebal" = solo días de rebalanceo (lo que el motor realmente ve).`);
  console.log(`  Coste de timing venta→reentrada: TEST 3 (A vs B sobre esta misma data).`);
})();
