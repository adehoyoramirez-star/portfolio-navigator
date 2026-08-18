// run-backtest-tactical-optimize.ts
// Grid Search: riskPerTradePct x minScore x maxOpenPositions
// Ejecutar: npx tsx run-backtest-tactical-optimize.ts

import fs from 'fs';
import path from 'path';
import { calcIndicators, generateSignals, calcStopLoss } from './src/core/tactical/tacticalSignals.ts';
import type { OpportunityType } from './src/core/tactical/types.ts';

const GRID_RISK = [0.005, 0.010, 0.015, 0.020];
const GRID_MIN_SCORE = [30, 35, 40, 45, 50];
const GRID_MAX_POSITIONS = [2, 3, 4, 5, 6];
const LOOKBACK = 252;
const INITIAL_CAPITAL = 10000;
const MIN_RISK_REWARD = 1.3;

interface BacktestPosition {
  ticker: string; entryDay: number; entryPrice: number; shares: number;
  invested: number; stopLoss: number; takeProfit1: number; takeProfit2: number;
  exitDay: number; exitPrice: number; pnl: number; daysHeld: number; exitReason: string;
}

interface BacktestResult {
  riskPerTradePct: number; minScore: number; maxOpenPositions: number;
  cagr: number; sharpe: number; maxDrawdown: number; calmar: number;
  totalReturn: number; finalValue: number; trades: number; winRate: number;
  volatility: number; compositeScore: number;
}

interface RegimeState { regime: string; vixLevel: number; }
function detectRegime(vix: number, c: number[]): RegimeState {
  if (vix > 25) return { regime: "HIGH_VOL", vixLevel: vix };
  if (!c || c.length < 50) return { regime: "BULL", vixLevel: vix };
  const last = c[c.length-1];
  const sma20 = c.slice(-20).reduce(function(a,b){return a+b;},0)/20;
  const sma50 = c.slice(-50).reduce(function(a,b){return a+b;},0)/50;
  if (last < sma50*0.95 && sma20 < sma50) return { regime: "BEAR", vixLevel: vix };
  if (last > sma50 && sma20 > sma50) return { regime: "BULL", vixLevel: vix };
  return { regime: "SIDEWAYS", vixLevel: vix };
}

function regMul(r: RegimeState): number {
  return r.regime === "BULL" ? 1.0 : r.regime === "BEAR" ? 0.7 : r.regime === "HIGH_VOL" ? 0.6 : 0.85;
}

function approxATR(closes: number[]): number {
  if (!closes || closes.length < 3) return 0;
  let sum = 0;
  for (let i = 1; i < closes.length; i++) sum += Math.abs(closes[i] - closes[i-1]);
  return sum / (closes.length - 1);
}

function synHLC(closes: number[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [], lows: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const a = approxATR(closes.slice(Math.max(0, i-20), i+1));
    highs.push(closes[i] + a * 1.5);
    lows.push(closes[i] - a * 1.5);
  }
  return { highs: highs, lows: lows };
}

function computeMetrics(eq: number[], initCap: number) {
  const clean = eq.filter(function(v){return isFinite(v)&&v>0;});
  if (clean.length < 21) return { cagr: 0, sharpe: 0, maxDD: 0, calmar: 0, vol: 0, totRet: 0, finVal: initCap };
  const yrs = (clean.length - 1) / 252;
  const fv = clean[clean.length-1];
  const tr = (fv / initCap) - 1;
  const cagr = yrs > 0 ? Math.pow(Math.max(0.001, fv/initCap), 1/yrs) - 1 : 0;
  const dr: number[] = [];
  for (var i = 1; i < clean.length; i++) dr.push(clean[i]/clean[i-1]-1);
  const mn = dr.reduce(function(a,b){return a+b;},0)/dr.length;
  const vr = dr.reduce(function(s,r){return s+(r-mn)**2;},0)/(dr.length-1);
  const vol = Math.sqrt(Math.max(0, vr*252));
  const sh = vol > 0 ? (mn - 0.04/252)/vol*Math.sqrt(252) : 0;
  let mdd = 0, peak = clean[0];
  for (var i = 0; i < clean.length; i++) {
    if (clean[i] > peak) peak = clean[i];
    const dd = (peak - clean[i]) / peak;
    if (dd > mdd) mdd = dd;
  }
  return { cagr: cagr, sharpe: sh, maxDD: mdd, calmar: mdd > 0 ? cagr/mdd : 0, vol: vol, totRet: tr, finVal: fv };
}

