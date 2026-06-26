// ===============================================================
// simulate-spacex-crash.ts
// SpaceX IPO + Crash: ¿qué capas de protección del Olympus V5 se activan?
// Ejecutar: npx tsx simulate-spacex-crash.ts
// ===============================================================

import { runOlympusEngine, AssetInput, EngineOutput } from './src/core/engine/olympusV3';

// ── ASSETS (7 activos) ─────────────────────────────────────────────
const NAMES   = ['Bitcoin','Emerging Markets','Gold (ETC)','Uranium','Semiconductors','Vanguard Global Stock'];
const TICKERS = ['BTC-EUR','EMXC.DE','PPFB.DE','URNU.DE','VVSM.DE','0P00000WLG.F'];
const VOLS = [0.60,0.18,0.15,0.35,0.25,0.16];

function makeCorrMatrix(level: number): number[][] {
  // level = 0: normal, 1: high stress, 2: panic
  const BASE = [
    [1.00,0.15,0.05,0.10,0.30,0.15],
    [0.15,1.00,0.10,0.15,0.40,0.65],
    [0.10,0.15,0.05,1.00,0.20,0.15],
    [0.30,0.40,0.05,0.20,1.00,0.50],
    [0.15,0.65,0.05,0.15,0.50,1.00],
  ];
  const stress = level === 0 ? 1 : level === 1 ? 1.15 : 1.30;
  return BASE.map(row => row.map((v, i) => Math.min(0.99, v * stress + (i === 0 ? 0 : 0))));
}

function makeAssets(ret12m: number[]): AssetInput[] {
  return NAMES.map((name, i) => ({
    name,
    ticker: TICKERS[i],
    returns12m: ret12m[i],
    returns3m: ret12m[i] * 0.25,
    returns1m: ret12m[i] * 0.08,
    earningsYield: i < 2 ? 0.03 : i === 2 ? 0.055 : i === 5 ? 0.035 : 0,
    volatility: VOLS[i],
  }));
}

function avgCorrelation(corr: number[][]): number {
  let sum = 0, count = 0;
  for (let i = 0; i < corr.length; i++) {
    for (let j = i+1; j < corr.length; j++) {
      sum += corr[i][j];
      count++;
    }
  }
  return sum / count;
}

// ── 3 ESCENARIOS ─────────────────────────────────────────────────
interface Scenario {
  name: string;
  description: string;
  assets: AssetInput[];
  corrMatrix: number[][];
  vix: number;
  creditSpread: number;
  yieldSpread: number;
  m2Growth: number;
  btcVol: number;
  dxyTrend: number;
  moveIndex: number;
  wtiOil: number;
  drawdown: number;
  realizedVol: number;
  erpValue: number;
  avgCorr: number;
  btcOnChain: { mvrvRatio: number; puellMultiple: number; rsiWeekly: number };
}

const SCENARIOS: Scenario[] = [];

// ── ESCENARIO 1: BASE (condiciones actuales, abril 2026) ──────────
{
  const ret12m = [0.45,0.08,0.15,0.05,0.10,0.10];
  const corr = makeCorrMatrix(0);
  SCENARIOS.push({
    name: '🏁 BASE — Condiciones actuales (Abril 2026)',
    description: 'VIX 18, credit spreads normales, M2 estable, régimen EXPANSION. Sin triggers activos.',
    assets: makeAssets(ret12m),
    corrMatrix: corr,
    vix: 18, creditSpread: 2.5, yieldSpread: 0.40, m2Growth: 5.2,
    btcVol: 0.55, dxyTrend: 103, moveIndex: 95, wtiOil: 75,
    drawdown: -0.011, realizedVol: 0.175,
    erpValue: 0.035, avgCorr: avgCorrelation(corr),
    btcOnChain: { mvrvRatio: 2.8, puellMultiple: 1.2, rsiWeekly: 58 },
  });
}

// ── ESCENARIO 2: SPACEX IPO EUPHORIA ─────────────────────────────
{
  const ret12m = [0.75,0.18,0.10,0.12,0.25,0.20]; // todo sube con euforia
  const corr = makeCorrMatrix(0); // correlaciones normales (todo sube)
  SCENARIOS.push({
    name: '🚀 SPACEX IPO — Euforia post-salida a bolsa',
    description: 'VIX 12 (complacencia), M2 7%, ERP 1.5% (comprimido), credit spreads 1.8%. FOMO generalizado.',
    assets: makeAssets(ret12m),
    corrMatrix: corr,
    vix: 12, creditSpread: 1.8, yieldSpread: 0.60, m2Growth: 7.0,
    btcVol: 0.40, dxyTrend: 101, moveIndex: 75, wtiOil: 82,
    drawdown: 0, realizedVol: 0.145,
    erpValue: 0.015, // ERP comprimido < 2.5% → trigger!
    avgCorr: 0.42,
    btcOnChain: { mvrvRatio: 3.6, puellMultiple: 2.5, rsiWeekly: 72 },
  });
}

