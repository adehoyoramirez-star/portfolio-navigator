// 1. DEFINICIÓN DE INTERFACES
export interface Asset {
  ticker: string;
  name: string;
  weight: number;           // peso objetivo (%)
  currentWeight: number;    // peso actual (calculado, no editable)
  price: number;            // precio actual (de mercado, no editable)
  shares: number;           // participaciones (editable)
  avgPrice: number;         // precio medio de compra (editable)
  volatility: number;       // volatilidad anualizada fija (%) - se puede calcular después
  expectedReturn: number;   // rentabilidad esperada (no usado actualmente)
  sector: string;
  history: number[];        // historial de precios (para calcular returns)
  zScore?: number;
  rsi?: number;
  // Nuevos campos editables para returns (en tanto por uno, ej. 0.15 = 15%)
  return12m?: number;       // rentabilidad últimos 12 meses
  return3m?: number;        // rentabilidad últimos 3 meses
  return1m?: number;        // rentabilidad último mes
  earningsYield?: number;   // earnings yield (BPA/Price)
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

// 2. GENERADOR DE HISTORIAL (252 días ≈ 1 año) - sigue siendo mock
const generateMockHistory = (basePrice: number): number[] => 
  Array.from({ length: 252 }, (_, index) => {
    const randomShock = (Math.random() - 0.5) * 0.02;
    const trend = index * 0.001;
    return basePrice * (1 + trend + randomShock);
  });

// Función auxiliar para calcular returns a partir del historial
const calculateReturn = (history: number[], months: number): number => {
  const daysPerMonth = 22;
  const periods = months * daysPerMonth;
  if (history.length < periods + 1) return 0.01;
  const current = history[history.length - 1];
  const past = history[history.length - 1 - periods];
  return (current - past) / past;
};

// 3. PORTFOLIO COMPLETO CON RETORNOS INICIALES CALCULADOS
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
      avgPrice: 58520.45,
      price: 55134.37,
      volatility: 60,
      expectedReturn: 45,
      sector: "Crypto",
      zScore: -2.08,
      rsi: 40.51,
      history: generateMockHistory(55134),
      return12m: calculateReturn(generateMockHistory(55134), 12),
      return3m: calculateReturn(generateMockHistory(55134), 3),
      return1m: calculateReturn(generateMockHistory(55134), 1),
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
      expectedReturn: 18,
      sector: "Technology",
      history: generateMockHistory(62.60),
      return12m: calculateReturn(generateMockHistory(62.60), 12),
      return3m: calculateReturn(generateMockHistory(62.60), 3),
      return1m: calculateReturn(generateMockHistory(62.60), 1),
      earningsYield: 0.05, // valor de ejemplo (5%)
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
      history: generateMockHistory(70.62),
      return12m: calculateReturn(generateMockHistory(70.62), 12),
      return3m: calculateReturn(generateMockHistory(70.62), 3),
      return1m: calculateReturn(generateMockHistory(70.62), 1),
      earningsYield: 0.04,
    },
    {
      ticker: "URNU.DE",
      name: "Uranium",
      weight: 15.0,
      currentWeight: 15.5,
      shares: 13,
      avgPrice: 26.48,
      price: 28.15,
      volatility: 40,
      expectedReturn: 25,
      sector: "Energy",
      history: generateMockHistory(28.15),
      return12m: calculateReturn(generateMockHistory(28.15), 12),
      return3m: calculateReturn(generateMockHistory(28.15), 3),
      return1m: calculateReturn(generateMockHistory(28.15), 1),
      earningsYield: 0.06,
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
      history: generateMockHistory(35.56),
      return12m: calculateReturn(generateMockHistory(35.56), 12),
      return3m: calculateReturn(generateMockHistory(35.56), 3),
      return1m: calculateReturn(generateMockHistory(35.56), 1),
      earningsYield: 0.05,
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
      history: generateMockHistory(72.10),
      return12m: calculateReturn(generateMockHistory(72.10), 12),
      return3m: calculateReturn(generateMockHistory(72.10), 3),
      return1m: calculateReturn(generateMockHistory(72.10), 1),
      earningsYield: 0.03,
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
      history: generateMockHistory(65.40),
      return12m: calculateReturn(generateMockHistory(65.40), 12),
      return3m: calculateReturn(generateMockHistory(65.40), 3),
      return1m: calculateReturn(generateMockHistory(65.40), 1),
      earningsYield: 0.04,
    }
  ]
};