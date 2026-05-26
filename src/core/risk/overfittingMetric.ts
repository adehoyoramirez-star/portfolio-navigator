// ===============================================
// ARCHIVO: src/core/risk/overfittingMetric.ts
// OLYMPUS V5 — Métrica de Sobreajuste (Overfitting)
// ===============================================
//
// PROBLEMA:
//   El PDF de auditoría reportó "Overfitting 56%" pero no había
//   código que calculara esta métrica. Sin una definición formal,
//   el número es arbitrario e inverificable.
//
// SOLUCIÓN:
//   Implementamos 4 métricas de sobreajuste independientes:
//
//   1. SHARPE RATIO DEGRADATION (SRD):
//      Diferencia entre Sharpe in-sample y out-of-sample en
//      walk-forward. >50% de degradación = sobreajuste severo.
//
//   2. SIGNAL DENSITY RATIO (SDR):
//      Cuántas señales genera el sistema vs. activos totales.
//      Si >80% de activos tienen señales en todo momento,
//      el sistema está sobreajustado ("todo es señal").
//
//   3. REGIME SWITCHING FRENZY (RSF):
//      Cuántas veces cambia el régimen en N períodos.
//      Cambios frecuentes (>8 en 252 sesiones) indican
//      sobreajuste a ruido de mercado.
//
//   4. PARAMETER EFFICIENCY RATIO (PER):
//      Ratio de parámetros del modelo vs. puntos de datos
//      disponibles. Regla general: >10 datos por parámetro
//      para evitar sobreajuste.
//
//   El OVERFITTING SCORE global es un promedio ponderado
//   de las 4 métricas, cada una normalizada a [0, 1].
//
// USO:
//   integratedOverfittingMetric() devuelve el score completo
//   con desglose. Se integra en tacticalScreener.ts para
//   mostrar en el diagnóstico.
// ===============================================

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface OverfittingMetrics {
  /** Sharpe Ratio Degradation [0, 1] — qué parte del rendimiento IS se pierde en OOS */
  sharpeDegradation: number;
  /** Signal Density Ratio [0, 1] — fracción de activos con señales activas */
  signalDensity: number;
  /** Regime Switching Frenzy [0, 1] — frecuencia de cambios de régimen */
  regimeFrenzy: number;
  /** Parameter Efficiency Ratio [0, 1] — 1 = eficiente, 0 = sobreparametrizado */
  parameterEfficiency: number;
}

export interface OverfittingReport {
  /** Score global de sobreajuste [0, 1] — 0 = sin sobreajuste, 1 = máximo */
  globalScore: number;
  /** Score global en porcentaje para display */
  globalScorePct: number;
  /** Desglose por métrica */
  metrics: OverfittingMetrics;
  /** Componentes raw (antes de normalizar) para diagnóstico */
  raw: {
    sharpeIS: number;
    sharpeOOS: number;
    totalSignals: number;
    totalAssets: number;
    regimeChanges: number;
    totalPeriods: number;
    paramCount: number;
    dataPoints: number;
  };
  /** Advertencia textual */
  warning: string;
  /** Nivel de alerta */
  level: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
}

// ── Constantes de ponderación ─────────────────────────────────────────────────
// Cada métrica contribuye al score global con estos pesos.
// SRD tiene más peso porque es la métrica más directamente ligada
// al rendimiento real (el inversor pierde dinero cuando SRD es alto).
const WEIGHTS = {
  sharpeDegradation:  0.40,
  signalDensity:      0.20,
  regimeFrenzy:       0.20,
  parameterEfficiency: 0.20,
};

// ── Umbrales de diagnosis ─────────────────────────────────────────────────────

const THRESHOLDS = {
  /** SRD > 50% = sobreajuste severo */
  SHARPE_DEGRADATION_HIGH: 0.50,
  /** >60% de activos con señal = demasiadas señales */
  SIGNAL_DENSITY_HIGH: 0.60,
  /** >8 cambios de régimen en 252 días = frenesí */
  REGIME_CHANGES_HIGH: 8,
  /** <10 datos por parámetro = sobreparametrizado */
  MIN_DATA_PER_PARAM: 10,
};

