import React from 'react';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { ASSETS } from '@/lib/constants';
import { formatPercentage } from '@/lib/formatters';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D', '#FF6B6B'];

interface DonutChartsProps {
  targetWeights: number[];
  riskContribution: number[];
}

export const DonutCharts: React.FC<DonutChartsProps> = ({ targetWeights, riskContribution }) => {
  const targetData = ASSETS.map((asset, i) => ({ name: asset, value: targetWeights[i] }));
  const riskData = ASSETS.map((asset, i) => ({ name: asset, value: riskContribution[i] }));

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="bg-white p-4 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-2 text-center">Asignación objetivo</h3>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie data={targetData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} dataKey="value" label={({ name, value }) => `${name}: ${formatPercentage(value)}`}>
              {targetData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v: number) => formatPercentage(v)} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="bg-white p-4 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-2 text-center">Contribución al riesgo</h3>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie data={riskData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} dataKey="value" label={({ name, value }) => `${name}: ${formatPercentage(value)}`}>
              {riskData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v: number) => formatPercentage(v)} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};