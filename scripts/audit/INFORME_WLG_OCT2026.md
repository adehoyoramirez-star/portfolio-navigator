# PAQUETE DE INTEGRACIÓN — Detector WLG (MSCI World) · Oct-2026

> **Anotación de `decision_log` (§18.4)** exigida por la revisión cuantitativa
> independiente del detector de techo WLG (13-oct-2026). Modelo:
> `scripts/audit/INFORME_APLICACION_M3M4.md`.
>
> **Estado:** paquete PREPARADO, **sin commit ni push** (pendiente de autorización
> expresa). Aplica SOLO lo comportamiento-neutro (**A** estructural + **D**
> instrumentación/documentación). La **calibración** (**B** RSI y **C** ancla P/E)
> queda **NO APLICADA** y vive únicamente como propuesta en `.diff`.
> Motor: `ENGINE_VERSION = "v5.4.6"` (`src/core/engine/olympusV3.ts:122`) — **sin bump**.

---

## 1. Separación A / B / C / D e impacto real de cada línea

| Grupo | Qué es | Naturaleza | Aplicado |
|---|---|---|---|
| **A** | Extraer las curvas de WLG a constantes y permitir **inyección opcional** (`detectWLGTop(inputs, curves?)`, `detectCycleTops(inputs, wlgCurves?)`). Default = calibración APROBADA. | Estructural, **sin cambio de señal**: los literales extraídos son idénticos. | ✅ |
| **B** | Curva RSI `[[75,1.0],[80,1.5],[85,2.0]]` → `[[75,0],[80,1.0],[85,2.0]]`. | **CALIBRACIÓN**: mueve el trim de WLG en RSI 75–85 de 35–55% a 0–55%. | ❌ (propuesta) |
| **C** | Ancla de valoración `[[16,1.0],…]` → `[[13,0],[16,1.0],…]` y fallback `[[14,1.0],…]` → `[[11,0],[14,1.0],…]`. | **CALIBRACIÓN**: mueve el trim de WLG en P/E efectivo 13–16 de 0% a 0–35%. | ❌ (propuesta) |
| **D** | Harness opt-in (modo A/B/C), manejo de CSV ausente, trazabilidad del P/E efectivo, toggle RSI A/B, tests, documentación y artefactos de evidencia. | Instrumentación / documentación, **sin efecto en producción**. | ✅ |

**Regla aplicada:** ninguna línea empieza por "estructural" si altera señales,
ponderaciones, recortes o decisiones. El grupo A solo **parametriza** lo que ya
existía; su neutralidad está **medida** (§3.2), no argumentada.

---

## 2. ¿Se puede eliminar el cliff SIN tocar la calibración aprobada? — **NO**

El cliff no nace de un bug de tipeo, sino de la **regla de frontera** de
`smoothScore` (`src/core/risk/cycleTopDetector.ts:75`):

```ts
if (x <= sorted[0][0]) return 0;        // por debajo del primer ancla ⇒ score 0
const multiplier = smoothScore(score, [...]) // x = ancla ⇒ score del ancla
```

Con la calibración **aprobada** (RSI `[[75,1.0],…]`) eso da, medido en el barrido
real del harness (`C1`, paso 0.01):

| Indicador | Punto | Antes | Después | Δtrim |
|---|---|---|---|---|
| WLG P/E | 16.00 → 16.01 | 0% | 35% | **35.0 pp** |
| WLG RSI-W | 75.00 → 75.05 | 0% | 35% | **35.0 pp** |

**Alternativas y su impacto (no decido por ti):**

| Opción | Qué toca | Impacto | Valoración |
|---|---|---|---|
| **(a) Ancla cero explícita** `[13,0]` / `[75,0]` | Solo WLG | RSI 76: **37% → 10%**; P/E 15: **0% → ~25%**; P/E 16.01: 37% → 35%. Elimina el cliff. | Es el grupo **B/C**: cambio de calibración real. |
| **(b) Cambiar la regla de frontera de `smoothScore`** | **Global**: 8 curvas de 6 tickers (BTC, Oro, EMXC, SEMIS, DXY, Uranio); **7 de ellas con frontera activa** (§3.9) | Recalibra varios detectores a la vez y su umbral efectivo. La regla `x≤ancla ⇒ 0` es deliberada (evita el falso "trim 95%" con score 0, ver comentario L92). **Ojo:** la lista del traspaso omitía **WLG**, que es justo donde vive el cliff (3 de las 7 curvas activas). | Recalibración global, no un arreglo local. Requiere su propio change-control. |
| **(c) Mantener la calibración y aceptar el cliff** | Nada — pero **NO es una no-decisión**: es la calibración que sigue emitiendo la señal de frontera | Coste medido de convivir con el cliff en los **14,5 años** de historia semanal de URTH (no 56): **59 saltos ≥ 30 pp**, **21 whipsaws** (episodios ≥75 de ≤4 semanas), **+647 € (CASH0) / +673 € (TBILL) de impuestos brutos** y **+6 operaciones** frente a la curva suave, a cambio de **+0,08 / +0,11 pp de CAGR de sleeve** y **MaxDD idéntico (0,00 pp)** (§3.8). Comisiones (spread 5 pb) ≈ 10 € en el mismo tramo — **estimadas**, no impresas por C6. | Estado actual del paquete. |

