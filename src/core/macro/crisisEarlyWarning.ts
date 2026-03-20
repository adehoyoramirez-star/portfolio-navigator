// ===============================================
// ARCHIVO: src/core/macro/crisisEarlyWarning.ts
// Crisis Early Warning System (CEWS)
//
// A diferencia del masterRegime que trabaja con un snapshot,
// el CEWS analiza la TENDENCIA de 4 señales macro durante
// las últimas 8-12 semanas para detectar deterioro sistémico
// 3-6 meses ANTES de que llegue el crash.
//
// Señales:
//   1. Yield Curve (2y-10y spread)  → inversión = recesión en camino
//   2. Credit Spreads               → subida sostenida = estrés financiero
//   3. Liquidity Impulse (M2)       → caída = menos dinero en el sistema
//   4. Volatility Clustering (VIX)  → picos cada vez más frecuentes = régimen de miedo
// ===============================================

export type CEWSLevel = "CLEAR" | "WATCH" | "WARNING" | "ALERT";

export interface CEWSDataPoint {
  timestamp: string;   // ISO date
  vix: number;
  yieldSpread: number; // 10y - 2y (positivo = normal, negativo = invertida)
  creditSpread: number;
  m2Growth: number;    // crecimiento M2 YoY en %
}

export interface CEWSSignal {
  name: string;
  level: CEWSLevel;
  score: number;        // 0-3: cuántas semanas en rojo de las últimas 8
  trend: "IMPROVING" | "STABLE" | "DETERIORATING";
  value: number;        // valor actual
  threshold: number;    // umbral de alarma
  description: string;
}

export interface CEWSOutput {
  level: CEWSLevel;                 // nivel global de alerta
  score: number;                    // 0-12: suma de scores individuales
  signalsInRed: number;             // cuántas de las 4 señales están deterioradas
  weeksInWarning: number;           // semanas consecutivas con ≥2 señales en rojo
  signals: {
    yieldCurve:       CEWSSignal;
    creditSpreads:    CEWSSignal;
    liquidityImpulse: CEWSSignal;
    volClustering:    CEWSSignal;
  };
  earlyWarningActive: boolean;      // true = reducir exposición AHORA, el crash viene
  earlyWarningReason: string;
  regimePenaltyAdjustment: number; // multiplicador adicional sobre regimePenalty [-0.2, 0]
  recommendation: string;
}

// ── UMBRALES ──────────────────────────────────────────────────────────────
const THRESHOLDS = {
  yieldSpread: {
    warning: 0.0,    // curva plana
    danger:  -0.5,   // curva invertida -50bps (señal de recesión clásica)
  },
  creditSpread: {
    warning: 2.0,    // spreads elevados
    danger:  3.5,    // estrés sistémico (Lehman: 6%, COVID: 4.5%)
  },
  m2Growth: {
    warning: 2.0,    // crecimiento M2 muy bajo
    danger:  0.0,    // contracción de M2 (históricamente rarísimo, muy peligroso)
  },
  vixCluster: {
    warning: 25,     // volatilidad elevada
    danger:  35,     // pánico. Por encima de 35 el mercado está disfuncional.
  },
};

// ── ANÁLISIS DE SEÑAL INDIVIDUAL ─────────────────────────────────────────
function analyzeYieldCurve(history: CEWSDataPoint[]): CEWSSignal {
  const recent = history.slice(-8);
  const current = recent[recent.length - 1]?.yieldSpread ?? 0;
  const weeksInRed = recent.filter(d => d.yieldSpread < THRESHOLDS.yieldSpread.warning).length;
  const weeksInDanger = recent.filter(d => d.yieldSpread < THRESHOLDS.yieldSpread.danger).length;

  const trend = computeTrend(recent.map(d => d.yieldSpread));
  const score = weeksInDanger * 2 + Math.max(0, weeksInRed - weeksInDanger);
  const level = weeksInDanger >= 4 ? "ALERT" : weeksInRed >= 5 ? "WARNING" : weeksInRed >= 2 ? "WATCH" : "CLEAR";

  return {
    name: "Yield Curve (10y-2y)",
    level,
    score: Math.min(score, 3),
    trend,
    value: current,
    threshold: THRESHOLDS.yieldSpread.warning,
    description: current < THRESHOLDS.yieldSpread.danger
      ? `Curva invertida ${current.toFixed(2)}% — señal de recesión histórica`
      : current < THRESHOLDS.yieldSpread.warning
      ? `Curva plana/invertida ${current.toFixed(2)}% — deterioro en curso`
      : `Curva normal ${current.toFixed(2)}% — sin señal`,
  };
}

