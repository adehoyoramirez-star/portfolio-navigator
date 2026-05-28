// ===============================================
// ARCHIVO: src/core/persistence/portfolioStorage.ts
// FIX-HISTORY-01: Sistema de Snapshots Diarios
// ===============================================
// PROBLEMA ANTERIOR:
//   El histórico solo guardaba cuando CAMBIABA el régimen.
//   Si el usuario actualizaba datos manuales varias veces al día,
//   el histórico mezclaba sesiones con datos incorrectos/corregidos.
//   Un régimen que oscilaba CRISIS→CONTRACTION→CRISIS en un día generaba
//   3 entradas falsas que corrompían el cómputo de duración del régimen
//   (regimeDuration → durationAdjustment).
//
// SOLUCIÓN (Daily Snapshot System):
//   1. saveRegimeEntry() sigue funcionando igual (log de cambios de régimen)
//   2. NUEVO: saveDailySnapshot() — guarda UNA entrada por fecha de calendario.
//      Si ya existe snapshot del día, NO lo sobreescribe (el primero del día gana).
//      Esto garantiza que el histórico refleje el estado del mercado a primera hora,
//      no la última edición manual de las 22:00.
//   3. NUEVO: loadDailySnapshots() — devuelve array ordenado por fecha para
//      que el motor pueda calcular regimeDuration sobre datos reales, no falsificados.
//   4. El dashboard debe llamar a saveDailySnapshot() UNA VEZ al cargar la página,
//      no en cada recálculo del motor.
//
// ANALOGÍA HEDGE FUND:
//   Bloomberg guarda un "cierre de sesión" oficial por día.
//   No sobrescribe el cierre con las actualizaciones del día siguiente.
//   Nosotros hacemos lo mismo: primer snapshot del día = snapshot definitivo.
// ===============================================

const STORAGE_KEY  = "olympus_portfolio_v1";
const MACRO_KEY    = "olympus_macro_v1";
const REGIME_KEY   = "olympus_regime_history_v1";
// FIX-HISTORY-01: nueva clave para snapshots diarios
const SNAPSHOT_KEY = "olympus_daily_snapshots_v1";

export interface PersistedPosition {
  ticker: string;
  shares: number;
  avgPrice: number;
}

export interface PersistedPortfolio {
  positions: PersistedPosition[];
  cashReserve: number;
  monthlyInjection: number;
  savedAt: string;
}

export interface PersistedMacro {
  vix: number;
  manualPER: number;
  manualBond10y: number;
  bond2y: number;
  m2Growth: number;
  creditSpread: number;
  liquidityGrowth: number;
  dxy: number;
  moveIndex: number;
  btcVol: number;
  btcDominance?: number;
  mvrvRatio?: number;
  jumpIntensity?: number;
  jumpIntensityPortfolio?: number;
  jumpMean?: number;
  jumpStd?: number;
  puellMultiple?: number;
  hashRibbonState?: string;
  piCycleMa111?: number;
  piCycleMa350x2?: number;
  elliottCurrentWave?: string;
  elliottPivots?: Array<{ price: number; dateStr: string; type: string }>;
  is3qRsiWeekly?: number;
  is3qPERatio?: number;
  emxcRsiWeekly?: number;
  emxcPERatio?: number;
  xnasRsiWeekly?: number;
  xnasPERatio?: number;
  savedAt: string;
}

export interface RegimeHistoryEntry {
  timestamp: string;
  regime: string;
  regimePenalty: number;
  confidence: string;
  vix: number;
}

// FIX-HISTORY-01: Snapshot diario completo
// Captura el estado del mercado y portfolio una vez por día.
// Es la "foto oficial" del día — no se sobrescribe con ediciones posteriores.
export interface DailySnapshot {
  date: string;           // "YYYY-MM-DD" — clave única por día
  timestamp: string;      // ISO timestamp de cuándo se guardó
  regime: string;
  regimePenalty: number;
  vix: number;
  bond10y: number;
  bond2y: number;         // FIX-BOND2Y: almacenado desde input manual real, no ^IRX
  creditSpread: number;
  m2Growth: number;
  btcDominance: number;
  mvrvRatio: number;
  portfolioValue: number;
  drawdown: number;
  confidence: string;
}

// ==================== PORTFOLIO ====================

export function savePortfolio(data: PersistedPortfolio): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch (e) { console.warn("savePortfolio error:", e); }
}

export function loadPortfolio(): PersistedPortfolio | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.positions || !Array.isArray(parsed.positions)) return null;
    return parsed as PersistedPortfolio;
  } catch { return null; }
}

