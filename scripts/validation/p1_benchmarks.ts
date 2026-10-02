// ============================================================
// scripts/validation/p1_benchmarks.ts
// FASE 2B · P1 — Definición del B&H de Test A y benchmarks comparables.
//   BH0 = réplica exacta (equal-weight, fraccional, SIN costes) → control 63.36%
//   BH1 = BH0 + costes reales por compra
//   BH2 = BH1 + acciones enteras en ETFs (BTC fraccional)
// Ejecutar: npx tsx scripts/validation/p1_benchmarks.ts
// ============================================================

import { buildCanonicalDataset, runEngine, simulate, metrics, xirr, pct, CFG } from './sim_core';
import { computeTradeCost } from '../../src/core/validation/transactionCosts';
import { ASSETS } from '../../src/lib/constants';

const ds = buildCanonicalDataset();
const { dates, closes } = ds;
const R = runEngine(ds);
const S = simulate(ds);

// validación del simulador vs account_backtest.ts (Fase 2A)
console.log('='.repeat(104));
console.log('  P1 — BENCHMARKS COMPARABLES (validación del simulador incluida)');
console.log('='.repeat(104));
console.log(`  [validación] cuenta simulada: CAGR ${pct(S.cagr)} · Sharpe ${S.sharpe.toFixed(3)} · MaxDD ${pct(S.maxDD, 1)} · costes €${S.costs.toFixed(0)} · órdenes ${S.orders}`);
console.log(`  [validación] esperado Fase 2A: 23.39% · 1.244 · −12.5% · €524 · 343 órdenes`);
console.log(`  [validación] trims legacy: ${S.legacyRoundTrips} · €${S.legacyRoundTripEur.toFixed(0)} (esperado 49 · €81595) · churn directo €${S.churnDirectEur.toFixed(0)}`);

const lookback = CFG.lookbackDays;
const bh0Date = dates[lookback];

interface BHVariant { name: string; twr: number[]; values: number[]; final: number; costs: number; }
function buyEqual(bhCash: number, di: number, fractional: boolean, pv: number): { spent: number; cost: number; shares: Record<string, number> } {
  const per = bhCash / ASSETS.length;
  const shares: Record<string, number> = {}; ASSETS.forEach(a => shares[a] = 0);
  let spent = 0, cost = 0;
  for (const a of ASSETS) {
    const px = closes[a][di];
    let notional = per;
    let c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: notional / pv, portfolioValueEur: pv, priceEur: px }).totalCostEur;
    if (notional + c > bhCash - spent) { notional = Math.max(0, (bhCash - spent) - c); c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: notional / pv, portfolioValueEur: pv, priceEur: px }).totalCostEur; }
    if (notional <= 0) continue;
    const sh = fractional || a === 'BTC-EUR' ? notional / px : Math.floor(notional / px);
    if (sh <= 0) continue;
    const actual = sh * px;
    cost += c; spent += actual + c; shares[a] += sh;
  }
  return { spent, cost, shares };
}

function runBH(mode: 'BH0' | 'BH1' | 'BH2' | 'BH3', weights: Record<string, number> | null = null): BHVariant {
  const fractional = mode === 'BH0' ? true : mode === 'BH2' ? false : true;
  const payCosts = mode === 'BH1' || mode === 'BH2';
  const w = (a: string) => weights ? (weights[a] ?? 0) : 1 / ASSETS.length;
  const shares: Record<string, number> = {}; ASSETS.forEach(a => shares[a] = 0);
  let cash = CFG.initialCapital;
  let totalCosts = 0;
  // compra inicial
  if (!payCosts) {
    ASSETS.forEach(a => { shares[a] = (cash * w(a)) / closes[a][lookback]; });
    cash = 0;
  } else {
    const pv = cash;
    const r = buyEqual(cash, lookback, fractional, pv);
    totalCosts += r.cost;
    ASSETS.forEach(a => shares[a] += r.shares[a]);
    cash -= r.spent;
  }
  const values: number[] = []; const twr: number[] = [];
  let lastMonth = parseInt(dates[lookback].slice(5, 7), 10);
  for (let k = 1; k < R.recs.length; k++) {
    const di = k + lookback;
    const m = parseInt(dates[di].slice(5, 7), 10);
    if (m !== lastMonth) {
      lastMonth = m;
      if (!payCosts) {
        cash += CFG.monthlyContribution;
        ASSETS.forEach(a => { shares[a] += (cash * w(a)) / closes[a][di]; });
        cash = 0;
      } else {
        cash += CFG.monthlyContribution;
        const pv = cash + ASSETS.reduce((s, a) => s + shares[a] * closes[a][di], 0);
        const r = buyEqual(cash, di, fractional, pv);
        totalCosts += r.cost;
        ASSETS.forEach(a => shares[a] += r.shares[a]);
        cash -= r.spent;
      }
    }
    const v = cash + ASSETS.reduce((s, a) => s + shares[a] * closes[a][di], 0);
    values.push(v);
    if (values.length > 1) twr.push(v / values[values.length - 2] - 1);
  }
  return { name: mode, twr, values, final: values[values.length - 1], costs: totalCosts };
}

