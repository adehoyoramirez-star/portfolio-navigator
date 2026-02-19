import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { ASSETS, CHART_COLORS } from '@/lib/portfolio';
import { formatPercent } from '@/lib/formatters';

interface DonutChartsProps {
  weights: number[];
  riskContribution: number[];
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg bg-popover border border-border px-3 py-2 text-sm shadow-lg">
      <p className="font-medium">{d.name}</p>
      <p className="text-muted-foreground">{formatPercent(d.value)}</p>
    </div>
  );
};

function DonutChart({ data, title }: { data: { name: string; value: number; color: string }[]; title: string }) {
  return (
    <div className="rounded-lg bg-card border border-border p-4">
      <h3 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">{title}</h3>
      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={90}
              paddingAngle={2}
              dataKey="value"
              strokeWidth={0}
            >
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} />
            <span className="text-muted-foreground truncate">{d.name}</span>
            <span className="font-mono ml-auto">{formatPercent(d.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DonutCharts({ weights, riskContribution }: DonutChartsProps) {
  const allocationData = ASSETS.map((a, i) => ({
    name: a.name,
    value: weights[i],
    color: CHART_COLORS[i],
  }));

  const riskData = ASSETS.map((a, i) => ({
    name: a.name,
    value: riskContribution[i],
    color: CHART_COLORS[i],
  }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <DonutChart data={allocationData} title="Asignación Objetivo" />
      <DonutChart data={riskData} title="Contribución al Riesgo" />
    </div>
  );
}
