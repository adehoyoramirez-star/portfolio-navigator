// ============================================================
// scripts/validation/composite_split.ts
// ¿Cuánto cambia la cartera al añadir el satélite BTC?
//   - Sleeve motor al 100% (lo que midió la auditoría forense).
//   - Compuesto 85/15 y 80/20 (80/20 es el default de producción:
//     olympusPct = 80 en InstitutionalDashboard).
//   - Dos variantes por split: SIN acoplamiento (mezcla de retornos,
//     lo que hacía computeCompositeMetrics) y ACOPLADO
//     (runBacktestCoupled: el motor ve el DD del portfolio TOTAL).
// Ventana, datos y costes idénticos al resto de la validación:
// dataset largo (proxies reales), lookback 252, rebalanceo 21d, 15 bps.
// Anualización con la densidad REAL de la serie (FIX-AUDIT-ANNUALIZATION).
// Ejecutar: npx tsx scripts/validation/composite_split.ts
// ============================================================

import { loadLongDataset, type LongDataset } from './data_long';
import { runBacktest } from '../../src/core/backtest/backtestEngine';
import { computeCompositeMetrics, runBacktestCoupled, computeBtcTotalRisk } from '../../src/core/backtest/compositeMetrics';
import { btcSatPct, olyPct } from '../../src/core/backtest/composite';

const LOOK = 252;
const REB = 21;
const BPS = 15;
const CAPITAL = 10_000;
const pc = (x: number, d = 1) => (x * 100).toFixed(d) + '%';

function macroOf(ds: LongDataset) {
  const ys = ds.macro.tnx.map((v, i) => v - ds.macro.irx[i]);
  const cs = ds.macro.hyg.map((v, i) => (v > 0 && ds.macro.lqd[i] > 0
    ? Math.max(1, Math.min(9, ((0.045 + (1 - v / 100) * 0.03) - (0.035 + (1 - ds.macro.lqd[i] / 100) * 0.02)) * 100))
    : 2.5 + ds.macro.vix[i] / 20));
  const dt = ds.macro.dxy.map((_, i) => (i < 20 ? 0 : (ds.macro.dxy[i - 20] > 0 ? (ds.macro.dxy[i] / ds.macro.dxy[i - 20] - 1) * 100 : 0)));
  return { vix: ds.macro.vix, yieldSpread: ys, creditSpread: cs, move: ds.macro.move, dxyTrend: dt, btcVol: ds.macro.btcVol };
}

function density(dts: string[]): number {
  const span = (Date.parse(dts[dts.length - 1]) - Date.parse(dts[0])) / 86_400_000;
  return span > 0 ? (dts.length - 1) / (span / 365.25) : 251;
}

