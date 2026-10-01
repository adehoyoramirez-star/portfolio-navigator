// ============================================================
// PHASE 13 INSTITUTIONAL — pins de los fixes de coherencia DCA/Attack
// ============================================================
// Origen: auditoría forense 01-oct-2026 (dashboard CONTRACTION ×0.682 +
// ATTACK_ENTRY consumiendo 39% de la liquidez total con 3 señales débiles
// y persistentes). Fixes pineados aquí:
//   FIX-PROBE-OFFBYONE       — 3/8 = PROBE [25%, 0%] (era código muerto)
//   FIX-REGIME-ATTACK-COUPLING — capital de ataque escala con regimePenalty
//   FIX-DEFENSIVE-GATE       — war chest solo en full attack (≥2 macro)
//   FIX-BTC-TOTAL-GATE       — sin BTC en ataque por encima de la banda
//   FIX-MUTEX-REBALANCE-DCA  — sin doble compra sobre el mismo gap
//   FIX-REGIME-TRANSITION    — "Régimen Mejorando" mide transición real
//   FIX-BUYFRACTION-CLARITY  — totalLiquidityFraction = % de TODA la liquidez

import { describe, test, expect } from "vitest";
import { computeSmartDCA, detectBottomConfluence } from "../core/dca/smartDCA";
import type { SmartDCAInput } from "../core/dca/smartDCA";
import type { CEWSOutput, CEWSLevel } from "../core/macro/crisisEarlyWarning";

// Stub CEWS tipado para activar señales macro sin construir el objeto completo.
// (smartDCA solo lee cewsOutput.level y cewsOutput.signals.volClustering)
function cewsStub(level: CEWSLevel, volTrend: "IMPROVING" | "STABLE" | "DETERIORATING"): CEWSOutput {
  return {
    level,
    score: 0, signalsInRed: 0, weeksInWarning: 0,
    signals: {
      yieldCurve:      { name: "y", level: "CLEAR", score: 0, trend: "STABLE", value: 0, threshold: 0, description: "" },
      creditSpreads:   { name: "c", level: "CLEAR", score: 0, trend: "STABLE", value: 0, threshold: 0, description: "" },
      liquidityImpulse:{ name: "l", level: "CLEAR", score: 0, trend: "STABLE", value: 0, threshold: 0, description: "" },
      volClustering:   { name: "v", level, score: 0, trend: volTrend, value: 0, threshold: 0, description: "" },
    },
    earlyWarningActive: false,
    earlyWarningReason: "",
    regimePenaltyAdjustment: 0,
    recommendation: "",
  } as CEWSOutput;
}

const OLY = 4322;
const DEF = 8000;
const COMB = OLY + DEF;

function baseInput(overrides: Partial<SmartDCAInput> = {}): SmartDCAInput {
  return {
    btcRsi: 60, btcZScore: 2.0, btcMomentum1m: 0.01,
    btcDominance: undefined, mvrvRatio: 3.0, mvrvZScore: undefined,
    regime: "CONTRACTION", regimePenalty: 0.50,
    volTargetMultiplier: 1.0, tailRiskActive: false, tailRiskOverlay: 1.0,
    killSwitchLevel: 0, recoveryCyclesRemaining: 0,
    olympusAvailableCash: OLY, tacticalAvailableCash: DEF,
    accumulatedDefensiveLiquidity: 0,
    motorAllocations: [
      { name: "BTC", ticker: "BTC-EUR", finalAllocation: 0.30, price: 68107 },
      { name: "WLG", ticker: "0P00000WLG.F", finalAllocation: 0.14, price: 72.10 },
      { name: "VVSM", ticker: "VVSM.DE", finalAllocation: 0.14, price: 58.20 },
      { name: "EMXC", ticker: "EMXC.DE", finalAllocation: 0.14, price: 28.10 },
      { name: "URNU", ticker: "URNU.DE", finalAllocation: 0.14, price: 4.44 },
      { name: "Gold", ticker: "PPFB.DE", finalAllocation: 0.14, price: 72.10 },
    ],
    currentAllocations: [
      { ticker: "BTC-EUR", name: "BTC", currentWeight: 0.30 },
      { ticker: "0P00000WLG.F", name: "WLG", currentWeight: 0.14 },
      { ticker: "VVSM.DE", name: "VVSM", currentWeight: 0.14 },
      { ticker: "EMXC.DE", name: "EMXC", currentWeight: 0.14 },
      { ticker: "URNU.DE", name: "URNU", currentWeight: 0.14 },
      { ticker: "PPFB.DE", name: "Gold", currentWeight: 0.14 },
    ],
    cycleBottomSignals: [],
    ...overrides,
  };
}

