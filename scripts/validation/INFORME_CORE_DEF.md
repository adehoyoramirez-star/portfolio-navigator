# INFORME — PERFIL CORE-DEF (CORE + vol target + Kill Switch), OPT-IN (17-oct-2026)

> Criterios **preregistrados** en `PREREGISTRO_CORE_DEF.md` ANTES de modificar `src/` y de la
> primera corrida. Script: `scripts/validation/core_def_profile.ts`. Cambio en `src/`: un
> interruptor `coreDefensive` (opt-in, por llamada) en `olympusV3.ts` y `backtestEngine.ts`.
> La ruta por defecto sigue bit-idéntica (los baselines se reproducen; ver B1).

## 1. Resultados (dataset canónico, split 2023-10-28, 15 bp, 1331 días)

| Fila | CAGR | Sharpe | MaxDD | Turn/año | Invertido | Costes |
|---|---|---|---|---|---|---|
| LEGACY (v5.3) | 23,14% | 1,266 | −15,4% | 2,1 | 88,4% | €590 |
| CORE | 24,80% | 1,638 | −15,0% | 2,0 | 99,2% | €575 |
| **CORE-DEF** | **24,49%** | **1,626** | **−15,0%** | 2,0 | 98,6% | €573 |

**IS:** LEGACY 16,93% / 1,244 / −5,4% · CORE y CORE-DEF 16,41% / 1,403 / −4,2% (idénticos).
**OOS:** LEGACY 25,03% / 1,290 / −15,4% · CORE 27,38% / 1,706 / −15,0% · **CORE-DEF 26,97% / 1,691 / −15,0%**.

## 2. Veredicto de los criterios congelados

```
✅ B1  baselines reproducidos (LEGACY y CORE al decimal) · tsc 0 errores · vitest 716/716
✅ B2  determinismo — ΔCAGR entre dos corridas = 0
✅ B3  Sharpe OOS ≥ LEGACY — CORE-DEF 1,691 vs 1,290
✅ B4  MaxDD OOS no peor — −15,0% vs −15,4%
✅ B5  turnover 2,0/año y costes €573 ≤ €590
✅ B6  0 fallbacks
✅ B7  14 tests de comportamiento (verificados con mutaciones: 3 fugas detectadas)
```

**El perfil queda como OPT-IN válido.** No se promueve a producción.

## 3. Lo que los números dicen de verdad

1. **CORE-DEF ≈ CORE.** ΔSharpe OOS (CORE-DEF − CORE) = −0,015, IC95 [−0,035, 0,003]. En IS son
   **idénticos** y el MaxDD no cambia (−15,0%). El vol target y el Kill Switch casi no actúan en
   esta muestra: invertido medio 98,6% frente a 99,2%.
2. **El seguro no ha demostrado nada.** Cuesta ≈ 0,3 pp de CAGR (≈ 0,4 pp en OOS) y no reduce el
   MaxDD observado. No hay en la muestra un drawdown que lo ponga a prueba (el peor es −15,4%,
   que apenas roza L2). Esto coincide con la evidencia previa del repo (“coste con MaxDD
   bit-idéntico”). Se mantiene por decisión de diseño, no por evidencia de rendimiento.
3. **La rama ELEVATED del Kill Switch no existe en este perfil** (`stressScore = 0`, como en la
   ablación V4). Es una ceguera por diseño, documentada en el preregistro y en un test.
4. **La ventaja sobre LEGACY no es significativa.** ΔSharpe OOS (CORE-DEF − LEGACY) = +0,400, IC95
   [−0,200, 1,011]: incluye 0. Se esperaba (preregistro §6); no se reclama significancia.
5. **Robustez peor que LEGACY.** WFA: LEGACY grado B / sobreajuste MODERATE; CORE y CORE-DEF
   **C / HIGH**. Degradación IS→OOS 0,82 frente a 0,35. Es el mismo patrón que cerró el perfil CORE.

## 4. Consecuencia: promoción BLOQUEADA hoy

