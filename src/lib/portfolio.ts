// src/lib/portfolio.ts
import * as math from 'mathjs';
import { ASSETS, Asset, SECTOR_MAP, SECTOR_CAP, TARGET_GOAL, STRUCTURAL_RESERVE_PCT } from './constants';
import { getCurrentPrices, getHistoricalData, getMacroData, CurrentPrices, MacroData, HistoricalData } from './yahooFinance';

// ---------- TIPOS ----------
export interface Position {
  shares: number;
  avgPrice: number;
}

export interface MarketData {
  vix: number;
  tnx: number;
  irx: number;
  gspc: number;
  prices: Record<Asset, number>;
  btcZScore: number;
  vixPercentile80?: number;
  vixPercentile20?: number;
}

export interface Order {
  ticker: Asset;
  shares: number;
  price: number;
  cost: number;
}

export interface RecalculateResult {
  totalValue: number;
  weights: number[];
  riskContribution: number[];
  regime: string;
  targetVol: number;
  probability: number;
  mcResults: number[];
  marketData: MarketData;
  orders: Order[];
  portfolioReturn: number;
  portfolioVol: number;
}

// ---------- CONSTANTES ----------
export const CHART_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFE194',
  '#E6B89C', '#FE938C', '#A1C6EA', '#B8A9C9', '#A9D4B6'
];

export const DEFAULT_POSITIONS: Record<Asset, Position> = {
  "BTC-EUR": { shares: 0.031285, avgPrice: 88010.99 },
  "EMXC.DE": { shares: 31, avgPrice: 28.93 },
  "IS3Q.DE": { shares: 26, avgPrice: 67.53 },
  "PPFB.DE": { shares: 4, avgPrice: 69.39 },
  "URNU.DE": { shares: 13, avgPrice: 26.48 },
  "VVSM.DE": { shares: 2, avgPrice: 52.01 },
  "ZPRR.DE": { shares: 6, avgPrice: 61.67 }
};

// ---------- FUNCIONES AUXILIARES ----------
function calculateZScore(btcPrices: number[]): number {
  const window = 200;
  if (btcPrices.length < window) return 0;
  const lastPrices = btcPrices.slice(-window);
  const ma = Number(math.mean(lastPrices)); // Convertir a número
  const std = Number(math.std(lastPrices)); // Convertir a número
  const lastPrice = btcPrices[btcPrices.length - 1];
  return (lastPrice - ma) / std;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function getRegime(vix: number, vixHistory: number[], btcZ: number): { regime: string; targetVol: number; p80: number; p20: number } {
  const p80 = percentile(vixHistory, 0.8);
  const p20 = percentile(vixHistory, 0.2);
  let regime: string;
  let targetVol: number;

  if (vix > p80) {
    regime = 'RISK_OFF';
    targetVol = 0.10;
  } else if (vix < p20) {
    regime = 'RISK_ON';
    targetVol = 0.18;
  } else {
    regime = 'NEUTRAL';
    targetVol = 0.14;
  }

  if (btcZ < -2) {
    regime = 'ATTACK_MODE';
    targetVol = 0.22;
  }
  return { regime, targetVol, p80, p20 };
}

// ---------- COVARIANZA MANUAL (evita math.cov) ----------
function calculateCovariance(matrix: number[][]): number[][] {
  const n = matrix.length;           // número de filas (días)
  const m = matrix[0].length;        // número de columnas (activos)
  // Calcular medias por columna
  const means: number[] = new Array(m).fill(0);
  for (let j = 0; j < m; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += matrix[i][j];
    }
    means[j] = sum / n;
  }
  // Calcular matriz de covarianza (m x m)
  const cov: number[][] = Array(m).fill(0).map(() => new Array(m).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += (matrix[k][i] - means[i]) * (matrix[k][j] - means[j]);
      }
      cov[i][j] = sum / (n - 1); // covarianza muestral
    }
  }
  return cov;
}

