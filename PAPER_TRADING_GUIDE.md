# PAPER TRADING — Olympus V5
# Plan de 3 meses (Jul - Sep 2026)

## Resumen ejecutivo

Paper trading con el motor Olympus V5 sobre el portfolio real de 6 activos.
Capital inicial: 6,700 cash + posiciones actuales = ~13,857 total.
Rebalanceo mensual. Benchmark: Equal-Weight (16.67% cada activo).

## Rutina diaria (5 min)

1. Abrir dashboard: npm run dev
2. Refrescar datos: pulsar Actualizar precios
3. Revisar regimen: EXPANSION/CONTRACTION/CRISIS
4. Revisar seccion Rebalanceo (observar, no ejecutar)
5. Registrar snapshot: python paper_trading.py snapshot

## Rutina semanal (domingo, 15 min)

1. Comparar vs benchmark: python paper_trading.py weekly
2. Revisar journal: abrir paper_trading_journal.csv
3. Actualizar benchmark: python paper_trading.py benchmark

## Rutina mensual (dia 1, 30 min)

1. Ejecutar rebalanceo segun dashboard
2. Registrar operaciones: python paper_trading.py trade --ticker X --action BUY/SELL --shares N --price P
3. Generar informe: python paper_trading.py report --month 2026-07

## Metricas de aprobacion

| Metrica | Umbral | Frecuencia |
|---------|--------|------------|
| Sharpe ratio | > 0.5 | Mensual |
| Consistencia vs backtest | > 70% | Mensual (mes 2-3) |
| Max drawdown | < 25% | Diario |
| Tracking error vs EW | < 15% anual | Mensual |
| Operaciones | >= 1/mes | Mensual |

## Aprobacion final (Sep 2026)

APROBADO: Sharpe > 0.5, Consistencia > 70%, MaxDD < 25%
CONDICIONAL: Sharpe 0.3-0.5 o Consistencia 60-70% -> 2 meses mas
RECHAZADO: Sharpe < 0.3, MaxDD > 25%, o motor sin senales

## Reglas de oro

1. NO intervengas manualmente. El motor manda.
2. Registra TODO. Sin huecos.
3. No persigas el benchmark. Validar el motor, no ganarle cada semana.
4. Si ALL_CASH, liquida todo. Es la senal mas importante.
5. Si bug -> anotalo pero no lo arregles durante paper trading.

Olympus Capital - Paper Trading V5 - Julio 2026