**Conclusión:** no existe arreglo local y comportamiento-neutro simultáneamente.
Por eso B/C van fuera del paquete.

---

## 3. Evidencia reproducida (13-oct-2026, no citada de memoria)

### 3.1 Checks del paquete
| Comprobación | Comando | Resultado |
|---|---|---|
| Tipos | `npx tsc --noEmit` | **exit 0** |
| Tests | `npx vitest run` | **649/649 PASS · 44 archivos · exit 0** (antes 647; −4 tests del cambio de calibración, +6 de la candidata por inyección) |
| Equivalencia estructural HEAD ↔ working tree | `cd scripts && npx tsx audit/propuesta_wlg_pe/equivalencia/equiv.ts` | **27 477 casos · 0 discrepancias** |

### 3.2 Neutralidad del grupo A (prueba directa)
`equivalencia/equiv.ts` compara `detectCycleTops` de **HEAD** (copia congelada
`head_cycleTopDetector.ts`) contra el de `src/` sobre RSI × P/E × CAPE × shift ×
credit spread y TODOS los demás detectores: **0 discrepancias en 27 477 casos**.
Muestras del comportamiento aprobado: RSI 74.99→0% · 75→0% · 76→**37%** ·
P/E 15.99→0% · 16.00→0% · 17.9→40%.

### 3.3 Canónico del harness: baseline HEAD-code vs paquete
`audit/.base/m3_rerun_base.ts` = `m3_rerun.ts` + `m3_harness.ts` **de HEAD**.
Diff de salidas: **la única diferencia son las 2 filas nuevas del barrido de
cliffs** (+ sus 2 líneas de detalle):

```
WLG P/E   wlgPERatio    [10,30] paso 0.01: max Δtrim=35.0pp en 16.00→16.01 · cliffs≥5pp=1
WLG RSI-W wlgRsiWeekly  [60,90] paso 0.05: max Δtrim=35.0pp en 75.00→75.05 · cliffs≥5pp=1
```
Todas las secciones 0.1/0.3/0.4/A/B/C/D1 son **línea a línea idénticas**.
(Nota: la corrida baseline terminó con `ENOENT` al escribir su JSON redirigido —
ocurrió **después** de todo el `console.log`; no afecta a la comparación.)

### 3.4 A/B de la curva RSI en una MISMA ejecución (datos y costes idénticos)
`cd scripts && WLG_RSI_TOGGLE=1 npx tsx audit/m3_rerun.ts` → sección `C6`:

```
grid/precios/costes idénticos: SÍ (N=2441) · trim medio aprobada=2.2% vs candidata=1.7%
CASH0 | Δ (candidata − aprobada): CAGR -0.08 pp · vol +0.07 pp · MaxDD 0.00 pp · ops +6 · impuestos −647 €
TBILL | Δ (candidata − aprobada): CAGR -0.11 pp · vol +0.07 pp · MaxDD 0.00 pp · ops +6 · impuestos −673 €
```
La candidata **no es gratis**: reduce recortes, sube operaciones y baja ligeramente
el CAGR. Sigue sin resolver el cliff de valoración (ruta P/E sin datos).

### 3.5 Determinismo
La corrida del toggle reproduce **exactamente** las mismas líneas canónicas que la
corrida A: lo único que se añade es la sección `C6`.

### 3.6 CSV ausente (modo B sin datos) — no rompe, no inventa
`WLG_PE_MODE=B npx tsx audit/m3_rerun.ts` → **exit 0**, un solo aviso, y degradación
declarada:

```
[WLG-PE] CSV no encontrado: audit/data/wlg_forward_pe.csv → serie vacía. La ruta de valoración queda SIN VALIDAR (no se inventan datos históricos).
semanas con P/E efectivo inyectado: 0/2441 · descartadas por baseline NO fiable (<5 años de histórico): 0
[!] NO se inyectó ningún P/E (CSV ausente o sin histórico suficiente) → el modo B/C degrada a A
```
El resto del canónico queda idéntico a la corrida A (verificado con `diff`).

