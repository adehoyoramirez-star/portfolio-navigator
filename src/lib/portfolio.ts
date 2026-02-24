// src/lib/portfolio.ts
import * as math from 'mathjs';
import { ASSETS, Asset, SECTOR_MAP, SECTOR_CAP, STRUCTURAL_RESERVE_PCT } from './constants';
import { getCurrentPrices, getHistoricalData, getMacroData, CurrentPrices, MacroData, HistoricalData } from './yahooFinance';
import { MacroExtendedData } from './macroExtended';
import { ledoitWolfCovariance } from './risk';
import { monteCarloInstitutional } from './montecarlo';

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
  macroExtended?: MacroExtendedData;
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
  const ma = Number(math.mean(lastPrices));
  const std = Number(math.std(lastPrices));
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

function getRegime(vix: number, vixHistory: number[], btcZ: number, m2Growth: number): { regime: string; targetVol: number; p80: number; p20: number } {
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

  // Ajuste por liquidez (M2)
  if (m2Growth > 5) {
    targetVol *= 1.1;
  } else if (m2Growth < 2) {
    targetVol *= 0.9;
  }

  return { regime, targetVol, p80, p20 };
}

// ---------- OPTIMIZACIÓN (BÚSQUEDA ALEATORIA CON RESTRICCIONES) ----------
function optimizePortfolio(
  returns: number[][],
  targetVol: number,
  btcMin: number,
  btcMax: number,
  erp: number
): number[] {
  const n = ASSETS.length;
  // Media de retornos por activo (diarios)
  const mu: number[] = [];
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let i = 0; i < returns.length; i++) {
      sum += returns[i][j];
    }
    mu.push(sum / returns.length);
  }

  // Identificar activos de renta variable
  const equityIndices = ASSETS.reduce((acc, asset, idx) => {
    if (['EMXC.DE', 'IS3Q.DE', 'VVSM.DE'].includes(asset)) acc.push(idx);
    return acc;
  }, [] as number[]);

  // Ajuste por ERP (PER)
  const erpFactor = 1 + (erp / 100);
  equityIndices.forEach(i => { mu[i] *= erpFactor; });

  // Covarianza shrinkeada (Ledoit-Wolf)
  const cov = ledoitWolfCovariance(returns);

  // Búsqueda aleatoria
  let bestW: number[] = [];
  let bestSharpe = -Infinity;
  const sectors = [...new Set(Object.values(SECTOR_MAP))];

  for (let attempt = 0; attempt < 20000; attempt++) {
    const w = Array(n).fill(0).map(() => Math.random());
    const sum = w.reduce((a, b) => a + b, 0);
    const wNorm = w.map(v => v / sum);

    // Límites individuales
    let boundsOk = true;
    for (let i = 0; i < n; i++) {
      if (i === ASSETS.indexOf('BTC-EUR')) {
        if (wNorm[i] < btcMin || wNorm[i] > btcMax) { boundsOk = false; break; }
      } else {
        if (wNorm[i] < 0.02 || wNorm[i] > 0.40) { boundsOk = false; break; }
      }
    }
    if (!boundsOk) continue;

    // Límites sectoriales
    let sectorsOk = true;
    for (const sector of sectors) {
      const indices = ASSETS.map((a, idx) => SECTOR_MAP[a] === sector ? idx : -1).filter(i => i >= 0);
      const sectorSum = indices.reduce((acc, i) => acc + wNorm[i], 0);
      if (sectorSum > SECTOR_CAP) { sectorsOk = false; break; }
    }
    if (!sectorsOk) continue;

    // Volatilidad
    let portVar = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        portVar += wNorm[i] * wNorm[j] * cov[i][j];
      }
    }
    const portVol = Math.sqrt(portVar);
    if (portVol > targetVol) continue;

    // Sharpe
    let portReturn = 0;
    for (let i = 0; i < n; i++) portReturn += wNorm[i] * mu[i];
    const sharpe = portReturn / portVol;
    if (sharpe > bestSharpe) {
      bestSharpe = sharpe;
      bestW = wNorm;
    }
  }

  if (bestW.length === 0) {
    return Array(n).fill(1 / n);
  }
  return bestW;
}

