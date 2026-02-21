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
  const bins = Array(binCount).fill(0).map((_, i) => ({ rangeMin: min + i * binWidth, count: 0 }));
  results.forEach(v => { const i = Math.floor((v - min) / binWidth); if (i >= 0 && i < binCount) bins[i].count++; });
  const data = bins.map(b => ({ name: `${formatCurrency(b.rangeMin)}`, value: b.count }));
  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <h3 className="text-lg font-semibold mb-2 text-center">Distribución Monte Carlo (10 años)</h3>
      <div className="text-center mb-2"><span className="text-sm text-gray-500">P(≥150k) = </span><span className="font-bold text-blue-600">{(probability * 100).toFixed(1)}%</span></div>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" tick={false} /><YAxis />
          <Tooltip labelFormatter={() => ''} formatter={(v) => [`Frecuencia: ${v}`, '']} />
          <Bar dataKey="value" fill="#8884d8" />
          <ReferenceLine x={data.findIndex(d => d.rangeMax >= 150000)} stroke="red" label="150k" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};