async function main() {
  const ds = await loadLongDataset();
  const macroHistory = macroOf(ds);
  const btcPrices = ds.closes['BTC-EUR'];

  // Baseline: sleeve solo (100%) con la densidad real.
  const base = runBacktest({
    closesHistory: ds.closes, macroHistory, lookbackDays: LOOK, rebalanceDays: REB,
    initialCapital: CAPITAL, transactionCostBps: BPS,
  });
  const recLen = base.dailyRecords.length;
  const dts = ds.dates.slice(LOOK, LOOK + recLen);
  const dpy = density(dts);
  const sleeveVals = base.dailyRecords.map(r => r.portfolioValue);

  // Sleeve al 100% medido con la MISMA anualización que el compuesto.
  const sleeve = computeCompositeMetrics({
    olympusDailyValues: sleeveVals, btcPrices, olympusPct: 100,
    initialCapital: CAPITAL, periodsPerYear: dpy,
  });

  // B&H del satélite solo, en la misma ventana (referencia de qué aporta BTC).
  const btcLen = btcPrices.length;
  const btcStart = Math.max(0, btcLen - recLen - 1);
  const btcOnly = computeCompositeMetrics({
    olympusDailyValues: new Array(recLen).fill(CAPITAL), // sleeve plano → solo BTC
    btcPrices: btcPrices.slice(btcStart, btcStart + recLen + 1),
    olympusPct: 0, initialCapital: CAPITAL, periodsPerYear: dpy,
  });

  console.log('='.repeat(112));
  console.log(`  COMPUESTO MOTOR + SATÉLITE BTC · ${dts[0]} → ${dts[dts.length - 1]} · ${recLen} sesiones · ${dpy.toFixed(0)} filas/año`);
  console.log(`  Lookback ${LOOK} · rebalanceo ${REB}d · costes ${BPS} bps · caja remunerada 4% (default del motor)`);
  console.log('='.repeat(112));
  console.log(`  ${'cartera'.padEnd(26)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(8)} ${'Vol'.padStart(8)} ${'MaxDD'.padStart(8)} ${'Calmar'.padStart(8)} ${'final'.padStart(11)} ${'BTC_TOT'.padStart(9)}`);
  const row = (name: string, m: { cagr: number; sharpe: number; maxDrawdown: number; calmar: number; volatility: number; finalValue: number }, btcTotal?: string) =>
    console.log(`  ${name.padEnd(26)} ${pc(m.cagr).padStart(8)} ${m.sharpe.toFixed(2).padStart(8)} ${pc(m.volatility).padStart(8)} ${pc(m.maxDrawdown).padStart(8)} ${m.calmar.toFixed(2).padStart(8)} ${('€' + m.finalValue.toFixed(0)).padStart(11)} ${(btcTotal ?? '—').padStart(9)}`);

  row('Sleeve motor 100/0', sleeve);
  row('BTC B&H solo (satélite)', btcOnly);

  const splits: [number, boolean][] = [[85, false], [85, true], [80, false], [80, true]];
  const out: { pct: number; coupled: boolean; cagr: number; sharpe: number; mdd: number; calmar: number; vol: number; finalValue: number }[] = [];
  for (const [olyPctNum, coupled] of splits) {
    let m: { cagr: number; sharpe: number; maxDrawdown: number; calmar: number; volatility: number; finalValue: number };
    let btcTotal = '—';
    if (coupled) {
      const r = runBacktestCoupled({
        closesHistory: ds.closes, macroHistory, lookbackDays: LOOK, rebalanceDays: REB,
        initialCapital: CAPITAL, transactionCostBps: BPS, olympusPct: olyPctNum,
        btcPrices, periodsPerYear: dpy,
      });
      m = r.composite;
      const risk = computeBtcTotalRisk(r.backtest.dailyRecords.map(x => x.allocations), olyPctNum);
      btcTotal = pc(risk.btcTotalMeanPct / 100, 1);
      out.push({ pct: olyPctNum, coupled, ...m });
    } else {
      // Sin acoplamiento: mezcla de los retornos del sleeve baseline con BTC.
      m = computeCompositeMetrics({
        olympusDailyValues: sleeveVals, btcPrices, olympusPct: olyPctNum,
        initialCapital: CAPITAL, periodsPerYear: dpy,
      });
      out.push({ pct: olyPctNum, coupled, ...m });
    }
    row(`${olyPctNum}/${100 - olyPctNum} ${coupled ? 'acoplado' : 'sin acoplar'}`, m, btcTotal);
  }

  console.log('='.repeat(112));
  const sat = btcSatPct(80);
  console.log(`  Satélite: ${pc(sat)} del capital a BTC buy & hold; el resto escala el sleeve (${pc(olyPct(80))}).`);
  console.log(`  Acoplamiento = el kill switch del motor ve el DD del portfolio TOTAL (sleeve + satélite),`);

  const g = (p: number, c: boolean) => out.find(x => x.pct === p && x.coupled === c)!;
  console.log('  como en producción (FIX-ACOPLAMIENTO-SATELITE).\n');
  console.log(`  Δ vs sleeve 100/0:`);
  for (const x of out) {
    console.log(`    ${String(x.pct).padStart(3)}/${String(100 - x.pct).padEnd(3)} ${x.coupled ? 'acoplado   ' : 'sin acoplar'}`
      + ` ΔCAGR ${((x.cagr - sleeve.cagr) * 100).toFixed(1).padStart(6)} pp`
      + ` · ΔSharpe ${(x.sharpe - sleeve.sharpe).toFixed(2).padStart(6)}`
      + ` · ΔMaxDD ${((x.mdd ?? x.maxDrawdown) - sleeve.maxDrawdown) * 100 >= 0 ? '+' : ''}${(((x.mdd ?? x.maxDrawdown) - sleeve.maxDrawdown) * 100).toFixed(1).padStart(5)} pp`);
  }
  console.log(`  Efecto del acoplamiento (mismo split, con vs sin):`);
  for (const p of [85, 80]) {
    const a = g(p, false), b = g(p, true);
    console.log(`    ${p}/${100 - p} → ΔCAGR ${((b.cagr - a.cagr) * 100).toFixed(2)} pp · ΔSharpe ${(b.sharpe - a.sharpe).toFixed(3)}`
      + ` · ΔMaxDD ${((b.maxDrawdown - a.maxDrawdown) * 100).toFixed(2)} pp · caja extra por el freno del motor`);
  }
  console.log('='.repeat(112));
}

main();
