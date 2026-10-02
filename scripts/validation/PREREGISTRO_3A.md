# PREREGISTRO — FASE 3A · OLYMPUS

> **Commiteado ANTES de ejecutar cualquier test.** Criterios y ventanas congelados en el commit
> que precede a toda corrida. Fecha: 02-oct-2026. Modo: READ-ONLY sobre `src/`, sin push,
> overrides solo en memoria desde `scripts/validation/`.
>
> **Baseline**: `HEAD 456c6e5` (housekeeping 2B/2C) · branch `main` · `main...origin/main [ahead 3]`
> · `src/` limpio · `tsc --noEmit` 0 errores · `vitest run` 586/586 · dataset largo
> 2309 filas · 2017-07-26 → 2026-10-01 · gate VÁLIDO · `ENGINE_VERSION v5.4.6`.

## 0. Contabilidad N

- **Variantes de estrategia que cuentan para DSR**: mismas que 2B/2C = N_headline 20 (histórico 3 +
  ablación 7 [V1-V6,V5'] + KS A/B/C 3 + caps BTC 6 + BL 2 = 21; headline conservador 20).
  **3A añade 0 variantes.**
- **Robustez (NO cuenta)**: diagnóstico de brecha, matriz 2×2 homogénea, reconstrucción de señales de
  ataque, riesgo BTC — son diagnósticos de los mismos arms, no estrategias nuevas.
- **Ventanas (NO cuentan)**: FULL largo, HOLDOUT/VISTA, COVID-2020, 2022, 2018, 2018-Q4.

## 1. TEST 1 — Diagnóstico de la brecha (COVID-2020 y 2022)

Se instrumenta el simulador de cuenta (script) para registrar por día: exposición objetivo total del
motor `Σ allocations[k]`, exposición invertida real `1 − cash/PV`, valor de cuenta, nivel de kill
switch (réplica P3) y log de órdenes (DCA semanal y Rebalancer mensual, BUY/SELL, ticker, €).

**Hipótesis (una a una, con evidencia):**
- **H1 — el rebalancer no vende hacia cash cuando cae la exposición objetivo total.** Confirmada si,
  en días de rebalanceo con `Σtarget` muy por debajo de la exposición real, el rebalancer no emite
  SELL (o el SELL no alcanza el target) y la cuenta permanece >2pp por encima del target total.
- **H2 — cadencia.** El motor rebalancea cada 21 días; la cuenta simulada ejecuta el rebalancer cada
  30 días (declarado) → reacciona más tarde. Confirmada si en la ventana de crash la cuenta deja
  pasar un rebalanceo del motor sin actuar.
- **H3 — umbrales MIN_TRADE/drift.** `driftThreshold = 0.02` puede saltar SELLs pequeños.
  Confirmada si hay activos con `0 < drift ≤ 2pp` no recortados.
- **H4 — `allocationMultiplier < 0.6` bloquea compras, no genera ventas.** Confirmada por código
  (`rebalancer.ts` L~305: el filtro aplica solo a BUYs; los SELLs dependen de `drift` y `shouldTrim`).
- **H5 — otra causa** (a documentar): p.ej. el DCA semanal recompra y neutraliza el de-risking, o los
  targets se mantienen constantes entre rebalanceos del motor.

**Cuantificación**: se simula en el script una corrección por causa (p.ej. forzar cadencia 21d;
vender todo el exceso sobre target hasta cash) SIN tocar `src/`, y se reporta ΔMaxDD (pp).

**d)** Se muestran las salidas reales del rebalancer en días de caída de exposición: ¿el usuario
recibe órdenes SELL (reducir) o solo BUY/recortes relativos?

Criterio de veredicto por hipótesis: CONFIRMADA / DESCARTADA / INCONCLUSO.

## 2. TEST 2 — Comparación homogénea (misma capa de ejecución)

Matriz 2×2 sobre FULL largo, HOLDOUT y VISTA, **€400/mes** y **costes de spread completo**
(corrección declarada: `computeTradeCost` cobra solo medio spread → en el script se duplica
`halfSpreadBps`; el impacto se mantiene). Celdas:
- (targets motor × ejecución IDEAL): rebalanceo exacto a target cada 21d, fraccional, spread completo.
- (targets motor × ejecución REAL): DCA semanal + rebalancer mensual (simulador).
- (targets V3 × ejecución IDEAL).
- (targets V3 × ejecución REAL).

Reporta XIRR, TWR (CAGR), Sharpe, MaxDD, CVaR95, costes, turnover.
**Descomposición**: (A) selección de pesos = [V3 ideal] − [motor ideal]; (B) capa de ejecución =
[motor ideal] − [motor real].
**Criterio**: la capa de ejecución es DEFECTUOSA si degrada el MaxDD de COVID en **>5pp** frente a
la ejecución ideal con los mismos targets.

## 3. TEST 3 — Capa de ataque: reconstruir señales

- Se invoca el **detector real** `detectCycleBottoms(inputs, topSignals)` (`cycleTopDetector.ts`)
  sin ajustar umbrales, alimentado con lo derivable del dataset largo y **declarando cada input**:
  `mvrvRatio` (proxy BTC/MA252, NO MVRV de red), `btcRsiWeekly` (RSI(14) semanal de BTC),
  `wlgRsiWeekly` (RSI(14) semanal de URTH), `bondYield10y` (^TNX). **No disponibles** →
  `puellMultiple`, `mvrvZScore`, `uraniumSpotPrice/LT`, `siaSalesYoY`, `soxRsiWeekly`, `brentOil`,
  `wlgPERatio` → señales de esos activos quedan NEUTRAL.
- Reejecuta la cuenta con `cycleBottomSignals` reconstruidas en FULL largo y reporta: nº de señales
  por nivel, compras bajo EXTREME, exceso máximo sobre target, round-trips, disparos de
  `BTC_CYCLE_OVERRIDE` con BTC_TOTAL ≥ 0.337, e impacto en XIRR/Sharpe/MaxDD vs ataque desactivado.
- **Si la reconstrucción no es fiel** (por los inputs faltantes): **NO VERIFICADO** y se explica qué
  falta. No se infiere el resultado.

## 4. TEST 4 — Riesgo BTC de la cuenta completa (corrección)

- Fórmula: `RC_i = w_i·(Σw)_i / (wᵀΣw)`, **Σ de log-retornos diarios anualizada** (×365).
- Pesos: satélite `btcSatPct(80) = 0.20` + motor `olyPct(80)×w_BTC_motor` + resto del motor.
  Fuente: `src/core/backtest/composite.ts`; default `olympusPct=80` (`InstitutionalDashboard.tsx:464`).
- Reporta RC de BTC con Σ de 1y/2y/3y y **toda la historia larga**, para: cuenta completa, motor solo,
  satélite solo. **Reconcilia** con el 14.2% del informe 2C (declarar qué pesos/Σ se usaron).
  **Control de referencia** (a reproducir de forma independiente): con BTC 28.7% nominal y el resto
  con la mezcla del motor → RC ≈ 42% (1y) / 44% (2y) / 46% (3y) / 55% (historia completa).
  Si el cálculo no converge a la referencia, se declara la discrepancia (no se oculta).
- MaxDD de la cuenta completa en 2018, 2022 y shock BTC −70% (aplicando el peso real).
- **Sin proponer límite final.** Solo tabla nominal 10/15/20/25/30/35% vs RC vs CAGR/MaxDD.

## 5. TEST 5 — Correcciones candidatas (solo propuesta, NO implementar)

Para cada hallazgo confirmado: archivo:línea, cambio mínimo, test que lo cubre, impacto estimado
(cifra medida en el script) y riesgo de regresión, ordenado por impacto/riesgo. No se edita `src/`.

## 6. Comandos

```bash
npx tsx scripts/validation/fase3a_test1.ts   # brecha motor↔cuenta + H1-H5
npx tsx scripts/validation/fase3a_test2.ts   # matriz 2x2 homogénea (spread completo)
npx tsx scripts/validation/fase3a_test3.ts   # reconstrucción de señales de ataque
npx tsx scripts/validation/fase3a_test4.ts   # riesgo BTC (RC corregido, log-retornos)
git status -sb; npx tsc --noEmit; npx vitest run
```

## 7. Honestidad

Toda cifra sale de un comando mostrado; lo no ejecutable = **NO VERIFICADO**. No se cambia `src/`,
no se añaden indicadores (incl. filtro de valoración), no se optimiza, no Monte Carlo, no
Momentum/Value. Cierre: `src/` limpio, `tsc` 0 errores, `vitest` 586/586.
