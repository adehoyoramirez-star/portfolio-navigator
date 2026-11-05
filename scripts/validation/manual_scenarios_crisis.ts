import { runOlympusEngine, type AssetInput } from '../../src/core/engine/olympusV3';
const TICKERS = ['BTC-EUR', 'EMXC.DE', 'PPFB.DE', 'URNU.DE', 'VVSM.DE', '0P00000WLG.F'];
const VOLS = [0.72, 0.22, 0.15, 0.35, 0.28, 0.16];
const assets = (): AssetInput[] => TICKERS.map((t, i) => ({ name: t, ticker: t,
  returns12m: [0.45,0.06,0.12,0.20,0.10,0.09][i], returns3m: [0.08,0.02,0.03,0.05,0.02,0.02][i],
  returns1m: [0.02,0.01,0.01,0.02,0.01,0.01][i], earningsYield: [0,0.05,0,0.02,0.04,0.05][i], volatility: VOLS[i] }));
const cov = (c = 0.3) => VOLS.map((vi,i)=>VOLS.map((vj,j)=> i===j ? vi*vi : c*vi*vj));
const CALM = { vix: 16, yieldSpread: 0.8, creditSpread: 2.5, move: 90, dxyTrend: 0, btcVol: 0.5, m2Growth: 3, wtiOil: 70 };
function run(label: string, macro: any, extra: any = {}) {
  const o = runOlympusEngine({ assets: assets(), correlationMatrix: cov(0.3), macro: { ...CALM, ...macro },
    covMatrix: cov(0.3), portfolioDrawdown: 0, portfolioRealizedVol: 0.15, bypassHysteresis: true, ...extra } as any);
  const w = (n: string) => ((o.allocations.find(a => a.name === n)?.finalAllocation ?? 0) * 100).toFixed(1);
  const st = o.masterRegime.stressDetail;
  return `${label.padEnd(34)} ${o.regime.padEnd(11)} pen ${o.masterRegime.regimePenalty.toFixed(3)} stress ${String(st.score).padStart(4)} KS${String(o.killSwitchLevel).padEnd(2)} VT ${o.volTargetMultiplier.toFixed(2)} tail ${o.tailRiskOverlay.toFixed(2)} exp ${(o.totalInvested*100).toFixed(0).padStart(3)}% WLG ${w('0P00000WLG.F')}% VVSM ${w('VVSM.DE')}% BTC ${w('BTC-EUR')}%`;
}
console.log('='.repeat(140));
console.log('  CREDIT / ERP / CRISIS COMBINADA');
console.log('='.repeat(140));
for (const [l, m, e] of [
  ['credit 6.0 solo', { creditSpread: 6.0 }, {}],
  ['credit 6.0 + VIX 45', { creditSpread: 6.0, vix: 45 }, {}],
  ['credit 6.0 + VIX 45 + M2 -2', { creditSpread: 6.0, vix: 45, m2Growth: -2 }, {}],
  ['ERP 3% (calma)', {}, { erpValue: 0.03 }],
  ['ERP 0.4%', {}, { erpValue: 0.004 }],
  ['ERP -1%', {}, { erpValue: -0.01 }],
  ['ERP 0.4% + VIX 45', { vix: 45 }, { erpValue: 0.004 }],
  ['CRISIS PACK', { vix: 45, creditSpread: 6.0, yieldSpread: -1.0, m2Growth: -2, wtiOil: 120, btcVol: 0.9, move: 160 }, { erpValue: -0.01 }],
  ['CRISIS PACK + DD -15%', { vix: 45, creditSpread: 6.0, yieldSpread: -1.0, m2Growth: -2, wtiOil: 120, btcVol: 0.9, move: 160 }, { erpValue: -0.01, portfolioDrawdown: -0.15 }],
  ['CRISIS PACK + DD -25% + corr 0.9', { vix: 45, creditSpread: 6.0, yieldSpread: -1.0, m2Growth: -2, wtiOil: 120, btcVol: 0.9, move: 160 }, { erpValue: -0.01, portfolioDrawdown: -0.25, avgCorrelation: 0.90 }],
  ['TODO LO MALO + vol 50%', { vix: 45, creditSpread: 6.0, yieldSpread: -1.0, m2Growth: -2, wtiOil: 120, btcVol: 0.9, move: 160 }, { erpValue: -0.01, portfolioDrawdown: -0.25, avgCorrelation: 0.90, portfolioRealizedVol: 0.50 }],
] as [string, any, any][]) console.log('  ' + run(l, m, e));
