import { describe, test, expect } from "vitest";
import {
  computeSmartDCA,
  detectBottomConfluence,
  buildAllocations,
  getKillSwitchDcaScale,
  getBottomDriftFloor,
  type SmartDCAInput,
} from "../core/dca/smartDCA";

// ---- Helpers ----
function baseInput(overrides: Partial<SmartDCAInput> = {}): SmartDCAInput {
  return {
    btcRsi: 50, btcZScore: 0, btcMomentum1m: 0,
    btcDominance: 50, mvrvRatio: 2.0,
    regime: "EXPANSION", regimePenalty: 0.80,
    volTargetMultiplier: 1.0,
    tailRiskActive: false, tailRiskOverlay: 1.0,
    killSwitchLevel: 0, recoveryCyclesRemaining: 0,
    olympusAvailableCash: 1000, tacticalAvailableCash: 500,
    accumulatedDefensiveLiquidity: 0,
    motorAllocations: [
      { name: "Bitcoin", ticker: "BTC-EUR", finalAllocation: 0.20, price: 60000 },
      { name: "MSCI World", ticker: "0P00000WLG.F", finalAllocation: 0.30, price: 75 },
      { name: "Uranio", ticker: "URNU.DE", finalAllocation: 0.05, price: 28 },
      { name: "E.M.", ticker: "EMXC.DE", finalAllocation: 0.10, price: 30 },
      { name: "Gold", ticker: "PPFB.DE", finalAllocation: 0.15, price: 70 },
      { name: "Value", ticker: "VVSM.DE", finalAllocation: 0.10, price: 55 },
    ],
    ...overrides,
  };
}

const assets3 = [
  { ticker: "BTC-EUR", name: "Bitcoin", finalAllocation: 0.20, price: 60000 },
  { ticker: "0P00000WLG.F", name: "MSCI World", finalAllocation: 0.30, price: 75 },
  { ticker: "URNU.DE", name: "Uranio", finalAllocation: 0.05, price: 28 },
];

// ── 1. KILL SWITCH DCA SCALE ──────────────────────────────────────────
describe("getKillSwitchDcaScale", () => {
  test("L0 (off) -> 1.0", () => expect(getKillSwitchDcaScale(0, 1.0)).toBe(1.0));
  test("L1 overlay=0.80 -> 0.80", () => expect(getKillSwitchDcaScale(1, 0.80)).toBe(0.80));
  test("L1 overlay=0.15 -> floor 0.25", () => expect(getKillSwitchDcaScale(1, 0.15)).toBe(0.25));
  test("L2 overlay=0.50 -> 0.50", () => expect(getKillSwitchDcaScale(2, 0.50)).toBe(0.50));
  test("L2 overlay=0.10 -> floor 0.25", () => expect(getKillSwitchDcaScale(2, 0.10)).toBe(0.25));
  test("L3 overlay=0.35 -> 0.35", () => expect(getKillSwitchDcaScale(3, 0.35)).toBe(0.35));
  test("L3 overlay=0.10 -> floor 0.25", () => expect(getKillSwitchDcaScale(3, 0.10)).toBe(0.25));
  test("L4 -> 0 (total block)", () => expect(getKillSwitchDcaScale(4, 0.80)).toBe(0));
  test("L5 -> 0 (total block)", () => expect(getKillSwitchDcaScale(5, 0.50)).toBe(0));
  test("L4 overlay=0.01 -> 0", () => expect(getKillSwitchDcaScale(4, 0.01)).toBe(0));
});

// ── 2. BOTTOM DRIFT FLOOR ────────────────────────────────────────────
describe("getBottomDriftFloor", () => {
  test("1.0 (normal) -> 0", () => expect(getBottomDriftFloor(1.0)).toBe(0));
  test("0.75 (no signal) -> 0", () => expect(getBottomDriftFloor(0.75)).toBe(0));
  test("1.25 (VALUE) -> 0.015 (1.5pp)", () => expect(getBottomDriftFloor(1.25)).toBe(0.015));
  test("1.5 (OPPORTUNITY) -> 0.030 (3pp)", () => expect(getBottomDriftFloor(1.5)).toBe(0.030));
  test("1.75 (OPPORTUNITY) -> 0.030 (3pp)", () => expect(getBottomDriftFloor(1.75)).toBe(0.030));
  test("2.0 (EXTREME) -> 0.050 (5pp)", () => expect(getBottomDriftFloor(2.0)).toBe(0.050));
  test("3.0 (EXTREME) -> 0.050 (5pp)", () => expect(getBottomDriftFloor(3.0)).toBe(0.050));
  test("1.1 (VALUE borderline) -> 0.015", () => expect(getBottomDriftFloor(1.1)).toBe(0.015));
});