// ---------- GENERACIÓN DE ÓRDENES ----------
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
      const price = prices[i];
      let shares: number;
      if (ASSETS[i] === 'BTC-EUR') {
        shares = diff / price;       // fracciones permitidas
      } else {
        shares = Math.floor(diff / price); // solo unidades enteras
      }
      const cost = shares * price;
      if (cost > 0 && cost <= cashAvailable - totalCost) {
        orders.push({ ticker: ASSETS[i], shares, price, cost });
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
  btcMaxWeight: number,
  macroExtended: MacroExtendedData | null
): Promise<RecalculateResult> {
  // Obtener datos de mercado
  const prices: CurrentPrices = await getCurrentPrices();
  const macro: MacroData = await getMacroData();
  const historical: HistoricalData = await getHistoricalData(2);

  // Extraer valores de macroExtended (con fallback)
  const erp = macroExtended?.erp ?? 20; // PER por defecto 20
  const m2Growth = macroExtended?.m2Growth ?? 5; // crecimiento por defecto 5%

  // Valores actuales
  const pricesArray = ASSETS.map(a => prices[a] || 0);
  const currentValues = ASSETS.map(asset => positions[asset]?.shares * prices[asset] || 0);
  const totalInvested = currentValues.reduce((a, b) => a + b, 0);
  const totalValue = totalInvested + cashReserve;
  // Silenciar advertencia de TypeScript (realmente se usa)
  void totalValue;

  // Z-score BTC
  const btcPrices = (historical['BTC-EUR'] as number[]) || [];
  const btcZ = calculateZScore(btcPrices);

  // Histórico VIX
  const vixHistory = (historical['^VIX'] as number[]) || [];
  const { regime, targetVol, p80, p20 } = getRegime(macro.vix, vixHistory, btcZ, m2Growth);

  // Construir matriz de retornos históricos
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

  // Calcular retornos esperados diarios por activo (ya lo hace optimizePortfolio internamente, pero no lo necesitamos aquí)
  // Solo necesitamos pasar returnsMatrix a optimizePortfolio

  // Optimizar pesos objetivo (búsqueda aleatoria con restricciones)
  const targetWeights = optimizePortfolio(
    returnsMatrix,
    targetVol,
    btcMinWeight,
    btcMaxWeight,
    erp
  );

  // Rentabilidad anual esperada del portafolio objetivo (para el Monte Carlo)
  // Necesitamos calcular mu anual a partir de los retornos diarios medios de los activos
  const muDaily = targetWeights.map((_, i) => {
    let sum = 0;
    for (let j = 0; j < returnsMatrix.length; j++) {
      sum += returnsMatrix[j][i];
    }
    return sum / returnsMatrix.length;
  });
  const muAnnual = targetWeights.reduce((sum, w, i) => sum + w * muDaily[i], 0) * 252;

  // Monte Carlo institucional (t‑Student)
  const mc = monteCarloInstitutional(
    totalValue,
    monthlyContribution,
    10,
    muAnnual,
    targetVol,
    5,
    2000
  );

  // Contribución al riesgo (usando covarianza shrinkeada)
  const covMatrix = ledoitWolfCovariance(returnsMatrix);
  const currentWeights = totalInvested > 0 ? currentValues.map(v => v / totalInvested) : Array(ASSETS.length).fill(1/ASSETS.length);
  void currentWeights; // Silenciar advertencia (realmente se usa)

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

  // Preparar marketData
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
    probability: mc.probability,
    mcResults: mc.results,
    marketData,
    orders,
    portfolioReturn: muAnnual,
    portfolioVol: targetVol,
    macroExtended: { erp, m2Growth }
  };
}