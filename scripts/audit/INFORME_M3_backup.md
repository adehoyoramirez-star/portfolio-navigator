# Auditoría adversarial — `src/core/risk/cycleTopDetector.ts`
**Auditor cuantitativo · comité de inversión · 2026-10-08**

**RONDA M3 (2026-10-12): el harness ON/OFF de la ronda M1/M2 estaba roto y ha sido REPARADO y validado con tests unitarios (8/8 PASS en `m3_harness.ts`). TODA cifra ON vs OFF anterior está RETIRADA y sustituida por las de `m3_output.txt`. El defecto, la corrección y el impacto completo se documentan en la §1bis.**

> Reglas del ejercicio: **0 líneas de `src/` modificadas**. Todo el trabajo vive en
> `scripts/audit/`. Los veredictos se emiten con números y sólo con números. Los datos
> reconstruidos con metodología propia se marcan como tales; un `NaN` **no** es prueba de
> ausencia. Baseline congelado: `ENGINE_VERSION v5.4.6`, `npx tsc --noEmit` = 0 errores,
> `npx vitest run` = 586/586.

**Artefactos producidos**
- `scripts/audit/fase0_realcode.ts` → tabla real score→multiplier→trim→zone y DXY→EMXC.
- `scripts/audit/fase1_data.ts` + `scripts/audit/data/` (16 CSV + `README.md`, 2026-10-08T11:19Z).
- `scripts/audit/fase2_detector.ts` → `fase2_output.txt` / `fase2_series.json`.
- `scripts/audit/fase3_design.ts` → `fase3_output.txt` / `fase3_results.json`.

---

## 1bis. RONDA M3 — HARNESS REPARADO (BLOQUE 0) ⚠️ RETIRA TODO LO ANTERIOR

### Defecto localizado (archivo:línea)
- `scripts/audit/fase2_detector.ts` L270: `const target = (nav / 6) * (1 - trim);`
- `scripts/audit/fase3_design.ts` L91: idéntico.
- El `nav/6` es la regla de CARTERA (6 sleeves equal-weight) aplicada a un backtest de UN solo activo: el "sleeve" no podía superar 1/6 del NAV en su activo y la caja se tragaba ~85-100%. Eso explica los tres síntomas exactos señalados por la revisión:
  - vol ON «demasiado baja» (WLG 2.6% vs cota 7.1%): el sleeve nunca tuvo más del ~17% de exposición;
  - Δ(ON-TBILL − ON-CASH0) = 1.5-2.2pp: con ~83% del NAV en caja permanente, el T-bill sobre 83% genera ese Δ;
  - oro 1.9% vol: lo mismo.

### Corrección
- **Por-sleeve**: target = (1 − trim) × NAV COMPLETO (sleeve aislado).
- **Cartera (D1)**: cada sleeve target = NAV × (1/6) × (1 − trim_s) — la regla correcta del motor.
- Motor con banda no-trade 2% NAV, re-entrada en la misma semana, impuesto 26% y spread 5bp igual que antes.

### Tests unitarios 0.2 (a–f) — `m3_harness.ts`, salida PEGADA (líneas 2-11 de `m3_output.txt`)
```
  PASS  a) trim≡0 → ON≡OFF — ops=0 expoMedia=1.000000
  PASS  b) trim 50% → expo 50%±banda y vol≈0.5×vol OFF — expoMedia=0.505 volRatio=0.505
  PASS  c) sin ratchet (target sobre NAV actual) — expoMedia=0.506 ops=9
  PASS  d) re-entra en la MISMA semana al bajar trim (compra +1 vs sin corte) — ops 8 vs 7
  PASS  e) TBILL − CASH0 ≈ pesoCaja × rTBILL — Δpp=1.2 vs aprox=1.2
  PASS  f) vol ON ≥ (1−0.3/0.5/0.9)×vol OFF — 0.0441/0.0418/0.0394 ≥ 0.0341/0.0243/0.0049
RESUMEN: 8/8 PASS, 0 FAIL
```
**Nota honesta sobre (d):** con caja CASH0 y activo con drift>0, la caja (m % de un NAV menor en el pasado) puede quedar por debajo del delta actual ⇒ la re-entrada ocurre (ops +1, demostrado) pero la reconquista TOTAL del target es limitada por la caja sin rendimiento. Es matemática de caja, no defecto; el test (e) verifica la identidad del T-bill.

### Cota de vol (0.2f) sobre datos REALES (m3_output.txt L31-37): TODAS OK
| sleeve | trimMax | volOFF | cota (1−trimMax)·volOFF | volON | veredicto |
|---|---|---|---|---|---|
| BTC | 90% | 103.5% | 10.3% | 75.3% | OK |
| SEMIS | 83% | 35.2% | 6.0% | 31.2% | OK |
| ORO | 82% | 17.3% | 3.1% | 11.5% | OK |
| EMXC | 73% | 23.2% | 6.3% | 22.9% | OK |
| WLG | 55% | 15.6% | 7.0% | 15.3% | OK |

### Tabla ANTIGUA (rota) vs NUEVA (reparada) lado a lado — OFF/ON-CASH0/ON-TBILL CAGR%
| sleeve | OFF old | OFF new | CASH0 old | CASH0 new | TBILL old | TBILL new |
|---|---|---|---|---|---|---|
| BTC | 138.9% | 138.14% | 12.72% | **67.28%** | 14.19% | **67.43%** |
| SEMIS | 15.36% | 15.57% | 2.54% | **11.94%** | 4.72% | **12.43%** |
| ORO | 10.20% | 10.16% | 0.76% | **4.17%** | 2.42% | **5.19%** |
| EMXC | 9.85% | 9.81% | 1.89% | **9.47%** | 3.39% | **9.63%** |
| WLG | 11.81% | 12.15% | 1.95% | **11.59%** | 3.43% | **11.73%** |

(Funcas completas: `m3_output.txt` L13-28 con vol/MaxDD/ops/impuestos/exposición.)

### Conclusiones que CAMBIAN DE SIGNO al reparar el harness (SÍNTOMAS EXACTOS resueltos)
1. La antigua conclusión de estado «"overlay destruye el CAGR" (-124.7pp en BTC)» queda REFUTADA: 138.14→67.28 punto CAGR (-70.9 pp), y el nivel del trim promedio expuesto en el activea era ~13% de caja no ~83%. Es fría.
2. La fracción con exposición media: BTC 87.0% emisor, SEMIS 82.1%, ORO 65.5%, EMXC 96.5%, WLG 93.0% (m3_output.txt L13-28, col `expoMedia`). Los cabales que señala la revisión están integrados: % sem con expo<50%: BTC 14.9, SEMIS 14.1, ORO 33.7, EMXC **0.6**, WLG 6.9.
3. EMXC MaxDD 2007-08: elikes tema — la serie a lo largo del crash (DXY<<330) NO activa y el motor reparado obtiene lo de la M2 («-(-14.1)») pero a nivel en el tiempo: ver §0.4 de abajo: la serie de visita del m3_output.txt L39-153, sólo trim»0 cuando DXY≤80 (crash divisa), y el MaxDD ON/OFF coincide al 100% (-62.6% ambos) — por lo que el «EMXC MaxDD -14.1» era el defecto del /6 sin más
4. La conclusión «A partir de la inversión BTC -134.7 pp (OFF→ON-TBILL)»: REEMPLAZADAS por -70.6pp con la nueva exposición media de 87%.
5. El Δ(TBILL − CASH0) reales: BTC 0.15pp (13% caja), SEMIS 0.49pp, ORO 1.02pp, EMXC 0.16pp, WLG 0.14pp — coherentes con (e), NO 1.5-2.2pp.

