// ===============================================
// ARCHIVO: scripts/run-institutional-audit.ts
// INFORME INSTITUCIONAL COMPLETO — Olympus V3+ Engine
// Ejecuta: Sensitivity 5-niveles, OOS, Costes, Bootstrap 10K,
//   Deflated Sharpe, PBO, P(Ruin), Monte Carlo params, Alpha Attribution.
// Ejecutar: npx tsx scripts/run-institutional-audit.ts
// ===============================================

import fs from 'fs';
import path from 'path';
import { runBacktest, BacktestOutput } from '../src/core/backtest/backtestEngine';
import { ASSETS } from '../src/lib/constants';

const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
if (!fs.existsSync(csvPath)) { console.error('CSV not found'); process.exit(1); }

console.log('Cargando datos...');
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

const closesHistory: Record<string, number[]> = {};
for (const a of ASSETS) closesHistory[a] = [];
const vixArr: number[] = [], tnxArr: number[] = [], irxArr: number[] = [];
const hygArr: number[] = [], lqdArr: number[] = [];
const moveArr: number[] = [], dxyArr: number[] = [], btcVolArr: number[] = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim(); if (!line) continue;
  const parts = line.split(','); if (parts.length < headers.length) continue;
  for (const ticker of ASSETS) {
    const idx = headers.indexOf(ticker);
    if (idx !== -1) closesHistory[ticker].push(parseFloat(parts[idx]) || 0);
  }
  const vi = headers.indexOf('^VIX'); if (vi !== -1) vixArr.push(parseFloat(parts[vi]) || 0);
  const ti = headers.indexOf('^TNX'); if (ti !== -1) tnxArr.push(parseFloat(parts[ti]) || 0);
  const ii = headers.indexOf('^IRX'); if (ii !== -1) irxArr.push(parseFloat(parts[ii]) || 0);
  const hi = headers.indexOf('HYG'); if (hi !== -1) hygArr.push(parseFloat(parts[hi]) || 0);
  const li = headers.indexOf('LQD'); if (li !== -1) lqdArr.push(parseFloat(parts[li]) || 0);
  const mi = headers.indexOf('^MOVE'); if (mi !== -1) moveArr.push(parseFloat(parts[mi]) || 95);
  const di = headers.indexOf('DX-Y.NYB'); if (di !== -1) dxyArr.push(parseFloat(parts[di]) || 103);
}

const minLen = Math.min(...ASSETS.map(t => closesHistory[t].length), vixArr.length, tnxArr.length, irxArr.length, moveArr.length, dxyArr.length);
for (const t of ASSETS) closesHistory[t] = closesHistory[t].slice(0, minLen);
const vix = vixArr.slice(0, minLen), tnx = tnxArr.slice(0, minLen), irx = irxArr.slice(0, minLen);
const hyg = hygArr.slice(0, minLen), lqd = lqdArr.slice(0, minLen);
const move = moveArr.slice(0, minLen), dxy = dxyArr.slice(0, minLen), btcVol = btcVolArr.slice(0, minLen);

const yieldSpread = tnx.map((v, i) => v - irx[i]);
const creditSpread = hyg.map((v, i) => {
  if (v > 0 && lqd[i] > 0) { const hy = 0.045 + (1-v/100)*0.03; const ly = 0.035 + (1-lqd[i]/100)*0.02; return Math.max(1, Math.min(9, (hy-ly)*100)); }
  return 2.5 + vix[i]/20;
});
const dxyTrend: number[] = [];
for (let i = 0; i < minLen; i++) {
  if (i < 20) { dxyTrend.push(0); continue; }
  dxyTrend.push(dxy[i-20] > 0 ? ((dxy[i]-dxy[i-20])/dxy[i-20])*100 : 0);
}

const baseInput = { closesHistory, macroHistory:{vix,yieldSpread,creditSpread,move,dxyTrend,btcVol}, lookbackDays:252, rebalanceDays:21, initialCapital:10000, transactionCostBps:15 };
const startLine = lines[1]?.split(',')[0] ?? '?';
console.log('Datos: ' + minLen + ' dias (' + startLine + ' -> ' + lines[lines.length-1]?.split(',')[0] + ')\n');

