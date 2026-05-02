// ===============================================
// ARCHIVO: src/core/factors/kalmanFactorWeights.ts
// OLYMPUS X — Factor Weights Adaptativos con Filtro de Kalman
// ===============================================
// UPGRADE INSTITUCIONAL: Los pesos de factores (momentum, value,
// quality, lowVol) estaban fijos en engineConfig.ts.
//
// ANTES:
//   FACTOR_CONFIG.DEFAULT_WEIGHTS = { momentum: 0.35, value: 0.25, ... }
//   Sin actualización. Un mismo peso en 2008, 2020, y 2026.
//   Problema: el factor momentum outperforma en expansion, se destruye en crises.
//   El factor quality es defensivo, pero costoso en rallies.
//
// AHORA (Filtro de Kalman):
//   Estado: vector de pesos de factores [w_mom, w_val, w_qual, w_lvol]
//   Transición: w_t = F * w_{t-1} + Q (random walk con ruido Q)
//   Observación: retorno_t = H_t * w_{t} + R (factor returns * pesos + ruido)
//
//   Esto permite que los pesos se adapten automáticamente a qué factores
//   están funcionando en el régimen actual, con amortiguación controlada.
//
// CICLO DE APRENDIZAJE:
//   1. Cada semana, observamos el retorno realizado del portfolio
//   2. Calculamos qué factores contribuyeron más al retorno (H_t)
//   3. Kalman Update ajusta los pesos hacia los factores más predictivos
//   4. Kalman Predict proyecta los pesos para la semana siguiente
//
// PROPIEDADES INSTITUCIONALES:
//   - No overfits: el ruido de proceso Q controla la velocidad de adaptación
//   - Reversion to mean: los pesos vuelven hacia el prior cuando hay
//     incertidumbre (P → ∞)
//   - Memory adaptativa: ~52 semanas de historia efectiva (depende de Q/R)
//
// REFERENCIAS:
//   - Harvey (1989): "Forecasting, Structural Time Series Models and the
//     Kalman Filter"
//   - Blitz & Van Vliet (2007): "The Volatility Effect" (Factor timing)
//   - Asness et al. (2015): "Fact, Fiction and Factor Investing"
// ===============================================

export interface FactorWeights {
  momentum: number;
  value: number;
  quality: number;
  lowVol: number;
}

export interface FactorObservation {
  // Retornos de cada factor en el periodo (ej: semana pasada)
  momentumReturn: number;  // retorno del decil momentum top
  valueReturn: number;     // retorno del decil value top
  qualityReturn: number;   // retorno del decil quality top
  lowVolReturn: number;    // retorno del decil lowVol top

  // Retorno realizado del portfolio (para calibración)
  portfolioReturn: number;

  // Régimen del periodo (para contextualizar el aprendizaje)
  regime: 'EXPANSION' | 'CONTRACTION' | 'CRISIS';
}

export interface KalmanState {
  // Vector de estado: pesos de factores estimados [4x1]
  weights: number[];      // [w_mom, w_val, w_qual, w_lvol]

  // Matriz de covarianza del estado [4x4] (incertidumbre en los pesos)
  P: number[][];

  // Número de observaciones asimiladas
  nUpdates: number;

  // Historial de innovaciones (residuos) para diagnóstico
  innovations: number[];  // últimas 12 semanas
}

// ── HIPERPARÁMETROS DEL FILTRO DE KALMAN ─────────────────────────────────────
// Q: ruido de proceso — controla cuánto pueden cambiar los pesos por semana
//    Q alto → adaptación rápida (riesgo: overfitting)
//    Q bajo → adaptación lenta (riesgo: stale weights)
//    Calibrado para ~1 año de datos hasta que los pesos se estabilizan al 50%
const PROCESS_NOISE_Q = 0.0002;  // varianza de cambio semanal de pesos

// R: ruido de observación — confianza en la relación factor→retorno
//    R alto → ignoramos observaciones (confiamos en el prior)
//    R bajo → seguimos las observaciones agresivamente
const OBSERVATION_NOISE_R = 0.0010;  // varianza del retorno del portfolio

const STORAGE_KEY = 'olympus_kalman_weights_v1';

// Prior: pesos iniciales centrados en la calibración AQR
const PRIOR_WEIGHTS: number[] = [0.35, 0.25, 0.25, 0.15];

// Prior de incertidumbre: alta incertidumbre inicial → deja que los datos hablen
const PRIOR_P_DIAG = 0.01;

export function createInitialKalmanState(): KalmanState {
  return {
    weights: [...PRIOR_WEIGHTS],
    P: [
      [PRIOR_P_DIAG, 0, 0, 0],
      [0, PRIOR_P_DIAG, 0, 0],
      [0, 0, PRIOR_P_DIAG, 0],
      [0, 0, 0, PRIOR_P_DIAG],
    ],
    nUpdates: 0,
    innovations: [],
  };
}

