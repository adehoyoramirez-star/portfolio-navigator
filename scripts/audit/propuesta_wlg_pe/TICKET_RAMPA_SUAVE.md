# TICKET (DISEÑO, NO IMPLEMENTADO) — rampa suave en sustitución del cliff de frontera

> **Estado: DISEÑO. Nada de esto está implementado.** No hay código, ni flags, ni cambios
> de motor en este documento. Fecha: 13-oct-2026. Base: commit `4ab4417` (paquete A+D),
> `ENGINE_VERSION` v5.4.6. Decisión vigente del comité: **(c) mantener en este paquete**;
> este ticket es el prerequisito documentado para reabrir el tema.
>
> Evidencia que lo motiva: `scope_b.ts` (§3.9 del `INFORME_WLG_OCT2026.md`) y
> `cliff_stats.ts` (§3.8).

---

## 1. Problema exacto a resolver

La regla de frontera de `smoothScore` (`src/core/risk/cycleTopDetector.ts:75`) es
`x ≤ a₁ ⇒ 0`. Cuando la primera ancla **a₁ tiene score ≠ 0 y no hay guard**, el motor pasa
de “sin señal” al score de a₁ en un solo paso. Medido con el detector real (paso 0.01):

| # | Curva (input) | Ticker | max\|Δtrim\| | Punto |
|---|---|---|---|---|
| 1 | `wlgRsiWeekly` | WLG | 35,0 pp | 75,00 → 75,01 |
| 2 | `wlgPERatio` | WLG | 35,0 pp | 16,00 → 16,01 |
| 3 | `wlgCAPE` (fallback) | WLG | 35,0 pp | 14,00 → 14,01 |
| 4 | `puellMultiple` | BTC | 35,0 pp | 2,50 → 2,51 |
| 5 | `emxcRsiWeekly` | EMXC | 25,0 pp | 75,00 → 75,01 |
| 6 | `soxRsiWeekly` | SEMIS | 35,0 pp | 80,00 → 80,01 |
| 7 | `soxSpyRelativeStrength` | SEMIS | 30,0 pp | 1,00 → 1,01 |

Las otras 8 curvas del detector tienen a₁ con score 0 o un guard previo → **no necesitan
ticket** (ver §3.9.1 del informe). El cliff de la ruta de valoración (2 y 3) **no tiene
datos históricos** (`wlg_forward_pe.csv` inexistente) → su calibración no se puede validar hoy.

## 2. Diseño propuesto: ancla cero explícita por curva (local), NO regla global

**B1 (preferida)** — cada curva recibe un **punto de arranque** `a₀ < a₁` con score 0, es
decir se le añade el ancla `[a₀, 0]`. La rampa pasa a ser `a₀ → a₁` (0 → score(a₁)) en vez de
un escalón en a₁. Es exactamente la mecánica del grupo B/C ya propuesto para WLG, generalizada
a las 7 curvas, **sin tocar `smoothScore`** → no recalibra ninguna otra curva.

**B2 (descartada de entrada)** — cambiar `smoothScore` globalmente. Recalibra a la vez las 8
curvas restantes y sus umbrales aprobados; requiere su propio change-control global. Se
documenta solo para dejar constancia de que existe y de por qué no.

### 2.1 Configuración (propuesta de interfaz — NO implementar sin orden)

Rampa **por detector** y **opt-in**, con default = calibración aprobada:

```ts
// propuesta de forma, no de valores definitivos
interface SmoothRampConfig {
  wlgRsi?:      { zeroAt: number };   // a₀
  wlgPE?:       { zeroAt: number };
  wlgCape?:     { zeroAt: number };
  puell?:       { zeroAt: number };
  emxcRsi?:     { zeroAt: number };
  soxRsi?:      { zeroAt: number };
  soxSpyRel?:   { zeroAt: number };
}
// activación por entorno, granular y aditiva, p. ej.
//   SMOOTH_RAMP=WLG,EMXC      → aplica solo a esas curvas
//   SMOOTH_RAMP_OFF=all       → default (comportamiento actual, sin cambios)
```

Valores de `a₀` **candidatos para el walk-forward** (NO decididos aquí, NO implementados):

| Curva | a₁ (aprobada) | a₀ candidato | Comentario |
|---|---|---|---|
| `wlgRsiWeekly` | 75 (score 1.0) | **70** | 70/72/75 = los tres brazos exigidos por el OOS |
| `wlgPERatio` | 16 (score 1.0) | **14** | sin datos históricos → **no promovible hoy** |
| `wlgCAPE` | 14 (score 1.0) | **12,5** | idem |
| `puellMultiple` | 2,5 (score ≠0) | **2,0** | verificar si el score de 2,5 es 1.0 |
| `emxcRsiWeekly` | 75 | **70** | EMXC es más volátil: validar |
| `soxRsiWeekly` | 80 | **75** | |
| `soxSpyRelativeStrength` | 1,0 | **0,75** | |

