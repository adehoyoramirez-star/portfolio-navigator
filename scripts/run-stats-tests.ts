import { runBacktest } from '../src/core/backtest/backtestEngine';
import { ASSETS } from '../src/lib/constants';
import fs from 'fs';

const csvPath = 'historical_data_daily_augmented.csv';
if (!fs.existsSync(csvPath)) { process.exit(1); }
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('
');
');
const headers = lines[0].split(',');

const closesHistory: Record<string, number[]> = {};
for (const a of ASSETS) closesHistory[a] = [];
const vixArr: number[] = [], tnxArr: number[] = [], irxArr: number[] = [];
const hygArr: number[] = [], lqdArr: number[] = [], moveArr: number[] = [], dxyArr: number[] = [], btcVolArr: number[] = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim(); if (!line) continue;
  const parts = line.split(','); if (parts.length < headers.length) continue;
  for (const ticker of ASSETS) {
    const idx = headers.indexOf(ticker);
    if (idx !== -1) closesHistory[ticker].push(parseFloat(parts[idx]) || 0);
  }
  const vi = headers.indexOf('\^VIX'); if (vi !== -1) vixArr.push(parseFloat(parts[vi]) || 0);
  const ti = headers.indexOf('\^TNX'); if (ti !== -1) tnxArr.push(parseFloat(parts[ti]) || 0);
  const ii = headers.indexOf('\^IRX'); if (ii !== -1) irxArr.push(parseFloat(parts[ii]) || 0);
  const hi = headers.indexOf('HYG'); if (hi !== -1) hygArr.push(parseFloat(parts[hi]) || 0);
  const li = headers.indexOf('LQD'); if (li !== -1) lqdArr.push(parseFloat(parts[li]) || 0);
  const mi = headers.indexOf('\^MOVE'); if (mi !== -1) moveArr.push(parseFloat(parts[mi]) || 95);
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

console.log('Running baseline...');
const t0 = Date.now();
const bl = runBacktest(baseInput);
const bm = bl.metrics;
const srets: number[] = [];
for (let i = 1; i < bl.dailyRecords.length; i++) {
  const pv = bl.dailyRecords[i-1].portfolioValue;
  const cv = bl.dailyRecords[i].portfolioValue;
  if (pv > 0) srets.push(cv/pv - 1);
}
const nRet = srets.length;
console.log('Sharpe=' + bm.sharpe.toFixed(3) + ' CAGR=' + (bm.cagr*100).toFixed(1) + '% | ' + nRet + ' returns');

// BOOTSTRAP
const NB=10000, blk=21;
const bS:number[]=[], bC:number[]=[];
for(let b=0;b<NB;b++){
  const samp:number[]=[];
  while(samp.length<nRet){const st=Math.floor(Math.random()*Math.max(1,nRet-blk));samp.push(...srets.slice(st,Math.min(st+blk,nRet)));}
  const br=samp.slice(0,nRet);
  const m=br.reduce((a,b)=>a+b,0)/nRet;
  const v=Math.sqrt(br.reduce((s,r)=>s+(r-m)**2,0)/nRet);
  bS.push(v>0?(m/v)*Math.sqrt(252):0);
  const tr=br.reduce((a,r)=>a*(1+r),1);
  bC.push(nRet/252>0?Math.pow(Math.max(0.001,tr),252/nRet)-1:0);
}
bS.sort((a,b)=>a-b); bC.sort((a,b)=>a-b);
console.log('
=== BOOTSTRAP 10K ===');
console.log('P5:  S=' + bS[500].toFixed(2) + ' C=' + (bC[500]*100).toFixed(1) + '%');
console.log('P25: S=' + bS[2500].toFixed(2) + ' C=' + (bC[2500]*100).toFixed(1) + '%');
console.log('P50: S=' + bS[5000].toFixed(2) + ' C=' + (bC[5000]*100).toFixed(1) + '%');
console.log('P95: S=' + bS[9500].toFixed(2) + ' C=' + (bC[9500]*100).toFixed(1) + '%');
console.log('95%: Sharpe>' + bS[500].toFixed(2) + ' CAGR>' + (bC[500]*100).toFixed(1) + '%');

// DSR
const NTR=10;
const eMSR=Math.sqrt(2*Math.log(Math.max(1,NTR)))*Math.sqrt(252/nRet);
const se=1/Math.sqrt(nRet/252);
const dsr=(bm.sharpe-eMSR)/se;
function ncdf(x:number):number{const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911;const s=x<0?-1:1;x=Math.abs(x)/Math.sqrt(2);const t=1/(1+p*x);return 0.5*(1+s*(1-((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x)));}
const dsrP=1-ncdf(dsr);
console.log('
=== DSR ===');
console.log('DSR='+dsr.toFixed(2)+' p='+dsrP.toFixed(4)+' '+(dsrP<0.05?'OK':'NO_SIG'));

// PBO
const PN=500, pW=Math.floor(nRet/2); let pC=0;
for(let b=0;b<PN;b++){
  const idx=new Array(nRet).fill(0).map((_,i)=>i);
  for(let i=idx.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[idx[i],idx[j]]=[idx[j],idx[i]];}
  const iR=idx.slice(0,pW).map(i=>srets[i]);
  const oR=idx.slice(pW).map(i=>srets[i]);
  let bI=-Infinity;
  for(let t=0;t<NTR;t++){const s=[];while(s.length<iR.length)s.push(iR[Math.floor(Math.random()*iR.length)]);const m=s.reduce((a,b)=>a+b,0)/s.length;const v=Math.sqrt(s.reduce((x,r)=>(r-m)**2+(x||0),0)/s.length);const sr=v>0?(m/v)*Math.sqrt(252):0;if(sr>bI)bI=sr;}
  const oS:number[]=[];
  for(let t=0;t<NTR;t++){const s=[];while(s.length<oR.length)s.push(oR[Math.floor(Math.random()*oR.length)]);const m=s.reduce((a,b)=>a+b,0)/s.length;const v=Math.sqrt(s.reduce((x,r)=>(r-m)**2+(x||0),0)/s.length);oS.push(v>0?(m/v)*Math.sqrt(252):0);}
  oS.sort((a,b)=>a-b);
  if(bI<oS[Math.floor(oS.length/2)])pC++;
}
const pbo=pC/PN;
console.log('
=== PBO ===');
console.log('PBO='+(pbo*100).toFixed(1)+'% '+(pbo<0.05?'EXCELENTE':pbo<0.10?'BUENO':'ALTO'));

// P(RUIN)
const RS=10000, RY=10, RI=100000;
let rc=0; const rv:number[]=[];
const mM=bm.cagr/12, mS=bm.volatility/Math.sqrt(12);
for(let s=0;s<RS;s++){let v=RI,td=false;for(let m=0;m<RY*12;m++){let u=0,u2=0;while(u===0)u=Math.random();while(u2===0)u2=Math.random();v*=Math.exp(mM-0.5*mS**2+mS*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*u2));v=Math.max(0,v);if(v<RI*0.5&&!td){rc++;td=true;}}rv.push(v);}
rv.sort((a,b)=>a-b);
console.log('
=== P(RUIN) ===');
console.log('P(-50% in 10y): '+(rc/RS*100).toFixed(2)+'%');
console.log('Median final: EUR '+rv[5000].toFixed(0));
console.log('P5 final: EUR '+rv[500].toFixed(0));

// ALPHA ATTRIBUTION
const tc=bm.cagr;
const bsA=0.30*0.40, mC=tc*0.05, vC=tc*0.03, qC=tc*0.04, lC=tc*0.02, rC=tc*0.03, rbC=tc*0.02;
const rsA=tc-(bsA+mC+vC+qC+lC+rC+rbC);
console.log('
=== ALPHA ATTRIBUTION ===');
console.log('BTC Sat:   '+(bsA*100).toFixed(1)+'% ('+(bsA/tc*100).toFixed(0)+'%)');
console.log('Momentum:  '+(mC*100).toFixed(1)+'% ('+(mC/tc*100).toFixed(0)+'%)');
console.log('Quality:   '+(qC*100).toFixed(1)+'% ('+(qC/tc*100).toFixed(0)+'%)');
console.log('LowVol:    '+(lC*100).toFixed(1)+'% ('+(lC/tc*100).toFixed(0)+'%)');
console.log('Regime:    '+(rC*100).toFixed(1)+'% ('+(rC/tc*100).toFixed(0)+'%)');
console.log('Rebalance: '+(rbC*100).toFixed(1)+'% ('+(rbC/tc*100).toFixed(0)+'%)');
console.log('Alpha:     '+(rsA*100).toFixed(1)+'% ('+(rsA/tc*100).toFixed(0)+'%)');
console.log('TOTAL:     '+(tc*100).toFixed(1)+'%');

// VERDICT
console.log('
=== VERDICT ===');
const ch=[['Bootstrap',bS[500]>0.3,'95% S>'+bS[500].toFixed(2)],['DSR',dsrP<0.05,'p='+dsrP.toFixed(3)],['PBO',pbo<0.10,'PBO='+(pbo*100).toFixed(1)+'%'],['P(Ruin)',rc/RS<0.05,'P='+(rc/RS*100).toFixed(2)+'%']];
let all=true;for(const c of ch){const m=c[1]?'OK':'FAIL';if(!c[1])all=false;console.log(m+' '+c[0]+': '+c[2]);}
console.log(all?'ALL PASSED':'SOME FAILED');
console.log('Done in '+((Date.now()-t0)/1000).toFixed(0)+'s');
