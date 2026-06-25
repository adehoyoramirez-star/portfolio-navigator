// ===============================================
// ARCHIVO: src/lib/constants.ts
// PORTFOLIO 6 ACTIVOS: elimina redundancia IS3Q (⊂ WLG) y XNAS (⊂ WLG)
// FIX-PPFB-SECTOR: PPFB.DE es ETC de oro → Commodities
// ===============================================

export const ASSETS = [
  "BTC-EUR",
  "EMXC.DE",
  "PPFB.DE",
  "URNU.DE",
  "VVSM.DE",
  "0P00000WLG.F",
] as const;

export type Asset = typeof ASSETS[number];


// ── FIX-AUDIT-R3 R3-03: centralize risk-free rate. Antes hardcoded 0.04 en 4 archivos
// distintos (liveMonitor, backtestEngine x3, benchmarkRunner). Si el BCE/BoE/Fed
// mueven el tipo rector, una única edición cambia la baseline en todo el sistema.
// Antes del 2022 era ~0%, en JUN-2025 está en ~4.25%, expectativa para QT-end ~3.5-3.75%.
export const RISK_FREE_RATE_ANNUAL = 0.04; // = BTP 10y expected/var proxy
export const RISK_FREE_RATE_DAILY = RISK_FREE_RATE_ANNUAL / 252;
const TRADING_DAYS_PER_YEAR = 252;
export { TRADING_DAYS_PER_YEAR };
export const SECTOR_MAP: Record<Asset, string> = {
  "BTC-EUR":  "crypto",
  "EMXC.DE":  "emerging",
  "PPFB.DE":  "gold",
  "URNU.DE":  "uranium",
  "VVSM.DE":  "semis",
  // 0P00000WLG.F = Vanguard Global Stock Index Fund EUR Acc (ISIN: IE00B03HD191)
  // → MSCI World Index (developed markets equity), UCITS mutual fund — núcleo global
  "0P00000WLG.F": "equity",
};

// Cap máximo por sector — si VVSM (semis) + WLG (equity) superan 50%, el motor limita.
export const SECTOR_CAP = 0.50;
export const TARGET_GOAL = 150000;
export const DEFAULT_MONTHLY = 400;
export const STRUCTURAL_RESERVE_PCT = 0.04;  // FIX-CASH-LEAN: reducido de 8%→4% — menos cash inmovilizado

// Pesos objetivo a largo plazo// por litigios glifosato. Upside asymétrico si se resuelve el riesgo legal.
export const DEFAULT_POSITIONS = {
  "BTC-EUR":  { shares: 0.031285, avgPrice: 88010.99 },
  "EMXC.DE":  { shares: 31,       avgPrice: 28.93 },
  "PPFB.DE":  { shares: 4,        avgPrice: 69.39 },
  "URNU.DE":  { shares: 13,       avgPrice: 26.48 },
  "VVSM.DE":  { shares: 2,        avgPrice: 52.01 },
  "0P00000WLG.F": { shares: 0,    avgPrice: 0 },
};

// ─── NOTA: IS3Q y XNAS ELIMINADOS — redundantes con 0P00000WLG.F ──────────
// IS3Q.DE (MSCI World Quality) y XNAS.DE (NASDAQ 100) son subconjuntos
// del MSCI World que ya cubre 0P00000WLG.F. El motor aplica scoring de
// factores internamente (quality, momentum, value) sin necesidad de ETFs
// dedicados. VVSM.DE mantiene la exposición a semiconductores como tilt
// de convicción (AI).
// ──────────────────────────────────────────────────────────────────────────

// ── FIX-AUDIT-R3 R3-02 v3: factor-proxy tickers + min points hoisted from dashboard.
// Si universo cambia (REFACTOR add/remove), editar SOLO estas dos constantes.
export const KALMAN_FACTOR_PROXY_TICKERS = [
  "0P00000WLG.F", "VVSM.DE", "URNU.DE", "EMXC.DE", "PPFB.DE",
] as const;
export const KALMAN_FACTOR_MIN_POINTS = 22;