// ── 3. DETECT BOTTOM CONFLUENCE ──────────────────────────────────────
describe("detectBottomConfluence", () => {
  test("sin senales -> 0 activas", () => {
    const r = detectBottomConfluence(baseInput());
    expect(r.filter((s: any) => s.active).length).toBe(0);
  });

  test("BTC oversold + BTC.D + MVRV + momentum -> 4 activas", () => {
    const r = detectBottomConfluence(baseInput({
      btcRsi: 30, btcZScore: -2.0, btcDominance: 60, mvrvRatio: 1.4,
      btcMomentum1m: -0.15,
    }));
    expect(r.filter((s: any) => s.active).length).toBe(4);
  });

  test("mvrvZScore primario sobre ratio bruto", () => {
    const r = detectBottomConfluence(baseInput({ mvrvZScore: 0.5, mvrvRatio: 3.5 }));
    const mvrv = r[6]; // "MVRV Zona de Valor"
    expect(mvrv.active).toBe(true);
  });

  test("mvrvZScore=2.0 -> NO activo (Z > 1.0 threshold)", () => {
    const r = detectBottomConfluence(baseInput({ mvrvZScore: 2.0 }));
    const mvrv = r[6];
    expect(mvrv.active).toBe(false);
  });

  test("regime CONTRACTION + penalty > 0.55 -> macro activa", () => {
    const r = detectBottomConfluence(baseInput({ regime: "CONTRACTION", regimePenalty: 0.70 }));
    const reg = r[2]; // "Regimen Mejorando"
    expect(reg.active).toBe(true);
  });

  test("cycleBottomSignals EXTREME -> senal #8 activa", () => {
    const r = detectBottomConfluence(baseInput({
      cycleBottomSignals: [{ ticker: "BTC-EUR", attackMultiplier: 2.0, shouldAccumulate: true, zone: "EXTREME" }],
    }));
    const bottom = r[7]; // "Cycle Bottom"
    expect(bottom.active).toBe(true);
    expect(bottom.description).toContain("EXTREME");
  });

  test("cycleBottomSignals VALUE only -> NO activa #8", () => {
    const r = detectBottomConfluence(baseInput({
      cycleBottomSignals: [{ ticker: "PPFB.DE", attackMultiplier: 1.25, shouldAccumulate: true, zone: "VALUE" }],
    }));
    const bottom = r[7];
    expect(bottom.active).toBe(false);
    expect(bottom.description).toContain("VALUE");
  });

  test("todas las senales juntas -> 8/8", () => {
    const r = detectBottomConfluence(baseInput({
      btcRsi: 30, btcZScore: -2.0, btcMomentum1m: -0.15,
      btcDominance: 60, mvrvRatio: 1.2,
      regime: "CONTRACTION", regimePenalty: 0.70,
      cewsOutput: {
        level: "CLEAR", score: 4, signalsInRed: 2, weeksInWarning: 2,
        signals: {
          yieldCurve: { name: "Yield Curve", level: "CLEAR", score: 0, trend: "STABLE", value: 1.2, threshold: 0.5, description: "" },
          creditSpreads: { name: "Credit Spreads", level: "WATCH", score: 2, trend: "STABLE", value: 2.5, threshold: 2.0, description: "" },
          liquidityImpulse: { name: "Liquidity", level: "WATCH", score: 2, trend: "IMPROVING", value: 2.0, threshold: 3.0, description: "" },
          volClustering: { name: "VIX", level: "CLEAR", score: 0, trend: "IMPROVING", value: 18, threshold: 22, description: "" },
        },
        earlyWarningActive: false, earlyWarningReason: "", regimePenaltyAdjustment: -0.05, recommendation: "",
      } as any,
      cewsPreviousLevel: "ALERT" as any,
      cycleBottomSignals: [{ ticker: "BTC-EUR", attackMultiplier: 2.0, shouldAccumulate: true, zone: "EXTREME" }],
    }));
    expect(r.filter((s: any) => s.active).length).toBe(8);
  });
});

// ── 4. BUILD ALLOCATIONS ─────────────────────────────────────────────
describe("buildAllocations con cycleBottomSignals", () => {
  test("sin bottom signals -> prorrateo normal por drift", () => {
    const a = buildAllocations(300, assets3, "DCA:", new Set(), new Map(), false, 0, new Map());
    const nonSkip = a.filter((x: any) => !x.skipped);
    expect(nonSkip.length).toBeGreaterThan(0);
    expect(a[0].reason).toContain("DCA:");
  });

  test("BTC EXTREME bottom -> bottomMul=2.0 se aplica", () => {
    const bm = new Map<string, number>([["BTC-EUR", 2.0]]);
    const a = buildAllocations(300, assets3, "DCA:", new Set(), new Map(), false, 0, bm);
    const btc = a[0];
    expect(btc.skipped).toBe(false);
    expect(btc.cashToInvest).toBeGreaterThan(0);
  });

  test("skipTickers excluye activos -> solo 2 elegibles", () => {
    const skip = new Set<string>(["BTC-EUR"]);
    const a = buildAllocations(300, assets3, "DCA:", skip, new Map(), false, 0, new Map());
    // BTC-EUR filtered from eligible -> 2 assets returned
    expect(a.length).toBe(2);
  });

  test("totalCash=0 -> array vacio", () => {
    const a = buildAllocations(0, assets3, "DCA:", new Set(), new Map(), false, 0, new Map());
    expect(a.length).toBe(0);
  });

  test("drift-aware: solo infraponderados aparecen en resultado", () => {
    const ca = new Map<string, number>([["BTC-EUR", 0.15], ["0P00000WLG.F", 0.35]]);
    const a = buildAllocations(300, assets3, "DCA:", new Set(), ca, false, 0, new Map());
    // BTC: drift 0.05pp > -0.02 -> eligible, skipped=false
    // WLG: drift -0.05pp <= -0.02 -> filtered from eligible, NOT in result
    expect(a.length).toBe(2); // BTC-EUR + URNU (no currentWeight, drift=0.05)
    expect(a.find((x: any) => x.ticker === "0P00000WLG.F")).toBeUndefined();
  });

  test("totalPortfolioValueEUR cap -> no excede drift * portfolio", () => {
    const a = buildAllocations(2000, assets3, "DCA:", new Set(), new Map(), false, 7000, new Map());
    const btc = a[0];
    // BTC target 20%, sin posicion actual -> drift 20pp. Cap: 0.20 * 7000 = 1400.
    // Sin bottom signal: 300 cash prorrateado. Con cap: max 1400.
    expect(btc.cashToInvest).toBeLessThanOrEqual(1400);
  });
});

