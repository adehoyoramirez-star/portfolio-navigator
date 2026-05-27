// ===============================================
// ARCHIVO: src/lib/csvBacktestProvider.ts
// Carga el CSV local con 11 anos de datos (2015-2026)
// para backtesting con horizonte extendido.
// ===============================================

import { ASSETS } from './constants';

const CSV_PATH = '/historical_data_daily.csv';

const COLUMN_MAP: Record<string, number> = {
  'BTC-EUR': 1,
  'EMXC.DE': 2,
  'IS3Q.DE': 3,
  'PPFB.DE': 4,
  'URNU.DE': 5,
  'VVSM.DE': 6,
  'XNAS.DE': 7,
  '^VIX': 8,
  '^TNX': 9,
  '^IRX': 10,
  'HYG': 11,
  'LQD': 12,
};

export interface CSVBacktestData {
  closesHistory: Record<string, number[]>;
  vixHistory: number[];
  tnxHistory: number[];
  irxHistory: number[];
  hygHistory: number[];
  lqdHistory: number[];
  totalDays: number;
}

function parseCSV(text: string): CSVBacktestData {
  const lines = text.trim().split('\n');
  const dataLines = lines.slice(1).filter(l => l.trim().length > 0);

  const closesHistory: Record<string, number[]> = {};
  const allTickers = [...ASSETS, '^VIX', '^TNX', '^IRX', 'HYG', 'LQD'];
  for (const ticker of allTickers) {
    closesHistory[ticker] = [];
  }

  for (const line of dataLines) {
    const parts = line.split(',');
    if (parts.length < 13) continue;
    for (const ticker of allTickers) {
      const colIdx = COLUMN_MAP[ticker];
      if (colIdx !== undefined) {
        const val = parseFloat(parts[colIdx]);
        closesHistory[ticker].push(isFinite(val) ? val : 0);
      }
    }
  }
  return { closesHistory, vixHistory: closesHistory['^VIX'], tnxHistory: closesHistory['^TNX'], irxHistory: closesHistory['^IRX'], hygHistory: closesHistory['HYG'], lqdHistory: closesHistory['LQD'], totalDays: dataLines.length };
}

let cachedData: CSVBacktestData | null = null;

export async function loadCSVBacktestData(): Promise<CSVBacktestData> {
  if (cachedData) return cachedData;
  const response = await fetch(CSV_PATH);
  if (!response.ok) throw new Error('Failed to load CSV: ' + response.status);
  const text = await response.text();
  cachedData = parseCSV(text);
  console.log('[CSV] Loaded ' + cachedData.totalDays + ' days of historical data');
  return cachedData;
}

export function buildMacroHistoryFromCSV(csvData: CSVBacktestData, length: number) {
  const vix = csvData.vixHistory.slice(-length);
  const tnx = csvData.tnxHistory.slice(-length);
  const irx = csvData.irxHistory.slice(-length);
  const hyg = csvData.hygHistory.slice(-length);
  const lqd = csvData.lqdHistory.slice(-length);
  const yieldSpread = tnx.map((t, i) => t - (irx[i] ?? 0));
  const creditSpread = hyg.map((h, i) => {
    const l = lqd[i] ?? 80;
    const sanitizedH = Math.max(1, h);
    const sanitizedL = Math.max(1, l ?? 80);
    if (sanitizedH <= 0 || sanitizedL <= 0 || !isFinite(sanitizedH) || !isFinite(sanitizedL)) return 3.0;
    const hygYield = 4.20 / (sanitizedH / 80);
    const lqdYield = 3.00 / (sanitizedL / 80);
    return Math.max(1.0, Math.min(9.0, (hygYield - lqdYield) / 0.80));
  });
  const is3qPrices = csvData.closesHistory['IS3Q.DE']?.slice(-length) ?? [];
  const erpValue = is3qPrices.map((price, i) => {
    const idx = Math.max(0, i - 756);
    const price3yAgo = is3qPrices[idx];
    if (!price3yAgo || price3yAgo <= 0) return 0.02;
    const total3yReturn = price / price3yAgo - 1;
    const LONG_TERM_AVG_RETURN = 0.225;
    const earningsYield = 0.055 - 0.15 * (total3yReturn - LONG_TERM_AVG_RETURN);
    const riskFree = (tnx[i] ?? 4) / 100;
    return Math.max(-0.03, Math.min(0.05, earningsYield - riskFree));
  });
  const avgCorrelation = vix.map(v => 0.30 + Math.min(0.65, v / 50 * 0.65));

  // ── btcVol: volatilidad realizada de BTC desde precios CSV ──
  const btcPrices = csvData.closesHistory['BTC-EUR']?.slice(-length) ?? [];
  const btcVol: number[] = [];
  const VOL_WINDOW = 63; // ~3 meses hábiles
  for (let i = 0; i < btcPrices.length; i++) {
    if (i < VOL_WINDOW + 1 || btcPrices[i] <= 0 || btcPrices[i - 1] <= 0) {
      btcVol.push(0.50); // fallback 50%
      continue;
    }
    let sumLog = 0, sumLog2 = 0;
    let count = 0;
    for (let j = i - VOL_WINDOW; j <= i; j++) {
      if (btcPrices[j] > 0 && btcPrices[j - 1] > 0) {
        const ret = Math.log(btcPrices[j] / btcPrices[j - 1]);
        sumLog += ret;
        sumLog2 += ret * ret;
        count++;
      }
    }
    if (count < 20) {
      btcVol.push(0.50);
    } else {
      const mean = sumLog / count;
      const variance = sumLog2 / count - mean * mean;
      btcVol.push(Math.max(0.20, Math.min(2.0, Math.sqrt(variance * 252))));
    }
  }

  // ── move: proxy desde VIX (relación empírica MOVE ≈ VIX × 4.5 + 20) ──
  const move = vix.map(v => Math.max(40, Math.min(300, v * 4.5 + 20)));

  // ── dxyTrend: proxy desde cambios en yield spread ──
  // Cuando yield spread se amplía (empinamiento) → USD suele fortalecerse
  // Usamos el gradiente suavizado del yield spread como proxy
  const dxyTrend: number[] = [];
  const DXY_WINDOW = 21;
  for (let i = 0; i < yieldSpread.length; i++) {
    if (i < DXY_WINDOW) {
      dxyTrend.push(0);
    } else {
      const change = yieldSpread[i] - yieldSpread[i - DXY_WINDOW];
      dxyTrend.push(Math.max(-0.05, Math.min(0.05, change * 0.05)));
    }
  }

  return { vix, yieldSpread, creditSpread, erpValue, avgCorrelation, btcVol, move, dxyTrend };
}