function analyzeCreditSpreads(history: CEWSDataPoint[]): CEWSSignal {
  const recent = history.slice(-8);
  const current = recent[recent.length - 1]?.creditSpread ?? 0;
  const weeksInWarning = recent.filter(d => d.creditSpread > THRESHOLDS.creditSpread.warning).length;
  const weeksInDanger  = recent.filter(d => d.creditSpread > THRESHOLDS.creditSpread.danger).length;

  const trend = computeTrend(recent.map(d => d.creditSpread), true); // invertido: subida = malo
  const score = weeksInDanger * 2 + Math.max(0, weeksInWarning - weeksInDanger);
  const level = weeksInDanger >= 3 ? "ALERT" : weeksInWarning >= 5 ? "WARNING" : weeksInWarning >= 2 ? "WATCH" : "CLEAR";

  return {
    name: "Credit Spreads (HY-IG)",
    level,
    score: Math.min(score, 3),
    trend,
    value: current,
    threshold: THRESHOLDS.creditSpread.warning,
    description: current > THRESHOLDS.creditSpread.danger
      ? `Spreads ${current.toFixed(2)}% — estrés sistémico (umbral crisis: 3.5%)`
      : current > THRESHOLDS.creditSpread.warning
      ? `Spreads elevados ${current.toFixed(2)}% — mercado de crédito bajo presión`
      : `Spreads normales ${current.toFixed(2)}% — sin señal`,
  };
}

function analyzeLiquidityImpulse(history: CEWSDataPoint[]): CEWSSignal {
  const recent = history.slice(-8);
  const current = recent[recent.length - 1]?.m2Growth ?? 0;
  const weeksLow      = recent.filter(d => d.m2Growth < THRESHOLDS.m2Growth.warning).length;
  const weeksNegative = recent.filter(d => d.m2Growth < THRESHOLDS.m2Growth.danger).length;

  const trend = computeTrend(recent.map(d => d.m2Growth));
  const score = weeksNegative * 2 + Math.max(0, weeksLow - weeksNegative);
  const level = weeksNegative >= 2 ? "ALERT" : weeksLow >= 5 ? "WARNING" : weeksLow >= 2 ? "WATCH" : "CLEAR";

  return {
    name: "Liquidity Impulse (M2 YoY)",
    level,
    score: Math.min(score, 3),
    trend,
    value: current,
    threshold: THRESHOLDS.m2Growth.warning,
    description: current < THRESHOLDS.m2Growth.danger
      ? `M2 contrayéndose ${current.toFixed(1)}% — drenaje de liquidez activo`
      : current < THRESHOLDS.m2Growth.warning
      ? `M2 crecimiento mínimo ${current.toFixed(1)}% — impulso de liquidez débil`
      : `M2 creciendo ${current.toFixed(1)}% — liquidez suficiente`,
  };
}

function analyzeVolClustering(history: CEWSDataPoint[]): CEWSSignal {
  const recent = history.slice(-8);
  const current = recent[recent.length - 1]?.vix ?? 0;
  const weeksElevated = recent.filter(d => d.vix > THRESHOLDS.vixCluster.warning).length;
  const weeksPanic    = recent.filter(d => d.vix > THRESHOLDS.vixCluster.danger).length;

  // Clustering: picos de VIX cada vez más frecuentes = régimen de miedo instalado
  const vixValues = recent.map(d => d.vix);
  const vixAcceleration = vixValues.length >= 4
    ? (vixValues.slice(-4).reduce((a, b) => a + b, 0) / 4) -
      (vixValues.slice(0, 4).reduce((a, b) => a + b, 0) / 4)
    : 0;

  const trend = computeTrend(vixValues, true);
  const clusteringBonus = vixAcceleration > 5 ? 1 : 0; // aceleración de VIX = señal extra
  const score = weeksPanic * 2 + Math.max(0, weeksElevated - weeksPanic) + clusteringBonus;
  const level = weeksPanic >= 3 ? "ALERT" : weeksElevated >= 5 ? "WARNING" : weeksElevated >= 2 ? "WATCH" : "CLEAR";

  return {
    name: "Volatility Clustering (VIX)",
    level,
    score: Math.min(score, 3),
    trend,
    value: current,
    threshold: THRESHOLDS.vixCluster.warning,
    description: weeksPanic >= 3
      ? `VIX ${current.toFixed(0)} — régimen de pánico instalado (${weeksPanic} semanas > 35)`
      : weeksElevated >= 4
      ? `VIX ${current.toFixed(0)} — volatilidad elevada persistente (${weeksElevated} semanas > 25)`
      : `VIX ${current.toFixed(0)} — volatilidad normalizada`,
  };
}

