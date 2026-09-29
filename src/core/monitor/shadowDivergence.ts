// ============================================================
// src/core/monitor/shadowDivergence.ts
// Modo sombra CORE vs v5.3 — divergencia de cartera (solo observabilidad).
//
// Propósito: cuantificar cuánto difiere la cartera que construiría CORE v1.0
// de la cartera v5.3 en producción, para registrar evidencia durante el
// periodo de sombra del plan de cutover (Phases 11-12, change-control §18).
//
// DEFINICIÓN (pre-registrada, determinista, SIN parámetros de estrategia):
//   - Peso absoluto del activo i = finalAllocation_i × totalInvested del motor.
//     (Los deltas se miden sobre exposición ABSOLUTA: capturan composición Y
//     diferencia de exposición total, que es lo que mueve el NAV.)
//   - deltaPp_i = (w_core_i − w_legacy_i) × 100  (puntos porcentuales de cartera)
//   - L1 (pp) = Σ_i |deltaPp_i|  ← "turnover" necesario para pasar de v5.3 a CORE
//   - Score 0-100 = min(100, round(L1 × 4)).
//     El mapeo ×4 es SOLO una convención de display (monótona, preserva orden);
//     no es un parámetro calibrado ni afecta a ninguna decisión del motor.
//   - aligned = ambos motores lideran con el mismo activo (se muestra aparte,
//     no se mezcla en el score).
// Bandas de display: ≤10 LOW · ≤25 MODERATE · ≤50 HIGH · >50 SEVERE.
// ============================================================

export interface ShadowAllocation {
  name: string;
  finalAllocation: number;
}

export interface ShadowEngineSide {
  allocations: ShadowAllocation[];
  totalInvested: number;
  regime?: string;
}

export interface ShadowDeltaRow {
  name: string;
  /** Peso absoluto v5.3 (% de la cartera total, 0-100). */
  legacyPct: number;
  /** Peso absoluto CORE (% de la cartera total, 0-100). */
  corePct: number;
  /** Δ CORE − v5.3 en puntos porcentuales. */
  deltaPp: number;
}

export interface ShadowDivergence {
  rows: ShadowDeltaRow[];
  /** Σ|Δ| en pp — divergencia total L1 entre carteras. */
  l1Pp: number;
  /** Score 0-100 = min(100, round(L1 × 4)) — convención de display monótona. */
  score: number;
  /** Peor delta individual en pp (para ordenar la tabla). */
  maxAbsDeltaPp: number;
  /** True si ambos motores lideran con el mismo activo. */
  aligned: boolean;
  legacyTop: string;
  coreTop: string;
}

function absWeights(side: ShadowEngineSide): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of side.allocations) {
    const w = (Number.isFinite(a.finalAllocation) ? a.finalAllocation : 0) *
      (Number.isFinite(side.totalInvested) ? side.totalInvested : 0);
    m.set(a.name, (m.get(a.name) ?? 0) + w);
  }
  return m;
}

function topHolding(weights: Map<string, number>): string {
  let best = "—";
  let bestW = -1;
  for (const [name, w] of weights) {
    if (w > bestW) { best = name; bestW = w; }
  }
  return best;
}

export function computeShadowDivergence(legacy: ShadowEngineSide, core: ShadowEngineSide | null): ShadowDivergence {
  const lw = absWeights(legacy);
  const cw = core ? absWeights(core) : new Map<string, number>();
  const names = Array.from(new Set([...lw.keys(), ...cw.keys()]));

  const rows: ShadowDeltaRow[] = names.map(name => {
    const l = lw.get(name) ?? 0;
    const c = cw.get(name) ?? 0;
    return { name, legacyPct: l * 100, corePct: c * 100, deltaPp: (c - l) * 100 };
  }).sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp));

  const l1Pp = rows.reduce((s, r) => s + Math.abs(r.deltaPp), 0);
  const legacyTop = topHolding(lw);
  const coreTop = topHolding(cw);

  return {
    rows,
    l1Pp,
    score: Math.min(100, Math.round(l1Pp * 4)),
    maxAbsDeltaPp: rows.length > 0 ? Math.abs(rows[0].deltaPp) : 0,
    aligned: legacyTop === coreTop,
    legacyTop,
    coreTop,
  };
}

export type DivergenceBand = "LOW" | "MODERATE" | "HIGH" | "SEVERE";

export function divergenceBand(score: number): DivergenceBand {
  if (score <= 10) return "LOW";
  if (score <= 25) return "MODERATE";
  if (score <= 50) return "HIGH";
  return "SEVERE";
}

// ── Historial de la sombra (persistido por el dashboard en localStorage) ──
export interface ShadowSnapshot {
  /** Fecha ISO del día de la observación (YYYY-MM-DD). */
  date: string;
  divergenceScore: number;
  l1Pp: number;
  aligned: boolean;
  legacyTop: string;
  coreTop: string;
}

export const SHADOW_HISTORY_MAX_ENTRIES = 180; // ~6 meses de sesiones

/**
 * Puro: añade un snapshot, reemplaza si ya existe uno del mismo día
 * (queda la última observación) y recorta al máximo de entradas.
 */
export function recordShadowSnapshot(
  history: ShadowSnapshot[],
  snapshot: ShadowSnapshot,
  maxEntries: number = SHADOW_HISTORY_MAX_ENTRIES,
): ShadowSnapshot[] {
  const filtered = history.filter(h => h.date !== snapshot.date);
  const next = [...filtered, snapshot];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}
