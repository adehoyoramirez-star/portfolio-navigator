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
//   - L1 sube de -5% → -8% (FIX-SCALE-01) → -12% (FIX-L1-BTC, 22-Jun-2026)
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

export const ENGINE_CONFIG_VERSION = "3.7.1"; // FIX MATH-02 + A2 intermediate band + A1 M2 sigmoid

// ── ERP TRIGGER ────────────────────────────────────────────────────────────
// Reducción forzada de exposición cuando el Equity Risk Premium está comprimido.
// Basado en evidencia histórica: ERP < 2.5% precede correcciones del 15-25%
// en los siguientes 6 meses con alta frecuencia (64% desde 1990).
export const ERP_CONFIG = {
  TRIGGER_THRESHOLD: 0.025,    // 2.5% ERP — señal de warning
  MAX_EXPOSURE: 0.85,          // Cap forzado al 85% (recalibrado: antes 60%). Permite mas equity en ERP comprimido sin sacrificar proteccion.
  CRITICAL_THRESHOLD: 0.005,   // 0.5% ERP — señal de peligro extremo (recalibrado: antes 1.0%)
  CRITICAL_EXPOSURE: 0.50,     // Cap forzado al 50% en peligro extremo (recalibrado: antes 35%)
} as const;

// ── CORRELATION PANIC TRIGGER ────────────────────────────────────────────
// Forzar reducción de exposición cuando las correlaciones entre activos
// convergen a niveles de pánico (>0.85). En mercados con estrés severo
// (COVID 2020, 2008), todas las correlaciones tienden a 1.0, haciendo
// que la diversificación (HRP, MinVar) sea inútil.
//
// Lógica:
//   - avgCorrelation > 0.85 → exposición máxima 50%
//   - avgCorrelation > 0.95 → exposición máxima 35% (correlación casi total)
//   - Se aplica DESPUÉS del ERP trigger y Alpha-Boost
//   - No incrementa exposición si ya está por debajo del cap
export const CORRELATION_PANIC_CONFIG = {
  PANIC_THRESHOLD: 0.85,     // correlación media > 85% → señal de pánico
  MAX_EXPOSURE: 0.50,         // cap forzado al 50%
  CRITICAL_THRESHOLD: 0.95,  // correlación > 95% → peligro extremo
  CRITICAL_EXPOSURE: 0.35,   // cap forzado al 35% en peligro extremo
  // FIX-POSTMORTEM: diversification collapse at lower threshold (0.60).
  // When BTC-WLG rolling correlation crosses 0.60, the portfolio's
  // diversification benefit has already eroded by >50%. This is an
  // early-warning gate that reduces exposure BEFORE panic levels.
  DIVERSIFICATION_COLLAPSE: 0.60,      // correlación BTC-WLG > 60% → early convergence
  DIVERSIFICATION_PENALTY: 0.05,       // -5pp sobre exposure base por debajo de 0.60
} as const;

// ── ABSOLUTE TREND GATES (Post-Mortem Oct 2026) ──────────────────────────
// Estos gates cierran la brecha entre el motor cross-sectional (BL+HRP) y
// el riesgo de mercado real. El motor rankea activos relativamente — el
// "mejor" activo en un bear market sigue teniendo retorno esperado negativo.
//
// Tres señales de mercado absoluto que el motor ignoraba:
//   1. Todos los activos negativos 3m → la diversificación no protege
//   2. BTC en bear market (returns12m < -30%) → proxy de BTC < MA200
//   3. DXY acelerándose (+5%) → dólar fuerte = risk-off global
//
// Lógica:
//   - All-bearish 3m → cap exposición al 50% (cross-sectional useless)
//   - BTC bear market → cap adicional al 35% (BTC arrastra al portfolio)
//   - DXY risk-off → -10pp adicional (tightening financiero global)
//   - Floor absoluto: 25% (nunca ir a 0 por estos gates, Tail Risk decide)
export const ABSOLUTE_TREND_GATE = {
  ALL_BEARISH_CAP: 0.50,        // todos los activos returns3m < 0 → max 50%
  BTC_BEAR_CAP: 0.35,           // BTC returns12m < -30% → max 35%
  BTC_BEAR_THRESHOLD: -0.30,    // umbral de bear market BTC (12 meses)
  DXY_RISK_OFF_THRESHOLD: 0.05, // DXY tendencia > 5% → risk-off
  DXY_PENALTY: 0.10,            // -10pp reduction per DXY gate
  CORR_EARLY_PENALTY: 0.0,      // FIX-CALIBRATION: desactivado (redundante con Correlation Panic + Tail Risk corr penalty)
  FLOOR: 0.25,                  // floor absoluto (Tail Risk + Kill Switch deciden más abajo)
} as const;

