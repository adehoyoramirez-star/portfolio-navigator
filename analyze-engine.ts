// analyze-engine.ts - Diagnostic: Which layers are reducing CAGR?
// Run: npx tsx analyze-engine.ts

import { runOlympusEngine } from './src/core/engine/olympusV3';

const TICKERS = ['BTC-EUR','EMXC.DE','PPFB.DE','URNU.DE','VVSM.DE','0P00000WLG.F'];
const ASSET_NAMES = ['Bitcoin','Emerging Markets','Gold (ETC)','Uranium','Semiconductors','Vanguard Global Stock'];
const VOLS = [0.60,0.18,0.15,0.35,0.25,0.16];

function makeCorr(base: number, stress: number): number[][] {
  const m = [
    [1.00,0.15,0.05,0.10,0.30,0.15],
    [0.15,1.00,0.10,0.15,0.40,0.65],
    [0.10,0.15,0.05,1.00,0.20,0.15],
    [0.30,0.40,0.05,0.20,1.00,0.50],
    [0.15,0.65,0.05,0.15,0.50,1.00],
  ];
  if (stress <= 0) return m;
  return m.map((row, i) => row.map((v, j) => {
    if (i === j) return 1.0;
    return Math.min(0.99, v + (1 - v) * stress);
  }));
}

// Current conditions (CONTRACTION)
console.log('\n=== CONDICIONES ACTUALES (CONTRACTION) ===');
let result = runOlympusEngine({
  assets: ASSET_NAMES.map((name, i) => ({
    name, ticker: TICKERS[i], returns12m: 0.12, returns3m: 0.03, returns1m: 0.01,
    earningsYield: 0.04, volatility: VOLS[i],
  })),
  correlationMatrix: makeCorr(0.5, 0),
  macro: { vix: 18, yieldSpread: -0.1, creditSpread: 2.1, move: 95, dxyTrend: 0.02, btcVol: 0.55, m2Growth: 3.5 },
  portfolioDrawdown: -0.011,
  portfolioRealizedVol: 0.15,
  erpValue: 0.035,
  avgCorrelation: 0.30,
  liquidityGrowth: 3.5,
  totalPortfolioValue: 10000,
  availableCash: 500,
});

console.log(`Régimen: ${result.regime}`);
console.log(`Regime Penalty: ${result.masterRegime.regimePenalty.toFixed(3)}`);
console.log(`Vol Target Multiplier: ${result.volTargetMultiplier.toFixed(3)}`);
console.log(`Tail Risk Overlay: ${result.tailRiskOverlay.toFixed(3)}`);
console.log(`Tail Risk Active: ${result.tailRiskActive} (${result.tailRiskReason})`);
console.log(`Kill Switch: L${result.killSwitchLevel} - ${result.killSwitchName}`);
console.log(`ERP Triggered: ${result.meta.erpTriggered} (ERP: ${(result.meta.erpValue*100).toFixed(1)}%)`);
console.log(`Correlation Panic: ${result.meta.correlationPanicTriggered} (avg: ${(result.meta.avgCorrelationValue*100).toFixed(0)}%)`);
console.log(`Core Signal Score: ${result.coreSignal.finalScore.toFixed(3)}`);
console.log(`Alpha-Boost Active: ${result.meta.allCash === false && result.totalInvested > 0.90}`);
console.log(`Total Invested: ${(result.totalInvested*100).toFixed(1)}%`);
console.log('Allocations:');
result.allocations.forEach(a => {
  console.log(`  ${a.name.padEnd(25)} ${(a.finalAllocation*100).toFixed(1)}%  (kelly:${(a.kellyFraction*100).toFixed(1)}% ret:${(a.expectedReturn*100).toFixed(1)}%)`);
});

