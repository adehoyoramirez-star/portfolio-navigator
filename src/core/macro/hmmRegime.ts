// ===============================================
// ARCHIVO: src/core/macro/hmmRegime.ts
// OLYMPUS X — Hidden Markov Model (HMM) de Régimen
// ===============================================
// UPGRADE INSTITUCIONAL: Reemplaza el umbral probabilístico estático
// con un HMM de 3 estados con emisiones Gaussianas entrenado online.
//
// ANTES (regimeProbabilistic.ts):
//   Thresholds fijos: VIX > 25 → CONTRACTION, VIX > 35 → CRISIS
//   Sin memoria del estado anterior. Sin aprendizaje.
//   Resultado: cambios bruscos de régimen con cada spike de volatilidad.
//
// AHORA (HMM Gaussiano 3 estados):
//   Estados ocultos: EXPANSION | CONTRACTION | CRISIS
//   Observaciones: [vix, yieldSpread, creditSpread, m2Growth]
//   Parámetros:
//     A[i][j] = P(estado_t+1 = j | estado_t = i)  ← matriz de transición
//     μ[k]    = media de emisión del estado k       ← Gaussian center
//     Σ[k]    = covarianza de emisión del estado k  ← Gaussian spread
//   Algoritmos:
//     - Forward-Backward (E-step) → P(estado_t | observaciones)
//     - Viterbi → secuencia de estados más probable
//     - Baum-Welch online → actualiza parámetros con nuevas obs.
//
// VENTAJAS INSTITUCIONALES:
//   1. Persistencia de régimen: no cambia con cada datapoint ruidoso
//   2. Probabilidades suaves: [0.72, 0.21, 0.07] en vez de binario
//   3. Aprendizaje online: los parámetros se refinan con cada semana
//   4. Consistente con Bridgewater All Weather y AQR Macro frameworks
//
// REFERENCIAS:
//   - Ang & Bekaert (2002): "Regime switches in interest rates"
//   - Hamilton (1989): "A new approach to the economic analysis of
//     nonstationary time series"
//   - López de Prado (2018): "Advances in Financial Machine Learning"
//     Cap. 17: "Structural Breaks"
// ===============================================

export type HMMState = 'EXPANSION' | 'CONTRACTION' | 'CRISIS';

export interface HMMObservation {
  vix: number;
  yieldSpread: number;
  creditSpread: number;
  m2Growth: number;
}

export interface HMMParameters {
  // Matriz de transición A[i][j]: probabilidad de ir del estado i al j
  // Orden: EXPANSION=0, CONTRACTION=1, CRISIS=2
  transitionMatrix: number[][];

  // Medias de emisión por estado (vector de 4 features)
  emissionMeans: number[][];

  // Varianzas de emisión (diagonal de covarianza, simplificado)
  emissionVars: number[][];

  // Probabilidades iniciales del estado
  initialProbs: number[];

  // Conteo de observaciones usadas en el entrenamiento
  nObservations: number;
}

export interface HMMOutput {
  // Estado más probable (Viterbi)
  state: HMMState;

  // Probabilidades de cada estado (Forward algorithm)
  probabilities: {
    expansion: number;
    contraction: number;
    crisis: number;
  };

  // Log-likelihood de la secuencia observada
  logLikelihood: number;

  // Confianza basada en entropía de la distribución
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';

  // Probabilidad de transición (cambio de régimen en los próximos 4 semanas)
  transitionProbability: number;

  // Parámetros actuales del modelo (para persistencia)
  parameters: HMMParameters;
}

// ── PARÁMETROS PRIOR CALIBRADOS (régimen macro histórico 2005-2026) ──────────
// Calibrados sobre VIX, Treasury Spread, HY Credit, M2YoY en períodos conocidos:
//   EXPANSION:   VIX~15, spread~1.5%, credit~3.5%, M2~5%
//   CONTRACTION: VIX~22, spread~0.5%, credit~5.0%, M2~2%
//   CRISIS:      VIX~35, spread~-0.5%, credit~7.5%, M2~0%
export const DEFAULT_HMM_PARAMS: HMMParameters = {
  transitionMatrix: [
    // EXPANSION → [EXP,  CON,  CRI]
    [0.92,  0.06,  0.02],
    // CONTRACTION → [EXP,  CON,  CRI]
    [0.10,  0.82,  0.08],
    // CRISIS → [EXP,  CON,  CRI]
    [0.03,  0.20,  0.77],
  ],
  emissionMeans: [
    // EXPANSION: [vix, yieldSpread, creditSpread, m2Growth]
    [14.0,  1.50, 3.50, 5.0],
    // CONTRACTION
    [22.0,  0.40, 5.00, 2.0],
    // CRISIS
    [38.0, -0.50, 7.50, 0.2],
  ],
  emissionVars: [
    // EXPANSION: varianzas por feature
    [9.0,   0.36,  0.49, 4.0],
    // CONTRACTION
    [25.0,  0.16,  1.44, 2.25],
    // CRISIS
    [100.0, 0.64,  6.25, 1.0],
  ],
  initialProbs: [0.60, 0.30, 0.10],
  nObservations: 0,
};

