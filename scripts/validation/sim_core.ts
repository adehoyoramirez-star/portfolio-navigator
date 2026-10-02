// ============================================================
// scripts/validation/sim_core.ts
// FASE 2B — Simulador de CUENTA REAL parametrizado (dataset como entrada)
// + shadow-sim de variantes (P2 ablation/caps) + métricas compartidas.
// Réplica de account_core.ts (FASE 2A) con logging de trims. VALIDACIÓN:
// sobre el dataset canónico debe reproducir account_backtest.ts:
//   23.39% / 1.244 / −12.5% / €524 / 343 órdenes / 49 trims / €81.595.
// ============================================================

import fs from 'fs';
import path from 'path';
import { runBacktest } from '../../src/core/backtest/backtestEngine';
import { computeSmartDCA } from '../../src/core/dca/smartDCA';
import type { SmartDCAInput } from '../../src/core/dca/smartDCA';
import { computeRebalanceSuggestions, type RebalanceAsset } from '../../src/core/portfolio/rebalancer';
import { computeTradeCost, ASSET_COST_PARAMS } from '../../src/core/validation/transactionCosts';
import { btcTotalExposure } from '../../src/core/backtest/composite';
import { ASSETS } from '../../src/lib/constants';

export const CFG = { lookbackDays: 252, rebalanceDays: 21, initialCapital: 10_000, monthlyContribution: 400, rf: 0.04, dpy: 365 };
export const pct = (x: number, d = 2) => (x * 100).toFixed(d) + '%';

export interface Dataset {
  dates: string[]; closes: Record<string, number[]>;
  macro: { vix: number[]; tnx: number[]; irx: number[]; hyg: number[]; lqd: number[]; move: number[]; dxy: number[]; btcVol: number[] };
}

export function buildCanonicalDataset(): Dataset {
  const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter(l => l.trim());
  const H = lines[0].split(',');
  const closes: Record<string, number[]> = {}; ASSETS.forEach(a => closes[a] = []);
  const macro: Dataset['macro'] = { vix: [], tnx: [], irx: [], hyg: [], lqd: [], move: [], dxy: [], btcVol: [] };
  const dates: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(','); if (p.length < H.length) continue;
    dates.push(p[0]);
    for (const a of ASSETS) { const k = H.indexOf(a); if (k !== -1) closes[a].push(parseFloat(p[k]) || 0); }
    const g = (n: string, d: number) => { const k = H.indexOf(n); return k === -1 ? d : parseFloat(p[k]) || d; };
    macro.vix.push(g('^VIX', 0)); macro.tnx.push(g('^TNX', 0)); macro.irx.push(g('^IRX', 0));
    macro.hyg.push(g('HYG', 0)); macro.lqd.push(g('LQD', 0));
    macro.move.push(g('^MOVE', 95)); macro.dxy.push(g('DX-Y.NYB', 103)); macro.btcVol.push(g('BTC_VOL', 30));
  }
  const nLen = Math.min(...ASSETS.map(a => closes[a].length));
  ASSETS.forEach(a => closes[a] = closes[a].slice(0, nLen));
  return { dates: dates.slice(0, nLen), closes, macro };
}

// cost override in-memory (no se toca src/)
const origParams = JSON.parse(JSON.stringify(ASSET_COST_PARAMS));
export function setCostScale(s: number) {
  for (const t of Object.keys(ASSET_COST_PARAMS)) {
    const o = origParams[t], c = ASSET_COST_PARAMS[t];
    c.halfSpreadBps = o.halfSpreadBps * s;
    c.impactCoefficient = o.impactCoefficient * s;
  }
}

