// ─── Types ───────────────────────────────────────────────────────────────────

export interface Asset {
  name: string;
  ticker: string;
  sector: string;
}

export interface Position {
  shares: number;
  avgPrice: number;
}

export interface MarketRegime {
  name: 'RISK ON' | 'RISK OFF' | 'NEUTRAL' | 'ATTACK MODE';
  targetVol: number;
  color: string;
}

export interface MarketData {
  prices: Record<string, number>;
  vix: number;
  tnx: number;
  irx: number;
  btcZScore: number;
  vixPercentile80: number;
  vixPercentile20: number;
  expectedReturns: number[];
  covMatrix: number[][];
}

export interface Order {
  ticker: string;
  name: string;
  shares: number;
  price: number;
  cost: number;
}

export interface PortfolioResults {
  marketData: MarketData;
  regime: MarketRegime;
  weights: number[];
  portfolioReturn: number;
  portfolioVol: number;
  mcResults: number[];
  probability: number;
  riskContribution: number[];
  orders: Order[];
  totalValue: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const ASSETS: Asset[] = [
  { name: 'Bitcoin', ticker: 'BTC-EUR', sector: 'crypto' },
  { name: 'Emerg. ex China', ticker: 'EMXC.DE', sector: 'emerging' },
  { name: 'Asia Emergente', ticker: 'IS3Q.DE', sector: 'emerging' },
  { name: 'Oro Físico', ticker: 'PPFB.DE', sector: 'gold' },
  { name: 'Uranio', ticker: 'URNU.DE', sector: 'uranium' },
  { name: 'Semiconductores', ticker: 'VVSM.DE', sector: 'semis' },
  { name: 'Inmob. Europeo', ticker: 'ZPRR.DE', sector: 'real_estate' },
];

export const TARGET_AMOUNT = 150_000;
export const SIMULATION_YEARS = 10;
export const NUM_SIMULATIONS = 500;

export const CHART_COLORS = [
  'hsl(149, 100%, 39%)',
  'hsl(210, 80%, 55%)',
  'hsl(280, 70%, 55%)',
  'hsl(45, 100%, 50%)',
  'hsl(15, 90%, 55%)',
  'hsl(190, 80%, 50%)',
  'hsl(340, 70%, 55%)',
];

export const DEFAULT_POSITIONS: Record<string, Position> = {
  'BTC-EUR': { shares: 0.031285, avgPrice: 88010.99 },
  'EMXC.DE': { shares: 31, avgPrice: 28.93 },
  'IS3Q.DE': { shares: 26, avgPrice: 67.53 },
  'PPFB.DE': { shares: 4, avgPrice: 69.39 },
  'URNU.DE': { shares: 13, avgPrice: 26.48 },
  'VVSM.DE': { shares: 2, avgPrice: 52.01 },
  'ZPRR.DE': { shares: 6, avgPrice: 61.67 },
};

// ─── Market Regime ───────────────────────────────────────────────────────────

export function calculateRegime(data: MarketData): MarketRegime {
  if (data.btcZScore < -2) {
    return { name: 'ATTACK MODE', targetVol: 0.22, color: 'hsl(280, 70%, 55%)' };
  }
  if (data.vix > data.vixPercentile80) {
    return { name: 'RISK OFF', targetVol: 0.10, color: 'hsl(0, 65%, 51%)' };
  }
  if (data.vix < data.vixPercentile20) {
    return { name: 'RISK ON', targetVol: 0.18, color: 'hsl(149, 100%, 39%)' };
  }
  return { name: 'NEUTRAL', targetVol: 0.14, color: 'hsl(45, 100%, 50%)' };
}

// ─── Portfolio Optimization (Random Sampling) ────────────────────────────────

function portfolioVariance(w: number[], cov: number[][]): number {
  let v = 0;
  for (let i = 0; i < w.length; i++) {
    for (let j = 0; j < w.length; j++) {
      v += w[i] * w[j] * cov[i][j];
    }
  }
  return v;
}

function portfolioReturnCalc(w: number[], r: number[]): number {
  return w.reduce((s, wi, i) => s + wi * r[i], 0);
}

export function optimizePortfolio(
  data: MarketData,
  targetVol: number,
  btcMin: number,
  btcMax: number
): { weights: number[]; ret: number; vol: number } {
  const n = ASSETS.length;
  const cov = data.covMatrix;
  const ret = data.expectedReturns;
  let bestWeights = new Array(n).fill(1 / n);
  let bestSharpe = -Infinity;

  for (let iter = 0; iter < 15000; iter++) {
    const btcW = btcMin + Math.random() * (btcMax - btcMin);
    const remaining = 1 - btcW;
    const raw = Array.from({ length: n - 1 }, () => Math.random());
    const sum = raw.reduce((a, b) => a + b, 0);
    const others = raw.map(r => (r / sum) * remaining);
    const w = [btcW, ...others];

    let valid = true;
    for (let i = 0; i < n; i++) {
      if (w[i] < 0.02 || w[i] > 0.40) { valid = false; break; }
    }
    if (!valid) continue;

    // Sector constraint: emerging (1+2) max 35%
    if (w[1] + w[2] > 0.35) continue;

    const pVol = Math.sqrt(portfolioVariance(w, cov));
    if (pVol > targetVol) continue;

    const pRet = portfolioReturnCalc(w, ret);
    const sharpe = pRet / pVol;
    if (sharpe > bestSharpe) {
      bestSharpe = sharpe;
      bestWeights = [...w];
    }
  }

  const vol = Math.sqrt(portfolioVariance(bestWeights, cov));
  const r = portfolioReturnCalc(bestWeights, ret);
  return { weights: bestWeights, ret: r, vol };
}

// ─── Monte Carlo Simulation ─────────────────────────────────────────────────

function normalRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function runMonteCarlo(
  annualReturn: number,
  annualVol: number,
  monthlyContribution: number,
  currentValue: number
): number[] {
  const monthlyReturn = annualReturn / 12;
  const monthlyVol = annualVol / Math.sqrt(12);
  const months = SIMULATION_YEARS * 12;
  const results: number[] = [];

  for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
    let value = currentValue;
    for (let m = 0; m < months; m++) {
      const r = normalRandom() * monthlyVol + monthlyReturn;
      value = value * (1 + r) + monthlyContribution;
    }
    results.push(value);
  }

