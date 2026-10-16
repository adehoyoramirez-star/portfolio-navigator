# OPT-SHADOW v1.0.0 — capa de opciones en modo sombra

**Solo observabilidad.** No influye en pesos, Kill Switch, vol target, régimen ni DCA.
Especificación congelada: [`scripts/validation/PREREGISTRO_OPCIONES_SOMBRA.md`](../validation/PREREGISTRO_OPCIONES_SOMBRA.md).

## Piezas

| Archivo | Papel |
|---|---|
| `src/core/risk/optionsVolShadow.ts` | Librería pura: features, flags y estados. No importa nada del motor. |
| `scripts/shadow/optionsShadowParsers.ts` | Parsers puros de Yahoo y Deribit (testeados con fixtures). |
| `scripts/shadow/options_shadow_snapshot.ts` | Descarga, calcula y **añade** una fila a `shadow_logs/options_shadow_log.csv`. |
| `src/test/optionsVolShadow.test.ts` · `optionsShadowParsers.test.ts` | Tests, incluido el de aislamiento (I1). |

## Ejecución diaria

```bash
npx tsx scripts/shadow/options_shadow_snapshot.ts          # escribe en el log
npx tsx scripts/shadow/options_shadow_snapshot.ts --dry    # solo imprime
npx tsx scripts/shadow/options_shadow_snapshot.ts --date 2026-10-15 --dry
```

Programar **después del cierre de EE. UU., ≥ 23:30 hora de Madrid** (cron o Programador de
tareas de Windows). La barra del día en curso se descarta hasta las 21:00 UTC.

Códigos de salida: `0` OK o fecha ya registrada · `2` cabecera del log incompatible ·
`3` no se pudo determinar la fecha (`^VIX` no descargado) · `1` error inesperado.

## Cómo leer el log

- `eqState` / `btcState`: `CALM` · `WATCH` · `CONFIRM` · `NO_DATA` · `INSUFFICIENT_HISTORY`.
- `NO_DATA` nunca equivale a `CALM`: es una serie ausente (columna `missing`).
- `preregSha`: hash del preregistro vigente al escribir la fila. Si cambia, **no mezclar**
  las filas anteriores y posteriores para inferencia (preregistro §9).
- Cada ejecución descarga ~2 años de histórico, así que los z-scores (ventana de 252
  observaciones previas) están disponibles desde el primer día. `INSUFFICIENT_HISTORY`
  solo aparece si una fuente devuelve menos historia de la necesaria.

## Qué NO hace (todavía)

- No evalúa los criterios A1–A4 del preregistro §5: eso es la fase de histórico largo.
- No integra nada en el motor. La promoción exige un preregistro de integración propio.
- Skew de 25 delta de BTC, GEX y put/call quedan fuera de v1.0.0.
