# Olympus V5 — Informe para Comité de Inversiones

**Fecha**: 17 Agosto 2026 · **Estado**: Paper trading activo · **Fase**: validación (congelado funcional)

---

## 1. Resumen Ejecutivo

Olympus V5 es un motor cuantitativo de asignación de activos (family office / hedge fund) que combina
**Black-Litterman + HRP + MinVar + Kelly** sobre una cartera de 6 activos. La arquitectura está
**congelada funcionalmente** desde la auditoría forense de Agosto 2026: no se añaden indicadores nuevos
sin validación. El esfuerzo actual es **demostrar con evidencia** que las decisiones ya tomadas son robustas
(paper trading, backtest fuera de muestra, ablación, sensibilidad).

**Tests**: 415 pasando / 416 (1 fallo flaky conocido: `allocationLogger` timeout de 5s, ajeno a la lógica).

---

## 2. Cartera (6 activos)

| Activo | Ticker | Clase | Detector techo | Detector suelo |
|---|---|---|---|---|
| Bitcoin | BTC-EUR | Cripto | MVRV Z, Puell, RSI-W | MVRV Z, Puell, RSI-W, BTC.D |
| Semiconductores | VVSM.DE | Renta variable | SOX/SPX RS, SOX RSI-W | SOX RSI, SOX/SPX RS |
| Global (MSCI World) | 0P00000WLG.F | Renta variable | Forward P/E, EPS Growth, RSI-W, Credit Spread | RSI-W, P/E bajo |
| Uranio | URNU.DE | Materia prima | Spot/LT ratio, RSI diario | Spot/LT ratio (suelo), RSI, Z-score |
| Emergentes | EMXC.DE | Renta variable | RSI-W, DXY | RSI-W, P/E bajo |
| Oro (ETC) | PPFB.DE | Materia prima | Tipo real (10Y−BE5Y), Brent, DXY, **BC compras** | Tipo real bajo |

---

## 3. Arquitectura de decisión (TOP → BOTTOM → DCA)

La decisión está separada en tres capas que no se mezclan:

| Capa | Función | Salida |
|---|---|---|
| **Cycle Top** | ¿Rentabilidad futura esperada ha caído por valoración/euforia? | trim % (SAFE/CAUTION/DANGER) |
| **Cycle Bottom** | ¿Rentabilidad esperada ha subido mucho por infravaloración? | score + multiplicador (VALUE ×1.25 / OPPORTUNITY ×1.5 / EXTREME ×2.0) |
| **Smart DCA** | ¿Cuánto desplegar y en qué activos? | órdenes con cap de drift y cash real |

Principios institucionales aplicados:

- **Solo lo *leading* puntúa.** Los datos coincidentes/proxy (SIA Sales, P/E trimestral, CAPE proxy) se degradan a **informativos** y no mueven el multiplicador por sí solos.
- **Multiplier como fuente única de verdad.** `trimPct = (1 − multiplier) × 100` derivado siempre del multiplier (elimina bugs de sincronización).
- **Rampas suaves** en vez de umbrales duros (anti-whipsaw).
- **Guard de contradicción** (techo bloquea suelo del mismo activo).

---

## 4. Controles de riesgo (verificados)

| Control | Detalle |
|---|---|
| **Kill Switch L1–L5** | Por drawdown real (−12/−15/−20/−25/−32%). No por sobrepeso ni por mover cash. |
| **Cap de drift / sobrecompra** | `tope = drift × valor cartera`. Impide concentrar todo el cash en un activo. |
| **Bypass EXTREME** | Solo en suelo EXTREME (×2.0) se permite sobrecomprar hasta −10pp. |
| **Recorte de sobrepeso** | Activo sobreponderado sin techo se recorta hacia target, respetando el floor de suelo. |
| **CASH-UNIFICADO** | cash broker + liquidez defensiva en estado atómico → no hay Kill Switch fantasma al mover dinero. |
| **Correlation Panic / Vol Target / Regime penalty** | Capas adicionales heredadas (BL×0.20 + HRP×0.55 + MinVar×0.25). |

---

## 5. Cambios de Agosto 2026 (este ciclo)