// ── EVALUACIÓN GLOBAL ─────────────────────────────────────────────────────
export function computeCEWS(history: CEWSDataPoint[]): CEWSOutput {
  if (history.length < 2) {
    return emptyCEWS();
  }

  const yieldCurve       = analyzeYieldCurve(history);
  const creditSpreads    = analyzeCreditSpreads(history);
  const liquidityImpulse = analyzeLiquidityImpulse(history);
  const volClustering    = analyzeVolClustering(history);

  const signals = { yieldCurve, creditSpreads, liquidityImpulse, volClustering };
  const allSignals = Object.values(signals);

  const totalScore = allSignals.reduce((sum, s) => sum + s.score, 0); // 0-12
  const signalsInRed = allSignals.filter(s => s.level === "WARNING" || s.level === "ALERT").length;
  const signalsInAlert = allSignals.filter(s => s.level === "ALERT").length;

  // Semanas consecutivas con ≥2 señales en rojo (requiere historial)
  const weeksInWarning = computeWeeksInWarning(history);

  // Nivel global
  let level: CEWSLevel;
  if (signalsInAlert >= 3 || (signalsInAlert >= 2 && weeksInWarning >= 6)) {
    level = "ALERT";
  } else if (signalsInRed >= 3 || (signalsInRed >= 2 && weeksInWarning >= 4)) {
    level = "WARNING";
  } else if (signalsInRed >= 2 || totalScore >= 4) {
    level = "WATCH";
  } else {
    level = "CLEAR";
  }

  // Early warning activo: ≥3 señales deterioradas durante ≥4 semanas
  const earlyWarningActive = signalsInRed >= 3 && weeksInWarning >= 4;

  // Penalización adicional sobre el regimePenalty del masterRegime
  // En ALERT: -0.20 adicional (sistema ya conservador + CEWS lo amplifica)
  // En WARNING: -0.10
  // En WATCH: -0.05
  // En CLEAR: 0
  const penaltyMap: Record<CEWSLevel, number> = {
    CLEAR:   0,
    WATCH:  -0.05,
    WARNING: -0.10,
    ALERT:  -0.20,
  };
  const regimePenaltyAdjustment = penaltyMap[level];

  const earlyWarningReason = buildWarningReason(signals, level, weeksInWarning);
  const recommendation = buildRecommendation(level, signalsInRed, weeksInWarning, earlyWarningActive);

  return {
    level,
    score: totalScore,
    signalsInRed,
    weeksInWarning,
    signals,
    earlyWarningActive,
    earlyWarningReason,
    regimePenaltyAdjustment,
    recommendation,
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────

// Calcula tendencia de una serie: ¿la media de las últimas 4 semanas
// es mejor o peor que la media de las 4 anteriores?
function computeTrend(values: number[], higherIsBad = false): "IMPROVING" | "STABLE" | "DETERIORATING" {
  if (values.length < 4) return "STABLE";
  const half = Math.floor(values.length / 2);
  const first = values.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const last  = values.slice(-half).reduce((a, b) => a + b, 0) / half;
  const delta = last - first;
  const threshold = Math.abs(first) * 0.05; // 5% de cambio relativo

  if (Math.abs(delta) < threshold) return "STABLE";
  const worsening = higherIsBad ? delta > 0 : delta < 0;
  return worsening ? "DETERIORATING" : "IMPROVING";
}

// Estima semanas consecutivas con ≥2 señales en rojo
// Requiere al menos 8 puntos de historia
function computeWeeksInWarning(history: CEWSDataPoint[]): number {
  if (history.length < 4) return 0;
  let count = 0;
  // Analiza cada punto histórico con ventana de 4 semanas
  for (let i = history.length - 1; i >= Math.max(0, history.length - 12); i--) {
    const point = history[i];
    let redSignals = 0;
    if (point.yieldSpread < THRESHOLDS.yieldSpread.warning)    redSignals++;
    if (point.creditSpread > THRESHOLDS.creditSpread.warning)  redSignals++;
    if (point.m2Growth < THRESHOLDS.m2Growth.warning)          redSignals++;
    if (point.vix > THRESHOLDS.vixCluster.warning)             redSignals++;
    if (redSignals >= 2) count++;
    else break; // si hay un punto sin señales, la racha se rompe
  }
  return count;
}

function buildWarningReason(
  signals: CEWSOutput["signals"],
  level: CEWSLevel,
  weeks: number
): string {
  if (level === "CLEAR") return "Todos los indicadores macroeconómicos en rango normal.";

  const red = Object.values(signals)
    .filter(s => s.level !== "CLEAR")
    .map(s => s.name);

  if (level === "ALERT") {
    return `⚠️ ALERTA TEMPRANA ACTIVA: ${red.join(", ")} deterioradas durante ${weeks} semanas. Históricamente este patrón precede crashes en 3-6 meses.`;
  }
  if (level === "WARNING") {
    return `${red.join(" + ")} mostrando deterioro sostenido (${weeks} semanas). Reducir exposición de forma gradual.`;
  }
  return `${red.join(" + ")} en zona de vigilancia. Monitorear evolución.`;
}

function buildRecommendation(
  level: CEWSLevel,
  signalsInRed: number,
  weeks: number,
  earlyWarning: boolean
): string {
  if (earlyWarning) {
    return "REDUCIR EXPOSICIÓN AHORA. El CEWS detecta deterioro sistémico sostenido. Aumentar liquidez para aprovechar el fondo cuando llegue. El DCA mensual debe pausarse.";
  }
  if (level === "ALERT") {
    return `${signalsInRed} señales en alerta durante ${weeks} semanas. Evitar nuevas posiciones. Revisar stops y coberturas.`;
  }
  if (level === "WARNING") {
    return "Señales de deterioro macro. Reducir tamaño de posición en activos de riesgo. Acumular liquidez.";
  }
  if (level === "WATCH") {
    return "Señales en vigilancia. Mantener plan actual pero no aumentar exposición hasta confirmar mejora.";
  }
  return "Sistema macro en condiciones normales. Seguir plan de inversión habitual.";
}

function emptyCEWS(): CEWSOutput {
  const emptySignal = (name: string): CEWSSignal => ({
    name, level: "CLEAR", score: 0, trend: "STABLE", value: 0, threshold: 0, description: "Sin datos suficientes",
  });
  return {
    level: "CLEAR", score: 0, signalsInRed: 0, weeksInWarning: 0,
    signals: {
      yieldCurve:       emptySignal("Yield Curve"),
      creditSpreads:    emptySignal("Credit Spreads"),
      liquidityImpulse: emptySignal("Liquidity Impulse"),
      volClustering:    emptySignal("Volatility Clustering"),
    },
    earlyWarningActive: false,
    earlyWarningReason: "Datos insuficientes para el análisis.",
    regimePenaltyAdjustment: 0,
    recommendation: "Añadir más puntos de datos para activar el CEWS.",
  };
}

// ── GESTIÓN DEL HISTORIAL (localStorage) ──────────────────────────────────
const CEWS_STORAGE_KEY = "olympus_cews_history_v1";

export function loadCEWSHistory(): CEWSDataPoint[] {
  try {
    const raw = localStorage.getItem(CEWS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveCEWSDataPoint(point: Omit<CEWSDataPoint, "timestamp">): CEWSDataPoint[] {
  const history = loadCEWSHistory();
  const newPoint: CEWSDataPoint = {
    ...point,
    timestamp: new Date().toISOString(),
  };

  // Evitar duplicados del mismo día
  const today = new Date().toDateString();
  const filtered = history.filter(p => new Date(p.timestamp).toDateString() !== today);

  // Mantener máximo 24 semanas de historial (168 días aprox)
  const updated = [...filtered, newPoint].slice(-168);
  try {
    localStorage.setItem(CEWS_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // localStorage lleno — no bloquear
  }
  return updated;
}

export function clearCEWSHistory(): void {
  try { localStorage.removeItem(CEWS_STORAGE_KEY); } catch { /* noop */ }
}

// ── DATOS SINTÉTICOS PARA DEMOSTRACIÓN ───────────────────────────────────
// Si no hay historial, genera 12 semanas de datos basados en los valores actuales
// con variación realista para que el CEWS tenga algo que analizar.
export function generateSyntheticHistory(
  currentVix: number,
  currentYieldSpread: number,
  currentCreditSpread: number,
  currentM2Growth: number,
  weeks = 12
): CEWSDataPoint[] {
  const history: CEWSDataPoint[] = [];
  const now = Date.now();

  for (let i = weeks; i >= 0; i--) {
    const t = (weeks - i) / weeks; // 0 = hace 12 semanas, 1 = ahora
    // Tendencia: los valores empeoran gradualmente hacia el presente
    // (simula un entorno que se ha ido deteriorando)
    const noise = (Math.random() - 0.5) * 0.3;
    history.push({
      timestamp: new Date(now - i * 7 * 24 * 3600 * 1000).toISOString(),
      vix:          currentVix * (0.7 + 0.3 * t) + noise * 3,
      yieldSpread:  currentYieldSpread * (1.2 - 0.2 * t) + noise * 0.1,
      creditSpread: currentCreditSpread * (0.8 + 0.2 * t) + noise * 0.1,
      m2Growth:     currentM2Growth * (1.1 - 0.1 * t) + noise * 0.3,
    });
  }
  return history;
}