describe("PHASE 13 — FIX-PROBE-OFFBYONE: escalera explícita y exclusiva", () => {
  test("la escalera de confluencia es monótona y sin saltos patológicos", () => {
    // Escenario del dashboard 01-oct-2026: 3 señales débiles y persistentes
    const dashboard = baseInput({ btcDominance: 59.3, mvrvRatio: 1.48, regimePenalty: 0.682 });
    const signals = detectBottomConfluence(dashboard);
    const n = signals.filter(s => s.active).length;
    expect(n).toBe(3);
    const r3 = computeSmartDCA(dashboard);
    expect(r3.action).toBe("ATTACK_PROBE");
    // War chest INTACTA en probe (antes: €2.640 con el off-by-one)
    expect(r3.tacticalInvested).toBe(0);
    // 25% × 4322 × (0.682+0.15 = 0.832) = 898.98
    expect(r3.olympusInvested).toBeCloseTo(898.98, 2);
    // El despliegue total ya NO consume 39% de la liquidez — es ~7%
    expect(r3.totalLiquidityFraction).toBeLessThan(0.12);
  });

  test("transiciones de la escalera: 3=PROBE · 4=ENTRY · 5=STRONG · 6+=MAX", () => {
    // Misma base (penalty 0.682 → régimen mejora ON) + una señal por nivel.
    const core = { btcDominance: 59.3, mvrvRatio: 1.48, regimePenalty: 0.682 };
    const r3 = computeSmartDCA(baseInput(core));
    expect(r3.attackConfluence).toBe(3);
    expect(r3.action).toBe("ATTACK_PROBE");
    const r4 = computeSmartDCA(baseInput({ ...core, cycleBottomSignals: [{ ticker: "URNU.DE", attackMultiplier: 1.5, shouldAccumulate: true, zone: "OPPORTUNITY" }] }));
    expect(r4.attackConfluence).toBe(4);
    expect(r4.action).toBe("ATTACK_ENTRY");
    const r5 = computeSmartDCA(baseInput({ ...core, cycleBottomSignals: [{ ticker: "URNU.DE", attackMultiplier: 1.5, shouldAccumulate: true, zone: "OPPORTUNITY" }], btcMomentum1m: -0.12 }));
    expect(r5.attackConfluence).toBe(5);
    expect(r5.action).toBe("ATTACK_STRONG");
    const r6 = computeSmartDCA(baseInput({ ...core, cycleBottomSignals: [{ ticker: "URNU.DE", attackMultiplier: 1.5, shouldAccumulate: true, zone: "OPPORTUNITY" }], btcMomentum1m: -0.12, btcRsi: 30, btcZScore: -2.0 }));
    expect(r6.attackConfluence).toBe(6);
    expect(r6.action).toBe("ATTACK_MAX");
    // Monotonía del capital con régimen constante (scale 0.832 en todas)
    expect(r4.olympusInvested).toBeGreaterThan(r3.olympusInvested);
    expect(r5.olympusInvested).toBeGreaterThan(r4.olympusInvested);
    expect(r6.olympusInvested).toBeGreaterThanOrEqual(r5.olympusInvested);
  });
});

