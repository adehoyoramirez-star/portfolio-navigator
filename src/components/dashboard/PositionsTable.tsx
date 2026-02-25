import React from 'react';
import { ASSETS, Asset } from '@/lib/constants';
import { formatCurrency, formatPercentage } from '@/lib/formatters';

interface PositionsTableProps {
  positions: Record<Asset, { shares: number; avgPrice: number }>;
  prices: Record<Asset, number>;
  targetWeights: number[];
}

export const PositionsTable: React.FC<PositionsTableProps> = ({
  positions,
  prices,
  targetWeights,
}) => {
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
    <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-6 rounded-xl border border-slate-700 shadow-lg overflow-x-auto">
      {/* Resumen superior */}
      <div className="grid grid-cols-3 gap-4 mb-6 p-4 bg-slate-700/30 rounded-lg">
        <div>
          <div className="text-sm text-slate-400">Valor cartera</div>
          <div className="text-xl font-bold text-white">{formatCurrency(currentTotal)}</div>
        </div>
        <div>
          <div className="text-sm text-slate-400">Coste total</div>
          <div className="text-xl font-bold text-white">{formatCurrency(totalInvested)}</div>
        </div>
        <div>
          <div className="text-sm text-slate-400">Ganancia/Pérdida</div>
          <div className={`text-xl font-bold ${totalGainLoss >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {formatCurrency(totalGainLoss)} ({formatPercentage(totalGainLossPct)})
          </div>
        </div>
      </div>

      <table className="w-full text-sm text-white">
        <thead>
          <tr className="border-b border-slate-700">
            <th className="text-left p-3 text-slate-400 font-medium">Activo</th>
            <th className="text-right p-3 text-slate-400 font-medium">Shares</th>
            <th className="text-right p-3 text-slate-400 font-medium">Precio Medio</th>
            <th className="text-right p-3 text-slate-400 font-medium">Precio Actual</th>
            <th className="text-right p-3 text-slate-400 font-medium">Valor</th>
            <th className="text-right p-3 text-slate-400 font-medium">Ganancia/Pérdida</th>
            <th className="text-right p-3 text-slate-400 font-medium">Desv. vs Obj.</th>
          </tr>
        </thead>
        <tbody>
          {ASSETS.map((asset, i) => {
            const pos = positions[asset] || { shares: 0, avgPrice: 0 };
            const price = prices[asset] || 0;
            const value = pos.shares * price;
            const cost = pos.shares * pos.avgPrice;
            const gainLoss = value - cost;
            const gainLossPct = cost > 0 ? gainLoss / cost : 0;

            const currentWeight = totalInvested > 0 ? value / currentTotal : 0;
            const targetWeight = targetWeights[i] || 0;
            const deviation = currentWeight - targetWeight;
            const deviationColor = deviation > 0.01 ? 'text-green-400' : deviation < -0.01 ? 'text-red-400' : 'text-slate-400';
            const deviationPercent = Math.min(Math.abs(deviation) * 100, 100);

            return (
              <tr key={asset} className="border-b border-slate-700/50 hover:bg-slate-700/20 transition-colors">
                <td className="p-3 font-medium">{asset}</td>
                <td className="text-right p-3 font-mono">{pos.shares.toFixed(4)}</td>
                <td className="text-right p-3 font-mono">{formatCurrency(pos.avgPrice)}</td>
                <td className="text-right p-3 font-mono">{formatCurrency(price)}</td>
                <td className="text-right p-3 font-mono">{formatCurrency(value)}</td>
                <td className="text-right p-3 font-mono">
                  <span className={gainLoss >= 0 ? 'text-green-400' : 'text-red-400'}>
                    {formatCurrency(gainLoss)} ({formatPercentage(gainLossPct)})
                  </span>
                </td>
                <td className={`text-right p-3 font-mono ${deviationColor}`}>
                  {formatPercentage(deviation)}
                  <div className="flex justify-end mt-1">
                    {deviation > 0 && (
                      <div className="w-16 h-1 bg-green-500/20 rounded-full overflow-hidden">
                        <div className="h-full bg-green-500 rounded-full" style={{ width: `${deviationPercent}%` }} />
                      </div>
                    )}
                    {deviation < 0 && (
                      <div className="w-16 h-1 bg-red-500/20 rounded-full overflow-hidden">
                        <div className="h-full bg-red-500 rounded-full" style={{ width: `${deviationPercent}%` }} />
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};