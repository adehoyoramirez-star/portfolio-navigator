# INFORME DE VALIDACIÓN — CIERRE PARCIAL (13-oct-2026)

> Resultados **reproducidos ejecutando los harness del repo**, no citados de memoria.
> Todo el trabajo es de lectura/simulación: `src/` no se ha modificado en esta fase.

## 0. Estado del motor

| | |
|---|---|
| Versión | `v5.4.6` · `ENGINE_CONFIG_VERSION 3.9.0` · `OLYMPUS_CORE v1.0.0` (opt-in) |
| Salud | `tsc --noEmit` **0 errores** · `vitest run` **628/628** (44 ficheros) |
| Fingerprint canónico | **CAGR 23,14% · Sharpe 1,266 · MaxDD −15,4%** (offset 0, 1331 días) |
| Estado | Congelado funcionalmente (change-control §18) · paper trading activo |

## 1. ABLACIÓN — ¿se justifica la complejidad del motor?

**Criterio PREREGISTRADO** (`scripts/validation/ablation.ts`, cabecera §6):
V5 se justifica solo si `Sharpe_OOS(V5) > Sharpe_OOS(V3)` **Y** el MaxDD OOS es mejor
**Y** el IC95 del ΔSharpe (bootstrap por bloques de 21 d, pareado) **excluye 0**.
Reparto IS/OOS: split `2023-10-28`.

| Variante | CAGR FULL | Sharpe | MaxDD | IS Sh | **OOS Sh** | OOS CAGR | OOS DD | Costes |
|---|---|---|---|---|---|---|---|---|
| V1 equal-weight | 35,30% | 1,545 | −22,7% | 2,186 | **1,439** | 34,83% | −22,7% | €502 |
| V2 HRP estático | 25,49% | 1,446 | −12,3% | 0,999 | **1,556** | 29,59% | −12,3% | €412 |
| **V3 HRP+volTarget** | 26,31% | 1,586 | −13,3% | 0,831 | **1,756** | 30,92% | −13,3% | €296 |
| V4 V3+tailRisk/KS | 25,21% | 1,541 | −13,3% | 0,831 | **1,702** | 29,45% | −13,3% | €298 |
| **V5 MOTOR** | 23,14% | 1,266 | −15,4% | 1,237 | **1,291** | 25,04% | −15,4% | €0 ⚠ |
| V5' shadow del motor | 22,78% | 1,281 | −14,4% | 1,491 | **1,260** | 23,78% | −14,4% | €715 |
| V6 B&H equal c/costes | 34,94% | 1,304 | −25,0% | 2,135 | **1,185** | 33,72% | −25,0% | €24 |

```
Sharpe OOS: V5 1,291 vs V3 1,756  → NO CUMPLE
MaxDD  OOS: V5 −15,4% vs V3 −13,3% → NO CUMPLE
Bootstrap ΔSharpe (V5−V3) OOS: mediana −0,515 · IC95 [−1,095, 0,097] → incluye 0 (NO CUMPLE)
VEREDICTO IMPRESO POR EL HARNESS: SIMPLIFICAR — V3 no es superado en los tres criterios
```

**Lectura honesta de este resultado.** V5 **sí** gana en *in-sample* (IS Sh 1,237 vs
0,831): el motor está mejor ajustado a la historia. Lo que **no** demuestra es
generalización: en la ventana OOS, un HRP con vol target (V3) rinde más y con menos
bache. Es exactamente el patrón de sobreajuste que la ablación existe para detectar.

**Limitación declarada:** la columna de costes de **V5 marca €0** mientras su *shadow*
(V5') marca €715. Un motor con rebalanceo real no puede costar cero: **esa celda no es
fiable** y hay que reconciliarla antes de usar el cuadro para decidir. La comparación de
Sharpe/MaxDD no depende de esa celda, pero la de costes sí.

## 2. SENSIBILIDAD Y ROBUSTEZ

### (a) Dependencia de la fecha de inicio — 36 corridas, offsets 0..350 días (paso 10)

| métrica | P5 | mediana | P95 | min | max |
|---|---|---|---|---|---|
| CAGR | 19,91% | 23,22% | 25,45% | 19,55% | 25,68% |
| Sharpe | 1,015 | 1,224 | 1,299 | 0,988 | 1,304 |
| MaxDD | −12,7% | −12,2% | −11,5% | −12,7% | −11,3% |

**Criterio (P5 Sharpe > 0,5): CUMPLIDO — robusto.** El motor no depende de dónde se
empiece a medir: el peor arranque de los 36 sigue dando Sharpe ≈1,0.

### (b) Bootstrap por bloques (bloque 21 d, 10.000 remuestreos)

| métrica | P5 | P25 | P50 | P75 | P95 | IC 95% | observado |
|---|---|---|---|---|---|---|---|
| Sharpe | 0,325 | 0,844 | 1,205 | 1,568 | 2,094 | [0,165 · 2,264] | 1,233 |
| CAGR | 8,06% | 16,58% | 22,84% | 29,13% | 38,79% | [5,49% · 41,93%] | 23,22% |

El IC del Sharpe es ancho pero **no cruza cero negativo**: la señal existe. El IC del
CAGR es **muy ancho** (5,5%–41,9%) — con ~3,5 años de OOS no se puede estrechar más, y
cualquier promesa de retorno basada en esta muestra es frágil.

*Nota:* el "observado" del bootstrap (1,233 / 23,22%) no coincide exactamente con el
fingerprint canónico (1,266 / 23,14%) porque usa su propia ventana y agregación; se
reporta tal cual, sin forzar la coincidencia.

## 3. Qué queda abierto

| Pendiente | Estado |
|---|---|
| Degradación del detector de techo (P1–P5) | Evidencia medida; **sin aplicar** → `PREREGISTRO_M4_DEGRADACION.md` |
| Backtest de cartera con los 4 parches a la vez | **No ejecutado** (requisito previo a producción) |
| Reconciliar la celda de costes de V5 en la ablación | **Pendiente** (dato no fiable) |
| Candidato de Breadth institucional | `PENDING_OOS_VALIDATION` en shadow |
| P1 regime-conditional valuation shift | Diseñado, sin backtest de sensibilidad |
| Cuatro señales sin validar (MVRV Z manual, P/E forward WLG, Spot/LT uranio, credit spread <2023) | **PARCIAL** por falta de dato de época |

## 4. Conclusión del cierre parcial

1. El motor es **robusto a la fecha de inicio** y su señal **no está en cero**.
2. Su **complejidad no está justificada en OOS** frente a un HRP con vol target: la
   ablación pre-registrada pide **simplificar**.
3. El detector de techo **no anticipa caídas** y cuesta dinero: la vía correcta es
   **degradarlo con topes**, no afinarlo.
4. **Nada de esto se aplica sin el comité** (§18). El siguiente paso real es una
   decisión, no más análisis.