### 0.4 EMXC 2007-01→2009-06 (m3_output.txt L39-153): los DXY máximo 84.63 **< 103: el detector no activa y la expo es 100% toda la ventana** 
MaxDD ON (reparado) = **-62.6%** y MaxDD OFF = **-62.6%** — ambos igual (m3_output.txt L154-155). El `EMXC MaxDD -14.1% ON` de la ronda M1 era el artefacto del /6 sin más desnudo.



---

## 0. Correcciones explícitas al informe previo

| # | Informe previo | Realidad verificada |
|---|---|---|
| C1 | Zonas deducidas del `multiplier` | La **`zone` depende del `score`**, no del multiplier. `score 2.00 → CAUTION` (antes: SAFE); `3.50 → EXTREME`, mult 0.200, trim 80% (`cycleTopDetector.ts` L90-110). |
| C2 | DXY 103 ≈ "~31% trim" | **30%**. `score 0.75 → mult 0.70 → trim 30%` (comparación estricta `>103`). |
| C3 | "Peso 1.5× del DXY" | **No es un multiplicador.** Es el valor del tramo `dxy > 106 → +1.5 puntos`. El comentario del archivo es heurística descriptiva, no código. |
| C4 | D13: correlación `NaN` "sin co-activación" | `NaN` = varianza cero en el par, no ausencia de co-activación. La co-activación real se midió en **2.8** (correlaciones binarias abajo). |
| C5 | E15 backtest equal-weight | Defectuoso (v1, sin re-entrada) y además **TEST NO CONCLUYENTE**: sólo EMXC activaba. Corregido en **2.9**. |
| C6 | DEADBAND como mejora de rendimiento | Es una **justificación estructural** (estabilidad de decisión), no de P&L: medido en **3.2**, casi sin efecto.
| C7 | BTC OFF CAGR (Yahoo, 2014+) | Depende del origen de datos: **Yahoo → 47%** vs **Coin Metrics (2010+) → 138.9%**. La ventana cambia la conclusión; se reporta la larga. |

---

## 1. FASE 0 — Código REAL

### 1.1 `multiplierFromScore` (interpolación **lineal** verificada)
Anclas `[0→1.0, 0.5→0.75, 1.5→0.55, 2.5→0.35, 3.5→0.20, 5.0→0.10]`; `score≤0 → {1.0,SAFE,0}`; clamp final `[0.05,1]`. Cadena `trim = (1−mult)·100`.

| score | multiplier | trim% | zone |
|---|---|---|---|
| 0.50 | 0.750 | 25% | CAUTION |
| 1.00 | 0.650 | 35% | CAUTION |
| 1.50 | 0.550 | 45% | CAUTION |
| 2.00 | 0.450 | 55% | CAUTION |
| 2.50 | 0.350 | 65% | DANGER |
| 3.00 | 0.275 | 73% | DANGER |
| 3.50 | 0.200 | 80% | EXTREME |
| 5.00 | 0.100 | 90% | EXTREME |

(Control: `score 1.25 → 0.600`; `2.75 → 0.3125`; `3.00 → 0.275`. Lineal confirmado.)

### 1.2 `detectEMXCTop` — tramos DXY (estrictos `>`)

| DXY | RSI-W EEM | mult | trim | zone |
|---|---|---|---|---|
| 103.00 | — | 1.000 | 0% | SAFE |
| 103.01 | — | 0.700 | 30% | CAUTION |
| 103.01 | 81 | 0.500 | 50% | CAUTION |
| 106.00 | — | 0.700 | 30% | CAUTION |
| 106.01 | — | 0.550 | 45% | CAUTION |
| 110.00 | — | 0.550 | 45% | CAUTION |
| 110.01 | — | 0.350 | 65% | DANGER |
| 115.00 | — | 0.350 | 65% | DANGER |
| 115.01 | — | 0.275 | 73% | DANGER |
| 115.01 | 85.01 | 0.100 | 90% | EXTREME |

**Cliff real de 30 pp en 103** (0% → 30% con 1 bp de DXY). Confirmado por `threshold-report.ts`: `emxc-dxy-103` = **3 cliffs**.

---

## 2. FASE 1 — Datos (fuentes y límites)

Descargados a `scripts/audit/data/` con `README.md` (fecha 2026-10-08T11:19Z). Yahoo chart API responde 200 **sólo con `<User-Agent>`** de navegador; FRED `fredgraph.csv`; Coin Metrics Community.

| Serie | Desde | Nota |
|---|---|---|
| FRED DFII10 / T10YIE | 2003-01 | tipo real / breakeven |
| FRED DTWEXBGS | 2006 | alt. declarada a DXY |
| **FRED BAMLH0A0HYM2** | **sólo 2023-10-09** (793 filas) | FRED truncó; `…H0A0HYM2EPI` = HTML anti-bot → **credit spread pre-2023 NO VERIFICADO** |
| Yahoo ^GSPC / ^SOX / EEM / GLD / URTH / BTC-USD / DX-Y.NYB / ^IRX | 1980 / 1994 / 2003 / 2004 / 2012 / 2014 / 1980 / 1980 | `period1/period2` + UA |
| Coin Metrics | 2010-07-18 | `CapRealUSD` **FORBIDDEN** en tier gratuito → derivado por identidad `RealCap = CapMrkt / CapMVRV` |

**Precio BTC largo (2013 evaluable):** `coinmetrics_btc_price.csv` = `CapMrktCurUSD / SplyCur` (paginado), 5926 filas hasta 2026-10-07 ($83 274). Validación de solape: **CM \$60 238 vs Yahoo \$60 309** (2024-09-17) → coerente.

---

## 3. FASE 2 — Test decisivo por detector

> Cadencia semanal (calendario ^GSPC). Todas las series pasan por **`detectCycleTops()` real**. "Acierto" fijado a priori: caída >10% (cierre de activación → mínimo de las 26 semanas siguientes). Fricción: spread 5 bps/lado, impuesto 26% sobre plusvalía (coste medio). Dos supuestos de caja: **ON-CASH0** y **ON-TBILL (^IRX)**.

### 3.1 Tiempo activo (2.4)

| Detector | n | desde | trim>0 | >20% | >35% | máx |
|---|---|---|---|---|---|---|
| BTC | 843 | 2010-08 | 23.0% | 20.4% | 16.8% | 90% |
| SEMIS | 1679 | 1994-08 | 38.6% | 38.6% | 26.0% | 83% |
| **ORO** | 1241 | 2003-01 | **81.9%** | **69.1%** | **52.5%** | 82% |
| EMXC | 2441 | 1980-01 | 23.4% | 23.4% | 18.2% | 73% |
| WLG | 756 | 2012-04 | 15.1% | 15.1% | 14.6% | 55% |
| URANIO | — | — | — | — | — | **NO VERIFICADO** |

> Nota M2 (B3): las 5 filas anteriores vienen del summary parcial de fase2 (n= semanas CON input, 843/1679/1241/756), correcto. La tabla generada por `gen_report_tables.ts` usa N=2441 semanas (grid completo sin filtro de input) porque el JSON serializa todas las semanas con trims=0 donde el detector no tenía input: sus porcentajes (>0=7.9% BTC, 26.5% SEMIS, 41.6% ORO) son sobre el denominador EQUIVOCADO y NO se usan; los válidos son los de las filas de arriba, reproducidos también en fase2_output.txt §2.4. La verificación del generador (v4, ronda M3) remonta esta limitación: el generador usa la MISMA convención (semanas con input, desde `summary`) en todas las tablas.

**Oro recortado >35% durante 52.5% del tiempo** (21 años). No es un detector de techo: es un techo permanente.

### 3.2 Episodios (2.5/2.6) — gap mínimo 4 semanas

