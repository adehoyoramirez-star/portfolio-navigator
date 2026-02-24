import React from 'react';
import { Order } from '@/lib/portfolio';
import { formatCurrency, formatPercentage } from '@/lib/formatters';

interface ControlPanelProps {
  monthlyContribution: number;
  btcMinWeight: number;
  btcMaxWeight: number;
  orders: Order[];
  portfolioReturn: number;
  portfolioVol: number;
  onMonthlyChange: (value: number) => void;
  onBtcMinChange: (value: number) => void;
  onBtcMaxChange: (value: number) => void;
  onRecalculate: () => void;
  onConfirmOrders: (orders: Order[]) => void;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  monthlyContribution,
  btcMinWeight,
  btcMaxWeight,
  orders,
  portfolioReturn,
  portfolioVol,
  onMonthlyChange,
  onBtcMinChange,
  onBtcMaxChange,
  onRecalculate,
  onConfirmOrders
}) => {
  return (
    <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-6 rounded-xl border border-slate-700 shadow-lg">
      <h3 className="text-lg font-semibold mb-4 text-white">Controles de optimización</h3>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Aporte mensual (€)</label>
          <input
            type="number"
            value={monthlyContribution}
            onChange={(e) => onMonthlyChange(Number(e.target.value))}
            className="mt-1 block w-full rounded-lg border-slate-600 bg-slate-800 text-white shadow-sm 
                       focus:border-blue-500 focus:ring focus:ring-blue-500/20 transition"
            min="0"
            step="50"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">BTC min</label>
            <input
              type="number"
              value={btcMinWeight}
              onChange={(e) => onBtcMinChange(Number(e.target.value))}
              className="mt-1 block w-full rounded-lg border-slate-600 bg-slate-800 text-white shadow-sm 
                         focus:border-blue-500 focus:ring focus:ring-blue-500/20 transition"
              min="0"
              max="0.4"
              step="0.01"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">BTC max</label>
            <input
              type="number"
              value={btcMaxWeight}
              onChange={(e) => onBtcMaxChange(Number(e.target.value))}
              className="mt-1 block w-full rounded-lg border-slate-600 bg-slate-800 text-white shadow-sm 
                         focus:border-blue-500 focus:ring focus:ring-blue-500/20 transition"
              min={btcMinWeight}
              max="0.4"
              step="0.01"
            />
          </div>
        </div>
      </div>

      <div className="flex justify-between items-center mb-4">
        <div>
          <span className="text-sm text-slate-400">Retorno esperado: </span>
          <span className="font-medium text-white">{formatPercentage(portfolioReturn)}</span>
        </div>
        <div>
          <span className="text-sm text-slate-400">Volatilidad: </span>
          <span className="font-medium text-white">{formatPercentage(portfolioVol)}</span>
        </div>
        <button
          onClick={onRecalculate}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 
                     focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition"
        >
          Recalcular
        </button>
      </div>

      {orders.length > 0 && (
        <div className="border-t border-slate-700 pt-4">
          <h4 className="font-semibold mb-2 text-white">Órdenes sugeridas</h4>
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-b border-slate-700">
                <th className="text-left p-2 text-slate-400">Activo</th>
                <th className="text-right p-2 text-slate-400">Unidades</th>
                <th className="text-right p-2 text-slate-400">Precio</th>
                <th className="text-right p-2 text-slate-400">Coste</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.ticker} className="border-b border-slate-700/50 hover:bg-slate-700/20 transition-colors">
                  <td className="p-2 text-white">{order.ticker}</td>
                  <td className="text-right p-2 text-white font-mono">{order.shares.toFixed(4)}</td>
                  <td className="text-right p-2 text-white font-mono">{formatCurrency(order.price)}</td>
                  <td className="text-right p-2 text-white font-mono">{formatCurrency(order.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={() => onConfirmOrders(orders)}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 
                       focus:outline-none focus:ring-2 focus:ring-green-500/50 transition"
          >
            Confirmar ejecución
          </button>
        </div>
      )}
    </div>
  );
};