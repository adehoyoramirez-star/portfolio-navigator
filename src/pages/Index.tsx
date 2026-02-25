import { useState, useEffect } from 'react';
import { usePortfolio, PortfolioData } from '../hooks/usePortfolio';
import { KPIBar } from '../components/dashboard/KPIBar';
import { DonutCharts } from '../components/dashboard/DonutCharts';
import { MarketGauges } from '../components/dashboard/MarketGauges';
import { PositionsTable } from '../components/dashboard/PositionsTable';
import { ControlPanel } from '../components/dashboard/ControlPanel';
import { MonteCarloChart } from '../components/dashboard/MonteCarloChart';
import { DEFAULT_POSITIONS, ASSETS, Asset } from '../lib/constants';
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

  // Estado local para la edición de posiciones (valores temporales mientras se escribe)
  const [editablePositions, setEditablePositions] = useState(portfolioData.positions);

  // Sincronizar editablePositions cuando cambia portfolioData desde fuera (ej. compra automática)
  useEffect(() => {
    setEditablePositions(portfolioData.positions);
  }, [portfolioData.positions]);

  useEffect(() => {
    localStorage.setItem('userMacro', JSON.stringify(userMacro));
  }, [userMacro]);

  useEffect(() => {
    localStorage.setItem('portfolio', JSON.stringify(portfolioData));
  }, [portfolioData]);

  const { loading, error, results } = usePortfolio(userMacro, portfolioData);

  const handleMacroChange = (newMacro: MacroExtendedData) => {
    console.log('handleMacroChange llamado con', newMacro);
    setUserMacro(newMacro);
  };

  // Función para actualizar shares y avgPrice de un activo
  const updatePosition = (asset: Asset, field: 'shares' | 'avgPrice', value: number) => {
    if (value < 0) return; // No permitir negativos
    const updated = {
      ...editablePositions[asset],
      [field]: value
    };
    const newEditable = { ...editablePositions, [asset]: updated };
    setEditablePositions(newEditable);
  };

  // Aplicar cambios al perder el foco del input (o al pulsar "Guardar")
  const applyPositionChanges = () => {
    setPortfolioData(prev => ({
      ...prev,
      positions: editablePositions
    }));
  };

  // Si quieres guardar automáticamente al salir del input, puedes llamar a applyPositionChanges en onBlur.
  // Yo lo dejaré con un botón "Guardar cambios" para mayor control.

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

      {/* Tabla de posiciones EDITABLE */}
      <div className="bg-gray-800 p-4 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4 text-white">Edición manual de posiciones</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-white">
            <thead>
              <tr className="border-b border-gray-600">
                <th className="text-left p-2">Activo</th>
                <th className="text-right p-2">Shares (editable)</th>
                <th className="text-right p-2">Precio medio (€)</th>
                <th className="text-right p-2">Precio actual</th>
                <th className="text-right p-2">Valor estimado</th>
              </tr>
            </thead>
            <tbody>
              {ASSETS.map((asset) => {
                const pos = editablePositions[asset] || { shares: 0, avgPrice: 0 };
                const currentPrice = results.marketData.prices[asset] || 0;
                const estimatedValue = pos.shares * currentPrice;

                return (
                  <tr key={asset} className="border-b border-gray-700 hover:bg-gray-700">
                    <td className="p-2 font-medium">{asset}</td>
                    <td className="p-2">
                      <input
                        type="number"
                        value={pos.shares}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val) && val >= 0) {
                            updatePosition(asset, 'shares', val);
                          }
                        }}
                        onBlur={applyPositionChanges} // Guarda al salir del campo
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
                            updatePosition(asset, 'avgPrice', val);
                          }
                        }}
                        onBlur={applyPositionChanges}
                        step="0.01"
                        min="0"
                        className="w-full bg-gray-700 text-white rounded px-2 py-1 text-right"
                      />
                    </td>
                    <td className="text-right p-2">{currentPrice.toFixed(2)} €</td>
                    <td className="text-right p-2">{estimatedValue.toFixed(2)} €</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end mt-4">
          <button
            onClick={applyPositionChanges}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Guardar cambios
          </button>
        </div>
      </div>

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

      {/* Bloque de actualización manual de reserva (opcional, ya tenemos reserva en tabla) */}
      <div className="bg-gray-800 p-4 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4 text-white">Reserva de efectivo</h3>
        <div className="flex items-center gap-4">
          <input
            type="number"
            value={portfolioData.cashReserve}
            onChange={(e) => {
              const newReserve = Number(e.target.value);
              if (!isNaN(newReserve) && newReserve >= 0) {
                setPortfolioData(prev => ({ ...prev, cashReserve: newReserve }));
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