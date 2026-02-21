// src/pages/Index.tsx
import React, { useState } from 'react';
import { usePortfolio } from '../hooks/usePortfolio';
import { KPIBar } from '../components/dashboard/KPIBar';
import { DonutCharts } from '../components/dashboard/DonutCharts';
import { MarketGauges } from '../components/dashboard/MarketGauges';
import { PositionsTable } from '../components/dashboard/PositionsTable';
import { ControlPanel } from '../components/dashboard/ControlPanel';
import { MonteCarloChart } from '../components/dashboard/MonteCarloChart';
import { Asset } from '../lib/constants';

// Tipo para los datos del portfolio (necesario para setData)
interface PortfolioData {
  positions: Record<Asset, { shares: number; avgPrice: number }>;
  cashReserve: number;
  monthlyContribution: number;
  btcMinWeight: number;
  btcMaxWeight: number;
}

export default function Index() {
  const { loading, error, results, data, macroExtended, setData } = usePortfolio();
  const [version, setVersion] = useState(0); // Para forzar recálculos si es necesario

  if (loading) return <div className="p-4">Cargando datos financieros...</div>;
  if (error) return <div className="p-4 text-red-500">Error: {error.message}</div>;
  if (!results) return <div className="p-4">Sin resultados</div>;

  const handleRecalculate = () => setVersion(v => v + 1);
  const handleConfirmOrders = (orders: any[]) => alert('Órdenes confirmadas (simulado)');
  const handleMonthlyChange = (value: number) => setData((prev: PortfolioData) => ({ ...prev, monthlyContribution: value }));
  const handleBtcMinChange = (value: number) => setData((prev: PortfolioData) => ({ ...prev, btcMinWeight: value }));
  const handleBtcMaxChange = (value: number) => setData((prev: PortfolioData) => ({ ...prev, btcMaxWeight: value }));

  return (
    <div className="container mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold mb-4">📊 APEX Portfolio (Datos Reales)</h1>

      <KPIBar
        regime={results.regime}
        btcPrice={results.marketData?.prices?.['BTC-EUR'] || 0}
        btcZScore={results.marketData?.btcZScore || 0}
        probability={results.probability}
        cashReserve={data.cashReserve}
        targetVol={results.targetVol}
      />

      <DonutCharts
        targetWeights={results.weights}
        riskContribution={results.riskContribution}
      />

      <MarketGauges marketData={results.marketData} />

      <PositionsTable
        positions={data.positions}
        prices={results.marketData.prices}
        targetWeights={results.weights}
        totalValue={results.totalValue}
      />

      <MonteCarloChart
        results={results.mcResults}
        probability={results.probability}
      />

      <ControlPanel
        monthlyContribution={data.monthlyContribution}
        btcMinWeight={data.btcMinWeight}
        btcMaxWeight={data.btcMaxWeight}
        orders={results.orders}
        portfolioReturn={results.portfolioReturn}
        portfolioVol={results.targetVol}
        onMonthlyChange={handleMonthlyChange}
        onBtcMinChange={handleBtcMinChange}
        onBtcMaxChange={handleBtcMaxChange}
        onRecalculate={handleRecalculate}
        onConfirmOrders={handleConfirmOrders}
      />
    </div>
  );
}