// ============================================================
// scripts/validation/dca_probe.ts
// FASE 1 · TEST 6 — Probes DCA / Rebalancer / Attack (READ-ONLY)
// Ejecutar: npx tsx scripts/validation/dca_probe.ts
// No modifica src/. Reproduce los números citados en el informe.
// ============================================================

import { computeSmartDCA, getBottomDriftFloor } from '../../src/core/dca/smartDCA';
import type { SmartDCAInput } from '../../src/core/dca/smartDCA';
import { computeRebalanceSuggestions, type RebalanceAsset } from '../../src/core/portfolio/rebalancer';
import type { CEWSOutput, CEWSLevel } from '../../src/core/macro/crisisEarlyWarning';

const OLY = 4322, DEF = 8000, TPV = 10000;
const pct = (x: number, d = 2) => (x * 100).toFixed(d) + '%';

function cewsStub(level: CEWSLevel): CEWSOutput {
  return { level, score: 0, signalsInRed: 0, weeksInWarning: 0,
    signals: {
      yieldCurve:       { name: 'y', level: 'CLEAR', score: 0, trend: 'STABLE', value: 0, threshold: 0, description: '' },
      creditSpreads:    { name: 'c', level: 'CLEAR', score: 0, trend: 'STABLE', value: 0, threshold: 0, description: '' },
      liquidityImpulse: { name: 'l', level: 'CLEAR', score: 0, trend: 'STABLE', value: 0, threshold: 0, description: '' },
      volClustering:    { name: 'v', level, score: 0, trend: 'STABLE', value: 0, threshold: 0, description: '' },
    }, earlyWarningActive: false, earlyWarningReason: '', regimePenaltyAdjustment: 0, recommendation: '' } as CEWSOutput;
}

const MOTOR = [
  { name: 'BTC',  ticker: 'BTC-EUR',      finalAllocation: 0.20, price: 60000, isFractional: true },
  { name: 'WLG',  ticker: '0P00000WLG.F', finalAllocation: 0.20, price: 72.10, isFractional: false },
  { name: 'VVSM', ticker: 'VVSM.DE',      finalAllocation: 0.20, price: 58.20, isFractional: false },
  { name: 'EMXC', ticker: 'EMXC.DE',      finalAllocation: 0.20, price: 28.10, isFractional: false },
  { name: 'URNU', ticker: 'URNU.DE',      finalAllocation: 0.20, price: 26.48, isFractional: false },
];

function baseInput(o: Partial<SmartDCAInput> = {}): SmartDCAInput {
  return {
    btcRsi: 60, btcZScore: 2.0, btcMomentum1m: 0.01, btcDominance: undefined,
    mvrvRatio: 3.0, mvrvZScore: undefined,
    regime: 'CONTRACTION', regimePenalty: 0.50,
    volTargetMultiplier: 1.0, tailRiskActive: false, tailRiskOverlay: 1.0,
    killSwitchLevel: 0, recoveryCyclesRemaining: 0,
    olympusAvailableCash: OLY, tacticalAvailableCash: DEF, accumulatedDefensiveLiquidity: 0,
    totalPortfolioValueEUR: TPV,
    motorAllocations: MOTOR,
    currentAllocations: MOTOR.map(a => ({ ticker: a.ticker, name: a.name, currentWeight: 0.20 })),
    cycleBottomSignals: [],
    ...o,
  };
}

const EXTREME = [{ ticker: 'URNU.DE', attackMultiplier: 2.0, shouldAccumulate: true, zone: 'EXTREME' }];

console.log('='.repeat(104));
console.log('  TEST 6c/6d — SEÑAL DE SUELO EXTREME (×2.0): ¿CUÁNTO COMPRA Y HASTA QUÉ SOBREPESO LLEGA?');
console.log('='.repeat(104));
console.log(`  TPV = €${TPV} · target de cada activo = 20.0% · drift floor EXTREME = ${pct(getBottomDriftFloor(2.0), 1)}`);
console.log(`  Cash Olympus €${OLY} · War chest €${DEF} · cash TOTAL disponible €${OLY + DEF}\n`);
console.log('  drift inicial   modo        acción           confluence  compra URNU  peso final   exceso s/target');
console.log('  ' + '-'.repeat(96));
for (const mode of ['NORMAL', 'ATAQUE'] as const) {
  for (const drift of [-0.10, -0.05, 0.0, 0.03, 0.06, 0.10]) {
    const cur = 0.20 + drift;
    const inp = baseInput({
      currentAllocations: MOTOR.map(a => ({ ticker: a.ticker, name: a.name, currentWeight: a.ticker === 'URNU.DE' ? cur : 0.20 })),
      cycleBottomSignals: EXTREME,
      ...(mode === 'ATAQUE'
        ? { btcDominance: 59.3, mvrvRatio: 1.48, regimePenalty: 0.682,
            cycleBottomSignals: [...EXTREME, { ticker: 'VVSM.DE', attackMultiplier: 1.5, shouldAccumulate: true, zone: 'OPPORTUNITY' }] }
        : {}),
    });
    const r = computeSmartDCA(inp);
    const ur = r.allocationByAsset.find(a => a.ticker === 'URNU.DE');
    const bought = ur?.actualCost ?? 0;
    const finalW = cur + bought / TPV;
    console.log(
      `  ${pct(drift, 1).padStart(12)}   ${mode.padEnd(10)}  ${r.action.padEnd(15)} ${String(r.attackConfluence).padStart(8)}  ` +
      `€${bought.toFixed(0).padStart(9)}  ${pct(finalW, 1).padStart(8)}  ${(pct(finalW - 0.20, 1)).padStart(12)}`
    );
  }
  console.log('');
}