### 3.7 ATRIBUCIÓN de la deriva de `m3_results.json` (medido 13-oct-2026 con el código de HEAD)
Para decidir si regenerar el artefacto hay que separar *deriva ajena* de *efecto del paquete*.
Se extrajo un árbol de HEAD con `git archive` y se corrió el harness allí con el mismo
`tsx` y los mismos datos:

| Comparación | Semanas distintas (de 2441) |
|---|---|
| `m3_results.json` **committed** vs corrida **FRESH con código de HEAD** | **1310** |
| corrida FRESH código HEAD vs corrida FRESH **working tree** | **0** |
| `newBacktests` (5 tickers) HEAD vs working tree | **canónicamente idénticos** |
| `cliffs` | committed 10 · HEAD-fresh 10 · **working tree 12** (+2 filas nuevas) |

**Conclusión:** las 1310 semanas divergen **sin** el paquete (el artefacto ya estaba stale
frente a su propio código+datos). El paquete aporta **0** semanas y **+2 filas** de barrido.
Por eso **no** se regenera: metería 1310 semanas de drift ajeno en el commit.
`engine_returns.json` es ajeno a este paquete: `scripts/export_engine_returns.ts` corre
`runBacktest` sobre `historical_data_daily_augmented.csv`, y `backtestEngine.ts` **no**
importa `cycleTopDetector` (verificado por búsqueda) — sin cambio atribuible.

### 3.8 Cuantificación del precipicio sobre URTH semanal (histórico REAL del repo)
`cd scripts && npx tsx audit/propuesta_wlg_pe/cliff_stats.ts` (756 semanas con RSI-W,
2012-04-20 → 2026-10-07):

```
cruces al ALZA del umbral 75: 29 · cruces a la BAJA: 30 · saltos |Δtrim| ≥ 30 pp: APROBADA=59 · CANDIDATA=22
salto MÁXIMO observado |Δtrim| entre semanas: APROBADA=55.0 pp · CANDIDATA=55.0 pp
episodios con RSI ≥ 75: 30 · duración ≤ 4 semanas (whipsaw): 21 · duración mediana: 2 semanas
semanas con trim>0: APROBADA=114 · CANDIDATA=113 · banda 75–80: 47 semanas (trim 39.1% vs 17.9%)
trim medio: APROBADA 7.13% vs CANDIDATA 5.64% (Δ −1.49 pp) · trim máx alcanzado: 55% en ambas
```
La candidata **reduce el número** de saltos ≥30 pp un 63% (59→22) pero **no el máximo**
(55 pp, que viene de las salidas súbitas desde RSI ≥ 83, idénticas en ambas curvas).

### 3.9 Alcance de la opción (b) — cambiar la regla de frontera de `smoothScore`
`cd scripts && npx tsx audit/propuesta_wlg_pe/scope_b.ts` inventaría los acantilados de
frontera vivos por input (paso fino 0.01, detector real). Resultado medido:

| Input (curva) | Ticker | max\|Δtrim\| | Punto |
|---|---|---|---|
| `wlgRsiWeekly` | WLG | **35.0 pp** | 75.00 → 75.01 |
| `wlgPERatio` | WLG | **35.0 pp** | 16.00 → 16.01 |
| `wlgCAPE` (fallback) | WLG | **35.0 pp** | 14.00 → 14.01 |
| `puellMultiple` | BTC | **35.0 pp** | 2.50 → 2.51 |
| `emxcRsiWeekly` | EMXC | **25.0 pp** | 75.00 → 75.01 |
| `soxRsiWeekly` | SEMIS | **35.0 pp** | 80.00 → 80.01 |
| `soxSpyRelativeStrength` | SEMIS | **30.0 pp** | 1.00 → 1.01 |
| `mvrvZScore`, `mvrvRatio`, `btcRsiWeekly`, `dxy`, `realYield10y`, `uraniumSpotPrice`, `brentOil`, `goldCbPurchases` | — | ≤ 2 pp | sin frontera activa |

Bajo la interpretación «x = a₁ ⇒ score(a₁)» (ii), (b) mueve **7 curvas de 4 tickers**
(WLG, BTC, EMXC, SEMIS), no solo WLG. Bajo «extender la rampa por debajo de a₁» (i),
cambia **además** el tramo sub-ancla de todas las curvas (hoy 0 pp = sin señal).

