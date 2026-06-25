// ===============================================
// ARCHIVO: src/lib/fredManualInputs.ts
// FIX-AUDIT-R9 1: FRED MANUAL INPUTS - localStorage-based persistence
// ===============================================
// Sustituye los hardcoded 5.2% M2, 29.5 CAPE, 3.0% credit spread.
// El usuario actualiza estos valores manualmente cuando quiera.
// El motor los lee automaticamente - sin Supabase, sin API key.
//
// Fuentes recomendadas (actualizar semanalmente):
//   M2 Growth YoY:     fred.stlouisfed.org/series/M2SL -> % cambio 1 ano
//   Shiller CAPE:      multpl.com/shiller-pe
//   Credit Spread HY:  fred.stlouisfed.org/series/BAMLH0A0HYM2
//   Breakeven 5y:      fred.stlouisfed.org/series/T5YIFR
// ===============================================

export interface FredManualData {
  m2GrowthYoY: number;
  cape: number;
  creditSpread: number;
  inflationBreakeven5y: number;
  lastUpdated: string;
  updatedBy?: string;
}

const STORAGE_KEY = "olympus_fred_manual";

const DEFAULTS: FredManualData = {
  m2GrowthYoY: 5.2,
  cape: 29.5,
  creditSpread: 3.0,
  inflationBreakeven5y: 2.35,
  lastUpdated: new Date().toISOString(),
};

export function loadFredManual(): FredManualData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.m2GrowthYoY === "number" &&
      typeof parsed.cape === "number" &&
      typeof parsed.creditSpread === "number" &&
      typeof parsed.inflationBreakeven5y === "number"
    ) {
      return parsed as FredManualData;
    }
    return { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveFredManual(data: Partial<FredManualData> & { updatedBy?: string }): FredManualData {
  const current = loadFredManual();
  const updated: FredManualData = {
    m2GrowthYoY: data.m2GrowthYoY ?? current.m2GrowthYoY,
    cape: data.cape ?? current.cape,
    creditSpread: data.creditSpread ?? current.creditSpread,
    inflationBreakeven5y: data.inflationBreakeven5y ?? current.inflationBreakeven5y,
    lastUpdated: new Date().toISOString(),
    updatedBy: data.updatedBy,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    console.warn("[FredManual] localStorage full - couldn't save FRED data");
  }
  return updated;
}

export function resetFredManual(): FredManualData {
  const reset = { ...DEFAULTS, lastUpdated: new Date().toISOString() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reset));
  } catch { /* ignore */ }
  return reset;
}

export function isFredDataFresh(maxAgeDays: number = 7): boolean {
  const data = loadFredManual();
  const ageMs = Date.now() - new Date(data.lastUpdated).getTime();
  return ageMs < maxAgeDays * 24 * 60 * 60 * 1000;
}

export function getFredDefaults(): FredManualData {
  return { ...DEFAULTS };
}