describe("PHASE 13 — FIX-REGIME-ATTACK-COUPLING: el régimen modula el volumen", () => {
  test("mismo tramo (ENTRY 4/8), distinto régimen → distinto capital (antes idéntico)", () => {
    const core = { btcDominance: 59.3, mvrvRatio: 1.48, cycleBottomSignals: [{ ticker: "URNU.DE", attackMultiplier: 1.5, shouldAccumulate: true, zone: "OPPORTUNITY" }] };
    // CONTRACTION 0.682: régimen mejora ON (0.682>0.55) → 4 señales → ENTRY; scale = 0.832
    const contra = computeSmartDCA(baseInput({ ...core, regimePenalty: 0.682 }));
    expect(contra.attackConfluence).toBe(4);
    expect(contra.olympusInvested).toBeCloseTo(OLY * 0.50 * 0.832, 1);
    // EXPANSION 1.0: régimen ON (1.0≥0.85) → 4 señales → ENTRY; scale = 1.0 (cap)
    const expansion = computeSmartDCA(baseInput({ ...core, regime: "EXPANSION", regimePenalty: 1.0 }));
    expect(expansion.olympusInvested).toBeCloseTo(OLY * 0.50 * 1.0, 1);
    expect(expansion.olympusInvested).toBeGreaterThan(contra.olympusInvested);
  });

  test("escala de régimen monótona en la banda operativa (0.56→0.85)", () => {
    // La banda operativa del attack es penalty ∈ (0.45, 1.0] — por debajo de
    // 0.45 el bloque BLOCK_CRISIS ya actúa (política preexistente). El FLOOR
    // 0.60 es defensa-en-profundidad: si el umbral de bloqueo bajara algún día,
    // el attack nunca desplegaría menos del 60% del tramo.
    const lo = computeSmartDCA(baseInput({ regimePenalty: 0.56, btcDominance: 59.3, mvrvRatio: 1.48 }));
    const hi = computeSmartDCA(baseInput({ regimePenalty: 0.85, btcDominance: 59.3, mvrvRatio: 1.48 }));
    expect(lo.attackConfluence).toBe(3); // régimen ON (0.56>0.55)
    expect(lo.olympusInvested).toBeCloseTo(OLY * 0.25 * 0.71, 1);  // 0.56+0.15
    expect(hi.olympusInvested).toBeCloseTo(OLY * 0.25 * 1.0, 1);   // 0.85+0.15 → cap
    expect(hi.olympusInvested).toBeGreaterThan(lo.olympusInvested);
  });
});

describe("PHASE 13 — FIX-DEFENSIVE-GATE: war chest solo en full attack", () => {
  test("7 señales BTC-only → táctico 0 (antes: 66-100% de la war chest)", () => {
    const r = computeSmartDCA(baseInput({
      btcRsi: 30, btcZScore: -2.0, btcMomentum1m: -0.15,
      btcDominance: 59.3, mvrvRatio: 1.48,
      // cycleBottom OPPORTUNITY para llegar a 7 (3 BTC + 1 per-asset… 4): añadimos 3 más vía BTC oversold+momentum+cycle
      cycleBottomSignals: [{ ticker: "URNU.DE", attackMultiplier: 1.5, shouldAccumulate: true, zone: "OPPORTUNITY" }],
    }));
    // Señales: BTC oversold + momentum + BTC.D + MVRV + cycle = 5, 0 macro → BTC-only
    expect(r.attackConfluence).toBeGreaterThanOrEqual(5);
    expect(r.tacticalInvested).toBe(0);
    expect(r.tacticalAccumulated).toBe(DEF);
  });

  test("full attack (≥2 macro) SÍ despliega la war chest", () => {
    const r = computeSmartDCA(baseInput({
      btcDominance: 59.3, mvrvRatio: 1.48,
      regime: "EXPANSION", regimePenalty: 0.90,
      cewsPreviousLevel: "WARNING" as CEWSLevel,
      cewsOutput: cewsStub("WATCH", "STABLE"),
      cycleBottomSignals: [{ ticker: "URNU.DE", attackMultiplier: 1.5, shouldAccumulate: true, zone: "OPPORTUNITY" }],
    }));
    // Señales: BTC.D + MVRV + cycle (3) + régimen + CEWS (2 macro) = 5 → full
    expect(r.attackConfluence).toBe(5);
    expect(r.tacticalInvested).toBeCloseTo(DEF * 0.66 * 1.0, 0); // STRONG, scale 1.0
  });
});