// ── Función principal ─────────────────────────────────────────────────────────

/**
 * Calcula el score de sobreajuste del sistema táctico.
 *
 * @param params - Parámetros medidos del sistema
 * @returns OverfittingReport completo
 */
export function computeOverfitting(params: {
  /** Sharpe ratio in-sample (walk-forward train) */
  sharpeIS?: number;
  /** Sharpe ratio out-of-sample (walk-forward test) */
  sharpeOOS?: number;
  /** Número total de señales activas generadas */
  totalSignals?: number;
  /** Número total de activos en el universo */
  totalAssets?: number;
  /** Número de cambios de régimen en el período */
  regimeChanges?: number;
  /** Número total de períodos (días de trading) */
  totalPeriods?: number;
  /** Número de parámetros del modelo (indicadores + umbrales + reglas) */
  paramCount?: number;
  /** Número de puntos de datos disponibles */
  dataPoints?: number;
}): OverfittingReport {
  const {
    sharpeIS,
    sharpeOOS,
    totalSignals = 0,
    totalAssets = 1,
    regimeChanges,
    totalPeriods = 252,
    paramCount = 1,
    dataPoints = 1,
  } = params;

  // ── 1. SHARPE RATIO DEGRADATION (SRD) ───────────────────────────────────
  // Mide qué parte del Sharpe IS se pierde en OOS.
  // SRD = max(0, (sharpeIS - sharpeOOS) / max(sharpeIS, 0.01))
  // Normalizado: clamp a [0, 1]
  let rawSharpeDegradation = 0;
  if (sharpeIS !== undefined && sharpeOOS !== undefined && sharpeIS > 0) {
    rawSharpeDegradation = Math.max(0, (sharpeIS - sharpeOOS) / Math.max(sharpeIS, 0.01));
  } else {
    // Sin datos de walk-forward, estimar desde signal density
    rawSharpeDegradation = 0.30; // Default conservador
  }
  const sharpeDegradation = Math.min(1, rawSharpeDegradation);

  // ── 2. SIGNAL DENSITY RATIO (SDR) ───────────────────────────────────────
  // Fracción de activos que tienen señales activas.
  // Si casi todos los activos tienen señal, el sistema "ve" patrones en todo
  // → probable sobreajuste.
  const signalDensity = Math.min(1, totalSignals / Math.max(totalAssets, 1));

  // ── 3. REGIME SWITCHING FRENZY (RSF) ────────────────────────────────────
  // Cambios de régimen por período anualizado.
  // >8 cambios en 252 días = el sistema reacciona a ruido.
  let rawRegimeFrenzy = 0;
  if (regimeChanges !== undefined && totalPeriods > 0) {
    const changesPerYear = (regimeChanges / totalPeriods) * 252;
    rawRegimeFrenzy = Math.min(1, changesPerYear / THRESHOLDS.REGIME_CHANGES_HIGH);
  }
  const regimeFrenzy = rawRegimeFrenzy;

  // ── 4. PARAMETER EFFICIENCY RATIO (PER) ─────────────────────────────────
  // Ratio de datos por parámetro.
  // Regla: necesitas al menos 10 observaciones por parámetro.
  // PER = min(1, dataPoints / (paramCount * THRESHOLDS.MIN_DATA_PER_PARAM))
  const dataPerParam = dataPoints / Math.max(paramCount, 1);
  const parameterEfficiency = Math.min(1, dataPerParam / THRESHOLDS.MIN_DATA_PER_PARAM);
  // Invertir: 1 = eficiente (muchos datos, pocos parámetros)
  // 0 = sobreparametrizado (pocos datos, muchos parámetros)
  const parameterOverfit = 1 - parameterEfficiency;

  // ── SCORE GLOBAL ─────────────────────────────────────────────────────────
  const globalScore =
    WEIGHTS.sharpeDegradation * sharpeDegradation +
    WEIGHTS.signalDensity * signalDensity +
    WEIGHTS.regimeFrenzy * regimeFrenzy +
    WEIGHTS.parameterEfficiency * parameterOverfit;

  // ── NIVEL DE ALERTA ──────────────────────────────────────────────────────
  let level: OverfittingReport['level'];
  let warning: string;

  if (globalScore >= 0.70) {
    level = 'CRITICAL';
    warning = `🔴 Sobreajuste crítico (${(globalScore * 100).toFixed(0)}%). El sistema está memorizando ruido. Revisar parámetros y reducir complejidad del modelo.`;
  } else if (globalScore >= 0.50) {
    level = 'HIGH';
    warning = `⚠️ Sobreajuste alto (${(globalScore * 100).toFixed(0)}%). Señales pueden no generalizar a out-of-sample. Considerar simplificar reglas.`;
  } else if (globalScore >= 0.30) {
    level = 'MODERATE';
    warning = `⚡ Sobreajuste moderado (${(globalScore * 100).toFixed(0)}%). Monitorear degradación de Sharpe OOS.`;
  } else {
    level = 'LOW';
    warning = `✅ Sobreajuste bajo (${(globalScore * 100).toFixed(0)}%). El sistema generaliza correctamente.`;
  }

  return {
    globalScore,
    globalScorePct: Math.round(globalScore * 100),
    metrics: {
      sharpeDegradation,
      signalDensity,
      regimeFrenzy,
      parameterEfficiency,
    },
    raw: {
      sharpeIS: sharpeIS ?? 0,
      sharpeOOS: sharpeOOS ?? 0,
      totalSignals,
      totalAssets,
      regimeChanges: regimeChanges ?? 0,
      totalPeriods,
      paramCount,
      dataPoints,
    },
    warning,
    level,
  };
}

