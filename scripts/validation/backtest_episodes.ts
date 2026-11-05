// ============================================================
// scripts/validation/backtest_episodes.ts
// Backtest del MOTOR sobre datos REALES (proxies Yahoo 2017-2026) segmentado por
// expansiones y crisis. Solo lectura: no modifica src/.
// NOTA: DailyRecord solo expone { regime, cash }; el efecto de las capas se mide
// por la CAJA (1 − exposición), no por killSwitchLevel/volTarget (no persistidos).
// Ejecutar: npx tsx scripts/validation/backtest_episodes.ts
// ============================================================
import { loadLongDataset } from './data_long';
import { runBacktest } from '../../src/core/backtest/backtestEngine';
import { ASSETS } from '../../src/lib/constants';
import { CFG } from './sim_core';

const LOOKBACK = 126;
const RF = 0.04;

interface Rec { portfolioValue: number; drawdown: number; regime: string; cash: number; }

const annualVol = (r: number[]) => {
  const n = r.length; if (!n) return 0;
  const mu = r.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(r.reduce((s, x) => s + (x - mu) ** 2, 0) / n) * Math.sqrt(252);
};
const sharpe = (r: number[]) => {
  const n = r.length; if (n < 2) return 0;
  const mu = r.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mu) ** 2, 0) / n);
  return sd > 0 ? (mu * 252 - RF) / (sd * Math.sqrt(252)) : 0;
};
const maxDD = (v: number[]) => { let pk = v[0] ?? 1, dd = 0; for (const x of v) { if (x > pk) pk = x; const d = x / pk - 1; if (d < dd) dd = d; } return dd; };
const pctf = (x: number, d = 1) => (x * 100).toFixed(d) + '%';
const cum = (r: number[]) => r.reduce((g, x) => g * (1 + x), 1) - 1;
const path = (r: number[]) => { const v = [1]; r.forEach(x => v.push(v[v.length - 1] * (1 + x))); return v; };

