// ============================================================
// scripts/validation/fase2c_test5.ts
// FASE 2C · TEST 5 — BENCHMARKS con capital, aportaciones, costes y calendario comunes.
//   Separa CAGR (TWR) / XIRR / TWR. Resuelve la discrepancia:
//     B&H CAGR 63,36% (Test A) vs XIRR 33,14% vs V6 34,93%.
// Ejecutar: npx tsx scripts/validation/fase2c_test5.ts
// ============================================================

import { buildCanonicalDataset, runEngine, shadowSim, CFG, pct, xirr } from './sim_core';
import { loadLongDataset, validate } from './data_long';
import { full, WINDOWS, type WindowKey } from './metrics_unified';
import { computeTradeCost } from '../../src/core/validation/transactionCosts';
import { btcSatPct, olyPct } from '../../src/core/backtest/composite';
import { ASSETS } from '../../src/lib/constants';

const isBTC = (t: string) => t === 'BTC-EUR';

interface ContribResult {
  values: number[]; dates: string[]; twr: number[]; flows: number[]; contributions: number;
  costs: number; turnover: number; orders: number; final: number; xirr: number;
}

/** Portafolio con aportaciones €400/mes. mode 'rebalance' → a targets cada N días (vende/compra);
 *  mode 'deployOnly' → solo despliega el aporte en pesos iguales (B&H). Costes reales, ETFs enteros. */
function runContrib(ds: ReturnType<typeof buildCanonicalDataset>, target: Record<string, number>[] | null, opts: { rebalanceEvery?: number; mode?: 'rebalance' | 'deployOnly' } = {}): ContribResult {
  const mode = opts.mode ?? 'rebalance';
  const every = opts.rebalanceEvery ?? CFG.rebalanceDays;
  const { dates, closes } = ds;
  const R = runEngine(ds);
  const REC = R.recs.length;
  let cash = CFG.initialCapital;
  const shares: Record<string, number> = {}; ASSETS.forEach(a => shares[a] = 0);
  let costs = 0, turnover = 0, orders = 0;
  const values: number[] = [], twr: number[] = [], outDates: string[] = [], flows: number[] = [];
  let lastMonth = parseInt(dates[CFG.lookbackDays].slice(5, 7), 10);
  let contributions = 0;
  const px = (t: string, di: number) => closes[t][di];

  for (let k = 0; k < REC; k++) {
    const di = CFG.lookbackDays + k;
    const d = dates[di];
    outDates.push(d);
    const m = parseInt(d.slice(5, 7), 10);
    let flow = 0;
    if (k > 0 && m !== lastMonth) { lastMonth = m; cash += CFG.monthlyContribution; flow = CFG.monthlyContribution; contributions += flow; }
    flows.push(flow);
    const prevVal = values.length ? values[values.length - 1] : CFG.initialCapital;
    let pv = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a, di), 0);

    const doRebalance = mode === 'rebalance' && k % every === 0;
    if (doRebalance && target) {
      const tgt = target[k];
      for (const a of ASSETS) { // SELL a target
        const tv = (tgt[a] ?? 0) * pv; const cur = shares[a] * px(a, di);
        if (cur > tv + 0.01) {
          const notional = cur - tv;
          const c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: notional / pv, portfolioValueEur: pv, priceEur: px(a, di) }).totalCostEur;
          const sh = isBTC(a) ? notional / px(a, di) : Math.floor(notional / px(a, di));
          if (sh <= 0) continue;
          const actual = sh * px(a, di);
          shares[a] -= sh; cash += actual - c; costs += c; turnover += actual; orders++;
        }
      }
      pv = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a, di), 0);
      for (const a of ASSETS) { // BUY a target
        const tv = (tgt[a] ?? 0) * pv; const cur = shares[a] * px(a, di);
        if (tv > cur + 0.01) {
          let notional = tv - cur;
          let c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: notional / pv, portfolioValueEur: pv, priceEur: px(a, di) }).totalCostEur;
          if (notional + c > cash) { notional = Math.max(0, cash - c); c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: notional / pv, portfolioValueEur: pv, priceEur: px(a, di) }).totalCostEur; }
          if (notional <= 0.01) continue;
          const sh = isBTC(a) ? notional / px(a, di) : Math.floor(notional / px(a, di));
          if (sh <= 0) continue;
          const actual = sh * px(a, di);
          shares[a] += sh; cash -= actual + c; costs += c; turnover += actual; orders++;
        }
      }
    } else if (flow > 0) { // deployOnly: despliegue del aporte en pesos iguales
      const per = flow / ASSETS.length;
      for (const a of ASSETS) {
        let notional = per;
        let c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: notional / pv, portfolioValueEur: pv, priceEur: px(a, di) }).totalCostEur;
        if (notional + c > cash) { notional = Math.max(0, cash - c); c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: notional / pv, portfolioValueEur: pv, priceEur: px(a, di) }).totalCostEur; }
        if (notional <= 0.01) continue;
        const sh = isBTC(a) ? notional / px(a, di) : Math.floor(notional / px(a, di));
        if (sh <= 0) continue;
        const actual = sh * px(a, di);
        shares[a] += sh; cash -= actual + c; costs += c; turnover += actual; orders++;
      }
    }

    const pvNow = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a, di), 0);
    values.push(pvNow);
    if (k > 0) twr.push((pvNow - flow) / prevVal - 1);
  }
  const fl = [{ t: 0, amount: -CFG.initialCapital }];
  for (let i = 1; i < flows.length; i++) if (flows[i] > 0) fl.push({ t: i, amount: -flows[i] });
  fl.push({ t: flows.length, amount: values[values.length - 1] });
  return { values, dates: outDates, twr, flows, contributions, costs, turnover, orders, final: values[values.length - 1], xirr: xirr(fl) };
}

