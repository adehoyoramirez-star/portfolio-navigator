// ============================================================
// scripts/validation/fase3a_test2.ts
// FASE 3A · TEST 2 — COMPARACIÓN HOMOGÉNEA (misma capa de ejecución).
//   Matriz 2x2: {targets motor, targets V3} × {ejecución ideal, ejecución real}
//   €10k + €400/mes · costes de SPREAD COMPLETO (corrección declarada: 2× halfSpreadBps).
// Ejecutar: npx tsx scripts/validation/fase3a_test2.ts
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, simulate, deriveMacro, CFG, pct, xirr } from './sim_core';
import { full, slice, WINDOWS, type WindowKey } from './metrics_unified';
import { computeTradeCost, ASSET_COST_PARAMS } from '../../src/core/validation/transactionCosts';
import { computeHRP } from '../../src/core/risk/hrp';
import { computeVolTargetMultiplier } from '../../src/core/risk/volatilityTarget';
import { TAIL_RISK_CONFIG } from '../../src/core/config/engineConfig';
import { ASSETS } from '../../src/lib/constants';

// ── Corrección de coste DECLARADA: spread completo (computeTradeCost solo cobra medio spread) ──
let spreadFix = 0;
for (const t of Object.keys(ASSET_COST_PARAMS)) { ASSET_COST_PARAMS[t].halfSpreadBps *= 2; spreadFix++; }
console.log(`  [coste] spread completo: ${spreadFix} activos con halfSpreadBps ×2 (impacto intacto).`);

const isBTC = (t: string) => t === 'BTC-EUR';
const KS = TAIL_RISK_CONFIG.KILL_SWITCH;
function ksLevel(dd: number): number { const x = Math.abs(dd); if (x >= KS.L5.threshold) return 5; if (x >= KS.L4.threshold) return 4; if (x >= KS.L3.threshold) return 3; if (x >= KS.L2.threshold) return 2; if (x >= KS.L1_5.threshold) return 1.5; if (x >= KS.L1.threshold) return 1; return 0; }

interface Res { values: number[]; dates: string[]; twr: number[]; flows: number[]; costs: number; turnover: number; final: number; xirr: number; }

/** Ejecución IDEAL: rebalanceo EXACTO a target cada `every` días, fraccional, con aportaciones. */
function runIdeal(ds: any, target: Record<string, number>[], every = 21): Res {
  const { dates, closes } = ds; const R = runEngine(ds); const REC = R.recs.length;
  let cash = CFG.initialCapital; const shares: Record<string, number> = {}; ASSETS.forEach(a => shares[a] = 0);
  let costs = 0, turnover = 0, nOrders = 0;
  const values: number[] = [], twr: number[] = [], outDates: string[] = [], flows: number[] = [];
  let lastMonth = parseInt(dates[CFG.lookbackDays].slice(5, 7), 10);
  const px = (t: string, di: number) => closes[t][di];
  const sumT = (kk: number) => ASSETS.reduce((s, a) => s + Math.max(0, target[Math.max(0, Math.min(kk, REC - 1))][a] ?? 0), 0);
  for (let k = 0; k < REC; k++) {
    const di = CFG.lookbackDays + k; const d = dates[di]; outDates.push(d);
    const m = parseInt(d.slice(5, 7), 10); let flow = 0;
    if (k > 0 && m !== lastMonth) { lastMonth = m; cash += CFG.monthlyContribution; flow = CFG.monthlyContribution; }
    flows.push(flow);
    const prev = values.length ? values[values.length - 1] : CFG.initialCapital;
    let pv = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a, di), 0);
    // IDEAL = aplica el target cuando cambia (event-driven) además de cada `every` días.
    const deRisk = k > 0 && (sumT(k - 1) - sumT(k)) > 0.05;
    if (k % every === 0 || deRisk) {
      const tgt = target[k];
      for (const a of ASSETS) { const tv = (tgt[a] ?? 0) * pv; const cur = shares[a] * px(a, di); if (cur > tv + 0.01) { const not = cur - tv; const c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: not / pv, portfolioValueEur: pv, priceEur: px(a, di) }).totalCostEur; shares[a] -= not / px(a, di); cash += not - c; costs += c; turnover += not; nOrders++; } }
      pv = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a, di), 0);
      for (const a of ASSETS) { const tv = (tgt[a] ?? 0) * pv; const cur = shares[a] * px(a, di); if (tv > cur + 0.01) { let not = tv - cur; let c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: not / pv, portfolioValueEur: pv, priceEur: px(a, di) }).totalCostEur; if (not + c > cash) { not = Math.max(0, cash - c); c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: not / pv, portfolioValueEur: pv, priceEur: px(a, di) }).totalCostEur; } if (not <= 0.01) continue; shares[a] += not / px(a, di); cash -= not + c; costs += c; turnover += not; nOrders++; } }
    }
    const pvNow = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a, di), 0); values.push(pvNow);
    if (k > 0) twr.push((pvNow - flow) / prev - 1);
  }
  const fl = [{ t: 0, amount: -CFG.initialCapital }];
  for (let i = 1; i < flows.length; i++) if (flows[i] > 0) fl.push({ t: i, amount: -flows[i] });
  fl.push({ t: flows.length, amount: values[values.length - 1] });
  return { values, dates: outDates, twr, flows, costs, turnover, final: values[values.length - 1], xirr: xirr(fl) };
}

