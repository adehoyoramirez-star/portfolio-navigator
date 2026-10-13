# PROPUESTA — WLG forward P/E: serie histórica + instrumentación del harness

> **ESTADO (actualizado 13-oct-2026): instrumentación CABLEADA como opt-in;
> calibración y validación PENDIENTES.**
> - `scripts/audit/wlg_forward_pe.ts` (Paso 0) y la instrumentación del harness
>   (Paso 1) **ya existen**, pero son **opt-in**: el modo `A` es el default y el
>   canónico es invariante (verificado línea a línea frente a HEAD-code; ver
>   `../INFORME_WLG_OCT2026.md` §3.3). **Nada de esto toca el motor en runtime.**
> - La **calibración** (ancla rolling 10a, curvas RSI/valoración candidatas) sigue
>   **NO APLICADA**: `fix_cliff_wlg.diff` (adjunto, `git apply --check` OK).
> - La **serie histórica de P/E forward NO EXISTE** en el repo: sin ella el Paso 0
>   queda sin datos, el modo `B`/`C` degrada a `A` con aviso explícito y la ruta de
>   valoración sigue **SIN VALIDAR** (no se inventan datos).
>
> Contexto: informe de revisión cuantitativa del detector de techo WLG
> (13-oct-2026). Hallazgos que motivan esta propuesta:
> 1. **Cliff de 37 pp** en el ancla P/E = 16 efectivo (`smoothScore` devuelve 0
>    por debajo del primer umbral y arranca en score 1.0 en el umbral).
> 2. **Persistencia estructural**: el P/E se compara contra una media fija ~16.
> 3. **Vacío empírico**: `m3_rerun.ts` no pasa `wlgPERatio` → la ruta de
>    valoración de WLG **nunca se ha backtesteado**. No existe serie histórica
>    de P/E forward en el repo (solo precios URTH 2012-2026).

---

## Paso 0 (bloqueante) — Serie histórica de P/E forward MSCI World + baseline rolling

### 0.1 Contrato de datos
CSV mensual `wlg_forward_pe.csv` con cabecera y columnas:

| columna | significado |
|---|---|
| `date` | **fecha de publicación** del dato (ISO `YYYY-MM-DD`), no la del período |
| `forwardPE` | P/E forward del MSCI World (número) |
| `source` | etiqueta de la fuente y su fecha (auditoría) |

**Fuente documentada — elegir UNA y dejarla constancia en el CSV `source`:**
- (a) **MSCI World Index factsheet** mensual → campo *Fwd P/E* (fuente preferida:
  es el índice que posee WLG).
- (b) **Yardeni Research** S&P 500 Forward P/E → **PROXY** (marcarlo como tal; el
  S&P 500 es estructuralmente más caro que el MSCI World por concentración Mag7).
- (c) Proveedor de datos del ETF URTH (ficha del fondo).

> Regla anti-circularidad: **no** derivar el beneficio estimado desde la propia
> serie de precio. El P/E debe venir de una fuente fundamental externa.

### 0.2 Metodología (sin look-ahead)
1. Cargar y ordenar por `date` ascendente.
2. **Valor vigente** `wlgForwardPE(t)` = último registro con `publicationDate ≤ t`
   (respeta el retardo de publicación ~1 mes). Sin esto hay look-ahead.
3. **Baseline** `baseline(t)` = **mediana** rolling de los registros con
   `publicationDate ≤ t` dentro de una ventana trailing de **120 meses** (10 años).
   Mínimo 60 meses; si no hay suficientes → `baseline = prior` (16) y
   `baselineReliable = false`.
4. Salida alineada al grid del backtest: `{ d, wlgForwardPE, baseline, baselineReliable }`.

### 0.3 Código propuesto (NO cableado) — `wlg_forward_pe.ts`
```ts
// PROPUESTA — Paso 0. NO importada en el motor ni en el harness.
import { readFileSync } from "fs";

export interface WlgPePoint {
  d: string; wlgForwardPE: number; baseline: number; baselineReliable: boolean;
}
const DAY = 86400000;
const toMs = (d: string) => Date.parse(d + "T00:00:00Z");

export function buildWlgForwardPeSeries(
  csvPath: string,
  grid: string[],                       // fechas del backtest, ascendentes
  opts?: { windowMonths?: number; minMonths?: number; prior?: number },
): WlgPePoint[] {
  const windowMonths = opts?.windowMonths ?? 120;  // 10 años
  const minMonths    = opts?.minMonths    ?? 60;   // 5 años mínimo
  const prior        = opts?.prior        ?? 16;   // prior documentado

  const rows = readFileSync(csvPath, "utf8").trim().split("\n").slice(1)
    .map(l => l.split(","))
    .map(c => ({ t: toMs(c[0]), pe: Number(c[1]) }))
    .filter(r => Number.isFinite(r.pe))
    .sort((a, b) => a.t - b.t);

  const out: WlgPePoint[] = [];
  for (const d of grid) {
    const t = toMs(d);
    let cur: number | undefined;
    for (const r of rows) { if (r.t <= t) cur = r.pe; else break; }   // <= t
    if (cur === undefined) continue;

    const from = t - windowMonths * 30.44 * DAY;
    const win = rows.filter(r => r.t <= t && r.t >= from).map(r => r.pe);
    let baseline: number, reliable: boolean;
    if (win.length >= minMonths) {
      const s = [...win].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      baseline = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;   // mediana
      reliable = true;
    } else { baseline = prior; reliable = false; }

    out.push({ d, wlgForwardPE: cur, baseline, baselineReliable: reliable });
  }
  return out;
}
```