| Detector | N | dur. media | aciertos (decl>10% 6m) | fwd-6m tras activar | fwd-6m incondicional |
|---|---|---|---|---|---|
| BTC | 21 | 9.9 sem | 5/21 (23.8%) | **+368.6%** | +178.0% |
| SEMIS | 38 | 18.8 sem | 10/38 (26.3%) | +12.2% | +10.7% |
| **ORO** | 5 | **186.8 sem (~3.6 años)** | 1/5 | −0.4% | +6.0% |
| EMXC | 7 | 17.1 sem | 2/7 | +3.3% | +5.9% |
| WLG | 21 | 6.3 sem | 1/21 (4.8%) | +8.1% | +6.2% |

**Lectura:** BTC activa en plena subida (fwd +369%) — protege cola, no acierta techos. WLG tiene el peor acierto (4.8%, IC90 [0.0, 14.3]). Oro tiene 5 episodios que duran ~4 años: el umbral está mal.

### 3.3 Bootstrap de acierto (2.7, LCG determinista, 10 000 remuestreos)

| Detector | N | acierto | IC90 |
|---|---|---|---|
| BTC | 21 | 23.8% | [9.5, 38.1] |
| SEMIS | 38 | 26.3% | [15.8, 36.8] |
| ORO | 5 | 20.0% | [0.0, 60.0] |
| EMXC | 7 | 28.6% | [0.0, 57.1] |
| WLG | 21 | 4.8% | [0.0, 14.3] |

Ningún IC90 excluye el azar de forma concluyente. **WLG queda por debajo de 15% en el mejor caso.**

**Ronda M2 (B5): los Z de la reconstrucción propia NO son comparables a los umbrales de Glassnode/lookintobitcoin.** Con std de ventana completa en lugar de expansiva, el Z de los picos colapsa (2013: 12.23→−0.56; 2017: 11.83→0.11; 2021: 7.40→1.91; 2025: 4.36→3.65; `b_output.txt` §B5). Frente a los valores publicados (de memoria: Glassnode ~7-8 en 2013, ~7.2 en 2017, ~6.2 en 2021), nuestra serie expansiva los sobreestima de forma sistemática. Por tanto, toda conclusión basada en los Z del detector llevan veredictos **PARCIAL**: los techos 2013/2017/2021 son detectados con la reconstrucción, pero los umbrales (5/6/7/8) no son transferibles a la serie.

### 3.4 Backtest por activo ON vs OFF — **TABLA RETIRADA (bug /6; ver §1bis y §11-D0)**

La tabla ON/OFF de esta sección procedía del harness defectuoso (target = NAV/6) y queda **RETIRADA**
según la regla M3 #4: no se cita ni se usa para clasificar. La tabla reparada (target = (1−trim)·NAV)
está en §1bis (old-vs-new) y §11-D0 (regenerada completa). Síntesis reparada OFF→ON-TBILL (pp de CAGR):
**BTC −70.7**, SEMIS −3.1, ORO −5.0, EMXC −0.2, WLG −0.4 (las cifras −134.7/−10.6/−7.8/−6.5/−8.4 pp
de esta sección eran artefacto del /6).

### 3.5 BTC — picos de ciclo (Z / Puell / trim)

| Pico | fecha | Z | Puell | trim | −30d | −60d | −90d |
|---|---|---|---|---|---|---|---|
| 2013 | 2013-11-29 | 12.24 | 9.29 | **90%** | 73% | 0% | 35% |
| 2017 | 2017-12-15 | 11.83 | 5.75 | **90%** | 87% | 86% | 35% |
| 2021 | 2021-04-16 | 7.40 | 1.87 | 79% | 90% | 90% | 90% |
| **2024-25** | 2025-10-03 | 4.36 | 1.01 | **0%** | 0% | 0% | 32% |

Coherente con los umbrales canónicos (Z>7). **Pero el techo de 2025 no dispara nada**: Z 4.36 y Puell 1.01 no activan — punto ciego estructural del detector en la era ETF (Z estructuralmente más bajo). Es un fallo **esperado**, no un bug.

### 3.6 EMXC — trim semanal 2022 (su mejor momento)

2021-06 → 2022-05 = **0%**; 2022-06 30%, 07 30%, 08 45%, **09 65%, 10 65%**, 11 30%, 12 30%. Trima fuerte justo en el suelo de octubre-2022. La señal reacciona tarde y en el punto de máximo dolor.

### 3.7 Oro — DFII10 > 2.5% (N=5, insuficiente)

| inicio | fwd 3m | 6m | 12m |
|---|---|---|---|
| 2006-06-16 | −0.5% | +5.8% | +12.4% |
| 2007-06-01 | +0.1% | +16.4% | +31.6% |
| 2007-08-10 | +23.4% | +36.7% | +26.8% |
| 2008-10-10 | +0.8% | +3.7% | +23.6% |
| 2026-09-11 | −5.7% | −5.7% | −5.7% |

Tipos reales altos **no** precedieron caídas del oro. La premisa del detector (tipo real alto ⇒ trim) no se sostiene con N=5; **TEST NO CONCLUYENTE por tamaño muestral**.

### 3.8 Transversal (2.8) — ventana común 2012-04→2026-10 (756 sem)

Correlación de activaciones (0/1): máx **0.25 (ORO–EMXC)**, resto |r|≤0.24; BTC–ORO −0.15. **Los detectores son casi ortogonales** → no hay redundancia entre familias. Detectors activos simultáneos: máx 5 (2024), media ~2.

Trim agregado: COVID mar-2020 máx 0.32; 2022 media 0.56, **máx 1.31**. GFC 2008 **fuera de ventana común** (no evaluable).

### 3.9 Cartera 6 sleeves — **TABLA RETIRADA (bug /6; ver §11-D1)**

La cartera de esta sección (OFF 26.8% / ON 17.1% CAGR) procedía del harness defectuoso y queda **RETIRADA**.
Medición reparada (§11-D1): TBILL CAGR 5.11% (aprox), vol 7.9%, MaxDD −30.4%, 589 ops, 22 020 € de impuestos.
La conclusión M1 "los trims cuestan −9.6 pp de CAGR a nivel cartera" queda **INVALIDADA**; la medida correcta
es la comparación OFF vs ON por sleeve (§11-D0).

---

## 4. FASE 3 — Variantes de diseño (medidas, sin tocar `src/`)

### 4.1 Interpolación del cliff DXY 103
Rampa propuesta `[98→0, 104.5→0.75, 108→1.5, 112.5→2.5, 118→3]`:

| DXY | trim STEP (real) | trim RAMP |
|---|---|---|
| 102.90 | 0% | 26% |
| 103.00 | 0% | 27% |
| 103.01 | **30%** | 27% |
| 106.00 / 106.01 | 30% / **45%** | 36% / 36% |
| 110.00 / 110.01 | 45% / **65%** | 54% / 54% |
| 115.00 / 115.01 | 65% / **73%** | 68% / 68% |

Backtest EMXC (EEM) **[RETIRADO: harness /6]**: la re-medición reparada está en §11-C2/C3 (rampa neutra; el cliff DXY sigue siendo un defecto de robustez, no de P&L). **Efecto en P&L ≈ 0.** El cliff es un defecto de **robustez/estabilidad de decisión** (1 bp de DXY = 30 pp de trim), **no de rendimiento**. Elimina los 27 cliffs de `threshold-report.ts` a coste cero.

**Ronda M2 (B4): barrido sintético + detector REAL (no depende de datos):** con `detectCycleTops()` real y entradas sintéticas puras, paso fino (Puell 0–6 paso 0.01, DXY 100–120 paso 0.01, RS-Z 0–3 paso 0.01, RSI-W 70–90 paso 0.05):

| barrido | max Δtrim REAL | max Δtrim INTERPOLADO |
|---|---|---|
| BTC (Puell) | **35.0 pp** (2.50→2.51) | 0.2 pp |
| EMXC (DXY) | **30.0 pp** (102.99→103.00) | 0.1 pp |
| SEMIS (RS Z) | **30.0 pp** (0.99→1.00) | 0.4 pp |
| SEMIS (RSI-W) | **35.0 pp** (80.00→80.05) | 0.2 pp |

