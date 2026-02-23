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
    rangeMin: b.rangeMin // mantener para referencia
  }));

  // Encontrar el índice donde el rango mínimo supera 150k
  const targetIndex = data.findIndex(d => d.rangeMin >= 150000);

  return (
    <div className="bg-gray-800 p-4 rounded-lg shadow">
      <h3 className="text-lg font-semibold mb-2 text-center text-white">Distribución Monte Carlo (10 años)</h3>
      <div className="text-center mb-2">
        <span className="text-sm text-gray-400">P(≥150k) = </span>
        <span className="font-bold text-blue-400">{(probability * 100).toFixed(1)}%</span>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#444" />
          <XAxis dataKey="name" tick={false} stroke="#aaa" />
          <YAxis stroke="#aaa" />
          <Tooltip
            labelFormatter={() => ''}
            formatter={(value: number) => [`Frecuencia: ${value}`, '']}
            contentStyle={{ backgroundColor: '#1f1f1f', borderColor: '#444', color: '#fff' }}
          />
          <Bar dataKey="value" fill="#8884d8" />
          {targetIndex !== -1 && (
            <ReferenceLine
              x={data[targetIndex].name}
              stroke="red"
              label={{ value: '150k', fill: 'red', position: 'top' }}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};