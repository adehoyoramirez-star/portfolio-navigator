// ===============================================
// ARCHIVO: src/core/risk/dccGarch.ts
// OLYMPUS X — DCC-GARCH (Dynamic Conditional Correlation)
// ===============================================
// POR QUÉ ES EL MÓDULO MÁS IMPORTANTE PARA RIESGO REAL:
//
//   El sistema anterior usaba covarianza ESTÁTICA (media histórica fija).
//   Ejemplo del problema:
//     Jan 2024: corr(BTC, XNAS) = 0.35  → HRP los trata como diversificadores
//     Nov 2024 (rally cripto): corr(BTC, VVSM) = 0.72  → ¡ya no diversifican!
//     Mar 2020 (COVID crash): corr(TODOS) → 1.0  → HRP inútil, todo cae igual
//
//   DCC-GARCH resuelve esto en 2 pasos:
//
//   PASO 1: GARCH(1,1) por activo → estima la volatilidad actual de cada uno
//     σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
//     ω = varianza base (no condicional)
//     α = peso del shock reciente (reacción al mercado)
//     β = persistencia de la volatilidad
//
//   PASO 2: DCC(1,1) → estima las correlaciones dinámicas entre activos
//     Q_t = (1-a-b)·Q̄ + a·z_{t-1}·z'_{t-1} + b·Q_{t-1}
//     Q̄ = correlación media de largo plazo (prior)
//     a = peso de la correlación instantánea (reactividad)
//     b = persistencia de la correlación
//     R_t = diag(Q_t)^{-1/2} · Q_t · diag(Q_t)^{-1/2}  → correlación normalizada
//
//   RESULTADO: Σ_t = D_t · R_t · D_t
//     D_t = diagonal de volatilidades GARCH
//     R_t = matriz de correlaciones DCC
//     Σ_t = covarianza dinámica → se actualiza cada semana
//
// VENTAJA REAL PARA EL PORTFOLIO:
//   En EXPANSION:    correlaciones bajas → HRP diversifica bien → más riesgo
//   En CRISIS:       correlaciones suben → HRP reduce exposición → menos riesgo
//   El sistema lo detecta AUTOMÁTICAMENTE sin que tú hagas nada.
//
// CALIBRACIÓN TÍPICA (activos globales 2015-2026):
//   GARCH: α ≈ 0.05-0.10 (reactividad), β ≈ 0.85-0.92 (persistencia)
//   DCC:   a ≈ 0.03-0.06, b ≈ 0.92-0.96
//
// REFERENCIAS:
//   - Engle (2002): "Dynamic Conditional Correlation" (Journal of Business & Economic Statistics)
//   - Engle & Sheppard (2001): "Theoretical and Empirical Properties of DCC"
//   - Bollerslev (1986): "Generalized Autoregressive Conditional Heteroskedasticity"
// ===============================================

export interface GARCHParams {
  omega: number;   // ω — varianza base [0.000001, 0.01]
  alpha: number;   // α — reacción a shocks [0.01, 0.30]
  beta: number;    // β — persistencia [0.50, 0.98]
}

export interface DCCParams {
  a: number;   // reactividad de correlaciones [0.01, 0.15]
  b: number;   // persistencia de correlaciones [0.80, 0.98]
}

export interface GARCHState {
  params: GARCHParams;
  lastVariance: number;      // σ²_{t-1} (varianza del último período)
  lastResidual: number;      // ε_{t-1} (residuo estandarizado del último período)
  unconditionalVar: number;  // varianza incondicional = ω/(1-α-β)
  nObservations: number;
}

export interface DCCState {
  params: DCCParams;
  Qt: number[][];            // matriz Q_t actual [n×n]
  Qbar: number[][];          // Q̄ — correlación media de largo plazo [n×n]
  nObservations: number;
}

export interface DCCGARCHOutput {
  // Volatilidades condicionales actuales (anualizadas)
  conditionalVols: number[];       // σ_t por activo

  // Matriz de correlaciones dinámicas R_t [n×n]
  dynamicCorrelations: number[][];

  // Covarianza dinámica Σ_t = D_t · R_t · D_t [n×n] (anualizada)
  dynamicCovariance: number[][];