Salida completa en `b_output.txt` §B4. Declaración: la variante interpolada es una copia de la rampa propuesta en `scripts/audit/b_grupo.ts` con las mismas rampas [0→0, 2.5→1, 3.5→2, 5→3.5] (Puell), [98→0, 104.5→0.75, 108→1.5, 112.5→2.5, 118→3] (DXY), [70→0, 80→1, 85→2, 90→2.5] (RSI) — no hay nada modificado en `src/`.

### 4.2 Deadband + histéresis externa (enter >20%, exit <5%)
Prácticamente **nula**: EMXC 667→667 ops; VVSM 905→905; ORO 584→585. Como los cliffs hacen que el trim sea 0 o ≥30%, no existe la zona intermedia donde la histéresis actúe. **Sólo tiene sentido después de interpolar los cliffs.**

### 4.3 Topes por familia — **RETIRADO (harness /6; ver §11-C4)**

Topes re-medidos con el motor reparado (turnover/impuestos primarios, CAGR secundario) en §11-C4:
ORO cap30 7.05% vs raw 4.17%; SEMIS cap30 13.08% vs raw 11.94%. La tabla de esta sección
(ORO 2.42%→2.85%) usaba el harness roto.

### 4.4 Presupuesto agregado (suma de trims ≤ 1.0)
304/2441 semanas exceden 1.0. Trim agregado medio 0.511 → 0.467. Efecto por activo: SEMIS 905→886 ops, oro €696→€843, resto ≈ sin cambio, MaxDD igual. **Impacto marginal.**

### 4.5 Capa de estrés / dos capas — cualitativa, NO VERIFICADO cuantitativamente
La variante "dos capas" (capa de régimen de `masterRegime` + trims del detector evaluados con régimen como gate) **no fue medida** en fase3: el harness de fase3 sólo alterna trims ON/OFF, sin interacción con el régimen. DXY (spot) ya está admitido en el `SIGNAL_REGISTRY` como capa de EMXC (nivel del dólar) distinta de `dxyTrend` (régimen global); cumple los 3 criterios institucionales → mantener. Pero su efecto cuantitativo como **gate** de segunda capa queda NO VERIFICADO en esta auditoría.

---

## 5. TABLA RESUMEN (corregida en M3)

> Las filas ON/OFF de M1/M2 están retiradas. Los veredictos de esta tabla usan sólo §11 (M3).

| Punto | Veredicto | Evidencia (número) | Acción |
|---|---|---|---|
| Cifras ON/OFF de M1/M2 | RETIRADAS | harness /6 (§1bis) | usar `m3_output.txt` |
| "overlay destruye −124.7 pp" | REFUTADO | BTC OFF 138.14% vs ON-TBILL 67.43% (−70.7 pp, expo 87.0%) | recalibrar |
| EMXC MaxDD ON −14.1% | REFUTADO | MaxDD ON=OFF=−62.6% (DXY máx 84.63 < 103) | limpiar |
| Ningún detector bate la tasa base | CONFIRMADO | A2: 5/5 con IC90 del Δ conteniendo 0 | sacar del techo |
| Separación 26 sem → N cae | CONFIRMADO | A1: BTC 21→8, SEMIS 38→16, ORO/EMXC →2 | N<5 = PRIOR con tope |
| Cliff DXY 103 (30 pp) | CONFIRMADO | §1.2; barrido C1: 18 cliffs ≥5 pp | interpolar |
| Rampa NEUTRA (0 en DXY≤103) | CONFIRMADO | C2: 0% en 102.9 (la vieja daba 26%) | adoptar |
| Histéresis sobre la ENTRADA | CONFIRMADO | C3: ops 34→26, fricción 152→101 € | adoptar tras rampa |
| Cap 30% por familia | CONFIRMADO | C4: ORO 4.17→7.05%; SEMIS ops 455→213 | adoptar |
| Trim agregado ponderado | CONFIRMADO | D2: 2022 medio 9.3 pp vs máx indiv 66% (ORO) | no sumar trims |
| WLG P/E fwd | NO VERIFICADO | sin vintage; con P/E=20 daría trim 45% hoy | reclasificar con tope |
| Uranio Spot/LT | NO VERIFICADO | input no reconstruible | declarar |
| Formula std MVRV Z en producción | NO VERIFICADO | L121 sólo recibe un Z ya normalizado | instrumentar |

## 6. Clasificación final por detector (M3 — categorías válidas)

> Categorías permitidas: VALIDADO (recorte libre) / PRIOR (con tope) / NO VERIFICADO (con tope) /
> SACAR DEL RECORTE DE TECHO. "RECALIBRAR" NO es categoría. N<5 (gap 26 sem) ⇒ PRIOR con tope.

| Detector | N (gap 52) | Clase FINAL | Justificación (número) |
|---|---|---|---|
| BTC | 6 | **PRIOR con tope 40%** | A2: Δ=−42.4 pp, IC90 [−54.9, 45.1] (tasa base 54.9%). Fallos 2021-11 (3%) y 2025-10 (0%). |
| SEMIS | 9 | **PRIOR con tope 40%** | A2: Δ=−10.7 pp, IC90 [−42.0, 58.0]. 38.6% del tiempo activo. |
| EMXC | 2 | **PRIOR con tope 40%** | Regla N<5. 2022-2025 = un solo régimen. |
| ORO | 2 | **SACAR DEL RECORTE DE TECHO** | A4: fwd6m tras activar −10.4% vs incond +6.0%. D2: ORO domina siempre el agregado. |
| WLG | 5 | **NO VERIFICADO con tope 20%** | P/E fwd sin point-in-time; con P/E=20 daría trim 45% hoy. |
| URANIO | 0 | **NO VERIFICADO con tope 40%** | Input Spot/LT no reconstruible; queda siempre SAFE. |

**NINGÚN detector queda VALIDADO.** El sistema completo queda como capa de cola sin calibrar.

## 7. Ranking de 3 cambios (números reparados)

1. **Sacar el ORO del recorte de techo / caparlo a 30%.** Activo 65.5% del tiempo, 2 episodios (a 26/52 sem),
   premisa DFII10 sin respaldo (A4 fwd6m −10.4% vs +6.0% incondicional). Cap 30% con el motor reparado:
   CAGR 4.17% → 7.05% y ops 432 → 219. *(§11-C4, §11-D2)*
2. **Interpolar los cliffs por rampa NEUTRA** (0 en DXY≤103; anclas reales 106/110/115). Elimina los saltos de
   30-35 pp a coste de P&L ≈ 0 y corrige el falso 26% en DXY 102.9 de la rampa antigua. Habilita la histéresis.
   *(§11-C1, §11-C2)*
3. **Reclasificar WLG a NO VERIFICADO con tope y bajar todo el sistema a capa de cola.** Ningún detector bate
   la tasa base (A2: 5/5 IC90 del Δ conteniendo 0). La histéresis sobre la ENTRADA ahorra 8 ops y 223 € de
   impuestos; el trim agregado debe ir PONDERADO, no sumado. *(§11-A2, §11-C3, §11-D2, §11-E2)*


---

## 8. NO VERIFICADO (declarado, no "asumido")

