# 📋 PLAN DE PAPER TRADING — Olympus V3+

**Fecha:** 14 de julio de 2026  
**Versión:** 1.0.0 (arquitectura congelada)  
**Duración recomendada:** 3–6 meses (mínimo 12 semanas) antes de capital reducido

---

## 1. CADENCIA DE REVISIÓN

| Frecuencia | Acción | Herramienta | Responsable |
|---|---|---|---|
| **Diaria** | Verificar que el log se actualiza sin errores | `wc -l paper_trading_log.csv` | Automático |
| **Semanal** (viernes) | Ejecutar `monitor.ts`, revisar 4 métricas Tier-1 y alertas | `npx tsx scripts/monitor.ts` | Trader |
| **Mensual** (día 1) | Deep dive: 14 métricas, benchmark, costes, turnover | `monitor.ts` + análisis manual | Trader + Cuant |
| **Trimestral** | Decisión GO/NO GO sobre aumentar capital | Informe completo | Comité |
| **En crisis** | Revisión inmediata si VIX > 30 o BTC −15% en una semana | Manual | Trader |

---

## 2. MÉTRICAS Y UMBRALES

### Tier 1 — Semanal (4 métricas imprescindibles)

| # | Métrica | Backtest referencia | 🟢 Normal | 🟡 Atención | 🟠 Precaución | 🔴 PAUSAR |
|---|---|---|---|---|---|---|
| M1 | **Sharpe rolling 12m** | 0.74 | > 0.59 | 0.45–0.59 | 0.30–0.45 | < 0.30 |
| M2 | **Max Drawdown** | −27% | > −22% | −22% a −32% | −32% a −40% | < −40% |
| M3 | **Volatilidad anualizada** | 12% | 9%–15% | 15%–20% | 20%–25% o < 6% | > 25% |
| M4 | **Ratio EXPANSION** | ~70% | > 50% | 35%–50% | 20%–35% | < 20% |

**Regla semanal:**  
- 0 flags → 🟢 Continuar normal  
- 1–2 🟡 → Aumentar frecuencia a revisión diaria  
- 1 🟠 o 3+ 🟡 → Pausar nuevas aportaciones, mantener posiciones  
- 1+ 🔴 → **PAUSAR operaciones.** Reducir exposición al 25%. Auditoría completa.

### Tier 2 — Mensual (10 métricas adicionales)

| # | Métrica | Backtest ref. | 🟢 | 🟡 | 🔴 |
|---|---|---|---|---|---|
| M5 | **Sortino Ratio** | 1.62 | > 1.30 | 0.90–1.30 | < 0.90 |
| M6 | **Calmar Ratio** | 0.47 | > 0.38 | 0.25–0.38 | < 0.25 |
| M7 | **Recovery Factor** | 1.85 | > 1.50 | 1.00–1.50 | < 1.00 |
| M8 | **Win Rate** (% días positivos) | ~53% | 48%–58% | 42%–48% | < 42% |
| M9 | **Turnover mensual** | ~15% | 10%–20% | 20%–35% | > 35% |
| M10 | **Costes / AUM mensual** | ~0.03% | < 0.05% | 0.05%–0.10% | > 0.10% |
| M11 | **Max consecutive loss days** | ~12 | < 15 | 15–25 | > 25 |
| M12 | **Sharpe vs EW (diff)** | −0.03 | ±0.15 | −0.15 a −0.30 | < −0.30 |
| M13 | **Monthly P&L consistency** | 60%+ positivos | > 50% | 40%–50% | < 40% |
| M14 | **Ulcer Index** | ~0.08 | < 0.10 | 0.10–0.15 | > 0.15 |

### Tier 3 — Trimestral (decisión GO/NO GO)

| # | Métrica | Condición GO |
|---|---|---|
| T1 | Sharpe rolling 12m ≥ 0.45 | ✅ |
| T2 | MaxDD < −40% | ✅ |
| T3 | Forward/Backtest Sharpe ratio ≥ 0.60 | ✅ |
| T4 | Sin eventos 🔴 en el trimestre | ✅ |
| T5 | Turnover mensual estable (CV < 50%) | ✅ |
| T6 | Regime distribution coherente con mercado | ✅ |

**GO si 6/6 ✅. GO CONDICIONAL si 4-5/6. NO GO si ≤ 3/6.**

---

## 3. PROTOCOLO DE ALERTAS

### 🟡 ATENCIÓN (Tier 1: 1–2 amarillas)
1. **No** reducir posiciones existentes
2. Aumentar frecuencia de monitorización a **diaria**
3. Revisar si la desviación es explicable por condiciones de mercado (ver §5 Contexto)
4. Si 3 semanas consecutivas en 🟡 → escalar a 🟠

### 🟠 PRECAUCIÓN (Tier 1: 1 naranja o 3+ amarillas)
1. **No** abrir nuevas posiciones ni aumentar capital
2. Revisar cada posición individualmente — ¿algún activo está causando la desviación?
3. Verificar que el detector de régimen no está atrapado (ver EXPANSION ratio)
4. Si es un bear market y el motor está siendo defensivo por diseño → puede ser falso positivo
5. Preparar informe para el comité en un plazo de 48h

### 🔴 PAUSAR (Tier 1: 1+ roja)
1. **Reducir exposición neta al 25%** (vender 75% de cada posición)
2. **No** liquidar completamente — mantener exposición mínima para seguir midiendo
3. Auditoría completa en 24h:
   - ¿Fallo del motor o evento de cola?
   - ¿El detector de régimen funcionó correctamente?
   - ¿Las órdenes se ejecutaron al precio esperado?
   - ¿Hay algún bug en el código?