#### 3.9.1 Conciliación con la lista del traspaso (BTC, Uranio, Semis, Oro, EMXC, DXY)
La lista del traspaso era el conjunto de **callers**, no el de fronteras *activas*. Hay que
distinguir dos capas:

| Capa | Curvas | Tickers | ¿Se mueve con (ii)? |
|---|---|---|---|
| **Callers** de `smoothScore` en `cycleTopDetector.ts` (20 llamadas) | 8 inputs con curva propia | BTC, Oro, EMXC, SEMIS, DXY, Uranio | Parcialmente |
| **Frontera activa** (a₁ con score ≠ 0 **y** sin guard) | `wlgRsiWeekly`, `wlgPERatio`, `wlgCAPE`, `puellMultiple`, `emxcRsiWeekly`, `soxRsiWeekly`, `soxSpyRelativeStrength` = **7** | **WLG, BTC, EMXC, SEMIS = 4** | **SÍ** |
| Frontera **inerte** (a₁ con score 0 o guard previo) | `mvrvZScore`, `mvrvRatio`, `btcRsiWeekly`, `dxy`, `realYield10y`, `uraniumSpotPrice`, `brentOil`, `goldCbPurchases` | BTC, EMXC, Oro, Uranio | No bajo (ii); **sí** bajo (i) |

Correcciones a la lista del traspaso:
1. **Falta WLG** (3 curvas: RSI, P/E, fallback CAPE) — es el 43 % del alcance activo y el
   único con cliff *documentado en producción*.
2. **BTC entra solo por `puellMultiple`** (35 pp en 2.50→2.51); `mvrvZScore`, `mvrvRatio`
   y `btcRsiWeekly` tienen a₁ con score 0 → 1 pp residual (redondeo de `trimPct`), sin cliff.
3. **Oro y Uranio no tienen frontera activa**: el Oro tiene guards (`realRate ≤ 0 → 1.0`) y
   sus curvas (Brent relief, compras BC) arrancan en score 0; el Uranio usa
   `ratio ≤ 1.0 ? 1.0 : smoothScore(...)`. Solo cambiarían bajo (i).
4. **DXY ya está suavizado** (máx |Δtrim| = 1 pp): `dxyScore = smoothScore(dxy, [[103,0],[106,0.75],…])`
   está en HEAD (L890), de modo que `proposed_patches/01_dxy_interpolation.diff` es **obsoleto**.

### 3.10 Aplicabilidad de `fix_cliff_wlg.diff` — **solo sobre el árbol con A+D**
El `.diff` edita el contexto **post-A** (el comentario «SEPARACIÓN A/B/C» que introduce el
grupo A), no el de HEAD anterior. Comprobación reproducible:

```bash
REPO=$(git rev-parse --show-toplevel)
# (1) árbol PRE-A+D (= commit anterior a este paquete)
rm -rf /tmp/wlg_pre && mkdir -p /tmp/wlg_pre && git -C "$REPO" archive HEAD~1 | tar -x -C /tmp/wlg_pre
cd /tmp/wlg_pre && git apply -p1 --check "$REPO/scripts/audit/propuesta_wlg_pe/fix_cliff_wlg.diff"; echo "PRE_A+D_EXIT=$?"
# (2) árbol CON A+D (= HEAD tras este paquete)
cd "$REPO" && git apply -p1 --check scripts/audit/propuesta_wlg_pe/fix_cliff_wlg.diff; echo "POST_A+D_EXIT=$?"
```
Resultado medido: **`PRE_A+D_EXIT=1`** (`error: patch does not apply` en el hunk de L634) y
**`POST_A+D_EXIT=0`**. Consecuencia operativa: B/C **no** se puede aplicar sobre un HEAD antiguo;
siempre va *apilado* sobre A+D. (`git apply --check` no modifica ficheros.)

---

## 4. Archivos que entrarían en el push

**Modificados**
| Fichero | Cambio | Riesgo |
|---|---|---|
| `src/core/risk/cycleTopDetector.ts` | Constantes de curva + inyección opcional. Default = aprobado. | Nulo (medido, §3.2) |
| `src/test/cycleTopDetector.test.ts` | 6 tests de la candidata vía inyección + asertos de default sin cambios. | Nulo |
| `scripts/audit/m3_rerun.ts` | Instrumentación opt-in: `WLG_PE_MODE` (A default), `WLG_RSI_TOGGLE`, trazabilidad P/E, WLG en `SWEEPS`. | Nulo en modo A (§3.3) |

