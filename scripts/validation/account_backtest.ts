// ============================================================
// scripts/validation/account_backtest.ts
// FASE 2A · TEST A — Backtest de CUENTA REAL (execution-aware)
// Ejecutar: npx tsx scripts/validation/account_backtest.ts
//
// Qué añade sobre canonical.ts: ejecuta la CAPA DE EJECUCIÓN real
// (computeSmartDCA semanal + computeRebalanceSuggestions mensual + costes
// reales por activo) sobre los TARGETS que produce el motor, con
// aportaciones mensuales, acciones enteras (BTC fraccional), y TWR/XIRR.
//
// MODELADO DECLARADO (no es una afirmación sobre el motor):
//  · targets          = runBacktest().dailyRecords[].allocations  (motor real)
//  · regime           = dailyRecords[].regime                     (motor real)
//  · regimePenalty    = 1.00 EXPANSION / 0.60 CONTRACTION / 0.40 CRISIS
//                       (bandas documentadas en CALIBRATION.md §4)
//  · volTargetMult    = 1.00 ; tailRiskActive=false ; killSwitchLevel=0
//                       → el kill switch NO se modela aquí (se mide en TEST D)
//  · btcRsi/Z/momentum: calculados del CSV (método declarado abajo)
//  · mvrvRatio        = BTC_precio / MA252  (proxy declarado; MVRV on-chain no existe en backtest)
//  · cycleBottomSignals = []  → la ruta EXTREME ×2.0 no se activa (se reporta)
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

const CFG = { lookbackDays: 252, rebalanceDays: 21, initialCapital: 10_000, monthlyContribution: 400, rf: 0.04, dpy: 365 };
const pct = (x: number, d = 2) => (x * 100).toFixed(d) + '%';
const eur = (x: number) => '€' + x.toFixed(0);

// ── Datos ───────────────────────────────────────────────────────────────────
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
const nLen = Math.min(...ASSETS.map(a => closes[a].length));
ASSETS.forEach(a => closes[a] = closes[a].slice(0, nLen));
const dts = dates.slice(0, nLen);
const yieldSpread = macro.tnx.map((v, i) => v - macro.irx[i]);
const creditSpread = macro.hyg.map((v, i) => {
  if (v > 0 && macro.lqd[i] > 0) {
    const hy = 0.045 + (1 - v / 100) * 0.03, ly = 0.035 + (1 - macro.lqd[i] / 100) * 0.02;
    return Math.max(1, Math.min(9, (hy - ly) * 100));
  }
  return 2.5 + macro.vix[i] / 20;
});
const dxyTrend = macro.dxy.map((_, i) => (i < 20 ? 0 : (macro.dxy[i - 20] > 0 ? ((macro.dxy[i] - macro.dxy[i - 20]) / macro.dxy[i - 20]) * 100 : 0)));

// ── Motor real → targets ────────────────────────────────────────────────────
const bt = runBacktest({
  closesHistory: closes,
  macroHistory: { vix: macro.vix, yieldSpread, creditSpread, move: macro.move, dxyTrend, btcVol: macro.btcVol },
  lookbackDays: CFG.lookbackDays, rebalanceDays: CFG.rebalanceDays,
  initialCapital: CFG.initialCapital, transactionCostBps: 15,
});
const recs = bt.dailyRecords;
console.log('='.repeat(112));
console.log('  TEST A — BACKTEST DE CUENTA REAL (execution-aware)');
console.log('='.repeat(112));
console.log(`  Motor: ${recs.length} registros · ${bt.rebalanceCount} rebalanceos · regímenes ${JSON.stringify(bt.regimeDays)}`);

// ── Indicadores BTC declarados ──────────────────────────────────────────────
function btcIndicators(i: number) {
  const p = closes['BTC-EUR'][i];
  const win = closes['BTC-EUR'].slice(Math.max(0, i - 251), i + 1);
  const ma14 = win.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, win.length);
  const gains = win.slice(-15).map((v, k, a) => (k === 0 ? 0 : a[k] - a[k - 1])).filter(x => x > 0);
  const losses = win.slice(-15).map((v, k, a) => (k === 0 ? 0 : a[k - 1] - v)).filter(x => x > 0);
  const rs = losses.reduce((a, b) => a + b, 0) > 0
    ? gains.reduce((a, b) => a + b, 0) / losses.reduce((a, b) => a + b, 0) : 999;
  const rsi = 100 - 100 / (1 + rs);
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const sd = Math.sqrt(win.reduce((s, v) => s + (v - mean) ** 2, 0) / win.length) || 1;
  const z = (p - mean) / sd;
  const mom1m = win.length > 31 ? p / win[win.length - 31] - 1 : 0;
  const ma252 = closes['BTC-EUR'].slice(Math.max(0, i - 251), i + 1).reduce((a, b) => a + b, 0) / Math.min(252, i + 1);
  const mvrv = ma252 > 0 ? p / ma252 : 3;
  void ma14;
  return { rsi, z, mom1m, mvrv };
}