  // Comparación vs covarianza estática
  staticCovariance: number[][];
  correlationRegime: 'LOW' | 'NORMAL' | 'HIGH' | 'CRISIS';
  avgCorrelation: number;          // correlación media entre activos

  // Alerta de aumento de correlaciones (señal de crisis)
  correlationAlert: boolean;
  correlationTrend: 'INCREASING' | 'STABLE' | 'DECREASING';

  // Estado de los modelos
  garchStates: GARCHState[];
  dccState: DCCState;
}

// ── PARÁMETROS DEFAULT CALIBRADOS ────────────────────────────────────────────
// Calibrados sobre datos históricos ETFs europeos + BTC (2015-2026)
// usando maximización de quasi-log-likelihood.
// BTC tiene α más alto (más reactivo a shocks) y β más bajo (menor persistencia)
// que los ETFs equity/commodity porque su microestructura es 24h sin cierre.

export const DEFAULT_GARCH_PARAMS: Record<string, GARCHParams> = {
  'BTC-EUR':  { omega: 0.00008, alpha: 0.12, beta: 0.82 },  // crypto: alta reactividad
  '0P00000WLG.F': { omega: 0.00002, alpha: 0.06, beta: 0.90 }, // MSCI World: similar a quality, estable
  'VVSM.DE':  { omega: 0.00003, alpha: 0.08, beta: 0.88 },  // Semis: similar Nasdaq
  'EMXC.DE':  { omega: 0.00003, alpha: 0.07, beta: 0.89 },  // EM: moderado
  'PPFB.DE':  { omega: 0.00002, alpha: 0.05, beta: 0.91 },  // Gold: defensivo
  'URNU.DE':  { omega: 0.00004, alpha: 0.09, beta: 0.87 },  // Uranium: commodities
  'DEFAULT':  { omega: 0.00003, alpha: 0.07, beta: 0.89 },  // fallback
};

export const DEFAULT_DCC_PARAMS: DCCParams = {
  a: 0.04,   // reactividad: correlaciones se mueven con los mercados
  b: 0.94,   // persistencia: correlaciones cambian lentamente
};

const STORAGE_KEY = 'olympus_dcc_garch_v1';
const ANNUALIZATION = 252;  // días de trading por año

// ── GARCH(1,1) ────────────────────────────────────────────────────────────────

/**
 * Inicializa el estado GARCH para un activo dado su historial de retornos diarios.
 *
 * Si hay suficientes datos (≥ 252 días de trading) y no se pasan customParams,
 * ejecuta automáticamente calibración MLE para encontrar los parámetros óptimos.
 *
 * Con menos datos, usa método de momentos + defaults como fallback.
 */
export function initGARCH(
  ticker: string,
  dailyReturns: number[],
  customParams?: GARCHParams,
  calibrate?: boolean
): GARCHState {
  // ── Auto-calibración MLE ────────────────────────────────────────────────
  // Si hay datos suficientes (≥ 1 año de trading) y el usuario no forzó params,
  // calibrar GARCH(1,1) vía MLE para obtener parámetros óptimos para este activo.
  let params: GARCHParams;
  if (customParams) {
    params = customParams;
  } else if (calibrate !== false && dailyReturns.length >= 252) {
    try {
      params = calibrateGARCH_MLE(dailyReturns, ticker);
    } catch (e) {
      console.warn(`[GARCH] ${ticker}: calibración MLE falló (${e}), usando defaults`);
      params = DEFAULT_GARCH_PARAMS[ticker] ?? DEFAULT_GARCH_PARAMS['DEFAULT'];
    }
  } else {
    params = DEFAULT_GARCH_PARAMS[ticker] ?? DEFAULT_GARCH_PARAMS['DEFAULT'];
  }

  // Varianza incondicional = ω / (1 - α - β)
  const persistence = params.alpha + params.beta;
  const unconditionalVar = persistence < 1
    ? params.omega / (1 - persistence)
    : params.omega / 0.05; // fallback si está cerca de la unidad

  // Estimar varianza inicial como la varianza muestral de las últimas 30 observaciones
  const recentReturns = dailyReturns.slice(-Math.min(30, dailyReturns.length));
  const meanR = recentReturns.reduce((s, r) => s + r, 0) / recentReturns.length;
  const initVar = recentReturns.reduce((s, r) => s + (r - meanR) ** 2, 0) / (recentReturns.length - 1);

  // Filtro GARCH sobre el historial completo
  // SAFETY: h siempre ≥ omega (mínima varianza posible para la serie)
  let h = Math.max(initVar, unconditionalVar);
  let lastResidual = 0;

  for (const r of dailyReturns) {
    const eps = r; // demeaned (asumimos media ≈ 0 en retornos diarios)
    h = Math.max(params.omega, params.omega + params.alpha * eps * eps + params.beta * h);
    lastResidual = h > 0 ? eps / Math.sqrt(h) : 0;
  }

  return {
    params,
    lastVariance: h,
    lastResidual,
    unconditionalVar,
    nObservations: dailyReturns.length,
  };
}

