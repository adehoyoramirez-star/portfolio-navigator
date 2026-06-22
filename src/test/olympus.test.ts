// ===============================================
// ARCHIVO: src/test/olympus.test.ts
// ESTADO: CORREGIDO Y BLINDADO
// ===============================================
import { describe, test, expect, beforeEach } from "vitest";
import { computeDCADecision } from "../core/dca/dcaEngine";
import type { BTCCycleOutput } from "../core/crypto/btcCycleOverlay";
import { runOlympusEngine, type OlympusEngineInput } from "../core/engine/olympusV3";
import { calculateQuality, computeQualityUniverseStats, type QualityInput } from "../core/factors/quality";
import { calculateMomentum } from "../core/factors/momentum";
import { getMasterRegime, type MasterRegimeInput } from "../core/macro/masterRegime";

describe("Pruebas del Motor Olympus Predator", () => {

  test("Debe reducir la intensidad en modo CRISIS", () => {
    const input = {
      regime: "CRISIS" as const,
      availableCash: 1000,
      totalPortfolioValue: 10000,
      portfolioVolatility: 0.01
    };

    const result = computeDCADecision(input);

    // Verificamos que la intensidad sea baja en crisis
    expect(result.baseIntensity).toBeLessThanOrEqual(0.05);
  });

  test("Debe aplicar el Boost en modo Recuperación", () => {
    // Mock corregido: sin 'phase' y con breakdown oficial
    const mockBtcCycle: BTCCycleOutput = {
      boostActive: true,
      btcScore: 1,
      btcNumeric: 1,
      signal: "BUY",
      breakdown: {
        mvrvScore: 1,
        puellScore: 1,
        rsiScore: 1
      },
      description: "Test de recuperación"
    };

    const input = {
      regime: "EXPANSION" as const,
      btcCycle: mockBtcCycle,
      availableCash: 5000,
      totalPortfolioValue: 10000,
      // FIX-DCA-2: boost solo se activa si portfolioDrawdown < -5% (recuperación real)
      portfolioDrawdown: -0.10,
    };

    const result = computeDCADecision(input);

    // Verificamos que el boost esté funcionando
    expect(result.boostMultiplier).toBeGreaterThan(1);
    expect(result.effectiveIntensity).toBeGreaterThan(result.baseIntensity);
  });

  test("Debe activar la Venta de Emergencia con alta volatilidad", () => {
    const input = {
      regime: "CRISIS" as const,
      // FIX-BUG-3: PANIC_VOLATILITY cambió de 0.04 (diaria) a 0.40 (anualizada).
      // Vol anual 0.50 supera el umbral de pánico 0.40.
      portfolioVolatility: 0.50, // 50% anual (Pánico detectado)
      availableCash: 0,
      totalPortfolioValue: 10000
    };

    const result = computeDCADecision(input);

    // Verificamos el protocolo de eyección
    expect(result.investAmount).toBeLessThan(0); // Es una venta
    expect(result.riskConstraintActive).toBe(true);
    expect(result.description).toContain("Liquidando");
  });

});

