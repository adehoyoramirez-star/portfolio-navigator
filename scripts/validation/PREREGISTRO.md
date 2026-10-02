# PREREGISTRO — FASE 2B · OLYMPUS

> **Este documento se commitea ANTES de ejecutar cualquier test de la Fase 2B.**
> Criterios, fórmulas y definiciones quedan congelados en el commit que precede a toda corrida
> (verificable en `git log`). Fecha: 02-oct-2026. Modo: READ-ONLY sobre `src/`;
> overrides solo en memoria desde `scripts/validation/`; sin push.

---

## 0. Contabilidad N (regla 4)

**(a) Variantes de estrategia — SÍ cuentan para DSR/PBO**
- TEST 2: V1–V6 = 6 arms.
- TEST 3: A/B/C = 3 arms.
- TEST 4: 6 caps (10/15/20/25/30/35%) = 6 arms.
- TEST 5: A/B = 2 arms.
- **Total Fase 2B = 17 arms.**
- Histórico bajo la regla nueva (offsets/costes/ventanas de crisis/estrés NO cuentan):
  variantes de estrategia declaradas = motor, cuenta real, B&H = **3** (supuesto declarado,
  conservador; Fase 1 fueron re-corridas del mismo runner → robustez).
- **N acumulado (headline) = 3 + 17 = 20.** Se reportan además N=55 (regla antigua Fase 2A)
  y N=72 (=55+17) como sensibilidad. DSR/PBO se recalculan con los tres.

**(b) Robustez — NO cuentan**: 36 offsets, 4 escalas de coste, ventanas crisis/estrés (Fase 2A),
ventanas del TEST 1 (misma estrategia, otra data) y diagnósticos P1–P3.

---

## 1. P1 — Definición exacta del B&H y benchmarks comparables

Definición del B&H de Test A (código `account_backtest.ts`, líneas ~228-252):
- Igual peso 1/6 en los 6 activos; capital inicial €10.000 en el primer día post-warm-up
  (2022-12-30); aportaciones €400/mes invertidas 1/6 a cierre del día de cambio de mes;
  sin rebalanceo; **sin costes**; acciones fraccionadas para TODOS los activos (incluidos ETFs).

No comparabilidad declarada vs cuenta real: (1) sin costes; (2) ETFs fraccionados
(la cuenta ejecuta acciones enteras); (3) 100% desplegado el día 1 vs cash medio 9.9% de la cuenta.

Benchmarks recalculados (mismo calendario, aportaciones €400/mes y ejecución que la cuenta):
- **BH1** = BH0 + costes reales por compra (`computeTradeCost`).
- **BH2** = BH1 + acciones enteras en ETFs (BTC fraccional).
Métricas: TWR (CAGR/Sharpe/MaxDD/CVaR95m) + XIRR + valor final.
**Control**: BH0 debe reproducir 63.36% / 2.169 / −21.6% (Test A) o el dataset cambió.

## 2. P2 — Round-trips: desglose por causa y activo

Se instrumenta una réplica del simulador de cuenta, validada contra `account_backtest.ts`
(debe reproducir 23.39% / 1.244 / −12.5% / €524 / 343 órdenes / 49 trims / €81.595 antes de
usar el desglose; si no reproduce, se reporta la discrepancia). Por cada trim OVERWEIGHT
(cualquiera, no solo los del contador histórico — el flag `dcaBought` nunca se resetea en el
código actual, lo que infla el contador):
- fecha, ticker, drift, € vendidos, target;
- € comprados por DCA del activo desde el último rebalanceo; últimos 7/14/30 días;
- retorno del activo vs retorno del portfolio desde el último rebalanceo.

Definiciones congeladas:
- **Round-trip verdadero** = trim ≤30 días después de una compra DCA del mismo activo.
- **€ evitables** = vendido × min(1, compras30d / exceso€), exceso€ = drift×PV;
  el resto = deriva de precios / cambio de target.
- **Churn directo** = € comprados por DCA cuando el drift ya era > +2pp en el momento de comprar
  (medida adicional, directamente evitable en la capa DCA).
Salida: tabla por activo + total; comparación con 49/€81.595.

## 3. P3 — Kill switch: base, frecuencia, conexión y nivel diario

- **Base**: drawdown unificado del sleeve motor `DD = min(0,(V−peak)/peak)`
  (`src/core/risk/drawdown.ts`; `backtestEngine.ts` L822-824) sobre `portfolioValue` del backtest.
- **Frecuencia**: el motor —y por tanto el kill switch— solo se evalúa en días de rebalanceo
  (`dayIndex % 21 === 0`, `backtestEngine.ts` L808). El `drawdown` de cada registro diario
  (L1163) es de reporting. Se reportan AMBAS series: "engine-seen" (solo rebalanceo) y diaria.
