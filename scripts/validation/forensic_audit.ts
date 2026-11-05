// AUDITORÍA FORENSE INDEPENDIENTE — mediciones propias sobre el dataset real del repo.
import { loadLongDataset } from './data_long';
import { runBacktest } from '../../src/core/backtest/backtestEngine';
import { ASSETS } from '../../src/lib/constants';

const RF = 0.04;

function stats(rets: number[], dates: string[], ann: number) {
  const n = rets.length;
  const mu = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mu) ** 2, 0) / n);
  const g = rets.reduce((a, r) => a * (1 + r), 1);
  const years = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86400000 / 365.25;
  const cagr = Math.pow(g, 1 / years) - 1;
  const path = [1];
  rets.forEach(r => path.push(path[path.length - 1] * (1 + r)));
  let pk = 1;
  let mdd = 0;
  for (const v of path) {
    if (v > pk) pk = v;
    if (v / pk - 1 < mdd) mdd = v / pk - 1;
  }
  return { cagr, sharpe: sd > 0 ? (mu * ann - RF) / (sd * Math.sqrt(ann)) : 0, vol: sd * Math.sqrt(ann), mdd, calmar: mdd < 0 ? cagr / Math.abs(mdd) : 0 };
}
const pc = (x: number, d = 1) => (x * 100).toFixed(d) + '%';

type Closes = Record<string, number[]>;

function simWeights(closes: Closes, off: number, n: number, wfn: (i: number) => Record<string, number>, rebal: number, bps: number) {
  const rets: number[] = [];
  let w = wfn(0);
  for (let i = 1; i <= n; i++) {
    const gi = off + i;
    let r = 0;
    for (const a of ASSETS) r += (w[a] ?? 0) * (closes[a][gi] / closes[a][gi - 1] - 1);
    rets.push(r);
    let sum = 0;
    for (const a of ASSETS) {
      w[a] = (w[a] ?? 0) * (closes[a][gi] / closes[a][gi - 1]);
      sum += w[a];
    }
    for (const a of ASSETS) w[a] /= (sum || 1);
    if (i % rebal === 0 && i < n) {
      const t = wfn(i);
      let to = 0;
      for (const a of ASSETS) to += Math.abs((t[a] ?? 0) - (w[a] ?? 0));
      rets[rets.length - 1] -= to * bps / 1e4;
      w = { ...t };
    }
  }
  return rets;
}

