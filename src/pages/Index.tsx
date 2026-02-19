import { useState, useMemo, useCallback } from 'react';
import { Order, ASSETS, recalculateAll } from '@/lib/portfolio';
import { formatCurrency } from '@/lib/formatters';
import { KPIBar } from '@/components/dashboard/KPIBar';
import { DonutCharts } from '@/components/dashboard/DonutCharts';
import { MonteCarloChart } from '@/components/dashboard/MonteCarloChart';
import { MarketGauges } from '@/components/dashboard/MarketGauges';
import { PositionsTable } from '@/components/dashboard/PositionsTable';
import { ControlPanel } from '@/components/dashboard/ControlPanel';
import { usePortfolioStorage } from '@/hooks/usePortfolioStorage';

const Index = () => {
  const { data, loading, save } = usePortfolioStorage();
  const [version, setVersion] = useState(0);

  const results = useMemo(() => {
    return recalculateAll(
      data.positions,
      data.cashReserve,
      data.monthlyContribution,
      data.btcMinWeight,
      data.btcMaxWeight
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, version]);

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

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground animate-pulse">Cargando cartera...</div>
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
          Datos simulados · Conectar Yahoo Finance para datos en tiempo real
        </p>
      </div>
    </div>
  );
};

export default Index;