interface DataCache {
  dates: string[]; priceData: Record<string, number[]>; vixData: number[];
  hlcCache: Record<string, { highs: number[]; lows: number[] }>;
  assetCols: { name: string; idx: number }[];
}

function loadData(): DataCache {
  const csvPath = path.resolve(process.cwd(), "historical_data_daily.csv");
  if (!fs.existsSync(csvPath)) throw new Error("CSV not found at " + csvPath);
  const raw = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
  const headers = raw[0].split(",").map(function(h){return h.trim();});
  const assetCols: { name: string; idx: number }[] = [];
  let vixIdx = -1;
  for (var i = 1; i < headers.length; i++) {
    var h = headers[i].replace("\r","");
    if (h === "^VIX") vixIdx = i;
  }
  for (var i = 1; i < headers.length; i++) {
    var h = headers[i].replace("\r","");
    if (!h.startsWith("^")) assetCols.push({ name: h, idx: i });
  }
  const dates: string[] = [];
  const priceData: Record<string, number[]> = {};
  const vixData: number[] = [];
  for (var a = 0; a < assetCols.length; a++) priceData[assetCols[a].name] = [];
  for (let r = 1; r < raw.length; r++) {
    const cols = raw[r].split(",").map(function(c){return parseFloat(c.trim());});
    if (cols.length < 3 || isNaN(cols[0])) continue;
    dates.push(raw[r].split(",")[0].trim());
    for (var a = 0; a < assetCols.length; a++) {
      const ac = assetCols[a];
      priceData[ac.name].push(cols[ac.idx] ?? priceData[ac.name][priceData[ac.name].length-1] ?? 0);
    }
    vixData.push(vixIdx >= 0 ? (cols[vixIdx] ?? 15) : 15);
  }
  const hlcCache: Record<string, { highs: number[]; lows: number[] }> = {};
  for (var a = 0; a < assetCols.length; a++) {
    hlcCache[assetCols[a].name] = synHLC(priceData[assetCols[a].name]);
  }
  return { dates: dates, priceData: priceData, vixData: vixData, hlcCache: hlcCache, assetCols: assetCols };
}

