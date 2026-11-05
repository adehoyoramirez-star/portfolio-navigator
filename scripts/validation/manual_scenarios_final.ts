// ============================================================
// scripts/validation/manual_scenarios_final.ts
// Packs de datos manuales verificados contra motor + detectores.
// Solo lectura: no modifica src/.
// ============================================================
import { runOlympusEngine, type AssetInput } from '../../src/core/engine/olympusV3';
import { detectCycleTops, detectCycleBottoms, type CycleTopInputs } from '../../src/core/risk/cycleTopDetector';

const TICKERS = ['BTC-EUR', 'EMXC.DE', 'PPFB.DE', 'URNU.DE', 'VVSM.DE', '0P00000WLG.F'];
const VOLS = [0.72, 0.22, 0.15, 0.35, 0.28, 0.16];
const assets = (): AssetInput[] => TICKERS.map((t, i) => ({
  name: t, ticker: t,
  returns12m: [0.45, 0.06, 0.12, 0.20, 0.10, 0.09][i],
  returns3m: [0.08, 0.02, 0.03, 0.05, 0.02, 0.02][i],
  returns1m: [0.02, 0.01, 0.01, 0.02, 0.01, 0.01][i],
  earningsYield: [0, 0.05, 0, 0.02, 0.04, 0.05][i],
  volatility: VOLS[i],
}));
const cov = (c = 0.3): number[][] => VOLS.map((vi, i) => VOLS.map((vj, j) => (i === j ? vi * vi : c * vi * vj)));
const CALM = { vix: 16, yieldSpread: 0.8, creditSpread: 2.5, move: 90, dxyTrend: 0, btcVol: 0.5, m2Growth: 3, wtiOil: 70 };

type Extra = Record<string, unknown>;
function run(label: string, macro: Partial<typeof CALM>, extra: Extra = {}) {
  const o = runOlympusEngine({
    assets: assets(), correlationMatrix: cov(0.3), macro: { ...CALM, ...macro },
    covMatrix: cov(0.3), portfolioDrawdown: 0, portfolioRealizedVol: 0.15,
    bypassHysteresis: true, ...extra,
  } as Parameters<typeof runOlympusEngine>[0]);
  const btc = o.allocations.find(a => a.name === 'BTC-EUR')?.finalAllocation ?? 0;
  return `${label.padEnd(30)} ${o.regime.padEnd(11)} pen ${o.masterRegime.regimePenalty.toFixed(3)} KS${String(o.killSwitchLevel).padEnd(2)} VT ${o.volTargetMultiplier.toFixed(2)} tail ${o.tailRiskOverlay.toFixed(2)}${o.tailRiskActive ? '*' : ' '} exp ${(o.totalInvested * 100).toFixed(0).padStart(3)}% BTC ${(btc * 100).toFixed(1)}%`;
}

