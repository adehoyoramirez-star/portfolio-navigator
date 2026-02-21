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

export const KPIBar: React.FC<KPIBarProps> = ({ regime, btcPrice, btcZScore, probability, cashReserve, targetVol }) => {
  const regimeColors: Record<string, string> = {
    RISK_ON: 'text-green-600',
    NEUTRAL: 'text-yellow-600',
    RISK_OFF: 'text-orange-600',
    ATTACK_MODE: 'text-purple-600'
  };
  const regimeClass = regimeColors[regime] || 'text-gray-600';
  return (
    <div className="grid grid-cols-4 gap-4 p-4 bg-white rounded-lg shadow">
      <div><div className="text-sm text-gray-500">Régimen</div><div className={`text-xl font-bold ${regimeClass}`}>{regime}</div>{targetVol && <div className="text-xs text-gray-400">Vol. obj: {formatPercentage(targetVol)}</div>}</div>
      <div><div className="text-sm text-gray-500">BTC Precio</div><div className="text-xl font-bold">{formatCurrency(btcPrice)}</div><div className={`text-xs ${btcZScore < -2 ? 'text-red-500' : 'text-gray-400'}`}>Z-score: {btcZScore.toFixed(2)}</div></div>
      <div><div className="text-sm text-gray-500">Prob. 150k€</div><div className="text-xl font-bold">{formatPercentage(probability)}</div><div className="text-xs text-gray-400">500 sim · 10 años</div></div>
      <div><div className="text-sm text-gray-500">Reserva</div><div className="text-xl font-bold">{formatCurrency(cashReserve)}</div><div className="text-xs text-gray-400">Efectivo disponible</div></div>
    </div>
  );
};