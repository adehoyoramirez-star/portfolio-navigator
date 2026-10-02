# PREREGISTRO — FASE 2C · OLYMPUS

> **Este documento se commitea ANTES de ejecutar cualquier test de la Fase 2C.**
> Criterios, ventanas y definiciones quedan congelados en el commit que precede a toda corrida
> (verificable en `git log`). Fecha: 02-oct-2026. Modo: READ-ONLY sobre `src/`;
> overrides solo en memoria desde `scripts/validation/`; sin push.
>
> **Baseline congelado**: `HEAD = 60d1b36` · branch `main` · `main...origin/main [ahead 1]`
> (PREREGISTRO 2B commiteado, sin push) · working tree: solo `scripts/validation/*` untracked ·
> `npx tsc --noEmit` = 0 errores · `npx vitest run` = 586/586 en 38 archivos ·
> `ENGINE_VERSION = "v5.4.6"` (`src/core/engine/olympusV3.ts:122`) ·
> `ENGINE_CONFIG_VERSION = "3.9.0"`.

---

## 0. Contabilidad N (regla 4) — y por qué N no crece en 2C

**La Fase 2C NO crea variantes nuevas** (prohibido). Reutiliza el universo ya declarado:

- **Estrategias/variantes que SÍ cuentan** (universo de selección acumulado):
  - Histórico declarado (motor, cuenta real, B&H) = **3**
  - TEST 2 de 2B: V1·V2·V3·V4·V5·V5'·V6 = **7** — *nota: en el headline de 2B se contaron 6;
    2C usa V5' como control y lo declara explícitamente; se conserva el criterio conservador de 2B
    y se reporta N=20 (headline) además de N=55 y N=72.*
  - TEST 3 de 2B (kill switch A/B/C) = **3**
  - TEST 4 de 2B (caps BTC 10..35%) = **6**
  - TEST 5 de 2B (BL A/B) = **2**
  - TEST 3/4 de 2C (BTC total 10..35%) = **mismo conjunto de caps**, no nuevas.
  - **N_headline = 20 · N_amplio = 55 · N_max = 72** (sensibilidad; mismo universo que 2B).
- **Ventanas de robustez — NO cuentan**: HOLDOUT / VISTA / FULL, 2018-Q4, COVID-2020, 2022
  (misma estrategia, otra data) = 6 ventanas diagnósticas.
- **Stress tests — NO cuentan**: shock BTC −70%, ventanas de covarianza 1y/2y/3y.

**Cómo se obtiene N**: N = Σ variantes con decisión binaria de adopción dentro del mismo pipeline
de selección (fase histórica + 2A + 2B). Las ventanas solo re-muestrean las mismas estrategias.
2C aporta 0 variantes → N_2C = 0.

## 1. Definiciones matemáticas unificadas (una sola implementación)

Módulo único `scripts/validation/metrics_unified.ts`. Se aplica **idénticamente** a cuenta real,
motor, B&H, V1–V6 y BTC total.

- **TWR** (time-weighted return): retorno diario `r_t = (V_t − F_t) / V_{t−1} − 1`, con `F_t` = aporte
  neto del día (€400 en el día de cambio de mes; 0 si no). El índice TWR es `Π(1+r_t)`.
  Es el **rendimiento puro de la estrategia**: independiente del calendario de aportaciones.
- **XIRR / TIR** (money-weighted): raíz de `Σ F_k / (1+r)^{t_k/365} = 0` sobre los flujos reales
  (−€10.000 día 0, −€400/mes, +valor final). Es el **rendimiento del dinero del inversor**.
- **CAGR** = `(Π(1+r_t))^{365/n} − 1` sobre el TWR (rendimiento puro anualizado).
- **Sharpe** = `(mean(r_t)·365 − rf) / (sd(r_t)·√365)`, `rf = 4%`.
- **MaxDD** = min sobre el índice TWR `Π(1+r_t)` de `(idx_t / peak_t − 1)`.
- **CVaR95 mensual** = media del 5% peor de los retornos mensuales compuestos.
- **turnover** = € nocionales negociados; **costes** = suma de `computeTradeCost` por operación;
  **patrimonio final** = valor de cartera el último día.

### Explicación obligatoria: B&H CAGR 63,36% vs XIRR 33,14% vs V6 CAGR 34,93%

