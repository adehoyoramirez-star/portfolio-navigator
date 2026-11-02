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
//   - aligned = ambos motores lideran con el mismo activo (dato factual, aparte
//     del score). "Mismo top" NO implica acuerdo: dos carteras pueden liderar con
//     el mismo activo estando a 65pp. Para eso existe sameTopAgreement.
//
// BANDAS (FIX-OBSERVATORY-SATURATION, Nov-2026): se calculan sobre L1 en pp:
//   ≤10 LOW · ≤25 MODERATE · ≤50 HIGH · >50 SEVERE.
//   ANTES se calculaban sobre el score = min(100, round(L1 × 4)), que se satura en
//   L1 ≥ 25,1pp: cualquier divergencia ≥ 25pp mostraba 100/100 SEVERE y el score
//   dejaba de distinguir 26pp de 66pp. El score se mantiene solo como referencia
//   de display (monótono, capado); la banda se deriva de L1.
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

export interface ShadowConcentration {
  name: string;
  /** Peso del activo líder como % del tramo invertido (composición, no exposición). */
  pct: number;
}

export interface ShadowDivergence {
  rows: ShadowDeltaRow[];
  /** Σ|Δ| en pp — divergencia total L1 entre carteras. */
  l1Pp: number;
  /** Banda derivada de L1 (NO del score: ver divergenceBandFromL1). */
  band: DivergenceBand;
  /** Score 0-100 = min(100, round(L1 × 4)) — convención de display monótona, satura en 25pp. */
  score: number;
  /** Peor delta individual en pp (para ordenar la tabla). */
  maxAbsDeltaPp: number;
  /** True si ambos motores lideran con el mismo activo (sin umbral de distancia). */
  aligned: boolean;
  /** aligned Y L1 ≤ SHADOW_ALIGNED_L1_MAX_PP: único caso que cuenta como acuerdo. */
  sameTopAgreement: boolean;
  legacyTop: string;
  coreTop: string;
  /** Activo con mayor peso relativo en cada motor (concentración del tramo invertido). */
  legacyMaxWeight: ShadowConcentration | null;
  coreMaxWeight: ShadowConcentration | null;
  /** Pesos relativos normalizados a 1 (para el track forward y para el snapshot). */
  legacyWeights: Record<string, number>;
  coreWeights: Record<string, number>;
}

/**
 * Umbral de acuerdo real entre motores (pp de L1). Por debajo, "mismo top"
 * significa que además las carteras son casi la misma; por encima, el mismo
 * líder es coincidencia de ranking, no acuerdo de cartera.
 */
export const SHADOW_ALIGNED_L1_MAX_PP = 10;

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

/** Peso de cada activo como fracción del tramo INVERTIDO (Σ = 1). */
function relativeWeights(weights: Map<string, number>): Record<string, number> {
  const total = Array.from(weights.values()).reduce((s, w) => s + Math.max(0, w), 0);
  const out: Record<string, number> = {};
  if (total <= 0) return out;
  for (const [name, w] of weights) out[name] = Math.max(0, w) / total;
  return out;
}

function maxWeightOf(weights: Map<string, number>): ShadowConcentration | null {
  // La comparación va sobre la FRACCIÓN, nunca sobre el pct ya escalado ×100
  // (comparar 0,67 contra 32,9 dejaba el líder clavado en el primer activo).
  let bestName: string | null = null;
  let bestRel = -Infinity;
  for (const [name, rel] of Object.entries(relativeWeights(weights))) {
    if (rel > bestRel) { bestName = name; bestRel = rel; }
  }
  return bestName === null ? null : { name: bestName, pct: bestRel * 100 };
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
  const aligned = legacyTop === coreTop;

  return {
    rows,
    l1Pp,
    band: divergenceBandFromL1(l1Pp),
    score: Math.min(100, Math.round(l1Pp * 4)),
    maxAbsDeltaPp: rows.length > 0 ? Math.abs(rows[0].deltaPp) : 0,
    aligned,
    sameTopAgreement: aligned && l1Pp <= SHADOW_ALIGNED_L1_MAX_PP,
    legacyTop,
    coreTop,
    legacyMaxWeight: maxWeightOf(lw),
    coreMaxWeight: maxWeightOf(cw),
    legacyWeights: relativeWeights(lw),
    coreWeights: relativeWeights(cw),
  };
}