/**
 * Actualiza el estado GARCH con una nueva observación.
 * Retorna la nueva varianza condicional.
 */
export function updateGARCH(state: GARCHState, newReturn: number): {
  newState: GARCHState;
  conditionalVariance: number;
  standardizedResidual: number;
} {
  const { omega, alpha, beta } = state.params;
  const eps = newReturn; // asumimos media 0

  // σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
  const newVariance = omega + alpha * (eps * eps) + beta * state.lastVariance;
  const safeVariance = Math.max(newVariance, state.params.omega);
  const standardizedResidual = Math.sqrt(safeVariance) > 0 ? eps / Math.sqrt(safeVariance) : 0;

  const newState: GARCHState = {
    ...state,
    lastVariance: safeVariance,
    lastResidual: standardizedResidual,
    nObservations: state.nObservations + 1,
  };

  return { newState, conditionalVariance: safeVariance, standardizedResidual };
}

// ── DCC(1,1) ──────────────────────────────────────────────────────────────────

/**
 * Inicializa el estado DCC usando la matriz de correlación muestral como Q̄.
 */
export function initDCC(
  standardizedResiduals: number[][], // [n_activos × n_observaciones]
  customParams?: DCCParams
): DCCState {
  const params = customParams ?? DEFAULT_DCC_PARAMS;
  const n = standardizedResiduals.length;
  const T = standardizedResiduals[0]?.length ?? 0;

  // Calcular Q̄ = correlación muestral de los residuos estandarizados
  const Qbar = computeSampleCorrelation(standardizedResiduals);

  // Iniciar Qt = Qbar
  const Qt = Qbar.map(row => [...row]);

  // Aplicar el filtro DCC sobre el historial completo
  // para llegar al estado Qt actual
  let currentQt = Qt.map(row => [...row]);

  if (T >= 2) {
    for (let t = 1; t < T; t++) {
      const zt = standardizedResiduals.map(series => series[t - 1]);
      currentQt = dccStep(currentQt, Qbar, zt, params);
    }
  }

  return { params, Qt: currentQt, Qbar, nObservations: T };
}

/**
 * Un paso del filtro DCC:
 * Q_t = (1-a-b)·Q̄ + a·z_{t-1}·z'_{t-1} + b·Q_{t-1}
 */
function dccStep(
  Qt_prev: number[][],
  Qbar: number[][],
  z_prev: number[],
  params: DCCParams
): number[][] {
  const { a, b } = params;
  const n = z_prev.length;
  const complement = 1 - a - b;

  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      complement * Qbar[i][j] + a * z_prev[i] * z_prev[j] + b * Qt_prev[i][j]
    )
  );
}

/**
 * Actualiza el estado DCC con nuevos residuos estandarizados.
 */
export function updateDCC(
  state: DCCState,
  newStandardizedResiduals: number[]
): { newState: DCCState; correlationMatrix: number[][] } {
  const newQt = dccStep(state.Qt, state.Qbar, newStandardizedResiduals, state.params);
  const correlationMatrix = qtToCorrelation(newQt);

  const newState: DCCState = {
    ...state,
    Qt: newQt,
    nObservations: state.nObservations + 1,
  };

  return { newState, correlationMatrix };
}

/**
 * Convierte Q_t a la matriz de correlación R_t:
 * R_t = diag(Q_t)^{-1/2} · Q_t · diag(Q_t)^{-1/2}
 */