  return results;
}

// ─── Risk Contribution ──────────────────────────────────────────────────────

export function calculateRiskContribution(w: number[], cov: number[][]): number[] {
  const n = w.length;
  const portVar = portfolioVariance(w, cov);
  const portVol = Math.sqrt(portVar);

  const rc = w.map((wi, i) => {
    let marginal = 0;
    for (let j = 0; j < n; j++) {
      marginal += w[j] * cov[i][j];
    }
    return (wi * marginal) / portVol;
  });

  const totalRC = rc.reduce((a, b) => a + b, 0);
  return rc.map(r => r / totalRC);
}

// ─── Order Generation ───────────────────────────────────────────────────────

export function generateOrders(
  positions: Record<string, Position>,
  weights: number[],
  prices: Record<string, number>,
  cashReserve: number,
  monthlyContribution: number,
  regime: MarketRegime
): Order[] {
  const totalInvested = ASSETS.reduce((sum, a) => {
    const pos = positions[a.ticker];
    return sum + (pos ? pos.shares * prices[a.ticker] : 0);
  }, 0);

  const structuralReserve = regime.name === 'ATTACK MODE'
    ? 0
    : 0.08 * (totalInvested + monthlyContribution);

  const availableCash = Math.max(0, cashReserve + monthlyContribution - structuralReserve);
  const totalTarget = totalInvested + availableCash;

  const orders: Order[] = [];

  ASSETS.forEach((asset, i) => {
    const currentVal = (positions[asset.ticker]?.shares || 0) * prices[asset.ticker];
    const targetVal = weights[i] * totalTarget;
    const diff = targetVal - currentVal;

    if (diff > 1) {
      const price = prices[asset.ticker];
      const isBTC = asset.ticker === 'BTC-EUR';
      const sharesToBuy = isBTC
        ? Math.round((diff / price) * 100000) / 100000
        : Math.floor(diff / price);

      if (sharesToBuy > 0) {
        orders.push({
          ticker: asset.ticker,
          name: asset.name,
          shares: sharesToBuy,
          price,
          cost: sharesToBuy * price,
        });
      }
    }
  });

  return orders;
}

// ─── Full Recalculation ─────────────────────────────────────────────────────

export function recalculateAll(
  positions: Record<string, Position>,
  cashReserve: number,
  monthlyContribution: number,
  btcMinWeight: number,
  btcMaxWeight: number,
  marketData: MarketData
): PortfolioResults {
  const regime = calculateRegime(marketData);
  const { weights, ret, vol } = optimizePortfolio(marketData, regime.targetVol, btcMinWeight, btcMaxWeight);

  const totalValue = ASSETS.reduce((sum, a) => {
    const pos = positions[a.ticker];
    return sum + (pos ? pos.shares * marketData.prices[a.ticker] : 0);
  }, 0) + cashReserve;

  const mcResults = runMonteCarlo(ret, vol, monthlyContribution, totalValue);
  const probability = mcResults.filter(v => v >= TARGET_AMOUNT).length / mcResults.length;
  const riskContribution = calculateRiskContribution(weights, marketData.covMatrix);
  const orders = generateOrders(positions, weights, marketData.prices, cashReserve, monthlyContribution, regime);

  return {
    marketData,
    regime,
    weights,
    portfolioReturn: ret,
    portfolioVol: vol,
    mcResults,
    probability,
    riskContribution,
    orders,
    totalValue,
  };
}