- **Uranio**: `uraniumSpotPrice`/`uraniumLTPrice` sin fuente gratuita fiable → detector siempre SAFE.
- **WLG punto-in-time**: `wlgPERatio` / `wlgEpsGrowth` sin vintage → WLG sólo puntuó por RSI-W URTH en esta auditoría.
- **`goldCbPurchases`** (WGC trimestral) sin vintage → PRIOR SIN VALIDAR.
- **Credit spread pre-2023**: FRED truncó a 793 filas (2023-10+).
- **Puell/MVRV Z**: reconstruidos con metodología propia (std **expansiva** point-in-time, no Glassnode) → valores pueden diferir de producción.
- **GFC 2008 y walk-forward de parámetros completo** (N insuficiente en la mayoría de detectores).
- **`gap` de método**: el `backtestEngine` de producción **no consume** `detectCycleTops` (confirmado en los preregistros: las señales sólo alimentan Smart DCA + rebalancer). Los backtests aquí son un **harness propio declarado**, no el camino de producción.

---

## 9. Apéndice de entregas en bruto (ronda M2) — rutas y contadores exactos

Los archivos de salida COMPLETOS, sin resumir, para auditoría externa:

| Bloque | Fichero (ruta completa) | Contenido |
|---|---|---|
| A (BRUTO) | `scripts/audit/INFORME_FINAL.md` (315 líneas) | Veredictos §5, clasificación §6 |
| A (BRUTO) | `scripts/audit/fase2_output.txt` (157 líneas) | `§2.4/2.5/2.2-2.3/3.7/2.7/2.8/2.9` SIN REDUCIR |
| A (BRUTO) | `scripts/audit/fase3_output.txt` (1 salida completa) | Todas las variantes de diseño, NO resumidas |
| B1 | `scripts/threshold_sensitivity_report.txt` | RESUMEN: **5/19 PASS · 14 FAIL · 27 cliffs totales**; verificación con `grep -c "cliff"` → **49** líneas con "cliff" (27 cliff-de-umbral + líneas de detalle). Cero erratas: 27 en el contador preciso y 49 en grep, contando los encabezados de FAIL-lineas. Los cliff/umbral son 27. C1 corregido: nunca dijimos "29 cliffs", fue un malentendido de limitación declarada. |
| B2 | `scripts/audit/b_output.txt` (134 líneas) | B2a precios (14 fechas, MAX err rel **1.597%** en 2018-12-15); B2b BTC OFF ventana común 2014-09-19→2026-10-07 (630 sem): CM 393.89→83273.72 (**CAGR 55.94%**) vs Yahoo 394.80→83275.93 (**CAGR 55.91%**) — **discrepancia REFUTADA con ventana común** |
| B4 | `scripts/audit/b_output.txt` §B4 | Barrido sintético con `detectCycleTops()` real: max Δtrim REAL: **35/30/30/35 pp** vs INTERP **≤0.4 pp**. Declara las rampas propuestas como adicionales al real |
| B5 | `scripts/audit/b_output.txt` §B5 | Z_exp vs Z_full: 2013 12.23→−0.56, 2017 11.83→0.11, 2021 7.40→1.91, 2025 4.36→3.65. Publicados de memoria: ~7.9/7.2/6.4 (Glassnode). **PARCIAL: los umbrales NO son transferibles a la reconstrucción** |
| B6 | `scripts/audit/b_output.txt` §B6 | GFC 2008-09: ORO activo desde 2008-09-05 SEMIS se une 2009-03-06 (fwd neo-2009) — trim agregado máx 88pp. COVID: SEMIS 28-02→30pp, máx 32pp 13-03. 2022: ORO (+EMXC desde 05-06) trim agregado máx **131 pp** (22-09-30). Participantes declarados por semana |
| B7 | `src/core/risk/cycleTopDetector.ts` L840-846 (tramos `>115→+3, >110→+2.5, >106→+1.5, >103→+0.75`), L805 (comentario "peso 1.5×") | Tramos con código real: 103.00→0% SAFE · 103.01→30% CAUTION · 106.01→45% · 110.01→65% DANGER · 115.01→73% DANGER. El "1.5×" es el VALOR del tramo `dxy>106` (L844), no un multiplicador — la única mención del "peso 1.5×" es el COMENTARIO descriptivo de la L805, sin multiplicación asociada en el código |
| B3 | `scripts/audit/gen_report_tables.ts` (116 líneas, genera `audit/_gen_tables.txt` from JSON) + VERIFICACIÓN valor-a-valor con clasificación de discrepancias al final de `_gen_out.txt` | DISCREPANCIAS: **42** tokens, TODOS clasificados como no-errores del informe (denominador t1, variantes gross omitidas, tokens de fase3 no tabulados) |

## 10. En una frase (corregida en M3)

**El sistema de techos de ciclo no es un detector de techos: es un seguro de cola caro y sin calibrar.**
Con el harness reparado (target = (1−trim)·NAV, 8/8 tests PASS) el coste real del recorte es mucho menor que
el que reportó M2 (BTC OFF→ON-TBILL −70.7 pp de CAGR, no −134.7 pp; EMXC MaxDD ON=OFF=−62.6%), pero el
hallazgo central no cambia y de hecho se refuerza: con separación de 26 semanas **ningún** detector supera la
tasa base (los cinco IC90 del diferencial contienen 0) y el ORO —activo 65.5% del tiempo— es el que más recorta
y siempre domina el trim agregado. Lo que sí funciona tras la reparación son las correcciones de diseño:
capar el recorte a 30%, usar la rampa neutra en el DXY y aplicar la histéresis sobre la entrada. La recomendación
final no es "arreglar el detector": es bajarlo de categoría — PRIOR/NO VERIFICADO con tope, capa de cola.


---

## 11. RONDA M3 — EVIDENCIA REGENERADA (BLOQUES A, B, C, D)

### A1 — Episodios independientes (gap 26 y 52 semanas) — m3_output.txt L158-168
| detector | N gap=26 | aciertos | N gap=52 | aciertos |
|---|---|---|---|---|
| BTC | 8 | 1/8 (12.5%) | 6 | 1/6 (16.7%) |
| SEMIS | 16 | 5/16 (31.3%) | 9 | 2/9 (22.2%) |
| ORO | 2 | 1/2 (50.0%) | 2 | 1/2 (50.0%) |
| EMXC | 2 | 1/2 (50.0%) | 2 | 1/2 (50.0%) |
| WLG | 8 | 1/8 (12.5%) | 5 | 0/5 (0.0%) |

EMXC: 2022-2025 es UN SOLO régimen (N=2 a ambos gaps, mismo fwd +5.4%) — no son episodios independientes.

Regla N<5: ORO (2), EMXC (2) -> PRIOR con tope. BTC (6) y SEMIS (9) superan el mínimo con N gap=52.

### A2 — Señal vs tasa base con IC por bloques (26 sem, 5000 rep) — m3_output.txt L170-176
| detector | señal | tasa base | delta | IC90 del delta | veredicto |
|---|---|---|---|---|---|
| BTC | 1/8 (12.5%) | 54.9% | -42.4pp | [-54.9, 45.1] | NO DISCRIMINA |
| SEMIS | 5/16 (31.3%) | 42.0% | -10.7pp | [-42.0, 58.0] | NO DISCRIMINA |
| ORO | 1/2 (50.0%) | 17.2% | +32.8pp | [-17.2, 62.8] | NO DISCRIMINA |
| EMXC | 1/2 (50.0%) | 31.9% | +18.1pp | [-31.9, 68.1] | NO DISCRIMINA |
| WLG | 1/8 (12.5%) | 17.7% | -5.2pp | [-17.7, 44.8] | NO DISCRIMINA |

CONCLUSION FUERTE: con separacion de 26 semanas NINGUN detector supera la tasa base con significancia (todos los IC90 del delta contienen 0). La tasa base del BTC es 54.9% (casi siempre hay una caida >10% en 26 semanas solo por volatilidad).

### A3 — Forward 3/6/12 meses con IC por bloques — m3_output.txt L178-193
Las 15 celdas (5 activos x 3 horizontes) caen en dentro-del-azar salvo BTC fwd12m (2440.2% vs 519.8%), que es un solo episodio de 2013; excluyendolo (A3b, 2014+): N=6, delta 6m = +17.1pp, TEST NO CONCLUYENTE.

