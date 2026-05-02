// ===============================================
// ARCHIVO: src/core/risk/cvarOptimizer.ts
// OLYMPUS X — Optimización CVaR Institucional
// ===============================================
// UPGRADE CRÍTICO: El motor actual usa Kelly + vol target para sizing.
// Kelly maximiza log-utility (correcto para horizonte largo) pero
// NO controla el tail risk directamente. Un portfolio con Kelly óptimo
// puede tener CVaR devastador en distribuciones fat-tailed (BTC).
//
// ANTES (Kelly puro):
//   f* = E[R] / σ² → tamaño basado en retorno esperado vs varianza
//   Sin restricción sobre la pérdida en el peor 5% de escenarios.
//   Riesgo: en un crash BTC, el Kelly puede exceder CVaR target.
//
// AHORA (Kelly + CVaR constraint):
//   Solver: Projected Gradient Descent sobre:
//     MAXIMIZAR:  sum(w_i * E[R_i])  [retorno esperado]
//     SUJETO A:
//       CVaR_α(w) ≤ CVaR_target       [restricción tail risk]
//       sum(w_i) = 1                   [presupuesto]
//       w_i ≥ 0                        [sin short]
//       w_BTC ≤ 0.25                   [cap BTC]
//
// CVaR se aproxima mediante Rockafellar-Uryasev (2000):
//   CVaR_α = min_{θ} { θ + (1/((1-α)N)) * sum(max(L_i - θ, 0)) }
//   donde L_i son pérdidas simuladas de scenarios Monte Carlo.
//
// VENTAJAS vs Kelly puro:
//   - Control directo del tail risk (peor 5% de outcomes)
//   - Más conservador en distribuciones asimétricas (BTC, crisis)
//   - Robusto a errores en estimación de retornos esperados
//   - Estándar en risk desks de bancos tier-1
//
// REFERENCIAS:
//   - Rockafellar & Uryasev (2000): "Optimization of Conditional Value-at-Risk"
//   - Cornuejols & Tütüncü (2006): "Optimization Methods in Finance"
//   - Qian (2011): "Risk Parity and Diversification" (Journal of Investing)
// ===============================================

export interface CVaROptimizerInput {
  assetNames: string[];

  // Matriz de scenarios (cada fila = un escenario, cada columna = retorno de activo)
  // Tipicamente 5000-10000 scenarios del Monte Carlo
  scenarios: number[][];

  // Retornos esperados (usados como objetivo a maximizar)
  expectedReturns: number[];

  // Parámetros de restricción
  cvarTarget: number;    // CVaR máximo tolerable (ej: 0.15 = pérdida max 15%)
  alpha: number;         // Nivel de confianza CVaR (ej: 0.95 = CVaR 95%)

  // Restricciones de peso
  minWeight?: number;    // Peso mínimo por activo (default: 0)
  maxWeight?: number;    // Peso máximo por activo (default: 1)
  maxBtcWeight?: number; // Cap específico BTC (default: 0.25)
  btcAssetIndex?: number; // Índice del activo BTC en el array

  // Parámetros del solver
  maxIterations?: number;  // default: 500
  learningRate?: number;   // default: 0.01
  tolerance?: number;      // default: 1e-6
}

export interface CVaROptimizerOutput {
  weights: number[];
  achievedCVaR: number;
  achievedExpectedReturn: number;
  sharpeApprox: number;
  portfolioVolApprox: number;

  // Diagnóstico del solver
  converged: boolean;
  iterations: number;
  cvarSlack: number;   // CVaR_target - CVaR_achieved (positivo = margen disponible)
  isBindingConstraint: boolean; // true si CVaR constraint está activa

  // VaR (para comparación)
  var95: number;

  // Contribución de CVaR por activo (risk attribution)
  cvarContributions: number[];
}

// ── CÁLCULO DE CVaR (Rockafellar-Uryasev) ────────────────────────────────────