- **Nivel por día**: réplica exacta con los umbrales exportados `TAIL_RISK_CONFIG.KILL_SWITCH`
  (L1 12%→0.80 · L1.5 13.5%→0.65 · L2 15%→0.50 · L3 20%→0.30 · L4 25%→0.15 · L5 32%→0.05).
- **Post-escalado**: overlay ∈ [0.05,1] multiplica `totalInvested = volTarget × overlay`
  (`olympusV3.ts` L1229). La exposición observada NO identifica niveles por sí sola
  (volTarget confunde) → se abandona el proxy de Fase 2A y se usa la réplica exacta.
- **Conexión**: el runner canónico no pasa `coreMode` → kill switch ACTIVO; el DD que alimenta
  tailRisk es el mismo objeto del registro. Se verifican ambos hechos en código.
Salida: días por nivel (canónico + ventanas largas) y explicación de la discrepancia con el
"only L1" anterior.

## 4. P4 — Veredicto correcto del TEST C (sin re-ejecutar)

- Criterio preregistrado (Fase 2A): "P5 Sharpe > 0.5".
- Offsets (36 corridas): P5 = 1.029 → **CUMPLE**.
- Bootstrap por bloques 21d: P5 = 0.325 → **NO CUMPLE**.
- Veredicto estricto (el criterio aplica a ambos): **NO CUMPLE global**; por separado:
  robusto a la fecha de inicio, NO robusto en el P5 del bootstrap.
- Cifras de los comandos ya mostrados en Fase 2A (`robustness.ts`), re-ejecutados en esta sesión.

## 5. TEST 1 — Dataset largo con proxies reales

Proxies (Yahoo chart API, precios ajustados; USD→EUR con EURUSD=X real; sin rellenado hacia atrás):

| Activo cartera | Ticker proxy | Primera fecha real (a reportar) | Por qué es proxy válido |
|---|---|---|---|
| BTC-EUR | BTC-USD ÷ EURUSD=X | 2014-09 (aprox) | conversión FX real; BTC-EUR directo en Yahoo tiene menos historia |
| EMXC.DE | EMXC (US, iShares MSCI EM ex-China) | 2017-08 (aprox) | mismo índice MSCI EM ex-China |
| PPFB.DE | GLD | 2004-11 (aprox) | oro físico |
| URNU.DE | URA (Global X Uranium) | 2010-08 (aprox) | mismo sector (mineras de uranio) |
| VVSM.DE | SOXX (iShares Semiconductor) | 2001-07 (aprox) | semis US |
| 0P00000WLG.F | URTH (iShares MSCI World) | 2012-01 (aprox) | MSCI World |

Macro: `^VIX`, `^TNX`, `^IRX`, `HYG`, `LQD`, `^MOVE`, `DX-Y.NYB` reales de Yahoo;
`BTC_VOL` = vol realizada 60d anualizada (decimal), validada contra la columna del CSV aumentado
en el solape (se reporta correlación y ratio medio).

- **Sin rellenado hacia atrás**: cada serie empieza en su primera barra real; el dataset empieza en
  max(primeras fechas) ≈ 2017-08.
- **Alineación**: calendario de días hábiles US (todos los proxies son US); BTC/EURUSD = valor del
  mismo día o último ≤5 días.
- **Validación (gate)**: |retorno diario| > 25% se lista por activo (BTC puede ser legítimo;
  equity >25% = error → serie inválida); huecos >5 días se listan. Si el gate falla →
  TEST 1 = NO VÁLIDO y TESTS 3/5 = NO CONCLUYENTE (por instrucción).
- **Ventanas**: 2018-Q4 (01-oct→31-dic-2018), COVID (01-feb→31-mar-2020), 2022 (año completo),
  FULL (dataset completo). Runner canónico (warm-up continuo) y cuenta real sobre la misma data.
- **Coste de timing venta→reentrada**: se entrega en TEST 3 (A vs B, misma data).

## 6. TEST 2 — Ablación vs alternativas simples

Harness común: €10.000 sin aportaciones, rebalanceo cada 21d a pesos objetivo, costes reales por
operación (`computeTradeCost`; cobra medio-spread — declarado; el motor cobra spread completo
internamente — asimetría declarada), TWR diario. Mismo universo (6 activos).

- **V1** equal-weight; **V2** HRP estático (cov de la primera ventana de 252d, fijo);
  **V3** HRP recomputado cada 21d (trailing 252d) + volTarget (target 20%, mult clamp [0.3,1.5],
  sin penalización de régimen — simplificación declarada);
  **V4** = V3 + `computeTailRiskOverlay` (drawdown propio, vix, creditSpread, stressScore=0
  declarado, vol 63d, correlación media 63d);
  **V5** = motor (`runBacktest` serie propia) y **V5'** shadow (targets del motor en el harness, control);
  **V6** = B&H equal-weight €10k con costes de compra inicial.