console.log('='.repeat(120));
console.log('  CAPAS DEL MOTOR — un input macro por fila (el resto en CALM: VIX 16, credit 2.5, M2 3, yieldSpread 0.8, oil 70)');
console.log('='.repeat(120));
const rows: [string, Partial<typeof CALM>, Extra?][] = [
  ['BASE calma', {}, {}],
  ['VIX 22', { vix: 22 }],
  ['VIX 26', { vix: 26 }],
  ['VIX 30', { vix: 30 }],
  ['VIX 36', { vix: 36 }],
  ['VIX 45', { vix: 45 }],
  ['credit 3.0', { creditSpread: 3.0 }],
  ['credit 3.5', { creditSpread: 3.5 }],
  ['credit 4.5', { creditSpread: 4.5 }],
  ['credit 6.0', { creditSpread: 6.0 }],
  ['yieldSpread 0', { yieldSpread: 0 }],
  ['yieldSpread -0.5 (invertida)', { yieldSpread: -0.5 }],
  ['yieldSpread -1.0', { yieldSpread: -1.0 }],
  ['M2 +8', { m2Growth: 8 }],
  ['M2 +1', { m2Growth: 1 }],
  ['M2 0', { m2Growth: 0 }],
  ['M2 -2', { m2Growth: -2 }],
  ['petroleo 100', { wtiOil: 100 }],
  ['petroleo 120', { wtiOil: 120 }],
  ['BTC vol 90%', { btcVol: 0.9 }],
  ['DD -10%', {}, { portfolioDrawdown: -0.10 }],
  ['DD -12% (L1)', {}, { portfolioDrawdown: -0.12 }],
  ['DD -13.5% (L1.5)', {}, { portfolioDrawdown: -0.135 }],
  ['DD -15% (L2)', {}, { portfolioDrawdown: -0.15 }],
  ['DD -20% (L3)', {}, { portfolioDrawdown: -0.20 }],
  ['DD -25% (L4)', {}, { portfolioDrawdown: -0.25 }],
  ['DD -33% (L5)', {}, { portfolioDrawdown: -0.33 }],
  ['vol 20%', {}, { portfolioRealizedVol: 0.20 }],
  ['vol 26%', {}, { portfolioRealizedVol: 0.26 }],
  ['vol 35%', {}, { portfolioRealizedVol: 0.35 }],
  ['vol 50%', {}, { portfolioRealizedVol: 0.50 }],
  ['correlacion 0.86', {}, { avgCorrelation: 0.86 }],
  ['correlacion 0.96', {}, { avgCorrelation: 0.96 }],
  ['ERP 2.0%', {}, { erpValue: 0.020 }],
  ['ERP 0.4%', {}, { erpValue: 0.004 }],
  ['ERP -1%', {}, { erpValue: -0.010 }],
];
for (const [l, m, e] of rows) console.log('  ' + run(l, m, e));

console.log('\n' + '='.repeat(120));
console.log('  PACKS DE CICLO — techos y suelos combinados (detectores reales)');
console.log('='.repeat(120));
const B: CycleTopInputs = { bondYield10y: 4.2 };
const packs: [string, CycleTopInputs][] = [
  ['MELT-UP extremo', { ...B, mvrvZScore: 8.5, puellMultiple: 4.5, btcRsiWeekly: 88, uraniumSpotPrice: 60, uraniumLTPrice: 100, siaSalesYoY: 55, soxRsiWeekly: 86, wlgPERatio: 30, wlgRsiWeekly: 86, emxcRsiWeekly: 86, emxcPERatio: 26, dxy: 118, realYield10y: 2.5, goldCbPurchases: 1200 }],
  ['Techo suave', { ...B, mvrvRatio: 4.5, wlgPERatio: 20, wlgRsiWeekly: 78, emxcRsiWeekly: 80, dxy: 106 }],
  ['CAPITULACION total', { ...B, mvrvRatio: 1.4, btcRsiWeekly: 25, uraniumSpotPrice: 55, uraniumLTPrice: 100, siaSalesYoY: -30, soxRsiWeekly: 30, wlgPERatio: 12, wlgRsiWeekly: 40, emxcPERatio: 8, emxcRsiWeekly: 25, dxy: 118, realYield10y: 2.5 }],
  ['Suelo moderado', { ...B, mvrvRatio: 2.0, btcRsiWeekly: 32, uraniumSpotPrice: 75, uraniumLTPrice: 100, siaSalesYoY: -10, soxRsiWeekly: 38, wlgPERatio: 14, wlgRsiWeekly: 45, emxcPERatio: 11, emxcRsiWeekly: 33, dxy: 108, realYield10y: 2.2 }],
];
for (const [name, inp] of packs) {
  const tops = detectCycleTops(inp).signals;
  const bots = detectCycleBottoms(inp, tops).signals;
  console.log('\n  ' + name);
  for (const t of tops) {
    const b = bots.find(x => x.ticker === t.ticker)!;
    console.log(`    ${t.ticker.padEnd(14)} TOP ${t.zone.padEnd(8)} mult ${t.allocationMultiplier.toFixed(2)} trim ${String(t.trimPct).padStart(3)}%  |  BOTTOM ${b.zone.padEnd(11)} score ${String(b.opportunityScore).padStart(3)} x${b.attackMultiplier.toFixed(2)}`);
  }
}
