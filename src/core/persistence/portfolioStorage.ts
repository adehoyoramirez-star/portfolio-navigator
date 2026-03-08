// ===============================================
// ARCHIVO: src/core/persistence/portfolioStorage.ts
// NIVEL 4 — Persistencia del estado del portfolio
// ===============================================

const STORAGE_KEY = "olympus_portfolio_v1";
const MACRO_KEY   = "olympus_macro_v1";
const REGIME_KEY  = "olympus_regime_history_v1";

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
  // Monte Carlo Jump Diffusion (λ Poisson — script TradingView)
  jumpIntensity?: number;
  jumpMean?: number;
  jumpStd?: number;
  // BTC Cycle Analyzer
  puellMultiple?: number;
  hashRibbonState?: string;
  piCycleMa111?: number;
  piCycleMa350x2?: number;
  elliottCurrentWave?: string;
  elliottPivots?: Array<{ price: number; dateStr: string; type: string }>;
  savedAt: string;
}

export interface RegimeHistoryEntry {
  timestamp: string;
  regime: string;
  regimePenalty: number;
  confidence: string;
  vix: number;
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

export function clearAll(): void {
  [STORAGE_KEY, MACRO_KEY, REGIME_KEY].forEach(k => localStorage.removeItem(k));
}