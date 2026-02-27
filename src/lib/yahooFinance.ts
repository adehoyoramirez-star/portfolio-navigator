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

/**
 * Función interna que llama al proxy de Vercel (api/yahoo.js)
 * Incluye reintentos, validación de respuesta y manejo de errores con tipo 'unknown'.
 */
async function fetchYahoo(
  ticker: string,
  range: string = '1d',
  interval: string = '1d',
  retries: number = 2
): Promise<any> {
  const url = `/api/yahoo?ticker=${encodeURIComponent(ticker)}&range=${range}&interval=${interval}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      const data = await response.json();

      if (!response.ok) {
        const errorMsg = data.error || `HTTP ${response.status}`;
        throw new Error(errorMsg);
      }

      // Verificar que la estructura de Yahoo es la esperada
      if (!data.chart?.result?.[0]) {
        throw new Error('Respuesta inesperada de Yahoo (sin data.chart.result[0])');
      }

      return data;
    } catch (error) {
      // Manejo seguro de 'unknown'
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Intento ${attempt + 1} falló para ${ticker}:`, errorMessage);
      lastError = error instanceof Error ? error : new Error(String(error));

      // Esperar antes de reintentar (solo si no es el último intento)
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  }
  throw new Error(`No se pudo obtener datos de ${ticker} después de ${retries + 1} intentos: ${lastError?.message}`);
}

// ------------------------------------------------------------------
// PRECIOS ACTUALES
// ------------------------------------------------------------------
export async function getCurrentPrices(): Promise<CurrentPrices> {
  const prices: CurrentPrices = {};
  for (const ticker of ASSETS) {
    try {
      const data = await fetchYahoo(ticker, '1d');
      prices[ticker] = data.chart.result[0].meta.regularMarketPrice;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error obteniendo precio de ${ticker}:`, errorMessage);
      prices[ticker] = 0; // Valor por defecto para no romper la app
    }
  }
  return prices;
}

// ------------------------------------------------------------------
// DATOS MACRO (VIX, TNX, IRX, GSPC)
// ------------------------------------------------------------------
export async function getMacroData(): Promise<MacroData> {
  // Valores por defecto en caso de fallo total
  const defaultMacro: MacroData = {
    vix: 20,
    tnx: 4.0,
    irx: 3.0,
    gspc: 4000,
  };

  try {
    // Ejecutamos todas las peticiones en paralelo con Promise.allSettled
    const results = await Promise.allSettled([
      fetchYahoo('^VIX', '1d'),
      fetchYahoo('^TNX', '1d'),
      fetchYahoo('^IRX', '1d'),
      fetchYahoo('^GSPC', '1d'),
    ]);

    const extractPrice = (result: PromiseSettledResult<any>): number | null => {
      if (result.status === 'fulfilled') {
        try {
          return result.value.chart.result[0].meta.regularMarketPrice;
        } catch (e) {
          return null;
        }
      }
      return null;
    };

    const [vixResult, tnxResult, irxResult, gspcResult] = results;

    return {
      vix: extractPrice(vixResult) ?? defaultMacro.vix,
      tnx: extractPrice(tnxResult) ?? defaultMacro.tnx,
      irx: extractPrice(irxResult) ?? defaultMacro.irx,
      gspc: extractPrice(gspcResult) ?? defaultMacro.gspc,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error grave en getMacroData, usando valores por defecto:', errorMessage);
    return defaultMacro;
  }
}

// ------------------------------------------------------------------
// DATOS HISTÓRICOS (2 años por defecto)
// ------------------------------------------------------------------
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error obteniendo histórico de ${ticker}:`, errorMessage);
      result[ticker] = []; // array vacío para no romper
    }
  }
  return result;
}