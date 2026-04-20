// ============================================================
// src/core/tactical/fundamentalsConfig.ts
// Configuración manual de fundamentales (fallback)
// ============================================================
//
// Usar cuando Yahoo Finance no devuelva datos fundamentales.
// Datos actualizados: 2026-04-20
// Fuentes: justetf.com, seekingalpha.com, tickers & more
// ============================================================

export interface FundamentalData {
  earningsYield: number;  // E/P = 1/PER
  per: number;            // Price/Earnings
  eps: number;            // Earnings per share
  source: string;         // Fuente de los datos
  lastUpdated: string;    // Fecha de actualización
}

// Mapa de fundamentales por ticker
export const FUNDAMENTALS: Record<string, FundamentalData> = {
  // ── Portfolio Olympus ──────────────────────────────────────
  'BTC-EUR': {
    earningsYield: 0,      // Crypto no tiene earnings
    per: 0,
    eps: 0,
    source: 'N/A (Crypto)',
    lastUpdated: '2026-04-20',
  },

  'IS3Q.DE': {  // iShares MSCI World Quality Factor UCITS ETF
    earningsYield: 0.042,  // ~4.2% (PER ~24)
    per: 23.8,
    eps: 4.20,
    source: 'justetf.com + MSCI factsheet',
    lastUpdated: '2026-04-20',
  },

  'VVSM.DE': {  // VanEck Semiconductor UCITS ETF
    earningsYield: 0.035,  // ~3.5% (PER ~28-29)
    per: 28.5,
    eps: 5.80,
    source: 'VanEck factsheet Q1 2026',
    lastUpdated: '2026-04-20',
  },

  'URNU.DE': {  // Global X Uranium UCITS ETF
    earningsYield: 0.028,  // ~2.8% (PER ~35)
    per: 35.7,
    eps: 2.10,
    source: 'Global X factsheet + miners avg',
    lastUpdated: '2026-04-20',
  },

  'EMXC.DE': {  // iShares MSCI EM ex China UCITS ETF
    earningsYield: 0.055,  // ~5.5% (PER ~18)
    per: 18.2,
    eps: 3.85,
    source: 'iShares factsheet + MSCI EM data',
    lastUpdated: '2026-04-20',
  },

  'PPFB.DE': {  // iShares Physical Gold ETC
    earningsYield: 0,      // Gold ETC no tiene earnings
    per: 0,
    eps: 0,
    source: 'N/A (Commodity)',
    lastUpdated: '2026-04-20',
  },

  'XNAS.DE': {  // iShares NASDAQ 100 UCITS ETF
    earningsYield: 0.032,  // ~3.2% (PER ~31)
    per: 31.2,
    eps: 6.40,
    source: 'iShares factsheet + NASDAQ-100 data',
    lastUpdated: '2026-04-20',
  },

  // ── Proxies americanos (usar si no hay datos Yahoo) ────────
  'QQQ': {
    earningsYield: 0.032,  // ~3.2% (PER ~31)
    per: 31.2,
    eps: 6.40,
    source: 'Invesco QQQ factsheet',
    lastUpdated: '2026-04-20',
  },

  'SPY': {
    earningsYield: 0.038,  // ~3.8% (PER ~26)
    per: 26.3,
    eps: 7.60,
    source: 'SPDR factsheet + S&P 500 data',
    lastUpdated: '2026-04-20',
  },

  'SMH': {
    earningsYield: 0.036,  // ~3.6% (PER ~28)
    per: 27.8,
    eps: 8.20,
    source: 'VanEck SMH factsheet',
    lastUpdated: '2026-04-20',
  },

  'URA': {
    earningsYield: 0.029,  // ~2.9% (PER ~34)
    per: 34.5,
    eps: 2.05,
    source: 'Global X URA factsheet',
    lastUpdated: '2026-04-20',
  },

  'GLD': {
    earningsYield: 0,      // Gold ETF no tiene earnings
    per: 0,
    eps: 0,
    source: 'N/A (Commodity)',
    lastUpdated: '2026-04-20',
  },

  'IWM': {
    earningsYield: 0.048,  // ~4.8% (PER ~21)
    per: 20.8,
    eps: 4.80,
    source: 'iShares factsheet + Russell 2000',
    lastUpdated: '2026-04-20',
  },
};

// Helper: obtener fundamentales con fallback a 0
export function getFundamentals(ticker: string): FundamentalData {
  return FUNDAMENTALS[ticker] ?? {
    earningsYield: 0,
    per: 0,
    eps: 0,
    source: 'Default (sin datos)',
    lastUpdated: new Date().toISOString().split('T')[0],
  };
}

// Helper: verificar si hay datos manuales disponibles
export function hasManualFundamentals(ticker: string): boolean {
  return ticker in FUNDAMENTALS;
}

// Helper: obtener todos los tickers con datos manuales
export function getManualTickers(): string[] {
  return Object.keys(FUNDAMENTALS);
}
