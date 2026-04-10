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
  history: number[]; // El historial que ahora sí vamos a usar
  zScore?: number;
  rsi?: number;
  factorRole?: 'momentum' | 'value' | 'lowVol' | 'quality' | 'defensive';
  // NUEVAS PROPIEDADES para el motor y el dashboard
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

// 2. GENERADOR DE HISTORIAL CORREGIDO
const generateMockHistory = (basePrice: number): number[] => 
  Array.from({ length: 30 }, (_, index) => {
    const randomShock = (Math.random() - 0.5) * 0.02;
    const trend = index * 0.001;
    return basePrice * (1 + trend + randomShock);
  });

// 3. PORTFOLIO COMPLETO CON CONEXIÓN DE DATOS
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
      zScore: -2.08,
      rsi: 40.51,
      history: generateMockHistory(55134),
      factorRole: 'defensive',
      return12m: 0.45,    // ejemplo, se actualizará con datos reales
      return3m: 0.12,
      return1m: 0.03,
      earningsYield: 0,
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
      history: generateMockHistory(62.60),
      factorRole: 'momentum',
      return12m: 0.22,
      return3m: 0.08,
      return1m: 0.02,
      earningsYield: 0.03,
    },
    {
      ticker: "IS3Q.DE",
      name: "MSCI World Momentum",
      weight: 20.0,
      currentWeight: 26.6,
      shares: 26,
      avgPrice: 67.53,
      price: 70.62,
      volatility: 18,
      expectedReturn: 11,
      sector: "Equity",
      history: generateMockHistory(70.62),
      factorRole: 'momentum',
      return12m: 0.18,
      return3m: 0.05,
      return1m: 0.01,
      earningsYield: 0.04,
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
      history: generateMockHistory(28.15),
      factorRole: 'value',
      return12m: 0.30,
      return3m: 0.10,
      return1m: 0.04,
      earningsYield: 0,
    },
    {
      ticker: "EMXC.DE",
      name: "Emerging Markets",
      weight: 10.0,
      currentWeight: 10.0,
      shares: 31,
      avgPrice: 28.93,
      price: 35.56,
      volatility: 22,
      expectedReturn: 8,
      sector: "Emerging",
      history: generateMockHistory(35.56),
      factorRole: 'value',
      return12m: 0.12,
      return3m: 0.04,
      return1m: 0.00,
      earningsYield: 0.05,
    },
    {
      ticker: "PPFB.DE",
      name: "Gold (ETC)",
      weight: 10.0,
      currentWeight: 5.0,
      shares: 4,
      avgPrice: 69.39,
      price: 72.10,
      volatility: 30,
      expectedReturn: 6,
      sector: "Commodities",
      history: generateMockHistory(72.10),
      factorRole: 'defensive',
      return12m: 0.08,
      return3m: 0.02,
      return1m: 0.01,
      earningsYield: 0,
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
      sector: "Real Estate",
      history: generateMockHistory(65.40),
      factorRole: 'quality',
      return12m: 0.15,
      return3m: 0.06,
      return1m: 0.02,
      earningsYield: 0.02,
    }
  ]
};