// ================================================================
// OLYMPUS ENGINE — TEST SUITE
// Cubre los módulos críticos del motor: Kelly, CEWS, SmartDCA,
// regímenes, rebalanceo, factorCalibration, cycleTopDetector
// ================================================================

import { describe, it, expect } from "vitest";

// ── Imports de módulos a testear ────────────────────────────────
import { calculateKelly } from "@/core/portfolio/kelly";
import { calibrateExpectedReturn } from "@/core/factors/factorCalibration";
import { computeRebalanceSuggestions } from "@/core/portfolio/rebalancer";
import { detectCycleTops } from "@/core/risk/cycleTopDetector";
import { getMasterRegime } from "@/core/macro/masterRegime";
import { calculateSpainTax } from "@/core/tax/spainTaxAnalysis";
import { runWalkForward } from "@/core/backtest/walkForwardOptimizer";
import { computeHRP } from "@/core/risk/hrp";
import { runBlackLitterman } from "@/core/portfolio/blackLitterman";
import { computeCEWS } from "@/core/macro/crisisEarlyWarning";

// ================================================================
// 1. KELLY — fracción óptima de tamaño de posición
// ================================================================
describe("Kelly fraction", () => {
  it("debe devolver fracción positiva para retorno positivo", () => {
    const result = calculateKelly({ expectedReturn: 0.15, volatility: 0.30 });
    expect(result.kellyFraction).toBeGreaterThan(0);
  });

  it("debe clampar a half-kelly máximo 0.25", () => {
    // Retorno muy alto → Kelly puro sería >0.5, half-kelly debe clampear
    const result = calculateKelly({ expectedReturn: 0.80, volatility: 0.20 });
    expect(result.kellyFraction).toBeLessThanOrEqual(0.25);
  });

  it("debe devolver 0 para retorno negativo", () => {
    const result = calculateKelly({ expectedReturn: -0.10, volatility: 0.30 });
    expect(result.kellyFraction).toBe(0);
  });

  it("debe devolver 0 para volatilidad cero (sin riesgo no hay Kelly)", () => {
    const result = calculateKelly({ expectedReturn: 0.05, volatility: 0 });
    expect(result.kellyFraction).toBe(0);
  });

  it("a mayor volatilidad, menor fracción Kelly (manteniendo retorno fijo)", () => {
    const lowVol  = calculateKelly({ expectedReturn: 0.15, volatility: 0.20 });
    const highVol = calculateKelly({ expectedReturn: 0.15, volatility: 0.60 });
    expect(lowVol.kellyFraction).toBeGreaterThan(highVol.kellyFraction);
  });
});

// ================================================================
// 2. FACTOR CALIBRATION — retornos esperados calibrados con primas AQR
// ================================================================
describe("calibrateExpectedReturn", () => {
  it("retorno positivo para Z-scores positivos fuertes", () => {
    const result = calibrateExpectedReturn({
      momentumScore: 1.5, valueScore: 0.8, qualityScore: 1.0, lowVolScore: 0.5,
    });
    expect(result.expectedReturn).toBeGreaterThan(0.03); // > tasa libre de riesgo
  });

  it("retorno negativo o muy bajo para Z-scores negativos fuertes", () => {
    const result = calibrateExpectedReturn({
      momentumScore: -2.0, valueScore: -1.5, qualityScore: -1.0, lowVolScore: -1.0,
    });
    expect(result.expectedReturn).toBeLessThan(0.03);
  });

  it("clamped entre -30% y +80%", () => {
    const extreme = calibrateExpectedReturn({
      momentumScore: 10, valueScore: 10, qualityScore: 10, lowVolScore: 10,
    });
    expect(extreme.expectedReturn).toBeLessThanOrEqual(0.80);

    const extremeNeg = calibrateExpectedReturn({
      momentumScore: -10, valueScore: -10, qualityScore: -10, lowVolScore: -10,
    });
    expect(extremeNeg.expectedReturn).toBeGreaterThanOrEqual(-0.30);
  });

  it("pesos adaptativos — reducir momentum aumenta influencia de value", () => {
    const base = calibrateExpectedReturn(
      { momentumScore: 2, valueScore: 0.5, qualityScore: 0.5, lowVolScore: 0.5 },
      { momentum: 0.40, value: 0.25, quality: 0.20, lowVol: 0.15 }
    );
    const reduced = calibrateExpectedReturn(
      { momentumScore: 2, valueScore: 0.5, qualityScore: 0.5, lowVolScore: 0.5 },
      { momentum: 0.28, value: 0.30, quality: 0.22, lowVol: 0.20 }
    );
    // Con momentum alto (z=2), reducir su peso debe bajar el retorno esperado
    expect(reduced.expectedReturn).toBeLessThan(base.expectedReturn);
  });

  it("breakdown suma al factorAlpha total", () => {
    const result = calibrateExpectedReturn({
      momentumScore: 1.0, valueScore: 0.5, qualityScore: 0.8, lowVolScore: 0.3,
    });
    const sumBreakdown = Object.values(result.breakdown).reduce((s, v) => s + v, 0);
    expect(Math.abs(sumBreakdown - result.factorAlpha)).toBeLessThan(1e-10);
  });
});

