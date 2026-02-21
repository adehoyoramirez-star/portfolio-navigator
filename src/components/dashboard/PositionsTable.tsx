import React from 'react';
import { ASSETS, Asset } from '@/lib/constants';
import { formatCurrency, formatPercentage } from '@/lib/formatters';

interface PositionsTableProps {
  positions: Record<Asset, { shares: number; avgPrice: number }>;
  prices: Record<Asset, number>;
  targetWeights: number[];
  totalValue: number;
}

export const PositionsTable: React.FC<PositionsTableProps> = ({ positions, prices, targetWeights, totalValue }) => {
  const totalInvested = ASSETS.reduce((s, a) => s + (positions[a]?.shares * prices[a] || 0), 0);
  return (
    <div className="bg-white p-4 rounded-lg shadow overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="border-b"><th className="text-left p-2">Activo</th><th className="text-right p-2">Shares</th><th className="text-right p-2">Precio Medio</th><th className="text-right p-2">Precio Actual</th><th className="text-right p-2">Valor</th><th className="text-right p-2">Desv. vs Obj.</th></tr></thead>
        <tbody>
          {ASSETS.map((asset, i) => {
            const pos = positions[asset] || { shares: 0, avgPrice: 0 };
            const price = prices[asset] || 0;
            const value = pos.shares * price;
            const currentWeight = totalInvested > 0 ? value / totalInvested : 0;
            const targetWeight = targetWeights[i] || 0;
            const deviation = currentWeight - targetWeight;
            const deviationColor = deviation > 0.01 ? 'text-red-500' : deviation < -0.01 ? 'text-green-500' : 'text-gray-500';
            return (
              <tr key={asset} className="border-b hover:bg-gray-50">
                <td className="p-2 font-medium">{asset}</td>
                <td className="text-right p-2">{pos.shares.toFixed(4)}</td>
                <td className="text-right p-2">{formatCurrency(pos.avgPrice)}</td>
                <td className="text-right p-2">{formatCurrency(price)}</td>
                <td className="text-right p-2">{formatCurrency(value)}</td>
                <td className={`text-right p-2 ${deviationColor}`}>{formatPercentage(deviation)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};