// ── Motor de cuenta ─────────────────────────────────────────────────────────
const isBTC = (t: string) => t === 'BTC-EUR';
let cash = CFG.initialCapital;
const shares: Record<string, number> = {}; ASSETS.forEach(a => shares[a] = 0);
let totalCosts = 0, turnoverEur = 0, nOrders = 0;
const dcaBought: Record<string, number> = {};        // € comprados por DCA en el ciclo
let dcaBoughtDay = -99;

const dailyValue: number[] = [];                      // valor total (con aportaciones)
const dailyTwr: number[] = [];                       // retorno diario EXCLUYENDO aportación
const cashSeries: number[] = [];
let contributions = 0;
let lastMonth = -1;

// contadores de hallazgos
let roundTrips = 0, roundTripEur = 0;
let maxExcessPp = 0, extremeEvents = 0;
let btcOverrideBandBreaches = 0, btcOverrideCount = 0;
let dcaBlockedDays = 0, dcaWaits = 0;

function tradeCostEur(ticker: string, turnover: number, pv: number, price: number) {
  const r = computeTradeCost({ ticker, oldWeight: 0, newWeight: turnover / pv, portfolioValueEur: pv, priceEur: price });
  return r.totalCostEur;
}

for (let k = 0; k < recs.length; k++) {
  const rec = recs[k];
  const di = k + CFG.lookbackDays;
  const price = (t: string) => closes[t][di];

  // aportación mensual
  const m = parseInt(dts[di].slice(5, 7), 10) - 1;
  if (m !== lastMonth) {
    if (lastMonth !== -1) { cash += CFG.monthlyContribution; contributions += CFG.monthlyContribution; }
    lastMonth = m;
  }

  // marcar valor PRE-ordenes para TWR
  const prevPv = dailyValue.length ? dailyValue[dailyValue.length - 1] : CFG.initialCapital;
  let contributedToday = 0;

  const pv = cash + ASSETS.reduce((s, a) => s + shares[a] * price(a), 0);
  const isDcaDay = k % 7 === 0;
  const isRebDay = k % 30 === 0;
  if (k > 0) { isDcaDay && 0; }

  let dcaCommitted: Record<string, number> = {};

  if (isDcaDay && k > 0) {
    const allocRec = rec.allocations as Record<string, number>;
    const motorAllocations = ASSETS.map(a => ({
      name: a, ticker: a, finalAllocation: Math.max(0, allocRec[a] ?? 0), price: price(a), isFractional: isBTC(a),
    }));
    const currentAllocations = ASSETS.map(a => ({
      ticker: a, name: a, currentWeight: pv > 0 ? (shares[a] * price(a)) / pv : 0,
    }));
    const bi = btcIndicators(di);
    const reg = rec.regime as 'EXPANSION' | 'CONTRACTION' | 'CRISIS';
    const penalty = reg === 'EXPANSION' ? 1.0 : reg === 'CONTRACTION' ? 0.6 : 0.4;
    const btcEngineW = pv > 0 ? (shares['BTC-EUR'] * price('BTC-EUR')) / pv : 0;
    const inp: SmartDCAInput = {
      btcRsi: bi.rsi, btcZScore: bi.z, btcMomentum1m: bi.mom1m, btcDominance: undefined,
      mvrvRatio: bi.mvrv, mvrvZScore: undefined,
      regime: reg, regimePenalty: penalty,
      volTargetMultiplier: 1.0, tailRiskActive: false, tailRiskOverlay: 1.0,
      killSwitchLevel: 0, recoveryCyclesRemaining: 0,
      olympusAvailableCash: cash, tacticalAvailableCash: 0, accumulatedDefensiveLiquidity: 0,
      totalPortfolioValueEUR: pv,
      motorAllocations, currentAllocations, cycleBottomSignals: [],
      btcTotalComposite: btcTotalExposure(1.0, btcEngineW),
    };
    const r = computeSmartDCA(inp);
    if (r.action.startsWith('BLOCK')) dcaBlockedDays++;
    if (r.action === 'WAIT') dcaWaits++;
    if (r.action === 'BTC_CYCLE_OVERRIDE') {
      btcOverrideCount++;
      if ((inp.btcTotalComposite ?? 0) >= 0.337) btcOverrideBandBreaches++;
    }
    for (const a of r.allocationByAsset) {
      const cost = a.actualCost ?? 0;
      if (cost <= 0) continue;
      const px = price(a.ticker);
      if (px <= 0) continue;
      const sh = isBTC(a.ticker) ? cost / px : Math.floor(cost / px);
      if (sh <= 0) continue;
      const notional = sh * px;
      const c = tradeCostEur(a.ticker, notional, pv, px);
      if (notional + c > cash) continue;
      cash -= notional + c; shares[a.ticker] += sh;
      totalCosts += c; turnoverEur += notional; nOrders++;
      dcaBought[a.ticker] = (dcaBought[a.ticker] ?? 0) + notional;
      dcaCommitted[a.ticker] = (dcaCommitted[a.ticker] ?? 0) + notional;
      contributedToday += c;
    }
    if (Object.keys(dcaBought).length && k - dcaBoughtDay >= 21) { dcaBoughtDay = k; dcaBoughtDay = k; }
  }

  if (isRebDay && k > 0) {
    const pv2 = cash + ASSETS.reduce((s, a) => s + shares[a] * price(a), 0);
    const rbAssets: RebalanceAsset[] = ASSETS.map(a => ({
      ticker: a, name: a, price: price(a), shares: shares[a], targetAllocation: Math.max(0, (rec.allocations as Record<string, number>)[a] ?? 0),
    }));
    const out = computeRebalanceSuggestions(rbAssets, cash, pv2, 0.02, [], [], dcaCommitted);
    for (const s of out.suggestions) {
      const px = price(s.ticker);
      if (s.action === 'SELL' && s.sharesToSell > 0) {
        const sh = isBTC(s.ticker) ? s.sharesToSell : Math.min(s.sharesToSell, Math.floor(shares[s.ticker]));
        if (sh <= 0) continue;
        const notional = sh * px;
        const c = tradeCostEur(s.ticker, notional, pv2, px);
        shares[s.ticker] -= sh; cash += notional - c;
        totalCosts += c; turnoverEur += notional; nOrders++; contributedToday += c;
        if (s.isOverweightTrim && (dcaBought[s.ticker] ?? 0) > 0) { roundTrips++; roundTripEur += notional; }
        if (s.isOverweightTrim) maxExcessPp = Math.max(maxExcessPp, s.drift * 100);
      } else if (s.action === 'BUY' && s.cost > 0) {
        const px2 = price(s.ticker);
        const sh = isBTC(s.ticker) ? s.sharesToBuy : Math.floor(s.sharesToBuy);
        const notional = sh * px2;
        if (notional <= 0 || notional > cash) continue;
        const c = tradeCostEur(s.ticker, notional, pv2, px2);
        if (notional + c > cash) continue;
        cash -= notional + c; shares[s.ticker] += sh;
        totalCosts += c; turnoverEur += notional; nOrders++; contributedToday += c;
      }
    }
    for (const t of Object.keys(dcaBought)) if ((dcaBought[t] ?? 0) > 0) { /* se conserva para el ciclo */ }
  }

  const pvNow = cash + ASSETS.reduce((s, a) => s + shares[a] * price(a), 0);
  const flow = (k > 0 && dts[di] !== dts[di - 1] && parseInt(dts[di].slice(5, 7), 10) !== parseInt(dts[di - 1].slice(5, 7), 10)) ? CFG.monthlyContribution : 0;
  void contributedToday;
  dailyValue.push(pvNow);
  cashSeries.push(cash / Math.max(1e-9, pvNow));
  if (k > 0) {
    const r = (pvNow - flow) / prevPv - 1;
    dailyTwr.push(r);
  }
}

