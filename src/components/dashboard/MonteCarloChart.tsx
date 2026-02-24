import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { formatCurrency } from '@/lib/formatters';

interface MonteCarloChartProps {
  results: number[];
  probability: number;
}

export const MonteCarloChart: React.FC<MonteCarloChartProps> = ({ results, probability }) => {
  const min = Math.min(...results);
  const max = Math.max(...results);
  const binCount = 40;
  const binWidth = (max - min) / binCount;
  const bins = Array(binCount).fill(0).map((_, i) => ({
    rangeMin: min + i * binWidth,
    rangeMax: min + (i + 1) * binWidth,
    count: 0
  }));
  results.forEach(v => {
    const i = Math.floor((v - min) / binWidth);
    if (i >= 0 && i < binCount) bins[i].count++;
  });
  const data = bins.map(b => ({
    name: `${formatCurrency(b.rangeMin)} - ${formatCurrency(b.rangeMax)}`,
    value: b.count,
    rangeMin: b.rangeMin
  }));

  const targetIndex = data.findIndex(d => d.rangeMin >= 150000);

  return (
    <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-6 rounded-xl border border-slate-700 shadow-lg">
      <h3 className="text-lg font-semibold mb-2 text-center text-white">Distribución Monte Carlo (10 años)</h3>
      <div className="text-center mb-4">
        <span className="text-sm text-slate-400">P(≥150k) = </span>
        <span className="font-bold text-blue-400 text-lg">{(probability * 100).toFixed(1)}%</span>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <defs>
            <linearGradient id="colorBar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.3}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="name" tick={false} stroke="#94a3b8" />
          <YAxis stroke="#94a3b8" />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
              color: '#f8fafc',
              boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)'
            }}
            labelFormatter={() => ''}
            formatter={(value: number) => [`Frecuencia: ${value}`, '']}
          />
          <Bar dataKey="value" fill="url(#colorBar)" radius={[4,4,0,0]} />
          {targetIndex !== -1 && (
            <ReferenceLine
              x={data[targetIndex].name}
              stroke="#ef4444"
              strokeWidth={2}
              label={{
                value: '150k',
                position: 'top',
                fill: '#ef4444',
                fontSize: 12,
                fontWeight: 600
              }}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};