const BH0 = runBH('BH0'); const BH1 = runBH('BH1'); const BH2 = runBH('BH2');
// BH3 — DIAGNÓSTICO (no preregistrado): pesos estáticos = targets del motor del día 0
// (normalizados a 1, sin cash) — aísla el efecto ASIGNACIÓN del efecto EJECUCIÓN.
const day0 = R.recs[0].allocations as Record<string, number>;
const day0Sum = ASSETS.reduce((s, a) => s + (day0[a] ?? 0), 0);
const BH3W = Object.fromEntries(ASSETS.map(a => [a, (day0[a] ?? 0) / day0Sum]));
const BH3 = runBH('BH3', BH3W);

function flowList(final: number): { t: number; amount: number }[] {
  const fl: { t: number; amount: number }[] = [{ t: 0, amount: -CFG.initialCapital }];
  for (let i = 1; i < R.recs.length; i++) {
    const d = dates[i + lookback];
    if (parseInt(d.slice(5, 7), 10) !== parseInt(dates[i + lookback - 1].slice(5, 7), 10)) fl.push({ t: i, amount: -CFG.monthlyContribution });
  }
  fl.push({ t: R.recs.length, amount: final });
  return fl;
}

const rows: [string, ReturnType<typeof metrics>, number, number, number][] = [
  ['MOTOR (pesos objetivo)', R.metrics, NaN, R.values[R.values.length - 1], 0],
  ['CUENTA REAL (DCA+rebalanceo)', metrics(S.twr, S.values, S.dates), S.xirr, S.finalValue, S.costs],
  ['BH0 (fraccional, SIN costes) — réplica Test A', metrics(BH0.twr, BH0.values, R.dates.slice(1)), xirr(flowList(BH0.final)), BH0.final, 0],
  ['BH1 (fraccional, CON costes)', metrics(BH1.twr, BH1.values, R.dates.slice(1)), xirr(flowList(BH1.final)), BH1.final, BH1.costs],
  ['BH2 (ETFs enteros, CON costes)', metrics(BH2.twr, BH2.values, R.dates.slice(1)), xirr(flowList(BH2.final)), BH2.final, BH2.costs],
  ['BH3 [diagnóstico] targets motor d0, estático', metrics(BH3.twr, BH3.values, R.dates.slice(1)), xirr(flowList(BH3.final)), BH3.final, BH3.costs],
];
console.log(`\n  ${'Cartera'.padEnd(44)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95m'.padStart(8)} ${'XIRR'.padStart(7)} ${'Final'.padStart(10)} ${'Costes'.padStart(8)}`);
console.log('  ' + '-'.repeat(100));
for (const [n, m, x, fin, c] of rows) {
  console.log(`  ${n.padEnd(44)} ${pct(m.cagr).padStart(8)} ${m.sharpe.toFixed(3).padStart(7)} ${pct(m.maxDD, 1).padStart(8)} ${pct(m.cvar95).padStart(8)} ${(isFinite(x) ? pct(x) : '   n/a').padStart(7)} ${('€' + fin.toFixed(0)).padStart(10)} ${('€' + c.toFixed(0)).padStart(8)}`);
}
console.log(`\n  Nota: BH0 (réplica exacta) debe reproducir 63.36% / 2.169 / −21.6% de Test A.`);
console.log(`  Aportaciones idénticas (€400/mes) y mismo inicio (${bh0Date}) en todas las filas.`);
