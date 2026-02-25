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
  console.log('handleMacroChange llamado con', newMacro); // DEPURACIÓN
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
      {/* AÑADE ESTE BLOQUE DESPUÉS DE <ControlPanel> O DONDE PREFIERAS */}
<div className="bg-gray-800 p-4 rounded-lg shadow mt-4">
  <h3 className="text-lg font-semibold mb-4 text-white">Actualización manual</h3>
  <div className="grid grid-cols-2 gap-4">
    <div>
      <label className="block text-sm font-medium text-gray-300">Reserva manual (€)</label>
      <input
        type="number"
        value={portfolioData.cashReserve}
        onChange={(e) => {
          const newReserve = Number(e.target.value);
          if (!isNaN(newReserve) && newReserve >= 0) {
            setPortfolioData(prev => ({
              ...prev,
              cashReserve: newReserve
            }));
          }
        }}
        className="mt-1 block w-full rounded-md border-gray-600 bg-gray-700 text-white shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
        min="0"
        step="10"
      />
      <p className="text-xs text-gray-400 mt-1">Actualiza directamente tu efectivo disponible</p>
    </div>
    <div>
      <label className="block text-sm font-medium text-gray-300">Comprar BTC (fracción)</label>
      <div className="flex gap-2">
        <input
          type="number"
          id="btc-purchase"
          placeholder="0.001"
          step="0.001"
          min="0"
          className="mt-1 block w-full rounded-md border-gray-600 bg-gray-700 text-white shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
        />
        <button
          onClick={() => {
            const input = document.getElementById('btc-purchase') as HTMLInputElement;
            const btcToAdd = parseFloat(input.value);
            if (isNaN(btcToAdd) || btcToAdd <= 0) {
              alert('Introduce una cantidad válida de BTC');
              return;
            }
          
            const currentPrice = results?.marketData?.prices?.['BTC-EUR'] || 0;
            const cost = btcToAdd * currentPrice;

            if (cost > portfolioData.cashReserve) {
              alert('No hay suficiente reserva para comprar esa cantidad');
              return;
            }

            setPortfolioData(prev => {
              const newPositions = { ...prev.positions };
              const old = newPositions['BTC-EUR'] || { shares: 0, avgPrice: 0 };
              const newShares = old.shares + btcToAdd;
              const newAvgPrice = (old.shares * old.avgPrice + btcToAdd * currentPrice) / newShares;

              newPositions['BTC-EUR'] = { shares: newShares, avgPrice: newAvgPrice };

              return {
                ...prev,
                positions: newPositions,
                cashReserve: prev.cashReserve - cost
              };
            });

            input.value = '';
            alert(`Comprados ${btcToAdd} BTC por ${(cost).toFixed(2)} €`);
          }}
          className="mt-1 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
        >
          Comprar
        </button>
      </div>
      <p className="text-xs text-gray-400 mt-1">Introduce fracción (ej. 0.005) y pulsa Comprar</p>
    </div>
  </div>
</div>
    </div>
  );
}