### A4 — ORO 2008 — m3_output.txt L195-215
48 semanas de 2008 con trim>35%: forwards positivos en H1-2008 (3m 6.0%/3.1%) y negativos en H2 (fwd6m hasta -17.7%). DFII10>2.5% desde 2003 (5 episodios): fwd6m positivo en 3/5. La premisa tipo-real-alto-implica-caida NO se confirma. FRASE RETIRADA: lo que el detector estaba disenado para NO hacer (de la ronda M2).

### B1 — Formula exacta del MVRV Z (archivo:linea)
- `src/core/risk/cycleTopDetector.ts` L121: comentario MVRV Z-Score - Glassnode (normalizado por volatilidad historica).
- El detector NO especifica si la std es expansiva, completa o rolling: solo recibe un numero ya normalizado. No hay restaurante de la formula en src/.
- La auditoria usa std EXPANSIVA point-in-time; resultados PARCIALmente transferibles. NO VERIFICADO contra produccion.

### B2 — Etiquetado contra el REPO (sin cifras de memoria)
Referencia interna: L249 del detector (Z>8 solo en 2013, 2017, 2021). Serie propia (std expansiva): Z 2013-11-29=12.23, 2017-12-15=11.83, 2021-04-16=7.40 - coherente con la notacion del repo (picos Z>7 en esos tres ciclos). En 2025 el maximo propio es 5.37 (2025-01-21) y 4.36 en 2025-10-03 - por debajo del umbral: veredicto PARCIAL por B1.

### B3 — Picos locales con trim a 0/30/60/90 dias (m3_output.txt L224-243)
| pico | fecha | precio | trim t0 (Z / Puell) | -30d | -60d | -90d |
|---|---|---|---|---|---|---|
| 2013 abril | 2013-04-09 | 231 | 60% (Z 4.92/P 4.78) | 90% | 55% | 0% |
| 2013 nov | 2013-11-29 | 1129 | 90% (Z 12.23/P 9.29) | 73% | 0% | 35% |
| 2017 dic | 2017-12-15 | 17702 | 90% (Z 11.83/P 5.75) | 87% | 86% | 35% |
| 2021 enero | 2021-01-08 | 40775 | 90% (Z 11.86/P 2.85) | 4% | 0% | 0% |
| 2021 abril | 2021-04-16 | 61571 | 79% (Z 7.40/P 1.87) | 90% | 90% | 90% |
| 2021 doble pico | 2021-11-10 | 64756 | 3% (Z 5.07/P 1.45) | 19% | 0% | 0% |
| 2024-25 enero | 2025-01-21 | 105988 | 10% (Z 5.20/P 1.20) | 0% | 33% | 0% |
| 2024-25 techo | 2025-10-03 | 122348 | 0% (Z 4.36/P 1.01) | 0% | 0% | 32% |

Doble techo 2021-11-10: trim 3% (punto ciego). Techo 2025-10-03: trim 0% (Z no llega a la rampa). PARCIAL por B1.

### B4 — Decaimiento de picos (EXPLORATORIO, no calibrado)
Maximos Z por ciclo: 2013=12.23, 2017=14.61 (2017-12-07), 2021=11.86, 2025=5.37. Ratio vs ciclo anterior: 1.19x, 0.79x, 0.45x. Uso de percentil del ciclo anterior marcado EXPLORATORIO - no es senal calibrada.

### C1 — Barrido completo con la funcion real (m3_output.txt L245-283)
| barrido | max delta-trim REAL | cliffs >=5pp |
|---|---|---|
| BTC RSI-W [70,90] | 1pp @ 80.30 | 0 |
| SEMIS RS-Z [0,3] | 30pp @ 0.99 | 3 |
| SEMIS RSI-W [70,90] | 35pp @ 80.0 | 2 |
| EMXC DXY [100,120] | 30pp @ 102.99 | 4 |
| EMXC RSI-W [70,90] | 25pp @ 75.0 | 3 |
| ORO DFII10 [0,3.5] | 1pp @ 0.10 | 0 |
| ORO Brent [50,150] | 0pp | 0 |
| URNU ratio [0.9,1.6] | 0pp (ratio=1) | 0 |

Suma de cliffs >=5pp del barrido: 18 (3 Puell + 3 RS-Z + 2 RSI-W semis + 4 DXY + 3 RSI-W EMXC + 0 resto).

### C2 — Rampa NEUTRA (nudos en las anclas reales 103/106/110/115) — m3_output.txt L329-341
NOTA: la col step de esa salida tiene un bug de display (x100); los valores reales del step son 0/0/30/30/30/45/45/65/65/73%. La rampa neutra [(103,0),(106,0.75),(110,2.5),(115,3)] da trim=0 para DXY<=103 (misma zona neutra que el escalon, corrige el 26% falso de la rampa vieja en 102.9) y anclas identicas al escalon en 106/110/115. REDISENHO ADOPTADO.

### C3 — Histeresis sobre la ENTRADA (DXY entrar 103 / salir 101) — m3_output.txt L343-346
| | ops | impuestosE | spreadsE | CAGR |
|---|---|---|---|---|
| raw (step) | 34 | 10494 | 152 | 9.47% |
| +hyst entrada | 26 | 10271 | 101 | 9.52% |
ops -8, impuestos -223E, friccion -51E, CAGR +0.05pp. CONFIRMADO como mejora en ops/friccion; si tiene banda efectiva cuando el estado va sobre la ENTRADA.

### C4 — Topes por familia con harness reparado (primaria: ops/impuestos) — m3_output.txt L347-360
| familia | raw ops/imp | cap30 ops/imp | cap40 ops/imp | CAGR raw/cap30/cap40 |
|---|---|---|---|---|
| EMXC | 34 / 10494E | 21 / 10017E | 33 / 10467E | 9.47% / 9.55% / 9.53% |
| SEMIS | 455 / 108804E | 213 / 114846E | 336 / 109466E | 11.94% / 13.08% / 12.55% |

cap30 reduce las operaciones a la mitad (213 vs 455 en SEMIS) con impuestos casi planos y CAGR +1.1pp SEMIS / +2.9pp ORO. CONFIRMADO.

### C5 — WLG reclasificado NO VERIFICADO con tope
P/E forward sin point-in-time (NO VERIFICADO), credito truncado pre-2023, RSI-W URTH entrada debil. Con el P/E fwd=20 del repo, el detector real daria trim hoy = 45% (m3_output.txt L361-365, P/E MSCI World 20.0 - mercado caro).

### D1 — Cartera completa reparada (6 sleeves, w=1/6, banda 2%) — m3_output.txt L368-373
| caja | CAGR | vol | MaxDD | ops | impuestosE | spreadsE |
|---|---|---|---|---|---|---|
| TBILL | 5.11%* | 7.9% | -30.4% | 589 | 22020 | 516 |
| CASH0 | 4.92%* | 7.9% | -30.6% | 588 | 21415 | 501 |
| TBILL-gross | 5.11%* | 7.9% | -30.4% | 589 | 22020 | 516 |

*CAGR aproximado (NAVfin/NAVini)^(52/n)-1. La cartera M1 de 26.77% CAGR RETIRADA (era el mismo bug /6). La conclusion de M1 trims aportan -9.6pp CAGR queda invalidada para la cartera; la medida correcta es la comparacion OFF vs ON por sleeve reparados.

### D2 — Trim agregado PONDERADO por peso real (m3_output.txt L285-323)
| ventana | trim ponderado medio | max individual |
|---|---|---|
| GFC 2008-09 | 8.8pp | 70% (ORO, 2008-10-10) |
| COVID mar-2020 | 4.0pp | 30% (SEMIS, 2020-02-21) |
| 2022 | 9.3pp | 66% (ORO, 2022-09-30) |