Hipótesis a **verificar** (no asumida) en TEST 5:
- El B&H de `account_backtest.ts` (L~260) calcula `bhTwr.push(v / v_prev − 1)` **sin restar el
  aporte** → cada ingreso de €400 se contabiliza como un retorno positivo, inflando el TWR (63,36%).
  **Ese número no es un TWR válido.**
- El **XIRR 33,14%** es el TIR money-weighted correcto (no depende del error anterior).
- **V6 34,93%** es el TWR de un B&H a tanto alzado (€10k, sin aportes): el rendimiento puro de la
  estrategia sin distorsión de flujos.
- **Predicción verificable**: el TWR del B&H **corregido por flujos** (F_t restado) debe caer
  ≈33–35%, próximo a V6 y a XIRR. Si no cae, la hipótesis es falsa y se declara NO VERIFICADO.

## 2. Ventanas (sobre el dataset largo validado 2017-07-26 → 2026-10-01, proxies Yahoo)

- **HOLDOUT** = 2018-07-01 → 2022-11-30 *(declarado NO VISTO para la selección previa de V3;
  el warm-up de 252d termina ≈2018-07, por lo que HOLDOUT cubre toda la historia post-warm-up
  hasta fin-2022)*.
- **VISTA** = 2022-12-01 → 2099-12-31 (hasta fin de datos).
- **FULL** = 2018-07-01 → 2099-12-31.
- Diagnósticas: **2018-Q4** (2018-10-01→2018-12-31), **COVID-2020** (2020-02-01→2020-03-31),
  **2022** (2022-01-01→2022-12-31).

## 3. TEST 1 — Ablación en HOLDOUT (definiciones V1-V6 CONGELADAS, sin variantes nuevas)

Harness común (idéntico a 2B): €10.000, sin aportaciones, rebalanceo 21d, costes reales
(`computeTradeCost`, medio-spread — declarado), acciones fraccionales, TWR.
- **V1** equal-weight · **V2** HRP estático (cov 1ª ventana 252d) · **V3** HRP recomputado 21d
  (252d) + volTarget (target 20%, clamp [0.3,1.5], regimePenalty=1.0 declarado) ·
  **V4** = V3 + `computeTailRiskOverlay` (stressScore=0 declarado) · **V5** motor (`runBacktest`) ·
  **V5'** shadow de targets del motor (control) · **V6** B&H equal-weight con coste inicial.

### Criterios congelados

**V3 CONFIRMADA fuera de muestra** ⇔ se cumplen los 3:
1. HOLDOUT: `Sharpe(V3) ≥ Sharpe(Motor completo)`.
2. HOLDOUT: `MaxDD(V3) ≥ MaxDD(Motor) − 0.02` (no peor en >2pp).
3. FULL: IC95% del ΔSharpe `(V3 − Motor)` por bootstrap de bloques de 21d (10.000 réplicas
   pareadas) **NO implica pérdida relevante** ⇒ se define pérdida relevante como
   **límite inferior del IC95 < −0,20**. Si el límite inferior ≥ −0,20 → sin pérdida relevante.

**Motor completo JUSTIFICADO** ⇔ en HOLDOUT:
- `Sharpe(Motor) > Sharpe(V3)` **Y** `MaxDD(Motor) > MaxDD(V3)` (menos negativo) **Y**
  el IC95% del ΔSharpe `(Motor − V3)` (bloques 21d, 10.000) **excluye 0**.

**Reglas de veredicto**: si V3 gana en VISTA pero NO en HOLDOUT → **INCONCLUSO** (no simplificar).
Si V3 gana HOLDOUT pero pierde claramente en FULL → investigar discrepancia, sin victoria automática.

## 4. TEST 2 — Ejecución con vetos reales (cuenta simulada)

Se conectan a `computeSmartDCA` los valores del motor, revertidos/derivados con precisión declarada:
- **regimePenalty** = del régimen real del motor (EXPANSION 1,0 · CONTRACTION 0,6 · CRISIS 0,4).
- **volTargetMultiplier** = `computeVolTargetMultiplier` (misma función del motor) sobre los pesos
  objetivo del motor, vol realizada 63d, regimePenalty; **replicación declarada**.
- **killSwitchLevel** = réplica de P3 (drawdown unificado + `TAIL_RISK_CONFIG.KILL_SWITCH`, umbrales
  exportados); **exacto respecto de la réplica P3, declarado**.
- **staleDataBlock** = el dataset largo está validado sin huecos >5d ⇒ **nunca activo** (efecto 0 por
  construcción; declarado).

