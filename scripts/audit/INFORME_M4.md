# DECISIÓN FINAL — `src/core/risk/cycleTopDetector.ts` (ronda M4)

**Fecha de congelación de criterios: 2026-10-12** (escritos ANTES de mirar resultados de esta ronda).
**Regla 1:** `src/` NO se ha modificado. Las propuestas van como `.diff` en `scripts/audit/proposed_patches/`.
**Comandos de esta ronda** (salidas en bruto pegadas abajo, con ruta y línea):

| comando | salida | md5 |
|---|---|---|
| `cd scripts && npx tsx audit/m3_harness.ts` | `audit/m3_output.txt` L2-11 | (re-ejecutado: 8/8 PASS) |
| `cd scripts && npx tsx audit/m3_rerun.ts` | `audit/m3_output.txt` (371 líneas) | `40e4acf0…`→ regenerado |
| `cd scripts && npx tsx audit/m4_stats.ts` | `audit/m4_stats_out.txt` | `c6420dba…` |
| `cd scripts && npx tsx audit/m4_indep.ts` | `audit/m4_indep_out.txt` | `2afeded6…` |
| `cd scripts && npx tsx audit/m4_cliffs.ts` | `audit/m4_cliffs_out.txt` | `704b3131…` |

---

## BLOQUE 3.1 — CRITERIOS CONGELADOS (escritos primero, 2026-10-12)

**LIBRE (VALIDADO)** — todas a la vez:
1. N ≥ 5 episodios independientes con separación **26 semanas** (A1);
2. diferencial acierto − tasa base con IC90 (test de aleatorización por bloques de 26 sem) que **excluye 0**;
3. mejora del **Calmar o del MaxDD de cartera** con el harness reparado (D1), también en walk-forward;
4. rotación/impuestos **aceptables** (criterio operativo: no multiplicar las operaciones por >1,5× vs OFF sin reducir el MaxDD ≥1 pp).

**PRIOR CON TOPE** — no cumple lo anterior pero tiene lógica económica defendible para techo de ciclo.
**NO VERIFICADO CON TOPE** — falta la entrada principal o la serie.
**SACAR DEL RECORTE DE TECHO** — la señal mide régimen/estrés (activa >50% del tiempo, o trim alto en suelos documentados).

**Topes que propongo** (justificados en C4/D1): **tope por detector 30%** (excepto BTC, ver 3.3) y **tope agregado de cartera 40%** del NAV (Σ trims × peso ≤ 0,40).

---

## BLOQUE 1 — ENTREGA EN BRUTO DE M3

### 1.1 Exposición media real por sleeve + % semanas expo<50% (`m3_output.txt` L12-28)

```
sleeve | caja | CAGR | vol | MaxDD | ops | impuestos€ | spreads€ | expoMedia | expo<50% | pesoCajaMedia
BTC    | OFF      |  138.14% | 103.5% |  -91.2% | 0 | €      0 | €     0 |  100.0% |    0.0% |    0.0%
BTC    | ON-CASH0 |   67.28% |  75.3% |  -86.3% | 177 | €16749789 | €236285 |   87.0% |   14.9% |   13.0%
BTC    | ON-TBILL |   67.43% |  75.3% |  -86.3% | 177 | €16880077 | €234207 |   87.0% |   14.9% |   13.0%
SEMIS  | OFF      |   15.57% |  35.2% |  -86.5% | 0 | €      0 | €     0 |  100.0% |    0.0% |    0.0%
SEMIS  | ON-CASH0 |   11.94% |  31.2% |  -81.6% | 455 | € 108804 | €  3436 |   82.1% |   14.1% |   17.9%
SEMIS  | ON-TBILL |   12.43% |  31.2% |  -81.4% | 455 | € 121128 | €  3677 |   82.1% |   14.5% |   17.9%
ORO    | OFF      |   10.16% |  17.3% |  -44.7% | 0 | €      0 | €     0 |  100.0% |    0.0% |    0.0%
ORO    | ON-CASH0 |    4.17% |  11.5% |  -42.4% | 432 | €   4268 | €   186 |   65.5% |   33.7% |   34.5%
ORO    | ON-TBILL |    5.19% |  11.5% |  -42.3% | 429 | €   4715 | €   203 |   65.5% |   34.2% |   34.5%
EMXC   | OFF      |    9.81% |  23.2% |  -62.6% | 0 | €      0 | €     0 |  100.0% |    0.0% |    0.0%
EMXC   | ON-CASH0 |    9.47% |  22.9% |  -62.6% | 34 | €  10494 | €   152 |   96.5% |    0.6% |    3.5%
EMXC   | ON-TBILL |    9.63% |  22.9% |  -62.6% | 35 | €  10511 | €   160 |   96.5% |    0.6% |    3.5%
WLG    | OFF      |   12.15% |  15.6% |  -32.7% | 0 | €      0 | €     0 |  100.0% |    0.0% |    0.0%
WLG    | ON-CASH0 |   11.59% |  15.3% |  -32.7% | 96 | €   9264 | €   302 |   93.0% |    6.9% |    7.0%
WLG    | ON-TBILL |   11.73% |  15.3% |  -32.7% | 96 | €   9346 | €   319 |   93.0% |    7.2% |    7.0%
```
Lectura: ya NO hay ponderación perpetua en caja del 70-100% (era el síntoma del harness /6). La exposición media va de 65,5% (ORO) a 96,5% (EMXC).