// ── STEP 1: PREDICT ───────────────────────────────────────────────────────────
// Proyecta el estado al siguiente periodo.
// Para factor weights usamos un random walk: w_{t|t-1} = w_{t-1|t-1}
// pero aumentamos la incertidumbre P por el ruido de proceso Q.

function kalmanPredict(state: KalmanState): KalmanState {
  const n = state.weights.length;

  // P_{t|t-1} = P_{t-1|t-1} + Q (proceso de random walk)
  const newP = state.P.map((row, i) =>
    row.map((p, j) => p + (i === j ? PROCESS_NOISE_Q : 0))
  );

  return {
    ...state,
    P: newP,
  };
}

// ── STEP 2: UPDATE ────────────────────────────────────────────────────────────
// Incorpora una nueva observación.
// Modelo de observación:
//   y_t = H_t * w_t + v_t
// donde:
//   y_t = retorno realizado del portfolio
//   H_t = vector de factor returns [r_mom, r_val, r_qual, r_lvol]
//   v_t ~ N(0, R)

function kalmanUpdate(
  state: KalmanState,
  obs: FactorObservation,
  regimeAdjustedR: number
): KalmanState {
  // H = vector de factor returns (modelo de observación lineal)
  const H = [
    obs.momentumReturn,
    obs.valueReturn,
    obs.qualityReturn,
    obs.lowVolReturn,
  ];
  const n = H.length;

  // Retorno predicho: ŷ = H * w_{t|t-1}
  const yPred = H.reduce((sum, h, i) => sum + h * state.weights[i], 0);
  const innovation = obs.portfolioReturn - yPred;

  // S = H * P * H' + R (innovación covarianza)
  const PH = matVecMul(state.P, H);
  const HPH = vecDot(H, PH);
  const S = HPH + regimeAdjustedR;

  // K = P * H' / S (Kalman gain)
  const K = PH.map(ph => ph / S);

  // Actualizar pesos: w_{t|t} = w_{t|t-1} + K * innovation
  const newWeights = state.weights.map((w, i) => w + K[i] * innovation);

  // Actualizar covarianza: P_{t|t} = (I - K*H') * P
  // Joseph form para estabilidad numérica: P = (I-KH)*P*(I-KH)' + K*R*K'
  const IminusKH = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      (i === j ? 1 : 0) - K[i] * H[j]
    )
  );
  const newP = matMulAdd(IminusKH, state.P, K, regimeAdjustedR);

  // Normalizar pesos para que sumen 1 y sean positivos
  const normalizedWeights = normalizeWeightsWithFloors(newWeights);

  // Actualizar historial de innovaciones
  const newInnovations = [...state.innovations.slice(-11), innovation];

  return {
    weights: normalizedWeights,
    P: newP,
    nUpdates: state.nUpdates + 1,
    innovations: newInnovations,
  };
}

// ── NORMALIZACIÓN CON FLOORS ──────────────────────────────────────────────────
// Mantenemos pesos entre [0.05, 0.60] para evitar degeneración
function normalizeWeightsWithFloors(weights: number[]): number[] {
  const minW = 0.05;
  const maxW = 0.60;

  // Aplicar límites
  let clipped = weights.map(w => Math.max(minW, Math.min(maxW, w)));

  // Normalizar a suma = 1
  const total = clipped.reduce((s, w) => s + w, 0);
  if (total > 0) {
    clipped = clipped.map(w => w / total);
  } else {
    clipped = [...PRIOR_WEIGHTS];
  }

  return clipped;
}

// ── AJUSTE POR RÉGIMEN ────────────────────────────────────────────────────────
// En CRISIS, aumentamos R (observación noise) porque las relaciones factor-retorno
// se rompen (correlaciones spike a 1, factor momentum se destruye en crashes).
// El sistema confía más en el prior y menos en las observaciones recientes.

function regimeAdjustedObservationNoise(
  regime: 'EXPANSION' | 'CONTRACTION' | 'CRISIS'
): number {
  switch (regime) {
    case 'EXPANSION':   return OBSERVATION_NOISE_R;
    case 'CONTRACTION': return OBSERVATION_NOISE_R * 2.0;
    case 'CRISIS':      return OBSERVATION_NOISE_R * 5.0;
  }
}

// ── PERSISTENCIA ─────────────────────────────────────────────────────────────

export function loadKalmanState(): KalmanState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialKalmanState();
    const saved = JSON.parse(raw) as KalmanState;
    if (saved.weights?.length === 4 && saved.P?.length === 4) {
      return saved;
    }
    return createInitialKalmanState();
  } catch {
    return createInitialKalmanState();
  }
}

export function saveKalmanState(state: KalmanState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // silencio
  }
}

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────────────────