export type DivergenceBand = "LOW" | "MODERATE" | "HIGH" | "SEVERE";

/**
 * Banda sobre el score 0-100 (LEGACY). Se mantiene por compatibilidad: el score
 * satura en 100 con L1 ≥ 25pp, así que clasificar con él convierte cualquier
 * divergencia ≥ 25pp en SEVERE. Para clasificar usa `divergenceBandFromL1`.
 */
export function divergenceBand(score: number): DivergenceBand {
  if (score <= 10) return "LOW";
  if (score <= 25) return "MODERATE";
  if (score <= 50) return "HIGH";
  return "SEVERE";
}

/** Banda sobre L1 en pp (≤10 LOW · ≤25 MODERATE · ≤50 HIGH · >50 SEVERE). */
export function divergenceBandFromL1(l1Pp: number): DivergenceBand {
  if (!Number.isFinite(l1Pp) || l1Pp <= 10) return "LOW";
  if (l1Pp <= 25) return "MODERATE";
  if (l1Pp <= 50) return "HIGH";
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
  /** Sombra CORE-DEF (opcional: las observaciones anteriores no la tienen). */
  coreDefL1Pp?: number;
  coreDefInvestedPct?: number;
  /** Multiplicador efectivo de exposición del Kill Switch (1 = sin acción). */
  coreDefOverlay?: number;
  // ── Track forward (FIX-OBSERVATORY-FORWARD, Nov-2026) ──
  // Opcionales: las observaciones anteriores no los tienen y computeShadowTrack
  // simplemente ignora los intervalos sin datos (no inventa retornos).
  /** Pesos relativos de v5.3 (Σ = 1) el día de la observación. */
  legacyWeights?: Record<string, number>;
  /** Pesos relativos de CORE (Σ = 1) el día de la observación. */
  coreWeights?: Record<string, number>;
  /** Precios por activo (clave = nombre del activo) el día de la observación. */
  prices?: Record<string, number>;
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

// ── Track forward de las dos carteras (rendimiento realizado, no divergencia) ──
// El Observatory mide DISTANCIA entre carteras; la distancia no dice cuál lo hace
// mejor. Este track calcula el retorno que habría realizado cada libro usando los
// precios guardados en cada observación, para que los ≥90 días de sombra aporten
// evidencia de rendimiento y no solo de composición.
//
// Convención declarada (determinista, sin parámetros de estrategia):
//   - Entre observación t-1 y t se mantienen los pesos de t-1 (buy & hold, sin
//     rebalanceo intra-intervalo). No hay costes de transacción: es un track de
//     composición, no una simulación de cuenta.
//   - Solo entran activos con precio > 0 en ambas fechas. Los ausentes aportan 0.
//   - Un intervalo se descarta si la cobertura de pesos con precio es < 50%;
//     así un fallo de datos no se disfraza de retorno.
//   - Retorno compuesto: NAV = Π(1 + r_t), mostrado en %.
export const SHADOW_TRACK_MIN_COVERAGE = 0.5;

export interface ShadowTrack {
  /** Intervalos usados (observaciones consecutivas con datos válidos). */
  intervals: number;
  /** Fecha de la primera observación con datos de track, o null. */
  startDate: string | null;
  /** Retorno compuesto de cada libro desde startDate, en %. */
  legacyCumPct: number;
  coreCumPct: number;
  /** legacyCumPct − coreCumPct en pp. Positivo = v5.3 lo hizo mejor. */
  deltaPp: number;
  /** Riesgo realizado de cada libro sobre la misma serie de intervalos. */
  legacy: ShadowBookStats;
  core: ShadowBookStats;
}

export interface ShadowBookStats {
  /** Retorno compuesto desde startDate, en %. */
  cumPct: number;
  /** Máximo drawdown desde el pico de su propio NAV (≤ 0), en %. */
  maxDrawdownPct: number;
  /**
   * Volatilidad realizada anualizada, en %. Retornos por DÍA CALENDARIO
   * (r_i^(1/Δdías)) escalados ×√365, porque las observaciones no caen en
   * sesiones regulares. null si hay < 2 intervalos: con una sola observación
   * no hay dispersión y devolver 0 sería inventar calma.
   */
  volAnnualPct: number | null;
}

function bookReturn(
  weights: Record<string, number> | undefined,
  pricesFrom: Record<string, number> | undefined,
  pricesTo: Record<string, number> | undefined,
): number | null {
  if (!weights || !pricesFrom || !pricesTo) return null;
  let covered = 0;
  let ret = 0;
  for (const [name, w] of Object.entries(weights)) {
    const p0 = pricesFrom[name];
    const p1 = pricesTo[name];
    if (!(p0 > 0) || !(p1 > 0)) continue;
    covered += w;
    ret += w * (p1 / p0 - 1);
  }
  if (covered < SHADOW_TRACK_MIN_COVERAGE) return null;
  return ret;
}

const CALENDAR_DAYS_PER_YEAR = 365;

/** Días calendario entre dos fechas YYYY-MM-DD (mínimo 1: nunca divide por 0). */
function daysBetween(from: string, to: string): number {
  const t0 = Date.parse(`${from}T00:00:00Z`);
  const t1 = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return 1;
  const days = Math.round((t1 - t0) / 86_400_000);
  return days >= 1 ? days : 1;
}

interface BookAccumulator {
  nav: number;
  peak: number;
  maxDdPct: number;
  /** Retorno por día calendario de cada intervalo (para la vol realizada). */
  dailyReturns: number[];
}

function newAccumulator(): BookAccumulator {
  return { nav: 1, peak: 1, maxDdPct: 0, dailyReturns: [] };
}

function step(acc: BookAccumulator, intervalReturn: number, days: number): void {
  acc.nav *= 1 + intervalReturn;
  if (acc.nav > acc.peak) acc.peak = acc.nav;
  // Guard defensivo: un NAV ≤ 0 haría explotar la raíz de la anualización.
  if (acc.peak > 0 && acc.nav > 0) {
    acc.maxDdPct = Math.min(acc.maxDdPct, (acc.nav / acc.peak - 1) * 100);
  }
  const perDay = 1 + intervalReturn > 0 ? Math.pow(1 + intervalReturn, 1 / days) - 1 : intervalReturn;
  acc.dailyReturns.push(perDay);
}

function statsOf(acc: BookAccumulator): ShadowBookStats {
  const n = acc.dailyReturns.length;
  let volAnnualPct: number | null = null;
  if (n >= 2) {
    const mean = acc.dailyReturns.reduce((s, r) => s + r, 0) / n;
    const variance = acc.dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
    volAnnualPct = Math.sqrt(Math.max(0, variance)) * Math.sqrt(CALENDAR_DAYS_PER_YEAR) * 100;
  }
  return {
    cumPct: (acc.nav - 1) * 100,
    maxDrawdownPct: acc.maxDdPct,
    volAnnualPct,
  };
}

export function computeShadowTrack(history: ShadowSnapshot[]): ShadowTrack {
  const pts = history
    .filter(h => h.legacyWeights && h.coreWeights && h.prices)
    .sort((a, b) => a.date.localeCompare(b.date));

  const legacyAcc = newAccumulator();
  const coreAcc = newAccumulator();
  let intervals = 0;
  let startDate: string | null = null;

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const rLegacy = bookReturn(prev.legacyWeights, prev.prices, cur.prices);
    const rCore = bookReturn(prev.coreWeights, prev.prices, cur.prices);
    if (rLegacy === null || rCore === null) continue;
    const days = daysBetween(prev.date, cur.date);
    step(legacyAcc, rLegacy, days);
    step(coreAcc, rCore, days);
    intervals++;
    if (startDate === null) startDate = prev.date; // primera fecha con datos
  }

  const legacyCumPct = (legacyAcc.nav - 1) * 100;
  const coreCumPct = (coreAcc.nav - 1) * 100;

  return {
    intervals,
    startDate,
    legacyCumPct,
    coreCumPct,
    deltaPp: legacyCumPct - coreCumPct,
    legacy: statsOf(legacyAcc),
    core: statsOf(coreAcc),
  };
}