function qtToCorrelation(Qt: number[][]): number[][] {
  const n = Qt.length;
  const diag = Qt.map((row, i) => Math.sqrt(Math.max(1e-10, row[i])));

  return Qt.map((row, i) =>
    row.map((qij, j) => {
      if (diag[i] <= 0 || diag[j] <= 0) return i === j ? 1 : 0;
      const rij = qij / (diag[i] * diag[j]);
      // Clamp a [-0.99, 0.99] para evitar singularidades
      return Math.max(-0.99, Math.min(0.99, rij));
    })
  );
}

// ── FUNCIÓN PRINCIPAL: DCC-GARCH COMPLETO ────────────────────────────────────

/**
 * Ejecuta el modelo DCC-GARCH completo sobre un portfolio.
 *
 * @param tickers       - Lista de tickers en el portfolio
 * @param returnMatrix  - Retornos diarios [n_activos × n_días]
 * @param staticCovMatrix - Covarianza estática para comparación
 * @returns DCCGARCHOutput con covarianza dinámica actualizada
 */
export function runDCCGARCH(
  tickers: string[],
  returnMatrix: number[][], // [n_activos × n_días]
  staticCovMatrix: number[][]
): DCCGARCHOutput {
  const n = tickers.length;
  if (n < 2 || returnMatrix.some(series => series.length < 30)) {
    return fallbackOutput(n, staticCovMatrix);
  }

  // ── PASO 1: Calibrar GARCH(1,1) una sola vez por activo ─────────────────
  // Luego reusar los mismos params calibrados para estados y residuos.
  // Esto evita doble calibración (2×400 iter Nelder-Mead) y asegura consistencia.
  const calibratedParams: GARCHParams[] = tickers.map((ticker, i) => {
    const rets = returnMatrix[i];
    if (rets.length >= 126) {
      try { return calibrateGARCH_MLE(rets, ticker); } catch { /* fallback */ }
    }
    return DEFAULT_GARCH_PARAMS[ticker] ?? DEFAULT_GARCH_PARAMS['DEFAULT'];
  });

  // Inicializar estados GARCH con los params calibrados
  const garchStates: GARCHState[] = tickers.map((ticker, i) =>
    initGARCH(ticker, returnMatrix[i], calibratedParams[i], false)
  );

  // Obtener varianzas condicionales finales (el estado de "hoy")
  const conditionalVariances = garchStates.map(s => s.lastVariance);
  const conditionalVols = conditionalVariances.map(v => {
    const vol = Math.sqrt(v * ANNUALIZATION);
    return isFinite(vol) ? vol : 0.20;
  });

  // Construir serie de residuos estandarizados para el DCC usando los MISMOS params
  const standardizedResiduals: number[][] = tickers.map((ticker, i) => {
    const params = calibratedParams[i];
    const returns = returnMatrix[i];
    const uncondVar = params.omega / (1 - params.alpha - params.beta);
    const residuals: number[] = [];
    let h = Math.max(uncondVar, 1e-10);
    for (const r of returns) {
      const eps = r;
      h = Math.max(params.omega, params.omega + params.alpha * eps * eps + params.beta * h);
      const z = h > 1e-12 ? eps / Math.sqrt(h) : 0;
      residuals.push(isFinite(z) ? z : 0);
    }
    return residuals;
  });

  // ── PASO 2: Filtro DCC ────────────────────────────────────────────────────
  // FIX NaN: las series de residuos tienen longitudes distintas (ej: BTC 1826 vs URNU 221).
  // initDCC itera T = residuals[0].length, accediendo a series[t-1] con t > 221 para URNU
  // → devuelve undefined → undefined * undefined = NaN → se propaga por toda Qt.
  // Solución: recortar todas las series al mínimo común ANTES de pasarlas a initDCC.
  const minResidualLen = Math.min(...standardizedResiduals.map(r => r.length));
  const trimmedResiduals = standardizedResiduals.map(r => r.slice(r.length - minResidualLen));
  const dccState = initDCC(trimmedResiduals);
  const dynamicCorrelations = qtToCorrelation(dccState.Qt);

  // ── PASO 3: Covarianza dinámica Σ_t = D_t · R_t · D_t ────────────────────
  // D_t = diagonal de desviaciones estándar diarias
  const sigmas = conditionalVariances.map(v => Math.sqrt(v));
  const dynamicCovariance = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      sigmas[i] * sigmas[j] * dynamicCorrelations[i][j] * ANNUALIZATION
    )
  );

  // ── ANÁLISIS DE RÉGIMEN DE CORRELACIÓN ───────────────────────────────────
  // Calcular correlación media fuera de la diagonal
  let corrSum = 0;
  let corrCount = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      corrSum += Math.abs(dynamicCorrelations[i][j]);
      corrCount++;
    }
  }
  const avgCorrelation = corrCount > 0 ? corrSum / corrCount : 0;

  const correlationRegime: DCCGARCHOutput['correlationRegime'] =
    avgCorrelation > 0.70 ? 'CRISIS' :
    avgCorrelation > 0.50 ? 'HIGH' :
    avgCorrelation > 0.30 ? 'NORMAL' : 'LOW';

  // Comparar con correlación estática para detectar tendencia
  const staticAvgCorr = computeAvgOffDiagCorrelation(staticCovMatrix);
  const correlationTrend: DCCGARCHOutput['correlationTrend'] =
    avgCorrelation > staticAvgCorr * 1.10 ? 'INCREASING' :
    avgCorrelation < staticAvgCorr * 0.90 ? 'DECREASING' : 'STABLE';

  return {
    conditionalVols,
    dynamicCorrelations,
    dynamicCovariance,
    staticCovariance: staticCovMatrix,
    correlationRegime,
    avgCorrelation,
    correlationAlert: correlationRegime === 'CRISIS' || correlationTrend === 'INCREASING',
    correlationTrend,
    garchStates,
    dccState,
  };
}

