// ===============================================
// ARCHIVO: src/core/simulation/monteCarloTarget.ts
// MONTE CARLO CON OBJETIVO DE RETORNO TARGET (15% anual)
// ===============================================
// Calcula la probabilidad de alcanzar un retorno objetivo
// y la asignación óptima para maximizar probabilidad sin
// exceder límites de riesgo (CVaR, drawdown máximo).
//
// METODOLOGÍA:
//   1. Simular 10.000 escenarios con Jump Diffusion (Merton)
//   2. Calcular % de escenarios que superan el target (15%)
//   3. Calcular CVaR del peor 5%
//   4. Optimizar asignación para maximizar P(target) con CVaR < límite
//
// REFERENCIAS:
//   - Merton (1976): Option pricing when underlying returns are discontinuous
//   - Glasserman (2004): Monte Carlo Methods in Financial Engineering
// ===============================================

export interface MonteCarloTargetInput {
  // Parámetros del portfolio
  initialCapital: number;
  monthlyContribution: number;
  years: number;

  // Parámetros de retorno y volatilidad (anualizados)
  expectedReturn: number;    // μ (ej: 0.12 = 12% anual)
  volatility: number;        // σ (ej: 0.20 = 20% anual)

  // Parámetros de salto (para crypto/alta volatilidad)
  jumpIntensity?: number;    // λ: saltos por año (BTC: ~7, portfolio: ~1)
  jumpMean?: number;         // μ_jump: tamaño medio del salto (ej: -0.08)
  jumpStd?: number;          // σ_jump: volatilidad del salto (ej: 0.12)

  // Objetivo y límites de riesgo
  targetReturn?: number;     // retorno anual objetivo (default: 0.15 = 15%)
  maxCVaR?: number;          // CVaR máximo aceptable (default: 0.25 = 25%)
  maxDrawdown?: number;      // drawdown máximo aceptable (default: 0.30 = 30%)

  // Número de simulaciones
  simulations?: number;      // default: 10.000
}

export interface MonteCarloTargetResult {
  // Resultados de la simulación
  meanFinalValue: number;
  medianFinalValue: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;

  // Probabilidad de alcanzar objetivo
  probabilityOfSuccess: number;  // % de escenarios >= target
  probabilityOfFailure: number;  // % de escenarios < target
  targetAnnualReturn: number;    // target usado (anualizado)
  targetFinalValue: number;      // valor final objetivo en euros

  // Métricas de riesgo
  var95: number;           // Value at Risk 95% (en euros)
  cvar95: number;          // Conditional VaR 95% (en euros)
  cvar95Percent: number;   // CVaR 95% en % del capital
  maxDrawdownSimulated: number;

  // Clasificación de escenarios
  scenarios: {
    excellent: number;   // > target + 5%
    good: number;        // >= target
    moderate: number;    // 0% a target
    negative: number;    // -20% a 0%
    crash: number;       // < -20%
  };

  // Recomendación
  recommendation: string;
  isFeasible: boolean;   // true si P(success) >= 50% y CVaR < límite
  riskAdjustedScore: number;  // [0-100] score combinado retorno/riesgo
}

/**
 * Genera número aleatorio con distribución normal estándar
 */
function randomNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Simulación Monte Carlo con Jump Diffusion (Merton)
 * Discretización mensual para correcta modelización de Poisson
 */
function runMonteCarloSimulation(input: MonteCarloTargetInput): {
  finalValues: number[];
  returns: number[];
  mean: number;
  median: number;
} {
  const {
    initialCapital,
    monthlyContribution,
    years,
    expectedReturn,
    volatility,
    jumpIntensity = 1.0,
    jumpMean = -0.05,
    jumpStd = 0.10,
    simulations = 10000,
  } = input;

  const months = years * 12;
  const dt = 1 / 12;  // paso mensual

  const finalValues: number[] = [];

  for (let sim = 0; sim < simulations; sim++) {
    let value = initialCapital;

    for (let m = 0; m < months; m++) {
      // Aporte mensual
      value += monthlyContribution;

      // Componente de difusión (GBM)
      const diffusion = (expectedReturn - 0.5 * volatility ** 2) * dt
        + volatility * Math.sqrt(dt) * randomNormal();

      // Componente de salto (Poisson con λ*dt)
      const jumpOccurred = Math.random() < (1 - Math.exp(-jumpIntensity * dt));
      const jump = jumpOccurred ? jumpMean + jumpStd * randomNormal() : 0;

      value = value * Math.exp(diffusion + jump);
    }

    finalValues.push(value);
  }

  finalValues.sort((a, b) => a - b);

  const mean = finalValues.reduce((a, b) => a + b, 0) / simulations;
  const median = finalValues[Math.floor(simulations * 0.50)];

  return { finalValues, mean, median, returns: finalValues.map(v => v / initialCapital - 1) };
}

