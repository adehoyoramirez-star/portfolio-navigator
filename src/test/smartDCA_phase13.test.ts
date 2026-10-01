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
//   FIX-MUTEX-V3             — "un hueco, un euro" por capas: DCA semanal →
//                              rebalanceo mensual (sin candado por sugerencia)
//   FIX-REGIME-TRANSITION    — "Régimen Mejorando" mide transición real
//   FIX-BUYFRACTION-CLARITY  — totalLiquidityFraction = % de TODA la liquidez

import { describe, test, expect } from "vitest";
import { computeSmartDCA, detectBottomConfluence } from "../core/dca/smartDCA";
import type { SmartDCAInput } from "../core/dca/smartDCA";
import { computeRebalanceSuggestions, type RebalanceAsset } from "../core/portfolio/rebalancer";
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

describe("PHASE 13.2 — FIX-MUTEX-V3: \"un hueco, un euro\" por capas (DCA semanal → rebalanceo mensual)", () => {
  // Caso live 01-oct-2026: €3.900 en el bróker, COMPRA NORMAL, €0 desplegados un
  // mes. Causa raíz: el candado v1/v2 se activaba con las SUGERENCIAS del panel de
  // rebalanceo (persistentes todo el ciclo) → con cadencia MENSUAL (rebalanceo) +
  // SEMANAL (DCA) bloqueaba hasta 4 tranches semanales seguidas.
  // Regla nueva: la exclusión mutua NO depende de una sugerencia (intención) sino
  // del ESTADO (pesos + cash operativo), que se actualiza al confirmar cada
  // ejecución. Reparto por capas:
  //   1ª capa (semanal) → Smart DCA despliega su tranche por drift, sin veto.
  //   2ª capa (mensual) → el rebalanceo recibe dcaCommitted y cierra el remanente.
  //   Invariante: gap_i = dca_i + buy_i  ·  Σdca + Σbuy ≤ cash.

  test("1ª capa: el DCA despliega su tranche aunque el rebalanceo tenga BUYs pendientes (sin veto)", () => {
    const r = computeSmartDCA(baseInput({
      olympusAvailableCash: 3900,
      currentAllocations: [
        { ticker: "BTC-EUR", name: "BTC", currentWeight: 0.30 },
        { ticker: "0P00000WLG.F", name: "WLG", currentWeight: 0.10 },
        { ticker: "VVSM.DE", name: "VVSM", currentWeight: 0.14 },
        { ticker: "EMXC.DE", name: "EMXC", currentWeight: 0.10 },
        { ticker: "URNU.DE", name: "URNU", currentWeight: 0.10 },
        { ticker: "PPFB.DE", name: "Gold", currentWeight: 0.14 },
      ],
    }));
    expect(r.action).toBe("BUY");
    expect(r.totalCashToInvest).toBeGreaterThan(0);
    // Los MISMOS tickers que sugiere el rebalanceo (los huecos) SÍ reciben DCA
    for (const t of ["0P00000WLG.F", "EMXC.DE", "URNU.DE"]) {
      const row = r.allocationByAsset.find(a => a.ticker === t);
      expect(row?.actualCost ?? 0).toBeGreaterThan(0);
    }
    // Nunca se despliega más que el cash operativo disponible
    expect(r.totalCashToInvest).toBeLessThanOrEqual(3900);
  });

  // ── 2ª capa (mensual): el rebalanceo cierra el REMANENTE del hueco ──
  const NAV = 10_000;
  const uranio = (shares = 0): RebalanceAsset => ({
    ticker: "URNU.DE", name: "Uranium", price: 10, shares, targetAllocation: 0.10,
  });

  test("2ª capa: hueco 100% cubierto por el DCA → el rebalanceo no emite BUY", () => {
    // Déficit URNU = 0,10·(10.000+2.000) − 0 = €1.200. El DCA ya compromete €1.200.
    const out = computeRebalanceSuggestions(
      [uranio()], 2_000, NAV, 0.02, [], [], { "URNU.DE": 1_200 }
    );
    expect(out.buySuggestions).toHaveLength(0);
    expect(out.totalCost).toBe(0);
  });

  test("2ª capa: hueco parcialmente cubierto → compra exactamente el remanente", () => {
    const out = computeRebalanceSuggestions(
      [uranio()], 2_000, NAV, 0.02, [], [], { "URNU.DE": 500 }
    );
    expect(out.buySuggestions).toHaveLength(1);
    expect(out.buySuggestions[0].cost).toBeCloseTo(700, 6); // 1.200 − 500
    expect(out.buySuggestions[0].sharesToBuy).toBe(70);
  });

  test("2ª capa: invariante \"un hueco, un euro\" — gap = dca + buy", () => {
    const DCA_COMMITTED = 500;
    const gap = 0.10 * (NAV + 2_000); // 1.200
    const out = computeRebalanceSuggestions(
      [uranio()], 2_000, NAV, 0.02, [], [], { "URNU.DE": DCA_COMMITTED }
    );
    expect(DCA_COMMITTED + out.totalCost).toBeCloseTo(gap, 6);
  });

  test("2ª capa: el presupuesto de cash se reduce por lo comprometido por el DCA", () => {
    const a = { ticker: "A.DE", name: "A", price: 10, shares: 0, targetAllocation: 0.10 };
    const b = { ticker: "B.DE", name: "B", price: 10, shares: 0, targetAllocation: 0.10 };
    const CASH = 1_000;
    const sinNeteo = computeRebalanceSuggestions([a, b], CASH, NAV, 0.02, [], []);
    const conNeteo = computeRebalanceSuggestions([a, b], CASH, NAV, 0.02, [], [], { "A.DE": 600 });
    // Sin neteo el rebalanceo agota el pool de €1.000…
    expect(sinNeteo.totalCost).toBeGreaterThan(0);
    // …con neteo solo dispone del remanente (el resto lo despliega la capa semanal).
    expect(conNeteo.totalCost).toBeLessThanOrEqual(CASH - 600 + 1e-6);
    expect(600 + conNeteo.totalCost).toBeLessThanOrEqual(CASH + 1e-6);
  });

  test("2ª capa: matching exchange-agnostic (WLG ≈ 0P00000WLG.F)", () => {
    const wlg: RebalanceAsset = {
      ticker: "0P00000WLG.F", name: "WLG", price: 10, shares: 0, targetAllocation: 0.10,
    };
    const out = computeRebalanceSuggestions([wlg], 2_000, NAV, 0.02, [], [], { WLG: 2_000 });
    expect(out.buySuggestions).toHaveLength(0);
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