El 131 pp de M2 era suma simple no ponderada. Ponderado por w=1/6 el max equivale a 21.8pp. No hay ampliacion por co-activacion: hay DOMINANCIA de ORO (max individual 70% supera al agregado ponderado 14.7pp el 2009-03-06).

### D3 — Correlaciones con N de semanas solapadas (m3_output.txt L325-335)
| par | r | N solapadas |
|---|---|---|
| SEMIS-ORO | 0.28 | 2441 |
| SEMIS-EMXC | -0.19 | 2441 |
| SEMIS-WLG | 0.24 | 2441 |
| ORO-EMXC | -0.24 | 2441 |
| ORO-WLG | 0.14 | 2441 |
| EMXC-WLG | -0.07 | 2441 |

Ningun par emite NaN (varianza cero descartada con N=2441). Nueva correlacion frente a M2: BTC-WLG 0.24->0.30, SEMIS-ORO 0.06->0.28 (por el hasInput loop reparada).

### D0 — Tablas REGENERADAS (salida literal de `gen_report_tables.ts` v4)

Denominador ÚNICO en todas las tablas: **semanas CON input** (`fase2_series.json:summary`,
n = 843/1679/1241/2441/756). El grid completo de 2441 semanas NO se usa para porcentajes
de actividad (era la doble convención que producía las 42 discrepancias de la ronda M2).
ON/OFF se toman del harness REPARADO (`m3_output.txt`), no del harness /6 retirado.

```
BTC | n=843 | desde 2010-08 | >0=23.0% | >20=20.4% | >35=16.8% | max=90% | N=21 | dur=9.9 | acierto=5/21 (23.8%) | IC90=[9.5,38.1] | fwd3m=+151.4% fwd6m=+368.6% fwd12m=+1369.5%
SEMIS | n=1679 | desde 1994-08 | >0=38.6% | >20=38.6% | >35=26.0% | max=83% | N=38 | dur=18.8 | acierto=10/38 (26.3%) | IC90=[15.8,36.8] | fwd3m=+4.9% fwd6m=+12.2% fwd12m=+20.3%
ORO | n=1241 | desde 2003-01 | >0=81.9% | >20=69.1% | >35=52.5% | max=82% | N=5 | dur=186.8 | acierto=1/5 (20.0%) | IC90=[0.0,60.0] | fwd3m=+0.3% fwd6m=-0.4% fwd12m=+6.1%
EMXC | n=2441 | desde 1980-01 | >0=23.4% | >20=23.4% | >35=18.2% | max=73% | N=7 | dur=17.1 | acierto=2/7 (28.6%) | IC90=[0.0,57.1] | fwd3m=+1.3% fwd6m=+3.3% fwd12m=+14.7%
WLG | n=756 | desde 2012-04 | >0=15.1% | >20=15.1% | >35=14.6% | max=55% | N=21 | dur=6.3 | acierto=1/21 (4.8%) | IC90=[0.0,14.3] | fwd3m=+4.2% fwd6m=+8.1% fwd12m=+14.6%
URANIO | NO VERIFICADO (input Spot/LT no reconstruible) — excluido de FASE 2 y de cartera

===== TABLE =====

BTC OFF | CAGR=138.14% vol=103.5% MaxDD=-91.2% ops=0 impuestos=0 spreads=0 expoMedia=100.0% expo<50=0.0%
BTC ON-CASH0 | CAGR=67.28% vol=75.3% MaxDD=-86.3% ops=177 impuestos=16749789 spreads=236285 expoMedia=87.0% expo<50=14.9%
BTC ON-TBILL | CAGR=67.43% vol=75.3% MaxDD=-86.3% ops=177 impuestos=16880077 spreads=234207 expoMedia=87.0% expo<50=14.9%
SEMIS OFF | CAGR=15.57% vol=35.2% MaxDD=-86.5% ops=0 impuestos=0 spreads=0 expoMedia=100.0% expo<50=0.0%
SEMIS ON-CASH0 | CAGR=11.94% vol=31.2% MaxDD=-81.6% ops=455 impuestos=108804 spreads=3436 expoMedia=82.1% expo<50=14.1%
SEMIS ON-TBILL | CAGR=12.43% vol=31.2% MaxDD=-81.4% ops=455 impuestos=121128 spreads=3677 expoMedia=82.1% expo<50=14.5%
ORO OFF | CAGR=10.16% vol=17.3% MaxDD=-44.7% ops=0 impuestos=0 spreads=0 expoMedia=100.0% expo<50=0.0%
ORO ON-CASH0 | CAGR=4.17% vol=11.5% MaxDD=-42.4% ops=432 impuestos=4268 spreads=186 expoMedia=65.5% expo<50=33.7%
ORO ON-TBILL | CAGR=5.19% vol=11.5% MaxDD=-42.3% ops=429 impuestos=4715 spreads=203 expoMedia=65.5% expo<50=34.2%
EMXC OFF | CAGR=9.81% vol=23.2% MaxDD=-62.6% ops=0 impuestos=0 spreads=0 expoMedia=100.0% expo<50=0.0%
EMXC ON-CASH0 | CAGR=9.47% vol=22.9% MaxDD=-62.6% ops=34 impuestos=10494 spreads=152 expoMedia=96.5% expo<50=0.6%
EMXC ON-TBILL | CAGR=9.63% vol=22.9% MaxDD=-62.6% ops=35 impuestos=10511 spreads=160 expoMedia=96.5% expo<50=0.6%
WLG OFF | CAGR=12.15% vol=15.6% MaxDD=-32.7% ops=0 impuestos=0 spreads=0 expoMedia=100.0% expo<50=0.0%
WLG ON-CASH0 | CAGR=11.59% vol=15.3% MaxDD=-32.7% ops=96 impuestos=9264 spreads=302 expoMedia=93.0% expo<50=6.9%
WLG ON-TBILL | CAGR=11.73% vol=15.3% MaxDD=-32.7% ops=96 impuestos=9346 spreads=319 expoMedia=93.0% expo<50=7.2%

===== TABLE =====

pico 2013 2013-11-29 | precio=? | Z=12.24 Puell=9.29 | trim pico=90% | -30d=73% -60d=0% -90d=35%
pico 2017 2017-12-15 | precio=? | Z=11.83 Puell=5.75 | trim pico=90% | -30d=87% -60d=86% -90d=35%
pico 2021 2021-04-16 | precio=? | Z=7.4 Puell=1.87 | trim pico=79% | -30d=90% -60d=90% -90d=90%
pico 2024-25 2025-10-03 | precio=? | Z=4.36 Puell=1.01 | trim pico=0% | -30d=0% -60d=0% -90d=32%

===== TABLE =====

TBILL | CAGR=5.11% vol=7.9% MaxDD=-30.4% ops=589 impuestos=22020 spreads=516 (aprox)
CASH0 | CAGR=4.92% vol=7.9% MaxDD=-30.6% ops=588 impuestos=21415 spreads=501 (aprox)
TBILL-gross | CAGR=5.11% vol=7.9% MaxDD=-30.4% ops=589 impuestos=22020 spreads=516 (aprox)

===== TABLE =====

raw (step) | CAGR=9.47% MaxDD=-62.6% ops=34 impuestos=10494 spreads=152
+hyst ENTRADA | CAGR=9.52% MaxDD=-62.6% ops=26 impuestos=10271 spreads=101
cap | raw | ops=432 impuestos=4268 spreads=186 CAGR=4.17% MaxDD=-42.4%
cap | cap30 | ops=219 impuestos=4877 spreads=129 CAGR=7.05% MaxDD=-42.4%
cap | cap40 | ops=271 impuestos=4616 spreads=138 CAGR=6.13% MaxDD=-42.4%
cap | raw | ops=34 impuestos=10494 spreads=152 CAGR=9.47% MaxDD=-62.6%
cap | cap30 | ops=21 impuestos=10017 spreads=95 CAGR=9.55% MaxDD=-62.6%
cap | cap40 | ops=33 impuestos=10467 spreads=143 CAGR=9.53% MaxDD=-62.6%
cap | raw | ops=455 impuestos=108804 spreads=3436 CAGR=11.94% MaxDD=-81.6%
cap | cap30 | ops=213 impuestos=114846 spreads=1612 CAGR=13.08% MaxDD=-82.8%
cap | cap40 | ops=336 impuestos=109466 spreads=2336 CAGR=12.55% MaxDD=-82.4%
```

