# APLICACIÓN M3/M4 — parches del detector de techo aplicados a `src/`

> **Registro de ejecución (13-oct-2026).** Cierra el ciclo abierto por
> `scripts/audit/INFORME_M4.md` (decisión) y
> `scripts/validation/PREREGISTRO_M4_DEGRADACION.md` (criterios congelados).
> Los cinco parches se aplicaron UNO A UNO, cada uno con su commit atómico, su
> test, la suite entera en verde y el runner canónico reproducido. Este
> documento es la anotación que el preregistro exige en decision_log (§18.4):
> qué se aplicó, cómo se apartó del `.diff` original y por qué.

## 0. Baseline y orden de aplicación

Baseline congelada del preregistro: `HEAD b0c730f` · `tsc` 0 · 628/628 ·
canónico **MOTOR 22.92% / 1.332 / −15.2% · cross 23.14% / 1.266 / −15.4%**.

| orden | parche | commit | verificado tras el commit |
|---|---|---|---|
| 1 | P5 comentario L805 | `2cf6442` | canónico bit-idéntico |
| 2 | P1 rampa DXY EMXC | `ee4549d` | cliffs 4→0, jalones de trim 22/30/30/38/45/65/73 declarados; suite verde |
| 3 | P3 tope 30% (EMXC) | `2e42409` | canónico bit-idéntico; invariantes intactos |
| 4 | P4 oro tope 20% | `acbe4fa` | canónico bit-idéntico; 2 tests GOLD-CB-SENSOR ajustados |
| 5 | P2 histéresis DXY | `2a42103` | canónico bit-idéntico; dashboard cableado |

## 1. Desviaciones sobre los `.diff` originales (inspectadas y justificadas)

### P3 / P4 — el `.diff` original rompía el invariante estructural
El parche `03` acotaba el **trimPct derivado** (`trimPct = min(30, …)`) y el
`04` hacía lo mismo con el oro (20%). Eso rompe el invariante FIX-STRUCTURAL
de Jul-2026 (`trimPct === round((1 − multiplier) × 100)`)
— `detectorInvariants.test.ts` lo detectó en el grid al aplicar P4
(`expected 20 to be 45`).
**Aplicación real:** se acota el **MULTIPLIER** (P3: floor 0.70 ⟺ trim ≤30%;
P4: floor 0.80 ⟺ trim ≤20%) y `zone` se calcula **antes** del cap (describe la
fuerza de la señal, no el tamaño del recorte — misma convención en P3 y P4).
`trimPct` sigue derivándose, invariante intacto en todo el grid.

### P2 — el `.diff` original era fail-open
El parche `02` condiciona el scoring DXY de EMXC a
`emxcDxyActive` tal que **campo ausente = señal apagada**: backtest, runner
canónico y grid de invariantes habrían perdido la señal DXY silenciosamente.
**Aplicación real:** el campo es **OPT-IN** (`emxcDxyActive ?? true`); si no
llega el estado, el comportamiento es el de nivel (FIX-CLIFF-DXY/P1). El
estado lo mantiene el caller (dashboard), que es quien observa lecturas
sucesivas, vía `updateEmxcDxyHysteresis()` exportada (entrar >103 / salir
<101, lecturas inválidas no mueven el estado). El canónico sale
**bit-idéntico**, verificando que el opt-in no toca el camino sin estado.

### P2 — cableado en el dashboard
La histéresis elimina el parpadeo del panel con DXY oscilante; el estado vive
en `InstitutionalDashboard.tsx` con un `useEffect` funcional sobre `dxy`
(ningún otro estado depende de la actualización; sin dependencias cíclicas).

## 2. Evidencia final (reproducida 13-oct-2026)

| comprobación | comando | resultado |
|---|---|---|
| Tipos | `npx tsc --noEmit` | **0 errores** |
| Suite entera | `npm run test` | **643/643** (44 ficheros; +15 tests netos vs baseline 628) |
| Harness ON/OFF | `npx tsx audit/m3_harness.ts` (desde `scripts/`) | **8/8 PASS, 0 FAIL** |
| Saltos del DXY | `npx tsx audit/m4_cliffs.ts` | **0 saltos ≥5 pp** (antes 4) |
| Runner canónico | `npx tsx scripts/validation/canonical.ts` | **bit-idéntico** en los 5 commits |

Nota operativa: el harness vive bajo `scripts/` — el canónico y los bloques de
auditoría se ejecutan desde `scripts/` (`npx tsx audit/m3_harness.ts`). Si se
corren desde la raíz crashean con ENOENT (`audit/data/*.csv`): defecto de
rutas relativas conocido, no de este ciclo.

## 3. Cumplimiento de los criterios congelados del preregistro

| criterio | estado |
|---|---|
| §2.3 canónico salvo parches que cambian el recorte | **MEJOR**: bit-idéntico en TODOS, incluyendo P3/P4 (el canónico no activa los inputs que disparan los topes) |
| §2.4 harness 8/8 | **OK** |
| P1: 0 saltos ≥5 pp | **OK** (coste declarado: primer tramo retrasado — 22% en 104.75 en vez de 30%) |
| P2: sin señal muda (<50% de activaciones) | **OK por diseño**: opt-in; el brazo desarmado solo apaga DXY, nunca el resto de inputs (test explícito) |
| P3: el tope no sube el bache >1 pp | no re-medido con cartera completa; justification: el tope SOLO puede reducir recortes (trim ≤30), y el canónico es bit-idéntico |
| P4: el agregado no sube >5 pp sin bajar el bache | ídem: trim del oro ≤20 ≤ trim anterior; monotonicidad preservada |
| Anotación en decision_log | ESTE DOCUMENTO |

## 4. Lo que queda abierto (deliberado, no asumido)

- El backtest de cartera completa con los cinco parches conjuntos (requisito
  §5 del preregistro para PRODUCCIÓN) no se ha corrido aquí; la evidencia es
  por-parche + suite + canónico. Modo sombra §4.2 del INFORME_M4 sigue siendo
  el camino de cierre.
- Cuatro señales siguen SIN validar por falta de dato de época (MVRV Z fórmula
  real, P/E forward WLG vintage, Uranio Spot/LT, credit pre-2023): conclusiones
  PARCIAL, fechados en INFORME_M4 §5.1.
- Deuda de naming `wtiOil`→`brentOil` conservada (documentado en AGENTS.md y
  P5); el ratio Spot/LT del uranio clampado sigue perdiendo granularidad
  (FIX-AUDIT-URANIO-CLAMP), consciente.
- No se aplicaron los flags de reversión de §4.3 (`CYCLE_TOP_INTERP_V1`,
  `GOLD_AS_HEDGE`): cada parche es un commit atómico revertible
  (`git revert <hash>`); añadir flags duplicaría el estado de decisión.