// ── KELLY CRITERION ───────────────────────────────────────────────────────
export const KELLY_CONFIG = {
  // Cap 30% — recalibrado: antes 20%. Mas concentracion en activos de alta conviccion.
  // Walk-forward optimizer (23-Jun-2026) recomendaba 20% por overfitting HIGH,
  // pero con DCC-GARCH + correlation panic gates activos, el riesgo de overfitting
  // esta mitigado. Permite posiciones hasta 30% en EXPANSION.
  CAP: 0.30,
  HALF_FRACTION: 0.70,  // recalibrado: antes 0.50. Sigue siendo conservador (< Kelly completo)
  // FIX-AUDIT-C11: James-Stein prior centralizado (antes hardcodeado 0.08 en kelly.ts).
  // 8% anual = retorno esperado neutro del "activo promedio".
  PRIOR_RETURN: 0.08,
} as const;

// ── VOLATILITY TARGETING ───────────────────────────────────────────────────
export const VOLATILITY_CONFIG = {
  // FIX-OVERPERF-2: recalibrado 0.22 → 0.25 → 0.20.
  // Walk-forward optimizer (36 combos, 23-Jun-2026): V20 da Sharpe 0.817 > V25 (0.805).
  // Con BTC en cartera (~20% peso) la volatilidad natural del portfolio
  // es ~20%. Con target 20%, en EXPANSION (penalty=1.0) el target efectivo = 20%,
  // permitiendo al engine operar al ~100% con volatilidad controlada.
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

  // FIX-AUDIT-C6: Systemic crisis thresholds for tail risk overlay.
  // Antes hardcodeados en tailRisk.ts (VIX>40, creditSpread>5, etc.).
  SYSTEMIC_CRISIS: {
    DISFUNCTIONAL:   { vix: 40, creditSpread: 5.0, overlay: 0.35 },
    SYSTEMIC_STRESS: { vix: 35, creditSpread: 3.5, overlay: 0.45 },
    ELEVATED:        { vix: 30, stressScore: 7,  overlay: 0.60 },
  },
} as const;

// ── MASTER REGIME ──────────────────────────────────────────────────────────
export const REGIME_CONFIG = {
  CRISIS_SCORE_THRESHOLD: 25,
  // FIX MATH-02: subido 10→12 tras reducir credit multiplier 3→2 en crisis.ts.
  // Con VIX=20 y credit=2.71% el score = 10.18 < 12 → EXPANSION (correcto).
  // Con VIX=28 y credit=4.5% el score = 14.8 > 12 → CONTRACTION (correcto).
  CONTRACTION_THRESHOLD: 15,  // FIX-CALIBRATION: subido 12→15. Con VIX=22 y credit=2.5% score=13<15→EXPANSION (correcto, no es contracción real)
  PENALTY_MIN: 0.4,
  PENALTY_MAX: 1.0,
  BINARY_WEIGHT: 0.4,
  CONTINUOUS_WEIGHT: 0.6,
} as const;

