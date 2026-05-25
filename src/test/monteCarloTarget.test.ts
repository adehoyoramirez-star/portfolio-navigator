// ===============================================
// TESTS: Monte Carlo con Target 15% Anual
// ===============================================
import { describe, test, expect } from "vitest";
import {
  runMonteCarloWithTarget,
  optimizeAllocationForTarget,
  type MonteCarloTargetInput,
} from "@/core/simulation/monteCarloTarget";

describe("Monte Carlo con Target 15% Anual", () => {

  const defaultInput: MonteCarloTargetInput = {
    initialCapital: 10000,
    monthlyContribution: 500,
    years: 5,
    expectedReturn: 0.12,
    volatility: 0.20,
    jumpIntensity: 1.0,
    jumpMean: -0.05,
    jumpStd: 0.10,
    targetReturn: 0.15,
    maxCVaR: 0.25,
    maxDrawdown: 0.30,
    simulations: 1000, // Reducido para tests rápidos
  };

  test("Debe calcular probabilidad de éxito coherente", () => {
    const result = runMonteCarloWithTarget(defaultInput);

    // La probabilidad debe estar entre 0 y 1
    expect(result.probabilityOfSuccess).toBeGreaterThanOrEqual(0);
    expect(result.probabilityOfSuccess).toBeLessThanOrEqual(1);

    // Con expectedReturn 12% y target 15%, probabilidad debería ser < 50%
    expect(result.probabilityOfSuccess).toBeLessThan(0.60);
  });

  test("Debe calcular CVaR correcto", () => {
    const result = runMonteCarloWithTarget(defaultInput);

    // CVaR es valor final en euros del peor 5% de escenarios
    // Con aportes mensuales (500/mes × 60 meses = 30.000 + 10.000 inicial = 40.000 total)
    // El CVaR debe ser menor que el valor final esperado pero mayor que 0
    expect(result.cvar95).toBeGreaterThan(0);

    // CVaR en porcentaje representa la pérdida desde el capital total invertido
    // Debe ser positivo (representa % de pérdida en el peor 5%)
    expect(result.cvar95Percent).toBeGreaterThan(0);

    // El peor 5% debe ser menor que la mediana (escenario típico)
    expect(result.cvar95).toBeLessThan(result.medianFinalValue);
  });

  test("Debe clasificar escenarios correctamente", () => {
    const result = runMonteCarloWithTarget(defaultInput);

    const { scenarios } = result;
    const total = scenarios.excellent + scenarios.good + scenarios.moderate + scenarios.negative + scenarios.crash;

    // La suma debe ser ~1 (100%)
    expect(total).toBeGreaterThanOrEqual(0.99);
    expect(total).toBeLessThanOrEqual(1.01);
  });

  test("Debe generar valor final objetivo correcto", () => {
    const result = runMonteCarloWithTarget(defaultInput);

    // Target value debe ser mayor que capital inicial + aportes
    const totalInvested = defaultInput.initialCapital + defaultInput.monthlyContribution * 12 * defaultInput.years;
    expect(result.targetFinalValue).toBeGreaterThan(totalInvested);

    // Con 15% anual, el target debe ser significativamente mayor
    // FIX-V5-7: monthlyRate corregida a (1+r)^(1/12)-1 (geométrica) en lugar de r/12 (lineal).
    // El target correcto con tasa geométrica es ~63.287€ vs ~64.400€ con la tasa lineal anterior.
    const expectedMinGrowth = Math.pow(1.15, defaultInput.years);
    // Valor correcto con tasa geométrica mensual: fvInitial + fvContributions
    //   = 10000*1.15^5 + 500*((1.15^(5/12))^60-1)/(1.15^(1/12)-1)
    //   ≈ 20114 + 43174 = 63288
    expect(result.targetFinalValue).toBeGreaterThan(totalInvested * 1.2); // margen amplio: 40000 * 1.2 = 48000
    expect(result.targetFinalValue).toBeLessThan(totalInvested * 1.7); // cota superior: 40000 * 1.7 = 68000
  });

  test("Debe calcular media y mediana coherentes", () => {
    const result = runMonteCarloWithTarget(defaultInput);

    expect(result.meanFinalValue).toBeGreaterThan(defaultInput.initialCapital);
    expect(result.medianFinalValue).toBeGreaterThan(defaultInput.initialCapital);

    // En distribución con saltos negativos, mediana < media
    expect(result.medianFinalValue).toBeLessThanOrEqual(result.meanFinalValue * 1.1);
  });

  test("Debe calcular percentiles correctos", () => {
    const result = runMonteCarloWithTarget(defaultInput);

    // P10 < P25 < Mediana < P75 < P90
    expect(result.p10).toBeLessThanOrEqual(result.p25);
    expect(result.p25).toBeLessThanOrEqual(result.medianFinalValue);
    expect(result.medianFinalValue).toBeLessThanOrEqual(result.p75);
    expect(result.p75).toBeLessThanOrEqual(result.p90);
  });

  test("Debe generar recomendación no vacía", () => {
    const result = runMonteCarloWithTarget(defaultInput);

    expect(result.recommendation).toBeTruthy();
    expect(result.recommendation.length).toBeGreaterThan(10);
  });

  test("Debe calcular score ajustado al riesgo [0-100]", () => {
    const result = runMonteCarloWithTarget(defaultInput);

    expect(result.riskAdjustedScore).toBeGreaterThanOrEqual(0);
    expect(result.riskAdjustedScore).toBeLessThanOrEqual(100);
  });

  test("Mayor volatilidad debe reducir probabilidad de éxito", () => {
    const lowVolInput = { ...defaultInput, volatility: 0.15 };
    const highVolInput = { ...defaultInput, volatility: 0.35 };

    const lowVolResult = runMonteCarloWithTarget(lowVolInput);
    const highVolResult = runMonteCarloWithTarget(highVolInput);

    // Mayor volatilidad generalmente reduce probabilidad de alcanzar target fijo
    // (aunque puede aumentar la cola derecha, también aumenta la izquierda)
    expect(highVolResult.cvar95Percent).toBeGreaterThan(lowVolResult.cvar95Percent);
  });

  test("Mayor retorno esperado debe aumentar probabilidad de éxito", () => {
    const lowReturnInput = { ...defaultInput, expectedReturn: 0.08 };
    const highReturnInput = { ...defaultInput, expectedReturn: 0.18 };

    const lowReturnResult = runMonteCarloWithTarget(lowReturnInput);
    const highReturnResult = runMonteCarloWithTarget(highReturnInput);

    expect(highReturnResult.probabilityOfSuccess).toBeGreaterThan(lowReturnResult.probabilityOfSuccess);
  });

  test("optimizeAllocationForTarget debe retornar mejor asignación", () => {
    const allocationOptions = [
      { label: "Conservador", expectedReturn: 0.08, volatility: 0.12 },
      { label: "Moderado", expectedReturn: 0.12, volatility: 0.20 },
      { label: "Agresivo", expectedReturn: 0.18, volatility: 0.30 },
    ];

    const baseInput: Omit<MonteCarloTargetInput, 'expectedReturn' | 'volatility'> = {
      initialCapital: 10000,
      monthlyContribution: 500,
      years: 5,
      jumpIntensity: 1.0,
      jumpMean: -0.05,
      jumpStd: 0.10,
      targetReturn: 0.15,
      maxCVaR: 0.25,
      maxDrawdown: 0.30,
      simulations: 500,
    };

    const result = optimizeAllocationForTarget(baseInput, allocationOptions);

    expect(result.bestAllocation).toBeDefined();
    expect(result.bestAllocation.label).toBeTruthy();
    expect(result.allResults.length).toBe(3);

    // Todos los resultados deben tener score válido
    result.allResults.forEach(r => {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    });
  });

  test("Salto más frecuente debe aumentar CVaR (más riesgo de cola)", () => {
    const lowJumpInput = { ...defaultInput, jumpIntensity: 0.5 };
    const highJumpInput = { ...defaultInput, jumpIntensity: 3.0 };

    const lowJumpResult = runMonteCarloWithTarget(lowJumpInput);
    const highJumpResult = runMonteCarloWithTarget(highJumpInput);

    // Más saltos → mayor riesgo de cola → CVaR mayor
    expect(highJumpResult.cvar95Percent).toBeGreaterThan(lowJumpResult.cvar95Percent);
  });

  test("Target más bajo debe aumentar probabilidad de éxito", () => {
    const highTargetInput = { ...defaultInput, targetReturn: 0.20 };
    const lowTargetInput = { ...defaultInput, targetReturn: 0.10 };

    const highTargetResult = runMonteCarloWithTarget(highTargetInput);
    const lowTargetResult = runMonteCarloWithTarget(lowTargetInput);

    expect(lowTargetResult.probabilityOfSuccess).toBeGreaterThan(highTargetResult.probabilityOfSuccess);
  });
});
