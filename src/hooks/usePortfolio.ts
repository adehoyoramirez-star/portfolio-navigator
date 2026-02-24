import { useState, useEffect } from 'react';
import { recalculateAll } from '../lib/portfolio';
import { MacroExtendedData } from '../lib/macroExtended';
import { Asset } from '../lib/constants';

export interface PortfolioData {
  positions: Record<Asset, { shares: number; avgPrice: number }>;
  cashReserve: number;
  monthlyContribution: number;
  btcMinWeight: number;
  btcMaxWeight: number;
}

export function usePortfolio(
  userMacro: MacroExtendedData | null,
  portfolioData: PortfolioData
) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [results, setResults] = useState<any>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const res = await recalculateAll(
          portfolioData.positions,
          portfolioData.cashReserve,
          portfolioData.monthlyContribution,
          portfolioData.btcMinWeight,
          portfolioData.btcMaxWeight,
          userMacro
        );
        setResults(res);
        setError(null);
      } catch (err) {
        setError(err as Error);
        console.error('Error en usePortfolio:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [portfolioData, userMacro]);

  return { loading, error, results };
}