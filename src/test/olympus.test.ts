// ===============================================
// ARCHIVO: src/test/olympus.test.ts
// ESTADO: CORREGIDO Y BLINDADO
// ===============================================
import { describe, test, expect } from "vitest";
import { computeDCADecision } from "../core/dca/dcaEngine";
import type { BTCCycleOutput } from "../core/crypto/btcCycleOverlay";
import { runOlympusEngine, type OlympusEngineInput } from "../core/engine/olympusV3";
import { calculateQuality, computeQualityUniverseStats, type QualityInput } from "../core/factors/quality";
import { calculateMomentum } from "../core/factors/momentum";

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
      totalPortfolioValue: 10000
    };

    const result = computeDCADecision(input);

    // Verificamos que el boost esté funcionando
    expect(result.boostMultiplier).toBeGreaterThan(1);
    expect(result.effectiveIntensity).toBeGreaterThan(result.baseIntensity);
  });

  test("Debe activar la Venta de Emergencia con alta volatilidad", () => {
    const input = {
      regime: "CRISIS" as const,
      portfolioVolatility: 0.08, // 8% de vol (Pánico detectado)
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