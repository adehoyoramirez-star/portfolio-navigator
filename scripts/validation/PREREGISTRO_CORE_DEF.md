# PREREGISTRO — PERFIL CORE-DEF (CORE + vol target + Kill Switch), OPT-IN

> **FROZEN el 17-oct-2026, ANTES de modificar `src/` y de ejecutar nada.**
> Base de código: `HEAD 27f3305`. Si se cambia algo de este documento después de ver
> resultados, la validación deja de servir como evidencia (ver §8).

## 0. Qué es y por qué

Decisión del responsable del motor (17-oct-2026), tras la clasificación de capas hecha a
partir de la ablación del 13-oct (`INFORME_VALIDACION_OCT2026.md`) y de
`INFORME_CORE_SIMPLIFICADO.md`:

- La ablación preregistrada dijo **SIMPLIFICAR**: HRP + vol target (V3) iguala o supera al
  motor completo (V5) en OOS con menos coste (Sharpe OOS 1,756 vs 1,291; MaxDD −13,3% vs
  −15,4%; costes €296 vs €590).
- El perfil CORE (HRP puro, todo el stack defensivo OFF) se cerró con **“No activar”**
  (IC95 del ΔSharpe incluye 0, sobreajuste HIGH, nota C).
- **Decisión:** crear un perfil **intermedio**: el CORE v1.0 con **vol target** y **Kill
  Switch** reactivados. Conserva el seguro de cola (la muestra no contiene un drawdown
  > 15%) y elimina el resto de capas (BL, DCC-GARCH, overlay discrecional, régimen en el
  sizing, Alpha-Boost).

**Es opt-in.** `OLYMPUS_CORE.enabled` sigue `false` y el comportamiento por defecto de
`coreMode` no cambia. Este documento valida que el perfil existe, funciona y no
empeora; **no lo promueve a producción**.

## 1. Aviso de independencia (leer antes de interpretar nada)

La ablación V5 vs V3 y la validación CORE vs legacy **ya se han visto** (13-oct). Esta
validación **no es una confirmación independiente**: comprueba que la implementación en la
ruta de producción reproduce lo que la ablación sugería y que cumple criterios de no
regresión. La única evidencia fresca posible es **forward** (modo sombra, §6).

## 2. Definición exacta del perfil

Activación por llamada (nunca global): `coreMode: true` **y** `coreDefensive: { volTarget: true, killSwitch: true }`.

- **Base:** idéntica a `coreMode` actual (HRP puro, covarianza Ledoit-Wolf, sin BL/MinVar,
  sin tilt de régimen, caps BTC OFF, Trend Gate según `coreTrendGate`, ahora OFF).
- **Vol target** (`volTarget: true`): `computeVolTargetMultiplier({ targetVol: input.targetVol ??
  VOLATILITY_CONFIG.DEFAULT_TARGET_VOL, realizedVol: realizedVol (cartera completa, incl. BTC),
  regimePenalty: 1.0 })`. Sin penalización por régimen y con la volatilidad completa, que es lo
  que midió la ablación V3.
- **Kill Switch** (`killSwitch: true`): `computeTailRiskOverlay` con los mismos argumentos
  que la ruta legacy **salvo `stressScore: 0`** (como en la ablación V4). Efecto: el escalón
  ELEVATED de crisis sistémica (VIX + stressScore) no puede dispararse; sí lo hacen el Kill
  Switch por drawdown, las dos ramas VIX + spread y la penalización por correlación.
- **Alpha-Boost deshabilitado** cuando `coreDefensive.volTarget` es true (forzar exposición
  máxima por una señal de BTC contradice el vol target y no formaba parte de V3/V4).
- Con `coreDefensive` ausente, o con ambos campos falsos: **bit-idéntico** al `coreMode`
  actual.

No se cambia ningún umbral ni parámetro existente.

## 3. Baselines congelados (13-oct-2026, reproducibles)