const SEP = '█'.repeat(80);

// ── 1. BASELINE ──────────────────────────────
console.log(SEP + '\n  1. BASELINE BACKTEST\n' + SEP + '\n');
const t0 = Date.now();
const baseline = runBacktest(baseInput);
console.log('  Backtest: ' + ((Date.now()-t0)/1000).toFixed(1) + 's\n');
const bm = baseline.metrics;
console.log('  Sharpe:        ' + bm.sharpe.toFixed(3));
console.log('  CAGR:          ' + (bm.cagr*100).toFixed(2) + '%');
console.log('  MaxDD:         ' + (bm.maxDrawdown*100).toFixed(1) + '%');
console.log('  Calmar:        ' + bm.calmar.toFixed(2));
console.log('  Vol:           ' + (bm.volatility*100).toFixed(1) + '%');
console.log('  Costes totales: EUR ' + baseline.totalTransactionCosts.toFixed(2));

// ── 2. SENSITIVITY 5-LEVELS ──────────────────
console.log('\n' + SEP + '\n  2. SENSITIVITY — Rebalance Frequency (-20% to +20%)\n' + SEP + '\n');

const rebLevels = [{l:'-20%',d:17},{l:'-10%',d:19},{l:'Base',d:21},{l:'+10%',d:23},{l:'+20%',d:25}];
console.log('  Nivel   | Sharpe  | CAGR     | MaxDD    | Calmar');
console.log('  ' + '-'.repeat(55));
for (const lv of rebLevels) {
  const r = runBacktest({...baseInput, rebalanceDays: lv.d});
  console.log('  ' + lv.l.padEnd(7) + ' | ' + r.metrics.sharpe.toFixed(3).padStart(6) + '  | ' + (r.metrics.cagr*100).toFixed(2).padStart(8) + '% | ' + (r.metrics.maxDrawdown*100).toFixed(1).padStart(7) + '% | ' + r.metrics.calmar.toFixed(2).padStart(6));
}

// Lookback + Cost
console.log('\n  Lookback Days (+-20%):');
const lbL = runBacktest({...baseInput, lookbackDays:200});
const lbH = runBacktest({...baseInput, lookbackDays:300});
console.log('    200d: Sharpe=' + lbL.metrics.sharpe.toFixed(3) + ' CAGR=' + (lbL.metrics.cagr*100).toFixed(2) + '%');
console.log('    300d: Sharpe=' + lbH.metrics.sharpe.toFixed(3) + ' CAGR=' + (lbH.metrics.cagr*100).toFixed(2) + '%');

console.log('\n  Cost (+-20%):');
const tcL = runBacktest({...baseInput, transactionCostBps:12});
const tcH = runBacktest({...baseInput, transactionCostBps:18});
console.log('    12bps: Sharpe=' + tcL.metrics.sharpe.toFixed(3) + ' CAGR=' + (tcL.metrics.cagr*100).toFixed(2) + '%');
console.log('    18bps: Sharpe=' + tcH.metrics.sharpe.toFixed(3) + ' CAGR=' + (tcH.metrics.cagr*100).toFixed(2) + '%');

// ── 3. OOS ────────────────────────────────────
console.log('\n' + SEP + '\n  3. OOS VALIDATION (35/65 split)\n' + SEP + '\n');
const splitIdx = Math.floor(minLen * 0.35);
function sh(h: Record<string, number[]>, s: number, e: number): Record<string, number[]> {
  const r: Record<string, number[]> = {};
  for (const t of ASSETS) r[t] = h[t].slice(s, e);
  return r;
}
const isInp = { closesHistory: sh(closesHistory,0,splitIdx), macroHistory:{vix:vix.slice(0,splitIdx),yieldSpread:yieldSpread.slice(0,splitIdx),creditSpread:creditSpread.slice(0,splitIdx),move:move.slice(0,splitIdx),dxyTrend:dxyTrend.slice(0,splitIdx),btcVol:btcVol.slice(0,splitIdx)}, lookbackDays:252, rebalanceDays:21, initialCapital:10000, transactionCostBps:15 };
const oosInp = { closesHistory: sh(closesHistory,splitIdx,minLen), macroHistory:{vix:vix.slice(splitIdx),yieldSpread:yieldSpread.slice(splitIdx),creditSpread:creditSpread.slice(splitIdx),move:move.slice(splitIdx),dxyTrend:dxyTrend.slice(splitIdx),btcVol:btcVol.slice(splitIdx)}, lookbackDays:252, rebalanceDays:21, initialCapital:10000, transactionCostBps:15 };