function runBT(data: DataCache, cfg: { riskPerTradePct: number; minScore: number; maxOpenPositions: number }): BacktestResult {
  const dates = data.dates, priceData = data.priceData, vixData = data.vixData;
  const hlcCache = data.hlcCache, assetCols = data.assetCols;
  const riskPct = cfg.riskPerTradePct, minSc = cfg.minScore, maxPos = cfg.maxOpenPositions;
  if (dates.length < LOOKBACK + 50) throw new Error("Not enough data");
  let cash = INITIAL_CAPITAL;
  const eq: number[] = [INITIAL_CAPITAL];
  const closed: BacktestPosition[] = [];
  const open: BacktestPosition[] = [];
  const isSigAllowed = function(st: string, reg: RegimeState): boolean {
    const r = reg.regime;
    if (r === "BEAR" && ["MOMENTUM_BREAKOUT","TREND_FOLLOWING","BREAKOUT"].includes(st)) return false;
    if (r === "HIGH_VOL" && ["MOMENTUM_BREAKOUT","BREAKOUT","TREND_FOLLOWING"].includes(st)) return false;
    return true;
  };
  for (var t = LOOKBACK; t < dates.length; t++) {
    const ws = Math.max(0, t - LOOKBACK);
    const vix = vixData[t] ?? 15;
    const wlg = priceData["0P00000WLG.F"]?.slice(ws, t+1) ?? [];
    const reg = detectRegime(vix, wlg);
    const sMul = regMul(reg);
    for (var pi = open.length-1; pi >= 0; pi--) {
      var pos = open[pi];
      const cp = priceData[pos.ticker]?.[t] ?? pos.entryPrice;
      const hlc = hlcCache[pos.ticker];
      const ch = hlc?.highs[t] ?? cp;
      const cl = hlc?.lows[t] ?? cp;
      const exitPos = function(reason: string, price: number) {
        pos.exitPrice = price; pos.pnl = (price-pos.entryPrice)*pos.shares;
        pos.daysHeld = t-pos.entryDay; pos.exitReason = reason;
        cash += price*pos.shares; closed.push(pos); open.splice(pi,1);
      };
      if (cl <= pos.stopLoss) { exitPos("STOP_LOSS", pos.stopLoss); continue; }
      if (ch >= pos.takeProfit2) { exitPos("TAKE_PROFIT_2", pos.takeProfit2); continue; }
      if (ch >= pos.takeProfit1) {
        const half = pos.shares/2; cash += half*pos.takeProfit1;
        pos.shares -= half; pos.invested = pos.shares*pos.entryPrice;
        pos.takeProfit1 = Infinity;
      }
      if (t-pos.entryDay > 60) { exitPos("TIMEOUT", cp); }
    }
    interface Cand { ticker: string; price: number; st: string; score: number; sl: number; tp1: number; tp2: number; rr: number; }
    const cands: Cand[] = [];
    for (let a = 0; a < assetCols.length; a++) {
      const ac = assetCols[a];
      const closes = priceData[ac.name]?.slice(ws, t+1);
      if (!closes || closes.length < 50) continue;
      const hi = hlcCache[ac.name].highs.slice(ws, t+1), lo = hlcCache[ac.name].lows.slice(ws, t+1);
      const ind = calcIndicators(closes, closes, hi, lo);
      const sigs = generateSignals(ind);
      for (let si = 0; si < sigs.length; si++) {
        const sig = sigs[si];
        if (!isSigAllowed(sig.type, reg)) continue;
        const pr = closes[closes.length-1];
        const sc = sig.score * sMul;
        if (sc < minSc) continue;
        const sl = calcStopLoss(pr, ind.atr, sig.type, closes);
        const tMul = sig.type === "MOMENTUM_BREAKOUT" ? 1.8 : sig.type === "OVERSOLD_BOUNCE" ? 1.3 : 1.5;
        const tp1 = pr + (pr-sl)*tMul;
        const tp2 = pr + (pr-sl)*tMul*1.5;
        const rr = Math.abs((tp1-pr)/Math.max(0.0001, pr-sl));
        cands.push({ ticker: ac.name, price: pr, st: sig.type, score: sc, sl: sl, tp1: tp1, tp2: tp2, rr: rr });
      }
    }
    cands.sort(function(a,b){return b.score-a.score;});
    const openT = new Set(open.map(function(p){return p.ticker;}));
    for (let ci = 0; ci < cands.length; ci++) {
      const c = cands[ci];
      if (open.length >= maxPos) break;
      if (openT.has(c.ticker)) continue;
      if (c.rr < MIN_RISK_REWARD) continue;
      const den = Math.abs(1-c.sl/Math.max(0.0001,c.price));
      const ps = Math.min(cash*0.30, riskPct*cash/den);
      if (ps < cash*0.01 || ps > cash*0.3) continue;
      const sh = ps/c.price; cash -= sh*c.price;
      open.push({ticker:c.ticker,entryDay:t,entryPrice:c.price,shares:sh,invested:sh*c.price,
        stopLoss:c.sl,takeProfit1:c.tp1,takeProfit2:c.tp2,exitDay:t,exitPrice:0,pnl:0,daysHeld:0,exitReason:""});
      openT.add(c.ticker);
    }
    let pv = cash;
    for (let pi2 = 0; pi2 < open.length; pi2++) {
      pv += (priceData[open[pi2].ticker]?.[t] ?? open[pi2].entryPrice) * open[pi2].shares;
    }
    eq.push(pv);
  }
  const li = dates.length-1;
  for (let pi3 = 0; pi3 < open.length; pi3++) {
    var p = open[pi3];
    const lp = priceData[p.ticker]?.[li] ?? p.entryPrice;
    p.exitDay = li; p.exitPrice = lp;
    p.pnl = (lp-p.entryPrice)*p.shares; p.daysHeld = li-p.entryDay; p.exitReason = "MANUAL";
    closed.push(p);
  }
  const m = computeMetrics(eq, INITIAL_CAPITAL);
  let w = 0;
  for (var p = 0; p < closed.length; p++) { if (closed[p].pnl > 0) w++; }
  const wr = closed.length > 0 ? w/closed.length : 0;
  const cs = m.sharpe*0.35 + m.calmar*0.25 + m.cagr*10*0.20 + wr*0.10 + (1-m.maxDD)*0.10;
  return {
    riskPerTradePct: riskPct, minScore: minSc, maxOpenPositions: maxPos,
    cagr: m.cagr, sharpe: m.sharpe, maxDrawdown: m.maxDD, calmar: m.calmar,
    totalReturn: m.totRet, finalValue: m.finVal, trades: closed.length, winRate: wr,
    volatility: m.vol, compositeScore: parseFloat(cs.toFixed(4)),
  };
}

