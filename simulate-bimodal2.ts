// simulate-bimodal2.ts - Validar FIX-BIMODAL sin ERP trigger
// Run: npx tsx simulate-bimodal2.ts

import { runOlympusEngine } from './src/core/engine/olympusV3';

const TICKERS = ['BTC-EUR','EMXC.DE','PPFB.DE','URNU.DE','VVSM.DE','0P00000WLG.F'];
const NAMES   = ['Bitcoin','Emerging Markets','Gold (ETC)','Uranium','Semiconductors','Vanguard Global Stock'];
const VOLS = [0.60,0.18,0.15,0.35,0.25,0.16];

function makeCorr(): number[][] {
  return [
    [1.00,0.15,0.05,0.10,0.30,0.15],
    [0.15,1.00,0.10,0.15,0.40,0.65],
    [0.10,0.15,0.05,1.00,0.20,0.15],
    [0.30,0.40,0.05,0.20,1.00,0.50],
    [0.15,0.65,0.05,0.15,0.50,1.00],
  ];
}

function makeAssets(returns12m: number[]) {
  return TICKERS.map((t, i) => ({
    name: NAMES[i],
    ticker: t,
    returns12m: returns12m[i],
    returns3m: returns12m[i] * 0.3,
    returns1m: returns12m[i] * 0.1,
    earningsYield: [0, 0.05, 0.04, 0, 0.02, 0.03, 0.03, 0.05][i],
    volatility: VOLS[i],
  }));
}

function runScenario(label: string, macro: any, returns: number[], btcCycle?: any) {
  const assets = makeAssets(returns);
  const corr = makeCorr();
  const result = runOlympusEngine({
    assets,
    correlationMatrix: corr,
    macro,
    erpValue: 0.04,  // 4% ERP — saludable, sin trigger
    totalPortfolioValue: 10000,
    availableCash: 5000,
    avgCorrelation: 0.35,
    portfolioRealizedVol: 0.18,
  });

  console.log(`\n=== ${label} ===`);
  console.log(`Regime: ${result.regime}`);
  console.log(`RegimePenalty: ${result.masterRegime.regimePenalty.toFixed(3)}`);
  console.log(`TotalInvested: ${(result.totalInvested * 100).toFixed(1)}%`);
  console.log(`VolTarget: ${result.volTargetMultiplier.toFixed(3)}`);
  console.log(`KillSwitch: L${result.killSwitchLevel}`);
  console.log(`ERP Triggered: ${result.meta.erpTriggered}`);
  console.log(`\nAllocations:`);
  const growth = ['Bitcoin','Semiconductors','Uranium'];
  const defensive = ['Vanguard Global Stock','Gold (ETC)'];
  let gSum = 0, dSum = 0;
  result.allocations.forEach(a => {
    console.log(`  ${a.name.padEnd(22)} ${(a.finalAllocation * 100).toFixed(2)}%`);
    if (growth.includes(a.name)) gSum += a.finalAllocation;
    if (defensive.includes(a.name)) dSum += a.finalAllocation;
  });
  console.log(`  ---`);
  console.log(`  Growth (BTC+NASDAQ+Semis): ${(gSum * 100).toFixed(1)}%`);
  console.log(`  Defensive (Quality+Gold):  ${(dSum * 100).toFixed(1)}%`);
  const diff = gSum - dSum;
  console.log(`  Spread Growth-Defensive: ${(diff * 100).toFixed(1)}% ${diff > 0 ? '🟢 GROWTH' : '🔵 DEFENSIVE'}`);
}

// Scenario 1: EXPANSION
runScenario('EXPANSION - Bull Market', {
  vix: 14, yieldSpread: 1.5, creditSpread: 1.5,
  move: 60, dxyTrend: -0.5, btcVol: 0.40, m2Growth: 5.0,
}, [0.60,0.25,0.12,0.10,0.40,0.15], {
  mvrvRatio: 2.0, puellMultiple: 0.8, rsiWeekly: 70,
});

// Scenario 2: CONTRACTION
runScenario('CONTRACTION - Mixed', {
  vix: 22, yieldSpread: 0.3, creditSpread: 2.8,
  move: 80, dxyTrend: 0.3, btcVol: 0.50, m2Growth: 2.5,
}, [0.15,0.08,0.10,0.03,-0.05,0.06], {
  mvrvRatio: 1.5, puellMultiple: 0.6, rsiWeekly: 45,
});

// Scenario 3: CRISIS
runScenario('CRISIS - Market Crash', {
  vix: 45, yieldSpread: -1.2, creditSpread: 6.0,
  move: 120, dxyTrend: 2.0, btcVol: 0.80, m2Growth: -3.0,
}, [-0.40,-0.25,0.05,-0.30,-0.35,-0.20], {
  mvrvRatio: 0.9, puellMultiple: 0.3, rsiWeekly: 25,
});

console.log('\n✅ FIX-BIMODAL simulation complete');