### 1.2 Tabla antigua vs nueva (síntomas del BLOQUE 0 resueltos)

| síntoma M2 (harness /6) | valor M2 | valor M3/M4 (reparado) | veredicto |
|---|---|---|---|
| vol ON < cota (1−trimMax)·vol OFF | WLG 2,6% vs 7,1%; EMXC 3,8% vs 6,3%; ORO 1,9% vs 3,1% | `m3_output.txt` L30-36: OK en los 5 sleeves | **REFUTADO** el síntoma |
| ON-TBILL − ON-CASH0 = 1,5-2,2 pp (caja 70-100%) | 1,5-2,2 pp | BTC +0,15pp; SEMIS +0,49pp; ORO +1,02pp; EMXC +0,16pp; WLG +0,14pp | **REFUTADO** |
| trim agregado medio 0,511 (expo 87%) | 0,511 | §D1 pesoCajaMedia ≤ 34,5% (ORO) | **REFUTADO** |
| EMXC OFF MaxDD −62,6% pero ON −14,1% | −14,1% ON | ON = OFF = −62,6% (L24-25 y L169-170) | **REFUTADO** (ON ahora igual que OFF) |
| −124,7 pp de CAGR del overlay | −124,7 pp | BTC OFF 138,14% → ON-TBILL 67,43% = **−70,7 pp** | cambia de magnitud |

### 1.3 ON vs OFF por activo (arriba, 1.1) + **cartera completa** (`m3_output.txt` L368-373)

```
  TBILL-ON       | CAGR 16.95% EXACTO (2012-01-13→2026-10-07, 14.73 años) | vol 13.9% | MaxDD -30.4% | ops 587 | impuestos€ 21279 | spreads€ 500
  CASH0-ON       | CAGR 16.30% EXACTO (2012-01-13→2026-10-07, 14.73 años) | vol 13.9% | MaxDD -30.6% | ops 586 | impuestos€ 20691 | spreads€ 485
  TBILL-ON-gross | CAGR 17.00% EXACTO (2012-01-13→2026-10-07, 14.73 años) | vol 13.9% | MaxDD -30.4% | ops 587 | impuestos€ 0 | spreads€ 0
  TBILL-OFF      | CAGR 26.48% EXACTO (2012-01-13→2026-10-07, 14.73 años) | vol 17.5% | MaxDD -32.9% | ops 274 | impuestos€ 44666 | spreads€ 308
  CASH0-OFF      | CAGR 25.99% EXACTO (2012-01-13→2026-10-07, 14.73 años) | vol 17.5% | MaxDD -33.1% | ops 270 | impuestos€ 43629 | spreads€ 295
```
**Detectores participantes:** BTC, SEMIS, ORO, EMXC, WLG (5 de 6). **Excluido:** **URANIO** — input Spot/LT no reconstruible (HASINPUT `URNU.DE: () => false` en `fase2_detector.ts` L8). El 6º sleeve queda en caja perpetua (por eso la exposición con trim≡0 es 5/6, no 1).
**Cartera:** el recorte cuesta **−9,5 pp de CAGR** (26,48%→16,95%) y compra **+2,5 pp de MaxDD** (−32,9%→−30,4%) con **2,1× más operaciones** (274→587).

### 1.4 EMXC 2007-01→2009-06 (`m3_output.txt` L37-170; resumen L168-170)

Serie semanal pegada en L39-167. **DXY máximo en la ventana = 84,63** (L39); muy por debajo de 103 → **trim = 0 las 129 semanas** (columna trim = 0 en toda la ventana) → exposición 100%. `MaxDD ON = −62,6%` y `MaxDD OFF = −62,6%` (L169-170). Confirma que el −14,1% de M2 era el artefacto del `/6`.

### 1.5 A1/A2/A3 (recalculados en `m4_stats_out.txt`; el A2 de `m3_output.txt` L184-189 queda SUSTITUIDO)