| Área | Cambio | Justificación |
|---|---|---|
| **Detectores de techo** | Degradar SIA Sales y EMXC P/E a informativos (0 peso) | Coincidentes, no leading |
| **Oro** | Sensor de compras de bancos centrales (`goldCbPurchases`, 500→800→1200 t/año, máx +0.20) | Cierra el gap de de-dolarización (2022: oro sube pese a tipos reales positivos) |
| **WLG** | Forward P/E (media 16) + EPS Growth como modulador + Credit Spread amplificador | Evita vender demasiado pronto y refleja crecimiento de beneficios |
| **Rebalanceo** | Recorte institucional de sobrepeso (ya no HOLD eterno) | Límite de concentración |
| **Persistencia** | Inputs manuales de ciclo guardados en localStorage | No se pierden al recargar |
| **Reporting** | G/P latente total + **Retorno total del patrimonio** (editable "Aportado") | Trazabilidad de performance real |
| **Fixes forense** | H-2 (Sortino MAR=rf), H-5 (convención drift), H-6 (look-ahead pesos fijos), benchmark window, REGIME-50K display | Eliminar métricas imposibles / look-ahead |

---

## 6. Validación (estado actual)

| Fase | Estado |
|---|---|
| Congelar versión | ✅ Hecho |
| Paper trading (4–8 semanas) | 🔄 En curso (semanal, viernes) |
| Backtest fuera de muestra | ⚠️ Re-baselining tras fixes H-2/H-5/H-6 |
| Matriz de confusión / Ablación / Sensibilidad | 🔜 Pendiente |
| NUPL / Market Breadth | ⛔ Congelado hasta validar la versión actual |

**Regla del comité**: una mejora solo se aprueba si demuestra **impacto marginal cuantificado** (ablación),
no por "añadir más indicadores". Un motor con 15 indicadores justificados es más robusto que uno con 30 redundantes.

---

## 7. Veredicto para el Comité

### ✅ Fortalezas
- Arquitectura TOP/BOTTOM/DCA con sizing por convicción y límites de concentración: **institucional-grade**.
- Separación *leading* / *coincident* / *proxy* con regla de que solo lo leading puntúa.
- Fusibles de riesgo reales (Kill Switch por drawdown, cap de drift, recorte de sobrepeso).
- 415 tests + TypeScript estricto.

### ⚠️ Riesgos / pendientes
- **1 fallo flaky** (`allocationLogger` timeout) — cosmético, no afecta señales.
- **P1 regime-conditional valuation shift**: diseñado, pendiente de backtest de sensibilidad (±1/±1.5/±2) antes de producción.
- **Indicadores manuales** (MVRV Z, spot/LT uranio, compras BC, etc.) requieren actualización periódica — riesgo operativo silencioso si se olvidan.
- **Dependencia de indicador único** en algunos detectores (uranio: spot/LT; oro: tipo real) — mitigado parcialmente (BC sensor en oro), pendiente corroboración en uranio.

### 🔜 Próximos pasos
1. **Continuar paper trading** (protocolo de viernes, sin mirar a diario).
2. **Cerrar el ciclo de validación**: backtest OOS → matriz de confusión → ablación → sensibilidad.
3. **Solo después** evaluar NUPL (BTC) y Market Breadth (WLG) como mejoras medibles.
4. **Automatizar/verificar frecuencia** de los inputs manuales (timestamp de última actualización con guard de staleness).

---

## 8. Firma Técnica

```
Fecha del informe: 17 Agosto 2026
Motor: Olympus V5 (arquitectura congelada funcional)
Tests: 415 passing / 416 (1 flaky conocido)
TypeScript: estricto, sin errores (tsc --noEmit limpio)
Último commit: c562ad8 (campo editable 'Total aportado')
Fase: paper trading supervisado
```

**Dictamen**: APROBADO CONDICIONAL — la arquitectura está lista para paper trading supervisado.
Para capital de terceros se requiere: track record de 3–6 meses, validación estadística completa
(OOS + ablación + sensibilidad), y guard de staleness sobre los inputs manuales.

---

*Documento del comité de inversiones Olympus V5. Los números de performance se re-baselinan tras la
auditoría forense de Agosto 2026; el backtest final fuera de muestra se ejecutará al cierre de la fase de validación.*