// ── Integración con el sistema actual ─────────────────────────────────────────

/**
 * Calcula el parámetro count estimado del sistema táctico.
 * Suma todos los umbrales, pesos de indicadores, y reglas
 * que el tactical screener usa para generar señales.
 *
 * Valores actuales:
 *   - Thresholds en tacticalSignals (RSI, MACD, SMA, etc.): ~22
 *   - Pesos de indicadores en factorEngine: ~12
 *   - Reglas de filtro de régimen: ~8
 *   - Umbrales de score/recompensa: ~6
 *   - Parámetros de universos: ~12
 * Total estimado: ~60
 */
export function estimateTacticalParamCount(): number {
  return 60;
}

/**
 * Estima los puntos de datos disponibles basado en
 * el histórico típico de Yahoo Finance (~5 años = 1260 días)
 * y el número de activos en el universo.
 */
export function estimateTacticalDataPoints(totalAssets?: number): number {
  const assets = totalAssets ?? 57; // CORE_TACTICAL_UNIVERSE length
  const histLen = 1260; // ~5 años de datos diarios
  return assets * histLen;
}

/**
 * Versión integrada que usa defaults sensibles para el sistema actual.
 * Útil cuando no se tienen datos de walk-forward completos.
 */
export function integratedOverfittingMetric(params: {
  totalSignals?: number;
  totalAssets?: number;
  regimeChanges?: number;
  sharpeIS?: number;
  sharpeOOS?: number;
}): OverfittingReport {
  const totalAssets = params.totalAssets ?? 57;
  const dataPoints = estimateTacticalDataPoints(totalAssets);
  const paramCount = estimateTacticalParamCount();

  return computeOverfitting({
    sharpeIS: params.sharpeIS,
    sharpeOOS: params.sharpeOOS,
    totalSignals: params.totalSignals,
    totalAssets,
    regimeChanges: params.regimeChanges,
    totalPeriods: 252,
    paramCount,
    dataPoints,
  });
}
