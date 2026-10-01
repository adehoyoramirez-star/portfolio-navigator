// ============================================================
// scripts/validation/account_core.ts
// FASE 2A — Núcleo reutilizable: simulador de CUENTA REAL.
// Sin efectos de impresión. Usado por costs.ts y robustness.ts.
//
// Modelado declarado (NO es una afirmación sobre el motor):
//  · targets       = runBacktest().dailyRecords[].allocations  (motor real)
//  · regime        = dailyRecords[].regime                     (motor real)
//  · regimePenalty = 1.00 EXPANSION / 0.60 CONTRACTION / 0.40 CRISIS (CALIBRATION §4)
//  · volTargetMult = 1.00 ; tailRiskActive=false ; killSwitchLevel=0
//  · btcRsi/Z/mom  : calculados del CSV (RSI14 simple, z-score 252d, mom 30d)
//  · mvrvRatio     = BTC_precio / MA252 (proxy declarado; MVRV on-chain no existe en backtest)
//  · cycleBottomSignals = []
// Costes: computeTradeCost (fixed + half-spread + impacto raíz-cuadrada), escalables
// en memoria mediante costScale (0, 1, 2, 3) SIN tocar src/.
// ============================================================

import fs from 'fs';
import path from 'path';
import { runBacktest, DailyRecord } from '../../src/core/backtest/backtestEngine';
import { computeSmartDCA } from '../../src/core/dca/smartDCA';
import type { SmartDCAInput } from '../../src/core/dca/smartDCA';
import { computeRebalanceSuggestions, type RebalanceAsset } from '../../src/core/portfolio/rebalancer';
import { computeTradeCost, ASSET_COST_PARAMS } from '../../src/core/validation/transactionCosts';
import { btcTotalExposure } from '../../src/core/backtest/composite';
import { ASSETS } from '../../src/lib/constants';

export const CFG = { lookbackDays: 252, rebalanceDays: 21, initialCapital: 10_000, monthlyContribution: 400, rf: 0.04, dpy: 365 };
export const pct = (x: number, d = 2) => (x * 100).toFixed(d) + '%';

const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter(l => l.trim());
const H = lines[0].split(',');
const closes: Record<string, number[]> = {}; ASSETS.forEach(a => closes[a] = []);
const macro: Record<string, number[]> = { vix: [], tnx: [], irx: [], hyg: [], lqd: [], move: [], dxy: [], btcVol: [] };
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
export const N = closes[ASSETS[0]].length;
const yieldSpread = macro.tnx.map((v, i) => v - macro.irx[i]);
const creditSpread = macro.hyg.map((v, i) => {
  if (v > 0 && macro.lqd[i] > 0) {
    const hy = 0.045 + (1 - v / 100) * 0.03, ly = 0.035 + (1 - macro.lqd[i] / 100) * 0.02;
    return Math.max(1, Math.min(9, (hy - ly) * 100));
  }
  return 2.5 + macro.vix[i] / 20;
});
const dxyTrend = macro.dxy.map((_, i) => (i < 20 ? 0 : (macro.dxy[i - 20] > 0 ? ((macro.dxy[i] - macro.dxy[i - 20]) / macro.dxy[i - 20]) * 100 : 0)));
export const DATES = dates;
export const CLOSES = closes;

// cost override in-memory (no se toca src/)
const origParams = JSON.parse(JSON.stringify(ASSET_COST_PARAMS));
export function setCostScale(s: number) {
  for (const t of Object.keys(ASSET_COST_PARAMS)) {
    const o = origParams[t], c = ASSET_COST_PARAMS[t];
    c.halfSpreadBps = o.halfSpreadBps * s;
    c.impactCoefficient = o.impactCoefficient * s;
  }
}

