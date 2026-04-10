// ===============================================
// ARCHIVO: src/core/config/engineConfig.ts
// CONFIGURACIÓN CENTRALIZADA DEL MOTOR OLYMPUS V3+
// FIX-SCALE-01: Kill Switch calibrado para portfolio pequeño (<€20k)
// FIX-BOND2Y-DOC: documentar que bond2y es input MANUAL (no ^IRX)
// ===============================================
//
// PROBLEMA DE ESCALA (FIX-SCALE-01):
//   El motor original aplicaba los mismos overlays que un fondo de €10M
//   a un portfolio de €5-10k. A esa escala, el Kill Switch L1 (DD -5%)
//   bloqueaba compras con solo €285 de pérdida no realizada.
//   Resultado: el motor perdía TODAS las oportunidades de corrección.
//
// SOLUCIÓN: Ajustar triggers de drawdown para portfolio < €20k:
//   - L1 sube de -5% → -8%  (€400 de pérdida en €5k = poco significativo)
//   - L2 sube de -10% → -15% (más margen antes de frenar del todo)
//   - L3-L5 sin cambios (estos sí son daños reales a cualquier escala)
//   - Vol target sube de 18% → 20% (BTC justifica mayor tolerancia)
//
// NOTA IMPORTANTE BOND 2Y:
//   bond2y = input MANUAL del usuario. Fuente correcta:
//   https://home.treasury.gov/resource-center/data-chart-center/interest-rates/
//   "Daily Treasury Par Yield Curve Rates" → columna "2 yr"
//   Hoy (abril 2026): aprox 3.85%
//   NO usar ^IRX (T-Bill 3 meses ≈ 5.2%) — son instrumentos distintos.
// ===============================================

export const ENGINE_CONFIG_VERSION = "3.6.0"; // bump por FIX-SCALE-01

// ── KELLY CRITERION ───────────────────────────────────────────────────────
export const KELLY_CONFIG = {
  // Cap 20% — reducido de 0.25 per walk-forward optimizer (overfitting HIGH)
  CAP: 0.20,
  HALF_FRACTION: 0.5,
} as const;

// ── VOLATILITY TARGETING ───────────────────────────────────────────────────
export const VOLATILITY_CONFIG = {
  // FIX-SCALE-01: subido de 0.18 → 0.20
  // Con BTC en cartera (~20-25% peso) la volatilidad natural es 20-22%.
  // Un target de 18% era demasiado estricto y hacía que el motor redujera
  // exposición constantemente sin necesidad real.
  DEFAULT_TARGET_VOL: 0.20,

  MULTIPLIER_MIN: 0.3,
  MULTIPLIER_MAX: 1.5,

  REGIME_FACTOR_BASE: 0.60,
  REGIME_FACTOR_RANGE: 0.40,
  PENALTY_MIN: 0.4,
} as const;

// ── CEWS (Crisis Early Warning System) ─────────────────────────────────────
export const CEWS_CONFIG = {
  THRESHOLDS: {
    yieldSpread: {
      warning: 0.0,
      danger: -0.5,
    },
    creditSpread: {
      warning: 2.0,
      danger: 3.5,
    },
    m2Growth: {
      warning: 2.0,
      danger: 0.0,
    },
    vixCluster: {
      warning: 22,
      danger: 35,
    },
  },

  PENALTY_ADJUSTMENT: {
    CLEAR: 0,
    WATCH: -0.05,
    WARNING: -0.10,
    ALERT: -0.20,
  } as const,

  MAX_HISTORY_DAYS: 168,
  STORAGE_KEY: "olympus_cews_history_v1",
} as const;

// ── MASTER REGIME ──────────────────────────────────────────────────────────
export const REGIME_CONFIG = {
  CRISIS_SCORE_THRESHOLD: 25,
  CONTRACTION_THRESHOLD: 10,
  PENALTY_MIN: 0.4,
  PENALTY_MAX: 1.0,
  BINARY_WEIGHT: 0.4,
  CONTINUOUS_WEIGHT: 0.6,
} as const;