function main() {
  console.log("");
  console.log("====================================================================");
  console.log("  OPTIMIZACION PARAMETRICA - BACKTEST TACTICO OLYMPUS");
  console.log("  Grid: riskPerTradePct x minScore x maxOpenPositions");
  console.log("  LOOKBACK: " + LOOKBACK + "d");
  console.log("====================================================================");
  console.log("");
  console.log("Cargando datos historicos...");
  const data = loadData();
  console.log("Datos: " + data.dates.length + " dias, " + data.assetCols.length + " activos");
  const total = GRID_RISK.length * GRID_MIN_SCORE.length * GRID_MAX_POSITIONS.length;
  console.log("Combinaciones: " + total + " (risk: " + GRID_RISK.length + ", score: " + GRID_MIN_SCORE.length + ", pos: " + GRID_MAX_POSITIONS.length + ")");
  console.log("");
  const results: BacktestResult[] = [];
  let count = 0;
  for (let ri = 0; ri < GRID_RISK.length; ri++) {
    for (let mi = 0; mi < GRID_MIN_SCORE.length; mi++) {
      for (let pi = 0; pi < GRID_MAX_POSITIONS.length; pi++) {
        const risk = GRID_RISK[ri];
        const minSc = GRID_MIN_SCORE[mi];
        const maxPos = GRID_MAX_POSITIONS[pi];
        count++;
        if (count % 20 === 0 || count === total) {
          const pct = Math.round(count/total*100);
          process.stdout.write("\rProcesando: " + count + "/" + total + " (" + pct + "%)");
        }
        try {
          var r = runBT(data, { riskPerTradePct: risk, minScore: minSc, maxOpenPositions: maxPos });
          results.push(r);
        } catch (e: any) {
          console.error("\nFallo en " + risk + "/" + minSc + "/" + maxPos + ": " + (e.message ?? e));
        }
      }
    }
  }
  console.log("\n");
  results.sort(function(a,b){return b.compositeScore-a.compositeScore;});
  function pad(v: any, n: number, d: number): string {
    let s = (typeof v === "number" ? v.toFixed(d) : String(v));
    while (s.length < n) s = " " + s;
    return s;
  }
  function printHeader() {
    console.log("Rank  Risk%  Score  MaxPos  CAGR%   Sharpe  Calmar  WinRt%  DD%    Comp");
  }
  console.log("--- TOP 10 (Composite Score) ---");
  printHeader();
  for (var i = 0; i < Math.min(10, results.length); i++) {
    var r = results[i];
    const line = pad(i+1,4,0) + " " + pad((r.riskPerTradePct*100).toFixed(1),5,0) + " " +
      pad(r.minScore,5,0) + " " + pad(r.maxOpenPositions,6,0) + " " +
      pad((r.cagr*100).toFixed(2),6,0) + "%" + pad(r.sharpe.toFixed(3),7,0) + " " +
      pad(r.calmar.toFixed(2),7,0) + " " + pad((r.winRate*100).toFixed(1),6,0) + "%" +
      pad((r.maxDrawdown*100).toFixed(2),5,0) + "%" + pad(r.compositeScore.toFixed(4),9,0);
    console.log(line);
  }
  console.log("");
  const byS = [...results].sort(function(a,b){return b.sharpe-a.sharpe;});
  console.log("--- TOP 5 (Sharpe) ---");
  printHeader();
  for (var i = 0; i < Math.min(5, byS.length); i++) {
    var r = byS[i];
    console.log(pad(i+1,4,0)+" "+pad((r.riskPerTradePct*100).toFixed(1),5,0)+" "+pad(r.minScore,5,0)+" "+
      pad(r.maxOpenPositions,6,0)+" "+pad((r.cagr*100).toFixed(2),6,0)+"%"+pad(r.sharpe.toFixed(3),7,0)+" "+
      pad(r.calmar.toFixed(2),7,0)+" "+pad((r.winRate*100).toFixed(1),6,0)+"%"+pad((r.maxDrawdown*100).toFixed(2),5,0)+"%");
  }
  console.log("");
  const byC = [...results].sort(function(a,b){return b.calmar-a.calmar;});
  console.log("--- TOP 5 (Calmar) ---");
  printHeader();
  for (var i = 0; i < Math.min(5, byC.length); i++) {
    var r = byC[i];
    console.log(pad(i+1,4,0)+" "+pad((r.riskPerTradePct*100).toFixed(1),5,0)+" "+pad(r.minScore,5,0)+" "+
      pad(r.maxOpenPositions,6,0)+" "+pad((r.cagr*100).toFixed(2),6,0)+"%"+pad(r.sharpe.toFixed(3),7,0)+" "+
      pad(r.calmar.toFixed(2),7,0)+" "+pad((r.winRate*100).toFixed(1),6,0)+"%"+pad((r.maxDrawdown*100).toFixed(2),5,0)+"%");
  }
  const csvPath = path.resolve(process.cwd(), "optimization_results.csv");
  const csv: string[] = [];
  csv.push("Rank,RiskPct,MinScore,MaxPos,CAGR,Sharpe,Calmar,MaxDD,TotalRet,FinalValue,Trades,WinRate,Vol,Composite");
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    csv.push((i+1)+","+r.riskPerTradePct+","+r.minScore+","+r.maxOpenPositions+","+
      r.cagr.toFixed(6)+","+r.sharpe.toFixed(6)+","+r.calmar.toFixed(6)+","+
      r.maxDrawdown.toFixed(6)+","+r.totalReturn.toFixed(6)+","+r.finalValue.toFixed(2)+","+
      r.trades+","+r.winRate.toFixed(6)+","+r.volatility.toFixed(6)+","+r.compositeScore.toFixed(6));
  }
  fs.writeFileSync(csvPath, csv.join("\n"), "utf-8");
  console.log("\nResultados exportados a: " + csvPath);
  console.log("Total combinaciones exitosas: " + results.length + "/" + total);
}
try { main(); }
catch (e: any) { console.error("Optimizacion fallo:", e.message ?? e); process.exit(1); }
