# PREREGISTRO — DEGRADACIÓN DEL DETECTOR DE TECHO (M3/M4)

> **FROZEN antes de aplicar nada a `src/`.** Criterios de aceptación y de aniquilación
> congelados el 13-oct-2026. Modo: **ESCRITURA PROHIBIDA en `src/`** hasta que el comité
> decida. Este documento solo pre-registra; no autoriza.

## 0. Por qué existe este preregistro

El informe M3/M4 concluye que **ningún detector de techo medible anticipa caídas de
>10% en 6 meses mejor que el azar**, y que aplicarlos cuesta dinero. La conclusión
propuesta no es "afinar el detector" sino **bajarlo de categoría**: usarlo como seguro
de cola pequeño y acotado, no como señal activa por activo.

Es un cambio de comportamiento del motor, así que cae bajo el **change-control §18** de
`OLYMPUS_CORE_v1.0_SPEC.md`: ninguna modificación sin validación IS + OOS y sin
justificación escrita. Este preregistro fija **qué se medirá** y **qué haría fracasar
cada cambio** ANTES de tocar código, para que la decisión no se pueda reescribir después.

## 1. Baseline congelado (reproducido el 13-oct-2026)

- `HEAD b0c730f` · árbol limpio.
- `npx tsc --noEmit` = **0 errores** · `npx vitest run` = **628/628** (44 ficheros).
- **Runner canónico** (`scripts/validation/canonical.ts`, offset 0, 1331 días):
  **CAGR 23,14% · Sharpe 1,266 · MaxDD −15,4%**.
- Los cuatro parches viven en `scripts/audit/proposed_patches/*.diff` y **ninguno está
  aplicado en `src/`** (verificado: `git status --porcelain src/` vacío).

## 2. Definición de REGRESIÓN (aplicable a cualquier parche)

Un parche es REGRESIÓN si, tras aplicarlo:
1. `npx tsc --noEmit` ≠ 0, **o**
2. `npx vitest run` no queda todo en verde (tests nuevos incluidos), **o**
3. el runner canónico deja de reproducir `23,14% / 1,266 / −15,4%`, **salvo** en los
   parches que cambian intencionadamente el recorte (03/04: se documenta la diferencia), **o**
4. `npx tsx scripts/audit/m3_harness.ts` deja de dar **8/8 PASS**.

Acción ante regresión: `git revert` de ese parche y continuar con el siguiente.

## 3. Criterios de aceptación y de aniquilación por parche

Los criterios de aniquilación son los de §5.2 del `INFORME_M4.md`, congelados aquí.

### P1 — Rampa neutra del DXY (`01_dxy_interpolation.diff`)
- **Cambio:** sustituir el escalón `>103 / >106 / >110 / >115` por una rampa continua
  que arranca en **0 exactamente en 103** y conserva los niveles 30/45/65/73%
  repartidos en 103→118.
- **Medido:** `scripts/audit/m4_cliffs.ts` — **ANTES**: maxΔtrim = **30 pp** en
  102,99→103,00, **4 saltos ≥5 pp**. **DESPUÉS**: maxΔtrim = **1 pp**, **0 saltos ≥5 pp**.
- **Aceptación:** 0 saltos ≥5 pp en el barrido; los niveles de trim preservados.
- **ANULA el cambio:** que el barrido vuelva a mostrar saltos ≥5 pp.
- **Coste declarado (no es un defecto):** el primer tramo se **retrasa** — no se puede
  tener 0% en 103 y 30% en 103⁺. A 104,75 el recorte pasa de 30% a 22%.

### P2 — Histéresis sobre la ENTRADA (`02_hysteresis_entrada.diff`)
- **Cambio:** el estado del dólar entra en 103 y **no sale hasta 101** (banda 2 pt);
  requiere campo nuevo `emxcDxyActive` en `CycleTopInputs`, gestionado por el dashboard.
- **Medido:** **ops 34 → 26** (−8 operaciones), **−223 € de impuestos**.
- **Aceptación:** menos operaciones **sin** dejar la señal muda.
- **ANULA el cambio:** que la histéresis reduzca las activaciones **>50%** (señal muda).

### P3 — Tope 30% por detector (`03_caps_por_detector.diff`)
- **Cambio:** `trimPct = min(30, trimPct)` en el detector de EMXC.
- **Medido:** en SEMIS, **ops 455 → 213** con **0 coste** de protección.
- **Aceptación:** menos operaciones sin degradar el peor bache.
- **ANULA el cambio:** que un tope suba el peor bache de la cartera **>1 pp**.

### P4 — Reclasificar el oro (`04_reclasificar_oro.diff`)
- **Cambio:** el oro NO es un techo: es viento en contra → tope duro 20%.
- **Medido:** tras activar, el retorno forward a 6 meses es **−10,4%** frente a
  **+6,0%** incondicional ⇒ **el recorte llega tras la subida, no antes**.
- **Aceptación:** el oro deja de dominar el agregado de recortes.
- **ANULA el cambio:** que el agregado ponderado suba **>5 pp** sin bajar el bache.

### P5 — Comentario obsoleto L805 (`05_deuda_comentario_L805.diff`)
- **Cambio:** solo documentación (el DXY se SUMA, no se multiplica ×1,5; el P/E de EMXC
  ya se eliminó del scoring en Jul-2026). Sin efecto en el motor.
- **Aceptación:** canónico **bit-idéntico**.

## 4. Evidencia reproducida (13-oct-2026, no citada de memoria)

| Comprobación | Comando | Resultado |
|---|---|---|
| Harness reparado | `npx tsx scripts/audit/m3_harness.ts` | **8/8 PASS, 0 FAIL** |
| Verificación independiente | `npx tsx scripts/audit/m4_indep.ts` | ΔCAGR **0,00 pp** · Δvol −0,05 pp · ΔMaxDD −0,03 pp · g/h **PASS** |
| Saltos del DXY | `npx tsx scripts/audit/m4_cliffs.ts` | **4 → 0** saltos ≥5 pp |

## 5. Alcance y lo que NO se puede validar

- **NO se aplica nada a `src/`** en esta fase: los parches quedan como `.diff`.
- **Cuatro señales siguen sin validar** por falta de dato de época: la fórmula real del
  MVRV Z (es entrada manual), el P/E forward de WLG, el Spot/LT del uranio y el credit
  spread anterior a 2023. Sin ellos, esas conclusiones quedan **PARCIAL**.
- El efecto **económico agregado** de P3/P4 sobre la cartera se midió a nivel de
  detector y de recuento de operaciones; **no** se ha corrido un backtest de cartera
  completo con los cuatro parches aplicados a la vez. Ese backtest es requisito antes
  de producción.

## 6. Decisión que se solicita al comité

1. ¿Se aplican **P1, P2 y P5** (ingeniería, sin cambio de tesis: eliminan saltos y
   ruido) manteniendo el detector con su peso actual?
2. ¿Se aplican **P3 y P4** (topes), degradando el detector a **seguro de cola**?
3. ¿O se va más allá y se reduce el peso del detector de techo en la cartera, dado el
   veredicto de la ablación (ver `INFORME_VALIDACION_OCT2026.md`)?

Cualquier respuesta "sí" exige: parche aplicado **uno a uno**, con su test, canónico
reproducido, y anotación en `decision_log` (§18.4).