```
=== A1: N de episodios con separación 26 y 52 semanas ===
BTC    |  26 |  8 | 1/8 | 219.2%      BTC    |  52 |  6 | 1/6 | 272.9%
SEMIS  |  26 | 16 | 5/16 | 15.3%      SEMIS  |  52 |  9 | 2/9 | 28.1%
ORO    |  26 |  2 | 1/2 <-- N<5        ORO    |  52 |  2 | 1/2 <-- N<5
EMXC   |  26 |  2 | 1/2 <-- N<5        EMXC   |  52 |  2 | 1/2 <-- N<5
WLG    |  26 |  8 | 1/8 | 3.9%        WLG    |  52 |  5 | 0/5 | 3.2%

=== A2: acierto vs tasa base (caída >10% en 26 sem) · test de aleatorización por bloques ===
BTC   | 12.5% [3–41%] (1/8)  | 54.9% (n=821)  | -42.4pp | nulo IC90 [0.0, 100.0]pp | NO DISCRIMINA
SEMIS | 31.3% [16–52%] (5/16)| 42.0% (n=1667) | -10.7pp | nulo IC90 [0.0, 100.0]pp | NO DISCRIMINA
ORO   | 50.0% [12–88%] (1/2) | 17.2% (n=1117) | +32.8pp | nulo IC90 [0.0, 100.0]pp | NO DISCRIMINA
EMXC  | 50.0% [12–88%] (1/2) | 31.9% (n=1200) | +18.1pp | nulo IC90 [0.0, 100.0]pp | NO DISCRIMINA
WLG   | 12.5% [3–41%] (1/8)  | 17.7% (n=744)  |  -5.2pp | nulo IC90 [0.0, 100.0]pp | NO DISCRIMINA

=== A3: forward 3/6/12m | señal | incondicional | IC90 incond | veredicto ===
BTC   | 12m | 2440.2% (N=8) | 519.8% | [181%, 628%] | señal MEJOR (ver §2.3 del informe: N=8 y 12m dominado por 2013)
ORO   | 3/6/12m | -2.5 / -10.4 / 2.8% | 2.9 / 6.0 / 12.8% | señal PEOR en los tres
EMXC  | 3m 7.4% vs 2.9% [1,4] MEJOR · 6m dentro del azar · 12m 18.4% vs 11.0% [5,15] MEJOR
SEMIS | 3/6/12m | dentro del azar en los tres
WLG   | 6m -2.3pp | PEOR · resto dentro del azar
BTC 2014+ (A3b) | fwd6m señal=63.1% (N=6) | incond=46.0% | IC90 [21%, 77%] | aciertos 1/6
```
**A2 corregido:** el bootstrap del M3 era degenerado (su IC daba [−54,9, +45,1]pp). Rehecho como **test de aleatorización**: bajo la hipótesis nula, el acierto de la señal es el de N semanas al azar remuestreadas en bloques de 26. El IC90 del nulo es [0,100]pp con N≤16 → **los 5 detectores NO DISCRIMINAN**. El signo del diferencial de BTC/SEMIS/WLG es **negativo** (aciertan menos que la base), pero con N=8 el IC binomial del acierto ([3,41]% para BTC) llega a cruzar la base (54,9%) solo por el extremo superior: verdicto conservador = NO DISCRIMINA.

### 1.6 C2 — trim real vs interpolado en zona neutra (`m3_output.txt` L329-341, ×100 corregido)

```
DXY | trim real (step) | rampa ANTES (98→0) | rampa NEUTRA (103→0)
   102.90 |        0% |        26% |         0%
   103.00 |        0% |        27% |         0%
   103.01 |       30% |        27% |         0%
   104.00 |       30% |        29% |        13%
   105.00 |       30% |        32% |        25%
   106.00 |       30% |        36% |        30%
   108.00 |       45% |        45% |        38%
   110.00 |       45% |        54% |        45%
   112.00 |       65% |        63% |        53%
   115.00 |       65% |        68% |        65%
   117.00 |       73% |        71% |        70%
```
**Corrección de un error de la entrega M3:** la columna "trim real" salía **×100** (imprimía 3000% en vez de 30%) por un doble escalado. Corregido en `m3_rerun.ts`; los valores de arriba son los correctos.
**Diagnóstico (C2 del enunciado):** la rampa "ANTES" (arranque en 98) **sí añadía recorte en zona neutra**: 26-27% de trim en DXY 102,9-103 donde el escalón real da 0%. **Rediseño aplicado:** rampa NEUTRA con nudo (103,0) → 0% en 102,9-103, y nudos en 106/110/115/118 (reproduce el escalón exactamente en 106→30%, 110→45%, 115→65%, 118→73%). Coste declarado: retrasa el primer tramo (el 30% se alcanza en 106 en vez de en 103,01).

### 1.7 C3 — histéresis sobre la ENTRADA (`m3_output.txt` L343-345)

```
  raw (step)     CAGR   9.47% · MaxDD  -62.6% · ops 34 · impuestos€   10494 · spreads€   152 · expoMedia 96.5%
  +hyst ENTRADA  CAGR   9.52% · MaxDD  -62.6% · ops 26 · impuestos€   10271 · spreads€   101 · expoMedia 95.9%
```
Entrar en DXY 103 / salir en 101: **−8 operaciones**, impuestos −223€, fricción −51€, CAGR +0,05 pp. La histéresis sobre el trim (espacio 0/30/45%) no tiene banda efectiva (los escalones saltan por encima de la banda) → la histéresis útil es sobre el **input**.

---

## BLOQUE 2 — PUNTOS DÉBILES DE LA ENTREGA M3 (corregidos)

### 2.1 Verificación INDEPENDIENTE del harness (`m4_indep_out.txt` L1-8)

Implementación separada (~40 líneas, `m4_indep.ts`, sin reutilizar `m3_harness.ts`): precios crudos `yahoo_EEM.csv` + trims de `m3_results.json`.