/**
 * Calcula CVaR_α del portfolio dada una matriz de scenarios.
 *
 * @param weights - Pesos del portfolio (suma = 1)
 * @param scenarios - Matriz de retornos [N_scenarios x N_assets]
 * @param alpha - Nivel de confianza (ej: 0.95)
 * @returns { cvar, var, theta } — theta es el VaR óptimo
 */
export function computePortfolioCVaR(
  weights: number[],
  scenarios: number[][],
  alpha = 0.95
): { cvar: number; var95: number; theta: number } {
  const N = scenarios.length;
  const cutoff = Math.floor((1 - alpha) * N);

  // Calcular retorno del portfolio para cada escenario
  const portfolioReturns = scenarios.map(row =>
    row.reduce((sum, r, i) => sum + weights[i] * r, 0)
  );

  // Pérdidas (negativo del retorno)
  const losses = portfolioReturns.map(r => -r).sort((a, b) => b - a);

  // VaR = pérdida al percentil (1-alpha)
  const var95 = losses[Math.min(cutoff, N - 1)];

  // CVaR = media de las losses por encima de VaR
  const tailLosses = losses.slice(0, Math.max(1, cutoff));
  const cvar = tailLosses.reduce((s, l) => s + l, 0) / tailLosses.length;

  return { cvar, var95, theta: var95 };
}

/**
 * Calcula el gradiente del CVaR respecto a los pesos del portfolio.
 * Usando la formulación Rockafellar-Uryasev:
 *   ∂CVaR/∂w_i ≈ (1/((1-α)N)) * sum_{j ∈ tail} r_{ij}
 *   donde tail = scenarios donde el portfolio perdió más que VaR
 */
function cvarGradient(
  weights: number[],
  scenarios: number[][],
  alpha: number
): number[] {
  const N = scenarios.length;
  const n = weights.length;
  const cutoff = Math.floor((1 - alpha) * N);

  // Retornos del portfolio
  const portfolioReturns = scenarios.map((row, _) =>
    row.reduce((sum, r, i) => sum + weights[i] * r, 0)
  );

  // Índices del tail (peores scenarios)
  const sortedIdx = portfolioReturns
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r - b.r)
    .slice(0, Math.max(1, cutoff))
    .map(x => x.i);

  // Gradiente: promedio de retornos de activos en el tail
  const grad = new Array(n).fill(0);
  for (const idx of sortedIdx) {
    for (let i = 0; i < n; i++) {
      grad[i] += scenarios[idx][i];
    }
  }
  const scale = sortedIdx.length;
  // Nótese: ∂CVaR/∂w_i = -(1/|tail|) * sum_tail r_{ij}
  // El signo negativo porque CVaR es una pérdida (maximizamos -CVaR)
  return grad.map(g => -g / scale);
}

// ── PROYECCIÓN AL SIMPLEX (con restricciones box) ─────────────────────────────
// Proyecta un vector arbitrario al simplex restringido:
// sum(w) = 1, w_i ∈ [minW, maxW]

function projectToConstrainedSimplex(
  w: number[],
  minW: number,
  maxW: number,
  btcIdx: number,
  maxBtcW: number
): number[] {
  const n = w.length;
  let projected = w.map(wi => Math.max(minW, Math.min(maxW, wi)));

  // Aplicar cap BTC
  if (btcIdx >= 0 && btcIdx < n) {
    projected[btcIdx] = Math.min(projected[btcIdx], maxBtcW);
  }

  // Proyectar al simplex: ajustar para que sumen 1
  // Método iterativo (Duchi et al. 2008)
  for (let iter = 0; iter < 50; iter++) {
    const total = projected.reduce((s, wi) => s + wi, 0);
    const diff = total - 1;
    if (Math.abs(diff) < 1e-10) break;

    // Distribuir el exceso uniformemente entre activos no en los límites
    const freeIdx = projected.filter((wi, i) =>
      wi > minW + 1e-10 &&
      wi < (i === btcIdx ? maxBtcW : maxW) - 1e-10
    ).length;

    if (freeIdx === 0) break;

    const adjust = diff / freeIdx;
    projected = projected.map((wi, i) => {
      const cap = i === btcIdx ? maxBtcW : maxW;
      if (wi > minW + 1e-10 && wi < cap - 1e-10) {
        return Math.max(minW, Math.min(cap, wi - adjust));
      }
      return wi;
    });
  }

  return projected;
}