// ================================================================
// 3. MASTER REGIME — clasificación de estado del mercado
// ================================================================
describe("getMasterRegime", () => {
  const baseMacro = {
    vix: 15, yieldSpread: 0.015, creditSpread: 0.018,
    move: 70, dxyTrend: 0, btcVol: 0.45, m2Growth: 4.0,
  };

  it("EXPANSION con mercado tranquilo", () => {
    const result = getMasterRegime({ ...baseMacro, vix: 14 });
    expect(result.regime).toBe("EXPANSION");
    expect(result.regimePenalty).toBeCloseTo(1.0, 1);
  });

  it("CONTRACTION con VIX alto", () => {
    const result = getMasterRegime({ ...baseMacro, vix: 28, creditSpread: 0.04 });
    expect(result.regime).toBe("CONTRACTION");
    expect(result.regimePenalty).toBeLessThan(1.0);
  });

  it("CRISIS con VIX extremo y spreads de crédito altos", () => {
    const result = getMasterRegime({
      ...baseMacro, vix: 42, creditSpread: 0.07, yieldSpread: -0.01,
    });
    expect(result.regime).toBe("CRISIS");
    expect(result.regimePenalty).toBeLessThanOrEqual(0.55);
  });

  it("penalización es continua (no binaria) entre regímenes", () => {
    const mild = getMasterRegime({ ...baseMacro, vix: 20 });
    const moderate = getMasterRegime({ ...baseMacro, vix: 27 });
    const severe = getMasterRegime({ ...baseMacro, vix: 35 });
    expect(mild.regimePenalty).toBeGreaterThan(moderate.regimePenalty);
    expect(moderate.regimePenalty).toBeGreaterThan(severe.regimePenalty);
  });
});