function win(r: Res, K: WindowKey) {
  const [f, t] = WINDOWS[K];
  const s = r.dates.findIndex(d => d >= f); const e = r.dates.findIndex(d => d > t); const end = e < 0 ? r.dates.length : e;
  if (s < 0 || end - s < 2) return null;
  const m = full(r.twr.slice(s, end - 1), r.dates.slice(s, end));
  const fl = [{ t: 0, amount: -r.values[s] }];
  for (let i = s + 1; i < end; i++) if (r.flows[i] > 0) fl.push({ t: i - s, amount: -r.flows[i] });
  fl.push({ t: end - 1 - s, amount: r.values[end - 1] });
  return { m, xirr: xirr(fl), n: end - s };
}

(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(122));
  console.log('  TEST 2 — COMPARACIÓN HOMOGÉNEA 2×2 (€400/mes, spread completo, fraccional en ideal)');
  console.log('='.repeat(122));
  if (!v.valid) { console.log('  NO VÁLIDO'); return; }
  const R = runEngine(ds); const REC = R.recs.length; const N = ASSETS.length;
  const { creditSpread } = deriveMacro(ds);
  const penalty: number[] = [], ks: number[] = [];
  for (let k = 0; k < REC; k++) { const reg = R.recs[k].regime as string; penalty.push(reg === 'EXPANSION' ? 1 : reg === 'CONTRACTION' ? 0.6 : 0.4); ks.push(ksLevel(R.recs[k].drawdown)); }
  const real = { penalty, volTarget: new Array(REC).fill(1), ks };

  // V3 targets (misma definición congelada que 2B/2C)
  function retW(a: string, di: number, w: number) { const r: number[] = []; for (let i = Math.max(1, di - w + 1); i <= di; i++) r.push(ds.closes[a][i] / ds.closes[a][i - 1] - 1); return r; }
  function covAt(di: number, w: number) { const rs = ASSETS.map(a => retW(a, di, w)); const m = rs[0].length; const means = rs.map(x => x.reduce((s, q) => s + q, 0) / m); const C: number[][] = Array.from({ length: N }, () => new Array(N).fill(0)); for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { let s = 0; for (let k = 0; k < m; k++) s += (rs[i][k] - means[i]) * (rs[j][k] - means[j]); C[i][j] = s / m; } return C; }
  function portVol(w: number[], di: number, win2: number) { const C = covAt(di, win2); let s = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) s += w[i] * w[j] * C[i][j]; return Math.sqrt(Math.max(0, s) * CFG.dpy); }
  const v3t: Record<string, number>[] = []; let cur: Record<string, number> = {};
  for (let k = 0; k < REC; k++) { const di = CFG.lookbackDays + k; if (k % 21 === 0) { const w = computeHRP(covAt(di, 252), N).weights; const vt = computeVolTargetMultiplier({ targetVol: 0.20, realizedVol: portVol(w, di, 63), regimePenalty: 1.0 }).multiplier; cur = Object.fromEntries(ASSETS.map((a, i) => [a, w[i] * vt])); } v3t.push({ ...cur }); }
  void creditSpread;

  const motorT = R.recs.map(r => r.allocations as Record<string, number>);
  // celdas
  const mkFlows = (dates: string[]) => dates.map((d, i) => (i > 0 && parseInt(d.slice(5, 7), 10) !== parseInt(dates[i - 1].slice(5, 7), 10)) ? CFG.monthlyContribution : 0);
  const motorIdeal = runIdeal(ds, motorT, 21);
  const motorReal = (() => { const s = simulate(ds, { vetoSeries: real, targetsOverride: motorT }); return { values: s.values, dates: s.dates, twr: s.twr, flows: mkFlows(s.dates), costs: s.costs, turnover: s.turnoverEur, final: s.finalValue, xirr: s.xirr } as Res; })();
  const v3Ideal = runIdeal(ds, v3t, 21);
  const v3Real = (() => { const s = simulate(ds, { vetoSeries: real, targetsOverride: v3t }); return { values: s.values, dates: s.dates, twr: s.twr, flows: mkFlows(s.dates), costs: s.costs, turnover: s.turnoverEur, final: s.finalValue, xirr: s.xirr } as Res; })();

  const cells: [string, Res][] = [['motor × ideal', motorIdeal], ['motor × real', motorReal], ['V3 × ideal', v3Ideal], ['V3 × real', v3Real]];
  for (const K of ['FULL', 'HOLDOUT', 'VISTA'] as WindowKey[]) {
    console.log(`\n── ${K} (${WINDOWS[K][0]}→${WINDOWS[K][1]}) ──`);
    console.log(`  ${'celda'.padEnd(16)} ${'CAGR'.padStart(8)} ${'XIRR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95'.padStart(8)} ${'costes'.padStart(8)} ${'turnover'.padStart(10)}`);
    for (const [n, r] of cells) { const w = win(r, K); if (!w) continue; console.log(`  ${n.padEnd(16)} ${pct(w.m.cagr).padStart(8)} ${pct(w.xirr).padStart(8)} ${w.m.sharpe.toFixed(3).padStart(7)} ${pct(w.m.maxDD, 1).padStart(8)} ${pct(w.m.cvar95).padStart(8)} ${('€' + r.costs.toFixed(0)).padStart(8)} ${('€' + r.turnover.toFixed(0)).padStart(10)}`); }
  }

  // Crisis COVID
  console.log(`\n── COVID-2020 (MaxDD) ──`);
  const cm = (r: Res) => slice(r.twr, r.dates, ...WINDOWS.COVID)!.m.maxDD;
  const mi = cm(motorIdeal), mr = cm(motorReal), vi = cm(v3Ideal), vr = cm(v3Real);
  console.log(`  motor×ideal ${pct(mi, 1)} · motor×real ${pct(mr, 1)} · V3×ideal ${pct(vi, 1)} · V3×real ${pct(vr, 1)}`);
  const execDefect = (Math.abs(mr) - Math.abs(mi)) > 0.05;
  console.log(`  Criterio (>5pp de degradación con los MISMOS targets): ${((Math.abs(mr) - Math.abs(mi)) * 100).toFixed(1)} pp → ${execDefect ? 'CAPA DE EJECUCIÓN DEFECTUOSA' : 'capa de ejecución NO defectuosa según el criterio'}`);

  // Descomposición FULL
  const f = (r: Res) => full(r.twr, r.dates);
  console.log(`\n── DESCOMPOSICIÓN (FULL) ──`);
  console.log(`  (A) selección de pesos = V3ideal − motorIdeal: Sharpe ${(f(v3Ideal).sharpe - f(motorIdeal).sharpe).toFixed(3)} · CAGR ${pct(f(v3Ideal).cagr - f(motorIdeal).cagr)} · MaxDD ${pct(f(v3Ideal).maxDD - f(motorIdeal).maxDD, 1)}`);
  console.log(`  (B) capa de ejecución  = motorIdeal − motorReal: Sharpe ${(f(motorIdeal).sharpe - f(motorReal).sharpe).toFixed(3)} · CAGR ${pct(f(motorIdeal).cagr - f(motorReal).cagr)} · MaxDD ${pct(f(motorIdeal).maxDD - f(motorReal).maxDD, 1)}`);
  console.log(`  (C) capa de ejecución sobre V3 = V3ideal − V3real: Sharpe ${(f(v3Ideal).sharpe - f(v3Real).sharpe).toFixed(3)} · CAGR ${pct(f(v3Ideal).cagr - f(v3Real).cagr)} · MaxDD ${pct(f(v3Ideal).maxDD - f(v3Real).maxDD, 1)}`);
  console.log(`\n  Nota: el motor REAL incluye la cadencia mensual de la cuenta (30d) y el lag de aplicación del target (TEST 1).`);
})();
