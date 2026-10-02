// ============================================================
// scripts/validation/fase2c_test2.ts
// FASE 2C · TEST 2 — EJECUCIÓN CON VETOS REALES.
//   A) cuenta sin vetos DCA (penalty 1,0 · volTarget 1,0 · KS 0)
//   B) cuenta con vetos reales (régimen + volTarget replicado + KS réplica P3)
//   C) motor teórico (runBacktest)
//   Ventanas COVID-2020 / 2022 / FULL. Pregunta: ¿el −30,7% de COVID es límite del
//   simulador o comportamiento real de la capa DCA?
// Ejecutar: npx tsx scripts/validation/fase2c_test2.ts
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, simulate, deriveMacro, CFG, pct } from './sim_core';
import { full, slice, WINDOWS } from './metrics_unified';
import { computeVolTargetMultiplier } from '../../src/core/risk/volatilityTarget';
import { VOLATILITY_CONFIG, TAIL_RISK_CONFIG } from '../../src/core/config/engineConfig';
import { ASSETS } from '../../src/lib/constants';

const KS = TAIL_RISK_CONFIG.KILL_SWITCH;
function ksLevel(dd: number): number {
  const x = Math.abs(dd);
  if (x >= KS.L5.threshold) return 5;
  if (x >= KS.L4.threshold) return 4;
  if (x >= KS.L3.threshold) return 3;
  if (x >= KS.L2.threshold) return 2;
  if (x >= KS.L1_5.threshold) return 1.5;
  if (x >= KS.L1.threshold) return 1;
  return 0;
}

