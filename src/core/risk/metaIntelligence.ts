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
//   sube >5%), AUMENTA el confidenceMultiplier hacia 1.0 para que
//   `regimePenalty × confidenceMultiplier` se acerque al regimePenalty puro
//   (o lo supere ligeramente hacia más exposición) y compensar así el sesgo
//   excesivamente conservador.
//
// FIX-R2-A1 (auditoría institucional ronda 2):
//   ANTES: confidenceMultiplier = 0.70 cuando el modelo falla.
//     olympusV3 aplica `regimePenalty × confidenceMultiplier` en CRISIS/CONTRACTION.
//     Ejemplo: regimePenalty=0.44 (CRISIS), confidence=0.70 → 0.308 → MENOS exposición.
//     Esto es lo OPUESTO a la intención declarada: si el motor dice CRISIS y el
//     mercado sube 6 meses (fallo sistemático), hacer el motor aún más
//     conservador amplifica el coste de oportunidad. Bug conceptual confirmado
//     en auditoría ronda 2.
//   AHORA: confidenceMultiplier ahora está en [1.00, 1.30].
//     - Modelo fiable (sin fallos): multiplier = 1.00 (confianza plena en la señal).
//     - Modelo degradado: multiplier = 1.15 (15% más exposición de lo que la
//       señal de régimen sugeriría, para compensar el sesgo).
//     - Modelo no fiable: multiplier = 1.30 (30% extra — neutraliza casi todo
//       el efecto del régimen si está sistemáticamente equivocado).
//     - En olympusV3, regimePenalty se clamp a [0.4, 1.0] tras la multiplicación,
//       así que un multiplier > 1 solo sube la exposición, nunca la reduce.
//
// DEFINICIÓN DE "ACIERTO" del modelo de régimen:
//   EXPANSION predicho + retorno > 0%  → acierto
//   CRISIS predicho + retorno < 0%     → acierto (protegió)
//   CRISIS predicho + retorno > 5%     → fallo (pérdida de oportunidad)
//   EXPANSION predicho + retorno < -5% → fallo (no protegió)
//
// OUTPUTS:
//   confidenceMultiplier: [1.00, 1.30]  ← FIX-R2-A1: rango invertido
//     → 1.00 = confiar plenamente en la señal de régimen.
//     → 1.30 = la señal de régimen está sistemáticamente equivocada; el motor
//       añade hasta +30% de exposición para compensar el sesgo.
//   modelHealth: 'RELIABLE' | 'DEGRADED' | 'UNRELIABLE'
//   consecutiveErrors: número de fallos consecutivos recientes
//
// ALMACENAMIENTO:
//   localStorage key: 'olympus_meta_intelligence_v1'
//   Persistencia: 90 días de historial máximo
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
  // FIX-R2-A1: rango [1.00, 1.30] en lugar de [0.70, 1.00].
  // 1.00 = confianza plena en la señal de régimen.
  // 1.30 = la señal de régimen está sistemáticamente equivocada; compensa con +30% exposición.
  confidenceMultiplier: number;
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

// FIX-DENO-STORAGE (Jul-2026): localStorage no existe en Deno/Edge Functions.
//   Fallback Map en memoria para que la meta-inteligencia funcione en cualquier runtime.
const _metaMemory = new Map<string, string>();
function _storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch {}
  return _metaMemory.get(key) ?? null;
}
function _storageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); return; } catch {}
  _metaMemory.set(key, value);
}
function _storageRemove(key: string): void {
  try { localStorage.removeItem(key); return; } catch {}
  _metaMemory.delete(key);
}

export function loadPredictionHistory(): PredictionRecord[] {
  try {
    const raw = _storageGet(STORAGE_KEY);
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
    _storageSet(STORAGE_KEY, JSON.stringify(updated));
  } catch { /* noop */ }
  return updated;
}

export function clearPredictionHistory(): void {
  try { _storageRemove(STORAGE_KEY); } catch { /* noop */ }
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
    // Modelo muy degradado — el mercado contradice sistemáticamente las señales.
    // FIX-R2-A1: multiplier=1.30 (antes 0.70, lógica invertida).
    //   regimePenalty=0.44 × 1.30 = 0.572 (clamped a 1.0) → MÁS exposición.
    //   Esto compensa el sesgo: si predice CRISIS y el mercado sube, no ser aún más conservador.
    modelHealth = 'UNRELIABLE';
    confidenceMultiplier = 1.30;

  } else if (consecutiveErrors >= 2 || recentAccuracy < 0.55) {
    // Modelo degradado — señales poco fiables en periodo reciente.
    // FIX-R2-A1: multiplier=1.15 (antes 0.85).
    modelHealth = 'DEGRADED';
    confidenceMultiplier = 1.15;

  } else {
    // Modelo fiable — confianza plena en la señal de régimen.
    modelHealth = 'RELIABLE';
    confidenceMultiplier = 1.00;
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