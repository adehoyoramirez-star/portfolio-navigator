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
  const targetData = ASSETS.map((asset, i) => ({
    name: asset,
    value: targetWeights[i]
  }));

  const riskData = ASSETS.map((asset, i) => ({
    name: asset,
    value: riskContribution[i]
  }));

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="bg-gray-800 p-4 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-2 text-center text-white">Asignación objetivo</h3>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={targetData}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={80}
              dataKey="value"
              label={({ name, value }) => `${name}: ${formatPercentage(value)}`}
              labelLine={false}
              isAnimationActive={false}
            >
              {targetData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number) => formatPercentage(value)}
              contentStyle={{ backgroundColor: '#1f1f1f', borderColor: '#444', color: '#fff' }}
            />
            <Legend wrapperStyle={{ color: '#fff' }} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-gray-800 p-4 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-2 text-center text-white">Contribución al riesgo</h3>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={riskData}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={80}
              dataKey="value"
              label={({ name, value }) => `${name}: ${formatPercentage(value)}`}
              labelLine={false}
              isAnimationActive={false}
            >
              {riskData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number) => formatPercentage(value)}
              contentStyle={{ backgroundColor: '#1f1f1f', borderColor: '#444', color: '#fff' }}
            />
            <Legend wrapperStyle={{ color: '#fff' }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};