(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(118));
  console.log('  TEST 2 — EJECUCIÓN CON VETOS REALES (cuenta simulada)');
  console.log('='.repeat(118));
  if (!v.valid) { console.log('  Dataset NO VÁLIDO → NO VERIFICADO'); return; }
  console.log(`  Dataset largo ${ds.dates.length} filas · ${ds.dates[0]} → ${ds.dates[ds.dates.length - 1]}`);

  const R = runEngine(ds);
  const REC = R.recs.length;
  const { closes } = ds;

  // ── Serie de vetos del motor (por día de strategy) ──
  const penalty: number[] = new Array(REC).fill(1);
  const volTarget: number[] = new Array(REC).fill(1);
  const ks: number[] = new Array(REC).fill(0);
  let curVT = 1;
  for (let k = 0; k < REC; k++) {
    const rec = R.recs[k];
    const reg = rec.regime as string;
    penalty[k] = reg === 'EXPANSION' ? 1.0 : reg === 'CONTRACTION' ? 0.6 : 0.4;
    ks[k] = ksLevel(rec.drawdown);
    if (k % 21 === 0) {
      const w = ASSETS.map(a => Math.max(0, (rec.allocations as Record<string, number>)[a] ?? 0));
      // vol realizada 63d de la cartera objetivo del motor
      const di = CFG.lookbackDays + k;
      if (di > 63) {
        let s = 0; const ws = w; const rets: number[][] = ASSETS.map(a => { const r: number[] = []; for (let i = di - 62; i <= di; i++) r.push(closes[a][i] / closes[a][i - 1] - 1); return r; });
        const n = rets[0].length;
        for (let i = 0; i < ASSETS.length; i++) for (let j = 0; j < ASSETS.length; j++) { let c = 0; for (let t = 0; t < n; t++) c += rets[i][t] * rets[j][t]; c /= n; s += ws[i] * ws[j] * c; }
        const realizedVol = Math.sqrt(Math.max(0, s) * CFG.dpy);
        curVT = computeVolTargetMultiplier({ targetVol: VOLATILITY_CONFIG.DEFAULT_TARGET_VOL ?? 0.20, realizedVol, regimePenalty: penalty[k] }).multiplier;
      }
    }
    volTarget[k] = curVT;
  }
  const none = { penalty: new Array(REC).fill(1), volTarget: new Array(REC).fill(1), ks: new Array(REC).fill(0) };
  const real = { penalty, volTarget, ks };

  const A = simulate(ds, { vetoSeries: none });
  const B = simulate(ds, { vetoSeries: real });
  const C = R;

  const rows: [string, number[], string[], () => any][] = [
    ['A · cuenta SIN vetos', A.twr, A.dates, () => A],
    ['B · cuenta CON vetos reales', B.twr, B.dates, () => B],
    ['C · motor teórico', C.twr, C.dates, () => null],
  ];

  for (const K of ['FULL', 'COVID', 'Y2022'] as const) {
    const [f, t] = WINDOWS[K];
    console.log(`\n── ${K} (${f}→${t}) ──`);
    console.log(`  ${'Caso'.padEnd(26)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95'.padStart(8)} ${'n'.padStart(5)}`);
    for (const [name, twr, dt] of rows) {
      const r = K === 'FULL' ? { m: full(twr, dt), n: twr.length } : slice(twr, dt, f, t);
      if (!r) { console.log(`  ${name.padEnd(26)} sin datos`); continue; }
      console.log(`  ${name.padEnd(26)} ${pct(r.m.cagr).padStart(8)} ${r.m.sharpe.toFixed(3).padStart(7)} ${pct(r.m.maxDD, 1).padStart(8)} ${pct(r.m.cvar95).padStart(8)} ${String(r.n).padStart(5)}`);
    }
  }

  console.log(`\n── INSTRUMENTACIÓN DE LA CAPA DCA (FULL) ──`);
  console.log(`  ${'Caso'.padEnd(26)} ${'evalDCA'.padStart(8)} ${'días KS>0'.padStart(10)} ${'días vt<1'.padStart(10)} ${'compras n'.padStart(10)} ${'compras €'.padStart(11)} ${'ventas n'.padStart(9)} ${'ventas €'.padStart(10)} ${'turnover €'.padStart(11)} ${'costes €'.padStart(9)} ${'cash%med'.padStart(9)}`);
  const inst = (n: string, S: any) => console.log(`  ${n.padEnd(26)} ${String(S.dcaEvalDays).padStart(8)} ${String(S.ksBlockedDays).padStart(10)} ${String(S.vtBlockedDays).padStart(10)} ${String(S.dcaBuyCount).padStart(10)} ${('€' + S.dcaBuyEur.toFixed(0)).padStart(11)} ${String(S.sellCount).padStart(9)} ${('€' + S.sellEur.toFixed(0)).padStart(10)} ${('€' + S.turnoverEur.toFixed(0)).padStart(11)} ${('€' + S.costs.toFixed(0)).padStart(9)} ${pct(S.cashMean, 1).padStart(9)}`);
  inst('A · sin vetos', A);
  inst('B · vetos reales', B);
  console.log(`  C · motor teórico: n/a (serie de pesos objetivo del backtest del motor; ver TEST 1)`);
  console.log(`  Nota: el motor solo ve el KS en rebalanceos (21d) → ksBlockedDays en la capa DCA es la exposición real.`);
  console.log(`  XIRR · A ${pct(A.xirr)} · B ${pct(B.xirr)} · Aportaciones €${A.contributions.toFixed(0)} · Final A €${A.finalValue.toFixed(0)} · B €${B.finalValue.toFixed(0)}`);

  // ── Responder la pregunta específica ──
  const coA = slice(A.twr, A.dates, ...WINDOWS.COVID)!;
  const coB = slice(B.twr, B.dates, ...WINDOWS.COVID)!;
  const coC = slice(C.twr, C.dates, ...WINDOWS.COVID)!;
  const improved = Math.abs(coB.m.maxDD) < Math.abs(coA.m.maxDD) - 0.02;
  console.log(`\n── RESPUESTA: ¿el MaxDD de COVID es límite del simulador o comportamiento real? ──`);
  console.log(`  COVID MaxDD · A (sin vetos) ${pct(coA.m.maxDD, 1)} · B (vetos reales) ${pct(coB.m.maxDD, 1)} · C (motor) ${pct(coC.m.maxDD, 1)}`);
  console.log(`  → ${improved ? 'Los vetos reales REDUCEN el MaxDD >2pp: el −30,7% era límite del simulador sin vetos.' : 'Los vetos reales NO cambian el MaxDD (>2pp): la caída NO es un artefacto del simulador, sino comportamiento real de la capa DCA en ventanas donde el motor no rebalancea.'}`);
  console.log(`  RESULTADO: ${improved ? 'CONFIRMADO (artefacto del simulador corregido)' : 'NO CONFIRMADO (no es artefacto del simulador)'}`);
})();
