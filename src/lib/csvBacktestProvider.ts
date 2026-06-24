// ===============================================
// ARCHIVO: src/lib/csvBacktestProvider.ts
// Carga el CSV local con 11 anos de datos (2015-2026)
// para backtesting con horizonte extendido.
// ===============================================

import { ASSETS } from './constants';

// FIX-CSV-AUGMENTED: usar CSV aumentado con MOVE, DXY y BTC_VOL reales
// en vez de proxies sintéticos. Columnas 13-15 añadidas.
const CSV_PATH = '/historical_data_daily_augmented.csv';

const COLUMN_MAP: Record<string, number> = {
  'BTC-EUR': 1,
  'EMXC.DE': 2,
  '0P00000WLG.F': 3,
  'PPFB.DE': 4,
  'URNU.DE': 5,
  'VVSM.DE': 6,
  '^VIX': 8,
  '^TNX': 9,
  '^IRX': 10,
  'HYG': 11,
  'LQD': 12,
  '^MOVE': 13,
  'DX-Y.NYB': 14,
  'BTC_VOL': 15,
};

export interface CSVBacktestData {
  closesHistory: Record<string, number[]>;
  vixHistory: number[];
  tnxHistory: number[];
  irxHistory: number[];
  hygHistory: number[];
  lqdHistory: number[];
  moveHistory: number[];     // ^MOVE — CBOE MOVE Index (volatilidad bonos)
  dxyHistory: number[];      // DX-Y.NYB — DXY Dollar Index
  btcVolHistory: number[];   // BTC_VOL — volatilidad realizada BTC (pre-calculada)
  totalDays: number;
}

function parseCSV(text: string): CSVBacktestData {
  const lines = text.trim().split('\n');
  const dataLines = lines.slice(1).filter(l => l.trim().length > 0);

  const closesHistory: Record<string, number[]> = {};
  const allTickers = [...ASSETS, '^VIX', '^TNX', '^IRX', 'HYG', 'LQD', '^MOVE', 'DX-Y.NYB', 'BTC_VOL'];
  for (const ticker of allTickers) {
    closesHistory[ticker] = [];
  }

  for (const line of dataLines) {
    const parts = line.split(',');
    if (parts.length < 16) continue;
    for (const ticker of allTickers) {
      const colIdx = COLUMN_MAP[ticker];
      if (colIdx !== undefined) {
        const val = parseFloat(parts[colIdx]);
        closesHistory[ticker].push(isFinite(val) ? val : 0);
      }
    }
  }
  return {
    closesHistory,
    vixHistory: closesHistory['^VIX'],
    tnxHistory: closesHistory['^TNX'],
    irxHistory: closesHistory['^IRX'],
    hygHistory: closesHistory['HYG'],
    lqdHistory: closesHistory['LQD'],
    moveHistory: closesHistory['^MOVE'],
    dxyHistory: closesHistory['DX-Y.NYB'],
    btcVolHistory: closesHistory['BTC_VOL'],
    totalDays: dataLines.length,
  };
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
  const wlgPrices = csvData.closesHistory['0P00000WLG.F']?.slice(-length) ?? [];
  const erpValue = wlgPrices.map((price, i) => {
    const idx = Math.max(0, i - 756);
    const price3yAgo = wlgPrices[idx];
    if (!price3yAgo || price3yAgo <= 0) return 0.02;
    const total3yReturn = price / price3yAgo - 1;
    const LONG_TERM_AVG_RETURN = 0.225;
    const earningsYield = 0.055 - 0.15 * (total3yReturn - LONG_TERM_AVG_RETURN);
    const riskFree = (tnx[i] ?? 4) / 100;
    return Math.max(-0.03, Math.min(0.05, earningsYield - riskFree));
  });
  const avgCorrelation = vix.map(v => 0.30 + Math.min(0.65, v / 50 * 0.65));

  // ── btcVol: usar BTC_VOL pre-calculada del CSV aumentado ──
  // FIX-CSV-AUGMENTED: antes se calculaba desde precios BTC con rolling 63d.
  // Ahora usamos BTC_VOL real del CSV (NaN → fallback 0.50).
  const btcVolRaw = csvData.btcVolHistory.slice(-length);
  const btcVol = btcVolRaw.map(v => (isFinite(v) && v > 0) ? v : 0.50);

  // ── move: usar ^MOVE real del CSV aumentado ──
  // FIX-CSV-AUGMENTED: antes era proxy sintético VIX×4.5+20.
  // Ahora usamos el CBOE MOVE Index real.
  const moveRaw = csvData.moveHistory.slice(-length);
  const move = moveRaw.map((v, i) => (isFinite(v) && v > 0) ? v : (vix[i] ?? 20) * 4.5 + 20);

  // ── dxyTrend: calcular desde DX-Y.NYB real del CSV aumentado ──
  // FIX-CSV-AUGMENTED: antes era proxy desde yield spread.
  // Ahora calculamos el momentum del DXY real (cambio 21d normalizado).
  const dxyRaw = csvData.dxyHistory.slice(-length);
  const dxyTrend: number[] = [];
  const DXY_WINDOW = 21;
  for (let i = 0; i < dxyRaw.length; i++) {
    if (i < DXY_WINDOW || !isFinite(dxyRaw[i]) || !isFinite(dxyRaw[i - DXY_WINDOW]) || dxyRaw[i - DXY_WINDOW] <= 0) {
      dxyTrend.push(0);
    } else {
      const pctChange = (dxyRaw[i] - dxyRaw[i - DXY_WINDOW]) / dxyRaw[i - DXY_WINDOW];
      dxyTrend.push(Math.max(-0.05, Math.min(0.05, pctChange)));
    }
  }

  return { vix, yieldSpread, creditSpread, erpValue, avgCorrelation, btcVol, move, dxyTrend };
}
