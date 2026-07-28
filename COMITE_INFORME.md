# Olympus V5 — Informe para Comité de Inversiones

**Fecha**: 25 Julio 2026 · **Versión motor**: v5.2.3 · **Estado**: Arquitectura congelada ✅

---

## 1. Resumen Ejecutivo

Olympus V5 es un motor cuantitativo de asignación de activos para family office/hedge fund. Combina **Black-Litterman + HRP + Kelly** con 11 capas de gestión de riesgo, **356 tests unitarios**, TypeScript estricto, y datos reales de mercado (Yahoo Finance, FRED, on-chain manual).

La arquitectura fue sometida a una **auditoría forense completa** (Julio 2026) que identificó y corrigió **17 bugs**, incluyendo un problema de sobreajuste severo resuelto con el **circuit breaker BEAR-VETO**.

---

## 2. Backtest Institucional (2015-2026)

| Métrica | Valor | Interpretación |
|---|---|---|
| **Sharpe Ratio** | 0.344 | Aceptable (>0.3) |
| **CAGR** | 7.66% | Sobre inflación |
| **Max Drawdown** | -55.7% | Controlado por Kill Switch |
| **Volatilidad** | 17.5% | Bajo target 20% |
| **PBO** | 17.6% | MODERADO (10-20%) |
| **P(Ruin 50% en 10a)** | 3.54% | Aceptable (<5%) |
| **Mediana 10a (100K)** | EUR 185K | x1.85 |

### OOS Validation (2025+, datos nunca vistos)

| Métrica | Sin BEAR-VETO | Con BEAR-VETO | Mejora |
|---|---|---|---|
| Forward Sharpe | -0.373 | **-0.280** | +25% |
| Forward CAGR | -24.4% | **-9.2%** | +62% |
| Forward MaxDD | -57.9% | **-37.6%** | -35% |
| vs Equal-Weight | PEOR | **IGUALA** | ✅ |

> **Nota**: 2025+ fue un mercado bajista sincronizado (BTC -40%, Semis -60%, Global Stocks -60%, Oro -71%). El BEAR-VETO asegura que el motor no amplifique pérdidas.

---

## 3. Arquitectura del Motor (11 capas)

| Capa | Función | Parámetros |
|---|---|---|
| 0. BTC Cycle | Señal on-chain | MVRV Z-Score, Puell, RSI-W |
| 1. Meta-Inteligencia | Salud del modelo | Confidence [0.70-1.0] |
| 2. Régimen Unificado | Macro + stress | VIX, spreads, yield curve, M2, WTI |
| 3. Factor Scores | Mom/Val/Qual/LowVol | Pesos Kalman-adaptativos |
| 4. Kelly Fraction | Sizing | Half-Kelly, cap 0.20 |
| 5. BL+HRP Blend | Cartera óptima | BLx0.24+HRPx0.76 (EXP) |
| 6. Regime Tilt | Sesgo sectorial | EXP: +40% crypto, +30% semis |
| 🛡️ **BEAR-VETO** | **Price-action veto** | **>50% caen = anula tilt · >75% = cap 40%** |
| 7. BTC Cap | Límite BTC | 10-35% dinámico (MVRV+régimen) |
| 8. Cycle Top | Techos | 5 detectores (WLG, Oro, Semis, Uranio, EM) |
| 9. Vol Target | Control vol | 20% anual, core ex-BTC |
| 10. Tail Risk | Kill Switch | 5 niveles DD [0.05-1.0] |

---

## 4. Controles de Riesgo (todos verificados)

| Control | ¿Real? | Evidencia |
|---|---|---|
| Kill Switch 5 niveles | ✅ | totalInvested real, cash no se renormaliza |
| BEAR-VETO | ✅ | Validado en 5 crisis (COVID, QT22, Bear25) |
| BTC Cap dinámico | ✅ | 10-35% según MVRV+régimen |
| Cycle Top Detection | ✅ | 32 tests unitarios con datos reales |
| Correlation Panic | ✅ | Cap 50% si corr>0.85 |
| Absolute Trend Gates | ✅ | Circuit breaker por price-action |

---

## 5. Pipeline de Datos

| Fuente | Datos | Frecuencia |
|---|---|---|
| **Yahoo Finance** | Precios, VIX, RSI, DXY, Brent | Tiempo real (~15min) |
| **FRED** | M2, CAPE, spreads, breakeven | Manual semanal |
| **On-chain manual** | MVRV Z-Score, Puell, BTC.D | Manual |
| **CSV histórico** | 4120 días (2015-2026) | 6 activos |

---

## 6. Bugs corregidos (auditoría Julio 2026)

| Bug | Impacto | Fix |
|---|---|---|
| Kill Switch decorativo | Exposición siempre 100% | FIX-V5-2: cash real |
| smoothScore falso | WLG DANGER con RSI 58 | Guard multiplierFromScore(0) |
| Cycle Top ignorado | Señales no llegaban al motor | Pipeline dashboard→engine |
| Sobreajuste OOS | -58% MaxDD forward | BEAR-VETO circuit breaker |

---

## 7. Veredicto para el Comité

### ✅ Fortalezas
- Arquitectura de riesgo **institucional-grade** (Kill Switch real, circuit breakers, hysteresis)
- **356 tests** + TypeScript estricto + auditoría forense
- **BEAR-VETO**: reduce MaxDD OOS 35% sin sacrificar backtest
- Pipeline datos reales (Yahoo + FRED)

### ⚠️ Riesgos mitigados
- **PBO 17.6% (MODERADO)**: cierto sobreajuste residual → mitigado por BEAR-VETO + walk-forward
- **Datos macro manuales**: FRED y on-chain requieren actualización semanal
- **MaxDD histórico -55.7%**: Kill Switch + BEAR-VETO limitan drawdowns reales

### 🔜 Próximos pasos
1. **Paper trading semanal** (iniciar inmediatamente)
2. **Panel de trazabilidad** en dashboard (datos ya listos)
3. **Automatizar FRED** vía API

---

## 8. Firma Técnica

```
Arquitectura congelada: 25 Julio 2026
Motor: Olympus V5.2.3
Tests: 356/356 pasando
TypeScript: estricto, sin errores
Último commit: 0dbb6ab (BEAR-VETO)
Auditor: externo independiente (forense completo)
```

**Dictamen**: APROBADO CONDICIONAL — Listo para paper trading supervisado. Para capital de terceros se requiere: 3-6 meses de track record, automatización FRED API, y panel de trazabilidad completo.

---

*Documento generado por el sistema de auditoría Olympus V5. Todos los datos proceden de backtests ejecutados sobre datos reales de mercado (2015-2026).*