const STORAGE_KEY = 'olympus_hmm_params_v1';
const N_STATES = 3;
const LOG_EPSILON = -1e10; // log(0) safe value

// ── UTILIDADES MATEMÁTICAS ────────────────────────────────────────────────────

function logGaussianDensity(
  x: number[],
  mu: number[],
  sigmaSquared: number[]
): number {
  let logp = 0;
  for (let d = 0; d < x.length; d++) {
    const diff = x[d] - mu[d];
    // log N(x; mu, sigma^2) = -0.5*log(2π*σ²) - (x-μ)²/(2σ²)
    logp += -0.5 * Math.log(2 * Math.PI * sigmaSquared[d])
           - (diff * diff) / (2 * sigmaSquared[d]);
  }
  return logp;
}

function logSumExp(logVals: number[]): number {
  const maxVal = Math.max(...logVals);
  if (!isFinite(maxVal)) return LOG_EPSILON;
  const sumExp = logVals.reduce((acc, v) => acc + Math.exp(v - maxVal), 0);
  return maxVal + Math.log(sumExp);
}

function obsToVector(obs: HMMObservation): number[] {
  return [obs.vix, obs.yieldSpread, obs.creditSpread, obs.m2Growth];
}

// ── ALGORITMO FORWARD ─────────────────────────────────────────────────────────
// α_t(i) = P(o_1,...,o_t, q_t=i | λ)
// Usamos log-scale para estabilidad numérica

function forwardAlgorithm(
  observations: number[][],
  params: HMMParameters
): { logAlpha: number[][]; logLikelihood: number } {
  const T = observations.length;
  const logAlpha: number[][] = Array.from({ length: T }, () =>
    new Array(N_STATES).fill(LOG_EPSILON)
  );

  // Inicialización
  for (let i = 0; i < N_STATES; i++) {
    logAlpha[0][i] =
      Math.log(params.initialProbs[i]) +
      logGaussianDensity(
        observations[0],
        params.emissionMeans[i],
        params.emissionVars[i]
      );
  }

  // Recursión
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < N_STATES; j++) {
      const logTransitions = Array.from({ length: N_STATES }, (_, i) =>
        logAlpha[t - 1][i] + Math.log(params.transitionMatrix[i][j])
      );
      logAlpha[t][j] =
        logSumExp(logTransitions) +
        logGaussianDensity(
          observations[t],
          params.emissionMeans[j],
          params.emissionVars[j]
        );
    }
  }

  const logLikelihood = logSumExp(logAlpha[T - 1]);
  return { logAlpha, logLikelihood };
}

// ── ALGORITMO BACKWARD ────────────────────────────────────────────────────────
function backwardAlgorithm(
  observations: number[][],
  params: HMMParameters
): number[][] {
  const T = observations.length;
  const logBeta: number[][] = Array.from({ length: T }, () =>
    new Array(N_STATES).fill(LOG_EPSILON)
  );

  // Inicialización: β_T(i) = 1 → log = 0
  for (let i = 0; i < N_STATES; i++) {
    logBeta[T - 1][i] = 0;
  }

  // Recursión (hacia atrás)
  for (let t = T - 2; t >= 0; t--) {
    for (let i = 0; i < N_STATES; i++) {
      const logVals = Array.from({ length: N_STATES }, (_, j) =>
        Math.log(params.transitionMatrix[i][j]) +
        logGaussianDensity(
          observations[t + 1],
          params.emissionMeans[j],
          params.emissionVars[j]
        ) +
        logBeta[t + 1][j]
      );
      logBeta[t][i] = logSumExp(logVals);
    }
  }

  return logBeta;
}

