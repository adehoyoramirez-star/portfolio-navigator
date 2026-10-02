# PREREGISTRO — FASE 3B · IMPLEMENTACIÓN CONTROLADA DE CORRECCIONES

> **Commiteado ANTES de implementar.** Criterios de aceptación y definición de regresión congelados.
> Fecha: 02-oct-2026. Modo: ESCRITURA permitida SOLO en los ficheros listados por corrección.
> Sin push. Un commit por corrección, cada uno con su test. Si un test falla → revertir esa
> corrección y seguir.

## 0. Baseline congelado

- `HEAD 15bbe3c` · branch `main` · `main...origin/main [ahead 5]` (sin push).
- `npx tsc --noEmit` = **0 errores** · `npx vitest run` = **586/586** (38 archivos).
- **Referencia canónica** (`scripts/validation/canonical.ts`):
  - MOTOR: **CAGR 22,92% · Sharpe 1,332 · MaxDD −15,2%** (fuente de verdad).
  - Cross-check propio: 23,14% / 1,266 / −15,4%.
- Prohibido tocar pesos, umbrales de riesgo, parámetros del motor, BL, HRP, kill switch, régimen.
  Prohibido añadir indicadores/filtros de valoración.

## 1. Definición de REGRESIÓN (aplicable a toda corrección)

Una corrección se considera REGRESIÓN si, tras aplicarla:
1. `npx tsc --noEmit` ≠ 0, **o**
2. `npx vitest run` no queda todo en verde (incluyendo los tests nuevos), **o**
3. el runner canónico deja de reproducir MOTOR **22,92% / 1,332 / −15,2%** — **salvo** en las
   correcciones 1 y 2, donde la diferencia se documenta explícitamente.

Acción ante regresión: `git revert` de esa corrección y continuar con la siguiente.

## 2. Criterios de aceptación por corrección

### CORRECCIÓN 1 — Coste a spread completo (`transactionCosts.ts`)
- **Cambio**: `computeTradeCost` cobra el spread COMPLETO, coherente con el motor
  (`backtestEngine.ts` `getAssetSpreadCost = halfSpreadBps × 2 / 10_000`).
- **Test**: para una orden de referencia, `breakdown.spreadCost == turnoverEur × halfSpreadBps/10_000 × 2`.
- **Reporte**: cambio en costes de la cuenta simulada (FULL). **Sin cambio en pesos del motor.**
- **Aceptación**: test en verde; canónico sin cambio de pesos (la diferencia de coste se documenta).

### CORRECCIÓN 2 — Alerta/rebalanceo por evento de de-risking
- **Cambio**: cuando `Σtarget` cae **>5 pp** (umbral FIJO, no tuneable) respecto del último
  rebalanceo, marcar el día como "rebalanceo recomendado" y permitir generar las órdenes de venta
  hacia el nuevo objetivo, fuera de cadencia. **No ejecuta nada automáticamente.**
- **Test**: COVID (100% → 57%) genera órdenes de venta el 2020-02-28; caso sin caída → no alerta.
- **Validación** (2018-Q4, COVID-2020, 2022, FULL largo): MaxDD, Sharpe, CAGR, nº alertas/año,
  turnover, costes.
- **Aceptación**: se acepta el auto-rebalanceo por evento **si en las 3 ventanas (2018-Q4, COVID,
  2022) el MaxDD no empeora Y el turnover FULL no sube más del 25%**. Si falla → revertir el
  disparo automático y **dejarlo solo como alerta informativa**.

### CORRECCIÓN 3 — T6-1: `BTC_CYCLE_OVERRIDE` respeta `BTC_TOTAL_GATE` (`smartDCA.ts`)
- **Cambio**: el override no compra BTC si `btcTotalComposite ≥ 0.337` (misma regla que el ataque
  BTC-only), devolviendo WAIT.
- **Test**: CRISIS + 4 señales + BTC_TOTAL 40% → **WAIT** (hoy compra ~€1.081). Con BTC_TOTAL 30%
  sigue comprando. `staleDataBlock` y `killSwitchLevel ≥ 4` siguen bloqueando.
- **Aceptación**: los 3 casos en verde; canónico intacto.

### CORRECCIÓN 4 — T6-2: tope explícito del ataque (`smartDCA.ts`)
- **Cambio**: una compra de ataque no puede dejar el peso del activo por encima de **target + 5 pp**
  (suelo EXTREME) — el cap **NO** se multiplica por `bottomMul`.
- **Test**: probe EXTREME donde la compra superaría target+5 pp → se recorta al tope; caso normal
  (sin señal / drift negativo) **no cambia**.
- **Aceptación**: test en verde; canónico intacto.

### CORRECCIÓN 5 — Control muerto `dcaEngine.ts:117`
- **Cambio**: verificar de nuevo que NO hay consumidores (dashboard/core/output.dca). Si no hay
  ninguno → eliminar la liquidación del 30% (VENTA DE EMERGENCIA) o marcarla deprecada con
  comentario y test de que no se usa. **NO conectarla a ejecución.**
- **Aceptación**: verificación de consumidores documentada + test. Canónico intacto.

## 3. Fuera de alcance (NO hacer)

Capa de ataque con inputs on-chain (Fase 3C), simplificar el motor, límite de BTC, Momentum/Value,
Monte Carlo, cambios de UI no necesarios para la alerta.

## 4. Entregable por corrección

diff · test nuevo · comando de reproducción · métricas antes/después. Cierre: `tsc` 0 errores,
`vitest` verde con los tests nuevos, canónico reproducido, `git log` de la fase.

## 5. Comandos

```bash
npx tsc --noEmit
npx vitest run
npx tsx scripts/validation/canonical.ts
npx tsx scripts/validation/fase3b_costs.ts        # coste cuenta antes/después (CORRECCIÓN 1)
npx tsx scripts/validation/fase3b_derisk.ts       # validación evento de-risking (CORRECCIÓN 2)
```