function btcIndicators(i: number) {
  const p = closes['BTC-EUR'][i];
  const win = closes['BTC-EUR'].slice(Math.max(0, i - 251), i + 1);
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

export interface SimResult {
  twr: number[]; values: number[]; dates: string[];
  cagr: number; sharpe: number; sortino: number; maxDD: number; vol: number;
  cvar95: number; turnoverEur: number; orders: number; costs: number;
  cashMean: number; cashMax: number; cashRun: number; cashRunEnd: string;
  roundTrips: number; roundTripEur: number; maxExcessPp: number;
  btcOverride: number; btcOverrideBreach: number; dcaBlocked: number; dcaWait: number;
  finalValue: number; contributions: number; xirr: number;
  engineCagr: number; engineSharpe: number; engineMaxDD: number;
  regimeDays: Record<string, number>; rebalanceCount: number; nRecords: number;
}

export function simulateAccount(opts: { startOffset?: number; costScale?: number } = {}): SimResult {
  const startOffset = opts.startOffset ?? 0;
  setCostScale(opts.costScale ?? 1);
  const bt = runBacktest({
    closesHistory: closes,
    macroHistory: { vix: macro.vix, yieldSpread, creditSpread, move: macro.move, dxyTrend, btcVol: macro.btcVol },
    lookbackDays: CFG.lookbackDays, rebalanceDays: CFG.rebalanceDays,
    initialCapital: CFG.initialCapital, transactionCostBps: 15,
  });
  const recs = bt.dailyRecords;
  const off = Math.max(0, Math.min(startOffset, recs.length - 60));
  const rcs = recs.slice(off);
  const base = CFG.lookbackDays + off;

  let cash = CFG.initialCapital;
  const shares: Record<string, number> = {}; ASSETS.forEach(a => shares[a] = 0);
  let totalCosts = 0, turnoverEur = 0, nOrders = 0;
  const dcaBought: Record<string, number> = {};
  const values: number[] = [], twr: number[] = [], cashSeries: number[] = [], outDates: string[] = [];
  let contributions = 0, lastMonth = -1;
  let roundTrips = 0, roundTripEur = 0, maxExcessPp = 0;
  let btcOverride = 0, btcOverrideBreach = 0, dcaBlocked = 0, dcaWait = 0;
  const isBTC = (t: string) => t === 'BTC-EUR';

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
      const bi = btcIndicators(di);
      const reg = rcs[k].regime as 'EXPANSION' | 'CONTRACTION' | 'CRISIS';
      const penalty = reg === 'EXPANSION' ? 1.0 : reg === 'CONTRACTION' ? 0.6 : 0.4;
      const inp: SmartDCAInput = {
        btcRsi: bi.rsi, btcZScore: bi.z, btcMomentum1m: bi.mom1m, btcDominance: undefined,
        mvrvRatio: bi.mvrv, mvrvZScore: undefined,
        regime: reg, regimePenalty: penalty,
        volTargetMultiplier: 1.0, tailRiskActive: false, tailRiskOverlay: 1.0,
        killSwitchLevel: 0, recoveryCyclesRemaining: 0,
        olympusAvailableCash: cash, tacticalAvailableCash: 0, accumulatedDefensiveLiquidity: 0,
        totalPortfolioValueEUR: pv,
        motorAllocations: ASSETS.map(a => ({ name: a, ticker: a, finalAllocation: Math.max(0, alloc[a] ?? 0), price: px(a), isFractional: isBTC(a) })),
        currentAllocations: ASSETS.map(a => ({ ticker: a, name: a, currentWeight: pv > 0 ? (shares[a] * px(a)) / pv : 0 })),
        cycleBottomSignals: [],
        btcTotalComposite: btcTotalExposure(1.0, pv > 0 ? (shares['BTC-EUR'] * px('BTC-EUR')) / pv : 0),
      };
      const r = computeSmartDCA(inp);
      if (r.action.startsWith('BLOCK')) dcaBlocked++;
      if (r.action === 'WAIT') dcaWait++;
      if (r.action === 'BTC_CYCLE_OVERRIDE') { btcOverride++; if ((inp.btcTotalComposite ?? 0) >= 0.337) btcOverrideBreach++; }
      for (const a of r.allocationByAsset) {
        const c0 = a.actualCost ?? 0; if (c0 <= 0) continue;
        const p = px(a.ticker); if (p <= 0) continue;
        const sh = isBTC(a.ticker) ? c0 / p : Math.floor(c0 / p); if (sh <= 0) continue;
        const not = sh * p;
        const c = computeTradeCost({ ticker: a.ticker, oldWeight: 0, newWeight: not / pv, portfolioValueEur: pv, priceEur: p }).totalCostEur;
        if (not + c > cash) continue;
        cash -= not + c; shares[a.ticker] += sh;
        totalCosts += c; turnoverEur += not; nOrders++;
        dcaBought[a.ticker] = (dcaBought[a.ticker] ?? 0) + not;
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
          if (s.isOverweightTrim) {
            maxExcessPp = Math.max(maxExcessPp, s.drift * 100);
            if ((dcaBought[s.ticker] ?? 0) > 0) { roundTrips++; roundTripEur += not; }
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
    }

    const pvNow = cash + ASSETS.reduce((s, a) => s + shares[a] * px(a), 0);
    const flow = (k > 0 && parseInt(dstr.slice(5, 7), 10) !== parseInt(dates[di - 1].slice(5, 7), 10)) ? CFG.monthlyContribution : 0;
    values.push(pvNow);
    cashSeries.push(cash / Math.max(1e-9, pvNow));
    if (k > 0) twr.push((pvNow - flow) / prevVal - 1);
  }

  // métricas
  const mm = metrics(twr, values, outDates);
  const engineTwr: number[] = [];
  for (let i = 1; i < rcs.length; i++) engineTwr.push(rcs[i].portfolioValue / rcs[i - 1].portfolioValue - 1);
  const ev = rcs.map(r => r.portfolioValue);
  const em = metrics(engineTwr, ev, outDates);
  const finalValue = values[values.length - 1];
  const fl: { t: number; amount: number }[] = [{ t: 0, amount: -CFG.initialCapital }];
  for (let i = 1; i < outDates.length; i++)
    if (parseInt(outDates[i].slice(5, 7), 10) !== parseInt(outDates[i - 1].slice(5, 7), 10)) fl.push({ t: i, amount: -CFG.monthlyContribution });
  fl.push({ t: outDates.length, amount: finalValue });

  let run = 0, maxRun = 0, runEnd = '';
  for (let i = 0; i < cashSeries.length; i++) { if (cashSeries[i] >= 0.5) { run++; if (run > maxRun) { maxRun = run; runEnd = outDates[i]; } } else run = 0; }

  setCostScale(1);
  return {
    twr, values, dates: outDates,
    cagr: mm.cagr, sharpe: mm.sharpe, sortino: mm.sortino, maxDD: mm.maxDD, vol: mm.vol, cvar95: mm.cvar95,
    turnoverEur, orders: nOrders, costs: totalCosts,
    cashMean: cashSeries.reduce((a, b) => a + b, 0) / cashSeries.length, cashMax: Math.max(...cashSeries),
    cashRun: maxRun, cashRunEnd: runEnd,
    roundTrips, roundTripEur, maxExcessPp, btcOverride, btcOverrideBreach, dcaBlocked, dcaWait,
    finalValue, contributions, xirr: xirr(fl),
    engineCagr: em.cagr, engineSharpe: em.sharpe, engineMaxDD: em.maxDD,
    regimeDays: bt.regimeDays, rebalanceCount: bt.rebalanceCount, nRecords: recs.length,
  };
}

function metrics(twr: number[], vals: number[], dts: string[]) {
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
  const byM = new Map<string, number[]>();
  for (let i = 0; i < twr.length; i++) { const d = dts[i + 1]; if (!d) continue; byM.set(d.slice(0, 7), [...(byM.get(d.slice(0, 7)) ?? []), twr[i]]); }
  const mon = [...byM.values()].map(a => a.reduce((x, y) => x * (1 + y), 1) - 1).sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(mon.length * 0.05));
  const cvar95 = mon.length ? mon.slice(0, k).reduce((a, b) => a + b, 0) / k : 0;
  return { cagr, sharpe, sortino, maxDD: mdd, vol: sd * Math.sqrt(CFG.dpy), cvar95 };
}

function xirr(flows: { t: number; amount: number }[]): number {
  const npv = (r: number) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, f.t / CFG.dpy), 0);
  let lo = -0.9, hi = 5;
  if (npv(lo) * npv(hi) > 0) return NaN;
  for (let i = 0; i < 300; i++) { const mid = (lo + hi) / 2; if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}