Dataset canónico `historical_data_daily_augmented.csv`, split IS/OOS `2023-10-28`,
`transactionCostBps: 15`, 1331 días.

| Fila | CAGR | Sharpe | MaxDD |
|---|---|---|---|
| LEGACY (v5.3, `coreMode` ausente) | 23,14% | 1,266 | −15,4% |
| CORE (`coreMode: true`) | 24,80% | 1,638 | −15,0% |

OOS: LEGACY Sharpe 1,290 · MaxDD −15,4%; CORE Sharpe 1,706 · MaxDD −15,0%.

## 4. Criterios de ACEPTACIÓN (todos deben cumplirse)

- **B1 No regresión** — (a) la fila CORE reproduce 24,80% / 1,638 / −15,0% y la fila LEGACY
  23,14% / 1,266 / −15,4% (precisión mostrada); (b) `tsc --noEmit` = 0 errores; (c) `vitest run`
  todo en verde, incluidos los tests nuevos.
- **B2 Determinismo** — dos corridas de CORE-DEF dan el mismo CAGR (tolerancia 1e-12).
- **B3 Sharpe OOS** — `Sharpe_OOS(CORE-DEF) ≥ Sharpe_OOS(LEGACY)`.
- **B4 MaxDD OOS** — `MaxDD_OOS(CORE-DEF)` **no peor** que LEGACY (tolerancia 0).
- **B5 Operativa** — turnover ≤ 15/año y costes totales ≤ los de LEGACY.
- **B6 Política de datos** — 0 fallbacks silenciosos.
- **B7 Comportamiento protector (test unitario)** — con el perfil activo, un drawdown ≥ 12%
  produce `overlay < 1` y exposición total < 1; VIX 45 + spread de crédito 6 reduce la
  exposición; con el vol target, una volatilidad realizada muy superior al objetivo reduce el
  multiplicador. Con `coreMode` solo (sin `coreDefensive`) nada de eso ocurre.

## 5. Criterios de ANIQUILACIÓN (cualquiera descarta el perfil)

- **K1** B3 falla (Sharpe OOS peor que el legacy).
- **K2** B4 falla (MaxDD OOS peor que el legacy).
- **K3** B1 falla: se revierte el cambio en `src/` (`git revert`).

## 6. Informativo (no gobierna la aceptación)

- Bootstrap pareado del ΔSharpe OOS (bloque 21 d, 10.000 réplicas, semilla 20261017):
  CORE-DEF − LEGACY y CORE-DEF − CORE. **Se espera que el IC95 incluya 0** (la muestra OOS
  no tiene potencia; V5 vs V3 ya dio [−1,095, 0,097]). No se reclama significancia.
- Walk-forward: `sharpeOosAvg`, degradación IS→OOS, `robustnessGrade`, `overfittingRisk`.
- Comparación con las filas V3/V4 de la ablación (ruta distinta: no se espera coincidencia
  exacta, sí el mismo signo).

**Condiciones adicionales para PROMOVER a producción** (no evaluadas aquí):
1. Que B1–B6 se hayan cumplido y que el WFA no sea peor que el legacy en
   `robustnessGrade`/`overfittingRisk`.
2. ≥ 90 días de modo sombra forward (`coreShadowMode`) con el informe de divergencia.
3. Aprobación explícita y por escrito (change-control §18). Sin esto, el perfil sigue opt-in.

## 7. Qué NO se hace

- No se activa nada en producción; no cambia `OLYMPUS_CORE.enabled`.
- No se elimina código de las demás capas: queda disponible en la ruta legacy hasta que la
  promoción esté aprobada. “Eliminar” se hará **después** de promover, no antes.
- No se reoptimiza ningún parámetro con estos resultados.

## 8. Control de cambios

Cualquier cambio de definición, criterio o umbral crea una versión nueva de este
preregistro y descarta la evidencia previa.