// ── Buy & hold del mismo universo, mismas aportaciones ──────────────────────
let bhCash = CFG.initialCapital;
const bhShares: Record<string, number> = {}; ASSETS.forEach(a => bhShares[a] = 0);
const bh0 = CFG.lookbackDays;
const bh0Price = ASSETS.reduce((s, a) => s + shares[a], 0);
void bh0Price;
const invest = bhCash / ASSETS.length;
ASSETS.forEach(a => { bhShares[a] = invest / closes[a][bh0]; });
bhCash = 0;
const bhValue: number[] = []; const bhTwr: number[] = [];
let bhLastMonth = parseInt(dts[bh0].slice(5, 7), 10);
for (let k = 1; k < recs.length; k++) {
  const di = k + CFG.lookbackDays;
  const m = parseInt(dts[di].slice(5, 7), 10);
  if (m !== bhLastMonth) {
    bhCash += CFG.monthlyContribution; bhLastMonth = m;
    const pvi = ASSETS.reduce((s, a) => s + bhShares[a] * closes[a][di], 0) + bhCash;
    ASSETS.forEach(a => { bhShares[a] += bhCash / ASSETS.length / closes[a][di]; });
    bhCash = 0; void pvi;
  }
  const v = bhCash + ASSETS.reduce((s, a) => s + bhShares[a] * closes[a][di], 0);
  bhValue.push(v);
  if (bhValue.length > 1) bhTwr.push(v / bhValue[bhValue.length - 2] - 1);
}

