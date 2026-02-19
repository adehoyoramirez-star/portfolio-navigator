import { GaugeChart } from './GaugeChart';
import { MarketData } from '@/lib/portfolio';

interface MarketGaugesProps {
  data: MarketData;
}

export function MarketGauges({ data }: MarketGaugesProps) {
  const green = 'hsl(149, 100%, 39%)';
  const yellow = 'hsl(45, 100%, 50%)';
  const red = 'hsl(0, 65%, 51%)';
  const blue = 'hsl(210, 80%, 55%)';

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <GaugeChart
        value={data.vix}
        min={0}
        max={40}
        segments={[
          { from: 0, to: 20, color: green },
          { from: 20, to: 30, color: yellow },
          { from: 30, to: 40, color: red },
        ]}
        label="VIX"
        unit=""
      />
      <GaugeChart
        value={(data.tnx - data.irx) * 100}
        min={-100}
        max={200}
        segments={[
          { from: -100, to: 0, color: red },
          { from: 0, to: 100, color: yellow },
          { from: 100, to: 200, color: green },
        ]}
        label="Curva 10y-3m"
        unit=" bps"
        decimals={0}
      />
      <GaugeChart
        value={data.tnx}
        min={0}
        max={6}
        segments={[
          { from: 0, to: 2, color: green },
          { from: 2, to: 4, color: yellow },
          { from: 4, to: 6, color: red },
        ]}
        label="Tipo 10 Años"
        unit="%"
      />
      <GaugeChart
        value={data.btcZScore}
        min={-3}
        max={3}
        segments={[
          { from: -3, to: -1, color: red },
          { from: -1, to: 1, color: blue },
          { from: 1, to: 3, color: green },
        ]}
        label="Z-Score BTC"
        unit=""
        decimals={2}
      />
    </div>
  );
}