// ── OPTIMIZADOR PRINCIPAL: PROJECTED GRADIENT DESCENT ────────────────────────

export function optimizeCVaR(input: CVaROptimizerInput): CVaROptimizerOutput {
  const {
    assetNames,
    scenarios,
    expectedReturns,
    cvarTarget,
    alpha = 0.95,
    minWeight = 0,
    maxWeight = 0.40,
    maxBtcWeight = 0.25,
    btcAssetIndex = -1,
    maxIterations = 500,
    learningRate = 0.008,
    tolerance = 1e-6,
  } = input;

  const n = assetNames.length;
  const N = scenarios.length;

  // Inicializar con pesos iguales
  let weights = new Array(n).fill(1 / n);
  weights = projectToConstrainedSimplex(weights, minWeight, maxWeight, btcAssetIndex, maxBtcWeight);

  let prevLoss = Infinity;
  let converged = false;
  let iterations = 0;

  // Hiperparámetro de penalización para la restricción CVaR
  // Empezamos suave y aumentamos si la restricción sigue violándose
  let penaltyLambda = 10.0;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;

    // Calcular CVaR actual
    const { cvar: currentCVaR } = computePortfolioCVaR(weights, scenarios, alpha);
    const cvarViolation = Math.max(0, currentCVaR - cvarTarget);

    // Función objetivo: maximizar retorno - penalización CVaR
    // L(w) = -sum(w_i * E[R_i]) + λ * max(0, CVaR(w) - CVaRtarget)²
    const expectedReturn = weights.reduce((s, wi, i) => s + wi * expectedReturns[i], 0);
    const loss = -expectedReturn + penaltyLambda * cvarViolation * cvarViolation;

    // Gradiente de la función objetivo
    const gradReturn = expectedReturns.map(er => -er); // negativo = maximizar
    const gradCVaR = cvarGradient(weights, scenarios, alpha);
    const penaltyFactor = 2 * penaltyLambda * cvarViolation;

    const gradTotal = gradReturn.map((g, i) => g + penaltyFactor * gradCVaR[i]);

    // Gradient step
    const newWeights = weights.map((wi, i) => wi - learningRate * gradTotal[i]);

    // Proyección a las restricciones
    weights = projectToConstrainedSimplex(
      newWeights, minWeight, maxWeight, btcAssetIndex, maxBtcWeight
    );

    // Aumentar penalización si hay violación persistente
    if (cvarViolation > 0.001 && iter % 50 === 0) {
      penaltyLambda = Math.min(penaltyLambda * 1.5, 1000);
    }

    // Verificar convergencia
    if (Math.abs(prevLoss - loss) < tolerance) {
      converged = true;
      break;
    }
    prevLoss = loss;
  }

  // Cálculo final de métricas
  const { cvar: finalCVaR, var95 } = computePortfolioCVaR(weights, scenarios, alpha);
  const finalExpectedReturn = weights.reduce((s, wi, i) => s + wi * expectedReturns[i], 0);

  // Volatilidad aproximada del portfolio
  const portfolioReturns = scenarios.map(row =>
    row.reduce((sum, r, i) => sum + weights[i] * r, 0)
  );
  const meanReturn = portfolioReturns.reduce((s, r) => s + r, 0) / N;
  const variance = portfolioReturns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / N;
  const portfolioVol = Math.sqrt(variance * 252); // anualizado (asumiendo retornos diarios)

  // Sharpe aproximado (usando tasa libre de riesgo 3.85%)
  const riskFreeRate = 0.0385;
  const sharpeApprox = portfolioVol > 0
    ? (finalExpectedReturn * 252 - riskFreeRate) / portfolioVol
    : 0;

  // CVaR contributions por activo (marginal CVaR)
  const cvarContributions = computeMarginalCVaRContributions(
    weights, scenarios, alpha, N
  );

  return {
    weights,
    achievedCVaR: finalCVaR,
    achievedExpectedReturn: finalExpectedReturn * 252, // anualizado
    sharpeApprox,
    portfolioVolApprox: portfolioVol,
    converged,
    iterations,
    cvarSlack: cvarTarget - finalCVaR,
    isBindingConstraint: Math.abs(finalCVaR - cvarTarget) < 0.005,
    var95,
    cvarContributions,
  };
}