function optimizePortfolio(
  returns: number[][], // matriz de retornos: filas = días, columnas = activos
  targetVol: number,
  btcMin: number,
  btcMax: number
): number[] {
  const n = ASSETS.length;
  // Calcular media de retornos por activo
  const mu: number[] = [];
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let i = 0; i < returns.length; i++) {
      sum += returns[i][j];
    }
    mu.push(sum / returns.length);
  }

  // Calcular matriz de covarianza
  const cov = calculateCovariance(returns);

  // Función Sharpe negativo
  const negSharpe = (w: number[]): number => {
    let portReturn = 0;
    for (let i = 0; i < n; i++) portReturn += w[i] * mu[i];
    let portVar = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        portVar += w[i] * w[j] * cov[i][j];
      }
    }
    const portVol = Math.sqrt(portVar);
    return -portReturn / portVol;
  };

  // Restricciones
  const sectors = [...new Set(Object.values(SECTOR_MAP))];

  // Búsqueda aleatoria simple (para evitar optimizadores complejos)
  let bestW: number[] = [];
  let bestSharpe = -Infinity;
  for (let attempt = 0; attempt < 20000; attempt++) {
    const w = Array(n).fill(0).map(() => Math.random());
    const sum = w.reduce((a, b) => a + b, 0);
    const wNorm = w.map(v => v / sum);

    // Verificar límites individuales
    const boundsOk = wNorm.every((v, i) => {
      if (i === ASSETS.indexOf('BTC-EUR')) {
        return v >= btcMin && v <= btcMax;
      } else {
        return v >= 0.02 && v <= 0.40;
      }
    });
    if (!boundsOk) continue;

    // Verificar límites sectoriales
    let sectorsOk = true;
    for (const sector of sectors) {
      const indices = ASSETS.map((a, idx) => SECTOR_MAP[a] === sector ? idx : -1).filter(i => i >= 0);
      const sectorSum = indices.reduce((acc, i) => acc + wNorm[i], 0);
      if (sectorSum > SECTOR_CAP) { sectorsOk = false; break; }
    }
    if (!sectorsOk) continue;

    // Calcular volatilidad
    let portVar = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        portVar += wNorm[i] * wNorm[j] * cov[i][j];
      }
    }
    const portVol = Math.sqrt(portVar);
    if (portVol > targetVol) continue;

    const portReturn = wNorm.reduce((acc, wi, i) => acc + wi * mu[i], 0);
    const sharpe = portReturn / portVol;
    if (sharpe > bestSharpe) {
      bestSharpe = sharpe;
      bestW = wNorm;
    }
  }

  if (bestW.length === 0) {
    // fallback: pesos iguales
    return Array(n).fill(1 / n);
  }
  return bestW;
}

function monteCarlo(
  currentValue: number,
  monthlyContribution: number,
  years: number,
  muAnnual: number,
  volAnnual: number,
  nSims: number = 500
): { results: number[]; probability: number } {
  const months = years * 12;
  const monthlyMu = muAnnual / 12;
  const monthlyVol = volAnnual / Math.sqrt(12);
  const results: number[] = [];

  for (let sim = 0; sim < nSims; sim++) {
    let value = currentValue;
    for (let m = 0; m < months; m++) {
      // Box-Muller para generar normal estándar
      const u = Math.random();
      const v = Math.random();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      const ret = monthlyMu + monthlyVol * z;
      value = value * (1 + ret) + monthlyContribution;
    }
    results.push(value);
  }

  const probability = results.filter(v => v >= TARGET_GOAL).length / nSims;
  return { results, probability };
}

function generateOrders(
  currentWeights: number[],
  targetWeights: number[],
  currentValues: number[],
  cashAvailable: number,
  prices: number[]
): { orders: Order[]; totalCost: number } {
  const totalInvested = currentValues.reduce((a, b) => a + b, 0);
  const targetValues = targetWeights.map(w => w * (totalInvested + cashAvailable));
  const orders: Order[] = [];
  let totalCost = 0;

  for (let i = 0; i < ASSETS.length; i++) {
    const diff = targetValues[i] - currentValues[i];
    if (diff > 0) {
      const shares = diff / prices[i];
      const cost = shares * prices[i];
      if (cost <= cashAvailable - totalCost) {
        orders.push({ ticker: ASSETS[i], shares, price: prices[i], cost });
        totalCost += cost;
      }
    }
  }
  return { orders, totalCost };
}

