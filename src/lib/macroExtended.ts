// src/lib/macroExtended.ts
import axios from 'axios';

export interface MacroExtendedData {
  erp: number;      // PER del S&P 500 (luego se convierte a ERP en la UI)
  m2Growth: number; // crecimiento interanual de M2
}

// Obtener PER de SPY desde Yahoo Finance
async function getSP500PE(): Promise<number> {
  try {
    const response = await axios.get('/api/yahoo-quote?ticker=SPY&module=summaryDetail');
    const pe = response.data?.quoteSummary?.result?.[0]?.summaryDetail?.peRatio?.raw;
    if (!pe) throw new Error('PER no disponible');
    return pe;
  } catch (error) {
    console.error('Error obteniendo PER desde Yahoo:', error);
    return 20; // fallback
  }
}

// Obtener M2 desde FRED (usando el proxy que ya tienes, o podrías crear uno similar)
// Si no tienes proxy para FRED, puedes crearlo siguiendo el mismo patrón.
// Por ahora, asumimos que ya tienes un proxy en /api/fred. Si no, crea api/fred.js similar al de yahoo-quote pero con la URL de FRED.
async function getM2Growth(): Promise<number> {
  try {
    // Asegúrate de tener el proxy api/fred.js funcionando. Si no, usa el valor de ejemplo.
    const response = await axios.get('/api/fred?series_id=M2SL');
    const obs = response.data.observations;
    if (obs?.length < 2) throw new Error('No hay suficientes datos');
    const latest = parseFloat(obs[0].value);
    const prevYear = parseFloat(obs[1].value);
    return ((latest - prevYear) / prevYear) * 100;
  } catch (error) {
    console.error('Error obteniendo M2:', error);
    return 5.0; // fallback
  }
}

export async function getMacroExtended(): Promise<MacroExtendedData> {
  const [erp, m2Growth] = await Promise.all([
    getSP500PE().catch(() => 20),
    getM2Growth().catch(() => 5.0)
  ]);
  return { erp, m2Growth };
}