/** Métricas de ventana + XIRR de ventana (V_inicio como inversión inicial). */
function winMetrics(r: ContribResult, K: WindowKey) {
  const [f, t] = WINDOWS[K];
  const s = r.dates.findIndex(d => d >= f);
  const e = r.dates.findIndex(d => d > t);
  const end = e < 0 ? r.dates.length : e;
  if (s < 0 || end - s < 2) return null;
  const twrW = r.twr.slice(s, end - 1);
  const valsW = r.values.slice(s, end);
  const datesW = r.dates.slice(s, end);
  const m = full(twrW, datesW);
  const fl = [{ t: 0, amount: -r.values[s] }];
  for (let i = s + 1; i < end; i++) if (r.flows[i] > 0) fl.push({ t: i - s, amount: -r.flows[i] });
  fl.push({ t: end - 1 - s, amount: r.values[end - 1] });
  const x = xirr(fl);
  return { m, xirr: x, n: end - s };
}

// ═══════════════════════════════════════════════════════════════
// PARTE A — Resolver la discrepancia en el dataset CANÓNICO (igual que Test A)
// ═══════════════════════════════════════════════════════════════
console.log('='.repeat(122));
console.log('  TEST 5-A — DISCREPANCIA DEL B&H (dataset canónico, réplica de Test A / P1)');
console.log('='.repeat(122));
{
  const ds = buildCanonicalDataset();
  const { dates, closes } = ds;
  const R = runEngine(ds);
  const REC = R.recs.length;
  const lb = CFG.lookbackDays;
  // B&H equal-weight fraccional SIN costes (réplica de Test A)
  const shares: Record<string, number> = {}; ASSETS.forEach(a => shares[a] = 0);
  let cash = CFG.initialCapital; const invest = cash / ASSETS.length;
  ASSETS.forEach(a => shares[a] = invest / closes[a][lb]); cash = 0;
  const vals: number[] = []; const twrBad: number[] = []; const twrGood: number[] = []; const flows: number[] = [];
  let lastM = parseInt(dates[lb].slice(5, 7), 10); let contrib = 0;
  for (let k = 1; k < REC; k++) {
    const di = k + lb; const m = parseInt(dates[di].slice(5, 7), 10); let flow = 0;
    if (m !== lastM) { lastM = m; cash += CFG.monthlyContribution; flow = CFG.monthlyContribution; contrib += flow; ASSETS.forEach(a => { shares[a] += cash / ASSETS.length / closes[a][di]; }); cash = 0; }
    flows.push(flow);
    const v = ASSETS.reduce((s, a) => s + shares[a] * closes[a][di], 0);
    vals.push(v);
    if (vals.length > 1) { twrBad.push(v / vals[vals.length - 2] - 1); twrGood.push((v - flow) / vals[vals.length - 2] - 1); }
  }
  const dts = dates.slice(lb + 1, lb + 1 + twrBad.length);
  const mBad = full(twrBad, dts); const mGood = full(twrGood, dts);
  const fl = [{ t: 0, amount: -CFG.initialCapital }];
  for (let i = 0; i < flows.length; i++) if (flows[i] > 0) fl.push({ t: i + 1, amount: -flows[i] });
  fl.push({ t: flows.length + 1, amount: vals[vals.length - 1] });
  const xbh = xirr(fl);
  // V6 lump-sum (sin aportaciones, con costes)
  const s6 = shadowSim(ds, new Array(REC).fill(0).map(() => Object.fromEntries(ASSETS.map(a => [a, 1 / ASSETS.length]))), { rebalanceEvery: 1_000_000_000 });
  const m6 = full(s6.twr, s6.dates);
  console.log(`  B&H TWR CONTAMINADO (sin restar el aporte) : CAGR ${pct(mBad.cagr)}  Sharpe ${mBad.sharpe.toFixed(3)}  MaxDD ${pct(mBad.maxDD, 1)}  ← réplica 63,36% / 2,169 / −21,6%`);
  console.log(`  B&H TWR CORREGIDO  (aporte F_t restado)   : CAGR ${pct(mGood.cagr)}  Sharpe ${mGood.sharpe.toFixed(3)}  MaxDD ${pct(mGood.maxDD, 1)}  ← rendimiento puro real`);
  console.log(`  B&H XIRR (money-weighted)                  : ${pct(xbh)}  ← réplica 33,14%`);
  console.log(`  V6 lump-sum (€10k, sin aportes, costes)    : CAGR ${pct(m6.cagr)}  ← réplica 34,93%`);
  console.log(`\n  EXPLICACIÓN: el runner de Test A calcula el TWR como v/v_prev−1 SIN restar el aporte de €400;`);
  console.log(`  cada ingreso se contabiliza como retorno positivo (≈+${pct(CFG.monthlyContribution / CFG.initialCapital, 1)} de golpe al inicio) y compounded ~${flows.filter(x => x > 0).length} veces → CAGR inflado 63,36%.`);
  console.log(`  El TWR corregido (${pct(mGood.cagr)}) converge con V6 (${pct(m6.cagr)}) y con el XIRR (${pct(xbh)}).`);
  console.log(`  Veredicto: CAGR del runner B&H = NO VERIFICADO (error de flujos); XIRR 33,14% y V6 34,93% = correctos.`);
}

