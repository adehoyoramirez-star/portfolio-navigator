import React from 'react';
import { formatCurrency, formatPercentage } from '@/lib/formatters';

interface KPIBarProps {
  regime: string;
  btcPrice: number;
  btcZScore: number;
  probability: number;
  cashReserve: number;
  targetVol?: number;
}

const regimeColors: Record<string, string> = {
  RISK_ON: 'text-green-400',
  NEUTRAL: 'text-yellow-400',
  RISK_OFF: 'text-orange-400',
  ATTACK_MODE: 'text-purple-400'
};

export const KPIBar: React.FC<KPIBarProps> = ({
  regime,
  btcPrice,
  btcZScore,
  probability,
  cashReserve,
  targetVol
}) => {
  const regimeClass = regimeColors[regime] || 'text-gray-400';
  const zScoreColor = btcZScore < -2 ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="grid grid-cols-4 gap-4 p-4 bg-gray-800 rounded-lg shadow">
      <div>
        <div className="text-sm text-gray-400">Régimen</div>
        <div className={`text-xl font-bold ${regimeClass}`}>{regime}</div>
        {targetVol !== undefined && (
          <div className="text-xs text-gray-500">Vol. obj: {formatPercentage(targetVol)}</div>
        )}
      </div>
      <div>
        <div className="text-sm text-gray-400">BTC Precio</div>
        <div className="text-xl font-bold">{formatCurrency(btcPrice)}</div>
        <div className={`text-xs ${zScoreColor}`}>Z-score: {btcZScore.toFixed(2)}</div>
      </div>
      <div>
        <div className="text-sm text-gray-400">Prob. 150k€</div>
        <div className="text-xl font-bold">{formatPercentage(probability)}</div>
        <div className="text-xs text-gray-500">500 sim · 10 años</div>
      </div>
      <div>
        <div className="text-sm text-gray-400">Reserva</div>
        <div className="text-xl font-bold">{formatCurrency(cashReserve)}</div>
        <div className="text-xs text-gray-500">Efectivo disponible</div>
      </div>
    </div>
  );
};