/**
 * Calcula CVaR (Conditional Value at Risk) en euros y porcentaje
 * El porcentaje se calcula respecto al capital total invertido (inicial + aportes)
 */
function calculateCVaREuros(
  finalValues: number[],
  initialCapital: number,
  monthlyContribution: number,
  years: number,
  confidence = 0.95
): {
  var95: number;
  cvar95: number;
  cvar95Percent: number;
} {
  const n = finalValues.length;
  const totalInvested = initialCapital + monthlyContribution * 12 * years;
  const var95Idx = Math.floor(n * (1 - confidence));
  const var95 = finalValues[var95Idx];
  const tail = finalValues.slice(0, var95Idx + 1);
  const cvar95 = tail.reduce((a, b) => a + b, 0) / tail.length;
  // CVaR en porcentaje: pérdida desde el capital total invertido
  const cvar95Percent = totalInvested > 0 ? (totalInvested - cvar95) / totalInvested : 0;

  return {
    var95,
    cvar95,
    cvar95Percent,
  };
}

/**
 * Calcula el valor final objetivo basado en el retorno anual target
 */
function calculateTargetValue(
  initialCapital: number,
  monthlyContribution: number,
  years: number,
  targetAnnualReturn: number
): number {
  // Fórmula de valor futuro con aportes mensuales
  const monthlyRate = targetAnnualReturn / 12;
  const months = years * 12;

  // Valor futuro del capital inicial
  const fvInitial = initialCapital * Math.pow(1 + targetAnnualReturn, years);

  // Valor futuro de los aportes mensuales
  const fvContributions = monthlyContribution *
    ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);

  return fvInitial + fvContributions;
}

/**
 * Clasifica escenarios en categorías
 */
function classifyScenarios(
  finalValues: number[],
  initialCapital: number,
  monthlyContribution: number,
  years: number,
  targetReturn: number
): {
  excellent: number;
  good: number;
  moderate: number;
  negative: number;
  crash: number;
} {
  const totalInvested = initialCapital + monthlyContribution * 12 * years;
  const targetValue = calculateTargetValue(initialCapital, monthlyContribution, years, targetReturn);
  const targetValueHigh = calculateTargetValue(initialCapital, monthlyContribution, years, targetReturn + 0.05);

  let excellent = 0, good = 0, moderate = 0, negative = 0, crash = 0;

  for (const value of finalValues) {
    const totalReturn = (value - totalInvested) / totalInvested;

    if (value >= targetValueHigh) {
      excellent++;
    } else if (value >= targetValue) {
      good++;
    } else if (value >= totalInvested) {
      moderate++;
    } else if (value >= totalInvested * 0.80) {
      negative++;
    } else {
      crash++;
    }
  }

  const n = finalValues.length;
  return {
    excellent: excellent / n,
    good: good / n,
    moderate: moderate / n,
    negative: negative / n,
    crash: crash / n,
  };
}

/**
 * Calcula el drawdown máximo simulado (aproximado)
 */
function estimateMaxDrawdown(
  volatility: number,
  jumpIntensity: number,
  jumpMean: number,
  years: number
): number {
  // Aproximación basada en volatilidad y saltos
  // DD máximo ≈ 2σ * sqrt(T) + jumps esperados * |jumpMean|
  const volComponent = 2 * volatility * Math.sqrt(years);
  const jumpComponent = jumpIntensity * years * Math.abs(jumpMean);
  return Math.min(0.80, volComponent + jumpComponent);
}

/**
 * Genera recomendación basada en resultados
 */
function buildRecommendation(
  probabilityOfSuccess: number,
  cvar95Percent: number,
  maxCVaR: number,
  targetReturn: number,
  expectedReturn: number
): string {
  const parts: string[] = [];

  if (probabilityOfSuccess >= 0.70) {
    parts.push(`✅ Alta probabilidad (${(probabilityOfSuccess * 100).toFixed(0)}%) de alcanzar el ${Math.round(targetReturn * 100)}% anual.`);
  } else if (probabilityOfSuccess >= 0.50) {
    parts.push(`⚠️ Probabilidad moderada (${(probabilityOfSuccess * 100).toFixed(0)}%) de alcanzar el objetivo.`);
  } else {
    parts.push(`❌ Baja probabilidad (${(probabilityOfSuccess * 100).toFixed(0)}%) de alcanzar el ${Math.round(targetReturn * 100)}% anual.`);
  }

  if (cvar95Percent > maxCVaR) {
    parts.push(`⚠️ CVaR ${(cvar95Percent * 100).toFixed(0)}% supera límite de ${(maxCVaR * 100).toFixed(0)}%. Considerar reducir riesgo.`);
  } else {
    parts.push(`✅ CVaR ${(cvar95Percent * 100).toFixed(0)}% dentro de límites aceptables.`);
  }

  if (expectedReturn < targetReturn * 0.80) {
    parts.push(`📉 Retorno esperado ${(expectedReturn * 100).toFixed(1)}% está por debajo del target. Revisar asignación.`);
  }

  return parts.join(' ');
}