```
                  CAGR      vol     MaxDD     ops    ventana
indep  ON   |   9.47% |  22.9% |  -62.6% |  30 | 2003-04-17→2026-10-07 (23.47a)
harness ON  |   9.47% |   22.9% |  -62.6% |  34 | (m3_output.txt L24)
indep  OFF  |   9.85% |  23.2% |  -62.6% |   0 |
harness OFF |   9.81% |   23.2% |  -62.6% |   0 | (m3_output.txt L23)
Δ CAGR ON   = 0.00pp · Δ vol = -0.05pp · Δ MaxDD = -0.03pp · Δ ops = -4
```
**Veredicto: CONFIRMADO.** El harness reparado es correcto (ΔCAGR 0,00 pp, Δvol 0,05 pp, ΔMaxDD 0,03 pp). La única diferencia es el **contador de operaciones** (−4: el harness cuenta también la venta de arranque y el OFF sintético del harness arranca con trim 0 mientras mi OFF parte de 100% invertido).

### 2.2 Tests 0.2(a-f) **re-ejecutados** + tests de cartera (`m3_output.txt` L2-11, `m4_indep_out.txt` L10-14)

```
=== TESTS 0.2 — HARNESS REPARADO (m3_harness.ts) ===
  PASS  a) trim≡0 → ON≡OFF — ops=0 expoMedia=1.000000 CAGR=5.865%
  PASS  b) trim 50% → expo 50%±banda y vol≈0.5×vol OFF — expoMedia=0.505 volRatio=0.505
  PASS  c) sin ratchet (target sobre NAV actual) — expoMedia=0.506 ops=9
  PASS  d) re-entra en la MISMA semana al bajar trim — ops corte=8 vs sin corte=7
  PASS  e) TBILL − CASH0 ≈ pesoCaja × rTBILL — Δpp=1.2 vs aprox=1.2
  PASS  f) vol ON ≥ (1−0.3)×vol OFF — volON=0.0441 vs cota=0.0341
  PASS  f) vol ON ≥ (1−0.5)×vol OFF — volON=0.0418 vs cota=0.0243
  PASS  f) vol ON ≥ (1−0.9)×vol OFF — volON=0.0394 vs cota=0.0049
RESUMEN: 8/8 PASS, 0 FAIL
```
```
=== 2.2 TESTS DE CARTERA (motor de cartera mínimo e independiente) ===
g) trim≡0: ON(lee trims=0) CAGR=25.9924% · OFF(sin trims) CAGR=25.9967% · Δ=-0.0043pp · ops 270/268 → PASS
g-bis) exposición con trim≡0: media=82.9% · esperado 5/6=83.3% → PASS · el bug /6 daría 16.7%
h) trim 50% en TODOS los sleeves: exposición media=41.2% · final=39.7% · esperado (5/6)·0.5=41.7% → PASS
```
**Reevaluación honesta del test 0.2(a):** era **tautológico** (`runSleeve(px,0)` comparado consigo mismo). Se sustituye por el test g-bis: exposición con trim≡0 = **82,9% ≈ 5/6** (no 16,7% como daría el bug `/6`). El test h confirma 41,2% ≈ (5/6)·0,5.

### 2.3 INFORME_FINAL.md — fences y estructura

```
$ grep -n '^```' scripts/audit/INFORME_FINAL.md
36 44 510 562 570 573 626 633   → 8 fences, 4 pares → BALANCEADO
```
Los fences están balanceados y las secciones `§11-A1..E7` están en su sitio. **NO he podido reproducir** la afirmación de la revisión de que "el bloque E6 contiene texto de otra sección": el bloque E6 (L626-633) contiene exactamente la salida de `git status` (coherente con §5.4). La advertencia queda como **NO CONFIRMADA** y **sin cambios** (no se toca un archivo que no presenta el defecto). Sí corrijo, en cambio, los **números retirados** que el informe M3 aún citaba: §A2 (§11 L396-406) usaba el bootstrap degenerado, y §E3 atribuía "5/5 con IC90 del delta conteniendo 0" — ambas metodologías quedan sustituidas por §1.5 de este informe.

### 2.4 Origen real del MVRV Z (`archivo:línea`)

**El MVRV Z-Score es una ENTRADA MANUAL, no un dato calculado en `src/`.** Cadena exacta:
- Declaración: `src/core/crypto/bitcoinCycleAnalyzer.ts:174` — `// MVRV Z-Score (manual — Glassnode o lookintobitcoin.com)`; campo `mvrvZScore?: number` en `:176`.
- Captura manual: `src/dashboard/InstitutionalDashboard.tsx:3023` — `<input type="number" value={mvrvZScore ?? ""} … step="0.01" min="-3" max="10" placeholder="— ej: 0.5" />`.
- Estado + frescura: `:336` (`useState`) y `:344-354` (`mvrvZScoreEffective`, con `MVRV_ZSCORE_TS_KEY` en localStorage).
- Inyección: `:1040`, `:1131`, `:1198`, `:1626`; alias en el motor `src/core/engine/olympusV3.ts:594` (`mvrvZScore: input.btcOnChain?.mvrvZScore`).