### 0.4 Test anti-look-ahead (obligatorio)
```ts
// Para todo t: recomputar con la serie truncada en t y exigir igualdad bit a bit.
test("baseline sin look-ahead", () => {
  for (const i of sampleIndices) {
    const full = buildWlgForwardPeSeries(csv, grid.slice(0, i));
    const trunc = buildWlgForwardPeSeries(csv, grid.slice(0, i), { /* csv truncado en t_i */ });
    expect(trunc.at(-1)).toEqual(full.at(-1));
  }
});
```

---

## Paso 1 — Instrumentación del harness `m3_rerun.ts`

### 1.1 Objetivo
Que el backtest canónico **ejerza** la ruta de valoración de WLG (hoy inactiva),
con **universo, fechas, costes y datos idénticos** entre modos.

### 1.2 Modos (variable de entorno, no reescribe A)
| Modo | Qué inyecta |
|---|---|
| `A` | **nada** (comportamiento actual) — control bit-idéntico |
| `B` | `wlgPERatio` = P/E forward histórico (Paso 0) + `regimeShiftPE` |
| `C` | B **+** curva score→multiplier suavizada (requiere el sub-parche 1.4) |

### 1.3 Diff propuesto — ver `paso1_m3_rerun.patch` (adjunto)
> **Implementado como opt-in en el paquete Oct-2026** (modo `A` default = control).
> El `.patch` se conserva como referencia histórica del diseño.
Punto de instrumentación real: bloque `CycleTopInputs` en **L112–125** (y el
segundo bloque en **L367**). El harness **nunca** fija `wlgPERatio` ni `regimeShiftPE`.

### 1.4 Sub-parche de C (curva inyectable) — **implementado para las curvas de WLG**
> En el paquete Oct-2026 el detector expone `WlgCurveOverrides` y las constantes
> `WLG_*_CURVE_APPROVED` / `WLG_*_CURVE_CANDIDATE`, con **default = curva aprobada**
> (comportamiento-neutro, medido: `equivalencia/equiv.ts`, 27 477 casos). La curva
> score→multiplier global (`multiplierFromScore`) sigue **sin parametrizar**.
`C` no puede lograrse solo desde el harness: la curva vive **dentro** del detector
(`multiplierFromScore`). Propuesta de refactor (sin cambiar el default):
```ts
// cycleTopDetector.ts — PROPUESTA (default = curva actual, bit-idéntico)
export type Curve = [number, number][];
export const CURVE_DEFAULT: Curve =
  [[0,1.0],[0.5,0.75],[1.5,0.55],[2.5,0.35],[3.5,0.20],[5.0,0.10]];
function multiplierFromScore(score: number, curve: Curve = CURVE_DEFAULT) { /* … */ }
export function detectWLGTop(inputs, curve?: Curve) { /* usa curve ?? CURVE_DEFAULT */ }
```
Así el harness puede pasar una curva alternativa en modo C **sin tocar la
producción** (default sin cambios → canónico bit-idéntico).

### 1.5 `regimeShiftPE` en el harness
El harness no tiene ruta de régimen. Opciones (documentar la elegida):
- (i) importar `detectRegimeProbabilistic`/`masterRegime` y derivar el régimen en
  cada fecha del grid → máxima fidelidad a producción;
- (ii) mantener `regimeShiftPE = 0` y **acotar la sensibilidad** corriendo también
  con +1.5 y −1.5 (ya sabemos: 38% / 42% / 46% en el caso actual).

---

## Paso 2 — Calibración candidata (a definir con los datos del Paso 0)
- Ancla = `baseline(t)` rolling 10a **documentada** (en vez de la constante 16).
- Rampa de valoración con **suelo explícito** para eliminar el cliff, p. ej.
  `[[baseline − 3, 0], [baseline, 1.0], …]`.
- Curva score→multiplier suavizada en la zona baja.

## Paso 3 — Validación exigida (idéntica entre A/B/C)
- Backtest de cartera comparable (mismas fechas/costes/universo).
- **Walk-forward OOS** (baseline recalculado solo con información pasada).
- Sensibilidad al ancla (±2) y a la curva.
- Métricas: CAGR, Sharpe, Sortino, MaxDD, **rotación**, costes, % tiempo con
  exposición reducida y **retorno perdido en recuperaciones**.

## Criterios de aceptación (propuestos)
- Mejora **robusta** del balance retorno/riesgo **en OOS** (no solo in-sample).
- MaxDD no empeora > 1 pp (criterio de aniquilación M3/M4).
- Rotación y costes **no aumentan**.
- Cliff eliminado (test: `trim(16.00) → trim(16.01)` sin salto > 5 pp).
- Canónico reproducido + anotación en `decision_log`.

## Pruebas de regresión a añadir
1. `trim` fijado en P/E efectivo ∈ {13, 15.99, 16.00, 16.01, 17.9, 20, 23, 27}.
2. Continuidad de la curva en los anclajes (sin saltos > 5 pp).
3. Anti-look-ahead del baseline (Paso 0.4).
4. Modo A bit-idéntico al canónico actual (control).
