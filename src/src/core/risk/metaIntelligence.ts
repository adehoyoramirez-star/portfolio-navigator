// ===============================================
// ARCHIVO: src/core/risk/metaIntelligence.ts
// OLYMPUS V5 — Meta-Inteligencia Runtime
// ===============================================
// El sistema aprende de sus propios errores en tiempo real.
//
// PROBLEMA que resuelve:
//   El walk-forward optimizer valida offline (datos históricos).
//   Pero el motor puede fallar AHORA en vivo sin que nadie lo detecte.
//   Un motor con CRISIS que recomienda no comprar durante un bull market
//   sostenido está destruyendo valor, y el sistema no tenía forma de
//   detectarlo ni compensarlo automáticamente.
//
// SOLUCIÓN:
//   Tracking de las últimas N predicciones del régimen vs resultado real.
//   Si el modelo falla consistentemente (ej: predice CRISIS pero el mercado
//   sube >5%), reduce gradualmente la penalización del régimen para
//   compensar el sesgo excesivamente conservador.
//
// DEFINICIÓN DE "ACIERTO" del modelo de régimen:
//   EXPANSION predicho + retorno > 0%  → acierto
//   CRISIS predicho + retorno < 0%     → acierto (protegió)
//   CRISIS predicho + retorno > 5%     → fallo (pérdida de oportunidad)
//   EXPANSION predicho + retorno < -5% → fallo (no protegió)
//
// OUTPUTS:
//   confidenceMultiplier: [0.70, 1.0]
//     → Si el modelo está fallando, reduce penalización de régimen
//       para que el sistema no sea demasiado conservador cuando el
//       mercado contradice la señal macro.
//   modelHealth: 'RELIABLE' | 'DEGRADED' | 'UNRELIABLE'
//   consecutiveErrors: número de fallos consecutivos recientes
//
// ALMACENAMIENTO:
//   localStorage key: 'olympus_meta_intelligence_v1'
//   Persistencia: 90 días de historial máximo
//   Supabase: pendiente (misma tabla que CEWS history)
//
// FILOSOFÍA:
//   "Un modelo que sabe que puede equivocarse es más robusto
//    que uno que siempre confía en sí mismo."
// ===============================================

export type RegimePrediction = 'EXPANSION' | 'CONTRACTION' | 'CRISIS';
export type ModelHealth = 'RELIABLE' | 'DEGRADED' | 'UNRELIABLE';

export interface PredictionRecord {
  timestamp: string;           // ISO date
  predictedRegime: RegimePrediction;
  actualReturn1m: number;      // retorno real del portfolio en el siguiente mes (decimal)
  wasCorrect: boolean;         // acierto según la lógica de evaluación
  penaltyApplied: number;      // penalización de régimen aplicada [0.4, 1.0]
}

export interface MetaIntelligenceOutput {
  confidenceMultiplier: number;  // [0.70, 1.0] — multiplicador sobre la penalización de régimen
  modelHealth: ModelHealth;
  consecutiveErrors: number;     // fallos consecutivos recientes
  recentAccuracy: number;        // % de aciertos en las últimas N predicciones [0, 1]
  totalPredictions: number;
  recommendation: string;        // para mostrar en dashboard
  shouldReduceComplexity: boolean; // true si el modelo está muy degradado
}

// ── STORAGE ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'olympus_meta_intelligence_v1';
const MAX_HISTORY = 90;  // días máximo de historial

export function loadPredictionHistory(): PredictionRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const records: PredictionRecord[] = JSON.parse(raw);
    // Mantener solo los últimos MAX_HISTORY días
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_HISTORY);
    return records.filter(r => new Date(r.timestamp) > cutoff);
  } catch {
    return [];
  }
}

export function savePredictionRecord(record: Omit<PredictionRecord, 'timestamp'>): PredictionRecord[] {
  const history = loadPredictionHistory();
  const newRecord: PredictionRecord = {
    ...record,
    timestamp: new Date().toISOString(),
  };
  const updated = [...history, newRecord].slice(-MAX_HISTORY);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch { /* noop */ }
  return updated;
}

export function clearPredictionHistory(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
}

// ── EVALUACIÓN DE ACIERTO ─────────────────────────────────────────────────
// Lógica:
//   EXPANSION + retorno > 0%  → acierto (el motor acertó que el mercado subiría)
//   CRISIS    + retorno < 0%  → acierto (el motor protegió correctamente)
//   CRISIS    + retorno > 5%  → fallo (exceso de conservadurismo costoso)
//   EXPANSION + retorno < -5% → fallo (el motor no anticipó la caída)
//   CONTRACTION: zona gris, penalización parcial