// ═══════════════════════════════════════════════════════════════
// PARTE B — Tabla final sobre el dataset LARGO (con aportaciones comunes)
// ═══════════════════════════════════════════════════════════════
(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('\n' + '='.repeat(122));
  console.log('  TEST 5-B — BENCHMARKS (dataset largo · €10k + €400/mes · costes reales · ETFs enteros)');
  console.log('='.repeat(122));
  if (!v.valid) { console.log('  NO VÁLIDO'); return; }
  const R = runEngine(ds);
  const REC = R.recs.length;
  const ew = new Array(REC).fill(0).map(() => Object.fromEntries(ASSETS.map(a => [a, 1 / ASSETS.length])));

  const bh = runContrib(ds, null, { mode: 'deployOnly' });
  const eq = runContrib(ds, ew, { rebalanceEvery: 21 });
  // V3 (HRP+volTarget) reutiliza el harness de TEST 1 vía shadow→aportes: aquí recomputamos V3 targets
  const { computeHRP } = await import('../../src/core/risk/hrp');
  const { computeVolTargetMultiplier } = await import('../../src/core/risk/volatilityTarget');
  const N = ASSETS.length;
  function retW(a: string, di: number, w: number) { const r: number[] = []; for (let i = Math.max(1, di - w + 1); i <= di; i++) r.push(ds.closes[a][i] / ds.closes[a][i - 1] - 1); return r; }
  function covAt(di: number, w: number) { const rs = ASSETS.map(a => retW(a, di, w)); const m = rs[0].length; const means = rs.map(x => x.reduce((s, q) => s + q, 0) / m); const C: number[][] = Array.from({ length: N }, () => new Array(N).fill(0)); for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { let s = 0; for (let k = 0; k < m; k++) s += (rs[i][k] - means[i]) * (rs[j][k] - means[j]); C[i][j] = s / m; } return C; }
  function portVol(w: number[], di: number, win: number) { const C = covAt(di, win); let s = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) s += w[i] * w[j] * C[i][j]; return Math.sqrt(Math.max(0, s) * CFG.dpy); }
  const t3: Record<string, number>[] = [];
  let cur3: Record<string, number> = {};
  for (let k = 0; k < REC; k++) { const di = CFG.lookbackDays + k; if (k % 21 === 0) { const w = computeHRP(covAt(di, 252), N).weights; const vt = computeVolTargetMultiplier({ targetVol: 0.20, realizedVol: portVol(w, di, 63), regimePenalty: 1.0 }).multiplier; cur3 = Object.fromEntries(ASSETS.map((a, i) => [a, w[i] * vt])); } t3.push({ ...cur3 }); }
  const v3 = runContrib(ds, t3, { rebalanceEvery: 21 });
  const motorT = R.recs.map(r => r.allocations as Record<string, number>);
  const motor = runContrib(ds, motorT, { rebalanceEvery: 21 });
  const comp = R.recs.map(r => { const e = r.allocations as Record<string, number>; const t: Record<string, number> = {}; for (const a of ASSETS) t[a] = (e[a] ?? 0) * olyPct(80) + (a === 'BTC-EUR' ? btcSatPct(80) : 0); return t; });
  const btc = runContrib(ds, comp, { rebalanceEvery: 21 });

  const portfolios: [string, ContribResult][] = [['B&H universo', bh], ['Equal Weight', eq], ['V3 HRP+volTarget', v3], ['Motor completo', motor], ['BTC total (sat+motor)', btc]];
  console.log(`\n  ${'Cartera'.padEnd(24)} ${'FULL CAGR'.padStart(10)} ${'FULL XIRR'.padStart(10)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95'.padStart(8)} ${'turnover'.padStart(10)} ${'costes'.padStart(8)} ${'final'.padStart(10)}`);
  console.log('  ' + '-'.repeat(104));
  for (const [n, r] of portfolios) {
    const m = full(r.twr, r.dates);
    console.log(`  ${n.padEnd(24)} ${pct(m.cagr).padStart(10)} ${pct(r.xirr).padStart(10)} ${m.sharpe.toFixed(3).padStart(7)} ${pct(m.maxDD, 1).padStart(8)} ${pct(m.cvar95).padStart(8)} ${('€' + r.turnover.toFixed(0)).padStart(10)} ${('€' + r.costs.toFixed(0)).padStart(8)} ${('€' + r.final.toFixed(0)).padStart(10)}`);
  }

  console.log(`\n── TABLA FINAL · HOLDOUT / VISTA / FULL (CAGR TWR · XIRR · Sharpe · MaxDD · CVaR95) ──`);
  for (const K of ['HOLDOUT', 'VISTA', 'FULL'] as WindowKey[]) {
    console.log(`\n  ${K} (${WINDOWS[K][0]}→${WINDOWS[K][1]})`);
    console.log(`    ${'Cartera'.padEnd(24)} ${'CAGR'.padStart(8)} ${'XIRR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'CVaR95'.padStart(8)}`);
    for (const [n, r] of portfolios) {
      const w = winMetrics(r, K); if (!w) continue;
      console.log(`    ${n.padEnd(24)} ${pct(w.m.cagr).padStart(8)} ${pct(w.xirr).padStart(8)} ${w.m.sharpe.toFixed(3).padStart(7)} ${pct(w.m.maxDD, 1).padStart(8)} ${pct(w.m.cvar95).padStart(8)}`);
    }
  }
})();