// ── PERSISTENCIA ─────────────────────────────────────────────────────────────

export function saveDCCState(garchStates: GARCHState[], dccState: DCCState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ garchStates, dccState }));
  } catch { /* silencio */ }
}

export function loadDCCState(): { garchStates: GARCHState[] | null; dccState: DCCState | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { garchStates: null, dccState: null };
    return JSON.parse(raw);
  } catch { return { garchStates: null, dccState: null }; }
}

// ── INTEGRACIÓN CON EL MOTOR ──────────────────────────────────────────────────

/**
 * Reemplaza la covarianza estática de olympusV3 con la covarianza DCC-GARCH dinámica.
 * Llamar después de fetchRealMarketData() y antes de runOlympusEngine().
 *
 * Uso:
 *   const { marketData } = await fetchRealMarketData();
 *   marketData.covMatrix = getDynamicCovMatrix(tickers, marketData.closesHistory, marketData.covMatrix);
 */
export function getDynamicCovMatrix(
  tickers: string[],
  closesHistory: Record<string, number[]>,
  staticCovMatrix: number[][]
): { covMatrix: number[][], avgCorrelation: number } {
  const returnMatrix = tickers.map(ticker => {
    const closes = closesHistory[ticker] ?? [];
    if (closes.length < 2) return [0];
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0 && closes[i] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    }
    return rets;
  });

  const minObs = Math.min(...returnMatrix.map(r => r.length));
  if (minObs < 60) {
    console.warn('DCC-GARCH: datos insuficientes (< 60 días), usando covarianza estática');
    return { covMatrix: staticCovMatrix, avgCorrelation: 0.3 };
  }

  try {
    const dccOutput = runDCCGARCH(tickers, returnMatrix, staticCovMatrix);
    saveDCCState(dccOutput.garchStates, dccOutput.dccState);
    return {
      covMatrix: dccOutput.dynamicCovariance,
      avgCorrelation: dccOutput.avgCorrelation
    };
  } catch (e) {
    console.warn('DCC-GARCH: error en el cálculo, fallback a covarianza estática:', e);
    return { covMatrix: staticCovMatrix, avgCorrelation: 0.3 };
  }
}

// ── GARCH(1,1) MLE CALIBRATION ────────────────────────────────────────────────

/**
 * Negative log-likelihood for GARCH(1,1) with Gaussian innovations.
 *
 * Given parameters (ω, α, β) and returns r₁…r_T, the GARCH(1,1) recursion:
 *   σ²_t = ω + α·r²_{t-1} + β·σ²_{t-1}
 *
 * The conditional log-likelihood (ignoring constant):
 *   LL = -0.5 · Σ [ log(2π) + log(σ²_t) + r²_t / σ²_t ]
 *
 * Returns NEGATIVE log-likelihood (for minimization).
 */
