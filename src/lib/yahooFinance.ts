// src/lib/yahooFinance.ts
import { ASSETS } from './constants';

// --- TIPOS EXPORTABLES ---
export interface CurrentPrices {
  [ticker: string]: number;
}

export interface MacroData {
  vix: number;
  tnx: number;
  irx: number;
  gspc: number;
}

export interface HistoricalData {
  dates: Date[];
  [ticker: string]: number[] | Date[];
}
// --- FIN TIPOS ---

async function fetchYahoo(ticker: string, range: string = '1d', interval: string = '1d'): Promise<any> {
  // Usamos la ruta del proxy configurado en vite.config.ts
  const url = `/api/${ticker}?range=${range}&interval=${interval}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error fetching ${ticker}: ${response.statusText}`);
  }
  const data = await response.json();
  return data;
}

export async function getCurrentPrices(): Promise<CurrentPrices> {
  const prices: CurrentPrices = {};
  for (const ticker of ASSETS) {
    try {
      const data = await fetchYahoo(ticker, '1d');
      // La respuesta de Yahoo tiene la estructura: data.chart.result[0].meta.regularMarketPrice
      const price = data.chart.result[0].meta.regularMarketPrice;
      prices[ticker] = price;
    } catch (error) {
      console.error(`Error obteniendo precio de ${ticker}:`, error);
      prices[ticker] = 0; // Valor por defecto para no romper la app
    }
  }
  return prices;
}

export async function getMacroData(): Promise<MacroData> {
  // Ejecutamos todas las peticiones en paralelo
  const [vixData, tnxData, irxData, gspcData] = await Promise.all([
    fetchYahoo('^VIX', '1d'),
    fetchYahoo('^TNX', '1d'),
    fetchYahoo('^IRX', '1d'),
    fetchYahoo('^GSPC', '1d')
  ]);

  return {
    vix: vixData.chart.result[0].meta.regularMarketPrice,
    tnx: tnxData.chart.result[0].meta.regularMarketPrice,
    irx: irxData.chart.result[0].meta.regularMarketPrice,
    gspc: gspcData.chart.result[0].meta.regularMarketPrice,
  };
}

export async function getHistoricalData(years: number = 2): Promise<HistoricalData> {
  const range = `${years}y`;
  const tickers = [...ASSETS, '^VIX'];
  const result: HistoricalData = { dates: [] };

  for (const ticker of tickers) {
    try {
      const data = await fetchYahoo(ticker, range, '1d');
      const timestamps = data.chart.result[0].timestamp;
      const prices = data.chart.result[0].indicators.quote[0].close;

      if (result.dates.length === 0 && timestamps) {
        result.dates = timestamps.map((ts: number) => new Date(ts * 1000));
      }
      result[ticker] = prices;
    } catch (error) {
      console.error(`Error obteniendo histórico de ${ticker}:`, error);
      result[ticker] = []; // array vacío para no romper
    }
  }
  return result;
}