4. El comité decide: corregir bug → reanudar, o arquitectura rota → rediseñar

---

## 4. FALSOS POSITIVOS — GUÍA DE CONTEXTO

**Olympus NO está diseñado para ganar en todos los mercados.** Estas situaciones son esperables y NO deben disparar alertas de pausa:

| Situación | Qué esperar | Por qué NO es un fallo |
|---|---|---|
| **Bull market fuerte** (BTC +40% en 3 meses) | Olympus Sharpe < EW Sharpe. EXPANSION ratio alto | El motor capea BTC; EW tiene más BTC. Es por diseño |
| **Bear market suave** (−10% a −15%) | Aumento de días en CONTRACTION. Drawdown controlado | El detector está funcionando. Reducir exposición es lo correcto |
| **VIX 20–25 sostenido** | Oscilación EXPANSION↔CONTRACTION | Es el umbral de histéresis. VIX 25 con 3 días → EXPANSION forzada |
| **Crisis real** (VIX > 35) | Días en CRISIS, exposición mínima, MaxDD < −15% | Es EXACTAMENTE lo que queremos. No es un fallo, es protección |
| **Volatilidad < 8%** | Exposición aumentada por Vol Targeting | El motor escala a más riesgo porque hay menos riesgo. Correcto |

**Lo que SÍ es un fallo real:**
- Drawdown severo (> 40%) CON exposición baja → el Tail Risk no funcionó
- Drawdown severo CON régimen en EXPANSION → el detector falló
- Turnover > 35% sostenido → costes están devorando el alpha
- Sharpe < 0.30 con mercado normal → el motor está roto

---

## 5. CHECKLIST SEMANAL

Cada viernes, el trader ejecuta y responde:

```
□ Ejecutar: npx tsx scripts/monitor.ts
□ Veredicto semanal: 🟢 🟡 🟠 🔴 (rodear uno)
□ ¿Algún activo tuvo un movimiento > 2σ esta semana? SÍ / NO
  → Si SÍ: ¿el régimen lo detectó? SÍ / NO
□ ¿Hubo algún rebalanceo esta semana? SÍ / NO
  → Si SÍ: ¿costes estimados dentro de lo esperado? (< 0.10% AUM) SÍ / NO
□ ¿VIX actual? ___ (ref: VIX < 25 → histéresis activa salida rápida)
□ ¿BTC dominance? ___% (ref: > 60% → alerta de mercado crypto-céntrico)
□ Acción tomada: __________
□ Firma: ___
```

---

## 6. CHECKLIST MENSUAL

Primer día de cada mes:

```
□ Ejecutar monitor.ts (métricas Tier 2 incluidas)
□ Revisar tabla de 14 métricas contra umbrales
□ Comparar P&L mensual con expectativas:
  - Meses positivos esperados: ~60%
  - Peor mes aceptable: −8%
  - Mejor mes esperado: +10%
□ Revisar log de todos los rebalanceos del mes:
  - ¿Costes totales < 0.10% AUM?
  - ¿Turnover acumulado < 20%?
□ ¿Hay correlación Olympus-EW en terreno esperado? (ρ > 0.60)
□ ¿Alguna anomalía en asignaciones? (ej: 100% cash sin razón)
□ Decisión: Continuar / Aumentar frecuencia / Escalar a comité
□ Firma: ___
```

---

## 7. DECISIÓN TRIMESTRAL — GO / NO GO SOBRE CAPITAL

El comité evalúa:

| Condición | Peso |
|---|---|
| Tier 3: 6/6 ✅ | 40% |
| Sin eventos 🔴 en el trimestre | 25% |
| Forward Sharpe dentro del 60% del backtest | 20% |
| Sin anomalías operativas (bugs, datos faltantes, errores de ejecución) | 15% |

**Puntuación ≥ 80% → GO (aumentar capital)**  
**Puntuación 60–79% → GO CONDICIONAL (mantener capital actual, repetir en 3 meses)**  
**Puntuación < 60% → NO GO (no aumentar, revisar arquitectura)**

---

## 8. COMUNICACIÓN Y ESCALADO

| Evento | ¿Quién? | ¿Cuándo? | ¿Cómo? |
|---|---|---|---|
| 🟡 Atención | Trader → Cuant | 24h | Email con monitor_report.json |
| 🟠 Precaución | Cuant → Comité | 48h | Informe con diagnóstico |
| 🔴 PAUSAR | Comité completo | Inmediato | Reunión de emergencia |
| GO trimestral | Comité → Inversor | Día 5 del trimestre siguiente | Informe ejecutivo (1 página) |

---

## 9. DIARIO DE PAPER TRADING

Cada entrada semanal debe registrar:

```csv
semana,fecha,sharpe_rolling,cagr,maxdd,vol,expansion_ratio,veredicto,accion,notas
```

Ejemplo:
```
1,2026-07-21,0.72,13.1%,-14.2%,11.3%,72%,🟢,continuar,Semana tranquila. VIX 18. Sin rebalanceo.
2,2026-07-28,0.69,12.8%,-15.1%,12.1%,68%,🟢,continuar,BTC -8% pero Olympus solo -2%. Buena proteccion.
```

---

## 10. REFERENCIAS RÁPIDAS

### Comandos

```bash
# Ejecutar paper trading con datos frescos
npx tsx scripts/paper_trading.ts

# Monitorizar
npx tsx scripts/monitor.ts

# Ver últimos 7 días del log
tail -7 paper_trading_log.csv

# Ver alertas de la última ejecución
cat monitor_report.json | grep -A 20 alerts
