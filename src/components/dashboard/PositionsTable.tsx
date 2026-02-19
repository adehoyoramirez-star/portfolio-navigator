import { ASSETS, Position } from '@/lib/portfolio';
import { formatCurrency, formatCurrencyDecimal, formatPercent, formatShares } from '@/lib/formatters';

interface PositionsTableProps {
  positions: Record<string, Position>;
  prices: Record<string, number>;
  weights: number[];
  totalValue: number;
}

export function PositionsTable({ positions, prices, weights, totalValue }: PositionsTableProps) {
  return (
    <div className="rounded-lg bg-card border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Posiciones Actuales</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left p-3 text-xs text-muted-foreground font-medium uppercase tracking-wider">Activo</th>
              <th className="text-right p-3 text-xs text-muted-foreground font-medium uppercase tracking-wider">Shares</th>
              <th className="text-right p-3 text-xs text-muted-foreground font-medium uppercase tracking-wider">Precio Medio</th>
              <th className="text-right p-3 text-xs text-muted-foreground font-medium uppercase tracking-wider">Precio Actual</th>
              <th className="text-right p-3 text-xs text-muted-foreground font-medium uppercase tracking-wider">Valor</th>
              <th className="text-right p-3 text-xs text-muted-foreground font-medium uppercase tracking-wider">Desv. vs Obj.</th>
            </tr>
          </thead>
          <tbody>
            {ASSETS.map((asset, i) => {
              const pos = positions[asset.ticker] || { shares: 0, avgPrice: 0 };
              const price = prices[asset.ticker] || 0;
              const value = pos.shares * price;
              const currentWeight = totalValue > 0 ? value / totalValue : 0;
              const deviation = currentWeight - weights[i];
              const pnl = pos.avgPrice > 0 ? (price - pos.avgPrice) / pos.avgPrice : 0;
              const isBTC = asset.ticker === 'BTC-EUR';

              return (
                <tr key={asset.ticker} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: `hsl(var(--chart-${i + 1}))` }} />
                      <div>
                        <p className="font-medium">{asset.name}</p>
                        <p className="text-xs text-muted-foreground">{asset.ticker}</p>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 text-right font-mono">{formatShares(pos.shares, isBTC)}</td>
                  <td className="p-3 text-right font-mono">{formatCurrencyDecimal(pos.avgPrice)}</td>
                  <td className="p-3 text-right font-mono">
                    {formatCurrencyDecimal(price)}
                    <span className={`block text-xs ${pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {pnl >= 0 ? '+' : ''}{formatPercent(pnl)}
                    </span>
                  </td>
                  <td className="p-3 text-right font-mono font-medium">{formatCurrency(value)}</td>
                  <td className="p-3 text-right font-mono">
                    <span className={deviation >= 0 ? 'text-success' : 'text-destructive'}>
                      {deviation >= 0 ? '+' : ''}{formatPercent(deviation)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-muted/20">
              <td className="p-3 font-medium" colSpan={4}>Total</td>
              <td className="p-3 text-right font-mono font-semibold">{formatCurrency(totalValue)}</td>
              <td className="p-3"></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
