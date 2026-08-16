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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    console.warn("[CycleManual] localStorage full — no se pudieron guardar los inputs de ciclo");
  }
}
