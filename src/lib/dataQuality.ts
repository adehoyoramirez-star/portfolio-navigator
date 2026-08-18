// ============================================================
// ARCHIVO: src/lib/dataQuality.ts
// FASE 4 — DATA QUALITY ESTRUCTURAL (centralizado).
//
// Cada input manual relevante lleva: source, asOf (epoch ms), regla de
// staleness y comportamiento de degradación. Un solo lugar, no guards
// aislados por pantalla.
//
// Degradación = el dato stale se trata como undefined en el detector
// (fallback seguro a "Sin datos"), PERO el valor guardado NO se borra:
// la degradación es de solo lectura en la frontera del detector.
// ============================================================

export interface StalenessRule {
  /** antigüedad máxima antes de considerarse stale (ms) */
  staleAfterMs: number;
  /** descripción legible de la frecuencia esperada */
  label: string;
  /** comportamiento al estar stale (por ahora: fallback a undefined) */
  degrade: "fallback";
}

const DAY = 24 * 60 * 60 * 1000;

// Reglas de frescura por campo de ciclo (pre-registradas).
// Frecuencias: diaria / semanal / mensual / trimestral.
export const CYCLE_STALENESS_RULES: Record<string, StalenessRule> = {
  uraniumSpot:      { staleAfterMs: 7 * DAY,  label: "diario",      degrade: "fallback" },
  uraniumLT:        { staleAfterMs: 7 * DAY,  label: "diario",      degrade: "fallback" },
  siaSalesYoY:      { staleAfterMs: 31 * DAY, label: "mensual",     degrade: "fallback" },
  soxRsiWeekly:     { staleAfterMs: 14 * DAY, label: "semanal",     degrade: "fallback" },
  wlgRsiWeekly:     { staleAfterMs: 14 * DAY, label: "semanal",     degrade: "fallback" },
  emxcRsiWeekly:    { staleAfterMs: 14 * DAY, label: "semanal",     degrade: "fallback" },
  wlgPERatio:       { staleAfterMs: 92 * DAY, label: "trimestral",  degrade: "fallback" },
  wlgEpsGrowth:     { staleAfterMs: 92 * DAY, label: "trimestral",  degrade: "fallback" },
  emxcPERatio:      { staleAfterMs: 92 * DAY, label: "trimestral",  degrade: "fallback" },
  urnuPERatio:      { staleAfterMs: 92 * DAY, label: "trimestral",  degrade: "fallback" },
  vvsmPERatio:      { staleAfterMs: 92 * DAY, label: "trimestral",  degrade: "fallback" },
  goldCbPurchases:  { staleAfterMs: 92 * DAY, label: "trimestral",  degrade: "fallback" },
};

export function ageMs(asOf: number | undefined, now = Date.now()): number | undefined {
  if (asOf === undefined) return undefined;
  return Math.max(0, now - asOf);
}

export function isStale(asOf: number | undefined, staleAfterMs: number, now = Date.now()): boolean {
  const age = ageMs(asOf, now);
  return age !== undefined && age > staleAfterMs;
}

export function getStaleFields(
  asOfMap: Record<string, number> | undefined,
  rules: Record<string, StalenessRule>,
  now = Date.now(),
): string[] {
  if (!asOfMap) return [];
  return Object.keys(rules).filter(k => isStale(asOfMap[k], rules[k].staleAfterMs, now));
}

/**
 * Devuelve una COPIA de `data` con los campos stale degradados a undefined.
 * No muta `data` ni borra el almacenamiento.
 */
export function degradeStaleInputs<T extends object>(
  data: T,
  asOfMap: Record<string, number> | undefined,
  rules: Record<string, StalenessRule>,
  now = Date.now(),
): { degraded: T; stale: string[] } {
  const stale = getStaleFields(asOfMap, rules, now);
  const degraded = { ...data } as T;
  for (const k of stale) {
    (degraded as Record<string, unknown>)[k] = undefined;
  }
  return { degraded, stale };
}

// ============================================================
// POLÍTICA DE DATA QUALITY (Ago-2026, Comité) — aprobada explícitamente.
//
// Se ejecuta en la FRONTERA de inputs (dashboard → detector). NO toca la
// matemática interna de los detectores: solo decide qué valores llegan.
//
//  1. Uranio (uraniumSpot / uraniumLT) stale → undefined.
//     El detector ya hace early-return SAFE / trim 0% (verificado).
//  2. WLG P/E (wlgPERatio) stale → BLOQUEO de frontera: se neutraliza
//     la señal de valoración WLG. Se anulan también wlgRsiWeekly y wlgCAPE
//     para que el detector NO pueda puntuar por RSI-W-only ni por CAPE-proxy
//     (early-return "Sin datos" → SAFE/trim 0% en top, NEUTRAL en bottom).
//  3. WLG EPS Growth (wlgEpsGrowth) stale → undefined.
//     El detector omite el modificador PEG (isValidReading guard), sin
//     congelar el último valor bueno.
// ============================================================

export interface CycleDataQualityInput {
  uraniumSpot?: number;
  uraniumLT?: number;
  wlgRsiWeekly?: number;
  wlgPERatio?: number;
  wlgEpsGrowth?: number;
  /** CAPE/P/E S&P 500 auto (FRED) — solo se bloquea vía wlgPERatio stale, no tiene regla propia. */
  wlgCAPE?: number;
}

export interface CycleDataQualityOutput extends CycleDataQualityInput {
  /** campos stale detectados (según CYCLE_STALENESS_RULES). */
  stale: string[];
  /** campos anulados por la política de bloqueo (no están stale por sí mismos). */
  blocked: string[];
}

export function applyCycleDataQuality(
  inputs: CycleDataQualityInput,
  asOf: Record<string, number> | undefined,
  now = Date.now(),
): CycleDataQualityOutput {
  const stale = getStaleFields(asOf, CYCLE_STALENESS_RULES, now);
  const staleSet = new Set(stale);
  const blocked: string[] = [];

  const out: CycleDataQualityOutput = { ...inputs, stale, blocked };

  // 1. Uranio: stale → undefined (fallback seguro).
  if (staleSet.has("uraniumSpot")) out.uraniumSpot = undefined;
  if (staleSet.has("uraniumLT")) out.uraniumLT = undefined;

  // 2. WLG P/E primario stale → bloqueo de frontera.
  if (staleSet.has("wlgPERatio")) {
    out.wlgPERatio = undefined;
    out.wlgRsiWeekly = undefined;
    out.wlgCAPE = undefined;
    blocked.push("wlgRsiWeekly", "wlgCAPE");
  }

  // 3. WLG EPS Growth stale → undefined (sin PEG).
  if (staleSet.has("wlgEpsGrowth")) out.wlgEpsGrowth = undefined;

  return out;
}