**Invariante del diseño:** en `a₀` el score es 0 ⇒ **no se crea un cliff nuevo** en a₀.
Criterio verificable: `|Δtrim| < 5 pp` en todo el rango (paso 0.01).

**Lo que la rampa NO arregla (declarado):** el salto máximo observado en URTH semanal es
**55,0 pp en ambas curvas** (viene de las salidas desde RSI ≥ 83, no de la frontera). La rampa
reduce la **frecuencia** de saltos ≥30 pp (59 → 22 en la variante B de WLG), no el máximo.

## 3. Criterios de aceptación (todos medibles, todos bloqueantes)

| # | Criterio | Umbral | Cómo se mide |
|---|---|---|---|
| A1 | Salto máximo de frontera | **≤ 5 pp** | barrido paso 0.01 por curva (`scope_b.ts`) |
| A2 | Saltos ≥5 pp en el rango útil | **0** | idem |
| A3 | Whipsaws (episodios ≥75 de ≤4 semanas) | **≤ 10** (hoy 21) | `cliff_stats.ts` |
| A4 | CAGR de sleeve (WLG) | **≥ −0,20 pp** vs baseline | `C6` |
| A5 | CAGR de **cartera** (6 sleeves) | **≥ −0,10 pp** vs baseline | backtest de cartera completo |
| A6 | MaxDD | **no peor en > 0,5 pp** | sleeve y cartera |
| A7 | Impuestos **netos descontados del NAV** | **≤ baseline + 0 €** | requiere arreglar el harness (§5) |
| A8 | Operaciones | **+≤ 20** vs baseline | `C6` |
| A9 | Equivalencia fuera de la rampa | **0 discrepancias** | `equiv.ts` extendido a las 7 curvas |
| A10 | Walk-forward OOS | **ΔCAGR > 0** en test para ≥2 de 3 anclas | §4 |

Si **cualquiera** de A1–A10 falla → la rampa no se promueve y se mantiene (c).

## 4. Evidencia exigida ANTES de promover (bloqueante)

1. **Walk-forward OOS con sensibilidad al ancla** — 3 brazos de ancla × 3 de trim:
   RSI ∈ {70, 72, 75} y trim ∈ {0; 0,5; 1,0}. Split temporal explícito (p. ej. train
   pre-2020 / test 2020+), métricas de test pre-registradas, y **la misma** rampa en train y
   test (sin re-optimizar en test). Hoy existe solo un A/B **in-sample**.
2. **Backtest de cartera completa** (6 sleeves, `w_s = NAV/6`, banda 2 % NAV) con costes
   (spread 5 pb) **e impuestos**, comparando calibración aprobada vs rampa, con número de
   operaciones, impuestos y MaxDD.
3. **Harness fiscal**: hoy `runSleeve` acumula `taxes` en un contador pero **no** lo descuenta
   del NAV (`cash += proc - sc`), de modo que A7 no es evaluable con las cifras actuales.
   Sin este arreglo (más su propio control de cambios), la promoción queda bloqueada.
4. **Serie de P/E forward con fuente verificable** si se quiere promover también las curvas 2
   y 3 (MSCI World factsheet, o Yardeni marcado **PROXY** + análisis de sensibilidad).

## 5. Plan de rollback

- **Default OFF**: sin `SMOOTH_RAMP` en el entorno, el motor emite la calibración aprobada.
  La rampa se aplica **solo por inyección explícita** (tests / harness) hasta la promoción.
- **Rollback = 1 commit** (revert) porque B1 no cambia `smoothScore` ni las curvas de otros
  detectores; ninguna otra señal hereda el cambio.
- La calibración aprobada **se conserva** como constante (`*_CURVE_APPROVED`) → volver atrás
  no requiere reconstruirla.
- Promoción = bump de `ENGINE_VERSION` + entrada en el changelog + nota de `decision_log`
  (nada de esto se hace sin orden expresa del comité).

## 6. Riesgos del propio ticket

1. **Contra-riesgo principal**: la rampa *retrasa* los recortes → menos protección en la
   primera parte de una subida. El OOS (A10) debe demostrar que no se pierde protección
   (MaxDD y caída en los episodios de 2018/2020/2022).
2. Elegir `a₀` con el OOS es un parámetro más: **exige pre-registro** de brazos y umbrales
   antes de mirar resultados (si no, es overfitting con pasos extra).
3. A3/A9 dependen de la calidad de la serie de RSI semanal (URTH desde 2012; 1 685 de 2 441
   semanas sin RSI-W).
4. Extender el ticket a BTC/EMXC/SEMIS amplía el alcance a 4 tickers: conviene partirlo en
   **4 sub-tickets** (WLG, BTC, EMXC, SEMIS) con su propia aceptación, empezando por WLG.
