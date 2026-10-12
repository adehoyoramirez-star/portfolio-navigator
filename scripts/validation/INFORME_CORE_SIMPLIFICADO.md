# INFORME — VALIDACIÓN IS+OOS+WFA DEL PERFIL SIMPLIFICADO (13-oct-2026)

> Criterios **preregistrados** en `PREREGISTRO_CORE_V11.md` ANTES de la primera corrida.
> Script: `scripts/validation/core_simplificado.ts`. **`src/` no se ha modificado**:
> `coreMode` se pasa por llamada, así que la ruta por defecto sigue bit-idéntica a v5.3.

## 0. Qué se validó

"Quitar capas del motor hacia V3" ya existía como `OLYMPUS_CORE` v1.0.0 con
`enabled: false`. Ese perfil desactiva **kill switch, vol target, correlation panic,
absolute trend gate, BL y MinVar**, dejando **HRP puro**. Es una versión *más* agresiva
que la V3 de la ablación (que conservaba volTarget). Ningún script del repo lo había
medido: 0 coincidencias de `coreMode`/`OLYMPUS_CORE` en `scripts/`.

Dataset canónico · split IS/OOS **2023-10-28** (mismo que la ablación) · `transactionCostBps: 15`.

## 1. Resultados

| Fila | CAGR | Sharpe | MaxDD | Turn/año | coreMode | fallbacks |
|---|---|---|---|---|---|---|
| **LEGACY (v5.3)** | 23,14% | 1,266 | −15,4% | 2,1 | false | 0 |
| **CORE (simplificado)** | **24,80%** | **1,638** | **−15,0%** | 2,0 | true | 0 |
| CORE corrida 2 | 24,80% | 1,638 | −15,0% | 2,0 | true | 0 |

**IS (≤ 2023-10-27):** LEGACY 16,93% / 1,244 / −5,4% · CORE 16,41% / **1,403** / −4,2%
**OOS (≥ 2023-10-28):** LEGACY 25,03% / 1,290 / −15,4% · CORE 27,38% / **1,706** / **−15,0%**

### Walk-forward (ventanas desplazadas)

| Métrica WFA | LEGACY | CORE |
|---|---|---|
| `sharpeIsAvg` | 1,975 | **2,487** |
| `sharpeOosAvg` | 1,630 | **1,668** |
| `avgSharpeDegradation` | **0,345** | 0,819 |
| `overallConsistency` | **0,754** | 0,748 |
| `pctWindowsPositiveSharpe` | 1,000 | 1,000 |
| `deflatedSharpeRatio` | −0,779 | **−0,755** |
| `probabilisticSharpeRatio` | 0,845 | **0,851** |
| `robustnessGrade` | **B** | **C** |
| `overfittingRisk` | **MODERATE** | **HIGH** |

## 2. Veredicto de los criterios congelados

```
✅ A1 determinismo                — ΔCAGR entre dos corridas CORE = 0,00e+0
✅ A3 Sharpe OOS gana             — CORE 1,706 vs LEGACY 1,290
✅ A4 MaxDD cede ≤2pp             — CORE −15,0% vs LEGACY −15,4% (MEJORA)
✅ A5 turnover ≤15/año            — 2,0/año
✅ A6 data policy                 — 0 fallbacks
✅ K4 Sharpe OOS por ventana gana — CORE 1,668 vs LEGACY 1,630
```

**Ningún criterio aniquilador disparado.** K4 se implementó TAL COMO ESTÁ ESCRITO en el
preregistro (Sharpe OOS por ventana); la primera versión del script lo había medido por
`overallConsistency` y disparaba por 0,7 pp — se corrigió el script, **no el criterio**.

## 3. ⚠️ La evidencia que no puede quedarse sin decir

El criterio pasa, pero **por 0,038 de Sharpe** — ruido — y al mismo tiempo:

1. **La degradación IS→OOS se dispara 2,4×**: 0,345 → 0,819. El simplificado tiene un
   IS mucho más alto (2,487 vs 1,975) que se evapora al salir de muestra.
2. **El repositorio le pone nota C** (era B) y **riesgo de sobreajuste HIGH** (era MODERATE).
3. Es una comparación de **un solo dataset canónico**, con coste plano de 15 bp.

Es el patrón exacto que el §18 exige mirar: *"robustez (bootstrap)"* es requisito de
cambio, no un extra. **Un OOS ligeramente mejor con nota C y sobreajuste alto no es una
mejora institucionalmente defendible.**

## 4. Recomendación

**No activar todavía.** El criterio congelado se cumple y por eso queda registrado como
pasa — no se reescribe tras ver los números. Pero el perfil **degrada su robustez de B a C**
y el borde en OOS es de 0,038, dentro del ruido.

Antes de tocar `OLYMPUS_CORE.enabled` harían falta dos cosas que **no se ejecutaron aquí**:

- **Bootstrap pareado** del ΔSharpe entre CORE y legacy en OOS (el preregistro no lo
  pidió; la ablación sí lo hace para V5/V3). Con un borde de 0,038 es casi seguro que el
  IC95 incluiría 0, es decir: **sin ventaja estadísticamente distinguible**.
- **Ventanas múltiples del dataset** (hoy: una sola ventana OOS).

## 5. Qué NO se ejecutó

- **Ninguna activación**: `OLYMPUS_CORE.enabled` sigue `false`; `ENGINE_CONFIG_VERSION`
  sigue `3.9.0`; **cero cambios en `src/`**.
- No se corrió el bootstrap pareado de ΔSharpe (§4).
- No se midió el coste en vivo / contrato live-backtest (§18.2).
- No se ejecutó la suite de tests del perfil (no existe; `scripts/` no tiene tests).