export interface TrimLogRow {
  date: string; ticker: string; drift: number; soldEur: number; currentPct: number; targetPct: number;
  buysSinceReb: number; buys7: number; buys14: number; buys30: number; assetRet: number; pvRet: number;
}
export interface SimResult {
  twr: number[]; values: number[]; dates: string[];
  cagr: number; sharpe: number; sortino: number; maxDD: number; vol: number; cvar95: number;
  turnoverEur: number; orders: number; costs: number;
  cashMean: number; cashMax: number; cashSeries: number[];
  trimLog: TrimLogRow[]; trimCountAll: number; trimEurAll: number;
  legacyRoundTrips: number; legacyRoundTripEur: number;
  churnDirectEur: number;
  finalValue: number; contributions: number; xirr: number;
  regimeDays: Record<string, number>;
  // FASE 2C · TEST 2 — instrumentación de la capa DCA
  dcaEvalDays: number; ksBlockedDays: number; vtBlockedDays: number;
  dcaBuyCount: number; dcaBuyEur: number; sellCount: number; sellEur: number;
}

function btcIndicators(ds: Dataset, di: number) {
  const series = ds.closes['BTC-EUR'];
  const p = series[di];
  const win = series.slice(Math.max(0, di - 251), di + 1);
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const sd = Math.sqrt(win.reduce((s, v) => s + (v - mean) ** 2, 0) / win.length) || 1;
  const z = (p - mean) / sd;
  const l15 = win.slice(-15);
  const diffs = l15.map((v, k) => (k === 0 ? 0 : v - l15[k - 1]));
  const g = diffs.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const l = diffs.filter(x => x < 0).reduce((a, b) => a - b, 0);
  const rsi = l > 0 ? 100 - 100 / (1 + g / l) : 100;
  const mom1m = win.length > 31 ? p / win[win.length - 31] - 1 : 0;
  const ma252 = win.reduce((a, b) => a + b, 0) / win.length;
  return { rsi, z, mom1m, mvrv: ma252 > 0 ? p / ma252 : 3 };
}

export function deriveMacro(ds: Dataset) {
  const yieldSpread = ds.macro.tnx.map((v, i) => v - ds.macro.irx[i]);
  const creditSpread = ds.macro.hyg.map((v, i) => {
    if (v > 0 && ds.macro.lqd[i] > 0) {
      const hy = 0.045 + (1 - v / 100) * 0.03, ly = 0.035 + (1 - ds.macro.lqd[i] / 100) * 0.02;
      return Math.max(1, Math.min(9, (hy - ly) * 100));
    }
    return 2.5 + ds.macro.vix[i] / 20;
  });
  const dxyTrend = ds.macro.dxy.map((_, i) => (i < 20 ? 0 : (ds.macro.dxy[i - 20] > 0 ? ((ds.macro.dxy[i] - ds.macro.dxy[i - 20]) / ds.macro.dxy[i - 20]) * 100 : 0)));
  return { yieldSpread, creditSpread, dxyTrend };
}

// Serie del MOTOR (pesos objetivo) sobre un dataset, sin aportaciones.
export function runEngine(ds: Dataset) {
  const { yieldSpread, creditSpread, dxyTrend } = deriveMacro(ds);
  const bt = runBacktest({
    closesHistory: ds.closes,
    macroHistory: { vix: ds.macro.vix, yieldSpread, creditSpread, move: ds.macro.move, dxyTrend, btcVol: ds.macro.btcVol },
    lookbackDays: CFG.lookbackDays, rebalanceDays: CFG.rebalanceDays,
    initialCapital: CFG.initialCapital, transactionCostBps: 15,
  });
  const recs = bt.dailyRecords;
  const values = recs.map(r => r.portfolioValue);
  const dates = ds.dates.slice(CFG.lookbackDays, CFG.lookbackDays + recs.length);
  const twr: number[] = [];
  for (let i = 1; i < recs.length; i++) twr.push(recs[i].portfolioValue / recs[i - 1].portfolioValue - 1);
  return { twr, values, dates, metrics: metrics(twr, values, dates), regimeDays: bt.regimeDays, recs, bt };
}

