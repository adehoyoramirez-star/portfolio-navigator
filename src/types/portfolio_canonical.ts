import fetch from "node-fetch";

// --- 1. Interfaces ---
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

// --- 2. Generador de historial ---
const generateMockHistory = (basePrice: number): number[] =>
  Array.from({ length: 30 }, (_, index) => {
    const randomShock = (Math.random() - 0.5) * 0.02;
    const trend = index * 0.001;
    return basePrice * (1 + trend + randomShock);
  });

// --- 3. Función para obtener precio real desde Yahoo Finance ---
async function getRealPrice(ticker: string): Promise<number> {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
  const res = await fetch(url);
  const data: any = await res.json();  // <-- aquí decimos TS que ignore el tipo
  const quote = data.quoteResponse?.result?.[0];
  if (!quote) throw new Error(`No se encontró precio para ${ticker}`);
  return quote.regularMarketPrice;
}

// --- 4. Portfolio con precios dinámicos ---
async function buildPortfolio(): Promise<Portfolio> {
  const assetsData: Omit<Asset, "price" | "history">[] = [
    { ticker: "0P00000WLG.F", name: "Vanguard Global Stock", weight: 35.0, currentWeight: 35.0, shares: 0, avgPrice: 0, volatility: 16, expectedReturn: 9, sector: "Equity" },
    { ticker: "BTC-EUR", name: "Bitcoin", weight: 23.9, currentWeight: 9.2, shares: 0.031285, avgPrice: 88010.99, volatility: 60, expectedReturn: 15, sector: "Crypto" },
    { ticker: "VVSM.DE", name: "Semiconductors", weight: 12.5, currentWeight: 9.1, shares: 2, avgPrice: 52.01, volatility: 35, expectedReturn: 14, sector: "Technology" },
    { ticker: "URNU.DE", name: "Uranium", weight: 15.0, currentWeight: 15.5, shares: 13, avgPrice: 26.48, volatility: 40, expectedReturn: 10, sector: "Energy" },
    { ticker: "EMXC.DE", name: "Emerging Markets", weight: 10.0, currentWeight: 10.0, shares: 31, avgPrice: 28.93, volatility: 22, expectedReturn: 8, sector: "Emerging" },
    { ticker: "PPFB.DE", name: "Gold (ETC)", weight: 10.0, currentWeight: 5.0, shares: 4, avgPrice: 69.39, volatility: 30, expectedReturn: 6, sector: "Commodities" }
  ];

  const assets: Asset[] = [];
  for (const t of assetsData) {
    const price = await getRealPrice(t.ticker);
    assets.push({
      ...t,
      price,
      history: generateMockHistory(price)
    });
  }

  return {
    totalValue: 5685,
    cashReserve: 150,
    monthlyInjection: 400,
    targetGoal: 150000,
    regime: "ATTACK",
    riskFreeRate: 4,
    expectedVolatility: 24.2,
    assets
  };
}

// --- 5. Test rápido ---
(async () => {
  try {
    const portfolio = await buildPortfolio();
    const wlg = portfolio.assets.find(a => a.ticker === "0P00000WLG.F");
    console.log("Precio real Vanguard Global Stock (0P00000WLG.F):", wlg?.price);
    console.log("Portfolio completo:", portfolio);
  } catch (e) {
    console.error(e);
  }
})();