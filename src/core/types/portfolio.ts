// ===============================================
// ARCHIVO: src/core/types/portfolio.ts
// FIX-ASSET-INTERFACE: añadidos earningsYield, return12m, return3m, return1m
//   que el dashboard usa pero que NO estaban declarados en la interfaz Asset,
//   causando que TypeScript los tratara como 'any' silenciosamente.
// ===============================================

// 1. DEFINICIÓN DE INTERFACES
export interface Asset {
  ticker: string;
  name: string;
  weight: number;
  currentWeight: number;
  price: number;
  shares: number;
  avgPrice: number;
  volatility: number;
  expectedReturn: number;
  sector: string;
  history: number[];
  zScore?: number;
  rsi?: number;
  factorRole?: 'momentum' | 'value' | 'lowVol' | 'quality' | 'defensive';
  // FIX-ASSET-INTERFACE: estos campos son usados en el dashboard pero faltaban en el tipo
  earningsYield?: number;   // Earnings Yield anualizado (0.05 = 5%) — para el factor Value
  return12m?: number;       // Retorno 12 meses (decimal, ej: 0.12 = 12%)
  return3m?: number;        // Retorno 3 meses
  return1m?: number;        // Retorno 1 mes
}

export interface Portfolio {
  totalValue: number;
  cashReserve: number;
  monthlyInjection: number;
  targetGoal: number;
  regime: "ATTACK" | "NEUTRAL" | "RISK_OFF";
  riskFreeRate: number;
  expectedVolatility: number;
  assets: Asset[];
}

// 2. GENERADOR DE HISTORIAL CORREGIDO
const generateMockHistory = (basePrice: number): number[] =>
  Array.from({ length: 30 }, (_, index) => {
    const randomShock = (Math.random() - 0.5) * 0.02;
    const trend = index * 0.001;
    return basePrice * (1 + trend + randomShock);
  });

// 3. PORTFOLIO COMPLETO
// NOTA CRÍTICA — PRECIOS FALLBACK:
//   Los precios aquí son el FALLBACK estático que se usa SOLO cuando
//   fetchRealMarketData() falla o antes de que termine la primera carga.
//   En producción normal, el dashboard sobreescribe price con md.prices[ticker].
//
//   CAUSA DEL BUG "precios no actualizan":
//   El bug NO estaba aquí — estaba en dos sitios simultáneos:
//      → marketData.ts solo itera ASSETS para construir prices{}
//      → el fallback `asset.price` (este archivo) se usaba siempre
//   Ambos archivos están corregidos en este mismo commit.
//
// AUDIT-FIX-01: expectedReturn corregidos con priors de largo plazo (Damodaran 2024)
export const portfolio: Portfolio = {
  totalValue: 5685,
  cashReserve: 2982.00,
  monthlyInjection: 500.0,
  targetGoal: 150000,
  regime: "ATTACK",
  riskFreeRate: 4.0,
  expectedVolatility: 24.2,

  assets: [
    {
      ticker: "BTC-EUR",
      name: "Bitcoin",
      weight: 23.9,
      currentWeight: 9.2,
      shares: 0.031285,
      avgPrice: 87897.74,
      price: 85000,           // fallback — se sobreescribe con precio real Yahoo
      volatility: 60,
      expectedReturn: 15,
      sector: "Crypto",
      zScore: 0,
      rsi: 50,
      earningsYield: 0,
      return12m: 0,
      return3m: 0,
      return1m: 0,
      history: generateMockHistory(85000),
      factorRole: 'defensive'
    },
    {
      ticker: "VVSM.DE",
      name: "Semiconductors",
      weight: 12.5,
      currentWeight: 9.1,
      shares: 1,
      avgPrice: 57.49,
      price: 55.0,
      volatility: 35,
      expectedReturn: 14,
      sector: "Technology",
      earningsYield: 0.03,
      return12m: 0,
      return3m: 0,
      return1m: 0,
      history: generateMockHistory(55.0),
      factorRole: 'momentum'
    },
    {
      // FIX-MD-4: 0P00000WLG.F = Vanguard Global Stock Index (ISIN IE00B03HD191).
      // Cubre MSCI World (developed markets). Heredó el nombre "MSCI World Quality"
      // del fondo IS3Q.DE eliminado. El tilt quality real lo aplica el motor
      // internamente vía factor score, no el ETF en sí.
      ticker: "0P00000WLG.F",
      name: "Vanguard Global Stock Index",
      weight: 20.0,
      currentWeight: 26.6,
      shares: 19.23,
      avgPrice: 61.52,
      price: 70.0,
      volatility: 18,
      expectedReturn: 11,
      sector: "Equity",
      earningsYield: 0.04,
      return12m: 0,
      return3m: 0,
      return1m: 0,
      history: generateMockHistory(70.0),
      factorRole: 'quality'
    },
    {
      ticker: "URNU.DE",
      name: "Uranium",
      weight: 15.0,
      currentWeight: 15.5,
      shares: 74,
      avgPrice: 24.94,
      price: 27.0,
      volatility: 40,
      expectedReturn: 10,
      sector: "Energy",
      earningsYield: 0.02,
      return12m: 0,
      return3m: 0,
      return1m: 0,
      history: generateMockHistory(27.0),
      factorRole: 'value'
    },
    {
      ticker: "EMXC.DE",
      name: "Emerging Markets",
      weight: 10.0,
      currentWeight: 10.0,
      shares: 3,
      avgPrice: 29.30,
      price: 29.5,
      volatility: 22,
      expectedReturn: 8,
      sector: "Emerging",
      earningsYield: 0.05,
      return12m: 0,
      return3m: 0,
      return1m: 0,
      history: generateMockHistory(29.5),
      factorRole: 'value'
    },
    {
      ticker: "PPFB.DE",
      name: "Gold (ETC)",
      weight: 10.0,
      currentWeight: 5.0,
      shares: 32,
      avgPrice: 69.66,
      price: 72.0,
      volatility: 15,
      expectedReturn: 6,
      sector: "Commodities",
      earningsYield: 0,
      return12m: 0,
      return3m: 0,
      return1m: 0,
      history: generateMockHistory(72.0),
      factorRole: 'defensive'
    },
    // ─── FIX-AUDIT-DUPLICATE: entrada "NASDAQ 100" ELIMINADA ──────────
    // Esta entrada era un fantasma de XNAS.DE (NASDAQ 100), que fue eliminado
    // del portfolio por redundante con 0P00000WLG.F (MSCI World). Tenía el ticker
    // cambiado incorrectamente a VVSM.DE, causando que VVSM apareciera DUPLICADO
    // en DCA, rebalanceo, gráficos, y distorsionando totalPortfolioValue,
    // corrMatrix (7×7 en vez de 6×6), volatilidad y drawdown.
    // ────────────────────────────────────────────────────────────────────
  ]
};