// Scenario 2: EXPANSION regime (ideal conditions)
console.log('\n=== ESCENARIO: EXPANSION IDEAL ===');
result = runOlympusEngine({
  assets: ASSET_NAMES.map((name, i) => ({
    name, ticker: TICKERS[i], returns12m: 0.18, returns3m: 0.06, returns1m: 0.02,
    earningsYield: 0.05, volatility: VOLS[i],
  })),
  correlationMatrix: makeCorr(0.5, 0),
  macro: { vix: 12, yieldSpread: 0.2, creditSpread: 1.5, move: 85, dxyTrend: -0.01, btcVol: 0.40, m2Growth: 5.5 },
  portfolioDrawdown: 0,
  portfolioRealizedVol: 0.12,
  erpValue: 0.04,
  avgCorrelation: 0.25,
  liquidityGrowth: 5.5,
  btcOnChain: { mvrvRatio: 2.0, puellMultiple: 1.5, rsiWeekly: 55 },
  totalPortfolioValue: 10000,
  availableCash: 500,
});

console.log(`Régimen: ${result.regime}`);
console.log(`Regime Penalty: ${result.masterRegime.regimePenalty.toFixed(3)}`);
console.log(`Vol Target: ${result.volTargetMultiplier.toFixed(3)}`);
console.log(`Tail Risk: ${result.tailRiskOverlay.toFixed(3)}`);
console.log(`ERP Triggered: ${result.meta.erpTriggered}`);
console.log(`Total Invested: ${(result.totalInvested*100).toFixed(1)}%`);
console.log(`BTC Cycle Signal: ${result.btcCycle?.signal}`);
console.log('Allocations:');
result.allocations.forEach(a => {
  console.log(`  ${a.name.padEnd(25)} ${(a.finalAllocation*100).toFixed(1)}%`);
});

// Scenario 3: Stress test - what causes max reduction?
console.log('\n=== ESTRÉS: Múltiples capas activas ===');
result = runOlympusEngine({
  assets: ASSET_NAMES.map((name, i) => ({
    name, ticker: TICKERS[i], returns12m: -0.08, returns3m: -0.05, returns1m: -0.03,
    earningsYield: 0.03, volatility: VOLS[i],
  })),
  correlationMatrix: makeCorr(0.5, 0.6), // high stress corr
  macro: { vix: 32, yieldSpread: -1.0, creditSpread: 4.5, move: 130, dxyTrend: 0.05, btcVol: 0.80, m2Growth: -1.0 },
  portfolioDrawdown: -0.18,
  portfolioRealizedVol: 0.30,
  erpValue: -0.005,
  avgCorrelation: 0.75,
  liquidityGrowth: -1.0,
  totalPortfolioValue: 10000,
  availableCash: 500,
});

console.log(`Régimen: ${result.regime}`);
console.log(`Regime Penalty: ${result.masterRegime.regimePenalty.toFixed(3)}`);
console.log(`Vol Target: ${result.volTargetMultiplier.toFixed(3)}`);
console.log(`Tail Risk: ${result.tailRiskOverlay.toFixed(3)}`);
console.log(`Kill Switch: L${result.killSwitchLevel} - ${result.killSwitchName}`);
console.log(`ERP Triggered: ${result.meta.erpTriggered} (ERP: ${(result.meta.erpValue*100).toFixed(1)}%)`);
console.log(`Correlation Panic: ${result.meta.correlationPanicTriggered}`);
console.log(`Total Invested: ${(result.totalInvested*100).toFixed(1)}%`);

// DIAGNOSTIC: Which layer is the biggest CAGR killer?
console.log('\n========================================');
console.log('📊 DIAGNÓSTICO: ¿Qué capa mata el CAGR?');
console.log('========================================');
console.log('\nCapa 1: Regime Penalty (solo) =', result.masterRegime.regimePenalty.toFixed(3));
console.log('Capa 2: Vol Target (sobre regime) = multiplica por', result.volTargetMultiplier.toFixed(3));
console.log('Capa 3: Tail/Kill (sobre lo anterior) = multiplica por', result.tailRiskOverlay.toFixed(3));
console.log('Capa 4: ERP Trigger =', result.meta.erpTriggered ? 'ACTIVO (cap 60% o 35%)' : 'INACTIVO');
console.log('Capa 5: Correlation Panic =', result.meta.correlationPanicTriggered ? 'ACTIVO' : 'INACTIVO');
