# Setup Paper Trading para Olympus V5

## Plan de 3 meses

**MES 1 (Jul 2026): Ejecucion manual**
- Seguir senales del dashboard diariamente
- Registrar cada operacion en paper_trading_journal.csv
- Comparar vs benchmark equal-weight semanalmente

**MES 2 (Ago 2026): Semi-automatizacion**
- Activar cron jobs de refresco de datos
- Activar alertas Telegram

**MES 3 (Sep 2026): Validacion pre-produccion**
- Ejecutar WFO con datos de los 2 meses de paper trading
- Si consistencia > 75%: aprobado para produccion

## Umbral de aprobacion
- Sharpe paper > 0.5 y consistencia vs backtest > 70%
- MaxDD paper < 25%