async function main() {
  const ds = await loadLongDataset();
  const { dates, closes, macro } = ds;
  const yieldSpread = macro.tnx.map((v, i) => v - macro.irx[i]);
  const creditSpread = macro.hyg.map((v, i) => {
    if (v > 0 && macro.lqd[i] > 0) {
      const hy = 0.045 + (1 - v / 100) * 0.03, ly = 0.035 + (1 - macro.lqd[i] / 100) * 0.02;
      return Math.max(1, Math.min(9, (hy - ly) * 100));
    }
    return 2.5 + macro.vix[i] / 20;
  });
  const dxyTrend = macro.dxy.map((_, i) => (i < 20 || !(macro.dxy[i - 20] > 0) ? 0 : ((macro.dxy[i] - macro.dxy[i - 20]) / macro.dxy[i - 20]) * 100));

  const bt = runBacktest({
    closesHistory: closes,
    macroHistory: { vix: macro.vix, yieldSpread, creditSpread, move: macro.move, dxyTrend, btcVol: macro.btcVol },
    lookbackDays: LOOKBACK, rebalanceDays: 21, initialCapital: CFG.initialCapital, transactionCostBps: 15,
  });
  const recs = bt.dailyRecords as unknown as Rec[];
  const dts = dates.slice(LOOKBACK, LOOKBACK + recs.length);
  const twr: number[] = [], bench: number[] = [];
  for (let i = 1; i < recs.length; i++) {
    twr.push(recs[i].portfolioValue / recs[i - 1].portfolioValue - 1);
    const di = LOOKBACK + i;
    bench.push(ASSETS.reduce((s, a) => s + (closes[a][di] / closes[a][di - 1] - 1), 0) / ASSETS.length);
  }

  const EPISODES: [string, string, string][] = [
    ['Expansión 2018', '2018-01-01', '2018-08-31'],
    ['Q4-2018 (crash)', '2018-09-01', '2018-12-31'],
    ['Expansión 2019', '2019-01-01', '2020-02-19'],
    ['COVID (crash)', '2020-02-20', '2020-03-23'],
    ['Expansión 2020-21', '2020-03-24', '2021-12-31'],
    ['Bear 2022', '2022-01-01', '2022-10-12'],
    ['Expansión 2022-24', '2022-10-13', '2024-12-31'],
    ['2025-2026', '2025-01-01', '2026-10-01'],
  ];

  console.log('='.repeat(150));
  console.log(`  BACKTEST POR EPISODIOS — datos reales ${dts[0]} → ${dts[dts.length - 1]} · ${recs.length} días · lookback ${LOOKBACK}d · costes 15bps`);
  console.log('='.repeat(150));
  console.log(`  ${'episodio'.padEnd(19)} ${'días'.padStart(5)} ${'motor'.padStart(9)} ${'eq-w'.padStart(9)} ${'Δ'.padStart(8)} ${'Sh m'.padStart(6)} ${'Sh b'.padStart(6)} ${'vol'.padStart(7)} ${'MaxDD'.padStart(8)} ${'DD eq-w'.padStart(8)} ${'CRISIS'.padStart(7)} ${'CONTR'.padStart(6)} ${'EXP'.padStart(5)} ${'caja m'.padStart(7)} ${'caja máx'.padStart(8)}`);
  console.log('  ' + '-'.repeat(146));
  const crises: { name: string; motor: number; bench: number }[] = [];

  for (const [name, from, to] of EPISODES) {
    const idx: number[] = [];
    for (let i = 1; i < dts.length; i++) if (dts[i] >= from && dts[i] <= to) idx.push(i);
    if (idx.length < 5) { console.log(`  ${name.padEnd(19)}  sin días en el dataset`); continue; }
    const rm = idx.map(i => twr[i - 1]), rb = idx.map(i => bench[i - 1]);
    const regs = idx.map(i => recs[i].regime);
    const sh = (x: string) => regs.filter(r => r === x).length / regs.length;
    const cash = idx.map(i => recs[i].cash ?? 0);
    if (cum(rb) < 0) crises.push({ name, motor: cum(rm), bench: cum(rb) });
    console.log(`  ${name.padEnd(19)} ${String(idx.length).padStart(5)} ${pctf(cum(rm)).padStart(9)} ${pctf(cum(rb)).padStart(9)} ${pctf(cum(rm) - cum(rb)).padStart(8)} ${sharpe(rm).toFixed(2).padStart(6)} ${sharpe(rb).toFixed(2).padStart(6)} ${pctf(annualVol(rm)).padStart(7)} ${pctf(maxDD(path(rm))).padStart(8)} ${pctf(maxDD(path(rb))).padStart(8)} ${pctf(sh('CRISIS'), 0).padStart(7)} ${pctf(sh('CONTRACTION'), 0).padStart(6)} ${pctf(sh('EXPANSION'), 0).padStart(5)} ${pctf(cash.reduce((a, b) => a + b, 0) / cash.length, 0).padStart(7)} ${pctf(Math.max(...cash), 0).padStart(8)}`);
  }

  console.log('  ' + '-'.repeat(146));
  const allRegs = recs.map(r => r.regime);
  const allCash = recs.map(r => r.cash ?? 0);
  console.log(`  ${'TOTAL'.padEnd(19)} ${String(recs.length).padStart(5)} ${pctf(cum(twr)).padStart(9)} ${pctf(cum(bench)).padStart(9)} ${pctf(cum(twr) - cum(bench)).padStart(8)} ${sharpe(twr).toFixed(2).padStart(6)} ${sharpe(bench).toFixed(2).padStart(6)} ${pctf(annualVol(twr)).padStart(7)} ${pctf(maxDD(path(twr))).padStart(8)} ${pctf(maxDD(path(bench))).padStart(8)} ${pctf(allRegs.filter(r => r === 'CRISIS').length / recs.length, 0).padStart(7)} ${pctf(allRegs.filter(r => r === 'CONTRACTION').length / recs.length, 0).padStart(6)} ${pctf(allRegs.filter(r => r === 'EXPANSION').length / recs.length, 0).padStart(5)} ${pctf(allCash.reduce((a, b) => a + b, 0) / allCash.length, 0).padStart(7)} ${pctf(Math.max(...allCash), 0).padStart(8)}`);
  console.log('='.repeat(150));
  console.log(`  Costes €${bt.totalTransactionCosts.toFixed(0)} · rebalanceos ${bt.rebalanceCount} · capital final €${recs[recs.length - 1].portfolioValue.toFixed(0)} (inicial €${CFG.initialCapital})`);
  console.log(`  Captura en crisis (motor/eq-w, cuanto más bajo mejor): ${crises.map(c => `${c.name} ${(c.motor / c.bench).toFixed(2)}`).join(' · ')}`);
  const worst = twr.map((_, i) => ({ i, r: cum(twr.slice(i, i + 20)) })).sort((a, b) => a.r - b.r).slice(0, 3);
  const worstB = bench.map((_, i) => ({ i, r: cum(bench.slice(i, i + 20)) })).sort((a, b) => a.r - b.r).slice(0, 3);
  console.log(`  Peores 20 sesiones — motor: ${worst.map(w => `${dts[w.i + 1]} ${pctf(w.r)}`).join(' · ')}`);
  console.log(`  Peores 20 sesiones — eq-w : ${worstB.map(w => `${dts[w.i + 1]} ${pctf(w.r)}`).join(' · ')}`);
}
main();