export function evaluatePrediction(
  predicted: RegimePrediction,
  actualReturn: number
): boolean {
  switch (predicted) {
    case 'EXPANSION':
      // Motor dijo "sube" — fallo si cae más del 5%
      return actualReturn > -0.05;

    case 'CRISIS':
      // Motor dijo "protégete" — fallo si el mercado subió más del 5%
      // (perdiste oportunidad de forma sistemática)
      return actualReturn < 0.05;

    case 'CONTRACTION':
      // Zona gris — el motor es correcto si no hay ni rally fuerte ni crash fuerte
      return actualReturn > -0.08 && actualReturn < 0.10;

    default:
      return true;
  }
}

// ── CÁLCULO DE META-INTELIGENCIA ──────────────────────────────────────────
export function computeMetaIntelligence(
  history?: PredictionRecord[]
): MetaIntelligenceOutput {
  const records = history ?? loadPredictionHistory();

  // Sin historial suficiente — confiar plenamente en el modelo
  if (records.length < 3) {
    return {
      confidenceMultiplier: 1.0,
      modelHealth: 'RELIABLE',
      consecutiveErrors: 0,
      recentAccuracy: 1.0,
      totalPredictions: records.length,
      recommendation: records.length === 0
        ? 'Sin historial de predicciones. El motor opera con confianza plena.'
        : `${records.length} predicciones registradas. Necesita al menos 3 para activar la meta-inteligencia.`,
      shouldReduceComplexity: false,
    };
  }

  // Analizar las últimas 6 predicciones (ventana reciente)
  const recent = records.slice(-6);
  const recentErrors = recent.filter(r => !r.wasCorrect).length;
  const recentAccuracy = (recent.length - recentErrors) / recent.length;

  // Fallos consecutivos (desde el más reciente hacia atrás)
  let consecutiveErrors = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (!records[i].wasCorrect) consecutiveErrors++;
    else break;
  }

  // ── DETERMINAR SALUD DEL MODELO ────────────────────────────────────────
  let modelHealth: ModelHealth;
  let confidenceMultiplier: number;

  if (consecutiveErrors >= 4 || recentAccuracy < 0.35) {
    // Modelo muy degradado — el mercado contradice sistemáticamente las señales
    modelHealth = 'UNRELIABLE';
    confidenceMultiplier = 0.70;  // Reducir penalización de régimen al 70%
    // Esto significa: si el régimen dice CRISIS (0.44), el motor aplica 0.44*0.70=0.31
    // → más conservador aún, pero con less weight en la señal de régimen

  } else if (consecutiveErrors >= 2 || recentAccuracy < 0.55) {
    // Modelo degradado — señales poco fiables en periodo reciente
    modelHealth = 'DEGRADED';
    confidenceMultiplier = 0.85;  // Reducción moderada

  } else {
    // Modelo fiable
    modelHealth = 'RELIABLE';
    confidenceMultiplier = 1.0;
  }

  // ── RECOMENDACIÓN ──────────────────────────────────────────────────────
  let recommendation: string;
  if (modelHealth === 'UNRELIABLE') {
    recommendation = `⚠️ Meta-IA: ${consecutiveErrors} fallos consecutivos. El modelo de régimen no está capturando el mercado actual. Señales de régimen reducidas al 70%. Considerar revisión manual.`;
  } else if (modelHealth === 'DEGRADED') {
    recommendation = `⚡ Meta-IA: Precisión reciente ${(recentAccuracy * 100).toFixed(0)}% (${recentErrors}/${recent.length} fallos). Confianza del modelo reducida al 85%.`;
  } else {
    recommendation = `✅ Meta-IA: Modelo operando correctamente. Precisión reciente ${(recentAccuracy * 100).toFixed(0)}% (${recent.length - recentErrors}/${recent.length} aciertos).`;
  }

  return {
    confidenceMultiplier,
    modelHealth,
    consecutiveErrors,
    recentAccuracy,
    totalPredictions: records.length,
    recommendation,
    shouldReduceComplexity: modelHealth === 'UNRELIABLE' && consecutiveErrors >= 5,
  };
}

// ── ACTUALIZACIÓN AUTOMÁTICA ───────────────────────────────────────────────
// Llamar mensualmente cuando se actualicen precios:
// savePredictionRecord({
//   predictedRegime: lastMonthRegime,
//   actualReturn1m: portfolioReturn,
//   wasCorrect: evaluatePrediction(lastMonthRegime, portfolioReturn),
//   penaltyApplied: lastMonthPenalty,
// });
//
// En el dashboard (InstitutionalDashboard.tsx), guardar el régimen actual
// y cuando pase un mes, evaluar si fue correcto con el retorno real.