export function simulate(ds: Dataset, opts: { startOffset?: number; costScale?: number; vetoSeries?: { penalty: number[]; volTarget: number[]; ks: number[] } } = {}): SimResult {
  const startOffset = opts.startOffset ?? 0;
  setCostScale(opts.costScale ?? 1);
  const { dates, closes } = ds;
  const { yieldSpread, creditSpread, dxyTrend } = deriveMacro(ds);
  const bt = runBacktest({
    closesHistory: closes,
    macroHistory: { vix: ds.macro.vix, yieldSpread, creditSpread, move: ds.macro.move, dxyTrend, btcVol: ds.macro.btcVol },
    lookbackDays: CFG.lookbackDays, rebalanceDays: CFG.rebalanceDays,
    initialCapital: CFG.initialCapital, transactionCostBps: 15,
  });
  const recs = bt.dailyRecords;
  const off = Math.max(0, Math.min(startOffset, recs.length - 60));
  const rcs = recs.slice(off);
  const base = CFG.lookbackDays + off;
  const isBTC = (t: string) => t === 'BTC-EUR';

  let cash = CFG.initialCapital;
  const shares: Record<string, number> = {}; ASSETS.forEach(a => shares[a] = 0);
  let totalCosts = 0, turnoverEur = 0, nOrders = 0;
  const dcaBoughtEver: Record<string, number> = {};
  const buyEvents: Record<string, [number, number][]> = {};
  let buysSinceReb: Record<string, number> = {};
  let lastRebK = -1; let lastRebPv = 0;
  const lastRebPrice: Record<string, number> = {}; const lastRebTarget: Record<string, number> = {};
  const values: number[] = [], twr: number[] = [], cashSeries: number[] = [], outDates: string[] = [];
  let contributions = 0, lastMonth = -1;
  let churnDirectEur = 0;
  let dcaEvalDays = 0, ksBlockedDays = 0, vtBlockedDays = 0, dcaBuyCount = 0, dcaBuyEur = 0, sellCount = 0, sellEur = 0;
  const trimLog: TrimLogRow[] = [];
  let trimCountAll = 0, trimEurAll = 0, legacyRoundTrips = 0, legacyRoundTripEur = 0;

  for (let k = 0; k < rcs.length; k++) {
    const di = base + k;
    const px = (t: string) => closes[t][di];
    const dstr = dates[di];
    outDates.push(dstr);
    const mth = parseInt(dstr.slice(5, 7), 10);
    if (mth !== lastMonth) {
      if (lastMonth !== -1) { cash += CFG.monthlyContribution; contributions += CFG.monthlyContribution; }
      lastMonth = mth;
    }
    const prevVal = values.length ? values[values.length - 1] : CFG.initialCapital;
    const pv = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a), 0);
    const alloc = rcs[k].allocations as Record<string, number>;
    let dcaCommitted: Record<string, number> = {};

    if (k % 7 === 0 && k > 0) {
      const bi = btcIndicators(ds, di);
      const reg = rcs[k].regime as 'EXPANSION' | 'CONTRACTION' | 'CRISIS';
      const vs = opts.vetoSeries;
      const penalty = vs ? (vs.penalty[k] ?? 1.0) : (reg === 'EXPANSION' ? 1.0 : reg === 'CONTRACTION' ? 0.6 : 0.4);
      const vtMult = vs ? (vs.volTarget[k] ?? 1.0) : 1.0;
      const ksLevel = vs ? (vs.ks[k] ?? 0) : 0;
      dcaEvalDays++;
      if (ksLevel > 0) ksBlockedDays++;
      if (vtMult < 1) vtBlockedDays++;
      const inp: SmartDCAInput = {
        btcRsi: bi.rsi, btcZScore: bi.z, btcMomentum1m: bi.mom1m, btcDominance: undefined,
        mvrvRatio: bi.mvrv, mvrvZScore: undefined,
        regime: reg, regimePenalty: penalty,
        volTargetMultiplier: vtMult, tailRiskActive: ksLevel > 0, tailRiskOverlay: 1.0,
        killSwitchLevel: ksLevel, recoveryCyclesRemaining: 0,
        olympusAvailableCash: cash, tacticalAvailableCash: 0, accumulatedDefensiveLiquidity: 0,
        totalPortfolioValueEUR: pv,
        motorAllocations: ASSETS.map(a => ({ name: a, ticker: a, finalAllocation: Math.max(0, alloc[a] ?? 0), price: px(a), isFractional: isBTC(a) })),
        currentAllocations: ASSETS.map(a => ({ ticker: a, name: a, currentWeight: pv > 0 ? (shares[a] * px(a)) / pv : 0 })),
        cycleBottomSignals: [],
        btcTotalComposite: btcTotalExposure(1.0, pv > 0 ? (shares['BTC-EUR'] * px('BTC-EUR')) / pv : 0),
      };
      const r = computeSmartDCA(inp);
      for (const a of r.allocationByAsset) {
        const c0 = a.actualCost ?? 0; if (c0 <= 0) continue;
        const p = px(a.ticker); if (p <= 0) continue;
        const sh = isBTC(a.ticker) ? c0 / p : Math.floor(c0 / p); if (sh <= 0) continue;
        const not = sh * p;
        const c = computeTradeCost({ ticker: a.ticker, oldWeight: 0, newWeight: not / pv, portfolioValueEur: pv, priceEur: p }).totalCostEur;
        if (not + c > cash) continue;
        // churn directo: comprar con drift > +2pp (convención rebalancer: drift = actual − target)
        const curW = pv > 0 ? (shares[a.ticker] * p) / pv : 0;
        if ((alloc[a.ticker] ?? 0) > 0 && curW - (alloc[a.ticker] ?? 0) > 0.02) churnDirectEur += not;
        cash -= not + c; shares[a.ticker] += sh;
        totalCosts += c; turnoverEur += not; nOrders++;
        dcaBuyCount++; dcaBuyEur += not;
        dcaBoughtEver[a.ticker] = (dcaBoughtEver[a.ticker] ?? 0) + not;
        buysSinceReb[a.ticker] = (buysSinceReb[a.ticker] ?? 0) + not;
        (buyEvents[a.ticker] ??= []).push([k, not]);
        dcaCommitted[a.ticker] = (dcaCommitted[a.ticker] ?? 0) + not;
      }
    }

    if (k % 30 === 0 && k > 0) {
      const pv2 = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a), 0);
      const rbAssets: RebalanceAsset[] = ASSETS.map(a => ({
        ticker: a, name: a, price: px(a), shares: shares[a], targetAllocation: Math.max(0, alloc[a] ?? 0),
      }));
      const out = computeRebalanceSuggestions(rbAssets, cash, pv2, 0.02, [], [], dcaCommitted);
      for (const s of out.suggestions) {
        const p = px(s.ticker); if (p <= 0) continue;
        if (s.action === 'SELL' && s.sharesToSell > 0) {
          const sh = isBTC(s.ticker) ? s.sharesToSell : Math.min(s.sharesToSell, Math.floor(shares[s.ticker]));
          if (sh <= 0) continue;
          const not = sh * p;
          const c = computeTradeCost({ ticker: s.ticker, oldWeight: 0, newWeight: not / pv2, portfolioValueEur: pv2, priceEur: p }).totalCostEur;
          shares[s.ticker] -= sh; cash += not - c;
          totalCosts += c; turnoverEur += not; nOrders++;
          sellCount++; sellEur += not;
          if (s.isOverweightTrim) {
            trimCountAll++; trimEurAll += not;
            if ((dcaBoughtEver[s.ticker] ?? 0) > 0) { legacyRoundTrips++; legacyRoundTripEur += not; }
            const evs = buyEvents[s.ticker] ?? [];
            const sumW = (from: number) => evs.filter(([d]) => d >= k - from).reduce((acc, [, e]) => acc + e, 0);
            const assetRet = lastRebPrice[s.ticker] ? p / lastRebPrice[s.ticker] - 1 : 0;
            const pvRet = lastRebK >= 0 ? pv2 / (lastRebPv > 0 ? lastRebPv : pv2) - 1 : 0;
            trimLog.push({
              date: dstr, ticker: s.ticker, drift: s.drift, soldEur: not, currentPct: s.currentPct, targetPct: s.targetPct,
              buysSinceReb: buysSinceReb[s.ticker] ?? 0, buys7: sumW(7), buys14: sumW(14), buys30: sumW(30),
              assetRet, pvRet,
            });
          }
        } else if (s.action === 'BUY' && s.cost > 0) {
          const sh = isBTC(s.ticker) ? s.sharesToBuy : Math.floor(s.sharesToBuy);
          const not = sh * p; if (not <= 0 || not > cash) continue;
          const c = computeTradeCost({ ticker: s.ticker, oldWeight: 0, newWeight: not / pv2, portfolioValueEur: pv2, priceEur: p }).totalCostEur;
          if (not + c > cash) continue;
          cash -= not + c; shares[s.ticker] += sh;
          totalCosts += c; turnoverEur += not; nOrders++;
        }
      }
      lastRebK = k; lastRebPv = pv2;
      ASSETS.forEach(a => { lastRebPrice[a] = px(a); lastRebTarget[a] = alloc[a] ?? 0; });
      buysSinceReb = {};
    }

    const pvNow = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a), 0);
    const flow = (k > 0 && parseInt(dstr.slice(5, 7), 10) !== parseInt(dates[di - 1].slice(5, 7), 10)) ? CFG.monthlyContribution : 0;
    values.push(pvNow);
    cashSeries.push(cash / Math.max(1e-9, pvNow));
    if (k > 0) twr.push((pvNow - flow) / prevVal - 1);
  }
  void lastRebTarget;

  const mm = metrics(twr, values, outDates);
  const finalValue = values[values.length - 1];
  const fl: { t: number; amount: number }[] = [{ t: 0, amount: -CFG.initialCapital }];
  for (let i = 1; i < outDates.length; i++)
    if (parseInt(outDates[i].slice(5, 7), 10) !== parseInt(outDates[i - 1].slice(5, 7), 10)) fl.push({ t: i, amount: -CFG.monthlyContribution });
  fl.push({ t: outDates.length, amount: finalValue });

  setCostScale(1);
  return {
    twr, values, dates: outDates,
    cagr: mm.cagr, sharpe: mm.sharpe, sortino: mm.sortino, maxDD: mm.maxDD, vol: mm.vol, cvar95: mm.cvar95,
    turnoverEur, orders: nOrders, costs: totalCosts,
    cashMean: cashSeries.reduce((a, b) => a + b, 0) / cashSeries.length, cashMax: Math.max(...cashSeries), cashSeries,
    trimLog, trimCountAll, trimEurAll, legacyRoundTrips, legacyRoundTripEur, churnDirectEur,
    finalValue, contributions, xirr: xirr(fl), regimeDays: bt.regimeDays,
    dcaEvalDays, ksBlockedDays, vtBlockedDays, dcaBuyCount, dcaBuyEur, sellCount, sellEur,
  };
}

