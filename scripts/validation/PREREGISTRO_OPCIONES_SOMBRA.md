# PREREGISTRO — CAPA DE OPCIONES EN MODO SOMBRA (OPT-SHADOW v1.0.0)

> **FROZEN el 16-oct-2026, ANTES de calcular ninguna feature ni ver ningún dato.**
> Base de código: `HEAD cd46ae1`. Si se cambia algo de este documento después de ver
> resultados, el periodo de sombra deja de contar como evidencia (ver §9, control de cambios).

## 0. Qué es y qué NO es

Una capa **puramente observacional** que calcula y registra señales del mercado de
opciones (estructura temporal de volatilidad, prima de riesgo de varianza, VVIX, SKEW y
DVOL de BTC) **sin influir en ninguna decisión del motor**.

- NO modifica pesos, Kill Switch, vol target, régimen ni DCA.
- NO se integra en el motor. La promoción a producción exige un preregistro **distinto**
  (`PREREGISTRO_OPCIONES_INTEGRACION.md`, inexistente a fecha de congelación) y un
  cambio de configuración explícito (change-control §18).
- El periodo de sombra es **descriptivo**. Con pocos episodios de estrés no puede
  probar nada por sí solo; la inferencia se hace en histórico largo (§5).

## 1. Invariantes (todos deben cumplirse siempre)

- **I1 Aislamiento**: ningún archivo de `src/` distinto de `src/core/risk/optionsVolShadow.ts`
  y su test importa ese módulo. Lo verifica un test (`optionsVolShadow.test.ts`).
- **I2 Ruta por defecto bit-idéntica**: `tsc` 0 errores y `vitest` completo en verde
  antes y después del cambio; el motor no se toca.
- **I3 Sin fallbacks silenciosos**: si falta una serie requerida, la fila se registra con
  `state = NO_DATA` y la lista de series ausentes. **Nunca** se rellena ni se asume CALM.
- **I4 Log append-only e idempotente**: una fila por fecha de mercado; una fila ya
  escrita no se reescribe. Las correcciones se hacen añadiendo fila con `status` de
  revisión, no editando.
- **I5 Sin look-ahead**: las features en la fecha *t* usan solo datos con fecha ≤ *t*.
  Los z-scores usan la ventana de los 252 días **anteriores** (excluye *t*).

## 2. Features (definiciones exactas)

| ID | Definición | Convención |
|---|---|---|
| F1 `ts` | `VIX / VIX3M` | cierre diario |
| F2 `vrp` | `VIX − RV21(^GSPC)` | RV21 = desv. típica **muestral** (n−1) de 21 retornos log diarios (22 cierres válidos consecutivos) × √252 × 100 |
| F3 `vvixVix` | `VVIX / VIX` | cierre diario; se usa su z-score |
| F4 `skew` | nivel `^SKEW` | se usa su z-score |
| F5 `dvol` | cierre diario del índice DVOL (Deribit, BTC) | |
| F6 `vrpBtc` | `DVOL − RV30(BTC-USD)` | RV30 = desv. típica muestral de 30 retornos log diarios (31 cierres válidos) × √365 × 100 |

z-score(x_t) = (x_t − media de x_{t−252..t−1}) / desv. típica muestral de x_{t−252..t−1}.
Requiere ≥ 252 observaciones válidas previas; si no, `z = null` y `state = INSUFFICIENT_HISTORY`.

## 3. Flags y estados (umbrales congelados)

Flags de renta variable (cada uno 0/1):

- `TS_BACKWARDATION`: `ts > 1.00`
- `VRP_NEGATIVA`: `vrp < 0`
- `VVIXVIX_Z`: `z(vvixVix) ≥ 2.0`
- `SKEW_Z`: `z(skew) ≥ 2.0`

Estado de renta variable:

- **CONFIRM** = `TS_BACKWARDATION` ∧ al menos uno de {`VRP_NEGATIVA`, `VVIXVIX_Z`, `SKEW_Z`}
- **WATCH** = al menos un flag activo y no CONFIRM
- **CALM** = ningún flag activo
- **NO_DATA** / **INSUFFICIENT_HISTORY** según §1-I3 y §2

