// ===============================================
// ARCHIVO: src/core/types/portfolio.ts
// FIX-IS3Q-01: IS3Q.DE es MSCI World QUALITY (no Momentum)
//   ISIN: IE00BP3QZ601 — iShares MSCI World Quality Factor UCITS ETF
//   El factor Quality selecciona por ROE alto, deuda baja, beneficios estables.
//   No confundir con IS3R.DE (MSCI World Momentum Factor, ISIN IE00BP3QZ825).
//
// FIX-SECTOR-XNAS: XNAS.DE es NASDAQ 100 → sector Technology (no Real Estate)
//   Un error de sector afecta al risk budget sectorial y diversificación.
//
// PORTFOLIO RENDIMIENTO:
//   Retorno esperado ponderado actual: ~10.4%
//   Para llegar a 15%: BTC debe subir a 30-35% en ventanas de ciclo favorable.
//   El motor gestiona esta subida automáticamente via smartDCA Attack Mode.
// ===============================================

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
  // FIX-IS3Q-01: campo para el rol de factor — usado por factor scoring
  // "quality" | "momentum" | "value" | "lowVol" | "crypto" | "commodity" | "other"
  factorRole?: string;
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

const generateMockHistory = (basePrice: number): number[] =>
  Array.from({ length: 30 }, (_, index) => {
    const randomShock = (Math.random() - 0.5) * 0.02;
    const trend = index * 0.001;
    return basePrice * (1 + trend + randomShock);
  });

// ===============================================
// PORTFOLIO INICIAL — VALORES DE FALLBACK
// Se sobrescriben en tiempo real con datos de Yahoo Finance.
// Priors calibrados Damodaran 2024 / Vanguard CMA 2024.
// ===============================================
export const portfolio: Portfolio = {
  totalValue: 5685,
  cashReserve: 150.00,
  monthlyInjection: 400.0,
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
      shares: 0.033994,
      avgPrice: 85386.00,
      price: 55134.37,
      volatility: 60,
      expectedReturn: 15,
      sector: "Crypto",
      factorRole: "crypto",
      zScore: -2.08,
      rsi: 40.51,
      history: generateMockHistory(55134)
    },
    {
      ticker: "VVSM.DE",
      name: "Semiconductors",
      weight: 12.5,
      currentWeight: 9.1,
      shares: 2,
      avgPrice: 52.01,
      price: 62.60,
      volatility: 35,
      expectedReturn: 14,
      sector: "Technology",
      factorRole: "momentum",
      history: generateMockHistory(62.60)
    },
    {
      ticker: "IS3Q.DE",
      // FIX-IS3Q-01: era "MSCI World Momentum" — INCORRECTO
      // IS3Q.DE = iShares MSCI World Quality Factor UCITS ETF (ISIN: IE00BP3QZ601)
      // Selecciona por ROE alto, deuda/equity baja, variabilidad de beneficios baja.
      // Comportamiento: defensivo en crisis, estable en contraction, buen compounder largo plazo.
      // NO es momentum puro — en correcciones cae menos que el mercado general.
      name: "MSCI World Quality",
      weight: 20.0,
      currentWeight: 26.6,
      shares: 26,
      avgPrice: 67.53,
      price: 70.62,
      volatility: 15,       // FIX: vol real del Quality factor ~15% (era 18% del Momentum)
      expectedReturn: 11,
      sector: "Equity",
      factorRole: "quality",  // FIX: era implícitamente "momentum"
      history: generateMockHistory(70.62)
    },
    {
      ticker: "URNU.DE",
      name: "Uranium",
      weight: 15.0,
      currentWeight: 15.5,
      shares: 15,
      avgPrice: 26.53,
      price: 28.15,
      volatility: 40,
      expectedReturn: 10,
      sector: "Energy",
      factorRole: "value",
      history: generateMockHistory(28.15)
    },
    {
      ticker: "EMXC.DE",
      name: "Emerging Markets ex-China",
      weight: 10.0,
      currentWeight: 10.0,
      shares: 31,
      avgPrice: 28.93,
      price: 35.56,
      volatility: 22,
      expectedReturn: 8,
      sector: "Emerging",
      factorRole: "value",
      history: generateMockHistory(35.56)
    },
    {
      ticker: "PPFB.DE",
      name: "Gold (ETC)",
      weight: 10.0,
      currentWeight: 5.0,
      shares: 4,
      avgPrice: 69.39,
      price: 72.10,
      volatility: 14,       // FIX: vol realizada del oro ~14% (era 30% — incorrecto)
      expectedReturn: 6,
      sector: "Commodities",
      factorRole: "commodity",
      history: generateMockHistory(72.10)
    },
    {
      ticker: "XNAS.DE",
      name: "NASDAQ 100",
      weight: 8.6,
      currentWeight: 10.6,
      shares: 0,
      avgPrice: 0,
      price: 65.40,
      volatility: 25,
      expectedReturn: 9,
      // FIX-SECTOR-XNAS: era "Real Estate" — INCORRECTO
      // XNAS.DE = iShares NASDAQ 100 UCITS ETF → sector Technology
      // El error de sector afectaba al SECTOR_CAP (35%) calculando mal la concentración en tech.
      sector: "Technology",
      factorRole: "momentum",
      history: generateMockHistory(65.40)
    }
  ]
};
