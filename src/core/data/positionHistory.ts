// ============================================================
// ARCHIVO: src/core/data/positionHistory.ts
// FIX-FORENSIC-H6: histórico de posiciones reales para eliminar
// el look-ahead bias en las métricas realizadas del dashboard.
//
// PROBLEMA (auditoría forense):
//   El panel "Portfolio Analytics" calculaba el retorno diario de la
//   cartera aplicando los PESOS ACTUALES (a.price * a.shares) sobre
//   TODO el histórico de precios. Esos pesos no existían en el pasado
//   -> look-ahead bias: el retorno "realizado" de hace 5 años se
//   computaba con las participaciones de HOY.
//
// FIX:
//   1. Rastrear las posiciones (shares) reales día a día vía snapshots.
//   2. Calcular el retorno realizado usando los pesos REALMENTE
//      mantenidos en cada momento (pesos variables en el tiempo).
//   3. Si aún no hay historial suficiente, NO inventar un retorno
//      realizado — el panel muestra estimaciones forward (μ) claramente
//      etiquetadas como tales.
//
// El retorno diario usa pesos al INICIO del día (buy-and-hold entre
// rebalanceos), la convención estándar de TWR (time-weighted return).
// ============================================================

export interface PositionSnapshot {
  date: string;                       // 'YYYY-MM-DD' (fecha local)
  positions: Record<string, number>;  // ticker -> shares mantenidas ese día
}

const STORE_KEY = "olympus_position_history";
const MAX_SNAPSHOTS = 400; // ~1.6 años de snaps diarios — margen amplio para métricas realizadas

/** Fecha local 'YYYY-MM-DD' (sin hora, sin UTC shift). */
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Carga los snapshots persistidos (cronológico ascendente). */
export function loadPositionHistory(): PositionSnapshot[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is PositionSnapshot =>
        s && typeof s === "object" && typeof s.date === "string" && s.positions && typeof s.positions === "object"
    );
  } catch {
    return [];
  }
}

/** Borra el histórico de posiciones (para reset manual / tests). */
export function resetPositionHistory(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch { /* localStorage no disponible → memoria */ }
}

function persist(snapshots: PositionSnapshot[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(snapshots.slice(-MAX_SNAPSHOTS)));
  } catch { /* localStorage no disponible → memoria */ }
}

/**
 * Registra (o actualiza) el snapshot de posiciones del día actual.
 * UPSERT sobre el último día: si hoy ya se registró, sobreescribe las
 * shares con las actuales (p. ej. tras una operación). Si es un día
 * nuevo, añade una entrada.
 */
export function recordCurrentPositions(
  positions: Record<string, number>,
  now: Date = new Date()
): PositionSnapshot[] {
  const snapshots = loadPositionHistory();
  const today = todayISO(now);
  const last = snapshots[snapshots.length - 1];

  if (last && last.date === today) {
    last.positions = { ...positions };
  } else {
    snapshots.push({ date: today, positions: { ...positions } });
  }

  persist(snapshots);
  return snapshots.slice(-MAX_SNAPSHOTS);
}

/**
 * Retorno diario realizado usando pesos VARIABLES EN EL TIEMPO (sin look-ahead).
 *
 * @param histories  precios de cierre por ticker, orden cronológico ascendente.
 *                   (histories[ticker][i] = cierre del día i)
 * @param snapshots  posiciones por día, cronológico ascendente.
 *                   snapshot k se alinea al día `H - N + k` del historial,
 *                   donde H = longitud (mínima) del historial y N = nº snapshots.
 *                   Solo se cubre la ventana rastreada (los últimos N días),
 *                   NUNCA se proyectan las posiciones hacia el pasado.
 *
 * @returns retornos diarios (longitud N-1). `[]` si hay datos insuficientes.
 *
 * Convención: el retorno del día k (transición snapshot k-1 -> k) usa los
 * pesos del snapshot k-1 (inicio del día), estándar TWR.
 */
export function computeRealizedReturns(
  histories: Record<string, number[]>,
  snapshots: PositionSnapshot[]
): number[] {
  const N = snapshots.length;
  if (N < 2) return [];

  const tickers = Object.keys(histories).filter(
    (t) => Array.isArray(histories[t]) && (histories[t]?.length ?? 0) >= N
  );
  if (tickers.length === 0) return [];

  const H = Math.min(...tickers.map((t) => histories[t].length));
  if (H < N) return [];

  const baseIdx = H - N; // índice del historial correspondiente al snapshot k=0
  const returns: number[] = [];

  for (let k = 1; k < N; k++) {
    const prevIdx = baseIdx + (k - 1);
    const currIdx = baseIdx + k;
    const prevSnapshot = snapshots[k - 1];

    // Valor y pesos de la cartera al INICIO del día k (snapshot k-1).
    let prevTotal = 0;
    const prevVals: Record<string, number> = {};
    for (const t of tickers) {
      const shares = prevSnapshot.positions[t] ?? 0;
      const px = histories[t][prevIdx];
      if (px > 0 && shares > 0) {
        const v = shares * px;
        prevVals[t] = v;
        prevTotal += v;
      }
    }

    if (prevTotal <= 0) {
      returns.push(0);
      continue;
    }

    let dayRet = 0;
    for (const t of tickers) {
      const w = (prevVals[t] ?? 0) / prevTotal;
      const p0 = histories[t][prevIdx];
      const p1 = histories[t][currIdx];
      if (w > 0 && p0 > 0) {
        dayRet += w * (p1 / p0 - 1);
      }
    }
    returns.push(dayRet);
  }

  return returns;
}
