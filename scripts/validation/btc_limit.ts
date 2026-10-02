// ============================================================
// scripts/validation/btc_limit.ts
// FASE 2B · TEST 4 — Límite de BTC por riesgo (caps 10..35%).
//   Overlay sobre targets del motor + shadow-sim 21d con costes.
//   Contribución de BTC a la varianza: RC = w_B·(Σw)_B/(w'Σw), Σ de 252/504/756d,
//   muestreada en días de rebalanceo. Regla: si RC varía >10pp entre ventanas → sin valor final.
// Ejecutar: npx tsx scripts/validation/btc_limit.ts
// ============================================================

import { buildCanonicalDataset, runEngine, shadowSim, metrics, pct, CFG } from './sim_core';
import { loadLongDataset, validate } from './data_long';
import { ASSETS } from '../../src/lib/constants';

const CAPS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35];
const SPLIT = '2023-10-28';

function capAlloc(w: Record<string, number>, cap: number): Record<string, number> {
  const btc = w['BTC-EUR'] ?? 0; const cappedBtc = Math.min(btc, cap);
  const S = ASSETS.reduce((s, a) => s + (w[a] ?? 0), 0);
  const rest = S - btc;
  const scale = rest > 1e-9 ? (S - cappedBtc) / rest : 1;
  const t: Record<string, number> = {};
  for (const a of ASSETS) t[a] = a === 'BTC-EUR' ? cappedBtc : (w[a] ?? 0) * scale;
  return t;
}
function rets(a: string, closes: Record<string, number[]>, di: number, w: number): number[] {
  const r: number[] = []; for (let i = Math.max(1, di - w + 1); i <= di; i++) r.push(closes[a][i] / closes[a][i - 1] - 1); return r;
}
function twrVals(twr: number[]): number[] { const vv = [1]; for (const r of twr) vv.push(vv[vv.length - 1] * (1 + r)); return vv; }
function sliceM(twr: number[], dt: string[], from: string, to: string) {
  const rs: number[] = []; const ds2: string[] = [];
  for (let i = 0; i < twr.length; i++) { const d = dt[i + 1]; if (d >= from && d <= to) { rs.push(twr[i]); ds2.push(d); } }
  const vals = [1]; for (const r of rs) vals.push(vals[vals.length - 1] * (1 + r));
  return metrics(rs, vals, [from, ...ds2]);
}

function analyse(name: string, ds: ReturnType<typeof buildCanonicalDataset>) {
  const R = runEngine(ds);
  const closes = ds.closes;
  const REC = R.recs.length;
  console.log(`\n${'='.repeat(112)}\n  TEST 4 — ${name} (shadow-sim 21d, costes reales, €10k)\n${'='.repeat(112)}`);
  console.log(`  ${'cap BTC'.padStart(8)} ${'FULL CAGR'.padStart(10)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95'.padStart(8)} ${'vol'.padStart(7)} ${'IS Sh'.padStart(7)} ${'OOS Sh'.padStart(7)} ${'OOS CAGR'.padStart(9)} ${'OOS DD'.padStart(8)}`);
  console.log('  ' + '-'.repeat(92));
  const RCs: Record<string, number[]> = {};
  for (const cap of CAPS) {
    const allocs = R.recs.map(r => capAlloc(r.allocations as Record<string, number>, cap));
    const s = shadowSim(ds, allocs);
    const full = metrics(s.twr, twrVals(s.twr), s.dates);
    const is = sliceM(s.twr, s.dates, '2000-01-01', '2023-10-27');
    const oos = sliceM(s.twr, s.dates, SPLIT, '2030-01-01');
    console.log(`  ${(pct(cap, 0)).padStart(8)} ${pct(full.cagr).padStart(10)} ${full.sharpe.toFixed(3).padStart(7)} ${pct(full.maxDD, 1).padStart(8)} ${pct(full.cvar95).padStart(8)} ${pct(full.vol, 1).padStart(7)} ${is.sharpe.toFixed(3).padStart(7)} ${oos.sharpe.toFixed(3).padStart(7)} ${pct(oos.cagr).padStart(9)} ${pct(oos.maxDD, 1).padStart(8)}`);
    // RC muestreada en rebalanceos, por ventana de covarianza
    const row: number[] = [];
    for (const W of [252, 504, 756]) {
      const vals: number[] = [];
      for (let k = 0; k < REC; k += 21) {
        const di = CFG.lookbackDays + k;
        if (di < W + 1) continue;
        const w = allocs[k]; const sum = ASSETS.reduce((s, a) => s + (w[a] ?? 0), 0);
        if (sum <= 0) continue;
        const rs = ASSETS.map(a => rets(a, closes, di, W));
        const m = rs[0].length; const means = rs.map(x => x.reduce((s2, v) => s2 + v, 0) / m);
        const n = ASSETS.length;
        const C: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let s2 = 0; for (let t = 0; t < m; t++) s2 += (rs[i][t] - means[i]) * (rs[j][t] - means[j]); C[i][j] = s2 / m; }
        // FASE 3A FIX: varP se acumulaba DENTRO del doble bucle (sobre-conteo N×) → RC infravalorado.
        const Sw = new Array(n).fill(0);
        for (let i = 0; i < n; i++) { let acc = 0; for (let j = 0; j < n; j++) acc += C[i][j] * (w[ASSETS[j]] ?? 0); Sw[i] = acc; }
        let varP = 0; for (let i = 0; i < n; i++) varP += (w[ASSETS[i]] ?? 0) * Sw[i];
        const b = ASSETS.indexOf('BTC-EUR');
        if (varP > 0) vals.push(((w['BTC-EUR'] ?? 0) * Sw[b]) / varP);
      }
      row.push(vals.reduce((a, b2) => a + b2, 0) / Math.max(1, vals.length));
    }
    RCs[String(cap)] = row;
  }
  console.log(`\n  Contribución de BTC a la varianza (promedio en rebalanceos) — ${'cap'.padEnd(6)} ${'Σ 1y'.padStart(8)} ${'Σ 2y'.padStart(8)} ${'Σ 3y'.padStart(8)}`);
  let maxSpread = 0;
  for (const cap of CAPS) {
    const r = RCs[String(cap)]; const spread = Math.max(...r) - Math.min(...r);
    if (spread > maxSpread) maxSpread = spread;
    console.log(`  ${pct(cap, 0).padStart(20)} ${pct(r[0], 1).padStart(8)} ${pct(r[1], 1).padStart(8)} ${pct(r[2], 1).padStart(8)}`);
  }
  console.log(`  Variación máxima entre ventanas 1y/2y/3y: ${pct(maxSpread, 1)} → ${maxSpread > 0.10 ? 'NO se propone valor final (>10pp)' : 'variación ≤10pp'}`);
}

(async () => {
  analyse('CANÓNICO (2022-2026)', buildCanonicalDataset());
  const long = await loadLongDataset();
  if (validate(long).valid) analyse('LARGO (2017-2026, proxies reales)', long);
})();