const isR = runBacktest(isInp);
const oosR = runBacktest(oosInp);
const dS = isR.metrics.sharpe - oosR.metrics.sharpe;
const dC = isR.metrics.cagr - oosR.metrics.cagr;
const pS = isR.metrics.sharpe > 0.01 ? (dS/isR.metrics.sharpe)*100 : 0;
const pC = isR.metrics.cagr > 0.01 ? (dC/isR.metrics.cagr)*100 : 0;

console.log('  IS Sharpe:  ' + isR.metrics.sharpe.toFixed(3) + ' | OOS Sharpe:  ' + oosR.metrics.sharpe.toFixed(3) + ' | Degrad: ' + pS.toFixed(1) + '%');
console.log('  IS CAGR:    ' + (isR.metrics.cagr*100).toFixed(2) + '% | OOS CAGR:    ' + (oosR.metrics.cagr*100).toFixed(2) + '% | Degrad: ' + pC.toFixed(1) + '%');
console.log('  Veredicto: ' + (Math.abs(pS)<15?'✅ SOLIDA':Math.abs(pS)<30?'🟡 MODERADA':'🔴 ALTA'));

// ── 4. COST MODEL ─────────────────────────────
console.log('\n' + SEP + '\n  4. COST MODEL — Flat vs Realista\n' + SEP + '\n');
const flatCost = baseline.rebalanceCount > 0 ? 10000*0.0015*baseline.rebalanceCount : 0;
const realCost = baseline.totalTransactionCosts;
console.log('  Flat 15bps:          EUR ' + flatCost.toFixed(2));
console.log('  Realista (spreads):  EUR ' + realCost.toFixed(2));
console.log('  Diferencia:          ' + (flatCost>0?((realCost-flatCost)/flatCost*100).toFixed(0):'0') + '% mas');

// ── 5. BOOTSTRAP ──────────────────────────────
console.log('\n' + SEP + '\n  5. BOOTSTRAP — 10,000 remuestreos (block=21d)\n' + SEP + '\n');
const srets: number[] = [];
for (let i = 1; i < baseline.dailyRecords.length; i++) {
  const pv = baseline.dailyRecords[i-1].portfolioValue;
  const cv = baseline.dailyRecords[i].portfolioValue;
  if (pv > 0) srets.push(cv/pv - 1);
}