// ── TAIL RISK OVERLAY — FIX-SCALE-01 ─────────────────────────────────────
// ANTES: triggers en -5%, -10%, -15%, -20%, -25%
//   Problema: con €5.685 de portfolio, un DD de -5% = -€285.
//   Bloquear compras por €285 de pérdida no realizada en una corrección
//   de mercado hace que el motor pierda las mejores oportunidades.
//
// AHORA: triggers ajustados para escala pequeña (<€20k):
//   L1: -8%  (era -5%)  → reducción preventiva mínima
//   L2: -15% (era -10%) → reducción moderada
//   L3: -20% (era -15%) → modo defensivo real
//   L4: -25% (era -20%) → salida casi total
//   L5: -32% (era -25%) → protección máxima
//
// Los porcentajes de reducción de exposición NO cambian (son correctos).
// Solo cambian los UMBRALES de activación.
//
// FILOSOFÍA: Un fondo de €500M con -5% DD = -€25M de pérdida. Para ellos
// tiene sentido frenar inmediatamente. Con €5k, -5% = -€250. El motor
// debe seguir operando normalmente hasta daños más significativos.
export const TAIL_RISK_CONFIG = {
  KILL_SWITCH: {
    L1: { threshold: 0.08, name: "REDUCCIÓN PREVENTIVA", overlay: 0.85, reduction: 0.15 },
    L2: { threshold: 0.15, name: "REDUCCIÓN MODERADA",   overlay: 0.65, reduction: 0.35 },
    L3: { threshold: 0.20, name: "MODO DEFENSIVO",       overlay: 0.50, reduction: 0.50 },
    L4: { threshold: 0.25, name: "SALIDA CASI TOTAL",    overlay: 0.35, reduction: 0.65 },
    L5: { threshold: 0.32, name: "PROTECCIÓN MÁXIMA",    overlay: 0.30, reduction: 0.70 },
  },
  MIN_ALLOCATION: 0.25,
} as const;

// ── RISK BUDGET POR SECTOR ─────────────────────────────────────────────────
export const SECTOR_RISK_BUDGET: Record<string, number> = {
  crypto:      0.6,
  emerging:    1.0,
  equity:      1.0,
  gold:        1.0,
  uranium:     0.9,
  semis:       1.0,
  real_estate: 1.0,
  technology:  1.0,
  energy:      0.9,
} as const;

// ── FACTOR CALIBRATION (primas AQR) ───────────────────────────────────────
export const FACTOR_CONFIG = {
  DEFAULT_WEIGHTS: {
    momentum: 0.35,  // FIX: reducido de 0.40 — menos concentración en momentum
    value:    0.25,
    quality:  0.25,  // FIX: aumentado de 0.20 — quality es más estable en ciclo bajista
    lowVol:   0.15,
  },

  FACTOR_PREMIUMS: {
    momentum: 0.04,
    value:    0.03,
    quality:  0.025, // FIX: subido de 0.02 — prima quality documentada mayor tras 2020
    lowVol:   0.015,
  },

  EXPECTED_RETURN_MIN: -0.30,
  EXPECTED_RETURN_MAX: 0.80,
} as const;

// ── BLACK-LITTERMAN ───────────────────────────────────────────────────────
export const BL_CONFIG = {
  RISK_AVERSION: 2.5,
  TAU: 0.05,
  OMEGA_MIN: 1e-6,
} as const;

// ── DURATION ADJUSTMENT ────────────────────────────────────────────────────
export const DURATION_CONFIG = {
  CRISIS_YOUNG_PENALTY: -0.10,
  CRISIS_MATURE_PENALTY: -0.05,
  CRISIS_OLD_BONUS: 0.08,
  YOUNG_THRESHOLD: 4,
  OLD_THRESHOLD: 12,
} as const;

// ── STORAGE KEYS ───────────────────────────────────────────────────────────
export const STORAGE_KEYS = {
  PORTFOLIO:      "olympus_portfolio_v1",
  MACRO:          "olympus_macro_v1",
  REGIME_HISTORY: "olympus_regime_history_v1",
  DAILY_SNAPSHOTS:"olympus_daily_snapshots_v1",
  CEWS_HISTORY:   "olympus_cews_history_v1",
  DECISION_LOG:   "olympus_decision_log_v1",
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

// ── NOTA IS3Q vs IS3R ─────────────────────────────────────────────────────
// IS3Q.DE = iShares MSCI World Quality Factor (ISIN: IE00BP3QZ601)
//   Selección: ROE alto, deuda baja, beneficios estables
//   Comportamiento: defensivo, baja vol (~15%), buen compounder LP
//   factorRole: "quality"
//
// IS3R.DE = iShares MSCI World Momentum Factor (ISIN: IE00BP3QZ825)
//   Selección: acciones con mejor rendimiento relativo 6-12 meses
//   Comportamiento: cíclico, sigue tendencias, vol media (~18%)
//   factorRole: "momentum"
//   *** NO confundir con Russell 2000 (Small Cap USA) ***
//
// Son complementarios: Quality defiende en correcciones, Momentum acelera en tendencias.
// Si se añade IS3R al portfolio, reducir proporcionalmente VVSM.DE o XNAS.DE
// para no superar el SECTOR_CAP de tecnología/equity del 35%.
// ─────────────────────────────────────────────────────────────────────────