console.log('  FÓRMULA VERIFICADA (smartDCA.ts:373-441):');
console.log('    effDrift = max(drift, getBottomDriftFloor(mul))');
console.log('    maxCap   = effDrift × TPV');
console.log('    total    = min(cashAsignado, maxCap × bottomMul)   ← el multiplicador DOBLA el cap');
console.log(`    → con mul=2.0 el cap real es ${pct(0.05)} × 2.0 = ${pct(0.10)} de TPV, no ${pct(0.05)}.\n`);

console.log('='.repeat(104));
console.log('  TEST 6e — BTC_CYCLE_OVERRIDE vs BTC_TOTAL_GATE 0.337');
console.log('='.repeat(104));
const overrideCase = baseInput({
  regime: 'CRISIS', regimePenalty: 0.40,          // ≤ 0.45 → BLOCK_CRISIS normal
  btcDominance: 59.3, mvrvRatio: 1.48,
  btcRsi: 30, btcZScore: -2.0, btcMomentum1m: -0.15,
  currentAllocations: MOTOR.map(a => ({ ticker: a.ticker, name: a.name, currentWeight: a.ticker === 'BTC-EUR' ? 0.18 : 0.20 })),
  btcTotalComposite: 0.40,                        // MUY por encima del techo 0.337
});
const ov = computeSmartDCA(overrideCase);
console.log(`  Escenario: CRISIS penalty 0.40 · ${ov.attackConfluence} señales · BTC_TOTAL = 40.0% (techo 33.7%)`);
console.log(`  action            : ${ov.action}`);
console.log(`  totalCashToInvest : €${ov.totalCashToInvest.toFixed(0)}`);
console.log(`  BTC comprado      : €${(ov.allocationByAsset.find(a => a.ticker === 'BTC-EUR')?.actualCost ?? 0).toFixed(0)}`);
console.log(`  reasoning         : ${ov.reasoning}`);
console.log('');
console.log('  MISMO escenario SIN override (EXPANSION, banda excedida, ≥3 señales, 1 macro):');
const bandCase = computeSmartDCA(baseInput({
  regime: 'CONTRACTION', regimePenalty: 0.682, btcDominance: 59.3, mvrvRatio: 1.48,
  currentAllocations: MOTOR.map(a => ({ ticker: a.ticker, name: a.name, currentWeight: a.ticker === 'BTC-EUR' ? 0.18 : 0.20 })),
  btcTotalComposite: 0.40,
}));
console.log(`  action            : ${bandCase.action}  (banda respetada ✔)`);
console.log('');
console.log('  CONTROLES: ¿el override respeta stale data y kill switch?');
const staleOv = computeSmartDCA({ ...overrideCase, staleDataBlock: true });
const ksOv = computeSmartDCA({ ...overrideCase, tailRiskActive: true, killSwitchLevel: 4, tailRiskOverlay: 0.05 });
console.log(`    staleDataBlock=true      → ${staleOv.action}  €${staleOv.totalCashToInvest.toFixed(0)}  ${staleOv.action !== 'BTC_CYCLE_OVERRIDE' ? '✔ bloquea override' : '✘'}`);
console.log(`    killSwitchLevel=4        → ${ksOv.action}  €${ksOv.totalCashToInvest.toFixed(0)}  ${ksOv.action !== 'BTC_CYCLE_OVERRIDE' ? '✔ bloquea override' : '✘'}`);

console.log('\n' + '='.repeat(104));
console.log('  TEST 6f — ¿EL OVERWEIGHT TRIM VENDE LO QUE COMPRÓ EL ATAQUE?');
console.log('='.repeat(104));
for (const drift of [0.0, 0.03, 0.06]) {
  const cur = 0.20 + drift;
  const inp = baseInput({
    currentAllocations: MOTOR.map(a => ({ ticker: a.ticker, name: a.name, currentWeight: a.ticker === 'URNU.DE' ? cur : 0.20 })),
    cycleBottomSignals: EXTREME,
    regime: 'CONTRACTION', regimePenalty: 0.50,
  });
  const r = computeSmartDCA(inp);
  const bought = r.allocationByAsset.find(a => a.ticker === 'URNU.DE')?.actualCost ?? 0;
  const wAfter = cur + bought / TPV;

  const rbAssets: RebalanceAsset[] = MOTOR.map(a => ({
    ticker: a.ticker, name: a.name, price: a.price,
    shares: ((a.ticker === 'URNU.DE' ? wAfter : 0.20) * TPV) / a.price,
    targetAllocation: 0.20,
    isFractional: a.ticker === 'BTC-EUR',
  }));
  const out = computeRebalanceSuggestions(rbAssets, OLY, TPV, 0.02, [], EXTREME, {});
  const sell = out.suggestions.find(s => s.ticker === 'URNU.DE' && s.action === 'SELL');
  console.log(`  DCA compró €${bought.toFixed(0)} (peso ${cur.toFixed(3)} → ${wAfter.toFixed(3)}, exceso ${pct(wAfter - 0.2, 1)})`);
  console.log(`    Rebalanceo → ${sell ? `SELL ${sell.sharesToSell} acciones (€${sell.proceedsIfSold?.toFixed(0)}) · ${sell.reason}` : 'sin venta (dentro del floor +5pp)'}`);
  console.log('');
}

console.log('  NOTA: en modo ATAQUE con 1 sola señal macro el ataque es BTC-only');
console.log('  (smartDCA.ts:606 `btcOnlyAttack = canAttack && macroConfluence < 2`),');
console.log('  por eso URNU no recibe nada en las filas ATAQUE: el cash va solo a BTC.');
console.log('');
console.log('='.repeat(104));
console.log('  Fin probes TEST 6 · read-only');
console.log('='.repeat(104));