Las condiciones de promoción del preregistro (§6) exigen que el WFA no sea peor que LEGACY en
`robustnessGrade`/`overfittingRisk`. **No se cumple (C/HIGH vs B/MODERATE).** Además faltan ≥ 90
días de modo sombra forward y la aprobación por escrito (§18). Por tanto:

- `OLYMPUS_CORE.enabled` sigue `false`.
- **No se elimina ninguna capa** de la ruta legacy: “eliminar” se hace después de promover
  (preregistro §7), y hoy no hay base para promover.

## 5. Qué NO se ejecutó

- Ninguna validación independiente: la ablación V5 vs V3 y CORE vs LEGACY ya se habían visto.
- Modo sombra forward del perfil (`coreShadowMode` compara CORE vs v5.3; no se ha extendido a CORE-DEF).
- Ventanas OOS múltiples ni backtest de cartera sobre un periodo con un drawdown mayor del 15%.

## 6. Siguientes pasos que el resultado sugiere

1. ~~Entender por qué CORE degrada 0,82 IS→OOS~~ → diagnosticado en §7 (el WFA mide otra covarianza).
2. **Paso 3 del plan:** el VIX aparece en 7 módulos de régimen y riesgo (`regimeProbabilistic`,
   `globalStress`, `crisis`, `crisisEarlyWarning`, `masterRegime`, `hmmRegime`, `tailRisk`) y
   `AGENTS.md` fija un máximo de dos capas por variable. No todos son capas independientes
   (alguno puede solo encaminar el dato), pero hay que auditarlo antes de añadir nada.
3. Extender el modo sombra a CORE-DEF y acumular los 90 días antes de cualquier decisión.

## 7. Diagnóstico del bloqueo WFA (17-oct-2026, exploratorio, `wfa_cov_mismatch.ts`)

Hipótesis y regla fijadas en la cabecera del script antes de ejecutarlo. La réplica del bucle IS/OOS
reproduce el WFA nativo a 1e-9 en los tres perfiles (sin eso no se concluía nada).

**Hecho:** `runWalkForwardTest` fuerza `useDynamicCovariance: true` (DCC-GARCH) en todas las ventanas.
El perfil CORE validado (y CORE-DEF) usa la covarianza por defecto (Ledoit-Wolf). El WFA **no está
gradando el perfil que se validó**, sino "CORE con DCC", la variante que el criterio preregistrado ya rechazó.

| Perfil | Degradación IS→OOS con DCC (lo que grada el WFA) | Con covarianza del perfil |
|---|---|---|
| LEGACY | 0,345 | 0,313 |
| CORE | 0,819 | **0,229** |
| CORE-DEF | 0,824 | **0,238** |

- Con la covarianza del perfil, la degradación de CORE y CORE-DEF cae por debajo de 0,6 (umbral MODERATE)
  y de 0,8. El grado completo no se recalcula (la consistencia no está exportada): solo se reporta la degradación.
- Corrida completa: CORE con DCC da 31,5% CAGR / Sharpe 1,81 / DD −17,1% frente a 24,6% / 1,71 / −14,9% por defecto:
  DCC infla el resultado de muestra y empeora el drawdown, coherente con haberlo descartado.
- Un script contrastado aparte (`wfa_degradation_null.ts`, procedencia no verificada, sin commitear) apunta
  en la misma dirección: estrategias sin parámetros degradan ≈0,5 en esta muestra. Su regla es laxa y no se usa como evidencia.

**Qué NO significa:** no se ha promovido nada ni se declara cumplido el criterio del preregistro §6; cambiar
el WFA para que mida la covarianza del perfil es un cambio de criterio tras ver datos y requiere aprobación §18.
Con 5 ventanas OOS de ~67 días el ruido de cada Sharpe es ≈ ±2,3: es un diagnóstico, no una prueba.

**Siguiente paso:** añadir a `runWalkForwardTest` una opción `useDynamicCovariance` (por defecto sin cambios),
aprobarla por §18 y repetir el WFA con el perfil real; más los ≥ 90 días de sombra forward.
