import { useState } from 'react';
import { Order } from '@/lib/portfolio';
import { formatCurrency, formatCurrencyDecimal, formatShares, formatPercent } from '@/lib/formatters';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ControlPanelProps {
  monthlyContribution: number;
  btcMinWeight: number;
  btcMaxWeight: number;
  orders: Order[];
  portfolioReturn: number;
  portfolioVol: number;
  onMonthlyChange: (v: number) => void;
  onBtcMinChange: (v: number) => void;
  onBtcMaxChange: (v: number) => void;
  onRecalculate: () => void;
  onConfirmOrders: (orders: Order[]) => void;
}

export function ControlPanel({
  monthlyContribution,
  btcMinWeight,
  btcMaxWeight,
  orders,
  portfolioReturn,
  portfolioVol,
  onMonthlyChange,
  onBtcMinChange,
  onBtcMaxChange,
  onRecalculate,
  onConfirmOrders,
}: ControlPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const totalCost = orders.reduce((s, o) => s + o.cost, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Controls */}
      <div className="rounded-lg bg-card border border-border p-5 space-y-5">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Parámetros</h3>

        <div>
          <label className="text-xs text-muted-foreground block mb-2">
            Aporte Mensual: <span className="font-mono text-foreground">{formatCurrency(monthlyContribution)}</span>
          </label>
          <Input
            type="number"
            value={monthlyContribution}
            onChange={e => onMonthlyChange(Number(e.target.value) || 0)}
            className="font-mono bg-muted border-border"
          />
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-2">
            Peso Mínimo BTC: <span className="font-mono text-foreground">{formatPercent(btcMinWeight)}</span>
          </label>
          <Slider
            value={[btcMinWeight]}
            onValueChange={([v]) => {
              onBtcMinChange(v);
              if (v > btcMaxWeight) onBtcMaxChange(v);
            }}
            min={0.20}
            max={0.40}
            step={0.01}
            className="py-2"
          />
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-2">
            Peso Máximo BTC: <span className="font-mono text-foreground">{formatPercent(btcMaxWeight)}</span>
          </label>
          <Slider
            value={[btcMaxWeight]}
            onValueChange={([v]) => onBtcMaxChange(Math.max(v, btcMinWeight))}
            min={0.20}
            max={0.40}
            step={0.01}
            className="py-2"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button onClick={onRecalculate} className="flex-1">
            Recalcular
          </Button>
          <div className="text-xs text-muted-foreground text-right">
            <p>Ret: <span className="font-mono text-foreground">{formatPercent(portfolioReturn)}</span></p>
            <p>Vol: <span className="font-mono text-foreground">{formatPercent(portfolioVol)}</span></p>
          </div>
        </div>
      </div>

      {/* Orders */}
      <div className="rounded-lg bg-card border border-border p-5">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">Órdenes Sugeridas</h3>

        {orders.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No hay órdenes necesarias. La cartera está equilibrada.</p>
        ) : (
          <>
            <div className="space-y-2 max-h-[220px] overflow-y-auto">
              {orders.map(order => (
                <div key={order.ticker} className="flex items-center justify-between py-2 border-b border-border/50">
                  <div>
                    <p className="text-sm font-medium">{order.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatShares(order.shares, order.ticker === 'BTC-EUR')} × {formatCurrencyDecimal(order.price)}
                    </p>
                  </div>
                  <p className="font-mono text-sm font-medium text-success">{formatCurrency(order.cost)}</p>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
              <p className="text-sm text-muted-foreground">
                Coste total: <span className="font-mono text-foreground font-medium">{formatCurrency(totalCost)}</span>
              </p>
              <Button
                onClick={() => {
                  if (!confirming) {
                    setConfirming(true);
                    return;
                  }
                  onConfirmOrders(orders);
                  setConfirming(false);
                }}
                variant={confirming ? 'destructive' : 'default'}
                size="sm"
              >
                {confirming ? '¿Confirmar?' : 'Ejecutar'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
