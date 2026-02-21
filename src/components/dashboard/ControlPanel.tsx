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
  onMonthlyChange: (v: number) => void;
  onBtcMinChange: (v: number) => void;
  onBtcMaxChange: (v: number) => void;
  onRecalculate: () => void;
  onConfirmOrders: (orders: Order[]) => void;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  monthlyContribution, btcMinWeight, btcMaxWeight, orders,
  portfolioReturn, portfolioVol,
  onMonthlyChange, onBtcMinChange, onBtcMaxChange, onRecalculate, onConfirmOrders
}) => {
  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <h3 className="text-lg font-semibold mb-4">Controles de optimización</h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div><label className="block text-sm font-medium text-gray-700">Aporte mensual (€)</label>
          <input type="number" value={monthlyContribution} onChange={e => onMonthlyChange(Number(e.target.value))} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm" min="0" step="50" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="block text-sm font-medium text-gray-700">BTC min</label>
            <input type="number" value={btcMinWeight} onChange={e => onBtcMinChange(Number(e.target.value))} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm" min="0" max="0.4" step="0.01" />
          </div>
          <div><label className="block text-sm font-medium text-gray-700">BTC max</label>
            <input type="number" value={btcMaxWeight} onChange={e => onBtcMaxChange(Number(e.target.value))} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm" min={btcMinWeight} max="0.4" step="0.01" />
          </div>
        </div>
      </div>
      <div className="flex justify-between items-center mb-4">
        <div><span className="text-sm text-gray-500">Retorno esperado: </span><span className="font-medium">{formatPercentage(portfolioReturn)}</span></div>
        <div><span className="text-sm text-gray-500">Volatilidad: </span><span className="font-medium">{formatPercentage(portfolioVol)}</span></div>
        <button onClick={onRecalculate} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Recalcular</button>
      </div>
      {orders.length > 0 && (
        <div className="border-t pt-4">
          <h4 className="font-semibold mb-2">Órdenes sugeridas</h4>
          <table className="w-full text-sm mb-4">
            <thead><tr className="border-b"><th className="text-left p-1">Activo</th><th className="text-right p-1">Unidades</th><th className="text-right p-1">Precio</th><th className="text-right p-1">Coste</th></tr></thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.ticker}>
                  <td className="p-1">{order.ticker}</td>
                  <td className="text-right p-1">{order.shares.toFixed(4)}</td>
                  <td className="text-right p-1">{formatCurrency(order.price)}</td>
                  <td className="text-right p-1">{formatCurrency(order.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => onConfirmOrders(orders)} className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700">Confirmar ejecución</button>
        </div>
      )}
    </div>
  );
};