// src/components/dashboard/PositionsTable.tsx
import React from 'react';
import { ASSETS, Asset } from '@/lib/constants';
import { formatCurrency, formatPercentage } from '@/lib/formatters';

interface PositionsTableProps {
  positions: Record<Asset, { shares: number; avgPrice: number }>;
  prices: Record<Asset, number>;
  targetWeights: number[];
  totalValue: number; // aunque no se use directamente, se requiere por la interfaz
}

export const PositionsTable: React.FC<PositionsTableProps> = ({
  positions,
  prices,
  targetWeights,
  totalValue // lo recibimos pero no lo usamos, o podemos usarlo para calcular el total invertido
}) => {
  // Calculamos el total invertido (sin la reserva)
  const totalInvested = ASSETS.reduce(
    (sum, asset) => sum + (positions[asset]?.shares * prices[asset] || 0),
    0
  );

  return (
    <div className="bg-gray-800 p-4 rounded-lg shadow overflow-x-auto">
      <table className="w-full text-sm text-white">
        <thead>
          <tr className="border-b border-gray-600">
            <th className="text-left p-2">Activo</th>
            <th className="text-right p-2">Shares</th>
            <th className="text-right p-2">Precio Medio</th>
            <th className="text-right p-2">Precio Actual</th>
            <th className="text-right p-2">Valor</th>
            <th className="text-right p-2">Desv. vs Obj.</th>
          </tr>
        </thead>
        <tbody>
          {ASSETS.map((asset, i) => {
            const pos = positions[asset] || { shares: 0, avgPrice: 0 };
            const price = prices[asset] || 0;
            const value = pos.shares * price;
            const currentWeight = totalInvested > 0 ? value / totalInvested : 0;
            const targetWeight = targetWeights[i] || 0;
            const deviation = currentWeight - targetWeight;
            const deviationColor =
              deviation > 0.01
                ? 'text-green-400'
                : deviation < -0.01
                ? 'text-red-400'
                : 'text-gray-400';

            return (
              <tr key={asset} className="border-b border-gray-700 hover:bg-gray-700">
                <td className="p-2 font-medium">{asset}</td>
                <td className="text-right p-2">{pos.shares.toFixed(4)}</td>
                <td className="text-right p-2">{formatCurrency(pos.avgPrice)}</td>
                <td className="text-right p-2">{formatCurrency(price)}</td>
                <td className="text-right p-2">{formatCurrency(value)}</td>
                <td className={`text-right p-2 ${deviationColor}`}>
                  {formatPercentage(deviation)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};