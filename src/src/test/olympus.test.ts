// ===============================================
// ARCHIVO: src/test/olympus.test.ts
// ESTADO: CORREGIDO Y BLINDADO
// ===============================================
import { describe, test, expect } from "vitest"; 
import { computeDCADecision } from "../core/dca/dcaEngine";
import type { BTCCycleOutput } from "../core/crypto/btcCycleOverlay";

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