// ── Métricas ────────────────────────────────────────────────────────────────
function metrics(twr: number[]) {
  const n = twr.length; if (n < 2) return null;
  const mu = twr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(twr.reduce((s, r) => s + (r - mu) ** 2, 0) / n);
  const years = n / CFG.dpy;
  let g = 1; for (const r of twr) g *= (1 + r);
  const cagr = Math.pow(Math.max(1e-6, g), 1 / years) - 1;
  const sharpe = sd > 0 ? (mu * CFG.dpy - CFG.rf) / (sd * Math.sqrt(CFG.dpy)) : 0;
  const dn = twr.filter(r => r < 0);
  const dsd = Math.sqrt(dn.reduce((s, r) => s + r * r, 0) / Math.max(1, dn.length));
  const sortino = dsd > 0 ? (mu * CFG.dpy - CFG.rf) / (dsd * Math.sqrt(CFG.dpy)) : 0;
  let peak = 1, mdd = 0; for (const r of twr) { const v = peak * (1 + r); peak = Math.max(peak, v); const d = v / peak - 1; if (d < mdd) mdd = d; }
  return { n, years, cagr, sharpe, sortino, maxDD: mdd, vol: sd * Math.sqrt(CFG.dpy) };
}
function cvarMonthly(twr: number[], datesSlice: string[]) {
  const byM = new Map<string, number[]>();
  for (let i = 0; i < twr.length; i++) {
    const d = datesSlice[i + 1]; if (!d) continue;
    byM.set(d.slice(0, 7), [...(byM.get(d.slice(0, 7)) ?? []), twr[i]]);
  }
  const mon = [...byM.values()].map(a => a.reduce((x, y) => x * (1 + y), 1) - 1).sort((a, b) => a - b);
  if (!mon.length) return 0;
  const k = Math.max(1, Math.ceil(mon.length * 0.05));
  return mon.slice(0, k).reduce((a, b) => a + b, 0) / k;
}
function xirr(flows: { t: number; amount: number }[]): number {
  const npv = (r: number) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, f.t / CFG.dpy), 0);
  let lo = -0.9, hi = 5;
  if (npv(lo) * npv(hi) > 0) return NaN;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
function maxDDFromValues(vals: number[]): number {
  let peak = vals[0], mdd = 0;
  for (const v of vals) { if (v > peak) peak = v; const d = v / peak - 1; if (d < mdd) mdd = d; }
  return mdd;
}

const acctDates = recs.map((_, k) => dts[k + CFG.lookbackDays]);
const M = metrics(dailyTwr)!;
const B = metrics(bhTwr)!;
const engineTwr: number[] = [];
for (let i = 1; i < recs.length; i++) engineTwr.push(recs[i].portfolioValue / recs[i - 1].portfolioValue - 1);
const E = metrics(engineTwr)!;

console.log('\n── MÉTRICAS (TWR = sin aportaciones; XIRR = con aportaciones) ──');
console.log(`  ${'Cartera'.padEnd(34)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'Sortino'.padStart(7)} ${'MaxDD'.padStart(8)} ${'Vol'.padStart(7)} ${'CVaR95m'.padStart(8)}`);
console.log('  ' + '-'.repeat(84));
const engineVals = recs.map(r => r.portfolioValue);
const acctVals = dailyValue.slice();
const bhVals = bhValue;
const line = (n: string, m: ReturnType<typeof metrics>, cv: number, vals: number[]) =>
  `  ${n.padEnd(34)} ${pct(m!.cagr).padStart(8)} ${m!.sharpe.toFixed(3).padStart(7)} ${m!.sortino.toFixed(3).padStart(7)} ${pct(maxDDFromValues(vals), 1).padStart(8)} ${pct(m!.vol, 1).padStart(7)} ${pct(cv, 2).padStart(8)}`;
