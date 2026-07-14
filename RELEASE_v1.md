# 🏛️ Olympus V3+ — Release v1.0.0 (Arquitectura Congelada)

**Fecha de congelación:** 14 de julio de 2026  
**Estado:** GO — Listo para paper trading con capital real  
**Dictamen OOS:** Forward Sharpe (0.924) > Calibration Sharpe (0.791). Cero sobreajuste.

---

## Arquitectura

### Módulos activos (6)

| Capa | Módulo | Función | Parámetro clave |
|---|---|---|---|
| 1 | **HRP** | Hierarchical Risk Parity — clustering y asignación por riesgo | Peso: 0.76 |
| 2 | **Black-Litterman** | Retornos esperados con views + prior de mercado | Peso: 0.24, τ=0.05, λ=2.5 |
| 3 | **Detector de Régimen** | Clasifica mercado en EXPANSION/CONTRACTION/CRISIS | CEWS + masterRegime |
| 4 | **Tail Risk Overlay** | Kill Switch 5 niveles (L1-L5) reduce exposición en drawdowns | L1: -12%→0.80, L5: -32%→0.05 |
| 5 | **Volatility Targeting** | Escala exposición total al 20% vol objetivo | Target: 20%, core vol (ex-BTC) |
| 6 | **Kelly Criterion** | Half-Kelly con cap dinámico | Cap: 30%, Half-fraction: 0.70 |

### Módulos eliminados

| Módulo | Motivo | Fecha |
|---|---|---|
| **MinVar** | Redundante con HRP. Ablation study: ΔSharpe +0.013 al eliminarlo | 14-Jul-2026 |

---

## Parámetros Fijos (NO MODIFICAR)

### Blend Weights
```
CONSERVATIVE (CONTRACTION/CRISIS): BL=0.24, HRP=0.76, MIN_VAR=0.00
AGGRESSIVE (EXPANSION):          BL=0.50, HRP=0.50, MIN_VAR=0.00
```

### Backtest / Live
| Parámetro | Valor |
|---|---|
| RebalanceDays | 21 |
| LookbackDays | 252 |
| TransactionCostBps | 15 (variable por activo: 6-30bps) |
| InitialCapital | Variable (según cuenta) |

### Tail Risk — Kill Switch
| Nivel | Drawdown | Overlay | Reducción |
|---|---|---|---|
| L1 | −12.0% | 0.80 | 20% |
| L1.5 | −13.5% | 0.65 | 35% |
| L2 | −15.0% | 0.50 | 50% |
| L3 | −20.0% | 0.30 | 70% |
| L4 | −25.0% | 0.15 | 85% |
| L5 | −32.0% | 0.05 | 95% |

### Volatility Targeting
| Parámetro | Valor |
|---|---|
| Target Vol | 20% anual |
| Multiplier Range | [0.3, 1.5] |
| Usa core vol (ex-BTC) | Sí |

### Régimen — Fast Exit (Histéresis)
| Parámetro | Valor |
|---|---|
| VIX umbral | < 25 |
| Días consecutivos | 3 |
| Acción | Forzar EXPANSION aunque motor diga CONTRACTION |

### Kelly
| Parámetro | Valor |
|---|---|
| Cap | 30% |
| Half-Kelly fraction | 0.70 |
| James-Stein prior μ | 8% anual |

### BTC Caps Dinámicos
| Condición | Cap |
|---|---|
| EXPANSION (default) | 35% |
| CONTRACTION | 20% |
| CRISIS | 10% |
| STRONG_BUY + MVRV < 3.0 | 35% |
| MVRV > 3.5 | 10% |

---

## Activos del Portfolio

| Ticker | Nombre | Sector | Peso benchmark |
|---|---|---|---|
| BTC-EUR | Bitcoin | crypto | 10% |
| EMXC.DE | iShares MSCI Emerging Markets ex-China | emerging | 10% |
| 0P00000WLG.F | Vanguard Global Stock Index | equity | 35% |
| PPFB.DE | iShares Physical Gold ETC | gold | 20% |
| URNU.DE | UBS Uranium ETF | uranium | 10% |
| VVSM.DE | VanEck Semiconductor | semis | 15% |

