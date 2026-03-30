// ===============================================
// ARCHIVO: src/core/config/engineConfig.ts
// CONFIGURACIÓN CENTRALIZADA DEL MOTOR OLYMPUS V3
// LOW-01: Centralización de constantes mágicas
// ===============================================
// Este archivo centraliza todas las constantes que antes estaban
// dispersas en múltiples archivos. Facilita calibración y auditoría.
//
// Filosofía:
//   - Todos los thresholds y parámetros calibrables en un solo lugar
//   - Valores documentados con justificación académica/institucional
//   - Versionado para trazabilidad regulatoria
// ===============================================

export const ENGINE_CONFIG_VERSION = "3.5.1";

// ── KELLY CRITERION ───────────────────────────────────────────────────────
export const KELLY_CONFIG = {
  // Cap institucional: ningún activo puede tener >25% antes de normalización
  // Referencia: Thorp (2006) - half-kelly reduce volatilidad ~30% con pérdida mínima
  CAP: 0.25,
  HALF_FRACTION: 0.5, // usar mitad del Kelly óptimo

  // Justificación: con 7 activos, permitir >25% destruye diversificación
  // y concentra riesgo en un solo activo
} as const;

// ── VOLATILITY TARGETING ───────────────────────────────────────────────────
export const VOLATILITY_CONFIG = {
  // Target vol anual para portfolio multi-activo con BTC
  // 18% = más alto que 12-15% institucional estándar porque BTC añade vol
  DEFAULT_TARGET_VOL: 0.18,

  // Caps de multiplicador de exposición
  MULTIPLIER_MIN: 0.3,  // nunca reducir <30% (mantiene posición)
  MULTIPLIER_MAX: 1.5,  // nunca apalancar >1.5x (prudencia institucional)

  // Regime factor remapping
  // penalty [0.4, 1.0] → regimeFactor [0.60, 1.0]
  REGIME_FACTOR_BASE: 0.60,
  REGIME_FACTOR_RANGE: 0.40,
  PENALTY_MIN: 0.4,
} as const;

// ── CEWS (Crisis Early Warning System) ─────────────────────────────────────
export const CEWS_CONFIG = {
  // Umbrales de alerta por señal
  THRESHOLDS: {
    YIELD_SPREAD: {
      WARNING: 0.0,    // curva plana
      DANGER: -0.5,   // curva invertida -50bps
    },
    CREDIT_SPREAD: {
      WARNING: 2.0,    // spreads elevados
      DANGER: 3.5,     // estrés sistémico (Lehman: 6%, COVID: 4.5%)
    },
    M2_GROWTH: {
      WARNING: 2.0,   // crecimiento muy bajo
      DANGER: 0.0,    // contracción (históricamente raro y peligroso)
    },
    VIX_CLUSTER: {
      WARNING: 25,    // volatilidad elevada
      DANGER: 35,     // pánico
    },
  },

  // Penalizaciones por nivel de alerta
  PENALTY_ADJUSTMENT: {
    CLEAR: 0,
    WATCH: -0.05,
    WARNING: -0.10,
    ALERT: -0.20,
  } as const,

  // Historial máximo en días (24 semanas)
  MAX_HISTORY_DAYS: 168,
  STORAGE_KEY: "olympus_cews_history_v1",
} as const;

// ── MASTER REGIME ──────────────────────────────────────────────────────────
export const REGIME_CONFIG = {
  // Umbrales de clasificación
  CRISIS_SCORE_THRESHOLD: 25,    // score > 25 = CRISIS
  CONTRACTION_THRESHOLD: 10,     // score > 10 = CONTRACTION (FIX MATH-01: era 15)

  // Rango de penalización continua
  PENALTY_MIN: 0.4,   // CRISIS extrema
  PENALTY_MAX: 1.0,   // EXPANSIÓN

  // Componentes del blend
  BINARY_WEIGHT: 0.4,
  CONTINUOUS_WEIGHT: 0.6,
} as const;

