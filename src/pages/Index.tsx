import { useState, useEffect } from 'react';
import { usePortfolio, PortfolioData } from '../hooks/usePortfolio';
import { KPIBar } from '../components/dashboard/KPIBar';
import { DonutCharts } from '../components/dashboard/DonutCharts';
import { MarketGauges } from '../components/dashboard/MarketGauges';
import { ControlPanel } from '../components/dashboard/ControlPanel';
import { MonteCarloChart } from '../components/dashboard/MonteCarloChart';
import { DEFAULT_POSITIONS, ASSETS, Asset } from '../lib/constants';
import { MacroExtendedData, DEFAULT_MACRO } from '../lib/macroExtended';

// Componente de tabla editable
const EditablePositionsTable: React.FC<{
  positions: Record<Asset, { shares: number; avgPrice: number }>;
  prices: Record<Asset, number>;
  onUpdate: (asset: Asset, field: 'shares' | 'avgPrice', value: number) => void;
}> = ({ positions, prices, onUpdate }) => {
  // Calcular total invertido y valor actual
  const totalInvested = ASSETS.reduce((sum, asset) => {
    const pos = positions[asset] || { shares: 0, avgPrice: 0 };
    return sum + pos.shares * pos.avgPrice;
  }, 0);

  const currentTotal = ASSETS.reduce((sum, asset) => {
    const pos = positions[asset] || { shares: 0, avgPrice: 0 };
    return sum + pos.shares * (prices[asset] || 0);
  }, 0);

  const totalGainLoss = currentTotal - totalInvested;
  const totalGainLossPct = totalInvested > 0 ? (totalGainLoss / totalInvested) : 0;

  return (
    <div className="bg-gray-800 p-6 rounded-xl border border-slate-700 shadow-lg">
      {/* Resumen superior */}
      <div className="grid grid-cols-3 gap-4 mb-6 p-4 bg-slate-700/30 rounded-lg">
        <div>
          <div className="text-sm text-slate-400">Valor cartera</div>
          <div className="text-xl font-bold text-white">
            {new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(currentTotal)}
          </div>
        </div>
        <div>
          <div className="text-sm text-slate-400">Coste total</div>
          <div className="text-xl font-bold text-white">
            {new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(totalInvested)}
          </div>
        </div>
        <div>
          <div className="text-sm text-slate-400">Ganancia/Pérdida</div>
          <div className={`text-xl font-bold ${totalGainLoss >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(totalGainLoss)}
            {' '}
            <span className="text-sm">
              ({((totalGainLoss / (totalInvested || 1)) * 100).toFixed(1)}%)
            </span>
          </div>
        </div>
      </div>

      <table className="w-full text-sm text-white">
        <thead>
          <tr className="border-b border-slate-700">
            <th className="text-left p-2 text-slate-400">Activo</th>
            <th className="text-right p-2 text-slate-400">Shares</th>
            <th className="text-right p-2 text-slate-400">Precio Medio (€)</th>
            <th className="text-right p-2 text-slate-400">Precio Actual</th>
            <th className="text-right p-2 text-slate-400">Valor</th>
            <th className="text-right p-2 text-slate-400">Ganancia/Pérdida</th>
          </tr>
        </thead>
        <tbody>
          {ASSETS.map((asset) => {
            const pos = positions[asset] || { shares: 0, avgPrice: 0 };
            const price = prices[asset] || 0;
            const value = pos.shares * price;
            const cost = pos.shares * pos.avgPrice;
            const gainLoss = value - cost;
            const gainLossPct = cost > 0 ? (gainLoss / cost) * 100 : 0;

            return (
              <tr key={asset} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                <td className="p-2 font-medium">{asset}</td>
                <td className="p-2">
                  <input
                    type="number"
                    value={pos.shares}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val) && val >= 0) {
                        onUpdate(asset, 'shares', val);
                      }
                    }}
                    step={asset === 'BTC-EUR' ? '0.000001' : '1'}
                    min="0"
                    className="w-full bg-gray-700 text-white rounded px-2 py-1 text-right"
                  />
                </td>
                <td className="p-2">
                  <input
                    type="number"
                    value={pos.avgPrice}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val) && val >= 0) {
                        onUpdate(asset, 'avgPrice', val);
                      }
                    }}
                    step="0.01"
                    min="0"
                    className="w-full bg-gray-700 text-white rounded px-2 py-1 text-right"
                  />
                </td>
                <td className="text-right p-2">{price.toFixed(2)} €</td>
                <td className="text-right p-2">{value.toFixed(2)} €</td>
                <td className={`text-right p-2 ${gainLoss >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {gainLoss.toFixed(2)} € ({gainLossPct.toFixed(1)}%)
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

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

  const handlePositionUpdate = (asset: Asset, field: 'shares' | 'avgPrice', value: number) => {
    setPortfolioData(prev => {
      const updatedPositions = {
        ...prev.positions,
        [asset]: {
          ...prev.positions[asset],
          [field]: value
        }
      };
      return { ...prev, positions: updatedPositions };
    });
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

    setPortfolioData(prev => ({
      ...prev,
      positions: newPositions,
      cashReserve: newCashReserve,
    }));
    alert('Órdenes ejecutadas');
  };

  const handleMonthlyChange = (value: number) => {
    setPortfolioData(prev => ({ ...prev, monthlyContribution: value }));
  };

  const handleBtcMinChange = (value: number) => {
    setPortfolioData(prev => ({ ...prev, btcMinWeight: value }));
  };

  const handleBtcMaxChange = (value: number) => {
    setPortfolioData(prev => ({ ...prev, btcMaxWeight: value }));
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

      <EditablePositionsTable
        positions={portfolioData.positions}
        prices={results.marketData.prices}
        onUpdate={handlePositionUpdate}
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

      {/* Input para reserva manual */}
      <div className="bg-gray-800 p-4 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-2 text-white">Reserva de efectivo</h3>
        <div className="flex items-center gap-4">
          <input
            type="number"
            value={portfolioData.cashReserve}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (!isNaN(val) && val >= 0) {
                setPortfolioData(prev => ({ ...prev, cashReserve: val }));
              }
            }}
            className="w-40 bg-gray-700 text-white rounded px-2 py-1"
            step="10"
            min="0"
          />
          <span className="text-gray-400">€</span>
        </div>
      </div>
    </div>
  );
}