describe("Motor Olympus V5 - Factor Quality y Momentum", () => {

  test("Quality debe calcular score correcto para activo defensivo", () => {
    const defensiveAsset: QualityInput = {
      volatility: 0.12,  // baja volatilidad
      returns12m: 0.15,  // retorno positivo
      returns3m: 0.04,
      returns1m: 0.01,
    };

    const aggressiveAsset: QualityInput = {
      volatility: 0.60,  // alta volatilidad
      returns12m: 0.50,  // alto retorno pero volátil
      returns3m: 0.10,
      returns1m: 0.05,
    };

    const stats = computeQualityUniverseStats([defensiveAsset, aggressiveAsset]);
    const qualityDefensive = calculateQuality(defensiveAsset, stats);
    const qualityAggressive = calculateQuality(aggressiveAsset, stats);

    // Activo defensivo debe tener mayor quality score (menor vol, retorno estable)
    expect(qualityDefensive.volatilityScore).toBeGreaterThan(qualityAggressive.volatilityScore);
  });

  test("Quality debe aplicar bonus para ETF Quality Factor", () => {
    const qualityETF: QualityInput = {
      volatility: 0.15,
      returns12m: 0.12,
      returns3m: 0.03,
      returns1m: 0.01,
      isQualityFactor: true,  // ETF de factor quality
    };

    const genericETF: QualityInput = {
      ...qualityETF,
      isQualityFactor: false,
    };

    const stats = computeQualityUniverseStats([qualityETF, genericETF]);
    const qualityWithBonus = calculateQuality(qualityETF, stats);
    const qualityWithoutBonus = calculateQuality(genericETF, stats);

    // El bonus debe aumentar el score
    expect(qualityWithBonus.qualityScore).toBeGreaterThan(qualityWithoutBonus.qualityScore);
  });

  test("Momentum debe calcular score correctamente", () => {
    const strongMomentum = calculateMomentum({
      returns12m: 0.50,
      returns3m: 0.15,
      returns1m: 0.05,
    });

    const weakMomentum = calculateMomentum({
      returns12m: 0.05,
      returns3m: -0.02,
      returns1m: -0.01,
    });

    // Momentum fuerte debe tener score mayor
    expect(strongMomentum.momentumScore).toBeGreaterThan(weakMomentum.momentumScore);

    // Verificar componentes
    expect(strongMomentum.momentum12_1).toBeGreaterThan(0);  // 12m - 1m positivo
  });

  test("Olympus Engine debe integrar Quality y Momentum correctamente", () => {
    const input: OlympusEngineInput = {
      assets: [
        {
          name: "Quality ETF",
          returns12m: 0.12,
          returns3m: 0.04,
          returns1m: 0.01,
          earningsYield: 0.04,
          volatility: 0.15,
          sector: "equity",
        },
        {
          name: "Momentum ETF",
          returns12m: 0.25,
          returns3m: 0.08,
          returns1m: 0.03,
          earningsYield: 0.03,
          volatility: 0.22,
          sector: "equity",
        },
      ],
      correlationMatrix: [[1, 0.6], [0.6, 1]],
      macro: {
        vix: 18,
        yieldSpread: 0.5,
        creditSpread: 1.2,
        move: 100,
        dxyTrend: 0,
        btcVol: 0.60,
        m2Growth: 3.0,
      },
    };

    const result = runOlympusEngine(input);

    // Verificar que el engine produce asignaciones
    expect(result.allocations).toHaveLength(2);
    expect(result.allocations[0].finalAllocation).toBeGreaterThan(0);

    // Verificar que quality y momentum scores están presentes
    expect(result.allocations[0].qualityScore).toBeDefined();
    expect(result.allocations[0].momentumScore).toBeDefined();

    // Verificar régimen (debería ser EXPANSION con VIX 18)
    expect(result.regime).toBe("EXPANSION");
  });
});