---

## Resultados de Validación

### Backtest completo (2015-2026)
| Métrica | Olympus | EW Benchmark |
|---|---|---|
| Sharpe | 0.739 | 0.767 |
| CAGR | 12.60% | 17.35% |
| MaxDD | −26.65% | −37.42% |
| Volatilidad | 12.08% | 17.77% |

### WFO 8 ventanas
| Métrica | Olympus OOS | EW OOS |
|---|---|---|
| Sharpe medio | 0.882 | 0.765 |
| Ventanas > EW | 6/8 | — |
| Ventanas catastróficas | 0/8 | — |

### True OOS (calibración pre-2025, validación 2025+)
| Métrica | Calibración | Forward (OOS real) |
|---|---|---|
| Sharpe | 0.791 | **0.924** |
| CAGR | 12.39% | 17.45% |
| MaxDD | −24.2% | −14.8% |

**Forward/Calibration ratio: 116.8% — CERO sobreajuste.**

### Crisis (motor real)
| Crisis | Olympus MaxDD | EW MaxDD | Protección |
|---|---|---|---|
| 2018 Bear | 0.0% | −31.1% | +31.1pp |
| 2020 COVID | −3.1% | −30.2% | +33.3pp |
| 2022 Rate Hikes | −6.2% | −31.8% | +38.0pp |

---

## Expectativas Forward (para monitorización)

| Métrica | Backtest | Rango aceptable (±20%) | Alerta |
|---|---|---|---|
| **Sharpe (12m rolling)** | 0.74 | 0.59 – 0.89 | < 0.45 |
| **MaxDD** | −27% | −22% a −32% | > −40% |
| **Volatilidad** | 12% | 10% – 14% | > 20% |
| **Turnover mensual** | ~15% | 10% – 20% | > 35% |
| **Exposición media** | ~70% | 55% – 85% | < 35% (demasiado defensivo) |
| **Días en CRISIS/año** | < 30 | < 60 | > 90 |

---

## Reglas de Monitorización

1. **Semanalmente:** Ejecutar paper_trading.ts con datos frescos. Comparar Sharpe rolling 12m con backtest.
2. **Mensualmente:** Revisar todas las métricas contra tabla de expectativas.
3. **Trimestralmente:** Decisión GO/NO GO sobre aumentar capital.
4. **Alerta inmediata:** Si MaxDD > 40% o Sharpe rolling < 0.30, pausar operaciones.

---

## Archivos de la Release

| Archivo | Descripción |
|---|---|
| `src/core/engine/olympusV3.ts` | Motor principal (v5.2.3) |
| `src/core/backtest/backtestEngine.ts` | Backtest engine (v5.1, histéresis recalibrada) |
| `src/core/config/engineConfig.ts` | Configuración centralizada (v3.7.1) |
| `scripts/paper_trading.ts` | Script de paper trading forward |
| `scripts/wfo_final.ts` | WFO 8 ventanas |
| `scripts/oos_validation.ts` | Validación OOS real (pre-2025 vs 2025+) |
| `historical_data_daily_augmented.csv` | Datos históricos (2015-2026) |
| `engine_returns.json` | Retornos diarios del motor (referencia) |
| `oos_validation.json` | Resultados validación OOS |
| `paper_trading_log.csv` | Log de decisiones forward (2025+) |

---

## Próximos pasos (fuera de código)

1. Paper trading semanal con datos realmente nuevos (post-abril 2026)
2. Monitorizar desviaciones vs expectativas del backtest
3. Si 12 semanas consistentes → capital reducido
4. Si 6 meses consistentes → capital normal
5. **No modificar parámetros ni arquitectura durante la fase de operación**

---

*Dictamen firmado: Comité de Riesgos — 14 de julio de 2026*