- FULL/IS/OOS con split canónico (2023-10-28).
- **Criterio**: V5 se justifica solo si Sharpe_OOS(V5) > Sharpe_OOS(V3) **Y** MaxDD_OOS(V5)
  mejor (menos negativo) **Y** IC95 del ΔSharpe (bootstrap bloques 21d pareado, 10k) excluye 0.
  Si no → recomendar simplificación a V3.

## 7. TEST 3 — Kill switch A/B/C (solo con TEST 1 válido)

- **A** actual · **B** sin kill switch (umbrales DD → 99; overlay sistémico VIX/credit intacto) ·
  **C** umbrales ×0.5 (0.06 / 0.0675 / 0.075 / 0.10 / 0.125 / 0.16).
- Override en memoria: mutación de `TAIL_RISK_CONFIG.KILL_SWITCH` (objeto exportado; sin tocar src/).
- Ventanas: FULL largo + 2018-Q4 + COVID + 2022.
- **Criterio**: A se justifica vs B si (MaxDD_B − MaxDD_A) ≥ 5pp **Y** CVaR95(A) mejor que
  CVaR95(B) **Y** CAGR_A ≥ CAGR_B − 2pp. C se reporta como dosis-respuesta.
- **Coste de timing**: episodios = rachas de días con KS≥1 en A; por episodio,
  retorno_B − retorno_A (compuesto, mismas fechas); suma por ventana.

## 8. TEST 4 — Límite de BTC por riesgo

- Overlay sobre los targets diarios del motor (corrida canónica + dataset largo si es válido):
  `w_BTC' = min(w_BTC, cap)`; el resto reescalado pro-rata; shadow-sim 21d con costes reales.
  Caps: 10/15/20/25/30/35%.
- FULL/IS/OOS: CAGR, Sharpe, MaxDD, CVaR95, vol.
- **Contribución de BTC a la varianza**: `RC = w_BTC·(Σw)_BTC / (w'Σw)` con Σ estimada sobre
  252 / 504 / 756 días de retornos diarios, promedio del periodo.
- **Regla**: si RC varía >10pp entre las ventanas 1y/2y/3y, NO se propone valor final.

## 9. TEST 5 — BL absoluto A/B (solo con TEST 1 válido)

- **Fórmula (1 parámetro)**: `confianza' = confianza × max(0.25, breadth_pos)`,
  `breadth_pos` = fracción de activos con retorno 12m > 0.
- Implementación: intercepción en memoria de `generateViewsExternal` (hook CJS de require desde
  `scripts/validation/`; sin editar src/). Si la intercepción no es viable → **NO VERIFICADO**
  (no existe palanca de override; la confianza está hardcodeada en el motor).
- **Probe**: cartera sintética con todos los retornos12m < 0 → confianza 0.25 → 0.0625 (×4 menos
  influencia de las views); el spread cross-sectional NO cambia (clamp 0.02-0.20) — el ajuste
  actúa por confianza, no por spread.
- **Criterio**: se adopta solo si mejora MaxDD **Y** CVaR95 en las ventanas de crisis
  sin bajar el Sharpe OOS.

## 10. Comandos (todos con HEAD conocido antes del commit del preregistro)

```bash
npx tsx scripts/validation/data_long.ts       # TEST 1: fetch + validación + cache
npx tsx scripts/validation/p1_benchmarks.ts   # P1
npx tsx scripts/validation/p2_roundtrips.ts   # P2
npx tsx scripts/validation/p3_killswitch.ts   # P3
npx tsx scripts/validation/long_run.ts        # TEST 1b: canónico + cuenta en ventanas largas
npx tsx scripts/validation/ablation.ts        # TEST 2
npx tsx scripts/validation/ks_abc.ts          # TEST 3
npx tsx scripts/validation/btc_limit.ts       # TEST 4
npx tsx scripts/validation/bl_absolute.cjs    # TEST 5 (npx tsx o node --require tsx/cjs)
N_EXEC=20 npx tsx scripts/validation/dsr_pbo.ts   # + N_EXEC=55 y 72 (sensibilidad)
git status -sb; npx tsc --noEmit; npx vitest run
```

## 11. Honestidad

- Toda cifra sale de un comando mostrado; lo no ejecutable = **NO VERIFICADO**.
- Prohibido: tocar `src/`, optimizar parámetros, añadir indicadores, Monte Carlo, Momentum/Value.
- Cierre: `git status -sb` (src/ limpio), `tsc --noEmit` 0 errores, `vitest run` 586/586.

