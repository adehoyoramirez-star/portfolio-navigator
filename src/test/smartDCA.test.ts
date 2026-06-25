// ===============================================
// ARCHIVO: src/test/smartDCA.test.ts
// TESTS: DCA Normal - Ataque Cartera Completa - BTC-Only - Edge Cases
// ===============================================
import { describe, test, expect } from "vitest";
import { computeSmartDCA } from "../core/dca/smartDCA";
import type { SmartDCAInput } from "../core/dca/smartDCA";
import type { CEWSOutput } from "../core/macro/crisisEarlyWarning";

// ── Helper: base input con valores neutros ───────────────────────────────
function baseInput(overrides: Partial<SmartDCAInput> = {}): SmartDCAInput {
  return {
    btcRsi: 50,
    btcZScore: 0,
    btcMomentum1m: 0,
    btcDominance: 50,
    mvrvRatio: 2.0,
    regime: "EXPANSION",
    regimePenalty: 1.0,
    volTargetMultiplier: 1.0,
    tailRiskActive: false,
    tailRiskOverlay: 1.0,
    olympusAvailableCash: 1000,
    tacticalAvailableCash: 500,
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

// ── Helpers: condiciones para activar señales ─────────────────────────────
function cewsRecovering(): CEWSOutput {
  return {
    level: "CLEAR",
    score: 6,
    signalsInRed: 2,
    weeksInWarning: 2,
    signals: {
      yieldCurve: {
        name: "Yield Curve (10y-2y)", level: "CLEAR", score: 0,
        trend: "STABLE", value: 1.2, threshold: 0.5,
        description: "Curva normal — sin señal",
      },
      creditSpreads: {
        name: "Credit Spreads (HY-IG)", level: "WATCH", score: 2,
        trend: "STABLE", value: 2.5, threshold: 2.0,
        description: "Spreads elevados",
      },
      liquidityImpulse: {
        name: "Liquidity Impulse (M2 YoY)", level: "WATCH", score: 2,
        trend: "IMPROVING", value: 2.0, threshold: 3.0,
        description: "M2 crecimiento mínimo",
      },
      volClustering: {
        name: "Volatility Clustering (VIX)", level: "WATCH", score: 2,
        trend: "IMPROVING", value: 22, threshold: 25,
        description: "VIX normalizándose",
      },
    },
    earlyWarningActive: false,
    earlyWarningReason: "Señales en vigilancia",
    regimePenaltyAdjustment: -0.05,
    recommendation: "Monitorear evolución",
  };
}

function cewsStable(): CEWSOutput {
  return {
    level: "CLEAR",
    score: 2,
    signalsInRed: 0,
    weeksInWarning: 0,
    signals: {
      yieldCurve: {
        name: "Yield Curve (10y-2y)", level: "CLEAR", score: 0,
        trend: "STABLE", value: 1.5, threshold: 0.5,
        description: "Curva normal — sin señal",
      },
      creditSpreads: {
        name: "Credit Spreads (HY-IG)", level: "CLEAR", score: 1,
        trend: "STABLE", value: 1.5, threshold: 2.0,
        description: "Spreads normales",
      },
      liquidityImpulse: {
        name: "Liquidity Impulse (M2 YoY)", level: "CLEAR", score: 0,
        trend: "STABLE", value: 3.5, threshold: 3.0,
        description: "M2 creciendo",
      },
      volClustering: {
        name: "Volatility Clustering (VIX)", level: "CLEAR", score: 1,
        trend: "STABLE", value: 15, threshold: 25,
        description: "VIX normalizado",
      },
    },
    earlyWarningActive: false,
    earlyWarningReason: "Todos los indicadores en rango normal",
    regimePenaltyAdjustment: 0,
    recommendation: "Seguir plan habitual",
  };
}

// ───────────────────────────────────────────────────────────────────────────
// ESCENARIO 1: DCA NORMAL — menos de 4 señales activas
// ───────────────────────────────────────────────────────────────────────────
describe("DCA Normal (< 4 señales)", () => {

  test("Sin señales activas → BUY, ataque inactivo, solo 30% de Olympus", () => {
    const result = computeSmartDCA(baseInput());

    expect(result.action).toBe("BUY");
    expect(result.attackMode).toBe(false);
    expect(result.attackConfluence).toBe(0);
    // Solo 30% del cash Olympus, táctico acumula
    expect(result.olympusInvested).toBe(300);  // 1000 * 0.30
    expect(result.tacticalInvested).toBe(0);
    expect(result.tacticalAccumulated).toBe(500);
    expect(result.reasoning).toContain("DCA normal");
    expect(result.reasoning).toContain("Táctico acumula");
  });

  test("1 señal activa (BTC.D > 52) → BUY, sin ataque", () => {
    const result = computeSmartDCA(baseInput({
      btcDominance: 58,
    }));

    expect(result.action).toBe("BUY");
    expect(result.attackMode).toBe(false);
    expect(result.attackConfluence).toBe(1);
    expect(result.olympusInvested).toBe(300);
  });

  test("3 señales activas (solo BTC/on-chain, 0 macro) → BUY, umbral no alcanzado", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
      regimePenalty: 0.50,
    }));
    // Señales: BTC oversold + momentum + BTC.D + MVRV = 4, pero necesitamos ≤3 para normal
    // Con 4 activas -> ataque. Bajamos a 3 quitando una

    const result2 = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.05,  // no supera umbral -0.10
      btcDominance: 60,
      mvrvRatio: 1.4,
    }));
    // Señales activas: BTC oversold (1) + BTC.D (2) + MVRV (3) = 3 total, 0 macro
    expect(result2.action).toBe("BUY");
    expect(result2.attackMode).toBe(false);
    expect(result2.attackConfluence).toBe(3);
  });

  test("Distribuye cash proporcionalmente entre activos", () => {
    const result = computeSmartDCA(baseInput());

    // 300€ a repartir (1000 * 0.30)
    expect(result.totalCashToInvest).toBeGreaterThan(0);
    expect(result.allocationByAsset.length).toBeGreaterThan(0);
    // Todos los activos no-skips deben tener asignación
    const tickers = result.allocationByAsset.map(a => a.ticker);
    expect(tickers).toContain("BTC-EUR");
    expect(tickers).toContain("0P00000WLG.F");
    expect(tickers).toContain("VVSM.DE");
  });

  test("Cash total invertido no supera lo disponible", () => {
    const result = computeSmartDCA(baseInput());

    expect(result.totalCashToInvest).toBeLessThanOrEqual(result.olympusInvested + result.tacticalInvested);
  });

  test("Sin cash disponible → 0 invertido", () => {
    const result = computeSmartDCA(baseInput({
      olympusAvailableCash: 0,
      tacticalAvailableCash: 0,
    }));

    expect(result.totalCashToInvest).toBe(0);
    expect(result.allocationByAsset).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ESCENARIO 2: BTC-ONLY ATTACK — ≥4 señales activas pero < 2 macro
// ───────────────────────────────────────────────────────────────────────────
describe("BTC-Only Attack (≥4 señales, < 2 macro)", () => {

  test("4 señales BTC/on-chain, 0 macro → BTC-ONLY attack", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
      regimePenalty: 0.50,
    }));
    // Señales: BTC oversold (1) + momentum (2) + BTC.D (3) + MVRV (4) = 4 total, 0 macro

    expect(result.action).toBe("ATTACK_ENTRY");
    expect(result.attackMode).toBe(true);
    expect(result.attackConfluence).toBe(4);
    // BTC-only: solo se compra BTC-EUR
    expect(result.allocationByAsset.every(a => a.ticker === "BTC-EUR")).toBe(true);
    expect(result.reasoning).toContain("BTC-ONLY");
    // Olympus 60%, táctico completo
    expect(result.olympusInvested).toBe(600);
    expect(result.tacticalInvested).toBe(500);
  });

  test("4 señales BTC/on-chain + 1 macro → BTC-ONLY attack (solo 1 macro < 2)", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CONTRACTION",
      regimePenalty: 0.70,
    }));
    // Señales: BTC oversold (1) + momentum (2) + BTC.D (3) + MVRV (4) + Regimen (5 macro) = 5 total, 1 macro

    expect(result.attackConfluence).toBe(5);
    expect(result.attackMode).toBe(true);
    // Solo 1 macro (< 2) → BTC-only
    expect(result.allocationByAsset.every(a => a.ticker === "BTC-EUR")).toBe(true);
    expect(result.reasoning).toContain("BTC-ONLY");
  });

  test("5 señales (4 BTC/on-chain + 1 macro) → ATTACK_STRONG, BTC-only", () => {
    // 4 BTC/on-chain + 1 macro = 5 total, 1 macro < 2 → BTC-only
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 65,
      mvrvRatio: 1.2,
      regime: "CONTRACTION",
      regimePenalty: 0.80,
    }));
    // Activas: BTC oversold (1) + momentum (2) + BTC.D (3) + MVRV (4) + Regimen (5 macro) = 5 total, 1 macro

    expect(result.attackConfluence).toBe(5);
    expect(result.attackMode).toBe(true);
    expect(result.action).toBe("ATTACK_STRONG");
    // BTC-only porque macroConfluence (1) < 2
    expect(result.allocationByAsset.every(a => a.ticker === "BTC-EUR")).toBe(true);
    expect(result.reasoning).toContain("BTC-ONLY");
  });

  test("4 señales, 0 macro → solo 1 allocation: BTC-EUR", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
    }));

    expect(result.allocationByAsset.length).toBe(1);
    expect(result.allocationByAsset[0].ticker).toBe("BTC-EUR");
    expect(result.allocationByAsset[0].skipped).toBe(false);
  });

  test("4 señales BTC/on-chain, cycleTop para BTC → sin compras (todo skippeado)", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
      cycleTopSignals: [
        { ticker: "BTC-EUR", shouldTrim: true, zone: "CAUTION" },
      ],
    }));

    expect(result.attackMode).toBe(true);
    expect(result.attackConfluence).toBe(4);
    // BTC está en cycleTopTickers → no se compra nada (BTC-only pero BTC skippeado)
    expect(result.allocationByAsset).toHaveLength(0);
    // totalCashToInvest es el cash PLANIFICADO (600+500=1100), aunque ningún activo se compre
    expect(result.totalCashToInvest).toBe(1100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ESCENARIO 3: FULL PORTFOLIO ATTACK — ≥4 señales activas con ≥ 2 macro
// ───────────────────────────────────────────────────────────────────────────
describe("Full Portfolio Attack (≥4 señales, ≥2 macro)", () => {

  test("4 señales (2 macro + 2 on-chain) → ATTACK_ENTRY, cartera completa", () => {
    // Necesitamos exactamente 4 señales con ≥2 macro.
    // Usamos: Regimen (macro) + VIX (macro) + BTC.D + MVRV = 4
    // VIX requiere cews con volClustering.trend=IMPROVING, level≠ALERT
    // CEWS no debe activarse (necesita previous ALERT/WARNING + current WATCH/CLEAR)
    // Con cewsPreviousLevel=CLEAR y cewsOutput.level=CLEAR → NO activa
    const result = computeSmartDCA(baseInput({
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CONTRACTION",
      regimePenalty: 0.70,
      cewsOutput: cewsRecovering(),  // VIX se activa por volClustering IMPROVING
      cewsPreviousLevel: "CLEAR",     // CEWS NO se activa (CLEAR→WATCH/CLEAR, pero level=CLEAR no es WATCH/CLEAR... espera)
    }));
    // cewsRecovering().level = "CLEAR", cewsPreviousLevel = "CLEAR"
    // CEWS requiere previous ALERT/WARNING → NO activa
    // VIX requiere trend=IMPROVING y level≠ALERT → nivel WATCH ✅
    // Activas: BTC.D (1) + MVRV (2) + Regimen (3 macro) + VIX (4 macro) = 4 total, 2 macro

    expect(result.attackConfluence).toBe(4);
    expect(result.attackMode).toBe(true);
    expect(result.action).toBe("ATTACK_ENTRY");
    // Debe tener múltiples activos (no solo BTC)
    expect(result.allocationByAsset.length).toBeGreaterThan(1);
    const hasNonBtc = result.allocationByAsset.some(a => a.ticker !== "BTC-EUR" && !a.skipped);
    expect(hasNonBtc).toBe(true);
    expect(result.reasoning).toContain("ATAQUE");
    expect(result.reasoning).not.toContain("BTC-ONLY");
    // Olympus 60%, táctico completo
    expect(result.olympusInvested).toBe(600);
    expect(result.tacticalInvested).toBe(500);
  });

  test("7 señales con 3 macro → ATTACK_MAX, cartera completa", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CONTRACTION",
      regimePenalty: 0.70,
      cewsOutput: cewsRecovering(),
      cewsPreviousLevel: "ALERT",
    }));
    // Activas: BTC oversold (1) + momentum (2) + BTC.D (3) + MVRV (4) + Regimen (5 macro) + CEWS (6 macro) + VIX (7 macro)
    // = 7 total, 3 macro → full portfolio attack, ATTACK_MAX (≥6)

    expect(result.attackConfluence).toBe(7);
    expect(result.action).toBe("ATTACK_MAX");
    expect(result.attackMode).toBe(true);
    // Múltiples activos
    const tickers = result.allocationByAsset.filter(a => !a.skipped).map(a => a.ticker);
    expect(tickers.length).toBeGreaterThan(1);
    expect(tickers).toContain("0P00000WLG.F");
    expect(tickers).toContain("VVSM.DE");
  });

  test("Distribuye cash entre todos los activos según peso", () => {
    const result = computeSmartDCA(baseInput({
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CONTRACTION",
      regimePenalty: 0.70,
      cewsOutput: cewsRecovering(),
      cewsPreviousLevel: "ALERT",
    }));
    // 5 total (2 macro) → ATTACK_ENTRY

    const nonSkipped = result.allocationByAsset.filter(a => !a.skipped);
    // BTC-EUR debe tener ~20% del cash
    const btcAlloc = nonSkipped.find(a => a.ticker === "BTC-EUR");
    const totalCash = nonSkipped.reduce((s, a) => s + a.cashToInvest, 0);
    if (btcAlloc && totalCash > 0) {
      const btcPct = btcAlloc.cashToInvest / totalCash;
      expect(btcPct).toBeGreaterThan(0.10);
      expect(btcPct).toBeLessThan(0.35);
    }
  });

  test("cycleTopSignals excluye activos específicos en modo ataque completo", () => {
    const result = computeSmartDCA(baseInput({
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CONTRACTION",
      regimePenalty: 0.70,
      cewsOutput: cewsRecovering(),
      cewsPreviousLevel: "ALERT",
      cycleTopSignals: [
        { ticker: "PPFB.DE", shouldTrim: true, zone: "CAUTION" },
      ],
    }));

    // PPFB.DE está filtrado de eligible (skipTickers) → NO aparece en allocationByAsset
    const ppfb = result.allocationByAsset.find(a => a.ticker === "PPFB.DE");
    expect(ppfb).toBeUndefined();
    // Los demás activos se distribuyen el cash normalmente
    const others = result.allocationByAsset.filter(a => !a.skipped);
    expect(others.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BLOQUEOS — Condiciones que impiden cualquier compra
// ───────────────────────────────────────────────────────────────────────────
describe("Bloqueos", () => {

  test("Tail Risk activo con overlay < 0.7 → BLOCK_TAIL_RISK", () => {
    const result = computeSmartDCA(baseInput({
      tailRiskActive: true,
      tailRiskOverlay: 0.50,
    }));

    expect(result.action).toBe("BLOCK_TAIL_RISK");
    expect(result.attackMode).toBe(false);
    expect(result.totalCashToInvest).toBe(0);
    expect(result.blockReason).toContain("Tail Risk");
  });

  test("Tail Risk activo con overlay ≥ 0.7 → NO bloquea (sigue normal)", () => {
    const result = computeSmartDCA(baseInput({
      tailRiskActive: true,
      tailRiskOverlay: 0.80,
    }));

    expect(result.action).not.toBe("BLOCK_TAIL_RISK");
    expect(result.totalCashToInvest).toBeGreaterThan(0);
  });

  test("Régimen CRISIS → BLOCK_CRISIS", () => {
    const result = computeSmartDCA(baseInput({
      regime: "CRISIS",
      regimePenalty: 0.40,
    }));

    expect(result.action).toBe("BLOCK_CRISIS");
    expect(result.totalCashToInvest).toBe(0);
    expect(result.blockReason).toContain("CRISIS");
  });

  test("RégimenPenalty ≤ 0.45 → BLOCK_CRISIS (aunque no sea literal CRISIS)", () => {
    const result = computeSmartDCA(baseInput({
      regime: "CONTRACTION",
      regimePenalty: 0.40,
    }));

    expect(result.action).toBe("BLOCK_CRISIS");
    expect(result.totalCashToInvest).toBe(0);
  });

  test("Vol Target < 0.60 → BLOCK_VOL", () => {
    const result = computeSmartDCA(baseInput({
      volTargetMultiplier: 0.50,
    }));

    expect(result.action).toBe("BLOCK_VOL");
    expect(result.totalCashToInvest).toBe(0);
    expect(result.blockReason).toContain("Vol Target");
  });

  test("BTC Cycle Override en CRISIS con ≥4 señales → compra solo BTC", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CRISIS",
      regimePenalty: 0.40,
    }));

    // CRISIS + tailRisk false + 4 señales → BTC CYCLE OVERRIDE (antes del bloqueo CRISIS normal)
    expect(result.action).toBe("BTC_CYCLE_OVERRIDE");
    expect(result.attackConfluence).toBe(4);
    expect(result.allocationByAsset.every(a => a.ticker === "BTC-EUR")).toBe(true);
  });

  test("BTC Cycle Override con tailRisk activo → NO se activa (bloqueado por tailRisk)", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CRISIS",
      regimePenalty: 0.40,
      tailRiskActive: true,
      tailRiskOverlay: 0.50,
    }));

    // tailRisk check corre primero
    expect(result.action).toBe("BLOCK_TAIL_RISK");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// EDGE CASES