**Nuevos**
| Fichero | Contenido |
|---|---|
| `scripts/audit/wlg_forward_pe.ts` | Loader P/E forward con baseline rolling sin look-ahead; **tolerante a CSV ausente** (avisa y devuelve vacío; no inventa datos). |
| `scripts/audit/INFORME_WLG_OCT2026.md` | Este informe (anotación §18.4). |
| `scripts/audit/propuesta_wlg_pe/fix_cliff_wlg.diff` | Propuesta B/C (**NO aplicada**; `git apply --check` OK). |
| `scripts/audit/propuesta_wlg_pe/PROPUESTA_WLG_PE.md` | Metodología del Paso 0 (fuente documentada, anti-look-ahead) + estado. |
| `scripts/audit/propuesta_wlg_pe/paso1_m3_rerun.patch` | Papel del parche de instrumentación (ya implementado como opt-in). |
| `scripts/audit/propuesta_wlg_pe/equivalencia/{equiv.ts,head_cycleTopDetector.ts}` | Evidencia de equivalencia A (§3.2). |
| `scripts/audit/propuesta_wlg_pe/cliff_stats.ts` | Cuantificación del cliff sobre URTH semanal real (§3.8). **Análisis**, no toca motor ni datos. |
| `scripts/audit/propuesta_wlg_pe/scope_b.ts` | Inventario de acantilados de frontera por input = alcance de la opción (b) (§3.9). **Análisis**. |

## 5. Archivos EXCLUIDOS y motivo

| Fichero | Motivo |
|---|---|
| `scripts/audit/m3_results.json` | **Artefacto stale respecto a HEAD**: 1 310 de 2 441 semanas difieren en `trims` (p. ej. `EMXC.DE` 1981: 0.30 → 0.18) por cambios de detector **anteriores y ajenos** a este paquete. Regenerarlo metería ese drift en el push y haría inatribuible el diff. Se **restaura a HEAD**. Regeneración (cuando se quiera): `cd scripts && npx tsx audit/m3_rerun.ts`. |
| `engine_returns.json` | Ajeno a este paquete (instrucción explícita). Se **restaura a HEAD**. |
| Calibración B (RSI) y C (ancla P/E) | **No aplicadas**: requieren aprobación expresa + OOS (B) y serie de P/E verificable (C). Solo existen como `.diff`. |
| `scripts/audit/.base/**` (baseline de HEAD, copias temporales) | Herramienta de verificación desechable, se elimina. |

---

## 6. Riesgo residual y pruebas pendientes

1. **El cliff de 35 pp sigue vivo** en la calibración aprobada (P/E efectivo 16.00→16.01
   y RSI 75→75.05). No es un defecto introducido aquí: es el estado aprobado. Medido
   sobre URTH semanal real (§3.8): 59 saltos ≥30 pp y 21 whipsaws en 14,5 años. La cura
   real es una **rampa suave bajo su propio control de cambios** — ni (a) ni (b) la dan
   gratis: (a) es recalibración de WLG con coste medido, (b) es recalibración global.
2. **La ruta de valoración sigue SIN VALIDAR**: sin `wlg_forward_pe.csv` no hay
   backtest del tramo de P/E; el modo B/C degrada a A y lo declara.
3. El A/B de §3.4 es **in-sample y a nivel de sleeve** (la curva RSI solo afecta a
   WLG, por lo que el efecto de cartera es la composición de sleeves independientes,
   pero no se ha corrido un backtest de cartera completo con la candidata).
4. `equiv.ts` congela una copia de HEAD: si HEAD se mueve, la copia debe regenerarse
   (`git show HEAD:src/core/risk/cycleTopDetector.ts`).
5. Los scripts de `scripts/audit/` **están fuera del `tsconfig`** (`include: src, pages, api`):
   arrastran ruido de tipos preexistente (p. ej. `prices: (string|undefined)[]` con
   aritmética en `m3_harness.ts`/`m3_rerun.ts`). No lo introduce este paquete; el
   loader nuevo sí es type-clean (`tsc --strict` aislado: exit 0).
6. **Pendiente antes de producción (B/C):** walk-forward OOS, sensibilidad al ancla,
   backtest de cartera con la candidata, y bump de `ENGINE_VERSION` + changelog.

## 7. Decisión

- **GO** para el paquete **A + D** (comportamiento-neutro, verificado).
- **NO-GO** para **B** (calibración RSI) y **C** (ancla P/E) hasta: aprobación
  expresa del comité · OOS walk-forward (B) · serie de P/E con fuente verificable (C).
- **Sin commit ni push** hasta tu autorización.