console.log(line('MOTOR (backtest pesos objetivo)', E, cvarMonthly(engineTwr, acctDates), engineVals));
console.log(line('CUENTA REAL (DCA+rebalanceo)', M, cvarMonthly(dailyTwr, acctDates), acctVals));
console.log(line('BUY & HOLD mismo universo', B, cvarMonthly(bhTwr, acctDates), bhVals));
console.log(`  [control] maxDD declarado por el motor = ${pct(bt.metrics.maxDrawdown, 1)}`);

const finalV = dailyValue[dailyValue.length - 1];
const flowList: { t: number; amount: number }[] = [{ t: 0, amount: -CFG.initialCapital }];
for (let i = 1; i < recs.length; i++) {
  if (parseInt(acctDates[i].slice(5, 7), 10) !== parseInt(acctDates[i - 1].slice(5, 7), 10))
    flowList.push({ t: i, amount: -CFG.monthlyContribution });
}
flowList.push({ t: recs.length, amount: finalV });
console.log(`\n  Aportaciones totales : ${eur(contributions)} (${flowList.length - 2} meses)`);
console.log(`  Capital final       : ${eur(finalV)}`);
console.log(`  Coste acumulado     : ${eur(totalCosts)} = ${(totalCosts / (finalV + contributions) * 100).toFixed(2)}% del capital aportado`);
console.log(`  XIRR cuenta real    : ${pct(xirr(flowList))}`);
console.log(`  Nº de órdenes       : ${nOrders}  ·  turnover negociado ${eur(turnoverEur)} (${(turnoverEur / CFG.initialCapital * CFG.dpy / (M.years || 1)).toFixed(0)}% del capital inicial/año)`);

console.log('\n── CASH ──');
const cm = cashSeries.reduce((a, b) => a + b, 0) / cashSeries.length;
const cs = [...cashSeries].sort((a, b) => a - b);
console.log(`  Cash medio ${pct(cm, 1)} · mediana ${pct(cs[Math.floor(cs.length / 2)], 1)} · p95 ${pct(cs[Math.floor(cs.length * 0.95)], 1)} · máx ${pct(Math.max(...cashSeries), 1)}`);
let run = 0, maxRun = 0, end = '';
for (let i = 0; i < cashSeries.length; i++) { if (cashSeries[i] >= 0.5) { run++; if (run > maxRun) { maxRun = run; end = acctDates[i]; } } else run = 0; }
console.log(`  Racha máx con cash ≥50% : ${maxRun} días (fin ${end}) · días con cash>50%: ${cashSeries.filter(c => c >= 0.5).length}`);

console.log('\n── HALLAZGOS DE EJECUCIÓN (TEST E) ──');
console.log(`  Round-trips (OVERWEIGHT TRIM vendiendo lo comprado por DCA) : ${roundTrips} eventos · ${eur(roundTripEur)} vendidos`);
console.log(`  Máximo exceso sobre target detectado en un trim             : ${maxExcessPp.toFixed(1)}pp`);
console.log(`  Señales EXTREME ×2.0 en esta historia                        : ${extremeEvents} (cycleBottomSignals=[] por construcción)`);
console.log(`  BTC_CYCLE_OVERRIDE disparado                                : ${btcOverrideCount}`);
console.log(`  ... con BTC_TOTAL ≥ 0.337 (banda violada, T6-1)             : ${btcOverrideBandBreaches}`);
console.log(`  Días con DCA bloqueado (BLOCK_*)                            : ${dcaBlockedDays} · WAIT ${dcaWaits}`);
console.log(`  Costes reales por activo (ASSET_COST_PARAMS, bps efectivos) :`);
for (const a of ASSETS) { const p = ASSET_COST_PARAMS[a]; if (p) console.log(`      ${a.padEnd(14)} halfSpread ${String(p.halfSpreadBps).padStart(3)} bps → spread ${String(p.halfSpreadBps * 2).padStart(3)} bps · vol ${(p.dailyVol * 100).toFixed(1)}% · vol€ ${(p.dailyVolumeEur / 1000).toFixed(0)}k · impacto ${p.impactCoefficient}`); }

console.log('\n── TEST E(b): ¿consume alguien dca.investAmount (liquidación 30%)? ──');
console.log('  Ver informe: grep en src/dashboard y src/core/backtest → 0 consumidores (control muerto).');

console.log('\n' + '='.repeat(112));