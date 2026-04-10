// src/core/types/portfolio.ts
export interface Asset {
  ticker: string;
  name: string;
  weight: number;           // peso objetivo (nuevo)
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
  return12m?: number;
  return3m?: number;
  return1m?: number;
  earningsYield?: number;
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

// Generador de historial (mock)
const generateMockHistory = (basePrice: number): number[] => 
  Array.from({ length: 30 }, (_, idx) => basePrice * (1 + idx * 0.001 + (Math.random() - 0.5) * 0.02));

export const portfolio: Portfolio = {
  totalValue: 6186.88,   // actualizado según tu PDF
  cashReserve: 300.00,
  monthlyInjection: 400.0,
  targetGoal: 150000,
  regime: "NEUTRAL",
  riskFreeRate: 4.0,
  expectedVolatility: 18.0,  // objetivo de volatilidad

  assets: [
    {
      ticker: "IS3Q.DE",
      name: "MSCI World Quality",
      weight: 25.0,
      currentWeight: 29.3,
      shares: 26,
      avgPrice: 67.53,
      price: 69.67,
      volatility: 18,
      expectedReturn: 11,
      sector: "Equity",
      history: generateMockHistory(69.67),
      factorRole: 'quality',
      return12m: 0.2089,
      return3m: 0.00086,
      return1m: 0.0078,
      earningsYield: 0.04,
    },
    {
      ticker: "BTC-EUR",
      name: "Bitcoin",
      weight: 15.0,
      currentWeight: 31.2,
      shares: 0.031286,
      avgPrice: 87989.74,
      price: 61605.14,
      volatility: 60,
      expectedReturn: 15,
      sector: "Crypto",
      history: generateMockHistory(61605),
      factorRole: 'momentum',
      zScore: -0.97,
      rsi: 40,
      return12m: -0.3697,
      return3m: 0.3184,
      return1m: 0.1082,
      earningsYield: 0,
    },
    {
      ticker: "PPFB.DE",
      name: "Gold (ETC)",
      weight: 15.0,
      currentWeight: 6.4,
      shares: 5,
      avgPrice: 71.08,
      price: 79.48,
      volatility: 30,
      expectedReturn: 6,
      sector: "Commodities",
      history: generateMockHistory(79.48),
      factorRole: 'defensive',
      return12m: 0.4842,
      return3m: 0.0701,
      return1m: -0.0696,
      earningsYield: 0,
    },
    {
      ticker: "XNAS.DE",
      name: "NASDAQ 100",
      weight: 15.0,
      currentWeight: 0.0,
      shares: 0,
      avgPrice: 0,
      price: 49.43,
      volatility: 25,
      expectedReturn: 9,
      sector: "Growth",
      history: generateMockHistory(49.43),
      factorRole: 'momentum',
      return12m: 0.3027,
      return3m: -0.0221,
      return1m: 0.00233,
      earningsYield: 0.02,
    },
    {
      ticker: "URNU.DE",
      name: "Uranium",
      weight: 10.0,
      currentWeight: 10.7,
      shares: 25,
      avgPrice: 25.89,
      price: 26.50,
      volatility: 40,
      expectedReturn: 10,
      sector: "Energy",
      history: generateMockHistory(26.50),
      factorRole: 'value',
      return12m: 0.0,
      return3m: 0.01416,
      return1m: 0.01767,
      earningsYield: 0,
    },
    {
      ticker: "EMXC.DE",
      name: "Emerging Markets ex China",
      weight: 10.0,
      currentWeight: 17.2,
      shares: 31,
      avgPrice: 28.93,
      price: 34.36,
      volatility: 22,
      expectedReturn: 8,
      sector: "Emerging",
      history: generateMockHistory(34.36),
      factorRole: 'value',
      return12m: 0.5676,
      return3m: 0.1073,
      return1m: 0.04805,
      earningsYield: 0.05,
    },
    {
      ticker: "VVSM.DE",
      name: "Semiconductors",
      weight: 10.0,
      currentWeight: 5.2,
      shares: 5,
      avgPrice: 55.38,
      price: 64.66,
      volatility: 35,
      expectedReturn: 14,
      sector: "Technology",
      history: generateMockHistory(64.66),
      factorRole: 'momentum',
      return12m: 1.1539,
      return3m: 0.1594,
      return1m: 0.1066,
      earningsYield: 0.03,
    },
  ],
};