Estado BTC (independiente, **no** se mezcla con el de renta variable):

- **CONFIRM** = `z(dvol) ≥ 2.0` ∧ `vrpBtc < 0`
- **WATCH** = exactamente una de las dos condiciones
- **CALM** = ninguna

Quedan **fuera de alcance** en v1.0.0 (necesitan cadena de opciones e interpolación):
skew de 25 delta de BTC, gamma exposure (GEX), put/call ratio. Se añadirán, si se
añaden, en una versión nueva con su propio preregistro.

## 4. Política de datos

- Yahoo chart API (`^VIX`, `^VIX3M`, `^VVIX`, `^SKEW`, `^GSPC`, `BTC-USD`) y Deribit
  `public/get_volatility_index_data`.
- Cada serie empieza en su primera barra real; **sin relleno alguno** (ni hacia atrás ni
  hacia delante). Se emite fila solo para fechas en que existe cierre válido de `^VIX`.
- Una serie requerida sin barra con esa fecha **exacta** cuenta como ausente
  (`NO_DATA`); K3 vigila que esto no se vuelva habitual.
- Los cierres deben ser números finitos y > 0; cualquier otro valor cuenta como ausente.
- El snapshot se ejecuta después del cierre de EE. UU. (≥ 23:30 hora de Madrid).

## 5. Evidencia en histórico largo (fase separada, mismos umbrales)

Se evalúan los **mismos** umbrales de §3, sin reoptimizarlos, sobre el histórico completo
disponible de `^VIX3M`, `^VVIX` y `^SKEW` (descarga desde 2006-01-01; cada serie empieza en
su primera barra real). Implementación: `scripts/validation/opt_shadow_backtest.ts`.
Las filas se calculan con el mismo módulo `optionsVolShadow.ts` que el modo sombra.

**Definiciones operativas (fijadas antes de ver ningún resultado):**

- Calendario: el de `^GSPC` (jornadas bursátiles). Solo se evalúan filas con estado
  CALM/WATCH/CONFIRM (no `NO_DATA` ni `INSUFFICIENT_HISTORY`).
- **Evento E en t**: `min_{k=1..20} (S_{t+k} / S_t − 1) ≤ −7%`, con `S` el cierre de
  `^GSPC` y `k` en jornadas bursátiles. Los días *t* sin 20 jornadas posteriores
  disponibles quedan fuera de la muestra.
- **Episodio CONFIRM**: racha de filas consecutivas en estado CONFIRM. Un episodio es
  **falso positivo** si E(t₀) es falso, con t₀ su primer día.
- **Cruce de L1** en la cartera de referencia (`engine_returns.json`, `engineValues`):
  primer día con drawdown ≥ 12% (`TAIL_RISK_CONFIG.KILL_SWITCH.L1.threshold`) desde el
  último máximo; el detector se rearma solo cuando la cartera marca un nuevo máximo.
- **Adelanto** de un cruce: jornadas entre el **primer día CONFIRM** dentro de las 20
  jornadas anteriores al cruce (incluido el día del cruce) y el cruce. Sin ningún CONFIRM
  en esa ventana: “sin aviso”, adelanto = 0.

**Criterios:**

- **A1 Elevación**: `P(E | CONFIRM) / P(E)` ≥ 1,5 con límite inferior del IC95 > 1,0.
- **A2 Valor incremental sobre el VIX en nivel** (el criterio que importa, porque el VIX
  en nivel ya cuenta en `regimeProbabilistic`, `tailRisk` y `globalStress`):
  `P(E | CONFIRM ∧ VIX < 25)` frente a `P(E | VIX < 25)`; mismo umbral que A1.
