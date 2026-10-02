// ============================================================
// scripts/validation/fase3a_test1.ts
// FASE 3A · TEST 1 — DIAGNÓSTICO DE LA BRECHA MOTOR↔CUENTA (COVID-2020, 2022).
//   Serie diaria: exposición objetivo del motor, exposición invertida de la cuenta,
//   valor, kill switch, órdenes DCA/rebalancer. Hipótesis H1-H5 con evidencia.
// Ejecutar: npx tsx scripts/validation/fase3a_test1.ts
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, simulate, pct } from './sim_core';
import { full, slice, WINDOWS } from './metrics_unified';
import { TAIL_RISK_CONFIG } from '../../src/core/config/engineConfig';
import { ASSETS } from '../../src/lib/constants';

const KS = TAIL_RISK_CONFIG.KILL_SWITCH;
function ksLevel(dd: number): number {
  const x = Math.abs(dd);
  if (x >= KS.L5.threshold) return 5; if (x >= KS.L4.threshold) return 4; if (x >= KS.L3.threshold) return 3;
  if (x >= KS.L2.threshold) return 2; if (x >= KS.L1_5.threshold) return 1.5; if (x >= KS.L1.threshold) return 1; return 0;
}

(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(120));
  console.log('  TEST 1 — DIAGNÓSTICO DE LA BRECHA MOTOR↔CUENTA');
  console.log('='.repeat(120));
  if (!v.valid) { console.log('  NO VÁLIDO'); return; }

  const R = runEngine(ds);
  const REC = R.recs.length;
  const penalty: number[] = new Array(REC).fill(1), volTarget: number[] = new Array(REC).fill(1), ks: number[] = new Array(REC).fill(0);
  for (let k = 0; k < REC; k++) { const reg = R.recs[k].regime as string; penalty[k] = reg === 'EXPANSION' ? 1 : reg === 'CONTRACTION' ? 0.6 : 0.4; ks[k] = ksLevel(R.recs[k].drawdown); }
  const real = { penalty, volTarget, ks };

  const A = simulate(ds, { vetoSeries: real });                 // cadencia 30 (base)
  const A21 = simulate(ds, { vetoSeries: real, rebalanceEvery: 21 });   // corrección H2
  const Astrict = simulate(ds, { vetoSeries: real, strictDeRisk: true }); // corrección H1/H3
  const Adr = simulate(ds, { vetoSeries: real, deRiskTrigger: 0.05 });     // corrección: rebalancear al caer Σtarget >5pp (event-driven)

  const idx = (dates: string[], d: string) => dates.findIndex(x => x >= d);

  for (const [wn, from, to] of [['COVID-2020', '2020-02-01', '2020-04-15'], ['2022', '2022-01-01', '2022-12-31']] as [string, string, string][]) {
    const s0 = idx(A.dates, from), s1 = idx(A.dates, to); const end = s1 < 0 ? A.dates.length : s1;
    console.log(`\n${'─'.repeat(120)}\n  ${wn} — serie diaria (${A.dates[s0]} → ${A.dates[end - 1]})\n${'─'.repeat(120)}`);
    console.log(`  ${'fecha'.padEnd(11)} ${'Σtarget'.padStart(8)} ${'inv.cuenta'.padStart(10)} ${'gap pp'.padStart(7)} ${'motorExp'.padStart(9)} ${'valor'.padStart(9)} ${'KS'.padStart(4)}  órdenes del día`);
    const step = wn === 'COVID-2020' ? 2 : 30;
    for (let i = s0; i < end; i += step) {
      const k = i;
      const orders = A.orderLog.filter(o => o.day === k);
      const oTxt = orders.map(o => `${o.source}:${o.action} ${o.ticker.replace(/\.(DE|F)$/, '')} ${o.notional.toFixed(0)}`).join(' · ') || '—';
      console.log(`  ${A.dates[k].padEnd(11)} ${pct(A.targetTotalSeries[k], 1).padStart(8)} ${pct(A.investedSeries[k], 1).padStart(10)} ${((A.investedSeries[k] - A.targetTotalSeries[k]) * 100).toFixed(1).padStart(7)} ${pct(1 - A.engineCashSeries[k], 1).padStart(9)} ${('€' + A.values[k].toFixed(0)).padStart(9)} ${String(A.ksSeries[k]).padStart(4)}  ${oTxt}`);
    }
    const maxGap = Math.max(...A.investedSeries.slice(s0, end).map((x, i) => x - A.targetTotalSeries[s0 + i]));
    const rebDays = []; for (let i = s0; i < end; i++) if (i % 30 === 0 && i > 0) rebDays.push(i);
    const sellsInReb = rebDays.reduce((s, i) => s + A.orderLog.filter(o => o.day === i && o.source === 'REB' && o.action === 'SELL').length, 0);
    const buysInReb = rebDays.reduce((s, i) => s + A.orderLog.filter(o => o.day === i && o.source === 'REB' && o.action === 'BUY').length, 0);
    console.log(`  → gap máximo cuenta−target: ${(maxGap * 100).toFixed(1)} pp · rebalanceos en ventana: ${rebDays.length} · SELLs: ${sellsInReb} · BUYs: ${buysInReb}`);
  }

  // ── Hipótesis ──
  console.log(`\n${'='.repeat(120)}\n  HIPÓTESIS H1-H5\n${'='.repeat(120)}`);

  // H1: gap persistente en COVID
  let gapDays = 0, covidDays = 0, covidMaxGap = 0;
  { const s0 = idx(A.dates, '2020-02-01'), s1 = idx(A.dates, '2020-04-15'); const end = s1 < 0 ? A.dates.length : s1;
    for (let i = s0; i < end; i++) { covidDays++; const g = A.investedSeries[i] - A.targetTotalSeries[i]; if (g > 0.02) gapDays++; if (g > covidMaxGap) covidMaxGap = g; } }
  const h1 = gapDays > 0.5 * covidDays;
  console.log(`\n  H1 — el rebalancer no vende hacia cash cuando cae la exposición objetivo:`);
  console.log(`     COVID: ${gapDays}/${covidDays} días con exposición real > target + 2pp · gap máximo ${(covidMaxGap * 100).toFixed(1)} pp`);
  console.log(`     → ${h1 ? 'CONFIRMADA (la cuenta no converge al target del motor)' : 'DESCARTADA (converge o el gap es puntual)'}`);

  // FASE 3A — traza A vs A21 en COVID (días de rebalanceo marcados)
  { const s0 = idx(A.dates, '2020-02-18'), s1 = idx(A.dates, '2020-04-06'); const end = s1 < 0 ? A.dates.length : s1;
    console.log(`\n  TRAZA A(30d) vs A21(21d) en COVID — exposición invertida / target; * = rebalanceo`);
    for (let i = s0; i < end; i++) {
      const r30 = i % 30 === 0 ? '*' : ' ', r21 = i % 21 === 0 ? '*' : ' ';
      console.log(`    ${A.dates[i]}  A:${pct(A.investedSeries[i], 1).padStart(6)}${r30}  A21:${pct(A21.investedSeries[i], 1).padStart(6)}${r21}  target:${pct(A.targetTotalSeries[i], 1).padStart(6)}`);
    } }

  // H2: cadencia
  const mddA = full(A.twr, A.dates).maxDD, mdd21 = full(A21.twr, A21.dates).maxDD, mddStrict = full(Astrict.twr, Astrict.dates).maxDD;
  const covA = slice(A.twr, A.dates, ...WINDOWS.COVID)!, cov21 = slice(A21.twr, A21.dates, ...WINDOWS.COVID)!, covStrict = slice(Astrict.twr, Astrict.dates, ...WINDOWS.COVID)!, covDR = slice(Adr.twr, Adr.dates, ...WINDOWS.COVID)!;
  const engineRebsCOVID: string[] = []; for (let k = 0; k < REC; k++) { const d = R.dates[k]; if (d >= '2020-02-01' && d <= '2020-04-15' && k % 21 === 0) engineRebsCOVID.push(d); }
  console.log(`\n  H2 — cadencia (motor 21d vs cuenta 30d):`);
  console.log(`     rebalanceos del MOTOR en COVID: ${engineRebsCOVID.join(', ') || 'ninguno'}`);
  const acctRebs: string[] = []; for (let i = 0; i < A.dates.length; i++) if (i % 30 === 0 && i > 0 && A.dates[i] >= '2020-02-01' && A.dates[i] <= '2020-04-15') acctRebs.push(A.dates[i]);
  console.log(`     rebalanceos de la CUENTA en COVID: ${acctRebs.join(', ') || 'ninguno'}`);
  console.log(`     COVID MaxDD: cuenta-30 ${pct(covA.m.maxDD, 1)} · cuenta-21 ${pct(cov21.m.maxDD, 1)} · strictDeRisk ${pct(covStrict.m.maxDD, 1)}`);
  const h2 = Math.abs(cov21.m.maxDD) < Math.abs(covA.m.maxDD) - 0.005;
  console.log(`     → ${h2 ? `CONFIRMADA (escenario21 mejora ${((Math.abs(covA.m.maxDD) - Math.abs(cov21.m.maxDD)) * 100).toFixed(1)} pp)` : 'DESCARTADA (la cadencia por sí sola no explica la brecha)'}`);

  // H3: drift ≤ 2pp no recortado en días de rebalanceo
  let smallDrift = 0, smallDriftUnsold = 0;
  for (const row of A.rebalLog) { if (row.drift > 0 && row.drift <= 0.02) { smallDrift++; if (row.soldEur < 0.01) smallDriftUnsold++; } }
  console.log(`\n  H3 — driftThreshold 0.02 salta SELLs pequeños:`);
  console.log(`     filas rebalanceo con 0 < drift ≤ 2pp: ${smallDrift} · sin vender: ${smallDriftUnsold}`);
  const h3 = smallDrift > 0 && smallDriftUnsold / Math.max(1, smallDrift) > 0.5;
  console.log(`     → ${h3 ? 'CONFIRMADA PERO SECUNDARIA (el gap de exposición es mucho mayor que 2pp)' : 'NO RELEVANTE (el gap mayoritario supera el umbral)'}`);

  // H4: allocationMultiplier < 0.6 bloquea compras, no ventas (código)
  console.log(`\n  H4 — allocationMultiplier < 0.6 bloquea compras, no genera ventas:`);
  console.log(`     Evidencia de código: rebalancer.ts L~305 (\`if (a.cycleSignal && a.cycleSignal.allocationMultiplier < 0.6) return false;\`) está DENTRO del filtro de \`underweight\`→BUY.`);
  console.log(`     Los SELLs (L~200 trim de techo y L~240 trim de sobrepeso) dependen solo de drift/target.`);
  console.log(`     → CONFIRMADA (por construcción: el multiplicador no ordena de-risking; solo impide comprar)`);

  // H5: DCA recompra
  const dcaBuyInCOVID = A.orderLog.filter(o => o.source === 'DCA' && o.date >= '2020-02-01' && o.date <= '2020-04-15').reduce((s, o) => s + o.notional, 0);
  const rebSellInCOVID = A.orderLog.filter(o => o.source === 'REB' && o.action === 'SELL' && o.date >= '2020-02-01' && o.date <= '2020-04-15').reduce((s, o) => s + o.notional, 0);
  console.log(`\n  H5 — la capa DCA recompra y neutraliza el de-risking:`);
  console.log(`     COVID: compras DCA €${dcaBuyInCOVID.toFixed(0)} vs ventas rebalancer €${rebSellInCOVID.toFixed(0)}`);
  const h5 = dcaBuyInCOVID > 0.3 * Math.max(1, rebSellInCOVID);
  console.log(`     → ${h5 ? 'CONFIRMADA (el DCA contrapesa las ventas)' : 'DESCARTADA (el DCA no es el contrapeso principal)'}`);

  // Cuantificación
  console.log(`\n${'─'.repeat(120)}\n  CUANTIFICACIÓN (pp de MaxDD explicados; corrección solo en el script)\n${'─'.repeat(120)}`);
  console.log(`  COVID MaxDD · base(30d) ${pct(covA.m.maxDD, 1)} · cadencia 21d ${pct(cov21.m.maxDD, 1)} (Δ ${((Math.abs(covA.m.maxDD) - Math.abs(cov21.m.maxDD)) * 100).toFixed(1)} pp) · strictDeRisk ${pct(covStrict.m.maxDD, 1)} (Δ ${((Math.abs(covA.m.maxDD) - Math.abs(covStrict.m.maxDD)) * 100).toFixed(1)} pp) · EVENT-DRIVEN(Σtarget↓>5pp) ${pct(covDR.m.maxDD, 1)} (Δ ${((Math.abs(covA.m.maxDD) - Math.abs(covDR.m.maxDD)) * 100).toFixed(1)} pp)`);
  const fullA = full(A.twr, A.dates), full21 = full(A21.twr, A21.dates), fullStrict = full(Astrict.twr, Astrict.dates), fullDR = full(Adr.twr, Adr.dates);
  console.log(`  FULL  MaxDD · base ${pct(fullA.maxDD, 1)} · 21d ${pct(full21.maxDD, 1)} · strictDeRisk ${pct(fullStrict.maxDD, 1)} · event-driven ${pct(fullDR.maxDD, 1)}`);
  console.log(`  FULL  CAGR  · base ${pct(fullA.cagr)} · 21d ${pct(full21.cagr)} · strictDeRisk ${pct(fullStrict.cagr)} · event-driven ${pct(fullDR.cagr)}`);
  console.log(`  FULL  Sharpe· base ${fullA.sharpe.toFixed(3)} · 21d ${full21.sharpe.toFixed(3)} · strictDeRisk ${fullStrict.sharpe.toFixed(3)} · event-driven ${fullDR.sharpe.toFixed(3)}`);
  console.log(`  (motor FULL: MaxDD ${pct(full(R.twr, R.dates).maxDD, 1)} · CAGR ${pct(full(R.twr, R.dates).cagr)})`);

  // d) Qué ve el usuario
  console.log(`\n${'─'.repeat(120)}\n  d) ¿QUÉ RECIBE EL USUARIO CUANDO EL MOTOR BAJA LA EXPOSICIÓN TOTAL?\n${'─'.repeat(120)}`);
  const dropDay = (() => { for (let i = 1; i < A.dates.length; i++) if (A.dates[i] >= '2020-02-01' && A.dates[i] <= '2020-04-15' && A.targetTotalSeries[i] < A.targetTotalSeries[i - 1] - 0.05) return i; return -1; })();
  if (dropDay > 0) {
    console.log(`  Día con mayor caída de Σtarget: ${A.dates[dropDay]} (Σtarget ${pct(A.targetTotalSeries[dropDay - 1], 1)} → ${pct(A.targetTotalSeries[dropDay], 1)})`);
    const rows = A.rebalLog.filter(r => r.day === dropDay);
    if (rows.length) { console.log(`    ${'ticker'.padEnd(14)} ${'actual'.padStart(8)} ${'target'.padStart(8)} ${'drift'.padStart(8)} ${'vendido'.padStart(9)}`); for (const r of rows) console.log(`    ${r.ticker.padEnd(14)} ${pct(r.currentPct, 1).padStart(8)} ${pct(r.targetPct, 1).padStart(8)} ${pct(r.drift, 1).padStart(8)} ${('€' + r.soldEur.toFixed(0)).padStart(9)}`); }
    else console.log(`    (ese día no fue día de rebalanceo de la cuenta → NO se emitió ninguna orden)`);
    const dayOrders = A.orderLog.filter(o => o.day === dropDay);
    console.log(`    Órdenes ejecutadas ese día: ${dayOrders.map(o => `${o.source} ${o.action} ${o.ticker} €${o.notional.toFixed(0)}`).join(' · ') || 'NINGUNA'}`);
  }
  console.log(`\n  Nota: la app muestra computeRebalanceSuggestions; la cuenta ejecuta esas sugerencias.`);
  console.log(`  Si el día de caída de exposición NO es día de rebalanceo de la cuenta, el usuario no recibe ninguna orden ese día.`);
})();