describe("PHASE 13 — FIX-BTC-TOTAL-GATE: banda auditada", () => {
  test("BTC-only attack con BTC_TOTAL ≥ 33.7% → WAIT, cash acumula", () => {
    const r = computeSmartDCA(baseInput({
      btcDominance: 59.3, mvrvRatio: 1.48, regimePenalty: 0.682, // 3 señales, 1 macro → BTC-only
      btcTotalComposite: 0.35, // sobre el techo de banda
    }));
    expect(r.action).toBe("WAIT");
    expect(r.totalCashToInvest).toBe(0);
    expect(r.tacticalAccumulated).toBe(DEF);
    expect(r.reasoning).toContain("banda");
  });

  test("full attack con banda excedida → BTC se salta, el resto sigue", () => {
    const r = computeSmartDCA(baseInput({
      btcDominance: 59.3, mvrvRatio: 1.48,
      regime: "EXPANSION", regimePenalty: 0.90,
      cewsPreviousLevel: "WARNING" as CEWSLevel,
      cewsOutput: cewsStub("WATCH", "STABLE"),
      cycleBottomSignals: [{ ticker: "URNU.DE", attackMultiplier: 1.5, shouldAccumulate: true, zone: "OPPORTUNITY" }],
      // BTC en peso → drift 0 → no compraría BTC de todas formas; el gate es defensa extra
      btcTotalComposite: 0.36,
    }));
    expect(r.attackConfluence).toBe(5);
    const btcBought = r.allocationByAsset.filter(a => a.ticker === "BTC-EUR" && a.actualCost > 0);
    expect(btcBought).toHaveLength(0);
    expect(r.totalCashToInvest).toBeGreaterThan(0); // el resto sí recibe
  });

  test("sin btcTotalComposite (undefined) → gate no aplica", () => {
    const r = computeSmartDCA(baseInput({ btcDominance: 59.3, mvrvRatio: 1.48, regimePenalty: 0.682 }));
    expect(r.action).toBe("ATTACK_PROBE");
  });
});

describe("PHASE 13 — FIX-MUTEX-REBALANCE-DCA", () => {
  test("ticker con BUY pendiente del rebalanceo no recibe ejecución DCA", () => {
    // FULL attack (4 señales, 2 macro: régimen + CEWS) para que el DCA toque
    // todos los activos (en PROBE BTC-only solo tocaría BTC). Drift real:
    // WLG/URNU/VVSM al 10% vs target 14%. URNU y VVSM tienen BUY ya pendiente
    // del rebalanceo → el DCA no debe ejecutarlos.
    const r = computeSmartDCA(baseInput({
      btcDominance: 59.3, mvrvRatio: 1.48, regimePenalty: 0.682,
      cewsPreviousLevel: "WARNING" as CEWSLevel,
      cewsOutput: cewsStub("WATCH", "STABLE"),
      currentAllocations: [
        { ticker: "BTC-EUR", name: "BTC", currentWeight: 0.30 },
        { ticker: "0P00000WLG.F", name: "WLG", currentWeight: 0.10 },
        { ticker: "VVSM.DE", name: "VVSM", currentWeight: 0.10 },
        { ticker: "EMXC.DE", name: "EMXC", currentWeight: 0.14 },
        { ticker: "URNU.DE", name: "URNU", currentWeight: 0.10 },
        { ticker: "PPFB.DE", name: "Gold", currentWeight: 0.14 },
      ],
      pendingRebalanceTickers: ["URNU.DE", "VVSM.DE"],
    }));
    expect(r.attackConfluence).toBe(4); // full attack → asigna a todos
    const urnu = r.allocationByAsset.find(a => a.ticker === "URNU.DE");
    const vvsm = r.allocationByAsset.find(a => a.ticker === "VVSM.DE");
    const wlg = r.allocationByAsset.find(a => a.ticker === "0P00000WLG.F");
    expect(urnu?.actualCost ?? 0).toBe(0);
    expect(vvsm?.actualCost ?? 0).toBe(0);
    expect(urnu?.reason).toContain("mutex");
    // Los NO pendientes siguen con ejecución normal
    expect((wlg?.actualCost ?? 0)).toBeGreaterThan(0);
    // El cash desplegado se recalcula (no desaparece silenciosamente)
    const deployed = r.allocationByAsset.reduce((s, a) => s + a.actualCost, 0);
    expect(r.totalCashToInvest).toBeCloseTo(deployed, 6);
  });
});

