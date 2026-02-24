import { useState, useEffect } from 'react';
import { usePortfolio, PortfolioData } from '../hooks/usePortfolio';
import { KPIBar } from '../components/dashboard/KPIBar';
import { DonutCharts } from '../components/dashboard/DonutCharts';
import { MarketGauges } from '../components/dashboard/MarketGauges';
import { PositionsTable } from '../components/dashboard/PositionsTable';
import { ControlPanel } from '../components/dashboard/ControlPanel';
import { MonteCarloChart } from '../components/dashboard/MonteCarloChart';
import { DEFAULT_POSITIONS, Asset } from '../lib/constants';
import { MacroExtendedData } from '../lib/macroExtended';

const DEFAULT_MACRO = { erp: 22, m2Growth: 5.2 };

export default function Index() {
  const [userMacro, setUserMacro] = useState<MacroExtendedData>(() => {
    const saved = localStorage.getItem('userMacro');
    return saved ? JSON.parse(saved) : DEFAULT_MACRO;
  });

  const [portfolioData, setPortfolioData] = useState<PortfolioData>(() => {
    const saved = localStorage.getItem('portfolio');
    if (saved) return JSON.parse(saved);
    return {
      positions: DEFAULT_POSITIONS,
      cashReserve: 150,
      monthlyContribution: 400,
      btcMinWeight: 0.2,
      btcMaxWeight: 0.3
    };
  });

  useEffect(() => {
    localStorage.setItem('userMacro', JSON.stringify(userMacro));
  }, [userMacro]);

  useEffect(() => {
    localStorage.setItem('portfolio', JSON.stringify(portfolioData));
  }, [portfolioData]);

  const { loading, error, results } = usePortfolio(userMacro, portfolioData);

  const handleMacroChange = (newMacro: MacroExtendedData) => {
    setUserMacro(newMacro);
  };

  const handleConfirmOrders = (orders: any[]) => {
    const newPositions = { ...portfolioData.positions };
    let newCashReserve = portfolioData.cashReserve;

    orders.forEach((order) => {
      const asset = order.ticker as Asset;
      const shares = order.shares;
      const price = order.price;
      const cost = order.cost;

      const old = newPositions[asset] || { shares: 0, avgPrice: 0 };
      const newShares = old.shares + shares;
      const newAvgPrice = (old.shares * old.avgPrice + shares * price) / newShares;
      newPositions[asset] = { shares: newShares, avgPrice: newAvgPrice };
      newCashReserve -= cost;
    });

    setPortfolioData({
      ...portfolioData,
      positions: newPositions,
      cashReserve: newCashReserve,
    });
    alert('Órdenes ejecutadas y cartera actualizada');
  };

  const handleMonthlyChange = (value: number) => {
    setPortfolioData((prev: PortfolioData) => ({ ...prev, monthlyContribution: value }));
  };

  const handleBtcMinChange = (value: number) => {
    setPortfolioData((prev: PortfolioData) => ({ ...prev, btcMinWeight: value }));
  };

  const handleBtcMaxChange = (value: number) => {
    setPortfolioData((prev: PortfolioData) => ({ ...prev, btcMaxWeight: value }));
  };

  if (loading) return <div className="p-4 text-white">Cargando datos financieros...</div>;
  if (error) return <div className="p-4 text-red-500">Error: {error.message}</div>;
  if (!results) return <div className="p-4 text-white">Sin resultados</div>;

  return (
    <div className="container mx-auto p-4 space-y-4 bg-black text-white min-h-screen">
      <h1 className="text-2xl font-bold mb-4">📊 APEX Portfolio</h1>

      <KPIBar
        regime={results.regime}
        btcPrice={results.marketData?.prices?.['BTC-EUR'] || 0}
        btcZScore={results.marketData?.btcZScore || 0}
        probability={results.probability}
        cashReserve={portfolioData.cashReserve}
        targetVol={results.targetVol}
      />

      <DonutCharts
        targetWeights={results.weights}
        riskContribution={results.riskContribution}
      />

      <MarketGauges
        marketData={results.marketData}
        macroExtended={userMacro}
        tnx={results.marketData.tnx}
        onMacroChange={handleMacroChange}
      />

      <PositionsTable
        positions={portfolioData.positions}
        prices={results.marketData.prices}
        targetWeights={results.weights}
      />

      <MonteCarloChart
        results={results.mcResults}
        probability={results.probability}
      />

      <ControlPanel
        monthlyContribution={portfolioData.monthlyContribution}
        btcMinWeight={portfolioData.btcMinWeight}
        btcMaxWeight={portfolioData.btcMaxWeight}
        orders={results.orders}
        portfolioReturn={results.portfolioReturn}
        portfolioVol={results.targetVol}
        onMonthlyChange={handleMonthlyChange}
        onBtcMinChange={handleBtcMinChange}
        onBtcMaxChange={handleBtcMaxChange}
        onRecalculate={() => {}}
        onConfirmOrders={handleConfirmOrders}
      />
    </div>
  );
}