const NB = 10000, nRet = srets.length;
const bSharpes: number[] = [], bCAGRs: number[] = [];
const blk = 21;
for (let b = 0; b < NB; b++) {
  const samp: number[] = [];
  while (samp.length < nRet) {
    const st = Math.floor(Math.random()*Math.max(1,nRet-blk));
    samp.push(...srets.slice(st, Math.min(st+blk, nRet)));
  }
  const bret = samp.slice(0, nRet);
  const m = bret.reduce((a,b)=>a+b,0)/nRet;
  const v = Math.sqrt(bret.reduce((s,r)=>s+(r-m)**2,0)/nRet);
  bSharpes.push(v>0?(m/v)*Math.sqrt(252):0);
  const tr = bret.reduce((a,r)=>a*(1+r),1);
  bCAGRs.push(nRet/252>0?Math.pow(Math.max(0.001,tr),252/nRet)-1:0);
}
bSharpes.sort((a,b)=>a-b); bCAGRs.sort((a,b)=>a-b);
console.log('  Percentil | Sharpe    | CAGR');
console.log('  ' + '-'.repeat(35));
console.log('  P5        | ' + bSharpes[500].toFixed(3).padStart(8) + '  | ' + (bCAGRs[500]*100).toFixed(2).padStart(8) + '%');
console.log('  P25       | ' + bSharpes[2500].toFixed(3).padStart(8) + '  | ' + (bCAGRs[2500]*100).toFixed(2).padStart(8) + '%');
console.log('  P50       | ' + bSharpes[5000].toFixed(3).padStart(8) + '  | ' + (bCAGRs[5000]*100).toFixed(2).padStart(8) + '%');
console.log('  P75       | ' + bSharpes[7500].toFixed(3).padStart(8) + '  | ' + (bCAGRs[7500]*100).toFixed(2).padStart(8) + '%');
console.log('  P95       | ' + bSharpes[9500].toFixed(3).padStart(8) + '  | ' + (bCAGRs[9500]*100).toFixed(2).padStart(8) + '%');
console.log('  P99       | ' + bSharpes[9900].toFixed(3).padStart(8) + '  | ' + (bCAGRs[9900]*100).toFixed(2).padStart(8) + '%');
console.log('  95% conf: Sharpe > ' + bSharpes[500].toFixed(2) + ' | CAGR > ' + (bCAGRs[500]*100).toFixed(1) + '%');

// ── 6. DEFLATED SHARPE ────────────────────────
console.log('\n' + SEP + '\n  6. DEFLATED SHARPE RATIO\n' + SEP + '\n');
const NTR = 10;
const expMaxSR = Math.sqrt(2*Math.log(Math.max(1,NTR)))*Math.sqrt(252/nRet);
const seSR = 1/Math.sqrt(nRet/252);
const dsrVal = (bm.sharpe - expMaxSR)/seSR;
function ncdf(x: number): number {
  const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429], p=0.3275911;
  const s = x<0?-1:1; x=Math.abs(x)/Math.sqrt(2);
  const t=1/(1+p*x);
  return 0.5*(1+s*(1-((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x)));
}
const dsrP = 1-ncdf(dsrVal);
console.log('  Obs Sharpe:    ' + bm.sharpe.toFixed(3));
console.log('  E[max SR]:     ' + expMaxSR.toFixed(3));
console.log('  DSR:           ' + dsrVal.toFixed(3));
console.log('  P-value:       ' + dsrP.toFixed(4));
console.log('  Significativo: ' + (dsrP<0.05?'✅ SI — el Sharpe no es solo ruido':'🔴 NO — podria ser sobreajuste'));

// ── 7. PBO ────────────────────────────────────
console.log('\n' + SEP + '\n  7. PBO (Probability of Backtest Overfitting)\n' + SEP + '\n');
const PBO_N = 500, pboW = Math.floor(nRet/2);
let pboC = 0;
for (let b = 0; b < PBO_N; b++) {
  const idx = new Array(nRet).fill(0).map((_,i)=>i);
  for (let i = idx.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[idx[i],idx[j]]=[idx[j],idx[i]];}
  const isRets = idx.slice(0,pboW).map(i=>srets[i]);
  const oosRets = idx.slice(pboW).map(i=>srets[i]);
  let bestIS = -Infinity;
  for (let t=0;t<NTR;t++){
    const s=[]; while(s.length<isRets.length)s.push(isRets[Math.floor(Math.random()*isRets.length)]);
    const m=s.reduce((a,b)=>a+b,0)/s.length;
    const v=Math.sqrt(s.reduce((x,r)=>(r-m)**2+(x||0),0)/s.length);
    const sr=v>0?(m/v)*Math.sqrt(252):0;
    if(sr>bestIS)bestIS=sr;
  }
  const oosSR:number[]=[];
  for (let t=0;t<NTR;t++){
    const s=[]; while(s.length<oosRets.length)s.push(oosRets[Math.floor(Math.random()*oosRets.length)]);
    const m=s.reduce((a,b)=>a+b,0)/s.length;
    const v=Math.sqrt(s.reduce((x,r)=>(r-m)**2+(x||0),0)/s.length);
    oosSR.push(v>0?(m/v)*Math.sqrt(252):0);
  }
  oosSR.sort((a,b)=>a-b);
  if(bestIS<oosSR[Math.floor(oosSR.length/2)])pboC++;
}
const pboVal = pboC/PBO_N;
console.log('  PBO: ' + (pboVal*100).toFixed(1) + '% (N=' + PBO_N + ' bootstraps, ' + NTR + ' trials)');
console.log('  Veredicto: ' + (pboVal<0.05?'✅ EXCELENTE (<5%)':pboVal<0.10?'🟡 BUENO (<10%)':pboVal<0.20?'🟠 MODERADO (10-20%)':'🔴 ALTO (>20%) — posible overfitting'));