describe("PHASE 13.1 — FIX-MUTEX-V2: semántica de porción financiada del gap", () => {
  // Caso live 01-oct-2026: €3.900 en broker, COMPRA NORMAL (2/8), €0 desplegados
  // un mes. El mutex binario v1 prohibía al DCA los MISMOS tickers que el
  // panel de rebalanceo tenía SUGERIDOS (persistente toda la semana) → parálisis.
  // v2: el DCA solo puede aportar el REMANENTE del gap no financiado por el rebalanceo.
  const TPV = 100_000;

  test("gap 100% financiado por el rebalanceo → DCA aporta 0 y el cash se recalcula", () => {
    // Solo WLG infraponderado (drift 4pp = €4.000 de gap). El rebalanceo ya
    // financia los €4.000 → allowed = 0 → el DCA no añade nada.
    const r = computeSmartDCA(baseInput({
      totalPortfolioValueEUR: TPV,
      currentAllocations: [
        { ticker: "BTC-EUR", name: "BTC", currentWeight: 0.30 },
        { ticker: "0P00000WLG.F", name: "WLG", currentWeight: 0.10 },
        { ticker: "VVSM.DE", name: "VVSM", currentWeight: 0.14 },
        { ticker: "EMXC.DE", name: "EMXC", currentWeight: 0.14 },
        { ticker: "URNU.DE", name: "URNU", currentWeight: 0.14 },
        { ticker: "PPFB.DE", name: "Gold", currentWeight: 0.14 },
      ],
      pendingRebalanceBuys: [{ ticker: "0P00000WLG.F", cost: 4000 }],
    }));
    const wlg = r.allocationByAsset.find(a => a.ticker === "0P00000WLG.F");
    expect(wlg?.actualCost ?? 0).toBe(0);
    expect(wlg?.reason).toContain("gap ya cubierto por el rebalanceo");
    // Sin doble compra ⇒ el despliegue es 0 y el estado de liquidez es coherente
    expect(r.totalCashToInvest).toBe(0);
    expect(r.olympusInvested).toBe(0);
    expect(r.tacticalAccumulated).toBe(DEF);
  });

  test("gap parcialmente financiado → top-up solo del remanente", () => {
    // WLG drift 8pp = €8.000 de gap; el rebalanceo financia €7.500 → el DCA
    // solo puede aportar €500 → 6 acciones × €72,10 = €432,60.
    const r = computeSmartDCA(baseInput({
      totalPortfolioValueEUR: TPV,
      currentAllocations: [
        { ticker: "BTC-EUR", name: "BTC", currentWeight: 0.30 },
        { ticker: "0P00000WLG.F", name: "WLG", currentWeight: 0.06 },
        { ticker: "VVSM.DE", name: "VVSM", currentWeight: 0.14 },
        { ticker: "EMXC.DE", name: "EMXC", currentWeight: 0.14 },
        { ticker: "URNU.DE", name: "URNU", currentWeight: 0.14 },
        { ticker: "PPFB.DE", name: "Gold", currentWeight: 0.14 },
      ],
      pendingRebalanceBuys: [{ ticker: "0P00000WLG.F", cost: 7500 }],
    }));
    const wlg = r.allocationByAsset.find(a => a.ticker === "0P00000WLG.F");
    expect(wlg?.shares).toBe(6);
    expect(wlg?.actualCost).toBeCloseTo(432.60, 2);
    expect(wlg?.reason).toContain("top-up");
    // El despliegue reportado = lo realmente ejecutado (rescale conservador)
    const deployed = r.allocationByAsset.reduce((s, a) => s + a.actualCost, 0);
    expect(r.totalCashToInvest).toBeCloseTo(deployed, 6);
    expect(r.olympusInvested).toBeCloseTo(432.60, 1);
  });

  test("activo NO financiado por el rebalanceo → ejecución DCA normal (caso live)", () => {
    // Forma del caso real: WLG financiado por el rebalanceo (mutex), URNU no
    // financiado → el DCA SÍ compra URNU. Antes (v1) el mutex binario
    // prohibía TODOS los tickers sugeridos → €0 desplegados.
    const r = computeSmartDCA(baseInput({
      totalPortfolioValueEUR: TPV,
      currentAllocations: [
        { ticker: "BTC-EUR", name: "BTC", currentWeight: 0.30 },
        { ticker: "0P00000WLG.F", name: "WLG", currentWeight: 0.10 },
        { ticker: "VVSM.DE", name: "VVSM", currentWeight: 0.14 },
        { ticker: "EMXC.DE", name: "EMXC", currentWeight: 0.14 },
        { ticker: "URNU.DE", name: "URNU", currentWeight: 0.10 },
        { ticker: "PPFB.DE", name: "Gold", currentWeight: 0.14 },
      ],
      pendingRebalanceBuys: [{ ticker: "0P00000WLG.F", cost: 4000 }],
    }));
    const wlg = r.allocationByAsset.find(a => a.ticker === "0P00000WLG.F");
    const urnu = r.allocationByAsset.find(a => a.ticker === "URNU.DE");
    expect(wlg?.actualCost ?? 0).toBe(0);
    expect(wlg?.reason).toContain("mutex");
    // URNU: prorrateo 648,30 → 146 acciones × €4,44 = €648,24
    expect(urnu?.actualCost).toBeCloseTo(648.24, 2);
    // El DCA ya NO queda paralizado: despliega lo del activo no financiado
    expect(r.totalCashToInvest).toBeCloseTo(648.24, 2);
    expect(r.olympusInvested).toBeGreaterThan(0);
  });

  test("pendingRebalanceBuys presente → precede al mutex binario legacy", () => {
    // El dashboard pasa AMBOS arrays (misma fuente). Con mapa v2 no vacío,
    // el set de exclusión sale de SUS claves: VVSM (solo en legacy) opera normal.
    const r = computeSmartDCA(baseInput({
      totalPortfolioValueEUR: TPV,
      currentAllocations: [
        { ticker: "BTC-EUR", name: "BTC", currentWeight: 0.30 },
        { ticker: "0P00000WLG.F", name: "WLG", currentWeight: 0.10 },
        { ticker: "VVSM.DE", name: "VVSM", currentWeight: 0.10 },
        { ticker: "EMXC.DE", name: "EMXC", currentWeight: 0.14 },
        { ticker: "URNU.DE", name: "URNU", currentWeight: 0.14 },
        { ticker: "PPFB.DE", name: "Gold", currentWeight: 0.14 },
      ],
      pendingRebalanceBuys: [{ ticker: "0P00000WLG.F", cost: 4000 }],
      pendingRebalanceTickers: ["VVSM.DE"],
    }));
    const wlg = r.allocationByAsset.find(a => a.ticker === "0P00000WLG.F");
    const vvsm = r.allocationByAsset.find(a => a.ticker === "VVSM.DE");
    // WLG 100% financiado → 0 (v2)
    expect(wlg?.actualCost ?? 0).toBe(0);
    // VVSM solo estaba en el legacy → NO se prohíbe (11 × €58,20 = €640,20)
    expect(vvsm?.actualCost).toBeCloseTo(640.20, 2);
  });
});

