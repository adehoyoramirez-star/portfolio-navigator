import { useState, useEffect } from 'react';
import { ASSETS, DEFAULT_POSITIONS } from '../lib/constants';
import { recalculateAll } from '../lib/portfolio';
import { getMacroExtended, MacroExtendedData } from '../lib/macroExtended';

export function usePortfolio() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [results, setResults] = useState<any>(null);
  const [macroExtended, setMacroExtended] = useState<MacroExtendedData | null>(null);
  const [data, setData] = useState({
    positions: DEFAULT_POSITIONS,
    cashReserve: 150,
    monthlyContribution: 400,
    btcMinWeight: 0.2,
    btcMaxWeight: 0.3
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        // Datos de cartera y mercado
        const res = await recalculateAll(
          data.positions,
          data.cashReserve,
          data.monthlyContribution,
          data.btcMinWeight,
          data.btcMaxWeight
        );
        setResults(res);

        // Datos macro extendidos (ERP, M2)
        const macroExt = await getMacroExtended();
        setMacroExtended(macroExt);

        setError(null);
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [data]); // Se ejecuta cada vez que cambia data

  return { loading, error, results, data, macroExtended, setData };
}