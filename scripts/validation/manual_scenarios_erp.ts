import { runOlympusEngine, type AssetInput } from '../../src/core/engine/olympusV3';
const TICKERS = ['BTC-EUR','EMXC.DE','PPFB.DE','URNU.DE','VVSM.DE','0P00000WLG.F'];
const VOLS=[0.72,0.22,0.15,0.35,0.28,0.16];
const assets=():AssetInput[]=>TICKERS.map((t,i)=>({name:t,ticker:t,returns12m:[0.45,0.06,0.12,0.20,0.10,0.09][i],returns3m:[0.08,0.02,0.03,0.05,0.02,0.02][i],returns1m:[0.02,0.01,0.01,0.02,0.01,0.01][i],earningsYield:[0,0.05,0,0.02,0.04,0.05][i],volatility:VOLS[i]}));
const cov=(c=0.3)=>VOLS.map((vi,i)=>VOLS.map((vj,j)=>i===j?vi*vi:c*vi*vj));
const CALM={vix:16,yieldSpread:0.8,creditSpread:2.5,move:90,dxyTrend:0,btcVol:0.5,m2Growth:3,wtiOil:70};
function run(l:string,m:any,e:any={}){const o=runOlympusEngine({assets:assets(),correlationMatrix:cov(0.3),macro:{...CALM,...m},covMatrix:cov(0.3),portfolioDrawdown:0,portfolioRealizedVol:0.15,bypassHysteresis:true,...e} as any);
const meta:any=o.meta;return `${l.padEnd(36)} ${o.regime.padEnd(11)} exp ${(o.totalInvested*100).toFixed(0).padStart(3)}% ERP trig ${String(meta.erpTriggered).padEnd(5)} capFactor ${meta.erpCapFactor} WLG ${((o.allocations.find(a=>a.name==='0P00000WLG.F')?.finalAllocation??0)*100).toFixed(1)}%`;}
for(const [l,m,e] of [
 ['VIX 40 (CONTRACTION) sin ERP',{vix:40},{}],
 ['VIX 40 + ERP 2.0%',{vix:40},{erpValue:0.020}],
 ['VIX 40 + ERP 0.4% (critical)',{vix:40},{erpValue:0.004}],
 ['VIX 40 + ERP -1%',{vix:40},{erpValue:-0.010}],
 ['VIX 16 + ERP -1%',{}, {erpValue:-0.010}],
 ['VIX 16 + ERP -3% (critical)',{}, {erpValue:-0.030}],
] as [string,any,any][]) console.log('  '+run(l,m,e));
