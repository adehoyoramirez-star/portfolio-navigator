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
// AUDIT-FIX-01: expectedReturn corregidos con priors de largo plazo (Damodaran 2024 / Vanguard CMA 2024)
// Los valores anteriores (BTC=45%, Semis=18%, etc.) eran retornos históricos del bull run 2022-2024,
// NO retornos esperados prospectivos. Usarlos en Monte Carlo producía medianas de €443k absurdas.
//
// Priors calibrados (consenso académico — % anual en términos reales ajustados):
//   BTC:   15% — prima cripto ajustada ciclo (no 45% del bull run, ciclo largo ~4 años)
//   Semis: 14% — semiconductores: ciclo AI legítimo pero valoración ya alta (P/E ~30x)
//   MSCI Momentum: 11% — prima momentum documentada ~3% sobre mercado global
//   Uranio: 10% — demanda nuclear estructural, pero ilíquido y volátil
//   EM ex-China: 8% — prima EM ~3% sobre DM, ajustado riesgo divisa y geopolítico
//   Gold: 6% — retorno real histórico ~2-4% + inflación esperada ~2-3%
//   REITs: 9% — equity-like + renta, ajustado entorno tipos altos 2024-2025
//
// IMPORTANTE: estos valores son el FALLBACK cuando no hay datos Yahoo disponibles.
// Con datos Yahoo activos, el motor usa James-Stein shrinkage (marketData.ts) que
// combina 35% retorno histórico real + 65% prior de largo plazo. Estos priors son idénticos.
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
      expectedReturn: 15,   // AUDIT-FIX: era 45% (bull run) → 15% (prior LP Damodaran)
      sector: "Crypto",
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
      expectedReturn: 14,   // AUDIT-FIX: era 18% → 14% (ciclo AI legítimo, val ya alta)
      sector: "Technology",
      history: generateMockHistory(62.60)
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
      expectedReturn: 11,   // AUDIT-FIX: era 12% → 11% (prima momentum ~3% sobre mercado)
      sector: "Equity",
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
      expectedReturn: 10,   // AUDIT-FIX: era 25% → 10% (demanda nuclear real pero ilíquido)
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
      expectedReturn: 8,    // AUDIT-FIX: era 10% → 8% (prima EM ajustada riesgo divisa DXY alto)
      sector: "Emerging",
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
      volatility: 30,
      expectedReturn: 6,    // AUDIT-FIX: era 15% → 6% (retorno real histórico oro ~2-4%)
      sector: "Commodities",
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
      expectedReturn: 9,    // AUDIT-FIX: era 11% → 9% (ajustado tipos altos 2024-2025)
      sector: "Real Estate",
      history: generateMockHistory(65.40)
    }
  ]
};