// ── TAIL RISK OVERLAY ─────────────────────────────────────────────────────
export const TAIL_RISK_CONFIG = {
  // Triggers de overlay
  OVERLAYS: [
    { trigger: "DRAWDOWN_SEVERE", condition: { drawdown: 0.25 }, overlay: 0.40 },
    { trigger: "CRISIS_EXTREME", condition: { vix: 35, creditSpread: 0.03 }, overlay: 0.45 },
    { trigger: "DRAWDOWN_VIX", condition: { drawdown: 0.15, vix: 35 }, overlay: 0.55 },
    { trigger: "DRAWDOWN_STRESS", condition: { drawdown: 0.10, stressScore: 6 }, overlay: 0.65 },
  ] as const,

  // Overlay mínimo (nunca reducir a 0)
  MIN_ALLOCATION: 0.40,
} as const;

// ── RISK BUDGET POR SECTOR ─────────────────────────────────────────────────
export const SECTOR_RISK_BUDGET: Record<string, number> = {
  crypto: 0.6,      // 40% menos budget por volatilidad extrema
  emerging: 1.0,    // estándar
  equity: 1.0,      // estándar
  gold: 1.0,        // estándar (refugio)
  uranium: 0.9,     // algo más volátil que equity estándar
  semis: 1.0,       // estándar (sector específico pero no emergente)
  real_estate: 1.0, // estándar
} as const;

// ── FACTOR CALIBRATION (primas AQR) ───────────────────────────────────────
export const FACTOR_CONFIG = {
  // Pesos por defecto
  DEFAULT_WEIGHTS: {
    momentum: 0.40,
    value: 0.25,
    quality: 0.20,
    lowVol: 0.15,
  },

  // Primas de factor anuales calibradas con datos AQR
  FACTOR_PREMIUMS: {
    momentum: 0.04,    // 4% anual
    value: 0.03,       // 3% anual
    quality: 0.02,     // 2% anual
    lowVol: 0.015,     // 1.5% anual (low-vol anomaly)
  },

  // Bounds de retorno esperado
  EXPECTED_RETURN_MIN: -0.30,
  EXPECTED_RETURN_MAX: 0.80,
} as const;

// ── BLACK-LITTERMAN ───────────────────────────────────────────────────────
export const BL_CONFIG = {
  // Parámetros estándar
  RISK_AVERSION: 2.5,    // δ estándar para mercados
  TAU: 0.05,             // τ estándar para incertidumbre de prior

  // FIX MATH-02: omega ya no es constante
  // Ahora se calcula como: uncertainty_ratio × P×Σ×P^T
  OMEGA_MIN: 1e-6,      // floor para evitar división por cero
} as const;

// ── DURATION ADJUSTMENT ────────────────────────────────────────────────────
export const DURATION_CONFIG = {
  // Ajuste por madurez del régimen
  // Crisis JOVEN: más conservador (-0.10)
  // Crisis MADURA: algo conservador (-0.05)
  // Crisis VIEJA: preparar ataque (+0.08)
  CRISIS_YOUNG_PENALTY: -0.10,
  CRISIS_MATURE_PENALTY: -0.05,
  CRISIS_OLD_BONUS: 0.08,

  // Umbrales de madurez en semanas
  YOUNG_THRESHOLD: 4,
  OLD_THRESHOLD: 12,
} as const;

// ── STORAGE KEYS ───────────────────────────────────────────────────────────
export const STORAGE_KEYS = {
  PORTFOLIO: "olympus_portfolio_v1",
  MACRO: "olympus_macro_v1",
  REGIME_HISTORY: "olympus_regime_history_v1",
  CEWS_HISTORY: "olympus_cews_history_v1",
  DECISION_LOG: "olympus_decision_log_v1",
} as const;

// ── API LIMITS ─────────────────────────────────────────────────────────────
export const API_CONFIG = {
  YAHOO: {
    RATE_LIMIT_PER_MINUTE: 60,
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
  },
  FRED: {
    RATE_LIMIT_PER_MINUTE: 30,
    MAX_RETRIES: 3,
  },
} as const;