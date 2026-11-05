// ============================================================
// scripts/validation/vol_target_sensitivity.ts
// ¿Por qué el objetivo de volatilidad es 20% y no otro?
// Réplica de la variante V3 del harness de ablación (HRP 252d + vol target 63d,
// rebalanceo 21d, costes reales, sin aportaciones) barriendo DEFAULT_TARGET_VOL.
// Solo lectura: NO modifica src/.
// Ejecutar: npx tsx scripts/validation/vol_target_sensitivity.ts
// ============================================================

import { buildCanonicalDataset, shadowSim, metrics, pct, CFG } from './sim_core';
import { computeHRP } from '../../src/core/risk/hrp';
import { computeVolTargetMultiplier } from '../../src/core/risk/volatilityTarget';
import { ASSETS } from '../../src/lib/constants';

const TARGETS = [0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.25, 0.30];
const SPLIT = '2023-10-28';

const ds = buildCanonicalDataset();
const { dates, closes } = ds;
const N = ASSETS.length;
const REC = dates.length - CFG.lookbackDays;

function retWindow(a: string, di: number, w: number): number[] {
  const r: number[] = [];
  for (let i = Math.max(1, di - w + 1); i <= di; i++) r.push(closes[a][i] / closes[a][i - 1] - 1);
  return r;
}
function covAt(di: number, w: number): number[][] {
  const rs = ASSETS.map(a => retWindow(a, di, w));
  const m = rs[0].length;
  const means = rs.map(x => x.reduce((s, v) => s + v, 0) / m);
  const C: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    let s = 0; for (let k = 0; k < m; k++) s += (rs[i][k] - means[i]) * (rs[j][k] - means[j]);
    C[i][j] = s / m;
  }
  return C;
}
function portVolAt(weights: number[], di: number, w: number): number {
  const C = covAt(di, w); let v = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) v += weights[i] * weights[j] * C[i][j];
  return Math.sqrt(Math.max(0, v) * CFG.dpy);
}

// HRP y vol realizada dependen solo de la ventana, no del target → se calculan una vez.
const wByK = new Map<number, number[]>();
const volByK = new Map<number, number>();
for (let k = 0; k < REC; k += CFG.rebalanceDays) {
  const di = CFG.lookbackDays + k;
  if (di >= dates.length) break;
  const w = computeHRP(covAt(di, 252), N).weights;
  wByK.set(k, w);
  volByK.set(k, portVolAt(w, di, 63));
}

interface Row { target: number; alloc: Record<string, number>[]; meanMult: number; meanExp: number; pctBelow07: number; pctBelow06: number; }
function build(target: number): Row {
  const alloc: Record<string, number>[] = [];
  let cur: Record<string, number> = {};
  let sumMult = 0, sumExp = 0, n = 0, b07 = 0, b06 = 0;
  for (let k = 0; k < REC; k++) {
    const w = wByK.get(k);
    if (w) {
      const vt = computeVolTargetMultiplier({ targetVol: target, realizedVol: volByK.get(k)!, regimePenalty: 1.0 }).multiplier;
      // Producción: totalInvested = clamp(volTarget × tailRisk, 0.05, 1.0) → sin apalancamiento.
      const vtEff = Math.min(1, vt);
      cur = {};
      ASSETS.forEach((a, i) => { cur[a] = w[i] * vtEff; });
      sumMult += vt; sumExp += vtEff; n++;
      if (vt < 0.70) b07++;
      if (vt < 0.60) b06++;
    }
    alloc.push({ ...cur });
  }
  return { target, alloc, meanMult: sumMult / n, meanExp: sumExp / n, pctBelow07: b07 / n, pctBelow06: b06 / n };
}

function twrVals(twr: number[]): number[] { const vv = [1]; for (const r of twr) vv.push(vv[vv.length - 1] * (1 + r)); return vv; }
function slice(twr: number[], dt: string[], from: string, to: string) {
  const rs: number[] = []; const ds2: string[] = [];
  for (let i = 0; i < twr.length; i++) { const d = dt[i + 1]; if (d >= from && d <= to) { rs.push(twr[i]); ds2.push(d); } }
  const vals = [1]; for (const r of rs) vals.push(vals[vals.length - 1] * (1 + r));
  return metrics(rs, vals, [from, ...ds2]);
}

console.log('='.repeat(118));
console.log('  SENSIBILIDAD DEL OBJETIVO DE VOLATILIDAD — V3 (HRP 252d + volTarget 63d, rebal 21d, costes reales)');
console.log('  ' + dates[0] + ' → ' + dates[dates.length - 1] + ' · ' + REC + ' días de cartera · split OOS ' + SPLIT);
console.log('='.repeat(118));
console.log(`  ${'target'.padStart(7)} ${'exp.media'.padStart(9)} ${'mult.medio'.padStart(10)} ${'<0.70'.padStart(7)} ${'<0.60'.padStart(7)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'OOS CAGR'.padStart(9)} ${'OOS Sh'.padStart(7)} ${'OOS DD'.padStart(8)} ${'Costes'.padStart(8)}`);
console.log('  ' + '-'.repeat(114));
const rows: Row[] = [];
for (const t of TARGETS) {
  const r = build(t); rows.push(r);
  const s = shadowSim(ds, r.alloc);
  const full = metrics(s.twr, twrVals(s.twr), s.dates);
  const oos = slice(s.twr, s.dates, SPLIT, '2030-01-01');
  console.log(`  ${(t * 100).toFixed(0).padStart(6)}% ${pct(r.meanExp, 1).padStart(9)} ${r.meanMult.toFixed(3).padStart(10)} ${pct(r.pctBelow07, 1).padStart(7)} ${pct(r.pctBelow06, 1).padStart(7)} ${pct(full.cagr).padStart(8)} ${full.sharpe.toFixed(3).padStart(7)} ${pct(full.maxDD, 1).padStart(8)} ${pct(oos.cagr).padStart(9)} ${oos.sharpe.toFixed(3).padStart(7)} ${pct(oos.maxDD, 1).padStart(8)} ${('€' + s.costs.toFixed(0)).padStart(8)}`);
}
console.log('='.repeat(118));

// Referencia: la cartera SIN vol target (HRP puro = V2), para saber si el vol target aporta algo.
const hrpOnly = build(999); // target enorme → mult clampado a 1.5 → vtEff = 1 siempre
const sNoVt = shadowSim(ds, hrpOnly.alloc);
const fNoVt = metrics(sNoVt.twr, twrVals(sNoVt.twr), sNoVt.dates);
const oNoVt = slice(sNoVt.twr, sNoVt.dates, SPLIT, '2030-01-01');
console.log(`  ${'sin VT'.padStart(7)} ${pct(hrpOnly.meanExp, 1).padStart(9)} ${hrpOnly.meanMult.toFixed(3).padStart(10)} ${'—'.padStart(7)} ${'—'.padStart(7)} ${pct(fNoVt.cagr).padStart(8)} ${fNoVt.sharpe.toFixed(3).padStart(7)} ${pct(fNoVt.maxDD, 1).padStart(8)} ${pct(oNoVt.cagr).padStart(9)} ${oNoVt.sharpe.toFixed(3).padStart(7)} ${pct(oNoVt.maxDD, 1).padStart(8)} ${('€' + sNoVt.costs.toFixed(0)).padStart(8)}`);
console.log('='.repeat(118));