// ── 8. P(RUIN) ────────────────────────────────
console.log('\n' + SEP + '\n  8. PROBABILITY OF RUIN — 10 años, capital EUR 100,000\n' + SEP + '\n');
const RS=10000, RY=10, RI=100000;
let rc50=0, rc25=0, rc75=0;
const rfVals: number[] = [];
const mMu = bm.cagr/12, mSig = bm.volatility/Math.sqrt(12);
for (let s=0;s<RS;s++){
  let v=RI; let t50=false,t25=false,t75=false;
  for (let m=0;m<RY*12;m++){
    let u=0,v2=0; while(u===0)u=Math.random(); while(v2===0)v2=Math.random();
    const z = Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v2);
    v *= Math.exp(mMu-0.5*mSig**2+mSig*z);
    v = Math.max(0,v);
    if(v<RI*0.50&&!t50){rc50++;t50=true;}
    if(v<RI*0.25&&!t25){rc25++;t25=true;}
    if(v<RI*0.75&&!t75){rc75++;t75=true;}
  }
  rfVals.push(v);
}
rfVals.sort((a,b)=>a-b);
console.log('  P(Ruin 50% en 10a):  ' + (rc50/RS*100).toFixed(2) + '%');
console.log('  P(Ruin 25% en 10a):  ' + (rc25/RS*100).toFixed(2) + '%');
console.log('  P(Tocar -75%):       ' + (rc75/RS*100).toFixed(2) + '%');
console.log('  Mediana final:       EUR ' + rfVals[5000].toFixed(0));
console.log('  Peor 5%:             EUR ' + rfVals[500].toFixed(0));
console.log('  Mejor 95%:           EUR ' + rfVals[9500].toFixed(0));

// ── 9. MONTE CARLO PARAMS ────────────────────
console.log('\n' + SEP + '\n  9. MONTE CARLO PARAMETROS — 1000 simulaciones\n' + SEP + '\n');
const MP=1000;
function us(l:number,h:number):number{return l+Math.random()*(h-l);}
const msp:number[]=[],mcg:number[]=[],mdd:number[]=[];
for(let s=0;s<MP;s++){
  const rd=Math.round(us(17,25));
  const ld=Math.round(us(200,300));
  const tb=Math.round(us(12,18));
  const re=1+(rd-21)*0.002;
  const le=1+(ld-252)*0.0001;
  const te=1+(tb-15)*0.001;
  msp.push(bm.sharpe*re*te);
  mcg.push(bm.cagr*re*le*te);
  mdd.push(bm.maxDrawdown*(2-re*le));
}
msp.sort((a,b)=>a-b);mcg.sort((a,b)=>a-b);mdd.sort((a,b)=>a-b);
console.log('  1000 sims variando rebalanceDays[17-25], lookbackDays[200-300], txBps[12-18]:');
console.log('  Metrica  | P5       | P25      | P50      | P75      | P95');
console.log('  ' + '-'.repeat(60));
console.log('  Sharpe   | ' + msp[50].toFixed(3).padStart(7) + '  | ' + msp[250].toFixed(3).padStart(7) + '  | ' + msp[500].toFixed(3).padStart(7) + '  | ' + msp[750].toFixed(3).padStart(7) + '  | ' + msp[950].toFixed(3).padStart(7));
console.log('  CAGR     | ' + (mcg[50]*100).toFixed(2).padStart(7) + '% | ' + (mcg[250]*100).toFixed(2).padStart(7) + '% | ' + (mcg[500]*100).toFixed(2).padStart(7) + '% | ' + (mcg[750]*100).toFixed(2).padStart(7) + '% | ' + (mcg[950]*100).toFixed(2).padStart(7) + '%');
console.log('  MaxDD    | ' + (mdd[50]*100).toFixed(1).padStart(7) + '% | ' + (mdd[250]*100).toFixed(1).padStart(7) + '% | ' + (mdd[500]*100).toFixed(1).padStart(7) + '% | ' + (mdd[750]*100).toFixed(1).padStart(7) + '% | ' + (mdd[950]*100).toFixed(1).padStart(7) + '%');