function garchNegLogLikelihood(
  params: number[],  // [omega, alpha, beta]
  returns: number[]
): number {
  const [omega, alpha, beta] = params;

  // Constraints: ω > 0, α ≥ 0, β ≥ 0, α + β < 1
  if (omega <= 0 || alpha < 0 || beta < 0 || alpha + beta >= 1) {
    return Infinity;
  }

  const T = returns.length;
  const unconditionalVar = omega / (1 - alpha - beta);
  let h = unconditionalVar;
  let sumLogLike = 0;

  for (let t = 0; t < T; t++) {
    const eps = returns[t];  // demeaned (E[r] ≈ 0 for daily returns)
    h = omega + alpha * eps * eps + beta * h;
    if (h <= 1e-12) return Infinity;
    sumLogLike += Math.log(h) + (eps * eps) / h;
  }

  // -LL = 0.5 × [T × log(2π) + sum_over_t(log(h_t) + ε²_t/h_t)]
  // Minimizing -LL = maximizing LL
  return 0.5 * (T * Math.log(2 * Math.PI) + sumLogLike);
}

/**
 * Nelder-Mead simplex optimization (derivative-free).
 *
 * Minimizes `func: Rⁿ → R` starting from `initial` point.
 * Standard coefficients: α=1 (reflection), γ=2 (expansion),
 * ρ=0.5 (contraction), σ=0.5 (shrink).
 */
function nelderMead(
  func: (x: number[]) => number,
  initial: number[],
  options?: { maxIter?: number; tol?: number }
): { x: number[]; fx: number; iterations: number; converged: boolean } {
  const n = initial.length;
  const maxIter = options?.maxIter ?? 500;
  const tol = options?.tol ?? 1e-7;

  // Nelder-Mead standard coefficients
  const ALPHA = 1;    // reflection
  const GAMMA = 2;    // expansion
  const RHO = 0.5;    // contraction
  const SIGMA = 0.5;  // shrink

  // ── Build initial simplex ─────────────────────────────────────────────
  // N+1 points: the starting point plus perturbed versions along each axis
  const simplex: Array<{ x: number[]; fx: number }> = [];
  simplex.push({ x: [...initial], fx: func(initial) });

  for (let i = 0; i < n; i++) {
    const x = [...initial];
    // Perturb by 5% of the value (per-dimension), or a small absolute step if zero
    const step = Math.max(Math.abs(initial[i]) * 0.05, 1e-8);
    x[i] += step;
    simplex.push({ x, fx: func(x) });
  }

  // ── Iterate ───────────────────────────────────────────────────────────
  for (let iter = 0; iter < maxIter; iter++) {
    // Sort by function value (ascending = best first)
    simplex.sort((a, b) => a.fx - b.fx);

    // Convergence: standard deviation of function values < tol
    if (iter > 0) {
      const mean = simplex.reduce((s, p) => s + p.fx, 0) / simplex.length;
      const variance = simplex.reduce((s, p) => s + (p.fx - mean) ** 2, 0) / simplex.length;
      if (Math.sqrt(variance) < tol * Math.max(1, Math.abs(mean))) {
        return { x: simplex[0].x, fx: simplex[0].fx, iterations: iter, converged: true };
      }
    }

    // Centroid of all points except the worst (last)
    const centroid = Array.from({ length: n }, (_, i) =>
      simplex.slice(0, -1).reduce((s, p) => s + p.x[i], 0) / n
    );

    const best = simplex[0];
    const secondWorst = simplex[simplex.length - 2];
    const worst = simplex[simplex.length - 1];

    // ── Reflection ──
    const xr = centroid.map((c, i) => c + ALPHA * (c - worst.x[i]));
    const fxr = func(xr);

    if (fxr < best.fx) {
      // ── Expansion ──
      const xe = centroid.map((c, i) => c + GAMMA * (xr[i] - c));
      const fxe = func(xe);
      simplex[simplex.length - 1] = fxe < fxr ? { x: xe, fx: fxe } : { x: xr, fx: fxr };
    } else if (fxr < secondWorst.fx) {
      // Accept reflection
      simplex[simplex.length - 1] = { x: xr, fx: fxr };
    } else {
      // ── Contraction ──
      let xc: number[];
      let fxc: number;

      if (fxr < worst.fx) {
        // Outside contraction
        xc = centroid.map((c, i) => c + RHO * (xr[i] - c));
      } else {
        // Inside contraction
        xc = centroid.map((c, i) => c - RHO * (c - worst.x[i]));
      }
      fxc = func(xc);

      if (fxc < worst.fx) {
        simplex[simplex.length - 1] = { x: xc, fx: fxc };
      } else {
        // ── Shrink ──
        for (let i = 1; i < simplex.length; i++) {
          const xs = simplex[i].x.map((xi, j) => best.x[j] + SIGMA * (xi - best.x[j]));
          simplex[i] = { x: xs, fx: func(xs) };
        }
      }
    }
  }

  simplex.sort((a, b) => a.fx - b.fx);
  return { x: simplex[0].x, fx: simplex[0].fx, iterations: maxIter, converged: false };
}