// ── TAIL RISK OVERLAY — FIX-KILLSWITCH-AGGRESSIVE ─────────────────────────
// RECALIBRADO (27-May-2026): Kill Switch más agresivo.
// Auditoría externa señaló que en backtesting el MaxDD era -39% con el
// kill switch activo — esto indica que las reducciones no eran suficientes
// para evitar drawdowns severos.
//
// ANTES (FIX-SCALE-01):
//   L1: -8%  → 0.85 (15% reducción)
//   L2: -15% → 0.65 (35% reducción)
//   L3: -20% → 0.50 (50% reducción)
//   L4: -25% → 0.35 (65% reducción)
//   L5: -32% → 0.30 (70% reducción)
//
// AHORA (FIX-KILLSWITCH-AGGRESSIVE):
//   L1: -12% → 0.80 (20% reducción) — preventivo, subido de -8% (22-Jun-2026)
//   L2: -15% → 0.50 (50% reducción) — mucho más agresivo (era 35%)
//   L3: -20% → 0.30 (70% reducción) — defensivo real (era 50%)
//   L4: -25% → 0.15 (85% reducción) — casi cash (era 65%)
//   L5: -32% → 0.05 (95% reducción) — cash virtual (era 70%)
//
// FIX-L1-BTC (22-Jun-2026): L1 subido de -8% → -12%.
//   BTC (~20% del portfolio, vol 72%) genera DD de 8-10% frecuentemente
//   por volatilidad normal de crypto, bloqueando compras en todo el portfolio.
//   Con -12%, BTC puede corregir hasta ~60% sin disparar el Kill Switch L1
//   (20% × 60% = 12%), permitiendo al resto de activos seguir operando.
//   L2-L5 sin cambios: caídas más profundas sí activan protección completa.
//
// JUSTIFICACIÓN:
//   Con el antiguo kill switch, en un drawdown del -25% el motor aún
//   mantenía 35% de exposición → seguía perdiendo dinero en caídas
//   adicionales. Con la nueva calibración, en -25% solo queda 15% de
//   exposición, limitando el daño residual. En -32% la cartera está
//   prácticamente en cash (5%), preservando capital para el rebote.
//
// REFERENCIA: La auditoría externa proponía overlay=0.40 a -15%,
//   0.20 a -25%, 0.05 a -35%. Nuestra calibración es más conservadora
//   en L2 (0.50 vs 0.40) pero más protectora en L4-L5.
export const TAIL_RISK_CONFIG = {
  // FIX A2: banda intermedia L1.5 entre -12% y -15% para suavizar el cliff.
  // ANTES: L1 (-12% → 0.80) y L2 (-15% → 0.50) tenían gap de solo 3%.
  // Un mercado cayendo de -12% a -15% en días forzaba ventas masivas.
  // AHORA: L1.5 (-13.5% → 0.65) como transición gradual.
  KILL_SWITCH: {
    L1:   { threshold: 0.12,  name: "REDUCCIÓN PREVENTIVA",  overlay: 0.80, reduction: 0.20 },
    L1_5: { threshold: 0.135, name: "TRANSICIÓN GRADUAL",    overlay: 0.65, reduction: 0.35 },
    L2:   { threshold: 0.15,  name: "REDUCCIÓN MODERADA",    overlay: 0.50, reduction: 0.50 },
    L3:   { threshold: 0.20,  name: "MODO DEFENSIVO",        overlay: 0.30, reduction: 0.70 },
    L4:   { threshold: 0.25,  name: "SALIDA CASI TOTAL",     overlay: 0.15, reduction: 0.85 },
    L5:   { threshold: 0.32,  name: "PROTECCIÓN MÁXIMA",     overlay: 0.05, reduction: 0.95 },
  },
  MIN_ALLOCATION: 0.05,
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

// ── CORE SIGNAL WEIGHTS (FIX-AUDIT-C8) ────────────────────────────────────
// Pesos del core signal score que combina régimen, BTC cycle, y risk.
// Antes hardcodeados en olympusV3.ts (0.55, 0.20, 0.25).
export const CORE_SIGNAL_WEIGHTS = {
  REGIME: 0.55,
  BTC: 0.20,
  RISK: 0.25,
} as const;

// ── ALPHA BOOST (FIX-AUDIT-C9) ────────────────────────────────────────────
// Exposición forzada cuando el core signal es favorable.
// Antes hardcodeado a 0.95 incondicional en olympusV3.ts.
export const ALPHA_BOOST_CONFIG = {
  EXPOSURE: 0.95,         // exposición cuando alpha boost se activa
  SIGNAL_THRESHOLD: 0.60, // coreSignalScore mínimo para activar el boost
} as const;

// ── DYNAMIC BTC CAPS (FIX-AUDIT-C7) ───────────────────────────────────────
// Caps dinámicos para BTC según el régimen de mercado.
// Antes hardcodeados en olympusV3.ts (0.20, 0.35, 0.10).
// EXPANSION: cap más alto (35%) — permite correr rallies en tendencia alcista.
// CONTRACTION: cap por defecto (20%) — protección estándar.
// CRISIS: cap mínimo (10%) — protección máxima en stress.
export const BTC_CAPS_BY_REGIME: Record<string, number> = {
  EXPANSION:    0.35,
  CONTRACTION:  0.20,
  CRISIS:       0.10,
} as const;

// ── BOND YIELD REFERENCE (FIX-AUDIT-C4, C10) ───────────────────────────────
// Yield del bono a 10 años de referencia en NOTACIÓN PORCENTAJE (no decimal).
// Ej: 4.25 = 4.25%. El ciclo top detector lo espera en esta unidad para
// calcular realRate = bondYield10y - inflationBreakeven (ambos en %).
// Antes hardcodeado como 4.25 en olympusV3.ts.
// NOTA: esto difiere de RISK_FREE_RATE_ANNUAL que usa decimal (0.04).
// Ambos son correctos en sus respectivos contextos de consumo.
export const BOND_YIELD_10Y = 4.25; // 4.25% en notación porcentaje

// ── FACTOR CALIBRATION (primas AQR) ───────────────────────────────────────
export const FACTOR_CONFIG = {
  // FIX-WALKFORWARD (27-May-2026): Actualizados según walk-forward test óptimo
  // nWindows=5, trainRatio=0.65 → Risk LOW, Consistencia 87.6%
  // Pesos adaptativos recomendados:
  //   momentum: 0.40 (baja de 0.45 — menos dependencia de tendencias pasadas)
  //   value:    0.25 (baja de 0.30 — value premium más errática post-COVID)
  //   quality:  0.20 (sube de 0.15 — quality es el factor más robusto OOS)
  //   lowVol:   0.15 (sube de 0.10 — lowVol protege en regímenes de alta vol)
  // Ver: walkforward_optimal_v5plus.csv
  // FIX-CAGR-BOOST (28-May-2026): Pesos recalibrados para mejorar CAGR
  // momentum subido 0.40→0.45 — captura mejor las tendencias alcistas
  // quality bajado 0.20→0.15 — reduce sesgo defensivo que lastra el CAGR
  // value y lowVol sin cambios
  DEFAULT_WEIGHTS: {
    momentum: 0.45,   // subido de 0.40 — más tendencia, captura rallies
    value:    0.25,   // igual
    quality:  0.15,   // bajado de 0.20 — menos sesgo defensivo
    lowVol:   0.15,   // igual
  },

  FACTOR_PREMIUMS: {
    momentum: 0.04,
    value:    0.03,
    quality:  0.025, // FIX: subido de 0.02 — prima quality documentada mayor tras 2020
    lowVol:   0.015,
  },

  // FIX-AUDIT-B5: alineados con marketData.ts y factorCalibration.ts [-0.05, 0.30]
  EXPECTED_RETURN_MIN: -0.05,
  EXPECTED_RETURN_MAX: 0.30,
} as const;

// ── FACTOR WEIGHTS DINÁMICOS POR RÉGIMEN ──────────────────────────────────
// FIX-BIMODAL (30-May-2026): Factor weights cambian según el régimen macro.
// EXPANSION: máximo momentum (perseguir tendencia alcista), mínimo quality.
// CONTRACTION: quality como ancla, momentum reducido (no perseguir falsos rebotes).
// CRISIS: quality + lowVol dominan (preservación de capital), momentum mínimo.
export function getFactorWeightsByRegime(regime: string): {
  momentum: number;
  value: number;
  quality: number;
  lowVol: number;
} {
  const r = (regime || '').toUpperCase();
  if (r === 'EXPANSION') {
    return { momentum: 0.55, value: 0.20, quality: 0.10, lowVol: 0.15 };
  }
  if (r === 'CONTRACTION') {
    return { momentum: 0.30, value: 0.25, quality: 0.30, lowVol: 0.15 };
  }
  if (r === 'CRISIS') {
    return { momentum: 0.15, value: 0.20, quality: 0.35, lowVol: 0.30 };
  }
  return { ...FACTOR_CONFIG.DEFAULT_WEIGHTS };
}

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

// ── NOTA: IS3Q y XNAS ELIMINADOS del portfolio (redundantes con WLG) ─────
// 0P00000WLG.F = Vanguard Global Stock Index Fund (ISIN: IE00B03HD191)
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
// Si se añade IS3R al portfolio, reducir proporcionalmente VVSM.DE o WLG
// para no superar el SECTOR_CAP de tecnología/equity del 35%.
// ─────────────────────────────────────────────────────────────────────────