// ==================== MACRO ====================

export function saveMacro(data: PersistedMacro): void {
  try { localStorage.setItem(MACRO_KEY, JSON.stringify(data)); }
  catch (e) { console.warn("saveMacro error:", e); }
}

export function loadMacro(): PersistedMacro | null {
  try {
    const raw = localStorage.getItem(MACRO_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedMacro;
  } catch { return null; }
}

// ==================== HISTORIAL DE RÉGIMEN ====================
// Este log captura CAMBIOS de régimen (no todos los días).
// Sirve para detectar transiciones: ¿cuándo pasó de CRISIS a CONTRACTION?

export function saveRegimeEntry(entry: RegimeHistoryEntry): void {
  try {
    const history = loadRegimeHistory();
    // Solo guardar si el régimen cambió respecto al último
    if (history.length > 0 && history[0].regime === entry.regime) return;
    history.unshift(entry);
    localStorage.setItem(REGIME_KEY, JSON.stringify(history.slice(0, 90)));
  } catch (e) { console.warn("saveRegimeEntry error:", e); }
}

export function loadRegimeHistory(): RegimeHistoryEntry[] {
  try {
    const raw = localStorage.getItem(REGIME_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RegimeHistoryEntry[];
  } catch { return []; }
}

// ==================== SNAPSHOTS DIARIOS ====================
// FIX-HISTORY-01: Sistema que da al motor memoria temporal real.
//
// REGLA FUNDAMENTAL: UN snapshot por día. El primero del día es definitivo.
//   - Si el usuario abre la app a las 9:00 y actualiza VIX → snapshot guardado.
//   - Si a las 22:00 corrige manualmente → saveDailySnapshot() detecta que
//     ya existe snapshot del día y NO lo sobreescribe.
//   - Así el histórico es estable y no cambia con correcciones tardías.
//
// EXCEPCIÓN: forceOverwrite=true (solo para correcciones intencionadas del día actual).

export function saveDailySnapshot(snapshot: Omit<DailySnapshot, "date" | "timestamp">, forceOverwrite = false): boolean {
  try {
    const today = new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"
    const snapshots = loadDailySnapshots();

    // FIX-HISTORY-01: no sobreescribir si ya existe snapshot del día
    const existingIdx = snapshots.findIndex(s => s.date === today);
    if (existingIdx !== -1 && !forceOverwrite) {
      return false; // snapshot del día ya existe, no sobreescribir
    }

    const full: DailySnapshot = {
      ...snapshot,
      date: today,
      timestamp: new Date().toISOString(),
    };

    if (existingIdx !== -1 && forceOverwrite) {
      snapshots[existingIdx] = full;
    } else {
      snapshots.unshift(full);
    }

    // Mantener máximo 365 días de histórico
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots.slice(0, 365)));
    return true;
  } catch (e) {
    console.warn("saveDailySnapshot error:", e);
    return false;
  }
}

export function loadDailySnapshots(): DailySnapshot[] {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as DailySnapshot[];
  } catch { return []; }
}

// Convertir snapshots diarios al formato RegimeHistoryEntry para compatibilidad
// con getMasterRegime() que espera regimeHistory: RegimeHistoryEntry[]
export function snapshotsToRegimeHistory(snapshots: DailySnapshot[]): RegimeHistoryEntry[] {
  return snapshots.map(s => ({
    timestamp: s.timestamp,
    regime: s.regime,
    regimePenalty: s.regimePenalty,
    confidence: s.confidence,
    vix: s.vix,
  }));
}

// ==================== UTILIDADES ====================

export function clearAll(): void {
  [STORAGE_KEY, MACRO_KEY, REGIME_KEY, SNAPSHOT_KEY].forEach(k => localStorage.removeItem(k));
}

// Estadísticas del histórico — útil para el dashboard
export function getSnapshotStats(): {
  totalDays: number;
  oldestDate: string | null;
  regimeDistribution: Record<string, number>;
  avgDrawdown: number;
} {
  const snapshots = loadDailySnapshots();
  if (snapshots.length === 0) {
    return { totalDays: 0, oldestDate: null, regimeDistribution: {}, avgDrawdown: 0 };
  }

  const distribution: Record<string, number> = {};
  let totalDD = 0;

  for (const s of snapshots) {
    distribution[s.regime] = (distribution[s.regime] ?? 0) + 1;
    totalDD += s.drawdown;
  }

  return {
    totalDays: snapshots.length,
    oldestDate: snapshots[snapshots.length - 1]?.date ?? null,
    regimeDistribution: distribution,
    avgDrawdown: totalDD / snapshots.length,
  };
}