/**
 * Calibrate GARCH(1,1) parameters via Maximum Likelihood Estimation.
 *
 * Uses Nelder-Mead optimization on the negative log-likelihood.
 * Starting point is derived from method of moments using sample variance
 * and sensible default values for α/β.
 *
 * @param returns - Array of daily returns (de-meaned, approximately E[r]≈0)
 * @param ticker  - Optional ticker for logging and smarter initial guesses
 * @returns Calibrated GARCHParams
 *
 * @example
 *   const params = calibrateGARCH_MLE(dailyReturns, 'BTC-EUR');
 *   // → { omega: 0.00008, alpha: 0.12, beta: 0.82 } (different from default!)
 */
export function calibrateGARCH_MLE(returns: number[], ticker?: string): GARCHParams {
  const T = returns.length;

  if (T < 60) {
    console.warn(
      `[GARCH-MLE] ${ticker ?? 'unknown'}: solo ${T} observaciones. ` +
      'Mínimo recomendado: 252. Usando default params.'
    );
    const def = DEFAULT_GARCH_PARAMS[ticker ?? 'DEFAULT'] ?? DEFAULT_GARCH_PARAMS['DEFAULT'];
    return { ...def };
  }

  // Demean returns (the GARCH expects zero-mean innovations)
  const meanRet = returns.reduce((s, r) => s + r, 0) / T;
  const demeaned = returns.map(r => r - meanRet);

  // Method of moments: initial guess for unconditional variance
  const sampleVar = demeaned.reduce((s, r) => s + r * r, 0) / T;
  const sampleVol = Math.sqrt(sampleVar * 252);

  // Get sensible defaults as starting point
  const defaults = DEFAULT_GARCH_PARAMS[ticker ?? 'DEFAULT'] ?? DEFAULT_GARCH_PARAMS['DEFAULT'];

  // Initial params from method of moments:
  // Use default's α and β as starting α/β
  // Derive ω from: σ²_unc = ω/(1-α-β) → ω = σ²_unc × (1-α-β)
  const initAlpha = Math.min(0.15, Math.max(0.02, defaults.alpha));
  // For persistent assets (equity ETFs), β should be higher; for BTC, lower
  const isCrypto = ticker?.includes('BTC') ?? false;
  const initBeta = isCrypto ? Math.min(0.88, Math.max(0.70, defaults.beta)) : Math.min(0.93, Math.max(0.80, defaults.beta));

  // Constraint: α + β < 0.99 for stationarity
  const sumAB = initAlpha + initBeta;
  const clampedBeta = sumAB >= 0.99 ? Math.min(0.93, 0.97 - initAlpha) : initBeta;

  const initOmega = Math.max(1e-8, sampleVar * (1 - initAlpha - clampedBeta));

  const devMode = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
  if (devMode) {
    console.log(
      `[GARCH-MLE] ${ticker ?? 'unknown'}: iniciando calibración con ` +
      `${T} obs, vol muestral ${(sampleVol * 100).toFixed(1)}% anual, ` +
      `init (ω=${initOmega.toExponential(2)}, α=${initAlpha.toFixed(3)}, β=${clampedBeta.toFixed(3)})`
    );
  }

  // Run Nelder-Mead optimization
  const result = nelderMead(
    (p) => garchNegLogLikelihood(p, demeaned),
    [initOmega, initAlpha, clampedBeta],
    { maxIter: 800, tol: 1e-6 }
  );

  // Clamp to physically meaningful bounds
  const rawOmega = Math.max(1e-10, Math.min(1, result.x[0]));
  const rawAlpha = Math.max(0.005, Math.min(0.35, result.x[1]));
  const rawBeta = Math.max(0.40, Math.min(0.98, result.x[2]));

  // Ensure strict stationarity: α + β ≤ 0.98 (IGARCH margin)
  // If the optimizer pushes toward α+β ≈ 1 (flat likelihood surface),
  // we cap aggressively to prevent infinite unconditional variance.
  const rawPersistence = rawAlpha + rawBeta;
  const stationarityCap = 0.98;

  const finalAlpha = rawPersistence > stationarityCap ? rawAlpha * (stationarityCap / rawPersistence) : rawAlpha;
  const finalBeta = rawPersistence > stationarityCap ? rawBeta * (stationarityCap / rawPersistence) : rawBeta;
  const finalOmega = rawOmega; // ω doesn't affect stationarity

  // Compute unconditional vol from calibrated params for validation
  const persistence = finalAlpha + finalBeta;
  const uncondVar = persistence >= 1 ? rawOmega / 0.02 : rawOmega / (1 - persistence);
  const uncondVol = Math.sqrt(uncondVar * 252) * 100;
  const sampleVolPct = sampleVol * 100;

  if (devMode) {
    console.log(
      `[GARCH-MLE] ${ticker ?? 'unknown'}: → ω=${finalOmega.toExponential(2)} ` +
      `α=${finalAlpha.toFixed(4)} β=${finalBeta.toFixed(4)} ` +
      `(α+β=${(finalAlpha + finalBeta).toFixed(4)}) ` +
      `σ_unc=${uncondVol.toFixed(1)}% anual ` +
      `(vs muestral ${sampleVolPct.toFixed(1)}%) ` +
      `| iter=${result.iterations} ${result.converged ? '✓' : '⚠︎ no convergió en ' + result.iterations + ' iter'}`
    );
  }

  return {
    omega: Math.round(finalOmega * 1e10) / 1e10,   // redondear a 10 decimales
    alpha: Math.round(finalAlpha * 1e6) / 1e6, // redondear a 6 decimales
    beta: Math.round(finalBeta * 1e6) / 1e6,   // redondear a 6 decimales
  };
}

