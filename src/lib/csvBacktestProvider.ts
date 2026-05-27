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
  return { vix, yieldSpread, creditSpread, erpValue, avgCorrelation };
}
