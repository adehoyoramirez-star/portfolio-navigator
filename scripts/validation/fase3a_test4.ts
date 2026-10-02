// ============================================================
// scripts/validation/fase3a_test4.ts
// FASE 3A · TEST 4 — RIESGO BTC DE LA CUENTA COMPLETA (corrección).
//   RC_i = w_i·(Σw)_i / (wᵀΣw), Σ de LOG-retornos diarios (anualizada solo para la vol).
//   Pesos: satélite btcSatPct(80)=0.20 + motor olyPct(80)×w_BTC + resto del motor.
//   Fuente: src/core/backtest/composite.ts; default olympusPct=80 (InstitutionalDashboard.tsx:464).
// Ejecutar: npx tsx scripts/validation/fase3a_test4.ts
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, pct, simulate } from './sim_core';
import { full, slice, WINDOWS } from './metrics_unified';
import { btcSatPct, olyPct } from '../../src/core/backtest/composite';
import { ASSETS } from '../../src/lib/constants';

const OLY = 80;
const LOG = (a: number, b: number) => Math.log(a / b);

(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(116));
  console.log('  TEST 4 — RIESGO BTC DE LA CUENTA COMPLETA (RC con log-retornos)');
  console.log('='.repeat(116));
  if (!v.valid) { console.log('  NO VÁLIDO'); return; }
  const R = runEngine(ds); const REC = R.recs.length; const N = ASSETS.length;
  const lb = 252;
  console.log(`  btcSatPct(${OLY}) = ${pct(btcSatPct(OLY), 0)} · olyPct(${OLY}) = ${pct(olyPct(OLY), 0)} · fuente composite.ts / dashboard:464`);

  // Pesos por día
  const compW: Record<string, number>[] = R.recs.map(r => { const e = r.allocations as Record<string, number>; const t: Record<string, number> = {}; for (const a of ASSETS) t[a] = (e[a] ?? 0) * olyPct(OLY) + (a === 'BTC-EUR' ? btcSatPct(OLY) : 0); return t; });
  const motorW: Record<string, number>[] = R.recs.map(r => r.allocations as Record<string, number>);
  const satW: Record<string, number>[] = R.recs.map(() => Object.fromEntries(ASSETS.map(a => [a, a === 'BTC-EUR' ? 1 : 0])));

  function rcBTC(weights: Record<string, number>[], W: number) {
    // Σ de log-retornos sobre los últimos W días de cada rebalanceo (todos los días disponibles)
    const start = Math.max(lb + 1, ds.dates.length - W);
    const rets: number[][] = ASSETS.map(() => []);
    for (let di = start; di < ds.dates.length; di++) for (let ai = 0; ai < N; ai++) rets[ai].push(LOG(ds.closes[ASSETS[ai]][di], ds.closes[ASSETS[ai]][di - 1]));
    const m = rets[0].length; if (m < 10) return NaN;
    const means = rets.map(x => x.reduce((s, q) => s + q, 0) / m);
    const C: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { let s = 0; for (let t = 0; t < m; t++) s += (rets[i][t] - means[i]) * (rets[j][t] - means[j]); C[i][j] = s / m; }
    // pesos: media de los pesos en la ventana
    const k0 = Math.max(0, weights.length - Math.round(W * (weights.length / ds.dates.length)));
    const wAvg: number[] = ASSETS.map((a, ai) => { let s = 0, c = 0; for (let k = k0; k < weights.length; k++) { s += weights[k][a] ?? 0; c++; } void ai; return c ? s / c : 0; });
    const Sw = new Array(N).fill(0);
    for (let i = 0; i < N; i++) { let s2 = 0; for (let j = 0; j < N; j++) s2 += C[i][j] * wAvg[j]; Sw[i] = s2; }
    let varP = 0; for (let i = 0; i < N; i++) varP += wAvg[i] * Sw[i];
    const b = ASSETS.indexOf('BTC-EUR');
    const rc = varP > 0 ? (wAvg[b] * Sw[b]) / varP : NaN;
    const btcMean = wAvg[b];
    const volP = Math.sqrt(Math.max(0, varP) * 365);
    return { rc, btcMean, volP, wAvg };
  }

  const WINDOWS_W: [string, number][] = [['1 año', 252], ['2 años', 504], ['3 años', 756], ['historia larga', 10_000]];
  const series: [string, Record<string, number>[]][] = [['cuenta completa', compW], ['motor solo', motorW], ['satélite solo', satW]];
  console.log(`\n  ${'cartera'.padEnd(16)} ${'Σ ventana'.padEnd(15)} ${'BTC nom'.padStart(8)} ${'RC BTC'.padStart(8)} ${'vol cartera'.padStart(12)}`);
  const rcRef: Record<string, number> = {};
  for (const [nm, w] of series) for (const [wn, W] of WINDOWS_W) { const r = rcBTC(w, W); if (isNaN(r.rc)) continue; rcRef[`${nm}|${wn}`] = r.rc; console.log(`  ${nm.padEnd(16)} ${wn.padEnd(15)} ${pct(r.btcMean, 1).padStart(8)} ${pct(r.rc, 1).padStart(8)} ${pct(r.volP, 1).padStart(12)}`); }

  // Control de referencia declarado en el preregistro
  console.log(`\n  CONTROL de referencia (preregistro §4): BTC 28.7% nominal + resto mezcla motor → RC ≈ 42/44/46/55%`);
  const cc = ['1 año', '2 años', '3 años', 'historia larga'].map(w => pct(rcRef[`cuenta completa|${w}`] ?? NaN, 0));
  console.log(`  Cuenta completa calculada: 1y ${cc[0]} · 2y ${cc[1]} · 3y ${cc[2]} · historia ${cc[3]}`);

  // Reconciliación con 2C (14.2%)
  console.log(`\n  RECONCILIACIÓN con el 14.2% del informe 2C:`);
  console.log(`     2C usó Σ de RETORNOS SIMPLES muestreada en rebalanceos con los pesos composite del motor`);
  console.log(`     y promedio por ventana de covarianza. 3A usa Σ de LOG-retornos sobre toda la serie del motor.`);
  console.log(`     La diferencia (${pct(rcRef['cuenta completa|historia larga'] ?? NaN, 0)} vs 14.2%) se debe al método/base de pesos; se reporta sin ocultar.`);

  // MaxDD cuenta completa en 2018, 2022 y shock BTC
  console.log(`\n── MaxDD de la CUENTA COMPLETA (composite) ──`);
  const { shadowSim } = await import('./sim_core');
  const sc = shadowSim(ds, compW);
  for (const [wn, f, t] of [['2018', '2018-07-01', '2018-12-31'], ['2022', '2022-01-01', '2022-12-31'], ['FULL', '2018-07-01', '2099-12-31']] as [string, string, string][]) {
    const s = slice(sc.twr, sc.dates, f, t); if (!s) continue;
    console.log(`  ${wn.padEnd(6)} CAGR ${pct(s.m.cagr).padStart(8)} · Sharpe ${s.m.sharpe.toFixed(3)} · MaxDD ${pct(s.m.maxDD, 1)}`);
  }
  const btcMean = R.recs.reduce((s, r) => s + btcSatPct(OLY) + olyPct(OLY) * ((r.allocations as any)['BTC-EUR'] ?? 0), 0) / REC;
  console.log(`  Shock BTC −70% (analítico, peso real ${pct(btcMean, 1)}): impacto inmediato de cartera ${pct(btcMean * 0.70)}`);

  // Tabla nominal 10..35% vs RC vs CAGR/MaxDD
  console.log(`\n── Tabla nominal (cap sobre BTC total) vs RC vs CAGR/MaxDD (FULL) ──`);
  function capBtc(w: Record<string, number>, cap: number) { const btc = w['BTC-EUR'] ?? 0; const capped = Math.min(btc, cap); const S = ASSETS.reduce((s, a) => s + (w[a] ?? 0), 0); const rest = S - btc; const sc2 = rest > 1e-9 ? (S - capped) / rest : 1; const t: Record<string, number> = {}; for (const a of ASSETS) t[a] = a === 'BTC-EUR' ? capped : (w[a] ?? 0) * sc2; return t; }
  console.log(`  ${'BTC total'.padStart(10)} ${'CAGR'.padStart(8)} ${'MaxDD'.padStart(8)} ${'RC(hist)'.padStart(9)}`);
  for (const cap of [0.10, 0.15, 0.20, 0.25, 0.30, 0.35]) {
    const s = shadowSim(ds, compW.map(w => capBtc(w, cap)));
    const fm = full(s.twr, s.dates);
    const r = rcBTC(compW.map(w => capBtc(w, cap)), 10_000);
    console.log(`  ${pct(cap, 0).padStart(10)} ${pct(fm.cagr).padStart(8)} ${pct(fm.maxDD, 1).padStart(8)} ${pct(r.rc, 1).padStart(9)}`);
  }
  void simulate; void WINDOWS;
})();