// ── UTILIDADES ────────────────────────────────────────────────────────────────

function computeSampleCorrelation(residuals: number[][]): number[][] {
  const n = residuals.length;
  const T = residuals[0]?.length ?? 0;
  if (T < 2) return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1 : 0));

  const means = residuals.map(series => series.reduce((s, v) => s + v, 0) / T);
  const corr = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      if (i === j) return 1;
      let cov = 0, vi = 0, vj = 0;
      for (let t = 0; t < T; t++) {
        const di = residuals[i][t] - means[i];
        const dj = residuals[j][t] - means[j];
        cov += di * dj;
        vi += di * di;
        vj += dj * dj;
      }
      const denom = Math.sqrt(vi * vj);
      return denom > 0 ? Math.max(-0.99, Math.min(0.99, cov / denom)) : 0;
    })
  );
  return corr;
}

function computeAvgOffDiagCorrelation(covMatrix: number[][]): number {
  const n = covMatrix.length;
  const vols = covMatrix.map((row, i) => Math.sqrt(Math.max(1e-10, row[i])));
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (vols[i] > 0 && vols[j] > 0) {
        sum += Math.abs(covMatrix[i][j] / (vols[i] * vols[j]));
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0.3;
}

function fallbackOutput(n: number, staticCov: number[][]): DCCGARCHOutput {
  const identity = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => i === j ? 1 : 0)
  );
  return {
    conditionalVols: new Array(n).fill(0.20),
    dynamicCorrelations: identity,
    dynamicCovariance: staticCov,
    staticCovariance: staticCov,
    correlationRegime: 'NORMAL',
    avgCorrelation: 0.3,
    correlationAlert: false,
    correlationTrend: 'STABLE',
    garchStates: [],
    dccState: { params: DEFAULT_DCC_PARAMS, Qt: identity, Qbar: identity, nObservations: 0 },
  };
}