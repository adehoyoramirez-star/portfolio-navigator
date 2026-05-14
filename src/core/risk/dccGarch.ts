// ===============================================
// ARCHIVO: src/core/risk/dccGarch.ts
// OLYMPUS X — DCC-GARCH (Dynamic Conditional Correlation)
// ===============================================
// POR QUÉ ES EL MÓDULO MÁS IMPORTANTE PARA RIESGO REAL:
//
//   El sistema anterior usaba covarianza ESTÁTICA (media histórica fija).
//   Ejemplo del problema:
//     Jan 2024: corr(BTC, XNAS) = 0.35  → HRP los trata como diversificadores
//     Nov 2024 (rally cripto): corr(BTC, XNAS) = 0.72  → ¡ya no diversifican!
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
  'XNAS.DE':  { omega: 0.00003, alpha: 0.08, beta: 0.88 },  // Nasdaq: tech volátil
  'VVSM.DE':  { omega: 0.00003, alpha: 0.08, beta: 0.88 },  // Semis: similar Nasdaq
  'IS3Q.DE':  { omega: 0.00002, alpha: 0.06, beta: 0.90 },  // Quality: más estable
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
 * Usa método de momentos para estimar la varianza incondicional inicial.
 */
export function initGARCH(
  ticker: string,
  dailyReturns: number[],
  customParams?: GARCHParams
): GARCHState {
  const params = customParams ?? (DEFAULT_GARCH_PARAMS[ticker] ?? DEFAULT_GARCH_PARAMS['DEFAULT']);

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
  let h = Math.max(initVar, unconditionalVar);
  let lastResidual = 0;

  for (const r of dailyReturns) {
    const eps = r; // demeaned (asumimos media ≈ 0 en retornos diarios)
    h = params.omega + params.alpha * eps * eps + params.beta * h;
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

  // ── PASO 1: Filtro GARCH por activo ──────────────────────────────────────
  const garchStates: GARCHState[] = tickers.map((ticker, i) =>
    initGARCH(ticker, returnMatrix[i])
  );

  // Obtener varianzas condicionales finales (el estado de "hoy")
  const conditionalVariances = garchStates.map(s => s.lastVariance);
  const conditionalVols = conditionalVariances.map(v => Math.sqrt(v * ANNUALIZATION));

  // Construir serie de residuos estandarizados para el DCC
  const T = Math.min(...returnMatrix.map(r => r.length));
  const standardizedResiduals: number[][] = tickers.map((ticker, i) => {
    const state = initGARCH(ticker, returnMatrix[i].slice(0, -1));
    // Re-calcular residuos sobre todo el historial
    const returns = returnMatrix[i];
    const residuals: number[] = [];
    let h = state.unconditionalVar;
    for (const r of returns) {
      const eps = r;
      h = state.params.omega + state.params.alpha * eps * eps + state.params.beta * h;
      residuals.push(h > 0 ? eps / Math.sqrt(h) : 0);
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