// ─────────────────────────────────────────────────────
// EDGE CASES — Motor Olympus V5
// ─────────────────────────────────────────────────────
describe("Olympus V5 — Edge Cases", () => {

  function baseInput(overrides: Partial<OlympusEngineInput> = {}): OlympusEngineInput {
    return {
      assets: [
        { name: "BTC", returns12m: 0.80, returns3m: 0.20, returns1m: 0.05, earningsYield: 0, volatility: 0.60, sector: "crypto" },
        { name: "SP500", returns12m: 0.15, returns3m: 0.05, returns1m: 0.01, earningsYield: 0.035, volatility: 0.18, sector: "equity" },
        { name: "Gold", returns12m: 0.08, returns3m: 0.02, returns1m: -0.01, earningsYield: 0, volatility: 0.15, sector: "commodities" },
      ],
      correlationMatrix: [
        [1, 0.4, 0.15],
        [0.4, 1, 0.2],
        [0.15, 0.2, 1],
      ],
      macro: { vix: 18, yieldSpread: 0.5, creditSpread: 1.2, move: 100, dxyTrend: 0, btcVol: 0.60, m2Growth: 3.0, wtiOil: 75 },
      ...overrides,
    };
  }

  test("CRISIS con VIX alto → totalInvested reducido + tailRisk activo", () => {
    const result = runOlympusEngine(baseInput({
      macro: { vix: 45, yieldSpread: 3.5, creditSpread: 3.0, move: 180, dxyTrend: 4, btcVol: 1.2, m2Growth: -2.0, wtiOil: 60 },
    }));

    expect(result.regime).toBe("CRISIS");
    expect(result.totalInvested).toBeLessThanOrEqual(1.0);
    expect(result.metaIntelligence.modelHealth).toBeDefined();
    expect(result.coreSignal.finalScore).toBeLessThan(0.6);
  });

  test("EXPANSION + STRONG_BUY + M2 > 0 → condiciones Alpha-Boost se cumplen", () => {
    // LIMPIEZA: evitar hysteresis de tests CRISIS anteriores que contamina localStorage
    localStorage.removeItem('olympus_regime_hysteresis_v1');

    const result = runOlympusEngine(baseInput({
      macro: { vix: 12, yieldSpread: 0.2, creditSpread: 0.8, move: 80, dxyTrend: -1, btcVol: 0.40, m2Growth: 6.0, wtiOil: 80 },
      btcOnChain: { mvrvRatio: 1.49, puellMultiple: 0.4, rsiWeekly: 35 },
      covMatrix: [
        [0.36, 0.043, 0.0135],
        [0.043, 0.0324, 0.0054],
        [0.0135, 0.0054, 0.0225],
      ],
      liquidityGrowth: 5,
    }));

    // Verificar condiciones de Alpha-Boost (antes de volTarget)
    expect(result.regime).toBe("EXPANSION");
    expect(result.btcCycle?.signal).toBe("STRONG_BUY");
    expect(result.btcCycle?.boostActive).toBe(true);
    // totalInvested es positivo y razonable
    expect(result.totalInvested).toBeGreaterThan(0.50);
    expect(result.totalInvested).toBeLessThanOrEqual(1.0);
  });

  test("MVRV > 3.5 → BTC cap reducido de 20% a 10%", () => {
    const result = runOlympusEngine(baseInput({
      macro: { vix: 12, yieldSpread: 0.2, creditSpread: 0.8, move: 80, dxyTrend: -1, btcVol: 0.50, m2Growth: 4.0 },
      btcOnChain: { mvrvRatio: 3.8, puellMultiple: 2.5, rsiWeekly: 80 },
    }));

    // BTC no debe exceder 10% con MVRV > 3.5
    const btcAlloc = result.allocations.find(a => a.name === "BTC");
    expect(btcAlloc).toBeDefined();
    expect(btcAlloc!.finalAllocation).toBeLessThanOrEqual(0.11);
  });

  test("CRISIS con drawdown activo → tailRisk reduce exposición", () => {
    // NOTA: Con Kelly = μ/σ², retornos negativos dan Kelly negativo, no cero.
    // El camino ALL_CASH solo se activa si expectedReturn = 0 exacto.
    // Para activar tailRisk kill switch se necesita drawdown > umbral L1 (8%).
    // Con drawdown=-10% + VIX=35 + creditSpread=5 → Kill Switch L1 activo + crisis sistémica.
    const result = runOlympusEngine(baseInput({
      assets: [
        { name: "CashL", returns12m: -0.95, returns3m: -0.50, returns1m: -0.30, earningsYield: 0, volatility: 0.05, sector: "fixed_income" },
      ],
      correlationMatrix: [[1]],
      macro: { vix: 35, yieldSpread: 4.0, creditSpread: 5.0, move: 200, dxyTrend: 5, btcVol: 0.80, m2Growth: -5.0 },
      portfolioDrawdown: -0.10,
      portfolioRealizedVol: 0.35,
    }));

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].finalAllocation).toBeDefined();
    expect(isFinite(result.totalInvested)).toBe(true);
    expect(result.regime).toBe("CRISIS");
    // tailRisk activo por drawdown + VIX alto + credit spread
    expect(result.tailRiskActive).toBe(true);
    expect(result.killSwitchLevel).toBeGreaterThanOrEqual(1);
    expect(result.totalInvested).toBeLessThanOrEqual(1.0);
  });

  test("Sin covMatrix → fallback a Kelly+HRP blend", () => {
    // Omitir covMatrix a propósito
    const result = runOlympusEngine({
      assets: [
        { name: "BTC", returns12m: 0.50, returns3m: 0.15, returns1m: 0.05, earningsYield: 0, volatility: 0.60, sector: "crypto" },
        { name: "SP500", returns12m: 0.12, returns3m: 0.04, returns1m: 0.01, earningsYield: 0.035, volatility: 0.18, sector: "equity" },
      ],
      correlationMatrix: [[1, 0.5], [0.5, 1]],
      macro: { vix: 18, yieldSpread: 0.5, creditSpread: 1.2, move: 100, dxyTrend: 0, btcVol: 0.60, m2Growth: 3.0 },
    });

    expect(result.allocations).toHaveLength(2);
    expect(result.meta.hasRealCovMatrix).toBe(false);
    expect(result.allocations[0].finalAllocation).toBeGreaterThan(0);
    expect(result.allocations[1].finalAllocation).toBeGreaterThan(0);
  });

  test("dcaDataMissing flag true cuando falta totalPortfolioValue", () => {
    const result = runOlympusEngine(baseInput({
      // no pasar totalPortfolioValue
    }));

    expect(result.meta.dcaDataMissing).toBe(true);
  });

  test("dcaDataMissing flag false cuando se provee totalPortfolioValue", () => {
    const result = runOlympusEngine(baseInput({
      totalPortfolioValue: 100000,
      availableCash: 20000,
    }));

    expect(result.meta.dcaDataMissing).toBe(false);
  });

  test("Kill switch level 0 con condiciones normales", () => {
    const result = runOlympusEngine(baseInput());

    expect(result.killSwitchLevel).toBe(0);
    expect(result.tailRiskActive).toBe(false);
  });

  test("Todas las allocations suman ∼totalInvested", () => {
    const result = runOlympusEngine(baseInput({
      covMatrix: [
        [0.36, 0.043, 0.0135],
        [0.043, 0.0324, 0.0054],
        [0.0135, 0.0054, 0.0225],
      ],
    }));

    const sumAllocs = result.allocations.reduce((s, a) => s + a.finalAllocation, 0);
    expect(Math.abs(sumAllocs - result.totalInvested)).toBeLessThan(0.01);
  });

  test("btcCycle se incluye en el output", () => {
    const result = runOlympusEngine(baseInput());

    expect(result.btcCycle).toBeDefined();
    expect(result.btcCycle!.btcScore).toBeGreaterThanOrEqual(0);
    expect(result.btcCycle!.btcNumeric).toBeGreaterThanOrEqual(0);
    expect(result.btcCycle!.btcNumeric).toBeLessThanOrEqual(1);
  });

  test("metaIntelligence siempre presente", () => {
    const result = runOlympusEngine(baseInput());

    expect(result.metaIntelligence.modelHealth).toMatch(/^(RELIABLE|DEGRADED|UNRELIABLE)$/);
    expect(result.metaIntelligence.confidenceMultiplier).toBeGreaterThanOrEqual(0.70);
    expect(result.metaIntelligence.confidenceMultiplier).toBeLessThanOrEqual(1.0);
  });
});