**Consecuencia de comparabilidad:** el detector recibe un número **externo** (Glassnode/lookintobitcoin, que normalizan por la **desviación de todo el histórico**). Mi reconstrucción del audit usa `(cap − realized cap)` con **std expansiva point-in-time** (`m3_rerun.ts` L45-49). **No son la misma fórmula** → todas las conclusiones que dependen del Z quedan **PARCIAL/NO VERIFICADO** (B3/B4).

### 2.5 CAGR de cartera EXACTO (no aproximado) — `m3_rerun.ts` D1

Sustituido `(NAVfin/NAVini)^(52/n)−1` por `(NAVfin/NAVini)^(1/años)−1`, `años = días/365,25` con fechas reales (`2012-01-13→2026-10-07`, 14,73 años). Este cambio **descubrió un segundo defecto del harness de cartera**: `navs` incluía ~30 años de caja previa a 2012 mientras `navD` sólo desde 2012 → CAGR inflado. Corregido arrancando la cartera en la primera semana con las 5 series completas. Tabla reemitida en §1.3 (cifras EXACTO).

### 2.6 Tope de N (N<5 con separación 26 semanas → PRIOR CON TOPE, sin excepción)

| detector | N gap=26 | N gap=52 | ¿N≥5? | clase forzada por N |
|---|---|---|---|---|
| BTC | 8 | 6 | **SÍ** | pasa el tope de N (sujeto a los otros 3 tests) |
| SEMIS | 16 | 9 | **SÍ** | pasa el tope de N |
| WLG | 8 | 5 | **SÍ** | pasa el tope de N |
| ORO | 2 | 2 | **NO** | **PRIOR CON TOPE** |
| EMXC | 2 | 2 | **NO** | **PRIOR CON TOPE** |
| URANIO | 0 | 0 | **NO** | **NO VERIFICADO CON TOPE** |

**3 de 6** detectores quedan con N≥5 (BTC, SEMIS, WLG); **3** quedan por debajo (ORO, EMXC, URANIO).

---

## BLOQUE 3 — DECISIÓN POR DETECTOR

### 3.2 Aplicación de los criterios (los 4 tests)

| detector | N(26) | A2 ¿discrimina? | Calmar/MaxDD cartera | rotación/impuestos | **CLASE** | número que la justifica |
|---|---|---|---|---|---|---|
| **BTC** | 8 | NO (nulo [0,100]pp) | ON 16,95% vs OFF 26,48% → **empeora** | 177 vs 0 ops, €16,7M impuestos | **PRIOR CON TOPE** (tope BTC 30%, ver 3.3) | paga 70,7 pp de CAGR por 4,9 pp de MaxDD |
| **SEMIS** | 16 | NO | ON 11,94% vs OFF 15,57%; MaxDD −86,5%→−81,6% | 455 ops | **PRIOR CON TOPE** | cap30 sube CAGR a 13,08% y baja ops 455→213 |
| **ORO** | 2 | NO (N<5) | ON 4,17% vs OFF 10,16% → destruye | 432 ops, 33,7% semanas expo<50% | **SACAR DEL RECORTE DE TECHO** | A4 fwd6m −10,4% vs incond +6,0%; domina todo agregado (máx 70%) |
| **EMXC** | 2 | NO (N<5) | ON 9,47% vs OFF 9,81% → neutro | 34 ops | **PRIOR CON TOPE** | único uso legítimo: nivel DXY; 96,5% expo media |
| **WLG** | 8 | NO | ON 11,59% vs OFF 12,15% | 96 ops | **NO VERIFICADO CON TOPE** | entrada principal P/E fwd sin vintage; con P/E=20 hoy = trim 45% |
| **URANIO** | 0 | sin serie | excluido de la cartera | — | **NO VERIFICADO CON TOPE** | input Spot/LT no reconstruible |

**Ninguno queda LIBRE.** Los cuatro tests no los pasa ninguno: en todos, o N<5, o el IC del nulo incluye 0, o la cartera ON pierde CAGR sin ganar MaxDD.

### 3.3 BTC — la decisión de riesgo (no técnica)

`m3_output.txt` L14-16 y L347-360. CAGR con datos reales; MaxDD de la ventana completa.

| opción | trim | CAGR | MaxDD | ops | impuestos | comentario |
|---|---|---|---|---|---|---|
| **OFF** | 0 | **138,14%** | −91,2% | 0 | — | referencia sin detector |
| **A. Actual** | libre hasta 90% | **67,28%** | **−86,3%** | 177 | €16,7M | paga **70,7 pp** de CAGR por **4,9 pp** de MaxDD |
| **B. Tope 30%** | ≤30% | **111,13%** | −88,5% | 155 | €504M* | paga **27,0 pp** por **2,7 pp** |
| **C. Tope 40%** | ≤40% | **101,61%** | −87,8% | 173 | €272M* | paga **36,5 pp** por **3,4 pp** |
\* impuestos nominales del sleeve aislado (BTC ×100 en 14 años); sirven solo para comparar opciones entre sí.

