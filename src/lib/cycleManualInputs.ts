// ===============================================
// ARCHIVO: src/lib/cycleManualInputs.ts
// FIX-CYCLE-PERSIST (Ago-2026): persistencia de inputs manuales del
// detector de techo/suelo de ciclo.
//
// ANTES: uraniumSpot, uraniumLT, siaSalesYoY, soxRsiWeekly, wlgRsiWeekly,
// wlgPERatio, wlgEpsGrowth, emxcRsiWeekly, emxcPERatio, urnuPERatio y
// vvsmPERatio eran `useState(undefined)` sin persistir. Al recargar la
// página volvían a `undefined` → los detectores "se quedaban ciegos"
// (ej: Uranio EXTREME desaparecía del panel de oportunidades porque
// uraniumSpot/uraniumLT volvían a undefined).
// ===============================================

import { CYCLE_STALENESS_RULES, getStaleFields, degradeStaleInputs } from "./dataQuality";

export interface CycleManualInputs {
  uraniumSpot?: number;
  uraniumLT?: number;
  siaSalesYoY?: number;
  soxRsiWeekly?: number;
  wlgRsiWeekly?: number;
  wlgPERatio?: number;
  wlgEpsGrowth?: number;
  emxcRsiWeekly?: number;
  emxcPERatio?: number;
  urnuPERatio?: number;
  vvsmPERatio?: number;
  goldCbPurchases?: number; // GOLD-CB-SENSOR: compras netas oro BC (t/año, World Gold Council)
  /** timestamps (epoch ms) de la última edición de cada campo — para staleness */
  _asOf?: Record<string, number>;
  _source?: string;
}

const STORAGE_KEY = "olympus_cycle_manual";

export function loadCycleManual(): CycleManualInputs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as CycleManualInputs;
  } catch {
    return {};
  }
}

export function saveCycleManual(data: CycleManualInputs): void {
  try {
    const current = loadCycleManual();
    const now = Date.now();
    const asOf = { ...(current._asOf ?? {}) };
    // Solo se refresca el timestamp de un campo si su VALOR cambió respecto
    // a lo guardado. Así un reload (save effect en mount con valores iguales)
    // NO re-sella los timestamps y el staleness sí envejece con el tiempo.
    for (const k of Object.keys(data) as (keyof CycleManualInputs)[]) {
      if (k === "_asOf" || k === "_source") continue;
      const v = data[k];
      const prev = current[k];
      if (v !== undefined && v !== prev) asOf[k as string] = now;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, _asOf: asOf, _source: "manual" }));
  } catch {
    console.warn("[CycleManual] localStorage full — no se pudieron guardar los inputs de ciclo");
  }
}

/** Campos manuales de ciclo que están stale según CYCLE_STALENESS_RULES. */
export function getStaleCycleFields(data?: CycleManualInputs, now = Date.now()): string[] {
  const d = data ?? loadCycleManual();
  return getStaleFields(d._asOf, CYCLE_STALENESS_RULES, now);
}

/** Copia degradada (stale → undefined) para pasar al detector, sin tocar el almacenado. */
export function degradeStaleCycleInputs(data?: CycleManualInputs, now = Date.now()): { degraded: CycleManualInputs; stale: string[] } {
  const d = data ?? loadCycleManual();
  return degradeStaleInputs(d, d._asOf, CYCLE_STALENESS_RULES, now);
}