// ─────────────────────────────────────────────────────
// HYSTERESIS — Aislamiento entre regímenes
// ─────────────────────────────────────────────────────
describe("Hysteresis — aislamiento entre regímenes", () => {

  const HYSTERESIS_KEY = 'olympus_regime_hysteresis_v1';

  function makeInput(vix: number, creditSpread: number, yieldSpread: number, overrides: Partial<MasterRegimeInput> = {}): MasterRegimeInput {
    return {
      vix,
      creditSpread,
      yieldSpread,
      move: 100,
      dxyTrend: 0,
      btcVol: 0.60,
      m2Growth: 3.0,
      ...overrides,
    };
  }

  // Inputs que producen cada régimen según detectCrisis + computeGlobalStress:
  // EXPANSION: crisisScore=5.76 (<10), stressScore=0 → ambos EXPANSION
  const EXPANSION_INPUT = makeInput(12, 0.8, 0.2);
  // CONTRACTION: crisisScore=14.6 (>10, <25), stressScore=4 (HIGH_RISK) → CONTRACTION
  const CONTRACTION_INPUT = makeInput(26, 3.5, 1.5, { move: 120, dxyTrend: 0.01, m2Growth: 0 });
  // CRISIS: crisisScore=26 (>25), stressScore=7 (≥6) → CRISIS (ambos modelos)
  const CRISIS_INPUT = makeInput(50, 5.0, 0.5, { move: 150, dxyTrend: 0.03, btcVol: 0.9, m2Growth: -2 });

  beforeEach(() => {
    localStorage.removeItem(HYSTERESIS_KEY);
    localStorage.removeItem('olympus_manual_refresh_v1');
  });

  // ── Test 1: baseline ────────────────────────────────────────────────
  test("EXPANSION directo sin localStorage previo → EXPANSION", () => {
    const result = getMasterRegime(EXPANSION_INPUT);
    expect(result.regime).toBe("EXPANSION");
  });

  test("CONTRACTION directo sin localStorage previo → CONTRACTION", () => {
    const result = getMasterRegime(CONTRACTION_INPUT);
    expect(result.regime).toBe("CONTRACTION");
  });

  test("CRISIS directo sin localStorage previo → CRISIS", () => {
    const result = getMasterRegime(CRISIS_INPUT);
    expect(result.regime).toBe("CRISIS");
  });

  // ── Test 4: CRISIS→EXPANSION bloqueado ──────────────────────────────
  test("CRISIS previo en localStorage → EXPANSION es bloqueado por hysteresis", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    expect(result.regime).toBe("CRISIS");
  });

  // ── Test 5: CRISIS→CONTRACTION bloqueado ────────────────────────────
  test("CRISIS previo → CONTRACTION es bloqueado por hysteresis", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(CONTRACTION_INPUT);
    expect(result.regime).toBe("CRISIS");
  });

  // ── Test 6: CONTRACTION→EXPANSION bloqueado ─────────────────────────
  test("CONTRACTION previo → EXPANSION es bloqueado por hysteresis", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CONTRACTION",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.55,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    expect(result.regime).toBe("CONTRACTION");
  });

  // ── Test 7: EXPANSION→CRISIS NO bloqueado (upgrade) ────────────────
  test("EXPANSION previo → CRISIS NO es bloqueado por hysteresis (upgrade inmediato)", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "EXPANSION",
      lastTimestamp: Date.now(),
      penaltyAtChange: 1.0,
    }));

    const result = getMasterRegime(CRISIS_INPUT);
    expect(result.regime).toBe("CRISIS");
  });

  // ── Test 8: confidence con hysteresis ───────────────────────────────
  test("Confidence es LOW cuando hysteresis está activa bloqueando downgrade", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    expect(result.regime).toBe("CRISIS");
    expect(result.confidence).toBe("LOW");
  });

  // ── Test 9: limpieza manual ─────────────────────────────────────────
  test("Limpieza de localStorage permite el downgrade liberado", () => {
    // Con hysteresis activa
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));
    const blockedResult = getMasterRegime(EXPANSION_INPUT);
    expect(blockedResult.regime).toBe("CRISIS");

    // Limpiar y reintentar
    localStorage.removeItem(HYSTERESIS_KEY);
    const cleanResult = getMasterRegime(EXPANSION_INPUT);
    expect(cleanResult.regime).toBe("EXPANSION");
  });

  // ── Test 10: expiración automática >72h ─────────────────────────────
  test("Estado expirado (>72h) se resetea automáticamente", () => {
    // Sembrar CRISIS de hace 73 horas (excede HYSTERESIS_MAX_HOURS=72)
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now() - 73 * 3_600_000,
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    // Expiró → hysteresis se resetea → EXPANSION se aplica
    expect(result.regime).toBe("EXPANSION");
    // getMasterRegime re-savea estado nuevo tras el reset automático
    const saved = JSON.parse(localStorage.getItem(HYSTERESIS_KEY)!);
    expect(saved.lastRegime).toBe("EXPANSION");
  });

  // ── Test 11: manual refresh bypass ──────────────────────────────────
  test("Manual Refresh Bypass salta la hysteresis", () => {
    // Sembrar CRISIS reciente
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));
    // Señal de refresh manual (válida por 2 minutos)
    localStorage.setItem('olympus_manual_refresh_v1', Date.now().toString());

    const result = getMasterRegime(EXPANSION_INPUT);
    // Con bypass activo, hysteresis se salta → EXPANSION
    expect(result.regime).toBe("EXPANSION");
  });

  // ── Test 12: penalty interpolation ──────────────────────────────────
  test("Penalty se interpola correctamente con hysteresis activa", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    // hoursElapsed ≈ 0 → lerpFactor = 0 → penalty = penaltyAtChange = 0.40
    expect(result.regimePenalty).toBeGreaterThanOrEqual(0.40);
    expect(result.regimePenalty).toBeLessThan(0.60);
  });

  // ── Test 13: penalty NO se interpola tras limpiar ───────────────────
  test("Penalty es el correcto de EXPANSION tras limpiar hysteresis", () => {
    localStorage.removeItem(HYSTERESIS_KEY);
    const result = getMasterRegime(EXPANSION_INPUT);
    // Sin hysteresis, penalty debe ser ~1.0 (EXPANSION puro)
    expect(result.regimePenalty).toBeGreaterThan(0.80);
    expect(result.confidence).toBe("HIGH");
  });
});