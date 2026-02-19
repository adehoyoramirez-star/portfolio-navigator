import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';
import { TARGET_AMOUNT } from '@/lib/portfolio';
import { formatCurrency } from '@/lib/formatters';

interface MonteCarloChartProps {
  results: number[];
  probability: number;
}

function createBins(data: number[], numBins: number) {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const binWidth = (max - min) / numBins;
  const bins = Array.from({ length: numBins }, (_, i) => ({
    rangeMin: min + i * binWidth,
    rangeMax: min + (i + 1) * binWidth,
    count: 0,
    label: '',
    aboveTarget: false,
  }));

  data.forEach(v => {
    const idx = Math.min(Math.floor((v - min) / binWidth), numBins - 1);
    bins[idx].count++;
  });

  bins.forEach(b => {
    const mid = (b.rangeMin + b.rangeMax) / 2;
    b.label = `${Math.round(mid / 1000)}K`;
    b.aboveTarget = b.rangeMin >= TARGET_AMOUNT;
  });

  return bins;
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg bg-popover border border-border px-3 py-2 text-sm shadow-lg">
      <p className="font-medium">{formatCurrency(d.rangeMin)} – {formatCurrency(d.rangeMax)}</p>
      <p className="text-muted-foreground">{d.count} simulaciones</p>
    </div>
  );
};

export function MonteCarloChart({ results, probability }: MonteCarloChartProps) {
  const bins = createBins(results, 30);

  return (
    <div className="rounded-lg bg-card border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Simulación Monte Carlo
        </h3>
        <span className="text-xs bg-muted px-2 py-1 rounded font-mono">
          P(≥150K) = <span className={probability >= 0.5 ? 'text-success' : 'text-destructive'}>{(probability * 100).toFixed(1)}%</span>
        </span>
      </div>
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bins} barCategoryGap={1}>
            <XAxis
              dataKey="label"
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10 }}
              axisLine={{ stroke: 'hsl(215, 25%, 22%)' }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={30}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(215, 25%, 22%, 0.5)' }} />
            <ReferenceLine
              x={bins.findIndex(b => b.rangeMin <= TARGET_AMOUNT && b.rangeMax >= TARGET_AMOUNT) >= 0
                ? bins[bins.findIndex(b => b.rangeMin <= TARGET_AMOUNT && b.rangeMax >= TARGET_AMOUNT)].label
                : undefined}
              stroke="hsl(0, 65%, 51%)"
              strokeWidth={2}
              strokeDasharray="4 4"
              label={{ value: '150K€', fill: 'hsl(0, 65%, 51%)', fontSize: 11, position: 'top' }}
            />
            <Bar dataKey="count" radius={[2, 2, 0, 0]}>
              {bins.map((entry, i) => (
                <Cell
                  key={i}
                  fill={entry.aboveTarget ? 'hsl(149, 100%, 39%)' : 'hsl(210, 80%, 55%)'}
                  fillOpacity={0.8}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

