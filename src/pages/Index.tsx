import { useState, useMemo, useCallback, useEffect } from 'react';
import { Order, MarketData, recalculateAll } from '@/lib/portfolio';
import { fetchRealMarketData } from '@/lib/marketData';
import { formatCurrency } from '@/lib/formatters';
import { KPIBar } from '@/components/dashboard/KPIBar';
import { DonutCharts } from '@/components/dashboard/DonutCharts';
import { MonteCarloChart } from '@/components/dashboard/MonteCarloChart';
import { MarketGauges } from '@/components/dashboard/MarketGauges';
import { PositionsTable } from '@/components/dashboard/PositionsTable';
import { ControlPanel } from '@/components/dashboard/ControlPanel';
import { usePortfolioStorage } from '@/hooks/usePortfolioStorage';

const Index = () => {
  const { data, loading: storageLoading, save } = usePortfolioStorage();
  const [version, setVersion] = useState(0);
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketErrors, setMarketErrors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setMarketLoading(true);
      try {
        const { marketData: md, fetchErrors } = await fetchRealMarketData();
        if (!cancelled) {
          setMarketData(md);
          setMarketErrors(fetchErrors);
        }
      } catch (e) {
        console.error('Failed to fetch market data:', e);
        if (!cancelled) {
          setMarketErrors(['Error al conectar con Yahoo Finance']);
        }
      }
      if (!cancelled) setMarketLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [version]);

  const results = useMemo(() => {
    if (!marketData) return null;
    return recalculateAll(
      data.positions,
      data.cashReserve,
      data.monthlyContribution,
      data.btcMinWeight,
      data.btcMaxWeight,
      marketData
    );
  }, [data, marketData, version]);

  const handleRecalculate = useCallback(() => setVersion(v => v + 1), []);

  const handleConfirmOrders = useCallback((orders: Order[]) => {
    const newPositions = { ...data.positions };
    let totalCost = 0;

    orders.forEach(order => {
      const existing = newPositions[order.ticker] || { shares: 0, avgPrice: 0 };
      const totalShares = existing.shares + order.shares;
      const totalCostBasis = existing.shares * existing.avgPrice + order.shares * order.price;
      newPositions[order.ticker] = {
        shares: totalShares,
        avgPrice: totalShares > 0 ? totalCostBasis / totalShares : 0,
      };
      totalCost += order.cost;
    });

    save({
      positions: newPositions,
      cashReserve: data.cashReserve - totalCost,
    });
    setVersion(v => v + 1);
  }, [data, save]);

  if (storageLoading || marketLoading || !results) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <div className="text-muted-foreground animate-pulse">
          {storageLoading ? 'Cargando cartera...' : 'Obteniendo datos de Yahoo Finance...'}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Portfolio Manager</h1>
            <p className="text-xs text-muted-foreground">
              Objetivo: {formatCurrency(150000)} en 10 años
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Valor actual</p>
            <p className="text-lg font-mono font-semibold">{formatCurrency(results.totalValue)}</p>
          </div>
        </div>

        {marketErrors.length > 0 && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
            <p className="text-xs text-destructive">
              ⚠ Error al obtener datos de: {marketErrors.join(', ')}. Se usan datos parciales.
            </p>
          </div>
        )}

        <KPIBar
          regime={results.regime}
          btcPrice={results.marketData.prices['BTC-EUR']}
          btcZScore={results.marketData.btcZScore}
          probability={results.probability}
          cashReserve={data.cashReserve}
        />

        <DonutCharts
          weights={results.weights}
          riskContribution={results.riskContribution}
        />

        <MonteCarloChart
          results={results.mcResults}
          probability={results.probability}
        />

        <MarketGauges data={results.marketData} />

        <PositionsTable
          positions={data.positions}
          prices={results.marketData.prices}
          weights={results.weights}
          totalValue={results.totalValue}
        />

        <ControlPanel
          monthlyContribution={data.monthlyContribution}
          btcMinWeight={data.btcMinWeight}
          btcMaxWeight={data.btcMaxWeight}
          orders={results.orders}
          portfolioReturn={results.portfolioReturn}
          portfolioVol={results.portfolioVol}
          onMonthlyChange={v => save({ monthlyContribution: v })}
          onBtcMinChange={v => save({ btcMinWeight: v })}
          onBtcMaxChange={v => save({ btcMaxWeight: v })}
          onRecalculate={handleRecalculate}
          onConfirmOrders={handleConfirmOrders}
        />

        <p className="text-center text-xs text-muted-foreground pb-4">
          Datos en tiempo real · Yahoo Finance
        </p>
      </div>
    </div>
  );
};

export default Index;