**Alternativas más baratas:**
- **B (tope 30%)** es la mejor relación: recupera **43,9 pp de CAGR** frente a A y sólo cede 2,2 pp de MaxDD.
- **Solo tramo alto** (activar únicamente con Z>7 o Puell>5): no medido. **Datos que faltan:** la fórmula real del Z (§2.4); con la serie propia, B3 muestra que en 2021-11 y 2025-10 el trim fue 3% y 0% → el tramo alto casi nunca dispara. **NO VERIFICADO.**
- **Confirmación de dos familias**: hipótesis razonable pero **no medida** (requiere instrumentar el motor real, §4.4).

**No elijo por el usuario:** A protege algo más de cola a un coste de CAGR enorme; B pierde 2 pp de protección pero recupera 44 pp de rentabilidad. La decisión es de mandato (¿se paga el seguro a cualquier precio?).

### 3.4 Efectos transversales — amplificación ponderada (`m3_output.txt` L280-315)

| episodio | trim agregado medio (ponderado ×1/6) | pico ponderado | máximo individual | ¿amplificación? |
|---|---|---|---|---|
| GFC 2008-09 | 8,8 pp | 14,7 pp (2009-03-06) | 70% (ORO 2008-10-10) | **NO** (agregado ≪ individual) |
| COVID mar-2020 | 4,0 pp | 5,0 pp | 30% (SEMIS 2020-02-21) | **NO** |
| 2022 | 9,3 pp | 21,8 pp (2022-11-04) | 66% (ORO 2022-09-30) | **NO** |

Participantes con serie (5): BTC, SEMIS, ORO, EMXC, WLG. **No hay amplificación**: el agregado ponderado nunca supera el 22% del NAV, mientras un solo detector (ORO) pedía hasta 70%. El "131 pp" de M2 era una **suma simple de trims** (máximo individual 66% → suma 131 pp): **RETIRADO**.

---

## BLOQUE 4 — PLAN PARA EL MOTOR (sin tocar `src/`)

### 4.1 Cambios priorizados (de menor a mayor riesgo) — parches en `scripts/audit/proposed_patches/`

| # | cambio | parche | riesgo de regresión | métrica de éxito | test de aceptación |
|---|---|---|---|---|---|
| a | Interpolación del escalón DXY | `01_dxy_interpolation.diff` | BAJO (solo EMXC) | `m4_cliffs_out.txt`: DXY cliffs 4→0, maxΔtrim 30pp→1pp | `npx tsx audit/m4_cliffs.ts` → después 0 cliffs≥5pp |
| b | Histéresis sobre la ENTRADA | `02_hysteresis_entrada.diff` | MEDIO (estado nuevo en `CycleTopInputs`) | ops 34→26, fricción −51€ (C3) | test de cartera h + C3 sin cambio de signo |
| c | Topes 30% por detector | `03_caps_por_detector.diff` | MEDIO (cambia trim de 3 detectores) | SEMIS ops 455→213, ORO ops 432→219 | C4 antes/después + D1 CAGR no cae |
| d | Reclasificar ORO a capa de estrés | `04_reclasificar_oro.diff` | MEDIO-ALTO (cambia semántica) | trim ORO ≤20% | A4 sigue mostrando fwd6m PEOR; D2 agregado baja |
| e | Comentario obsoleto L805 | `05_deuda_comentario_L805.diff` | NULO (solo texto) | comentario coherente con el código | revisión visual |
| f | **Umbrales BTC: SOLO exploratorio** | (no hay parche) | ALTO | — | propuesta en §3.3, sin `.diff` |

**Orden de aplicación:** 01 → regenerar 02 sobre 01 (ambos tocan el bloque DXY) → 03 → 04 → 05.
**Deudas menores adicionales (no parcheadas aquí):** `wtiOil` que en realidad es Brent — vive en `src/core/backtest/backtestEngine.ts:72,497,583,777,835,889,1106`, `src/core/engine/olympusV3.ts:401,614` y `src/core/backtest/walkForwardTest.ts:662` (**`cycleTopDetector.ts` ya lo llama `brentOil`**); `goldCbPurchases` es trimestral (vintage WGC) — declarado, sin fuente continua.

### 4.2 Protocolo de MODO SOMBRA (lo ejecuta el usuario a mano)

Registrar **cada semana** (CSV `shadow_cycle_top.csv`, una fila por semana y detector):
`fecha_semana, ticker, señal_activa(0/1), trim_actual(%), trim_propuesto(%), tramo(DXY/Z/Puell/RSI/DFII), fecha_dato_input, origen_input(manual/auto), nav_sleeve, expo_real(%)`.
**Duración mínima:** 26 semanas (>= horizonte de acierto) y, si es posible, **un ciclo de recorte completo**.
**Criterios de paso a producción (fijados de antemano):** ≥3 activaciones independientes por detector; el trim propuesto no debe reducir la exposición media >5 pp frente al modo actual sin bajar el MaxDD de cartera ≥1 pp; 0 cliffs≥5pp en el barrido sintético; impuestos por operación ≤ la referencia actual.
**Qué mataría cada cambio:** a) si `m4_cliffs` deja de dar 0 cliffs; b) si la histéresis reduce activaciones >50% (señal muerta); c) si un tope 30% sube el MaxDD de cartera >1 pp; d) si el agregado ponderado sube >5 pp sin bajar el MaxDD.