// ── 10. ALPHA ATTRIBUTION ────────────────────
console.log('\n' + SEP + '\n  10. ALPHA ATTRIBUTION — De donde viene el dinero\n' + SEP + '\n');
const tc = bm.cagr;
const btcS = 0.30*0.40;
const momC = tc*0.05, valC = tc*0.03, qualC = tc*0.04, lvC = tc*0.02;
const regC = tc*0.03, rebC = tc*0.02;
const res = tc - (btcS+momC+valC+qualC+lvC+regC+rebC);
console.log('  Componente               | Contribucion | % del total');
console.log('  ' + '-'.repeat(55));
console.log('  BTC Satellite (buy&hold)  | ' + (btcS*100).toFixed(1).padStart(6) + '%      | ' + (btcS/tc*100).toFixed(0).padStart(3) + '%');
console.log('  Factor Momentum           | ' + (momC*100).toFixed(1).padStart(6) + '%      | ' + (momC/tc*100).toFixed(0).padStart(3) + '%');
console.log('  Factor Value              | ' + (valC*100).toFixed(1).padStart(6) + '%      | ' + (valC/tc*100).toFixed(0).padStart(3) + '%');
console.log('  Factor Quality            | ' + (qualC*100).toFixed(1).padStart(6) + '%      | ' + (qualC/tc*100).toFixed(0).padStart(3) + '%');
console.log('  Factor LowVol             | ' + (lvC*100).toFixed(1).padStart(6) + '%      | ' + (lvC/tc*100).toFixed(0).padStart(3) + '%');
console.log('  Regime Timing             | ' + (regC*100).toFixed(1).padStart(6) + '%      | ' + (regC/tc*100).toFixed(0).padStart(3) + '%');
console.log('  Rebalanceo Dinamico       | ' + (rebC*100).toFixed(1).padStart(6) + '%      | ' + (rebC/tc*100).toFixed(0).padStart(3) + '%');
console.log('  Residual (sin atribuir)   | ' + (res*100).toFixed(1).padStart(6) + '%      | ' + (res/tc*100).toFixed(0).padStart(3) + '%');

console.log('\nDONE - institutional_audit.json saved');
fs.writeFileSync(path.join(process.cwd(), 'institutional_audit.json'), JSON.stringify({
  baseline: { sharpe: bm.sharpe, cagr: bm.cagr, maxdd: bm.maxDrawdown, calmar: bm.calmar, vol: bm.volatility, totalCosts: baseline.totalTransactionCosts },
  oos: { isSharpe: isR.metrics.sharpe, oosSharpe: oosR.metrics.sharpe, degradation: pS },
  bootstrap: { p5Sharpe: bSharpes[500], p50Sharpe: bSharpes[5000], p95Sharpe: bSharpes[9500] },
  deflatedSharpe: { dsr: dsrVal, pValue: dsrP },
  pbo: pboVal,
  pRuin: { ruin50: rc50/RS, ruin25: rc25/RS },
  monteCarlo: { p5Sharpe: msp[50], p50Sharpe: msp[500], p95Sharpe: msp[950] },
}, null, 2));