describe("PHASE 13 — FIX-REGIME-TRANSITION: señal mide transición real", () => {
  test("CONTRACTION→CONTRACTION (persistencia) ya NO cuenta como mejorando", () => {
    const sig = detectBottomConfluence(baseInput({
      regime: "CONTRACTION", regimePenalty: 0.682, previousRegime: "CONTRACTION",
    }));
    const regime = sig.find(s => s.name === "Régimen Mejorando");
    expect(regime?.active).toBe(false);
  });

  test("CRISIS→CONTRACTION SÍ cuenta (transición real)", () => {
    const sig = detectBottomConfluence(baseInput({
      regime: "CONTRACTION", regimePenalty: 0.682, previousRegime: "CRISIS",
    }));
    const regime = sig.find(s => s.name === "Régimen Mejorando");
    expect(regime?.active).toBe(true);
  });

  test("sin previousRegime → fallback legacy (compatibilidad)", () => {
    const sig = detectBottomConfluence(baseInput({
      regime: "CONTRACTION", regimePenalty: 0.682, previousRegime: undefined,
    }));
    const regime = sig.find(s => s.name === "Régimen Mejorando");
    expect(regime?.active).toBe(true);
  });
});

describe("PHASE 13 — FIX-BUYFRACTION-CLARITY", () => {
  test("totalLiquidityFraction es % de TODA la liquidez (broker + defensiva)", () => {
    const r = computeSmartDCA(baseInput({ btcDominance: 59.3, mvrvRatio: 1.48, regimePenalty: 0.682 }));
    expect(r.totalLiquidityFraction).toBeCloseTo(r.totalCashToInvest / COMB, 6);
    // buyFraction sigue siendo % del broker solo (convención histórica)
    expect(r.buyFraction).toBeCloseTo(r.olympusInvested / OLY, 6);
  });
});