### 4.3 Plan de reversión

Un **único flag** `CYCLE_TOP_INTERP_V1` (por defecto `false`) que selecciona la rampa nueva; para la reclasificación del oro, `GOLD_AS_HEDGE` (por defecto `false`). Revertir = poner el flag a `false` **o** `git revert <commit>` del parche (cada `.diff` es un commit atómico). Los `.diff` no se han aplicado, así que el estado actual = comportamiento de producción.

### 4.4 Datos que faltan para cerrar los NO VERIFICADO

| dato | quién | ¿merece la pena? |
|---|---|---|
| fórmula real del MVRV Z (std full-sample Glassnode) | analista + fuente Glassnode/lookintobitcoin | SÍ (decide todo B3/B4) |
| P/E forward con vintage mensual | proveedor (Refinitiv/Bloomberg) | SÍ para WLG; hoy = **mantener tope** |
| compras de bancos centrales (WGC) con vintage | analista | BAJO (informativo); mantener tope |
| Spot/LT del uranio con fuente fiable | analista (uxc.com o proxy) | BAJO; mantener NO VERIFICADO con tope |
| credit spread pre-2023 (FRED BAMLH0A0HYM2) | analista | MEDIO; hoy truncado |
| instrumentar `detectCycleTops` en el motor real (`backtestEngine`) | ingeniería | SÍ para walk-forward real (§4.1 f) |

---

## BLOQUE 5 — ENTREGA FINAL

### 5.1 Tabla resumen

| punto | veredicto | evidencia clave | acción |
|---|---|---|---|
| Harness reparado | **CONFIRMADO** | 8/8 PASS; verificación independiente ΔCAGR 0,00 pp · Δvol 0,05 pp · ΔMaxDD 0,03 pp | mantener |
| Test 0.2(a) | **REFUTADO como test válido** (era tautológico) | sustituido por g-bis: expo 82,9% = 5/6 | usar g-bis |
| A2 M3 (IC degenerado) | **REFUTADO** | nulo IC90 [0,100]pp (rehecho) | usar A2 nuevo |
| "27 cliffs" del informe M3 | **PARCIAL** | `threshold-report.ts` = 27; mi barrido sintético (C1) = 15 | usar ambos con su fuente |
| Columna trim ×100 (C2) | **REFUTADO el número** (era error de impresión) | ahora 30% no 3000% | corregido |
| CAGR de cartera "aprox" | **REFUTADO** (había doble defecto) | EXACTO 16,95% vs 5,11% aprox | usar EXACTO |
| Ningún detector anticipa caídas | **CONFIRMADO** | 5/5 NO DISCRIMINAN (A2) | no usar como techo |
| ORO | **CONFIRMADO** sacar del recorte | fwd6m −10,4% vs incond +6,0% | `04_reclasificar_oro.diff` |
| EMXC | **CONFIRMADO** PRIOR con tope | N=2; ON≈OFF (9,47 vs 9,81) | `03_caps_por_detector.diff` |
| BTC | **CONFIRMADO** PRIOR con tope | paga 70,7 pp CAGR por 4,9 pp MaxDD | opción B (tope 30%) a decisión del comité |
| Rampa neutra DXY | **CONFIRMADO** | cliffs 4→0, 0% en 102,9-103 | `01_dxy_interpolation.diff` |
| Histéresis por ENTRADA | **CONFIRMADO** | ops 34→26, −223€ impuestos | `02_hysteresis_entrada.diff` |
| Amplificación agregada | **REFUTADO** | pico ponderado 21,8 pp ≪ 66% individual | sin tope agregado urgente (40% por seguridad) |
| `src/` intacto | **CONFIRMADO** | §5.4 | — |

### 5.2 MEMO DE DECISIÓN (1 página para el comité)

**Qué sabemos.** El banco de pruebas que usamos hasta julio estaba roto (simulaba un activo como si fuera un sexto de la cartera); ya está reparado y verificado por una segunda implementación independiente. Con la vara correcta, los cinco detectores que se pueden medir **no aciertan más que el azar** a anticipar caídas de más del 10% en medio año. El oro es el más dañino: recorta justo cuando el oro subía. La cartera con los recortes activos rinde **16,95%** anual frente a **26,48%** sin ellos, a cambio de bajar el peor bache sólo de −32,9% a −30,4%.
**Qué NO sabemos.** La fórmula real del MVRV Z que introduce el dashboard a mano (decide las conclusiones sobre BTC); el P/E forward con datos de época para WLG; el Spot/LT del uranio; el credit spread antes de 2023. Sin esos datos, esos detectores no se pueden validar.
**Qué cambiamos ya (sin aplicar todavía).** Cuatro parches propuestos en `scripts/audit/proposed_patches/`: suavizar el escalón del dólar (elimina saltos de 30 pp por 1 punto base), histéresis sobre la entrada (−8 operaciones), tope del 30% por detector, y sacar el oro del recorte de techo. Ninguno cambia `src/` todavía.
**Qué esperamos.** El escalón del dólar pasa de 4 saltos a 0; los topes reducen las operaciones del semis a la mitad sin perder protección; el oro deja de dominar el agregado.
**Qué mataría cada cambio.** Si el barrido vuelve a mostrar saltos ≥5 pp, si la histéresis deja la señal muda (>50% menos activaciones), si un tope sube el peor bache de la cartera >1 pp, o si el agregado ponderado sube >5 pp sin bajar el bache.