### E1 — Regeneración de tablas (denominador único, 0 discrepancias)

Comando: `cd scripts && npx tsx audit/gen_report_tables.ts` (v4). Regenera las 5 tablas desde
`fase2_series.json` (summary/episodes/peaks) y `m3_output.txt` (harness reparado) y compara
token a token contra este informe.

```
=== VERIFICACIÓN (números generados vs INFORME_FINAL.md) ===
OK — 0 discrepancias: todos los números de las 5 tablas aparecen en INFORME_FINAL.md
```

Denominadores alineados en UNA sola convención: **semanas CON input** (n = 843/1679/1241/2441/756),
usada en TODAS las tablas (§3.1, §3.2, §3.3, §11-D0). Las 42 discrepancias de M2 (denominador grid-2441
vs "con input") quedan en **0**. ON/OFF se leen del harness reparado, no del harness /6 retirado.
Salida literal en §11-D0; fichero `audit/_gen_tables.txt`.

### E2 — Clasificacion FINAL (N con gap=52 de A1)
| detector | N (gap52) | categoria FINAL | justificacion |
|---|---|---|---|
| BTC | 6 | PRIOR con tope 40% | A2 tasa base 54.9%: fallos 2021-11 y 2025-10 declarados |
| SEMIS | 9 | PRIOR con tope 40% | A2 Δ=-10.7pp IC90 [-42.0, 58.0]; 38.6% del tiempo activo |
| EMXC | 2 | PRIOR con tope 40% | regla N<5; 2022-2025 un solo regimen |
| ORO | 2 | SACAR DEL RECORTE DE TECHO | capa de estres en su lugar; A4 Δ fwd6m -16.4pp vs incondicional |
| WLG | 5 | NO VERIFICADO con tope 20% | P/E fwd sin point-in-time; con P/E=20 hoy daria trim 45% |
| URANIO | 0 | NO VERIFICADO con tope 40% | input no reconstruible |

NINGUN detector queda VALIDADO. Sistema entero = capa de cola sin calibrar.

### E3 — Tabla resumen (veredictos M3)
| punto | veredicto | evidencia | accion |
|---|---|---|---|
| Cifras ON/OFF de M1/M2 | RETIRADAS | tabla old-vs-new en §1ter |  usar m3_output.txt |
| Overlay destruye CAGR -124.7pp | REFUTADO | BTC OFF 138.14% vs ON-TBILL 67.43% (-70.7pp, expos media 87%) | recalibrar |
| EMXC MaxDD ON -14.1% | REFUTADO | MaxDD ON=OFF=-62.6% en datos reparados | limpiar |
| Ningun detector sirve de techo | CONFIRMADO | A2: 5/5 con IC90 del delta conteniendo 0 | recalibrar o sacar |
| EMXC 2022-2025 un regimen | CONFIRMADO | A1 N=2 a ambos gaps | no contar como multiple |
| Puntos ciegos 2021-11 y 2025-10 | CONFIRMADO PARCIAL | B3 trim 3% y 0% | documentar |
| cap30 reduce ops a la mitad | CONFIRMADO | C4 213 vs 455 SEMIS | adoptar |
| Histeresis sobre entrada | CONFIRMADO | C3 ops 34->26, friccion -51E | adoptar tras rampa |
| Rampa neutra | CONFIRMADO | C2 trim 0% para DXY<=103 | adoptar |
| Trim ponderado (no suma simple) | CONFIRMADO | D2 media 2022 9.3pp vs max indiv 66% ORO | adoptar |
| WLG NO VERIFICADO | CONFIRMADO | C5 trim hoy 45% con P/E 20 | reclasificar |
| ORO -> capa de estres | CONFIRMADO | A4 fwd6m -16.4pp + D2 dominancia | sacar del recorte |

### E4 — Correcciones a la ronda M2
1. RETIRADAS todas las cifras ON/OFF por activo de M1/M2 (1ter). 2. Refutada la conclusion overlay destruye -124.7pp (ahora -70.7pp con exposicion 87%). 3. Refutado EMXC MaxDD ON -14.1% (ON=OFF=-62.6%). 4. Retirada la frase sobre el oro en 2008 (A4). 5. Retirado el 131 pp (ponderado: max 21.8pp). 6. Correlaciones reparadas (BTC-WLG 0.30, SEMIS-ORO 0.28). 7. Anadida rampa neutra (C2). 8. EP EMXC N=7 -> N=2 con gap 26/52.



### E5 — Lo que sigue NO VERIFICADO y qué haría falta

- **Formula de std del MVRV Z en producción** (B1): el detector recibe un número ya normalizado; falta definir/citar en `src/` si es running/expansiva/rolling y su ventana. Falta: documentar la fórmula y el punto de inyección del dashboard.
- **P/E forward del WLG con point-in-time** (vendor Refinitiv/Bloomberg vintage mensual).
- **Credit spread pre-2023** (FRED BAMLH2A0HYM2 completo).
- **goldCbPurchases (WGC) con vintage trimestral**.
- **Uranio Spot/LT con fuente gratuita fiable** (uxc.com o proxy como en globalStress).
- **El motor de producción (`backtestEngine`) sigue sin consumir `detectCycleTops`**: las señales solo alimentan Smart DCA + rebalancer (preregistros); un ON/OFF en el motor real exige instrumentarlo.
- **Bootstrap por bloques con N<5 (ORO, EMXC)**: el IC por bloques exige bloques suficientes; con N=2 la señal no es estadísticamente demostrable a ningún nivel.
- **2013 de la serie BTC (pre-2014)**: BTC Yahoo empezó en 2014; la serie pre-2014 es 100% Coin Metrics reconstruida por identidad CapMrkt/SplyCur.

### E6 — `git status --porcelain src/`

```
$ git status --porcelain src/
(nothing - clean)
$ git status src/ 
On branch main
Your branch is up to date with 'origin/main'.
nothing to commit, working tree clean
```

### E7 — En lenguaje llano (coherente con las tablas)

Comprobamos con 8 pruebas automáticas que el banco de pruebas de antes estaba roto: al simular un activo solo, limitaba su inversión a un sexto del dinero cuando debía usar todo el. Ya reparado, medimos de nuevo: los gastos del sistema de recortes son reales pero mucho más pequeños que lo que dijimos antes (BTC pierde 70 puntos de rentabilidad anual, no 125). Lo más importante no cambia: medidos con la vara correcta, ninguno de los cinco detectores acierta más que el azar a predecir caídas de más del 10% en medio año (todos los IC contienen el 0). El oro es el peor: recorta el 70% justo cuando el oro subía (2008), y es el pico individual que domina siempre el agregado. Lo que sí funciona tras la reparación son los arreglos de diseño: cortar el recorte máximo al 30% reduce las operaciones a la mitad sin perder protección, la histéresis sobre la entrada ahorra 8 operaciones por 223€ de impuestos, y la rampa neutral corrige el salto brusco del dólar sin coste. La recomendación final no es "arreglar el detector": es bajarlo de categoría — usarlo solo como seguro de cola con topes, no como señal de techo por activo.
