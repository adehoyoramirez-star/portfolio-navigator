# PREREGISTRO — VALIDACIÓN DEL PERFIL SIMPLIFICADO (CORE v1.0) IS + OOS + WFA

> **FROZEN antes de ejecutar nada.** Criterios congelados el 13-oct-2026, ANTES de la
> primera corrida. Si se cambian después de ver los resultados, este documento deja de
> servir para nada, que es exactamente para lo que sirve.

## 0. Qué se va a validar y por qué

"Quitar capas del motor hacia V3" **ya existe en el código** como perfil `OLYMPUS_CORE`
v1.0.0 (`src/core/config/engineConfig.ts`), con `enabled: false`:

- `blend: { BL: 0.0, HRP: 1.0, MIN_VAR: 0.0 }` → **HRP puro**
- `defensiveStack: { killSwitch: false, volTarget: false, correlationPanic: false, absoluteTrendGate: false }`
- `overlay.trendGate.enabled: false`

Es decir: **sin kill switch, sin vol target, sin panic de correlación, sin capa de
amplitud, sin BL ni MinVar**. Es una versión *más* simplificada que la V3 de la ablación
(V3 conservaba volTarget). Se activa por llamada con `coreMode: true` y **no cambia el
default** (`OLYMPUS_CORE.enabled` sigue `false`).

**Lo que falta no es código, es evidencia**: ningún script del repo valida `coreMode`
(0 coincidencias en `scripts/`), así que esta ruta jamás se ha medido con los harness
propios.

## 1. Baseline congelado (reproducido el 13-oct-2026)

- `HEAD a2ddc98` · árbol limpio · `tsc` 0 · `vitest` 628/628.
- **Legacy (ruta por defecto)**: CAGR **23,14%** · Sharpe **1,266** · MaxDD **−15,4%**
  (runner canónico, offset 0, 1331 días).
- Dataset canónico `historical_data_daily_augmented.csv`. Split IS/OOS: **2023-10-28**
  (mismo que la ablación, para que los resultados sean comparables entre informes).

## 2. Criterios de ACEPTACIÓN (todos deben cumplirse)

- **A1 — Reproducibilidad**: dos corridas idénticas de `coreMode: true` producen los
  mismos números (tolerancia 1e-12). Un motor que no es determinista no se puede auditar.
- **A2 — IS + OOS en la misma ventana que el legacy**: se reportan ambos tramos.
- **A3 — El simplificado gana donde importa**: `Sharpe_OOS(CORE) > Sharpe_OOS(legacy)`.
  Quita capas que **protegían** — la simplificación sólo se justifica si mejora el
  retorno por unidad de riesgo fuera de muestra. Si empata o peora, no se quita nada.
- **A4 — La protección no se dispara más de 2 pp**: `MaxDD_OOS(CORE) ≥ MaxDD_OOS(legacy) − 2pp`.
  (Permito ceder hasta 2 pp de bache a cambio de ganar Sharpe; más no.)
- **A5 — Turnover medio ≤ 15/año** sin cambio de universo (§13.3 de la spec).
- **A6 — Sin violaciones de data policy** (`dataPolicy.noSilentValues`): si el CORE
  necesita un fallback silencioso para funcionar, se rechaza.

## 3. Criterios de ANIQUILACIÓN (cualquiera mata el cambio)

- **K1** — `Sharpe_OOS(CORE) ≤ Sharpe_OOS(legacy)`.
- **K2** — `MaxDD_OOS(CORE) < MaxDD_OOS(legacy) − 2pp`.
- **K3** — No determinista, o `tsc` ≠ 0, o la suite deja de estar en verde.
- **K4** — El WFA muestra que la ventaja del CORE desaparece al mover la ventana
  (mediana de Sharpe OOS por ventana ≤ legacy).

## 4. Rango documentado en la spec (§13.2/§16) — informativo, con salvedad

La spec fija para el CORE: `CAGR 25,8% ± 2pp · Sharpe 1,72 ± 0,15 · MaxDD −16,7% ± 2pp`
(fingerprint OOS CORE `€19.917,057257268985`). **Salvedad declarada de antemano**: ese
rango salió de la Phase 12 con **su ventana y su dataset**; este preregistro corre sobre
el dataset canónico actual (hasta 2026-10). Por eso **A3/A4 son los criterios
decisivos** (comparan CORE y legacy en *la misma* ventana, invariante a esa diferencia) y
el rango de la spec se reporta como referencia, no como veredicto.

## 5. Regla de decisión

- Si **A1–A6 cumplen y no dispara ninguna K**: se **propone** activar el perfil
  (`OLYMPUS_CORE.enabled: true`), con bump de versión (§17: `ENGINE_CONFIG_VERSION`
  `3.9.0` → `4.0.0`) y la ruta legacy **conservada y reproducible** mediante
  `coreMode: false` explícito (§18.3: la versión benchmark congelada no se destruye).
- Si **cualquier K dispara**: **no se toca `src/`**. El informe registra por qué, con
  números, y el perfil queda `enabled: false` como está hoy.

## 6. Alcance

- **No se modifica `src/`** en esta fase: `coreMode` se pasa por llamada en el script.
- La activación (si procede) se haría como **commit aparte**, con su test.
