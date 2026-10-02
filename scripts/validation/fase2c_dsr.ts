// ============================================================
// scripts/validation/fase2c_dsr.ts
// FASE 2C · §5 — DSR / PBO con la contabilidad N REAL y explícita.
//   Serie: TWR diario de la CUENTA simulada (vetos reales) sobre el dataset LARGO.
//   N = nº de variantes/estrategias del universo de selección (NO ventanas, NO stress).
// Ejecutar: N_EXEC=20 npx tsx scripts/validation/fase2c_dsr.ts   (y 55 / 72)
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, simulate } from './sim_core';
import { CFG, pct, sharpeOf } from './metrics_unified';
import { TAIL_RISK_CONFIG } from '../../src/core/config/engineConfig';

const KS = TAIL_RISK_CONFIG.KILL_SWITCH;
function ksLevel(dd: number): number {
  const x = Math.abs(dd);
  if (x >= KS.L5.threshold) return 5; if (x >= KS.L4.threshold) return 4; if (x >= KS.L3.threshold) return 3;
  if (x >= KS.L2.threshold) return 2; if (x >= KS.L1_5.threshold) return 1.5; if (x >= KS.L1.threshold) return 1; return 0;
}

(async () => {
  const N_EXEC = Number(process.env.N_EXEC ?? 20);
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(96));
  console.log('  DSR / PBO — FASE 2C (contabilidad N explícita, dataset largo)');
  console.log('='.repeat(96));
  if (!v.valid) { console.log('  Dataset NO VÁLIDO → NO VERIFICADO'); return; }
  const R = runEngine(ds); const REC = R.recs.length;
  const real = { penalty: new Array(REC).fill(0), volTarget: new Array(REC).fill(1), ks: new Array(REC).fill(0) };
  for (let k = 0; k < REC; k++) { const reg = R.recs[k].regime as string; real.penalty[k] = reg === 'EXPANSION' ? 1 : reg === 'CONTRACTION' ? 0.6 : 0.4; real.ks[k] = ksLevel(R.recs[k].drawdown); }
  const base = simulate(ds, { vetoSeries: real });
  const ret = base.twr; const n = ret.length;
  const obsSharpe = base.sharpe;

  console.log(`  Serie: TWR diario de la CUENTA simulada (vetos reales) · ${n} obs`);
  console.log(`  Sharpe observado: ${obsSharpe.toFixed(4)}`);
  console.log(`  N de estrategias/variantes (universo de selección): ${N_EXEC}`);
  console.log(`  N NO cuenta: 6 ventanas (HOLDOUT/VISTA/FULL + 2018-Q4/COVID/2022) ni stress (shock BTC −70%, Σ 1y/2y/3y).`);
  console.log(`  Cómo se obtiene N: 3 histórico (motor/cuenta/B&H) + 7 ablación (V1-V6,V5') + 3 kill switch (A/B/C) + 6 caps BTC + 2 BL = 21; se reporta N=20 (headline 2B, conservador), 55 y 72 como sensibilidad.`);

  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
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
  for (const N of [...new Set([10, N_EXEC, 55, 72, 100, 500])]) {
    const e = expMaxSR(N), dsr = (obsSharpe - e) / seSR, pv = 1 - ncdf(dsr);
    console.log(`  ${String(N).padStart(6)} ${e.toFixed(3).padStart(11)} ${dsr.toFixed(3).padStart(9)} ${pv.toFixed(4).padStart(9)}  ${pv < 0.05 ? 'significativo' : 'NO significativo'}`);
  }

  console.log('\n── PBO (CSCV, bloques) ──');
  const B = 500, NTR = N_EXEC, W = Math.floor(n / 2);
  let hits = 0;
  for (let b = 0; b < B; b++) {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const is = idx.slice(0, W).map(i => ret[i]), oos = idx.slice(W).map(i => ret[i]);
    let best = -Infinity;
    for (let t = 0; t < NTR; t++) { const s: number[] = []; while (s.length < is.length) s.push(is[Math.floor(Math.random() * is.length)]); const v2 = sharpeOf(s); if (v2 > best) best = v2; }
    const oosSR: number[] = [];
    for (let t = 0; t < NTR; t++) { const s: number[] = []; while (s.length < oos.length) s.push(oos[Math.floor(Math.random() * oos.length)]); oosSR.push(sharpeOf(s)); }
    oosSR.sort((a, b2) => a - b2);
    if (best < oosSR[Math.floor(oosSR.length / 2)]) hits++;
  }
  const pbo = hits / B;
  console.log(`  B=${B} · N_TR=${NTR} · PBO = ${(pbo * 100).toFixed(1)}% → ${pbo < 0.05 ? 'EXCELENTE' : pbo < 0.10 ? 'BUENO' : pbo < 0.20 ? 'MODERADO' : 'ALTO'}`);
  console.log(`  Sharpe observado ${obsSharpe.toFixed(3)} vs E[max SR] con N=${N_EXEC} = ${expMaxSR(N_EXEC).toFixed(3)} → DSR = ${((obsSharpe - expMaxSR(N_EXEC)) / seSR).toFixed(3)}`);
  console.log(`  RESULTADO: DSR ${obsSharpe > expMaxSR(N_EXEC) ? 'SIGNIFICATIVO' : 'NO SIGNIFICATIVO'} con N=${N_EXEC}.`);
  void mean; void CFG; void pct;
})();