Casos: **A** cuenta sin vetos (penalty 1,0, volTarget 1,0, KS 0) · **B** cuenta con vetos reales ·
**C** motor teórico (`runBacktest`). Ventanas: COVID-2020, 2022, FULL.
Salida: CAGR, Sharpe, MaxDD, CVaR95, cash medio, turnover, costes, días bloqueado, compras DCA (n)
y €, ventas (n) y €.
**Pregunta**: ¿el MaxDD −30,7% en COVID es limitación del simulador previo o comportamiento real de
la capa DCA? Se responde comparando A vs B.

## 5. TEST 3+4 — BTC de la cuenta COMPLETA (satélite + motor)

- Valores reales de código: `btcSatPct(olympusPct)` y `olyPct(olympusPct)` (`src/core/backtest/composite.ts`);
  default documentado **`olympusPct = 80`** (`InstitutionalDashboard.tsx:464`, "DEFAULT 80 (satélite 20%)").
  ⇒ **satélite = 20%, motor = 80%**. `btcTotalExposure(olympusPct, engineBtcWeight)`.
  No existen valores históricos de la cuenta ⇒ **defaults documentados, declarados**.
- **BTC total nominal** = `btcTotalExposure(80, w_BTC_motor)`; caps analíticos 10/15/20/25/30/35%
  aplicados sobre el BTC total (satélite fijo + tramo motor), **sin modificar el motor**.
- Ventanas: 1y, 2y, 3y, larga 2018-2026, 2018, 2022, **shock BTC −70%** (analítico: se aplica el
  −70% al tramo BTC de cada serie de pesos y se mide el impacto).
- **Contribución de BTC a la varianza**: `RC = w_B·(Σw)_B / (w'Σw)`, Σ sobre 1y/2y/3y,
  muestreada en rebalanceos. **Regla**: si RC varía >10pp entre ventanas ⇒ NO se propone límite final.
- **Coste de reducir BTC**: para 10..35% reportar CAGR, Sharpe, MaxDD, CVaR95, riesgo de cartera y
  **coste de CAGR** vs caso base (BTC total sin cap). No se declara "mejor".

## 6. TEST 5 — Benchmarks con métricas separadas

Mismo capital (€10.000), mismas aportaciones (€400/mes), mismos costes (`computeTradeCost`),
mismo calendario (dataset largo). Fila por cartera: B&H universo, Equal Weight, V3, Motor completo,
BTC total de la cuenta. Se separan **CAGR (TWR) / XIRR / TWR** y se resuelve §1.

## 7. Salidas obligatorias

- Una tabla por test con `RESULTADO ∈ {CONFIRMADO, NO CONFIRMADO, INCONCLUSO, NO VERIFICADO}`.
- **Tabla final** HOLDOUT / VISTA / FULL × (B&H, Equal Weight, V3, Motor) con
  CAGR, XIRR, Sharpe, MaxDD, CVaR95, Turnover, Costes.
- N total, DSR/PBO recalculados, IC95% de diferencias, BTC total y riesgo, impacto de los vetos DCA,
  discrepancias de runners, limitaciones, conclusión.
- Respuestas A–F.
- **PARADA OBLIGATORIA** con `git status -sb`, `npx tsc --noEmit`, `npx vitest run`.

## 8. Prohibiciones (Fase 2C)

NO optimizar V3/motor · NO cambiar pesos/umbrales/Kill Switch/BL/BTC cap · NO conectar
Momentum/Value · NO corregir T6-1/T6-2/código muerto · NO añadir indicadores · NO Monte Carlo ·
NO crear variantes nuevas. Toda cifra sale de un comando mostrado; lo no ejecutable = **NO VERIFICADO**.

## 9. Comandos

```bash
npx tsx scripts/validation/fase2c_test1.ts              # TEST 1: ablación HOLDOUT/VISTA/FULL
npx tsx scripts/validation/fase2c_test2.ts              # TEST 2: vetos reales A/B/C
npx tsx scripts/validation/fase2c_test3.ts              # TEST 3+4: BTC total, caps, RC, coste
npx tsx scripts/validation/fase2c_test5.ts              # TEST 5: benchmarks + tabla final
N_EXEC=20 npx tsx scripts/validation/fase2c_dsr.ts      # DSR/PBO (N=20; y 55/72)
git status -sb; npx tsc --noEmit; npx vitest run
```