// ---------- FUNCIÓN PRINCIPAL ----------
export async function recalculateAll(
  positions: Record<Asset, Position>,
  cashReserve: number,
  monthlyContribution: number,
  btcMinWeight: number,
  btcMaxWeight: number
): Promise<RecalculateResult> {
  // Obtener datos
  const prices: CurrentPrices = await getCurrentPrices();
  const macro: MacroData = await getMacroData();
  const historical: HistoricalData = await getHistoricalData(2);

  // Arrays ordenados
  const pricesArray = ASSETS.map(a => prices[a] || 0);
  const currentValues = ASSETS.map(asset => positions[asset]?.shares * prices[asset] || 0);
  const totalInvested = currentValues.reduce((a, b) => a + b, 0);
  const totalValue = totalInvested + cashReserve;

  // Z-score BTC
  const btcPrices = (historical['BTC-EUR'] as number[]) || [];
  const btcZ = calculateZScore(btcPrices);

  // Histórico VIX
  const vixHistory = (historical['^VIX'] as number[]) || [];
  const { regime, targetVol, p80, p20 } = getRegime(macro.vix, vixHistory, btcZ);

  // Construir matriz de retornos históricos (días x activos)
  const firstAsset = ASSETS[0];
  const firstHist = historical[firstAsset] as number[];
  const numDays = firstHist?.length || 0;
  const returnsMatrix: number[][] = [];
  for (let i = 1; i < numDays; i++) {
    const row: number[] = [];
    for (const asset of ASSETS) {
      const hist = historical[asset] as number[];
      if (hist && hist[i-1] && hist[i]) {
        row.push((hist[i] - hist[i-1]) / hist[i-1]);
      } else {
        row.push(0);
      }
    }
    returnsMatrix.push(row);
  }

  // Optimizar pesos objetivo
  const targetWeights = optimizePortfolio(returnsMatrix, targetVol, btcMinWeight, btcMaxWeight);

  // Rentabilidad media anual esperada (usamos la media de los retornos históricos)
  let totalMean = 0;
  for (let j = 0; j < ASSETS.length; j++) {
    let sum = 0;
    for (let i = 0; i < returnsMatrix.length; i++) {
      sum += returnsMatrix[i][j];
    }
    totalMean += sum / returnsMatrix.length;
  }
  const muAnnual = (totalMean / ASSETS.length) * 252; // media de medias

  // Monte Carlo
  const { results: mcResults, probability } = monteCarlo(
    totalValue,
    monthlyContribution,
    10,
    muAnnual,
    targetVol,
    500
  );

  // Contribución al riesgo (usando covarianza manual)
  const currentWeights = totalInvested > 0 ? currentValues.map(v => v / totalInvested) : Array(ASSETS.length).fill(1/ASSETS.length);
  const covMatrix = calculateCovariance(returnsMatrix);
  let portVar = 0;
  for (let i = 0; i < ASSETS.length; i++) {
    for (let j = 0; j < ASSETS.length; j++) {
      portVar += currentWeights[i] * currentWeights[j] * covMatrix[i][j];
    }
  }
  const portVol = Math.sqrt(portVar);
  const riskContrib = currentWeights.map((w, i) => {
    let marginal = 0;
    for (let j = 0; j < ASSETS.length; j++) {
      marginal += covMatrix[i][j] * currentWeights[j];
    }
    return w * marginal / portVol;
  });
  const riskContribNorm = riskContrib.map(v => v / riskContrib.reduce((a, b) => a + b, 0));

  // Generar órdenes
  const cashAvailable = cashReserve + monthlyContribution;
  const structuralReserve = STRUCTURAL_RESERVE_PCT * totalValue;
  const usableCash = regime === 'ATTACK_MODE' ? cashAvailable : Math.max(0, cashAvailable - structuralReserve);
  const { orders } = generateOrders(
    currentWeights,
    targetWeights,
    currentValues,
    usableCash,
    pricesArray
  );

  // MarketData
  const marketData: MarketData = {
    vix: macro.vix,
    tnx: macro.tnx,
    irx: macro.irx,
    gspc: macro.gspc,
    prices: ASSETS.reduce((acc, a, i) => ({ ...acc, [a]: pricesArray[i] }), {} as Record<Asset, number>),
    btcZScore: btcZ,
    vixPercentile80: p80,
    vixPercentile20: p20,
  };

  return {
    totalValue,
    weights: targetWeights,
    riskContribution: riskContribNorm,
    regime,
    targetVol,
    probability,
    mcResults,
    marketData,
    orders,
    portfolioReturn: muAnnual,
    portfolioVol: targetVol,
  };
}
// Re-exportar desde constants
export { ASSETS, SECTOR_MAP, SECTOR_CAP, TARGET_GOAL, DEFAULT_MONTHLY, STRUCTURAL_RESERVE_PCT } from './constants';
export type { Asset } from './constants';

// Alias para TARGET_AMOUNT (por si algún componente lo usa)
export const TARGET_AMOUNT = TARGET_GOAL;