async function main() {
  const ds = await loadLongDataset();
  const LOOK = 252;
  const REB = 21;
  const mk = (bps: number) => {
    const ys = ds.macro.tnx.map((v, i) => v - ds.macro.irx[i]);
    const cs = ds.macro.hyg.map((v, i) => (v > 0 && ds.macro.lqd[i] > 0
      ? Math.max(1, Math.min(9, ((0.045 + (1 - v / 100) * 0.03) - (0.035 + (1 - ds.macro.lqd[i] / 100) * 0.02)) * 100))
      : 2.5 + ds.macro.vix[i] / 20));
    const dt = ds.macro.dxy.map((_, i) => (i < 20 ? 0 : (ds.macro.dxy[i - 20] > 0 ? (ds.macro.dxy[i] / ds.macro.dxy[i - 20] - 1) * 100 : 0)));
    return runBacktest({
      closesHistory: ds.closes,
      macroHistory: { vix: ds.macro.vix, yieldSpread: ys, creditSpread: cs, move: ds.macro.move, dxyTrend: dt, btcVol: ds.macro.btcVol },
      lookbackDays: LOOK, rebalanceDays: REB, initialCapital: 10000, transactionCostBps: bps,
    });
  };

  const bt = mk(15);
  const recs = bt.dailyRecords as unknown as { portfolioValue: number; regime: string; cash: number }[];
  const dts = ds.dates.slice(LOOK, LOOK + recs.length);
  const twr: number[] = [];
  for (let i = 1; i < recs.length; i++) twr.push(recs[i].portfolioValue / recs[i - 1].portfolioValue - 1);
  const years = (Date.parse(dts[dts.length - 1]) - Date.parse(dts[0])) / 86400000 / 365.25;
  const rowsPerYear = dts.length / years;
  const m252 = stats(twr, dts, 252);
  const m365 = stats(twr, dts, 365);

  console.log('='.repeat(116));
  console.log(`  A1 · ANUALIZACIÓN — ${dts[0]} → ${dts[dts.length - 1]} · ${dts.length} sesiones · ${rowsPerYear.toFixed(0)} filas/año`);
  console.log('='.repeat(116));
  console.log(`  ${'métrica'.padEnd(20)} ${'repo (/365)'.padStart(13)} ${'correcta (252)'.padStart(15)} ${'error'.padStart(11)}`);
  console.log(`  ${'CAGR'.padEnd(20)} ${pc(bt.metrics.cagr).padStart(13)} ${pc(m252.cagr).padStart(15)} ${((bt.metrics.cagr - m252.cagr) * 100).toFixed(1).padStart(8)} pp`);
  console.log(`  ${'Sharpe'.padEnd(20)} ${bt.metrics.sharpe.toFixed(2).padStart(13)} ${m252.sharpe.toFixed(2).padStart(15)} ${(bt.metrics.sharpe - m252.sharpe).toFixed(2).padStart(11)}`);
  console.log(`  ${'Volatilidad'.padEnd(20)} ${pc(bt.metrics.volatility).padStart(13)} ${pc(m252.vol).padStart(15)} ${((bt.metrics.volatility - m252.vol) * 100).toFixed(1).padStart(8)} pp`);
  console.log(`  ${'MaxDD'.padEnd(20)} ${pc(bt.metrics.maxDrawdown).padStart(13)} ${pc(m252.mdd).padStart(15)} ${'—'.padStart(11)}`);
  console.log(`  ${'Calmar'.padEnd(20)} ${bt.metrics.calmar.toFixed(2).padStart(13)} ${m252.calmar.toFixed(2).padStart(15)} ${'—'.padStart(11)}`);

  const n = recs.length - 1;
  const ew = simWeights(ds.closes, LOOK, n, () => Object.fromEntries(ASSETS.map(a => [a, 1 / ASSETS.length])), REB, 6);
  const iv = simWeights(ds.closes, LOOK, n, (i) => {
    const vols = ASSETS.map(a => {
      const gi = LOOK + i;
      const sl = ds.closes[a].slice(Math.max(0, gi - 126), gi);
      const rr: number[] = [];
      for (let k = 1; k < sl.length; k++) rr.push(sl[k] / sl[k - 1] - 1);
      const mu = rr.reduce((x, y) => x + y, 0) / (rr.length || 1);
      return Math.sqrt(rr.reduce((s, r) => s + (r - mu) ** 2, 0) / (rr.length || 1)) || 1e-6;
    });
    const inv = vols.map(v => 1 / v);
    const s = inv.reduce((x, y) => x + y, 0);
    return Object.fromEntries(ASSETS.map((a, k) => [a, inv[k] / s]));
  }, REB, 6);
  const ewm = stats(ew, dts, 252);
  const ivm = stats(iv, dts, 252);
  const withCash = twr.map((r, i) => r + (recs[i + 1].cash ?? 0) * RF / 252);
  const cm = stats(withCash, dts, 252);

  console.log('\n' + '='.repeat(116));
  console.log('  A2 · MOTOR vs BENCHMARKS (anualización 252; benchmarks con 6 bps por rebalanceo)');
  console.log('='.repeat(116));
  console.log(`  ${'cartera'.padEnd(22)} ${'CAGR'.padStart(9)} ${'Sharpe'.padStart(8)} ${'Vol'.padStart(8)} ${'MaxDD'.padStart(9)} ${'Calmar'.padStart(8)}`);
  const rows: [string, ReturnType<typeof stats>][] = [
    ['Motor V5 (15bps)', m252],
    ['Motor + caja al 4%', cm],
    ['Eq-W 21d (6bps)', ewm],
    ['Inv-Vol 126d (6bps)', ivm],
  ];
  for (const [name, m] of rows) {
    console.log(`  ${name.padEnd(22)} ${pc(m.cagr).padStart(9)} ${m.sharpe.toFixed(2).padStart(8)} ${pc(m.vol).padStart(8)} ${pc(m.mdd).padStart(9)} ${m.calmar.toFixed(2).padStart(8)}`);
  }
  console.log(`  (con √365 el motor daría Sharpe ${m365.sharpe.toFixed(2)} y CAGR ${pc(m365.cagr)})`);

  console.log('\n' + '='.repeat(116));
  console.log('  A3 · ¿transactionCostBps hace algo?');
  console.log('='.repeat(116));
  for (const bps of [0, 15, 30, 60]) {
    const r = mk(bps);
    const rr = r.dailyRecords as unknown as { portfolioValue: number }[];
    console.log(`  bps=${String(bps).padStart(2)} → final €${rr[rr.length - 1].portfolioValue.toFixed(0)} · costes imputados €${r.totalTransactionCosts.toFixed(0)} · rebalanceos ${r.rebalanceCount}`);
  }

  const regs: Record<string, number> = {};
  for (const r of recs) regs[r.regime] = (regs[r.regime] ?? 0) + 1;
  const cash = recs.map(r => r.cash ?? 0).sort((a, b) => a - b);
  console.log('\n' + '='.repeat(116));
  console.log(`  A4 · RÉGIMEN: ${Object.entries(regs).map(([k, v]) => `${k} ${(v / recs.length * 100).toFixed(1)}%`).join(' · ')}`);
  console.log(`  Caja: media ${pc(cash.reduce((a, b) => a + b, 0) / cash.length)} · p95 ${pc(cash[Math.floor(cash.length * 0.95)])} · máx ${pc(cash[cash.length - 1])}`);

  const fwd: number[] = [];
  for (let i = 0; i + 21 < ew.length; i++) fwd.push(ew.slice(i, i + 21).reduce((g, r) => g * (1 + r), 1) - 1);
  const hi = fwd.filter((_, i) => (recs[i + 1].cash ?? 0) >= 0.5);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  console.log(`  EW a 21d tras caja≥50%: ${pc(avg(hi))} (n=${hi.length}) vs incondicional ${pc(avg(fwd))}`);

  const EP: [string, string, string][] = [
    ['Q4-2018', '2018-09-01', '2018-12-31'],
    ['COVID', '2020-02-20', '2020-03-23'],
    ['2022', '2022-01-01', '2022-10-12'],
    ['2025-26', '2025-01-01', '2026-09-30'],
  ];
  const g = (a: number[]) => a.reduce((x, r) => x * (1 + r), 1) - 1;
  const dd = (a: number[]) => {
    const p = [1];
    a.forEach(r => p.push(p[p.length - 1] * (1 + r)));
    let pk = 1;
    let m = 0;
    for (const v of p) {
      if (v > pk) pk = v;
      if (v / pk - 1 < m) m = v / pk - 1;
    }
    return m;
  };
  console.log('\n' + '='.repeat(116));
  console.log('  A5 · EPISODIOS');
  console.log('='.repeat(116));
  for (const [name, f, t] of EP) {
    const idx: number[] = [];
    for (let i = 1; i < dts.length; i++) if (dts[i] >= f && dts[i] <= t) idx.push(i - 1);
    if (idx.length < 5) continue;
    const sub = idx.map(i => twr[i]);
    const subB = idx.map(i => ew[i]);
    console.log(`  ${name.padEnd(9)} motor ${pc(g(sub)).padStart(8)} · EW ${pc(g(subB)).padStart(8)} · MaxDD motor ${pc(dd(sub))} vs EW ${pc(dd(subB))}`);
  }
  console.log('='.repeat(116));
}

main();