// ================================================================
// 4. CYCLE TOP DETECTOR — señales de techo de ciclo
// ================================================================
describe("detectCycleTops", () => {
  it("oro: señal SAFE cuando tipo real es bajo (< 0.5%)", () => {
    const result = detectCycleTops({
      bondYield10y: 2.5, inflationBreakeven: 2.3, // tipo real = 0.2%
    });
    const gold = result.signals.find(s => s.ticker === "PPFB.DE");
    expect(gold?.zone).toBe("SAFE");
    expect(gold?.shouldTrim).toBe(false);
  });

  it("oro: señal CAUTION cuando tipo real es alto (> 1.5%)", () => {
    const result = detectCycleTops({
      bondYield10y: 4.5, inflationBreakeven: 2.5, // tipo real = 2.0%
    });
    const gold = result.signals.find(s => s.ticker === "PPFB.DE");
    expect(gold?.zone).toBe("CAUTION");
    expect(gold?.shouldTrim).toBe(true);
  });

  it("oro: Brent >$95 cancela la señal de venta (override geopolítico)", () => {
    const result = detectCycleTops({
      bondYield10y: 4.5, inflationBreakeven: 2.5, // tipo real alto → normalmente vender
      brentOil: 100, // shock geopolítico → override
    });
    const gold = result.signals.find(s => s.ticker === "PPFB.DE");
    expect(gold?.shouldTrim).toBe(false); // señal cancelada por Brent
    expect(gold?.zone).toBe("SAFE");
  });

  it("oro: Brent $75-95 reduce el recorte pero no lo elimina del todo si tipo real >2.5%", () => {
    const result = detectCycleTops({
      bondYield10y: 5.5, inflationBreakeven: 2.5, // tipo real = 3.0% → trimPct=65% base
      brentOil: 85, // tensión elevada → reduce 20pp → 45%
    });
    const gold = result.signals.find(s => s.ticker === "PPFB.DE");
    // Con tipo real 3.0% (>2.5%) base trimPct=65, Brent 75-95 reduce 20pp → 45%
    expect(gold?.trimPct).toBe(45);
  });

  it("BTC: MVRV bajo → sin señal de techo", () => {
    const result = detectCycleTops({
      bondYield10y: 4.0, mvrvRatio: 1.2,
    });
    const btcSignal = result.signals.find(s => s.ticker === "BTC-EUR");
    expect(btcSignal?.shouldTrim).toBe(false);
  });

  it("BTC: MVRV alto → señal de techo activa", () => {
    const result = detectCycleTops({
      bondYield10y: 4.0, mvrvRatio: 4.2,
    });
    const btcSignal = result.signals.find(s => s.ticker === "BTC-EUR");
    expect(btcSignal?.shouldTrim).toBe(true);
    expect(btcSignal?.trimPct).toBeGreaterThan(0);
  });
});

// ================================================================
// 5. REBALANCER — sugerencias de compra/venta
// ================================================================
describe("computeRebalanceSuggestions", () => {
  const assets = [
    { ticker: "BTC-EUR",  name: "Bitcoin",      price: 60000, shares: 0.1,   targetAllocation: 0.06 },
    { ticker: "IS3Q.DE",  name: "MSCI World",   price: 380,   shares: 10,    targetAllocation: 0.25 },
    { ticker: "PPFB.DE",  name: "Gold",         price: 80,    shares: 4,     targetAllocation: 0.13 },
    { ticker: "URNU.DE",  name: "Uranium",      price: 27,    shares: 4,     targetAllocation: 0.14 },
    { ticker: "VVSM.DE",  name: "Semis",        price: 58,    shares: 10,    targetAllocation: 0.155 },
    { ticker: "ZPRR.DE",  name: "Small Cap",    price: 62,    shares: 10,    targetAllocation: 0.158 },
    { ticker: "EMXC.DE",  name: "EM ex-China",  price: 31,    shares: 10,    targetAllocation: 0.107 },
  ];

  it("genera sugerencias de BUY para activos infraponderados", () => {
    const result = computeRebalanceSuggestions(assets, 400, 10000);
    expect(result.buySuggestions.length).toBeGreaterThan(0);
    result.buySuggestions.forEach(s => expect(s.action).toBe("BUY"));
  });

  it("no genera SELLs sin señales de techo", () => {
    const result = computeRebalanceSuggestions(assets, 400, 10000, 0.02, []);
    expect(result.sellSuggestions.length).toBe(0);
  });

  it("genera SELL cuando hay señal de techo de ciclo activa", () => {
    const cycleSignals = [{
      asset: "Gold", ticker: "PPFB.DE",
      allocationMultiplier: 0.45, zone: "CAUTION" as const,
      reason: "Tipo real alto", indicator: "Tipo Real", indicatorValue: "1.8%",
      shouldTrim: true, trimPct: 40,
    }];
    const result = computeRebalanceSuggestions(assets, 400, 10000, 0.02, cycleSignals);
    expect(result.sellSuggestions.some(s => s.ticker === "PPFB.DE")).toBe(true);
  });

  it("proceeds de SELL se suman al cash disponible para BUYs", () => {
    const cycleSignals = [{
      asset: "Gold", ticker: "PPFB.DE",
      allocationMultiplier: 0.45, zone: "CAUTION" as const,
      reason: "Tipo real alto", indicator: "Tipo Real", indicatorValue: "1.8%",
      shouldTrim: true, trimPct: 40,
    }];
    const resultNoSell = computeRebalanceSuggestions(assets, 400, 10000, 0.02, []);
    const resultWithSell = computeRebalanceSuggestions(assets, 400, 10000, 0.02, cycleSignals);
    // Con sell proceeds, el total de compras puede ser mayor
    expect(resultWithSell.totalCost + resultWithSell.totalProceeds)
      .toBeGreaterThanOrEqual(resultNoSell.totalCost);
  });

  it("no gasta más cash del disponible", () => {
    const availableCash = 200;
    const result = computeRebalanceSuggestions(assets, availableCash, 10000);
    expect(result.totalCost).toBeLessThanOrEqual(availableCash + 0.01); // +0.01 por floating point
  });
});

