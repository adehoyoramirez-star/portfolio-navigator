import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Position, DEFAULT_POSITIONS } from '@/lib/portfolio';

interface PortfolioData {
  positions: Record<string, Position>;
  cashReserve: number;
  monthlyContribution: number;
  btcMinWeight: number;
  btcMaxWeight: number;
}

export function usePortfolioStorage() {
  const [data, setData] = useState<PortfolioData>({
    positions: DEFAULT_POSITIONS,
    cashReserve: 150,
    monthlyContribution: 400,
    btcMinWeight: 0.20,
    btcMaxWeight: 0.30,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const { data: row } = await supabase
          .from('portfolio')
          .select('*')
          .eq('id', 'default')
          .maybeSingle();

        if (row) {
          setData({
            positions: (row.positions as any) || DEFAULT_POSITIONS,
            cashReserve: row.cash_reserve ?? 150,
            monthlyContribution: row.monthly_contribution ?? 400,
            btcMinWeight: row.btc_min_weight ?? 0.20,
            btcMaxWeight: row.btc_max_weight ?? 0.30,
          });
        }
      } catch (e) {
        console.error('Error loading portfolio:', e);
      }
      setLoading(false);
    }
    load();
  }, []);

  const save = useCallback(async (update: Partial<PortfolioData>) => {
    const newData = { ...data, ...update };
    setData(newData);

    try {
      await supabase
        .from('portfolio')
        .upsert({
          id: 'default',
          cash_reserve: newData.cashReserve,
          positions: newData.positions as any,
          monthly_contribution: newData.monthlyContribution,
          btc_min_weight: newData.btcMinWeight,
          btc_max_weight: newData.btcMaxWeight,
          last_updated: new Date().toISOString(),
        });
    } catch (e) {
      console.error('Error saving portfolio:', e);
    }
  }, [data]);

  return { data, loading, save };
}