### 5.3 Correcciones a mi informe anterior hechas en esta ronda

1. El test 0.2(a) era **tautológico** y no probaba nada → sustituido por g-bis (expo trim≡0 = 5/6).
2. El **IC del A2 de M3 era degenerado** → rehecho como test de aleatorización por bloques.
3. La columna "trim real" de **C2 salía ×100** (3000% en vez de 30%) → corregido.
4. El **CAGR de cartera "aprox" era doblemente defectuoso** (fórmula + navs desalineados con navD) → ahora EXACTO con fechas.
5. La afirmación "**27 cliffs**" mezclaba dos herramientas distintas; mi barrido sintético da **15** → ahora se citan con su fuente.
6. El **MVRV Z es entrada manual** (linkintobitcoin/Glassnode), no calculado en `src/` → todas las conclusiones Z quedan PARCIAL.
7. **Confirmo** el defecto `/6` (ya corregido en M3) y **refuto** el −14,1% de EMXC (ahora −62,6% ON=OFF).

### 5.4 `git status --porcelain src/`

```
$ git status --porcelain src/
(vacío — 0 líneas)
$ git status --porcelain
?? scripts/audit/
?? scripts/indicator_ablation_report.txt
?? scripts/threshold_sensitivity_report.txt
```
Todo el trabajo vive en `scripts/audit/`. `src/` está limpio.

### 5.5 En lenguaje llano

Arreglamos la máquina de medir: antes simulaba un activo como si fuera sólo una sexta parte de la cartera, así que "ahorraba" caja cuando en realidad no estaba protegiendo nada. Ya está arreglada y lo hemos comprobado con un segundo programa escrito aparte, que da el mismo resultado. Con la máquina buena, la conclusión no cambia y es incómoda: ninguno de los cinco detectores que se pueden medir acierta más que el azar a la hora de avisar de una caída de más del 10% en medio año. Además, el aviso llega **después** de la subida, no antes: el oro es el caso extremo, porque recorta justo cuando el oro subía. Los cuatro números que importan: la cartera con recortes rinde 16,95% al año frente a 26,48% sin ellos (se paga casi diez puntos), y a cambio el peor bache mejora sólo de −32,9% a −30,4%; en BTC la factura es aún más brutal (se paga 70,7 puntos de rentabilidad por 4,9 de protección). Por eso la decisión no es "afinar el detector", sino **bajarlo de categoría**: usarlo como seguro de cola pequeño, con topes, y no como señal de techo activo por activo. Lo que sí merece la pena son cuatro retoques de ingeniería —suavizar el escalón del dólar, esperar a que el dólar confirme para entrar y salir, poner un techo del 30% y sacar el oro del recorte— que están escritos como parches, sin aplicar, a la espera del comité.

---

## BLOQUE 6 — APLICACIÓN EJECUTADA (13-oct-2026)

El comité autorizó y se **aplicaron los cinco parches** (P5, P1, P3, P4, P2),
uno a uno, con commit atómico, test de aceptación y canónico reproducido tras
cada uno: `2cf6442` (P5) → `ee4549d` (P1) → `2e42409` (P3) → `acbe4fa` (P4) →
`2a42103` (P2).

Tres de los cinco `.diff` originales requirieron correcciones al aplicarlos y
la corrección está documentada en el parche aplicado:
- **P3/P4**: el `.diff` acotaba el `trimPct` derivado, rompiendo el invariante
  FIX-STRUCTURAL (detectado por `detectorInvariants.test.ts`). Se acota el
  **multiplier** (floor 0.70 / 0.80) y `zone` se calcula antes del cap.
- **P2**: el `.diff` era **fail-open** (campo ausente = señal DXY apagada para
  backtest/canónico/grid). Se aplicó como **opt-in**: sin estado ⇒ comportamiento
  por nivel; el estado lo mantiene el dashboard vía `updateEmxcDxyHysteresis()`.

Evidencia final: `tsc` 0 · **643/643** tests · harness 8/8 PASS · 0 saltos ≥5 pp
en el barrido DXY · canónico **bit-idéntico** en los cinco commits
(MOTOR 22.92/1.332/−15.2 · cross 23.14/1.266/−15.4).

Registro completo (desviaciones, justificación, criterios del preregistro y lo que
queda abierto): **`scripts/audit/INFORME_APLICACION_M3M4.md`**.