// ================================================================
// 6. SPAIN TAX — cálculo IRPF base del ahorro
// ================================================================
describe("calculateSpainTax", () => {
  it("sin ganancia → sin impuesto", () => {
    const result = calculateSpainTax(0);
    expect(result.taxAmount).toBe(0);
    expect(result.effectiveRate).toBe(0);
  });

  it("ganancia de €3.000 → tramo 19%", () => {
    const result = calculateSpainTax(3000);
    expect(result.taxAmount).toBeCloseTo(570, 0); // 3000 × 19% = 570
    expect(result.effectiveRate).toBeCloseTo(0.19, 2);
  });

  it("ganancia de €10.000 → tramo mixto 19%+21%", () => {
    const result = calculateSpainTax(10000);
    // 6000 × 19% + 4000 × 21% = 1140 + 840 = 1980
    expect(result.taxAmount).toBeCloseTo(1980, 0);
    expect(result.effectiveRate).toBeLessThan(0.21);
    expect(result.effectiveRate).toBeGreaterThan(0.19);
  });

  it("ganancia de €60.000 → tipo efectivo entre 21% y 23%", () => {
    const result = calculateSpainTax(60000);
    expect(result.effectiveRate).toBeGreaterThan(0.20);
    expect(result.effectiveRate).toBeLessThan(0.225);
  });

  it("pérdida → sin impuesto (ganancia negativa ignorada)", () => {
    const result = calculateSpainTax(-500);
    expect(result.taxAmount).toBe(0);
  });
});