// ── 5. RECOVERY CYCLES ───────────────────────────────────────────────
describe("Recovery cycles en computeSmartDCA", () => {
  test("recoveryCycles=4 con tailRisk L2 -> DCA acelerado", () => {
    const r = computeSmartDCA(baseInput({
      tailRiskActive: true, tailRiskOverlay: 0.50, killSwitchLevel: 2,
      recoveryCyclesRemaining: 4,
    }));
    expect(r.action).toBe("BUY");
    expect(r.totalCashToInvest).toBeGreaterThan(0);
    // ksScale = 0.50, recovery x2 = 1.0 cap. DCA normal 30% * 1000 * 1.0 = 300
    expect(r.olympusInvested).toBe(300);
  });

  test("recoveryCycles=0 sin tailRisk -> DCA normal", () => {
    const r = computeSmartDCA(baseInput({ recoveryCyclesRemaining: 0 }));
    expect(r.olympusInvested).toBe(300);
  });

  test("recoveryCycles=4 sin tailRisk -> sin efecto extra", () => {
    const r = computeSmartDCA(baseInput({ recoveryCyclesRemaining: 4 }));
    expect(r.olympusInvested).toBe(300);
  });

  test("recoveryCycles=4 con tailRisk L2 -> olympus escalado correctamente", () => {
    // ksScale L2 = 0.50, recovery x2 = 1.0 min(1.0, 0.5*2) = 1.0
    // DCA normal: 1000 * 0.30 * 1.0 = 300
    const r = computeSmartDCA(baseInput({
      tailRiskActive: true, tailRiskOverlay: 0.50, killSwitchLevel: 2,
      recoveryCyclesRemaining: 4,
    }));
    expect(r.action).toBe("BUY");
    expect(r.olympusInvested).toBe(300);
    expect(r.reasoning).toContain("recuperación");
  });
});

// ── 6. CYCLE BOTTOM EN COMPUTESMARTDCA ──────────────────────────────
describe("cycleBottom en computeSmartDCA", () => {
  test("bottom EXTREME + cycleTop -> DCA no se asfixia", () => {
    const r = computeSmartDCA(baseInput({
      cycleTopSignals: [{ ticker: "0P00000WLG.F", shouldTrim: true, zone: "CAUTION" }],
      cycleBottomSignals: [{ ticker: "BTC-EUR", attackMultiplier: 2.0, shouldAccumulate: true, zone: "EXTREME" }],
      currentAllocations: [{ ticker: "0P00000WLG.F", name: "MSCI World", currentWeight: 0.35 }],
    }));
    // Con bottom EXTREME, maxBottomBoost=2.0 -> 15% * 2.0 = 30% = DCA normal
    expect(r.totalCashToInvest).toBeGreaterThan(0);
    expect(r.olympusInvested).toBe(300);
  });

  test("bottom VALUE en ataque BTC-only -> modo ataque activo", () => {
    const r = computeSmartDCA(baseInput({
      btcRsi: 30, btcZScore: -2.0, btcMomentum1m: -0.15,
      btcDominance: 60, mvrvRatio: 1.4,
      cycleBottomSignals: [{ ticker: "BTC-EUR", attackMultiplier: 1.5, shouldAccumulate: true, zone: "OPPORTUNITY" }],
    }));
    expect(r.attackMode).toBe(true);
    expect(r.totalCashToInvest).toBeGreaterThan(0);
  });

  test("sin cycleBottom -> DCA normal sin boost", () => {
    const r = computeSmartDCA(baseInput({ cycleTopSignals: [{ ticker: "0P00000WLG.F", shouldTrim: true, zone: "CAUTION" }] }));
    // cycleTopActive = true -> 15% fraction. No bottom boost -> 15%
    expect(r.olympusInvested).toBe(150);
  });
});
