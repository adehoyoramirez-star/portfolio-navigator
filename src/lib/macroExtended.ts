import axios from 'axios';

// Claves de API (debes reemplazar con tus propias claves)
// Para desarrollo local, puedes ponerlas directamente aquí.
// En producción, usa variables de entorno.
const ALPHA_VANTAGE_KEY = import.meta.env.VITE_ALPHA_VANTAGE_KEY;
const FRED_API_KEY = import.meta.env.VITE_FRED_API_KEY;

export interface MacroExtendedData {
  erp: number;           // PER del S&P 500 (luego se convierte a ERP)
  m2Growth: number;      // Crecimiento interanual de M2 en %
  m2Value?: number;      // Valor absoluto (opcional)
}

// Obtener PER del S&P 500 desde Alpha Vantage (usando ETF SPY como proxy)
async function getSP500PE(): Promise<number> {
  try {
    const response = await axios.get(
      `https://www.alphavantage.co/query?function=OVERVIEW&symbol=SPY&apikey=${ALPHA_VANTAGE_KEY}`
    );
    const pe = parseFloat(response.data.PERatio);
    if (isNaN(pe)) throw new Error('PERatio no disponible');
    return pe;
  } catch (error) {
    console.error('Error obteniendo PER:', error);
    // Fallback: valor típico (20)
    return 20;
  }
}

// Obtener M2 desde FRED
async function getM2Growth(): Promise<number> {
  try {
    const response = await axios.get(
      `https://api.stlouisfed.org/fred/series/observations?series_id=M2SL&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=2`
    );
    const observations = response.data.observations;
    if (observations.length < 2) throw new Error('No hay suficientes datos');
    const latest = parseFloat(observations[0].value);
    const prevYear = parseFloat(observations[1].value);
    const growth = ((latest - prevYear) / prevYear) * 100;
    return growth;
  } catch (error) {
    console.error('Error obteniendo M2:', error);
    // Fallback: valor típico ~5%
    return 5.0;
  }
}

// Función principal
export async function getMacroExtended(): Promise<MacroExtendedData> {
  const [erp, m2Growth] = await Promise.all([
    getSP500PE(),
    getM2Growth()
  ]);
  return { erp, m2Growth };
}