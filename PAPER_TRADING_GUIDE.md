# 📊 Paper Trading Institucional — Olympus V5+

## Proceso Semanal (cada viernes tras cierre de mercado)

### Paso 1: Actualizar datos de mercado
```bash
npx tsx scripts/append_weekly_data.ts
```
- Descarga precios de cierre de Yahoo Finance para los 14 tickers
- Calcula BTC_VOL (volatilidad anualizada 30d)
- Añade una fila nueva al CSV `historical_data_daily_augmented.csv`
- **Si falla algún ticker**: carry-forward del último precio conocido (nunca 0.00)

### Paso 2: Simular paper trading
```bash
npx tsx scripts/paper_trading.ts
```
- Lee `paper_trading_config.json` (posiciones iniciales, cash, fecha Día 0)
- Ejecuta el backtest del motor Olympus desde el Día 0 hacia delante
- Compara contra **Frozen Benchmark** (do-nothing: mismas shares iniciales, sin rebalanceos)
- Calcula Alpha = rendimiento diario motor − rendimiento diario frozen
- Genera:
  - `paper_trading_log.csv` — registro diario con motorValue, frozenValue, DD, régimen, allocations
  - `paper_trading_summary.json` — resumen con Sharpe, CAGR, MaxDD, Alpha

### Paso 3: Monitorizar métricas
```bash
# Semanal (viernes)
npx tsx scripts/monitor_v2.ts

# Mensual (último viernes del mes)
npx tsx scripts/monitor_v2.ts --monthly
```
- **Necesita ≥20 días** de datos para el reporte semanal
- **Necesita ≥60 días** para el reporte mensual (Tier 2)
- Genera `monitor_report.json` con:
  - Tier 1: Sharpe, CAGR, MaxDD, Vol, Ratio EXPANSION, días CRISIS
  - Tier 2 (--monthly): Sortino, Calmar, Recovery Factor, Win Rate, Ulcer Index, Turnover, Alpha vs Frozen
- Emite **veredicto**: 🟢 NORMAL / 🟡 ATENCIÓN / 🟠 PRECAUCIÓN / 🔴 PAUSAR

### Paso 4: Revisar dashboard
- Abrir Vercel y verificar:
  - Alertas de Tail Risk coherentes con DD real
  - Cycle Top/Bottom signals actualizadas
  - Smart DCA y Rebalanceo alineados con el motor

---

## Interpretación de Resultados

### Alpha (Motor − Frozen)
| Alpha | Significativo | Interpretación |
|---|---|---|
| > +2% anual | ✅ t-stat > 1.96 | El motor **genera valor** sobre no hacer nada |
| ~0% | ❌ t-stat < 1.96 | **Necesita más datos** (normal en <3 meses) |
| < −2% anual | ✅ t-stat > 1.96 | 🔴 El motor **destruye valor** — auditar |

### Sharpe
| Sharpe | Señal |
|---|---|
| > 0.50 | Bueno |
| 0.25–0.50 | Aceptable |
| < 0.25 | ⚠️ Atención |
| < 0 | 🔴 Malo |

### MaxDD
| MaxDD | Señal |
|---|---|
| < −15% | Normal para portfolio balanceado |
| −15% a −30% | ⚠️ Elevado |
| > −30% | 🔴 Crítico — revisar Kill Switch |

---

## Día 0: 24 de julio de 2026

| Activo | Shares | Precio compra | Precio Día 0 |
|---|---|---|---|
| BTC-EUR | 0.031285 | €87.897,74 | €56.618,52 |
| VVSM.DE | 1 | €57,49 | €100,56 |
| 0P00000WLG.F | 19,23 | €61,52 | €62,68 |
| URNU.DE | 74 | €24,94 | €22,02 |
| EMXC.DE | 3 | €29,30 | €40,51 |
| PPFB.DE | 32 | €69,66 | €68,56 |

- **Cash broker**: €2.062
- **Liquidez defensiva**: €10.000
- **Valor total cartera Día 0**: €9.084 (posiciones + cash)
- **Legacy P&L archivado**: −€1.131
- **Forward P&L**: empieza desde CERO

---

## Próximos Hitos

| Fecha | Qué esperar |
|---|---|
| **31 jul 2026** | 5 días forward — aún insuficiente para monitor |
| **14 ago 2026** | 15 días forward — primera señal de tendencia |
| **28 ago 2026** | ~25 días — **primer monitor semanal** válido |
| **24 oct 2026** | 3 meses — **primer monitor mensual** con Alpha y Frozen Benchmark |