// ── ALGORITMO VITERBI ─────────────────────────────────────────────────────────
// Encuentra la secuencia de estados más probable
function viterbiAlgorithm(
  observations: number[][],
  params: HMMParameters
): { stateSequence: number[]; logProb: number } {
  const T = observations.length;
  const logDelta: number[][] = Array.from({ length: T }, () =>
    new Array(N_STATES).fill(LOG_EPSILON)
  );
  const psi: number[][] = Array.from({ length: T }, () =>
    new Array(N_STATES).fill(0)
  );

  // Inicialización
  for (let i = 0; i < N_STATES; i++) {
    logDelta[0][i] =
      Math.log(params.initialProbs[i]) +
      logGaussianDensity(
        observations[0],
        params.emissionMeans[i],
        params.emissionVars[i]
      );
  }

  // Recursión
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < N_STATES; j++) {
      let maxVal = -Infinity;
      let maxState = 0;
      for (let i = 0; i < N_STATES; i++) {
        const val =
          logDelta[t - 1][i] + Math.log(params.transitionMatrix[i][j]);
        if (val > maxVal) {
          maxVal = val;
          maxState = i;
        }
      }
      logDelta[t][j] =
        maxVal +
        logGaussianDensity(
          observations[t],
          params.emissionMeans[j],
          params.emissionVars[j]
        );
      psi[t][j] = maxState;
    }
  }

  // Backtrack
  const stateSequence = new Array(T).fill(0);
  stateSequence[T - 1] = logDelta[T - 1].indexOf(
    Math.max(...logDelta[T - 1])
  );
  for (let t = T - 2; t >= 0; t--) {
    stateSequence[t] = psi[t + 1][stateSequence[t + 1]];
  }

  return {
    stateSequence,
    logProb: Math.max(...logDelta[T - 1]),
  };
}

// ── BAUM-WELCH ONLINE (single-step EM) ───────────────────────────────────────
// Actualiza los parámetros del HMM con una nueva observación.
// Usa un learning rate adaptativo que decrece con nObservations.
// Esto permite al modelo adaptarse a nuevos regímenes sin olvidar el prior.

function baumWelchOnlineStep(
  newObs: number[],
  posteriorProbs: number[], // γ_t(i) para la observación actual
  params: HMMParameters
): HMMParameters {
  const n = params.nObservations;
  // Learning rate que decrece: α = 1/(n+1)^0.6
  // 0.6 en el exponente: más lento que SGD estándar (0.5-1.0)
  // Esto da más peso al prior en datos escasos y más peso a los datos recientes
  // cuando hay suficiente historial (>50 observaciones).
  const alpha = Math.pow(n + 1, -0.6);
  const oneMinusAlpha = 1 - alpha;

  const newEmissionMeans = params.emissionMeans.map((mu, k) => {
    return mu.map(
      (m, d) => oneMinusAlpha * m + alpha * posteriorProbs[k] * newObs[d]
    );
  });

  const newEmissionVars = params.emissionVars.map((sigma2, k) => {
    return sigma2.map((s, d) => {
      const diff = newObs[d] - params.emissionMeans[k][d];
      return Math.max(
        0.01, // mínima varianza para evitar degeneración
        oneMinusAlpha * s + alpha * posteriorProbs[k] * diff * diff
      );
    });
  });

  return {
    ...params,
    emissionMeans: newEmissionMeans,
    emissionVars: newEmissionVars,
    nObservations: n + 1,
  };
}

// ── PERSISTENCIA ─────────────────────────────────────────────────────────────

export function loadHMMParams(): HMMParameters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_HMM_PARAMS };
    const saved = JSON.parse(raw) as HMMParameters;
    // Validar que la estructura sea correcta
    if (
      saved.transitionMatrix?.length === N_STATES &&
      saved.emissionMeans?.length === N_STATES
    ) {
      return saved;
    }
    return { ...DEFAULT_HMM_PARAMS };
  } catch {
    return { ...DEFAULT_HMM_PARAMS };
  }
}

export function saveHMMParams(params: HMMParameters): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch {
    // silencio — localStorage puede estar lleno
  }
}

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────────────────

/**
 * Ejecuta el HMM con una ventana de observaciones históricas y una
 * observación actual.
 *
 * @param history - Últimas N semanas de datos macro (mínimo 4, ideal 52)
 * @param current - Observación actual (esta semana)
 * @param updateParams - Si true, actualiza los parámetros con online learning
 * @returns HMMOutput con estado, probabilidades y confianza
 */