// ── Shadow-sim de variantes (TEST 2 / TEST 4): pesos objetivo diarios, rebalanceo cada N días,
//    acciones fraccionales, costes reales por operación. Sin aportaciones. ──
export interface ShadowResult { values: number[]; twr: number[]; dates: string[]; costs: number; turnover: number; orders: number; }
export function shadowSim(ds: Dataset, allocByDay: Record<string, number>[], opts: { initialCapital?: number; rebalanceEvery?: number } = {}): ShadowResult {
  const init = opts.initialCapital ?? CFG.initialCapital;
  const every = opts.rebalanceEvery ?? CFG.rebalanceDays;
  const { dates, closes } = ds;
  const isBTC = (t: string) => t === 'BTC-EUR';
  let cash = init;
  const shares: Record<string, number> = {}; ASSETS.forEach(a => shares[a] = 0);
  let costs = 0, turnover = 0, orders = 0;
  const values: number[] = [], twr: number[] = [], outDates: string[] = [];
  const R = allocByDay.length;
  for (let k = 0; k < R; k++) {
    const di = CFG.lookbackDays + k;
    if (di >= dates.length) break;
    const px = (t: string) => closes[t][di];
    outDates.push(dates[di]);
    let pv = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a), 0);
    if (k % every === 0) {
      const tgt = allocByDay[k];
      // SELLs primero (liberan cash), luego BUYs
      for (const a of ASSETS) {
        const tv = (tgt[a] ?? 0) * pv; const cur = shares[a] * px(a);
        if (cur > tv + 0.01) {
          const not = cur - tv;
          const c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: not / pv, portfolioValueEur: pv, priceEur: px(a) }).totalCostEur;
          shares[a] -= not / px(a); cash += not - c;
          costs += c; turnover += not; orders++;
        }
      }
      pv = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a), 0);
      for (const a of ASSETS) {
        const tv = (tgt[a] ?? 0) * pv; const cur = shares[a] * px(a);
        if (tv > cur + 0.01) {
          let not = tv - cur;
          let c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: not / pv, portfolioValueEur: pv, priceEur: px(a) }).totalCostEur;
          if (not + c > cash) { not = Math.max(0, cash - c); c = computeTradeCost({ ticker: a, oldWeight: 0, newWeight: not / pv, portfolioValueEur: pv, priceEur: px(a) }).totalCostEur; }
          if (not <= 0.01) continue;
          shares[a] += not / px(a); cash -= not + c;
          costs += c; turnover += not; orders++;
        }
      }
    }
    const pvNow = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a), 0);
    values.push(pvNow);
    if (k > 0) twr.push(pvNow / values[k - 1] - 1);
  }
  return { values, twr, dates: outDates, costs, turnover, orders };
}