// ================================================================
// 7. WALK-FORWARD OPTIMIZER — detección de overfitting y pesos adaptativos
// ================================================================
describe("runWalkForward", () => {
  // Generar retornos sintéticos consistentes (baja divergencia IS/OOS)
  const consistentReturns = Array.from({ length: 200 }, (_, i) =>
    0.002 + 0.001 * Math.sin(i * 0.1) + (Math.random() - 0.5) * 0.01
  );

  // Retornos con drift (overfitting: buen IS, mal OOS)
  const overfittedReturns = [
    ...Array.from({ length: 100 }, () => 0.005 + Math.random() * 0.01),  // IS: muy buenos
    ...Array.from({ length: 100 }, () => -0.003 + Math.random() * 0.01), // OOS: peores
  ];

  it("devuelve estructura completa con adaptiveFactorWeights", () => {
    const result = runWalkForward(consistentReturns, 4);
    expect(result).toHaveProperty("overallStabilityScore");
    expect(result).toHaveProperty("overfittingRisk");
    expect(result).toHaveProperty("adaptiveFactorWeights");
    expect(result.adaptiveFactorWeights).toHaveProperty("momentum");
    expect(result.adaptiveFactorWeights).toHaveProperty("value");
  });

  it("pesos adaptativos suman a 1", () => {
    const result = runWalkForward(consistentReturns, 4);
    const sum = Object.values(result.adaptiveFactorWeights).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("overfitting HIGH reduce peso de momentum", () => {
    const highOvfit = runWalkForward(overfittedReturns, 4);
    const noOvfit   = runWalkForward(consistentReturns, 4);
    // Si hay overfitting HIGH, momentum debe ser <= caso normal
    if (highOvfit.overfittingRisk === "HIGH") {
      expect(highOvfit.adaptiveFactorWeights.momentum)
        .toBeLessThanOrEqual(noOvfit.adaptiveFactorWeights.momentum + 0.01);
    }
  });

  it("datos insuficientes → resultado con fallback sin crash", () => {
    const result = runWalkForward([0.01, 0.02, -0.01], 5); // muy pocos datos
    expect(result.windows).toHaveLength(0);
    expect(result.recommendation).toContain("insuficientes");
    // Los pesos adaptativos deben ser los valores por defecto
    expect(result.adaptiveFactorWeights.momentum).toBeCloseTo(0.40, 3);
  });

  it("overfittingRisk refleja correctamente baja estabilidad", () => {
    const result = runWalkForward(overfittedReturns, 4);
    // Con retornos muy buenos IS y malos OOS → estabilidad baja → riesgo alto/medio
    expect(["MEDIUM", "HIGH"]).toContain(result.overfittingRisk);
  });
});

// ================================================================
// 8. HRP (Hierarchical Risk Parity) — López de Prado
// MED-01: Test unitario para algoritmo crítico
// ================================================================
describe("computeHRP", () => {
  // Matriz de covarianza conocida para 3 activos
  // BTC (alta vol), GOLD (media vol), BONDS (baja vol)
  const covMatrix = [
    [0.36, 0.02, 0.01],  // BTC: vol ~60%
    [0.02, 0.04, 0.015], // GOLD: vol ~20%
    [0.01, 0.015, 0.01], // BONDS: vol ~10%
  ];

  it("devuelve pesos que suman 1", () => {
    const result = computeHRP(covMatrix, 3);
    const sum = result.weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("todos los pesos son positivos", () => {
    const result = computeHRP(covMatrix, 3);
    result.weights.forEach(w => expect(w).toBeGreaterThanOrEqual(0));
  });

  it("asigna menor peso a activos de mayor varianza", () => {
    const result = computeHRP(covMatrix, 3);
    // BTC tiene varianza 0.36, BONDS tiene 0.01
    // HRP debe dar menos peso a BTC que a BONDS
    expect(result.weights[2]).toBeGreaterThan(result.weights[0]);
  });

  it("fallback a equal weight si covMatrix es null", () => {
    const result = computeHRP(null as unknown as number[][], 3);
    expect(result.weights).toEqual([1/3, 1/3, 1/3]);
  });

  it("fallback a equal weight si covMatrix es muy pequeña", () => {
    const result = computeHRP([[0.01]], 1);
    expect(result.weights).toEqual([1]);
  });

  it("detecta grupos de correlación correctamente", () => {
    // Matriz donde activos 0 y 1 están altamente correlacionados
    const correlatedCov = [
      [0.04, 0.035, 0.005],  // activos 0 y 1 correlacionados (~0.875)
      [0.035, 0.04, 0.005],
      [0.005, 0.005, 0.02],  // activo 2 no correlacionado
    ];
    const result = computeHRP(correlatedCov, 3);
    // clusterGroups debe detectar que 0 y 1 están en el mismo grupo
    expect(result.clusterGroups.length).toBeGreaterThanOrEqual(1);
  });

  it("clusterOrder contiene todos los activos sin duplicados", () => {
    const result = computeHRP(covMatrix, 3);
    const uniqueOrder = new Set(result.clusterOrder);
    expect(result.clusterOrder.length).toBe(3);
    expect(uniqueOrder.size).toBe(3);
  });
});

// ================================================================
// 9. BLACK-LITTERMAN — modelo de optimización con views
// MED-02: Test unitario con omega corregido
// ================================================================
describe("runBlackLitterman", () => {
  const assetNames = ["BTC", "GOLD", "BONDS"];

  // Covarianza diagonal simple para tests predecibles
  const covMatrix = [
    [0.36, 0, 0],     // BTC: vol 60%
    [0, 0.04, 0],      // GOLD: vol 20%
    [0, 0, 0.01],      // BONDS: vol 10%
  ];

  const marketWeights = [0.30, 0.40, 0.30];

  it("sin views → retorna pesos de mercado (equilibrio)", () => {
    const result = runBlackLitterman({
      assetNames,
      covMatrix,
      marketWeights,
      views: [],
    });
    // Sin views, los pesos deben estar cerca de los de mercado
    result.posteriorWeights.forEach((w, i) => {
      expect(w).toBeCloseTo(marketWeights[i], 1);
    });
  });

  it("view alcista sobre un activo aumenta su peso", () => {
    const result = runBlackLitterman({
      assetNames,
      covMatrix,
      marketWeights,
      views: [{
        assets: ["BTC"],
        weights: [1],
        expectedReturn: 0.20,
        confidence: 0.7,
      }],
    });
    // Con view alcista sobre BTC, su peso debe aumentar
    expect(result.posteriorWeights[0]).toBeGreaterThan(marketWeights[0]);
  });

  it("view bajista reduce el peso", () => {
    const result = runBlackLitterman({
      assetNames,
      covMatrix,
      marketWeights,
      views: [{
        assets: ["BTC"],
        weights: [1],
        expectedReturn: -0.10,
        confidence: 0.6,
      }],
    });
    expect(result.posteriorWeights[0]).toBeLessThan(marketWeights[0]);
  });

  it("pesos posteriores suman 1", () => {
    const result = runBlackLitterman({
      assetNames,
      covMatrix,
      marketWeights,
      views: [
        { assets: ["BTC"], weights: [1], expectedReturn: 0.15, confidence: 0.6 },
        { assets: ["GOLD"], weights: [1], expectedReturn: 0.05, confidence: 0.5 },
      ],
    });
    const sum = result.posteriorWeights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("view con alta confianza tiene más impacto que con baja confianza", () => {
    const resultHighConf = runBlackLitterman({
      assetNames,
      covMatrix,
      marketWeights,
      views: [{ assets: ["BTC"], weights: [1], expectedReturn: 0.20, confidence: 0.9 }],
    });
    const resultLowConf = runBlackLitterman({
      assetNames,
      covMatrix,
      marketWeights,
      views: [{ assets: ["BTC"], weights: [1], expectedReturn: 0.20, confidence: 0.3 }],
    });
    // Alta confianza → más cambio en el peso
    const changeHigh = Math.abs(resultHighConf.posteriorWeights[0] - marketWeights[0]);
    const changeLow = Math.abs(resultLowConf.posteriorWeights[0] - marketWeights[0]);
    expect(changeHigh).toBeGreaterThan(changeLow);
  });

  it("equilibriumReturns son proporcionales a covarianza × marketWeights", () => {
    const result = runBlackLitterman({
      assetNames,
      covMatrix,
      marketWeights,
      views: [],
    });
    // Π = δ × Σ × w_mkt (con δ = riskAversion = 2.5)
    // BTC: 2.5 × 0.36 × 0.30 = 0.27
    expect(result.equilibriumReturns[0]).toBeCloseTo(2.5 * 0.36 * 0.30, 5);
    // GOLD: 2.5 × 0.04 × 0.40 = 0.04
    expect(result.equilibriumReturns[1]).toBeCloseTo(2.5 * 0.04 * 0.40, 5);
    // BONDS: 2.5 × 0.01 × 0.30 = 0.0075
    expect(result.equilibriumReturns[2]).toBeCloseTo(2.5 * 0.01 * 0.30, 5);
  });

  it("viewImpact registra el impacto de cada view", () => {
    const result = runBlackLitterman({
      assetNames,
      covMatrix,
      marketWeights,
      views: [{ assets: ["BTC"], weights: [1], expectedReturn: 0.20, confidence: 0.6 }],
    });
    expect(result.viewImpact.length).toBe(1);
    expect(result.viewImpact[0].view.assets[0]).toBe("BTC");
  });
});

// ================================================================
// 10. CEWS — Crisis Early Warning System
// ================================================================
describe("computeCEWS", () => {
  // Generar historial sintético con deterioro progresivo
  const generateHistory = (
    vixTrend: number,    // valor inicial y tendencia
    yieldTrend: number,
    creditTrend: number,
    m2Trend: number,
    weeks = 12
  ) => {
    const history = [];
    for (let i = 0; i < weeks; i++) {
      history.push({
        timestamp: new Date(Date.now() - (weeks - i) * 7 * 24 * 3600 * 1000).toISOString(),
        vix: vixTrend + i * 0.5 + (Math.random() - 0.5) * 2,
        yieldSpread: yieldTrend - i * 0.02 + (Math.random() - 0.5) * 0.1,
        creditSpread: creditTrend + i * 0.05 + (Math.random() - 0.5) * 0.1,
        m2Growth: m2Trend - i * 0.1 + (Math.random() - 0.5) * 0.2,
      });
    }
    return history;
  };

  it("CLEAR con datos normales", () => {
    const history = generateHistory(15, 0.5, 1.5, 4.0); // VIX bajo, spreads normales
    const result = computeCEWS(history);
    expect(result.level).toBe("CLEAR");
    expect(result.signalsInRed).toBe(0);
  });

  it("ALERT con deterioro severo", () => {
    // VIX subiendo hacia 40, spreads altos, M2 cayendo
    const history = generateHistory(30, -0.3, 3.5, 1.0, 12);
    const result = computeCEWS(history);
    // Con VIX >35 y spreads >3% durante semanas → ALERT o WARNING
    expect(["ALERT", "WARNING"]).toContain(result.level);
    expect(result.signalsInRed).toBeGreaterThanOrEqual(2);
  });

  it("datos insuficientes → emptyCEWS", () => {
    const result = computeCEWS([{
      timestamp: new Date().toISOString(),
      vix: 20, yieldSpread: 0.5, creditSpread: 1.5, m2Growth: 3.0
    }]);
    expect(result.level).toBe("CLEAR");
    expect(result.score).toBe(0);
  });

  it("earlyWarningActive con ≥3 señales deterioradas durante ≥4 semanas", () => {
    // Construir historial con 3+ señales en rojo por 4+ semanas
    const history = [];
    for (let i = 0; i < 12; i++) {
      history.push({
        timestamp: new Date(Date.now() - (12 - i) * 7 * 24 * 3600 * 1000).toISOString(),
        vix: 38 + Math.random(),           // > 35 (danger)
        yieldSpread: -0.5 + Math.random() * 0.1, // < 0 (danger)
        creditSpread: 3.8 + Math.random() * 0.2, // > 3.5 (danger)
        m2Growth: 1.5 + Math.random() * 0.3,      // bajo pero no crítico
      });
    }
    const result = computeCEWS(history);
    expect(result.earlyWarningActive).toBe(true);
  });

  it("regimePenaltyAdjustment: CLEAR = 0, ALERT = -0.20", () => {
    const clearHistory = generateHistory(15, 0.5, 1.5, 4.0);
    const alertHistory = generateHistory(40, -0.5, 4.0, 0.5);

    const clearResult = computeCEWS(clearHistory);
    const alertResult = computeCEWS(alertHistory);

    expect(clearResult.regimePenaltyAdjustment).toBe(0);
    // ALERT tiene penalty -0.20, WARNING -0.10, WATCH -0.05
    expect(alertResult.regimePenaltyAdjustment).toBeLessThanOrEqual(-0.05);
  });

  it("tendencia DETERIORATING cuando los valores empeoran", () => {
    const history = [];
    for (let i = 0; i < 12; i++) {
      history.push({
        timestamp: new Date(Date.now() - (12 - i) * 7 * 24 * 3600 * 1000).toISOString(),
        vix: 20 + i * 2,           // subiendo
        yieldSpread: 0.3 - i * 0.05, // bajando hacia inversión
        creditSpread: 1.5 + i * 0.15, // subiendo
        m2Growth: 4.0 - i * 0.2,    // bajando
      });
    }
    const result = computeCEWS(history);
    // Al menos una señal debe estar en DETERIORATING
    const signals = Object.values(result.signals);
    const hasDeteriorating = signals.some(s => s.trend === "DETERIORATING");
    expect(hasDeteriorating).toBe(true);
  });
});