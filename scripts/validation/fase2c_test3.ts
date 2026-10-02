// ============================================================
// scripts/validation/fase2c_test3.ts
// FASE 2C · TEST 3+4 — BTC DE LA CUENTA COMPLETA (satélite + motor).
//   Valores REALES de código: btcSatPct/olyPct (composite.ts), default olympusPct=80.
//   BTC total nominal (10..35%) analítico (sin modificar el motor) + contribución a la
//   varianza (RC, Σ 1y/2y/3y) + coste de CAGR de reducir BTC + shock BTC −70%.
// Ejecutar: npx tsx scripts/validation/fase2c_test3.ts
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, shadowSim, CFG, pct } from './sim_core';
import { full, slice } from './metrics_unified';
import { btcSatPct, olyPct } from '../../src/core/backtest/composite';
import { ASSETS } from '../../src/lib/constants';

const OLYMPUS_PCT = 80; // default documentado (InstitutionalDashboard.tsx:464)
const CAPS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35];

function compositeWeights(engineAlloc: Record<string, number>): Record<string, number> {
  const t: Record<string, number> = {};
  for (const a of ASSETS) t[a] = (engineAlloc[a] ?? 0) * olyPct(OLYMPUS_PCT) + (a === 'BTC-EUR' ? btcSatPct(OLYMPUS_PCT) : 0);
  return t;
}
function capBtc(w: Record<string, number>, cap: number): Record<string, number> {
  const btc = w['BTC-EUR'] ?? 0; const capped = Math.min(btc, cap);
  const S = ASSETS.reduce((s, a) => s + (w[a] ?? 0), 0); const rest = S - btc;
  const scale = rest > 1e-9 ? (S - capped) / rest : 1;
  const t: Record<string, number> = {};
  for (const a of ASSETS) t[a] = a === 'BTC-EUR' ? capped : (w[a] ?? 0) * scale;
  return t;
}
function rets(a: string, closes: Record<string, number[]>, di: number, w: number): number[] {
  const r: number[] = []; for (let i = Math.max(1, di - w + 1); i <= di; i++) r.push(closes[a][i] / closes[a][i - 1] - 1); return r;
}

