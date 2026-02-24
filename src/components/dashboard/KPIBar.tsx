// src/components/dashboard/KPIBar.tsx
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
  RISK_ON: 'text-green-400 border-green-400/20',
  NEUTRAL: 'text-yellow-400 border-yellow-400/20',
  RISK_OFF: 'text-orange-400 border-orange-400/20',
  ATTACK_MODE: 'text-purple-400 border-purple-400/20'
};

export const KPIBar: React.FC<KPIBarProps> = ({
  regime,
  btcPrice,
  btcZScore,
  probability,
  cashReserve,
  targetVol
}) => {
  const regimeClass = regimeColors[regime] || 'text-gray-400 border-gray-400/20';
  const zScoreColor = btcZScore < -2 ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="grid grid-cols-4 gap-4">
      <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-5 rounded-xl border border-slate-700 shadow-lg hover:shadow-xl transition-all">
        <div className="text-sm font-medium text-slate-400 mb-1">RÉGIMEN</div>
        <div className={`text-2xl font-bold ${regimeClass.split(' ')[0]}`}>{regime}</div>
        {targetVol !== undefined && (
          <div className="text-xs text-slate-500 mt-1">Vol. obj: {formatPercentage(targetVol)}</div>
        )}
      </div>
      <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-5 rounded-xl border border-slate-700 shadow-lg hover:shadow-xl transition-all">
        <div className="text-sm font-medium text-slate-400 mb-1">BTC Precio</div>
        <div className="text-2xl font-bold text-white">{formatCurrency(btcPrice)}</div>
        <div className={`text-xs mt-1 ${zScoreColor}`}>Z-score: {btcZScore.toFixed(2)}</div>
      </div>
      <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-5 rounded-xl border border-slate-700 shadow-lg hover:shadow-xl transition-all">
        <div className="text-sm font-medium text-slate-400 mb-1">Prob. 150k€</div>
        <div className="text-2xl font-bold text-white">{formatPercentage(probability)}</div>
        <div className="text-xs text-slate-500 mt-1">500 sim · 10 años</div>
      </div>
      <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-5 rounded-xl border border-slate-700 shadow-lg hover:shadow-xl transition-all">
        <div className="text-sm font-medium text-slate-400 mb-1">Reserva</div>
        <div className="text-2xl font-bold text-white">{formatCurrency(cashReserve)}</div>
        <div className="text-xs text-slate-500 mt-1">Efectivo disponible</div>
      </div>
    </div>
  );
};