- **A3 Falsos positivos**: proporción de episodios CONFIRM falsos positivos ≤ 60%.
- **A4 Adelanto frente al Kill Switch**: mediana del adelanto de los cruces de L1 > 0
  (los “sin aviso” cuentan 0). Con *n* < 5 cruces el resultado es solo descriptivo.
- **Guardia de potencia**: si el número de episodios CONFIRM es < 5, A1–A3 se declaran
  **NO CONCLUYENTES** (no aprobados ni suspendidos) y K1/K2 no se activan.
- **Inferencia**: bootstrap por bloques móviles (bloque de 20 jornadas, 2.000 réplicas,
  semilla fija 20261016) por el solape de ventanas. Cada flag individual es exploratorio
  y se contrasta a α = 0,05 / 5 (Bonferroni, 5 hipótesis: composite + 4 flags), es decir,
  IC99 para los individuales. El composite CONFIRM es la única hipótesis primaria. Se
  reporta además, como exploratorio, CONFIRM sin `SKEW_Z` (ver §8).
- BTC: DVOL solo existe desde 2021; el backtest de renta variable no incluye BTC y
  cualquier conclusión sobre BTC se etiqueta **de muestra corta** y no puede sostener una
  promoción por sí sola.

## 6. Criterios de abandono (kill)

Se descarta la capa si ocurre cualquiera:

- **K1** A2 falla (no aporta nada sobre el VIX en nivel).
- **K2** A3 falla de forma que CONFIRM dispararía > 60% de falsas alarmas.
- **K3** Más de 5% de las filas del periodo de sombra en `NO_DATA` (calidad de datos
  inaceptable para depender de ella).
- **K4** Cualquier violación de I1–I5 detectada.

## 7. Qué se registra en sombra (log diario)

`shadow_logs/options_shadow_log.csv`: fecha, versión de especificación, hash del
preregistro, estado de datos, series ausentes, F1–F6, z-scores, flags, estados (renta
variable y BTC) y marca de tiempo de ejecución. Un episodio contrafactual (“habría
adelantado o evitado un L1”) se calcula **fuera de línea** a partir del log y del
historial de decisiones; nunca se ejecuta.

## 8. Post-mortem anticipado (asume que esto ha fallado a 3 meses)

| Causa probable | Señal que podríamos ignorar | Tripwire |
|---|---|---|
| Backwardation en picos benignos (rápidos y reversibles) | CONFIRM aparece y el mercado no cae | A3; revisar duración media de episodios |
| SKEW no informativo (efecto conocido: SKEW alto no predice caídas de forma fiable) | `SKEW_Z` es el único flag que sostiene CONFIRM | Reportar A1–A2 con y sin `SKEW_Z` (exploratorio) |
| Caída de datos silenciosa (Yahoo cambia ticker o formato) | Filas “CALM” durante semanas | I3 + K3: NO_DATA nunca se disfraza de CALM |
| Grados de libertad del analista | Ajustar un umbral “porque casi” dispara | §9: cualquier cambio de umbral = versión nueva, descarta la evidencia previa |
| Poca potencia estadística (pocos episodios) | Concluir con n < 5 | §5-A4: n < 5 es descriptivo, no concluyente |
| Muestra BTC corta (DVOL desde 2021) | Extrapolar a ciclos completos | Etiquetado obligatorio de muestra corta |
| Doble conteo con el VIX en nivel | La señal es el VIX con otro nombre | A2 es criterio de aceptación, no opcional |

## 9. Control de cambios

- Este archivo se identifica por su SHA-256. El snapshot lo calcula en cada ejecución y
  lo escribe en cada fila (`preregSha`). Si cambia, las filas posteriores quedan
  marcadas con otro hash y **no** se combinan con las anteriores para inferencia.
- Cualquier cambio de umbral, feature, ventana o criterio crea `OPT-SHADOW v1.x.y` con
  preregistro nuevo; la evidencia previa no se hereda.
- Promoción a integración: preregistro propio, validación IS/OOS/WFA y bootstrap pareado
  como en `PREREGISTRO_CORE_V11.md`, más aprobación explícita (no automática).
