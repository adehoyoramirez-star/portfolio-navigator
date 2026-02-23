import React from 'react';
import { MarketData } from '@/lib/portfolio';
import { MacroExtendedData } from '@/lib/macroExtended';

interface MarketGaugesProps {
  marketData: MarketData;
  macroExtended: MacroExtendedData | null;
  tnx: number;
}

export const MarketGauges: React.FC<MarketGaugesProps> = ({ marketData }) => {
  const { vix, tnx, irx, btcZScore } = marketData;
  const tedSpread = tnx - irx;
  const getVixColor = (v: number) => v < 20 ? 'text-green-600' : v < 30 ? 'text-yellow-600' : 'text-red-600';
  const getTedColor = (s: number) => s < 0 ? 'text-red-600' : s < 1 ? 'text-yellow-600' : 'text-green-600';
  const getRateColor = (r: number) => r < 2 ? 'text-green-600' : r < 4 ? 'text-yellow-600' : 'text-red-600';
  const getZColor = (z: number) => (z < -2 || z > 2) ? 'text-red-600' : (z < -1 || z > 1) ? 'text-yellow-600' : 'text-green-600';

  return (
    <div className="grid grid-cols-4 gap-4">
      <div className="bg-white p-4 rounded-lg shadow text-center"><div className="text-sm text-gray-500">VIX</div><div className={`text-2xl font-bold ${getVixColor(vix)}`}>{vix.toFixed(1)}</div></div>
      <div className="bg-white p-4 rounded-lg shadow text-center"><div className="text-sm text-gray-500">Curva 10y-3m</div><div className={`text-2xl font-bold ${getTedColor(tedSpread)}`}>{(tedSpread * 100).toFixed(0)} pb</div></div>
      <div className="bg-white p-4 rounded-lg shadow text-center"><div className="text-sm text-gray-500">Tipo 10 años</div><div className={`text-2xl font-bold ${getRateColor(tnx)}`}>{tnx.toFixed(1)}%</div></div>
      <div className="bg-white p-4 rounded-lg shadow text-center"><div className="text-sm text-gray-500">Z-score BTC</div><div className={`text-2xl font-bold ${getZColor(btcZScore)}`}>{btcZScore.toFixed(2)}</div></div>
    </div>
  );
};