// ── Métricas compartidas (mismas fórmulas que account_core.ts) ──
export function metrics(twr: number[], vals: number[], dts: string[]) {
  const n = twr.length;
  const mu = twr.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = Math.sqrt(twr.reduce((s, r) => s + (r - mu) ** 2, 0) / Math.max(1, n));
  let g = 1; for (const r of twr) g *= (1 + r);
  const years = n / CFG.dpy;
  const cagr = Math.pow(Math.max(1e-6, g), 1 / years) - 1;
  const sharpe = sd > 0 ? (mu * CFG.dpy - CFG.rf) / (sd * Math.sqrt(CFG.dpy)) : 0;
  const dn = twr.filter(r => r < 0);
  const dsd = Math.sqrt(dn.reduce((s, r) => s + r * r, 0) / Math.max(1, dn.length));
  const sortino = dsd > 0 ? (mu * CFG.dpy - CFG.rf) / (dsd * Math.sqrt(CFG.dpy)) : 0;
  let peak = vals[0], mdd = 0;
  for (const v of vals) { if (v > peak) peak = v; const d = v / peak - 1; if (d < mdd) mdd = d; }
  return { cagr, sharpe, sortino, maxDD: mdd, vol: sd * Math.sqrt(CFG.dpy), cvar95: cvarMonthly(twr, dts) };
}
export function cvarMonthly(twr: number[], dts: string[]): number {
  const byM = new Map<string, number[]>();
  for (let i = 0; i < twr.length; i++) { const d = dts[i + 1]; if (!d) continue; byM.set(d.slice(0, 7), [...(byM.get(d.slice(0, 7)) ?? []), twr[i]]); }
  const mon = [...byM.values()].map(a => a.reduce((x, y) => x * (1 + y), 1) - 1).sort((a, b) => a - b);
  if (!mon.length) return 0;
  const k = Math.max(1, Math.ceil(mon.length * 0.05));
  return mon.slice(0, k).reduce((a, b) => a + b, 0) / k;
}
export function xirr(flows: { t: number; amount: number }[]): number {
  const npv = (r: number) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, f.t / CFG.dpy), 0);
  let lo = -0.9, hi = 5;
  if (npv(lo) * npv(hi) > 0) return NaN;
  for (let i = 0; i < 300; i++) { const mid = (lo + hi) / 2; if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}
