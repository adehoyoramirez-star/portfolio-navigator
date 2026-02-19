import { MarketRegime } from '@/lib/portfolio';
import { formatCurrency, formatPercent, formatNumber } from '@/lib/formatters';

interface KPIBarProps {
  regime: MarketRegime;
  btcPrice: number;
  btcZScore: number;
  probability: number;
  cashReserve: number;
}

export function KPIBar({ regime, btcPrice, btcZScore, probability, cashReserve }: KPIBarProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div className="rounded-lg bg-card border border-border p-4">
        <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Régimen</p>
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full animate-pulse-glow"
            style={{ backgroundColor: regime.color }}
          />
          <span className="font-semibold text-sm" style={{ color: regime.color }}>
            {regime.name}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Vol. obj: {formatPercent(regime.targetVol)}
        </p>
      </div>

      <div className="rounded-lg bg-card border border-border p-4">
        <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">BTC Precio</p>
        <p className="font-mono font-semibold text-lg">{formatCurrency(btcPrice)}</p>
        <p className="text-xs text-muted-foreground mt-1">
          Z-score: <span className={btcZScore > 1 ? 'text-success' : btcZScore < -1 ? 'text-destructive' : 'text-foreground'}>{formatNumber(btcZScore, 2)}</span>
        </p>
      </div>

      <div className="rounded-lg bg-card border border-border p-4">
        <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Prob. 150K€</p>
        <p className={`font-mono font-semibold text-lg ${probability >= 0.5 ? 'text-success' : 'text-destructive'}`}>
          {formatPercent(probability)}
        </p>
        <p className="text-xs text-muted-foreground mt-1">500 simulaciones · 10 años</p>
      </div>

      <div className="rounded-lg bg-card border border-border p-4">
        <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Reserva</p>
        <p className="font-mono font-semibold text-lg">{formatCurrency(cashReserve)}</p>
        <p className="text-xs text-muted-foreground mt-1">Efectivo disponible</p>
      </div>
    </div>
  );
}