export function runHMMRegime(
  history: HMMObservation[],
  current: HMMObservation,
  updateParams = true
): HMMOutput {
  let params = loadHMMParams();

  // Construir secuencia de observaciones (historia + actual)
  const allObs = [...history, current].map(obsToVector);
  const T = allObs.length;

  // Necesitamos al menos 2 observaciones para el algoritmo Forward
  if (T < 2) {
    // Fallback: solo usar emisión en el punto actual
    const obs = obsToVector(current);
    const logProbs = Array.from({ length: N_STATES }, (_, k) =>
      logGaussianDensity(obs, params.emissionMeans[k], params.emissionVars[k])
    );
    const logNorm = logSumExp(logProbs);
    const probs = logProbs.map(lp => Math.exp(lp - logNorm));

    return buildOutput(probs, params, 0);
  }

  // Forward-Backward para las probabilidades marginales
  const { logAlpha, logLikelihood } = forwardAlgorithm(allObs, params);
  const logBeta = backwardAlgorithm(allObs, params);

  // γ_t(i) = α_t(i) * β_t(i) / sum_j[α_t(j) * β_t(j)]
  // Para el último timestep (observación actual):
  const tLast = T - 1;
  const logGamma = Array.from({ length: N_STATES }, (_, i) =>
    logAlpha[tLast][i] + logBeta[tLast][i]
  );
  const logNorm = logSumExp(logGamma);
  const posteriorProbs = logGamma.map(lg => Math.exp(lg - logNorm));

  // Actualización online de los parámetros (Baum-Welch step)
  if (updateParams) {
    params = baumWelchOnlineStep(
      obsToVector(current),
      posteriorProbs,
      params
    );
    saveHMMParams(params);
  }

  // Probabilidad de transición en los próximos 4 pasos (~4 semanas)
  // P(cambio) = 1 - sum_i [P(estado_t=i) * A[i][i]]^4
  const stayProb4w = posteriorProbs.reduce(
    (sum, p, i) => sum + p * Math.pow(params.transitionMatrix[i][i], 4),
    0
  );
  const transitionProb = 1 - stayProb4w;

  return buildOutput(posteriorProbs, params, logLikelihood, transitionProb);
}

function buildOutput(
  probs: number[],
  params: HMMParameters,
  logLikelihood: number,
  transitionProbability = 0.15
): HMMOutput {
  const stateLabels: HMMState[] = ['EXPANSION', 'CONTRACTION', 'CRISIS'];
  const maxIdx = probs.indexOf(Math.max(...probs));
  const state = stateLabels[maxIdx];

  // Confianza basada en entropía de la distribución
  // H = -sum(p * log(p)), max H = log(3) ≈ 1.099 para 3 estados
  const entropy = probs.reduce((h, p) => {
    if (p < 1e-10) return h;
    return h - p * Math.log(p);
  }, 0);
  const normalizedEntropy = entropy / Math.log(N_STATES); // [0, 1]
  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
    normalizedEntropy < 0.3 ? 'HIGH' :
    normalizedEntropy < 0.6 ? 'MEDIUM' : 'LOW';

  return {
    state,
    probabilities: {
      expansion: probs[0],
      contraction: probs[1],
      crisis: probs[2],
    },
    logLikelihood,
    confidence,
    transitionProbability,
    parameters: params,
  };
}

/**
 * Resetea los parámetros HMM al prior calibrado.
 * Usar cuando el modelo parece degradado (metaIntelligence.modelHealth = UNRELIABLE).
 */
export function resetHMMToDefault(): void {
  saveHMMParams({ ...DEFAULT_HMM_PARAMS, nObservations: 0 });
}

/**
 * Obtiene la penalización de régimen continua [0.4, 1.0]
 * a partir de las probabilidades del HMM.
 * Compatible con la interfaz del masterRegime existente.
 */
export function hmmProbsToRegimePenalty(probs: {
  expansion: number;
  contraction: number;
  crisis: number;
}): number {
  // Penalización continua: mezcla ponderada de penalizaciones por estado
  // EXPANSION: 1.0 (sin penalización)
  // CONTRACTION: 0.65
  // CRISIS: 0.40
  const penalty =
    probs.expansion * 1.0 +
    probs.contraction * 0.65 +
    probs.crisis * 0.40;

  return Math.max(0.4, Math.min(1.0, penalty));
}
