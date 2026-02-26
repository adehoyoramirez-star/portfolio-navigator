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
// Usamos '_' para indicar a TypeScript que el primer parámetro se ignora 
// y usamos 'index' para crear una tendencia ligera y que no dé error.
const generateMockHistory = (basePrice: number): number[] => 
  Array.from({ length: 30 }, (_, index) => {
    const randomShock = (Math.random() - 0.5) * 0.02;
    const trend = index * 0.001; // Usamos el índice para dar una ligera tendencia alcista
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
      shares: 0.031285,
      avgPrice: 88010.99,
      price: 55134.37,
      volatility: 60,
      expectedReturn: 45,
      sector: "Crypto",
      zScore: -2.08,
      rsi: 40.51,
      history: generateMockHistory(55134) // <--- FUNCIÓN LLAMADA
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
      expectedReturn: 18,
      sector: "Technology",
      history: generateMockHistory(62.60) // <--- FUNCIÓN LLAMADA
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
      expectedReturn: 12,
      sector: "Equity",
      history: generateMockHistory(70.62)
    },
    {
      ticker: "U3O8.DE",
      name: "Uranium",
      weight: 15.0,
      currentWeight: 15.5,
      shares: 13,
      avgPrice: 26.48,
      price: 28.15,
      volatility: 40,
      expectedReturn: 25,
      sector: "Energy",
      history: generateMockHistory(28.15)
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
      expectedReturn: 10,
      sector: "Emerging",
      history: generateMockHistory(35.56)
    },
    {
      ticker: "PPFB.DE",
      name: "Gold Mining",
      weight: 10.0,
      currentWeight: 5.0,
      shares: 4,
      avgPrice: 69.39,
      price: 72.10,
      volatility: 30,
      expectedReturn: 15,
      sector: "Commodities",
      history: generateMockHistory(72.10)
    },
    {
      ticker: "ZPRR.DE",
      name: "Small Cap US",
      weight: 8.6,
      currentWeight: 10.6,
      shares: 6,
      avgPrice: 61.67,
      price: 65.40,
      volatility: 25,
      expectedReturn: 11,
      sector: "Real Estate",
      history: generateMockHistory(65.40)
    }
  ]
};