/**
 * Actualiza los pesos de factores con una nueva observación y devuelve
 * los pesos adaptativos para la siguiente semana.
 *
 * @param observation - Retornos de factores y del portfolio esta semana
 * @returns FactorWeights adaptativos para la siguiente semana
 */
export function updateKalmanFactorWeights(
  observation: FactorObservation
): { weights: FactorWeights; state: KalmanState; diagnostics: KalmanDiagnostics } {
  let state = loadKalmanState();

  // Paso 1: Predict
  state = kalmanPredict(state);

  // Paso 2: Update con ruido ajustado por régimen
  const R = regimeAdjustedObservationNoise(observation.regime);
  state = kalmanUpdate(state, observation, R);

  // Guardar estado actualizado
  saveKalmanState(state);

  const weights: FactorWeights = {
    momentum: state.weights[0],
    value: state.weights[1],
    quality: state.weights[2],
    lowVol: state.weights[3],
  };

  const diagnostics = computeDiagnostics(state);

  return { weights, state, diagnostics };
}

/**
 * Obtiene los pesos actuales sin actualizar (para usar en el motor).
 */
export function getCurrentKalmanWeights(): FactorWeights {
  const state = loadKalmanState();
  return {
    momentum: state.weights[0],
    value: state.weights[1],
    quality: state.weights[2],
    lowVol: state.weights[3],
  };
}

// ── DIAGNÓSTICOS ──────────────────────────────────────────────────────────────

export interface KalmanDiagnostics {
  // Incertidumbre actual en los pesos (sqrt de diagonales de P)
  weightUncertainty: FactorWeights;

  // Ratio señal-ruido actual
  snratio: number;

  // Autocorrelación de innovaciones (deberían ser ~0 si el modelo es correcto)
  innovationAutocorr: number;

  // Health del modelo
  modelHealth: 'CALIBRATED' | 'LEARNING' | 'UNCERTAIN';

  // Número de actualizaciones (madurez del modelo)
  nUpdates: number;
}

function computeDiagnostics(state: KalmanState): KalmanDiagnostics {
  const uncertainty: FactorWeights = {
    momentum: Math.sqrt(Math.abs(state.P[0][0])),
    value: Math.sqrt(Math.abs(state.P[1][1])),
    quality: Math.sqrt(Math.abs(state.P[2][2])),
    lowVol: Math.sqrt(Math.abs(state.P[3][3])),
  };

  const avgUncertainty = (
    uncertainty.momentum + uncertainty.value +
    uncertainty.quality + uncertainty.lowVol
  ) / 4;

  const snratio = avgUncertainty > 0 ? 1 / avgUncertainty : 0;

  // Autocorrelación lag-1 de innovaciones
  let innovationAutocorr = 0;
  if (state.innovations.length >= 4) {
    const inv = state.innovations;
    const n = inv.length;
    const mean = inv.reduce((s, v) => s + v, 0) / n;
    const variance = inv.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    if (variance > 0) {
      let cov = 0;
      for (let i = 1; i < n; i++) {
        cov += (inv[i] - mean) * (inv[i - 1] - mean);
      }
      innovationAutocorr = (cov / (n - 1)) / variance;
    }
  }

  const modelHealth: 'CALIBRATED' | 'LEARNING' | 'UNCERTAIN' =
    state.nUpdates >= 52 && Math.abs(innovationAutocorr) < 0.3
      ? 'CALIBRATED'
      : state.nUpdates >= 12
        ? 'LEARNING'
        : 'UNCERTAIN';

  return {
    weightUncertainty: uncertainty,
    snratio,
    innovationAutocorr,
    modelHealth,
    nUpdates: state.nUpdates,
  };
}

// ── ÁLGEBRA LINEAL ────────────────────────────────────────────────────────────

function matVecMul(A: number[][], v: number[]): number[] {
  return A.map(row => row.reduce((sum, aij, j) => sum + aij * v[j], 0));
}

function vecDot(a: number[], b: number[]): number {
  return a.reduce((sum, ai, i) => sum + ai * b[i], 0);
}

// Joseph form: (I-KH)*P*(I-KH)' + K*R*K'
function matMulAdd(
  IKH: number[][],
  P: number[][],
  K: number[],
  R: number
): number[][] {
  const n = K.length;
  // Calcular (I-KH)*P
  const IKHP = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      IKH[i].reduce((sum, ikhi, k) => sum + ikhi * P[k][j], 0)
    )
  );
  // Calcular (I-KH)*P*(I-KH)'
  const IKHt = IKH[0].map((_, j) => IKH.map(row => row[j]));
  const newP = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      IKHP[i].reduce((sum, ikhpi, k) => sum + ikhpi * IKHt[k][j], 0) +
      K[i] * R * K[j]
    )
  );
  return newP;
}