(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(124));
  console.log('  TEST 3+4 — BTC DE LA CUENTA COMPLETA (satélite + motor)');
  console.log('='.repeat(124));
  if (!v.valid) { console.log('  Dataset NO VÁLIDO → NO VERIFICADO'); return; }
  console.log(`  Valores de código: btcSatPct(${OLYMPUS_PCT}) = ${pct(btcSatPct(OLYMPUS_PCT), 0)} · olyPct(${OLYMPUS_PCT}) = ${pct(olyPct(OLYMPUS_PCT), 0)}`);
  console.log(`  Fórmula composite (composite.ts): BTC = engineBtc×olyPct + btcSat ; resto = engineAlloc×olyPct`);
  console.log(`  No existen valores históricos de la cuenta → se usan los DEFAULTS documentados en src/ (declarado).`);

  const R = runEngine(ds);
  const REC = R.recs.length;
  const baseW = R.recs.map(r => compositeWeights(r.allocations as Record<string, number>));
  const baseBtc = baseW.reduce((s, w) => s + (w['BTC-EUR'] ?? 0), 0) / REC;
  console.log(`  BTC total de la cuenta (media histórica, sin cap): ${pct(baseBtc, 1)}`);

  // ── Ventanas para los caps ──
  const dates = R.dates;
  const N = dates.length;
  const WIN: [string, string, string][] = [
    ['1 año', dates[Math.max(0, N - 252)], dates[N - 1]],
    ['2 años', dates[Math.max(0, N - 504)], dates[N - 1]],
    ['3 años', dates[Math.max(0, N - 756)], dates[N - 1]],
    ['larga 2018-2026', '2018-07-01', '2099-12-31'],
    ['2018', '2018-07-01', '2018-12-31'],
    ['2022', '2022-01-01', '2022-12-31'],
  ];

  const series: { name: string; twr: number[]; dates: string[]; vols: number[] }[] = [];
  const sBase = shadowSim(ds, baseW);
  series.push({ name: 'base (sin cap)', twr: sBase.twr, dates: sBase.dates, vols: [] });
  for (const cap of CAPS) {
    const s = shadowSim(ds, baseW.map(w => capBtc(w, cap)));
    series.push({ name: `cap ${pct(cap, 0)}`, twr: s.twr, dates: s.dates, vols: [] });
  }
  void full; void slice;

  // ── Métricas por ventana ──
  console.log(`\n── CAGR / Sharpe / MaxDD / CVaR95 por ventana ──`);
  for (const [wn, f, t] of WIN) {
    console.log(`  ${wn} (${f}→${t})`);
    console.log(`    ${'BTC total'.padEnd(16)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95'.padStart(8)} ${'coste CAGR'.padStart(11)}`);
    const baseM = slice(sBase.twr, sBase.dates, f, t);
    for (const s of series) {
      const m = slice(s.twr, s.dates, f, t); if (!m) continue;
      const cost = baseM ? m.m.cagr - baseM.m.cagr : 0;
      console.log(`    ${s.name.padEnd(16)} ${pct(m.m.cagr).padStart(8)} ${m.m.sharpe.toFixed(3).padStart(7)} ${pct(m.m.maxDD, 1).padStart(8)} ${pct(m.m.cvar95).padStart(8)} ${(s.name.startsWith('base') ? '—' : pct(cost)).padStart(11)}`);
    }
  }

  // ── Contribución de BTC a la varianza (RC) por ventana de covarianza ──
  console.log(`\n── Contribución de BTC a la varianza (RC = w_B·(Σw)_B/(w'Σw), muestreada en rebalanceos) ──`);
  const RC: Record<string, number[]> = {};
  for (const s of series) {
    const cap = s.name.startsWith('base') ? 1 : parseFloat(s.name.replace('cap ', '')) / 100;
    const W = cap === 1 ? baseW : baseW.map(w => capBtc(w, cap));
    const row: number[] = [];
    for (const covW of [252, 504, 756]) {
      const vals: number[] = [];
      for (let k = 0; k < REC; k += 21) {
        const di = CFG.lookbackDays + k; if (di < covW + 1) continue;
        const w = W[k]; const S = ASSETS.reduce((a, b) => a + (w[b] ?? 0), 0); if (S <= 0) continue;
        const rs = ASSETS.map(a => rets(a, ds.closes, di, covW));
        const m = rs[0].length; const means = rs.map(x => x.reduce((q, z) => q + z, 0) / m);
        const n = ASSETS.length; const C: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let acc = 0; for (let t2 = 0; t2 < m; t2++) acc += (rs[i][t2] - means[i]) * (rs[j][t2] - means[j]); C[i][j] = acc / m; }
        // FASE 3A FIX: varP se acumulaba DENTRO del doble bucle (sobre-conteo N×) → RC infravalorado.
        const Sw = new Array(n).fill(0);
        for (let i = 0; i < n; i++) { let acc = 0; for (let j = 0; j < n; j++) acc += C[i][j] * (w[ASSETS[j]] ?? 0); Sw[i] = acc; }
        let varP = 0; for (let i = 0; i < n; i++) varP += (w[ASSETS[i]] ?? 0) * Sw[i];
        const b = ASSETS.indexOf('BTC-EUR');
        if (varP > 0) vals.push(((w['BTC-EUR'] ?? 0) * Sw[b]) / varP);
      }
      row.push(vals.reduce((a, b2) => a + b2, 0) / Math.max(1, vals.length));
    }
    RC[s.name] = row;
  }
  console.log(`  ${'BTC total'.padEnd(16)} ${'Σ 1y'.padStart(8)} ${'Σ 2y'.padStart(8)} ${'Σ 3y'.padStart(8)} ${'spread max'.padStart(11)}`);
  let maxSpread = 0;
  for (const s of series) {
    const r = RC[s.name]; const sp = Math.max(...r) - Math.min(...r); if (sp > maxSpread) maxSpread = sp;
    console.log(`  ${s.name.padEnd(16)} ${pct(r[0], 1).padStart(8)} ${pct(r[1], 1).padStart(8)} ${pct(r[2], 1).padStart(8)} ${pct(sp, 1).padStart(11)}`);
  }
  console.log(`  Variación máxima entre ventanas 1y/2y/3y: ${pct(maxSpread, 1)} → ${maxSpread > 0.10 ? 'NO se propone límite final (>10pp)' : 'variación ≤10pp'}`);

  // ── Shock BTC −70% (analítico) ──
  console.log(`\n── Shock BTC −70% (analítico: impacto nominal = BTC_total × 70%) ──`);
  for (const s of series) {
    const btc = s.name.startsWith('base') ? baseBtc : parseFloat(s.name.replace('cap ', '')) / 100;
    console.log(`  ${s.name.padEnd(16)} BTC total ${pct(btc, 1).padStart(6)} → impacto inmediato de cartera ${pct(btc * 0.70)}`);
  }
  console.log(`  RESULTADO (RC): ${maxSpread > 0.10 ? 'NO CONFIRMADO — sin límite final recomendable' : 'IC dentro de 10pp'}`);
})();
