# Plan de validación prospectiva de Olympus

## Alcance y veredicto

La serie histórica disponible no contiene valores punto-en-el-tiempo para todas las entradas de Olympus. Por eso no permite reconstruir una prueba retrospectiva de paridad completa. El walk-forward actual es diagnóstico con entradas parciales; sus resultados no se deben atribuir a la configuración completa.

Este plan separa dos evaluaciones:

1. **Variante observable retrospectiva:** solo se atribuyen resultados a entradas con serie histórica y fecha de disponibilidad verificables. Cada ventana debe publicar su manifiesto de datos, huecos, carry-forward, transformaciones y entradas neutralizadas. Una señal sin histórico no puede sustituirse por el valor actual, una constante o una reconstrucción retrospectiva.
2. **Configuración completa prospectiva:** empieza a generar evidencia desde el primer día en que se capturen fielmente todas las entradas y decisiones recibidas por el motor. Su evidencia empieza en esa fecha; no se retrotrae.

Hasta completar los criterios de aceptación de la configuración evaluada, su estado es **NO APTO para producción**. Un resultado de la variante observable nunca cambia por sí solo el veredicto de la configuración completa.

## Protocolo prospectivo

### Registro por decisión

Cada ejecución debe persistir un registro inmutable y ordenado con:

- `captured_at` UTC y `available_at` de cada dato, además de `as_of`/fecha de observación cuando sean distintos.
- Precio, fuente, ticker/unidad, moneda, fecha del proveedor, hora de descarga y regla de ajuste para cada activo y benchmark.
- Valor exacto de todas las entradas consumidas por el motor, incluidas entradas manuales, indicadores calculados y sus parámetros/ventanas; un valor ausente se registra como ausente, nunca se rellena silenciosamente.
- Entradas macro y de ciclo, indicadores de calidad (stale, fallback, bloqueado), valores antes y después de cualquier normalización.
- Ponderaciones antes/después, efectivo, NAV, operaciones, costes/tarifas/slippage, benchmark, versiones de código/configuración y razón de disparo.
- Hash del contenido canónico y enlace al registro anterior. El servidor debe rechazar UPDATE/DELETE y verificar la cadena; una copia en `localStorage` sirve solo como cola temporal, no como archivo oficial.

La decisión de fecha `t` solo puede leer datos cuyo `available_at <= decision_timestamp`. Los precios de ejecución deben seguir la convención de ejecución declarada por el backtest. No se admitirán series retrospectivamente revisadas sin conservar la vintage recibida originalmente.

### Cadencia y período

- Capturar en cada decisión del motor y también en cada rebalanceo/operación, no solo una vez al día.
- Reconciliar diariamente el NAV del libro contra cash + posiciones y guardar un cierre del día.
- Mantener al menos 36 meses de observación prospectiva y 3 ventanas OOS consecutivas de 12 meses; si la estrategia rebalancea con menor frecuencia o el ciclo objetivo es más largo, extender el período hasta incluir al menos 20 rebalanceos y tres ventanas completas.
- Congelar por adelantado los parámetros, costes, benchmark, universo, ventanas y tolerancias. Cualquier cambio material reinicia el conteo para la configuración nueva.

## Criterios cuantitativos de aceptación

Son controles mínimos de integridad, no una promesa de rentabilidad. Antes de declarar aptitud, el responsable de riesgo debe fijar por escrito el benchmark investible, presupuesto de drawdown, volatilidad máxima y umbral de rendimiento neto requerido.

1. **Integridad de datos:** 100% de decisiones con versión, timestamp, fuente y entradas completas; cero datos utilizados antes de `available_at`; cero fallbacks no declarados. Cualquier incumplimiento invalida la ventana afectada.
2. **Integridad del registro:** 100% de hashes y enlaces de cadena válidos; cero pérdidas de registros pendientes; reconciliación de conteos entre aplicación y almacén servidor.
3. **Contabilidad:** error absoluto diario entre NAV reconstruido y NAV contabilizado ≤ 0,01 unidades monetarias por cada 10.000 de capital inicial; error de reconciliación de operaciones y costes ≤ 1 punto básico de NAV. Retornos diarios netos deben reconstruir el NAV dentro de esa misma tolerancia.
4. **Riesgo y benchmark:** métricas calculadas exclusivamente con retornos netos de costes y un benchmark con calendario/fuente explícitos; reportar Sharpe, Sortino, volatilidad, máximo drawdown, Calmar, alpha/beta, turnover y exposición/efectivo en cada ventana.
5. **Evidencia OOS:** tres ventanas consecutivas que satisfagan el período mínimo. Reportar intervalos de confianza y sensibilidad a costes; ninguna ventana se elimina por mal resultado. La aptitud requiere además que las métricas respeten los límites de riesgo y retorno fijados antes de observar esos resultados.
6. **Control de cambios:** hash del commit/configuración por decisión; tras cambio de motor, señales o parámetros, abrir una cohorte nueva y no mezclarla con la anterior.

## Estado de la infraestructura existente

El repositorio ya tiene `decisionRecord.ts` y `decisionLog.ts` con canonicalización, hash encadenado y cola local con sincronización a una Edge Function. La sombra CORE vs v5.3 conserva además un resumen diario de divergencias en `localStorage`. En este clon, el payload encadenado ahora incluye la versión, régimen, exposición y asignaciones completas de `coreShadow`; esa instrumentación solo tendrá efecto en Olympus cuando se publique y despliegue el cambio. Antes de usarlo como evidencia prospectiva deben verificarse en el entorno desplegado la cobertura de todas las entradas reales (incluidas señales de ciclo y timestamps de disponibilidad), la política append-only efectiva, alertas de cola pendiente, retención/backup y reconciliación de registros.

## Próximos pasos

1. Fijar con Riesgo benchmark investible, límites de volatilidad/drawdown y objetivo neto de retorno.
2. Auditar los campos que realmente se envían a `logEngineDecision` en cada ruta de producción y cerrar huecos de procedencia/`available_at`.
3. Verificar esquema, permisos append-only, backup, retención, alertas y cadena de hashes en el almacén remoto sin alterar datos existentes.
4. Mantener CORE/v5.3 shadow activo. Desplegar la instrumentación local de `coreShadow` en el registro encadenado y verificar en el almacén remoto que cada fila incluye las asignaciones candidatas. La sombra compara pesos; para evaluar retorno neto aún hay que construir/reconciliar el NAV sombra y sus costes frente a precios ejecutables. No tratar el resumen de divergencias como un track record de rendimiento.
5. Publicar cada mes el manifiesto de cobertura, reconciliación NAV y estado de incidencias; al final de cada ventana, calcular métricas netas y decidir contra criterios congelados.
6. Mantener la configuración completa como NO APTO hasta pasar todas las ventanas y controles. Evaluar la variante observable por separado, con nombre/configuración propia.
