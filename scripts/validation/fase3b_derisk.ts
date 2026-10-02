// scripts/validation/fase3b_derisk.ts — FASE 3B · CORRECCIÓN 2
// Compara la cuenta base (cadencia 30d) vs de-risking por EVENTO (Σtarget↓>5pp) en
// 2018-Q4, COVID-2020, 2022 y FULL largo. Criterio preregistrado: se acepta el
// auto-rebalanceo si el MaxDD no empeora en las 3 ventanas Y el turnover FULL ≤ +25%.
import { loadLongDataset, validate } from './data_long';
import { runEngine, simulate, pct } from './sim_core';
import { full, slice, WINDOWS } from './metrics_unified';
import { detectDeRiskEvent, totalTarget } from '../../src/core/portfolio/rebalancer';
import { ASSETS } from '../../src/lib/constants';

(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(110));
  console.log('  FASE 3B · CORRECCIÓN 2 — VALIDACIÓN DEL DE-RISKING POR EVENTO (umbral 5 pp)');
  console.log('='.repeat(110));
  if (!v.valid) { console.log('  NO VÁLIDO'); return; }
  const R = runEngine(ds); const REC = R.recs.length;

  // Alertas = días donde Σtarget cae >5pp respecto del día anterior (detector de src/).
  const allocs = R.recs.map(r => r.allocations as Record<string, number>);
  const alertDays: number[] = [];
  for (let k = 1; k < REC; k++) if (detectDeRiskEvent(totalTarget(allocs[k - 1]), totalTarget(allocs[k]))) alertDays.push(k);
  const years = REC / 365;
  console.log(`  Alertas de de-risking detectadas: ${alertDays.length} en ${years.toFixed(1)} años → ${(alertDays.length / years).toFixed(1)}/año`);
  console.log(`  Primeras: ${alertDays.slice(0, 6).map(k => R.dates[k]).join(', ')}`);

  const base = simulate(ds);
  const evt = simulate(ds, { deRiskTrigger: 0.05 });

  const rows: [string, string, string][] = [['2018-Q4', '2018-10-01', '2018-12-31'], ['COVID', WINDOWS.COVID[0], WINDOWS.COVID[1]], ['2022', '2022-01-01', '2022-12-31']];
  console.log(`\n  ${'ventana'.padEnd(9)} ${'serie'.padEnd(6)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)}`);
  let worstDelta = 0;
  for (const [wn, f, t] of rows) {
    for (const [sn, S] of [['base', base], ['evento', evt]] as [string, typeof base][]) {
      const r = slice(S.twr, S.dates, f, t); if (!r) continue;
      console.log(`  ${wn.padEnd(9)} ${sn.padEnd(6)} ${pct(r.m.cagr).padStart(8)} ${r.m.sharpe.toFixed(3).padStart(7)} ${pct(r.m.maxDD, 1).padStart(8)}`);
    }
    const b = slice(base.twr, base.dates, f, t)!.m.maxDD, e = slice(evt.twr, evt.dates, f, t)!.m.maxDD;
    const d = Math.abs(e) - Math.abs(b); if (d > worstDelta) worstDelta = d;
  }
  const fb = full(base.twr, base.dates), fe = full(evt.twr, evt.dates);
  console.log(`\n  ${'FULL'.padEnd(9)} base    ${pct(fb.cagr).padStart(8)} ${fb.sharpe.toFixed(3).padStart(7)} ${pct(fb.maxDD, 1).padStart(8)}  turnover €${base.turnoverEur.toFixed(0)} costes €${base.costs.toFixed(0)}`);
  console.log(`  ${'FULL'.padEnd(9)} evento  ${pct(fe.cagr).padStart(8)} ${fe.sharpe.toFixed(3).padStart(7)} ${pct(fe.maxDD, 1).padStart(8)}  turnover €${evt.turnoverEur.toFixed(0)} costes €${evt.costs.toFixed(0)}`);

  const turnoverDelta = evt.turnoverEur / base.turnoverEur - 1;
  const maxDDok = worstDelta <= 1e-9;               // no empeora en ninguna ventana
  const turnoverOk = turnoverDelta <= 0.25;         // ≤ +25%
  console.log(`\n  CRITERIO: MaxDD no empeora en las 3 ventanas → ${maxDDok ? 'CUMPLE' : 'NO CUMPLE'} (peor Δ ${(worstDelta * 100).toFixed(1)} pp)`);
  console.log(`  CRITERIO: turnover FULL ≤ +25% → ${turnoverOk ? 'CUMPLE' : 'NO CUMPLE'} (Δ ${(turnoverDelta * 100).toFixed(1)}%)`);
  console.log(`\n  → ${maxDDok && turnoverOk ? 'ACEPTADA (auto-rebalanceo por evento)' : 'RECHAZADA como auto-rebalanceo → SOLO INFORMATIVA (alerta, no dispara órdenes)'}`);
  void ASSETS;
})();
