// ===============================================
// ARCHIVO: src/lib/fredManualInputs.ts
// FIX-AUDIT-R9 1: FRED MANUAL INPUTS - localStorage-based persistence
// FIX-AUDIT-R11: + fetchFredFromServer() para cron server-side
// ===============================================
// El usuario actualiza estos valores manualmente o el cron de Supabase
// los actualiza automaticamente. El motor lee la fuente mas reciente.
//
// Fuentes:
//   Server (cron):  supabase/functions/fred-data (diario 08:00 UTC)
//   Manual:         fred.stlouisfed.org, multpl.com
// ===============================================

export interface FredManualData {
  m2GrowthYoY: number;
  cape: number;
  creditSpread: number;
  inflationBreakeven5y: number;
  lastUpdated: string;
  updatedBy?: string;
  /** Si true, el usuario ha editado manualmente → el servidor NO sobrescribe */
  manuallyOverridden: boolean;
}

const STORAGE_KEY = "olympus_fred_manual";

// URL de la Edge Function desplegada en Supabase
const FRED_FUNCTION_URL = "https://yrirandgftnuvdzatwgc.supabase.co/functions/v1/fred-data";

const DEFAULTS: FredManualData = {
  m2GrowthYoY: 5.2,
  cape: 29.5,
  creditSpread: 3.0,
  inflationBreakeven5y: 2.35,
  lastUpdated: new Date().toISOString(),
  manuallyOverridden: false,
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
      return {
        ...parsed,
        manuallyOverridden: parsed.manuallyOverridden === true,
      } as FredManualData;
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
    // Si el usuario guarda manualmente, activamos el override
    manuallyOverridden: true,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    console.warn("[FredManual] localStorage full - couldn't save FRED data");
  }
  return updated;
}

export function resetFredManual(): FredManualData {
  const reset = { ...DEFAULTS, lastUpdated: new Date().toISOString(), manuallyOverridden: false };
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

// ============================================================
// FIX-AUDIT-R12: clearManualOverride
// Restaura los datos del servidor, descartando el override manual.
// Usado por el botón "Sync to Server" en FredManualPanel.
// ============================================================
export function clearManualOverride(): FredManualData | null {
  try {
    const serverRaw = localStorage.getItem(STORAGE_KEY + "_server");
    if (!serverRaw) return null;
    const serverData = JSON.parse(serverRaw);
    if (
      typeof serverData.m2GrowthYoY === "number" &&
      typeof serverData.cape === "number" &&
      typeof serverData.creditSpread === "number" &&
      typeof serverData.inflationBreakeven5y === "number"
    ) {
      serverData.manuallyOverridden = false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serverData));
      localStorage.removeItem(STORAGE_KEY + "_server");
      return serverData as FredManualData;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// FIX-AUDIT-R12: hasServerOverride
// Indica si hay datos de servidor más recientes que los manuales.
// ============================================================
export function hasServerOverride(): boolean {
  try {
    const current = loadFredManual();
    if (!current.manuallyOverridden) return false;
    const serverRaw = localStorage.getItem(STORAGE_KEY + "_server");
    if (!serverRaw) return false;
    const serverData = JSON.parse(serverRaw);
    return typeof serverData.lastUpdated === "string";
  } catch {
    return false;
  }
}

// ============================================================
// FIX-AUDIT-R11: fetchFredFromServer
// Intenta obtener datos FRED del cron server-side de Supabase.
// Si falla (sin API key, offline, error de red), devuelve null.
// El caller debe usar loadFredManual() como fallback.
// ============================================================
export async function fetchFredFromServer(): Promise<FredManualData | null> {
  try {
    const res = await fetch(FRED_FUNCTION_URL, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();

    // Validar que los campos existen y son números
    if (
      typeof json.m2GrowthYoY === "number" &&
      typeof json.cape === "number" &&
      typeof json.creditSpread === "number" &&
      typeof json.inflationBreakeven5y === "number"
    ) {
      // Guardar en localStorage como caché offline,
      // pero NO pisar si el usuario ha hecho override manual.
      const existing = loadFredManual();
      const data: FredManualData = {
        m2GrowthYoY: json.m2GrowthYoY,
        cape: json.cape,
        creditSpread: json.creditSpread,
        inflationBreakeven5y: json.inflationBreakeven5y,
        lastUpdated: json.fetchedAt ?? new Date().toISOString(),
        updatedBy: `server:${json.source ?? "FRED"}`,
        manuallyOverridden: false, // servidor nunca marca override
      };

      // Si el usuario tiene override activo, NO sobreescribir sus valores.
      // Guardamos los datos del servidor en segundo plano (para el botón "Sync").
      if (existing.manuallyOverridden) {
        // Guardar datos del servidor con clave separada para referencia
        try {
          localStorage.setItem(STORAGE_KEY + "_server", JSON.stringify(data));
        } catch { /* ignore */ }
        // Devolver los datos manuales del usuario (respetando el override)
        return existing;
      }

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch { /* localStorage lleno */ }
      return data;
    }
    return null;
  } catch {
    return null;
  }
}