/**
 * FUNCIÓN PRINCIPAL: Monte Carlo con análisis de objetivo
 */
export function runMonteCarloWithTarget(input: MonteCarloTargetInput): MonteCarloTargetResult {
  const {
    initialCapital,
    monthlyContribution,
    years,
    expectedReturn,
    volatility,
    jumpIntensity = 1.0,
    jumpMean = -0.05,
    jumpStd = 0.10,
    targetReturn = 0.15,
    maxCVaR = 0.25,
    maxDrawdown = 0.30,
    simulations = 10000,
  } = input;

  // Ejecutar simulación
  const { finalValues, mean, median } = runMonteCarloSimulation({
    ...input,
    simulations,
  });

  // Calcular valor objetivo
  const targetFinalValue = calculateTargetValue(initialCapital, monthlyContribution, years, targetReturn);

  // Calcular probabilidad de éxito
  const successfulScenarios = finalValues.filter(v => v >= targetFinalValue).length;
  const probabilityOfSuccess = successfulScenarios / finalValues.length;
  const probabilityOfFailure = 1 - probabilityOfSuccess;

  // Calcular CVaR
  const { var95, cvar95, cvar95Percent } = calculateCVaREuros(finalValues, initialCapital, monthlyContribution, years);

  // Clasificar escenarios
  const scenarios = classifyScenarios(finalValues, initialCapital, monthlyContribution, years, targetReturn);

  // Drawdown máximo estimado
  const maxDrawdownSimulated = estimateMaxDrawdown(volatility, jumpIntensity, jumpMean, years);

  // Score ajustado al riesgo [0-100]
  const riskAdjustedScore = Math.round(
    Math.max(0, Math.min(100,
      probabilityOfSuccess * 60 +  // 60% peso en probabilidad de éxito
      (1 - cvar95Percent / maxCVaR) * 30 +  // 30% peso en CVaR
      (1 - maxDrawdownSimulated / maxDrawdown) * 10  // 10% peso en drawdown
    ))
  );

  // Determinar viabilidad
  const isFeasible = probabilityOfSuccess >= 0.50 && cvar95Percent <= maxCVaR;

  // Recomendación
  const recommendation = buildRecommendation(probabilityOfSuccess, cvar95Percent, maxCVaR, targetReturn, expectedReturn);

  return {
    meanFinalValue: mean,
    medianFinalValue: median,
    p25: finalValues[Math.floor(simulations * 0.25)],
    p75: finalValues[Math.floor(simulations * 0.75)],
    p10: finalValues[Math.floor(simulations * 0.10)],
    p90: finalValues[Math.floor(simulations * 0.90)],
    probabilityOfSuccess,
    probabilityOfFailure,
    targetAnnualReturn: targetReturn,
    targetFinalValue,
    var95,
    cvar95,
    cvar95Percent,
    maxDrawdownSimulated,
    scenarios,
    recommendation,
    isFeasible,
    riskAdjustedScore,
  };
}

/**
 * Optimiza la asignación para maximizar probabilidad de alcanzar target
 * con CVaR dentro de límites
 */
export function optimizeAllocationForTarget(
  baseInput: Omit<MonteCarloTargetInput, 'expectedReturn' | 'volatility'>,
  allocationOptions: { expectedReturn: number; volatility: number; label: string }[]
): {
  bestAllocation: { label: string; expectedReturn: number; volatility: number };
  bestProbability: number;
  bestCVaR: number;
  allResults: { label: string; probability: number; cvar: number; score: number }[];
} {
  const results = allocationOptions.map(option => {
    const result = runMonteCarloWithTarget({
      ...baseInput,
      expectedReturn: option.expectedReturn,
      volatility: option.volatility,
    });
    return {
      label: option.label,
      expectedReturn: option.expectedReturn,
      volatility: option.volatility,
      probability: result.probabilityOfSuccess,
      cvar: result.cvar95Percent,
      score: result.riskAdjustedScore,
    };
  });

  // Ordenar por score (mejor combinación de probabilidad y riesgo)
  results.sort((a, b) => b.score - a.score);

  const best = results[0];

  return {
    bestAllocation: {
      label: best.label,
      expectedReturn: allocationOptions.find(o => o.label === best.label)!.expectedReturn,
      volatility: allocationOptions.find(o => o.label === best.label)!.volatility,
    },
    bestProbability: best.probability,
    bestCVaR: best.cvar,
    allResults: results,
  };
}