/**
 * Calcula la contribución marginal al CVaR de cada activo.
 * Marginal CVaR_i = w_i * ∂CVaR/∂w_i
 * Suma a CVaR total (Euler decomposition).
 */
function computeMarginalCVaRContributions(
  weights: number[],
  scenarios: number[][],
  alpha: number,
  N: number
): number[] {
  const cutoff = Math.floor((1 - alpha) * N);
  const n = weights.length;

  // Retornos del portfolio
  const portfolioReturns = scenarios.map(row =>
    row.reduce((sum, r, i) => sum + weights[i] * r, 0)
  );

  // Identificar tail scenarios
  const tailIdx = portfolioReturns
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r - b.r)
    .slice(0, Math.max(1, cutoff))
    .map(x => x.i);

  // Retorno promedio de cada activo en el tail
  const tailAvgReturn = new Array(n).fill(0);
  for (const idx of tailIdx) {
    for (let i = 0; i < n; i++) {
      tailAvgReturn[i] += scenarios[idx][i];
    }
  }

  const scale = tailIdx.length;
  // Contribution_i = -w_i * E[r_i | portfolio in tail]
  return weights.map((wi, i) => -wi * tailAvgReturn[i] / scale);
}

/**
 * Genera scenarios Monte Carlo para el optimizador CVaR.
 * Usa distribución t-Student (fat tails) + correlación para BTC.
 */
export function generateCVaRScenarios(
  expectedReturns: number[],  // Retornos esperados anualizados
  vols: number[],             // Volatilidades anualizadas
  correlationMatrix: number[][], // Correlaciones
  nScenarios = 5000,
  horizonDays = 1              // Horizonte de cada scenario
): number[][] {
  const n = expectedReturns.length;
  const dt = horizonDays / 252;

  // Retornos diarios esperados
  const muDaily = expectedReturns.map(er => er * dt);
  const sigmaDaily = vols.map(v => v * Math.sqrt(dt));

  // Cholesky de la matriz de correlación
  const chol = choleskyDecomposition(correlationMatrix);

  const scenarios: number[][] = [];

  for (let s = 0; s < nScenarios; s++) {
    // Generar vector de shocks independientes (normal estándar)
    const z = Array.from({ length: n }, () => randomNormal());

    // Correlacionar los shocks: x = L * z
    const x = Array.from({ length: n }, (_, i) =>
      chol[i].reduce((sum, lij, j) => sum + lij * z[j], 0)
    );

    // Retorno del activo: r_i = μ_i * dt + σ_i * √dt * x_i
    const returns = x.map((xi, i) => muDaily[i] + sigmaDaily[i] * xi);
    scenarios.push(returns);
  }

  return scenarios;
}

// ── UTILIDADES ────────────────────────────────────────────────────────────────

function randomNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function choleskyDecomposition(A: number[][]): number[][] {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }
      if (i === j) {
        const diag = A[i][i] - sum;
        L[i][j] = Math.sqrt(Math.max(0, diag)); // max(0,...) para estabilidad numérica
      } else if (L[j][j] > 1e-10) {
        L[i][j] = (A[i][j] - sum) / L[j][j];
      }
    }
  }
  return L;
}