// ───────────────────────────────────────────────────────────────────────────
describe("Edge Cases", () => {

  test("Todos los activos con cycleTopSignal → 0 compras (cash no se invierte)", () => {
    const result = computeSmartDCA(baseInput({
      cycleTopSignals: [
        { ticker: "BTC-EUR", shouldTrim: true, zone: "CAUTION" },
        { ticker: "0P00000WLG.F", shouldTrim: true, zone: "DANGER" },
        { ticker: "VVSM.DE", shouldTrim: true, zone: "CAUTION" },
        { ticker: "PPFB.DE", shouldTrim: true, zone: "CAUTION" },
        { ticker: "URNU.DE", shouldTrim: true, zone: "CAUTION" },
        { ticker: "EMXC.DE", shouldTrim: true, zone: "CAUTION" },
        { ticker: "VVSM.DE", shouldTrim: true, zone: "EXTREME" },
      ],
    }));

    // totalCashToInvest es el cash PLANIFICADO (1000*0.30=300), aunque ningún activo se compre
    expect(result.totalCashToInvest).toBe(300);
    expect(result.allocationByAsset).toHaveLength(0);
  });

  test("cycleTopSignals con zone SAFE → no se filtra (shouldTrim true pero SAFE)", () => {
    // PPFB con price bajo para asegurar que sea comprable
    const result = computeSmartDCA(baseInput({
      motorAllocations: [
        { name: "Bitcoin", ticker: "BTC-EUR", finalAllocation: 0.20, price: 60000 },
        { name: "MSCI World", ticker: "0P00000WLG.F", finalAllocation: 0.30, price: 75 },
        { name: "Uranio", ticker: "URNU.DE", finalAllocation: 0.05, price: 28 },
      { name: "E.M.", ticker: "EMXC.DE", finalAllocation: 0.10, price: 30 },
        { name: "Gold", ticker: "PPFB.DE", finalAllocation: 0.15, price: 20 },  // price bajo para que sea comprable
        { name: "Value", ticker: "VVSM.DE", finalAllocation: 0.10, price: 55 },
      ],
      cycleTopSignals: [
        { ticker: "PPFB.DE", shouldTrim: true, zone: "SAFE" },
      ],
    }));

    // SAFE zone significa que NO se filtra de eligible → PPFB aparece como comprable
    const ppfb = result.allocationByAsset.find(a => a.ticker === "PPFB.DE");
    expect(ppfb).toBeDefined();
    // PPFB puede estar skipped si el cash es insuficiente para 1 acción, no por cycleTop
    // Lo relevante: PPFB está en allocationByAsset (no fue removido de eligible)
    // La razón de skip NO debe mencionar cycleTop
    expect(ppfb!.skipped).toBe(false);
  });

  test("cycleTopSignals vacío → comportamiento normal", () => {
    const result = computeSmartDCA(baseInput({
      cycleTopSignals: [],
    }));

    const nonSkipped = result.allocationByAsset.filter(a => !a.skipped);
    expect(nonSkipped.length).toBeGreaterThan(0);
  });

  test("Sin tacticalAvailableCash → olympus solo", () => {
    const result = computeSmartDCA(baseInput({
      tacticalAvailableCash: 0,
    }));

    expect(result.tacticalInvested).toBe(0);
    expect(result.tacticalAccumulated).toBe(0);
    expect(result.olympusInvested).toBe(300);
  });

  test("Defensive liquidity se usa correctamente", () => {
    const result = computeSmartDCA(baseInput({
      accumulatedDefensiveLiquidity: 2000,
    }));

    // accumulatedDefensiveLiquidity es informativo, no cambia la lógica principal
    expect(result.action).toBe("BUY");
    expect(result.olympusInvested).toBe(300);
  });

  test("Attack con 7 señales y 3 macro → ATTACK_MAX full cartera", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CONTRACTION",
      regimePenalty: 0.70,
      cewsOutput: cewsRecovering(),
      cewsPreviousLevel: "ALERT",
    }));
    // 7 señales: oversold + momentum + BTC.D + MVRV + Regimen + CEWS + VIX = 7

    expect(result.attackConfluence).toBe(7);
    expect(result.action).toBe("ATTACK_MAX");
    expect(result.allocationByAsset.length).toBeGreaterThan(1);
    // Attack multiplier should be 1.5 for attack mode
    expect(result.attackMultiplier).toBe(1.5);
    // Attack tranche: 6+ → 3
    expect(result.attackTranche).toBe(3);
  });

  test("Attack con 5 señales (solo 1 macro) → ATTACK_STRONG, BTC-only", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CONTRACTION",
      regimePenalty: 0.70,
    }));
    // Activas: BTC oversold (1) + momentum (2) + BTC.D (3) + MVRV (4) + Regimen (5 macro) = 5
    // macroConfluence = 1 (< 2) → BTC-only

    expect(result.action).toBe("ATTACK_STRONG");  // 5 → ATTACK_STRONG
    expect(result.attackTranche).toBe(2);           // 5 → tranche 2
    // BTC-only
    expect(result.allocationByAsset.every(a => a.ticker === "BTC-EUR")).toBe(true);
  });

  test("Attack con 4 señales (0 macro) → ATTACK_ENTRY, BTC-only", () => {
    const result = computeSmartDCA(baseInput({
      btcRsi: 30,
      btcZScore: -2.0,
      btcMomentum1m: -0.15,
      btcDominance: 60,
      mvrvRatio: 1.4,
    }));
    // Activas: BTC oversold (1) + momentum (2) + BTC.D (3) + MVRV (4) = 4 total, 0 macro

    expect(result.attackConfluence).toBe(4);
    expect(result.action).toBe("ATTACK_ENTRY");
    expect(result.attackTranche).toBe(1);
    expect(result.allocationByAsset.every(a => a.ticker === "BTC-EUR")).toBe(true);
  });

  test("Cash Olympus = 0 pero táctico > 0 → usa táctico en ataque", () => {
    const result = computeSmartDCA(baseInput({
      olympusAvailableCash: 0,
      tacticalAvailableCash: 1000,
      btcDominance: 60,
      mvrvRatio: 1.4,
      regime: "CONTRACTION",
      regimePenalty: 0.70,
      cewsOutput: cewsRecovering(),
      cewsPreviousLevel: "ALERT",
    }));

    expect(result.attackMode).toBe(true);
    expect(result.olympusInvested).toBe(0);
    expect(result.tacticalInvested).toBe(1000);
    expect(result.totalCashToInvest).toBe(1000);
  });
});