// ── ESCENARIO 3: SPACEX CRASH (post-euforia) ─────────────────────
{
  // Cripto cae más por ser risk-on, quality resiste mejor, gold sube
  const ret12m = [-0.25,-0.18,0.05,-0.22,-0.15,-0.15];
  const corr = makeCorrMatrix(2); // panic: todas las correlaciones suben
  SCENARIOS.push({
    name: '💥 SPACEX CRASH — Corrección severa post-IPO',
    description: 'VIX 38, credit spreads 5.5%, yield spread -0.30% (invertida). Drawdown -22%. Todas las capas de protección activas.',
    assets: makeAssets(ret12m),
    corrMatrix: corr,
    vix: 38, creditSpread: 5.5, yieldSpread: -0.30, m2Growth: -1.0,
    btcVol: 0.85, dxyTrend: 108, moveIndex: 145, wtiOil: 62,
    drawdown: -0.22, realizedVol: 0.35,
    erpValue: -0.005, // ERP negativo = peligro extremo
    avgCorr: avgCorrelation(corr), // > 0.85 → correlation panic
    btcOnChain: { mvrvRatio: 1.5, puellMultiple: 0.3, rsiWeekly: 25 },
  });
}

// ── EJECUTAR MOTOR PARA CADA ESCENARIO ───────────────────────────
function showResult(label: string, result: EngineOutput): void {
  const m = result.meta;
  console.log(`\n  ─── ${label} ───`);
  console.log(`  Régimen:        ${result.regime}`);
  console.log(`  Penalty:        ${result.masterRegime.regimePenalty.toFixed(3)}`);
  console.log(`  Total invertido: ${(result.totalInvested * 100).toFixed(1)}%`);
  console.log(`  Tail Risk:       ${result.tailRiskActive ? '⚠️ ACTIVO' : '✅ Inactivo'} (overlay ${result.tailRiskOverlay.toFixed(3)})`);
  console.log(`  Kill Switch L${result.killSwitchLevel}: ${result.killSwitchName}`);
  console.log(`  Vol Target:      ${result.volTargetMultiplier.toFixed(3)}`);
  console.log(`  Core Signal:     ${result.coreSignal.finalScore.toFixed(3)}`);
  console.log(`  ERP Trigger:     ${m.erpTriggered ? '⚠️ ERP='+(m.erpValue*100).toFixed(1)+'% (CAP 60%)' : '✅ ERP='+(m.erpValue*100).toFixed(1)+'%'}`);
  console.log(`  Corr Panic:      ${m.correlationPanicTriggered ? '⚠️ Corr='+(m.avgCorrelationValue*100).toFixed(0)+'% (CAP 50%)' : '✅ Corr='+(m.avgCorrelationValue*100).toFixed(0)+'%'}`);
  console.log(`  CEWS:            ${result.masterRegime.cews?.level ?? 'N/A'}`);
  console.log(`  BTC Signal:      ${result.btcCycle?.signal ?? 'N/A'} (score ${result.btcCycle?.btcScore.toFixed(2)})`);
  console.log(`  Alpha-Boost:     ${result.totalInvested >= 0.95 ? '🚀 ACTIVO (95%+)' : '❌ No activo'}`);
  console.log(`  Allocations:`);
  for (const a of result.allocations) {
    const pct = (a.finalAllocation * 100).toFixed(1);
    const er = (a.expectedReturn * 100).toFixed(1);
    if (parseFloat(pct) > 0.1) {
      console.log(`    ${a.name.padEnd(25)} ${pct}%  (ER ${er}%)`);
    }
  }
  console.log(`  Cash implícito:  ${((1 - result.totalInvested) * 100).toFixed(1)}%`);
}

console.log('='.repeat(72));
console.log('🧪 SIMULACIÓN: SPACE X IPO + CRASH');
console.log('Motor: ' + runOlympusEngine.length + ' parámetros');
console.log('='.repeat(72));

for (const s of SCENARIOS) {
  console.log('\n' + '─'.repeat(72));
  console.log(s.name);
  console.log('  ' + s.description);
  console.log('─'.repeat(72));
  
  const result = runOlympusEngine({
    assets: s.assets,
    correlationMatrix: s.corrMatrix,
    covMatrix: s.corrMatrix.map(row => row.map((r, j) => r * VOLS[0] * VOLS[j])), // crude cov from corr
    macro: {
      vix: s.vix,
      yieldSpread: s.yieldSpread,
      creditSpread: s.creditSpread,
      move: s.moveIndex,
      dxyTrend: s.dxyTrend,
      btcVol: s.btcVol,
      m2Growth: s.m2Growth,
      wtiOil: s.wtiOil,
    },
    portfolioDrawdown: s.drawdown,
    portfolioRealizedVol: s.realizedVol,
    erpValue: s.erpValue,
    avgCorrelation: s.avgCorr,
    btcOnChain: s.btcOnChain,
    liquidityGrowth: s.m2Growth,
    totalPortfolioValue: 10000,
    availableCash: 500,
  });
  
  showResult('RESULTADOS', result);
}

console.log('\n' + '='.repeat(72));
