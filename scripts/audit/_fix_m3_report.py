# -*- coding: utf-8 -*-
import io, re, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
P = "audit/INFORME_FINAL.md"
s = io.open(P, encoding="utf-8").read()

# ---------- 1) Bloque de tablas regeneradas (salida literal del generador v4) ----------
gen = io.open("audit/_gen_out.txt", encoding="utf-8").read()
gen = gen.split("=== VERIFICACIÓN")[0].rstrip() + "\n"
block = (
    "### D0 — Tablas REGENERADAS (salida literal de `gen_report_tables.ts` v4)\n\n"
    "Denominador ÚNICO en todas las tablas: **semanas CON input** (`fase2_series.json:summary`,\n"
    "n = 843/1679/1241/2441/756). El grid completo de 2441 semanas NO se usa para porcentajes\n"
    "de actividad (era la doble convención que producía las 42 discrepancias de la ronda M2).\n"
    "ON/OFF se toman del harness REPARADO (`m3_output.txt`), no del harness /6 retirado.\n\n"
    "```\n" + gen + "```\n\n"
)
anchor = "### E2 — Clasificacion FINAL"
assert anchor in s, "ancla E2 no encontrada"
s = s.replace(anchor, block + anchor, 1)

# ---------- 2) §3.4 retirada ----------
def swap_section(text, start_marker, end_marker, new):
    i = text.index(start_marker)
    j = text.index(end_marker, i)
    return text[:i] + new + text[j:]

s = swap_section(
    s, "### 3.4 Backtest por activo ON vs OFF", "### 3.5 BTC",
    "### 3.4 Backtest por activo ON vs OFF — **TABLA RETIRADA (bug /6; ver §1bis y §11-D0)**\n\n"
    "La tabla ON/OFF de esta sección procedía del harness defectuoso (target = NAV/6) y queda **RETIRADA**\n"
    "según la regla M3 #4: no se cita ni se usa para clasificar. La tabla reparada (target = (1−trim)·NAV)\n"
    "está en §1bis (old-vs-new) y §11-D0 (regenerada completa). Síntesis reparada OFF→ON-TBILL (pp de CAGR):\n"
    "**BTC −70.7**, SEMIS −3.1, ORO −5.0, EMXC −0.2, WLG −0.4 (las cifras −134.7/−10.6/−7.8/−6.5/−8.4 pp\n"
    "de esta sección eran artefacto del /6).\n\n")

# ---------- 3) §3.9 retirada ----------
s = swap_section(
    s, "### 3.9 Cartera 6 sleeves", "---\n\n## 4. FASE 3",
    "### 3.9 Cartera 6 sleeves — **TABLA RETIRADA (bug /6; ver §11-D1)**\n\n"
    "La cartera de esta sección (OFF 26.8% / ON 17.1% CAGR) procedía del harness defectuoso y queda **RETIRADA**.\n"
    "Medición reparada (§11-D1): TBILL CAGR 5.11% (aprox), vol 7.9%, MaxDD −30.4%, 589 ops, 22 020 € de impuestos.\n"
    "La conclusión M1 \"los trims cuestan −9.6 pp de CAGR a nivel cartera\" queda **INVALIDADA**; la medida correcta\n"
    "es la comparación OFF vs ON por sleeve (§11-D0).\n\n")

# ---------- 4) §4.3 retirada ----------
s = swap_section(
    s, "### 4.3 Topes por familia", "### 4.4 Presupuesto agregado",
    "### 4.3 Topes por familia — **RETIRADO (harness /6; ver §11-C4)**\n\n"
    "Topes re-medidos con el motor reparado (turnover/impuestos primarios, CAGR secundario) en §11-C4:\n"
    "ORO cap30 7.05% vs raw 4.17%; SEMIS cap30 13.08% vs raw 11.94%. La tabla de esta sección\n"
    "(ORO 2.42%→2.85%) usaba el harness roto.\n\n")

# ---------- 5) §4.1 backtest EMXC retirado ----------
s = s.replace(
    "Backtest EMXC (EEM): STEP `CAGR 3.39% · MaxDD −13.4% · 667 ops · €1 566` vs RAMP `3.37% · −13.4% · 667 · €1 645`.",
    "Backtest EMXC (EEM) **[RETIRADO: harness /6]**: la re-medición reparada está en §11-C2/C3 "
    "(rampa neutra; el cliff DXY sigue siendo un defecto de robustez, no de P&L).",
    1)

# ---------- 6) §5 TABLA RESUMEN ----------
s = swap_section(
    s, "## 5. TABLA RESUMEN", "## 6. Clasificación por detector",
    "## 5. TABLA RESUMEN (corregida en M3)\n\n"
    "> Las filas ON/OFF de M1/M2 están retiradas. Los veredictos de esta tabla usan sólo §11 (M3).\n\n"
    "| Punto | Veredicto | Evidencia (número) | Acción |\n"
    "|---|---|---|---|\n"
    "| Cifras ON/OFF de M1/M2 | RETIRADAS | harness /6 (§1bis) | usar `m3_output.txt` |\n"
    "| \"overlay destruye −124.7 pp\" | REFUTADO | BTC OFF 138.14% vs ON-TBILL 67.43% (−70.7 pp, expo 87.0%) | recalibrar |\n"
    "| EMXC MaxDD ON −14.1% | REFUTADO | MaxDD ON=OFF=−62.6% (DXY máx 84.63 < 103) | limpiar |\n"
    "| Ningún detector bate la tasa base | CONFIRMADO | A2: 5/5 con IC90 del Δ conteniendo 0 | sacar del techo |\n"
    "| Separación 26 sem → N cae | CONFIRMADO | A1: BTC 21→8, SEMIS 38→16, ORO/EMXC →2 | N<5 = PRIOR con tope |\n"
    "| Cliff DXY 103 (30 pp) | CONFIRMADO | §1.2; barrido C1: 18 cliffs ≥5 pp | interpolar |\n"
    "| Rampa NEUTRA (0 en DXY≤103) | CONFIRMADO | C2: 0% en 102.9 (la vieja daba 26%) | adoptar |\n"
    "| Histéresis sobre la ENTRADA | CONFIRMADO | C3: ops 34→26, fricción 152→101 € | adoptar tras rampa |\n"
    "| Cap 30% por familia | CONFIRMADO | C4: ORO 4.17→7.05%; SEMIS ops 455→213 | adoptar |\n"
    "| Trim agregado ponderado | CONFIRMADO | D2: 2022 medio 9.3 pp vs máx indiv 66% (ORO) | no sumar trims |\n"
    "| WLG P/E fwd | NO VERIFICADO | sin vintage; con P/E=20 daría trim 45% hoy | reclasificar con tope |\n"
    "| Uranio Spot/LT | NO VERIFICADO | input no reconstruible | declarar |\n"
    "| Formula std MVRV Z en producción | NO VERIFICADO | L121 sólo recibe un Z ya normalizado | instrumentar |\n\n")

# ---------- 7) §6 clasificación (categorías válidas) ----------
s = swap_section(
    s, "## 6. Clasificación por detector", "## 7. Ranking",
    "## 6. Clasificación final por detector (M3 — categorías válidas)\n\n"
    "> Categorías permitidas: VALIDADO (recorte libre) / PRIOR (con tope) / NO VERIFICADO (con tope) /\n"
    "> SACAR DEL RECORTE DE TECHO. \"RECALIBRAR\" NO es categoría. N<5 (gap 26 sem) ⇒ PRIOR con tope.\n\n"
    "| Detector | N (gap 52) | Clase FINAL | Justificación (número) |\n"
    "|---|---|---|---|\n"
    "| BTC | 6 | **PRIOR con tope 40%** | A2: Δ=−42.4 pp, IC90 [−54.9, 45.1] (tasa base 54.9%). Fallos 2021-11 (3%) y 2025-10 (0%). |\n"
    "| SEMIS | 9 | **PRIOR con tope 40%** | A2: Δ=−10.7 pp, IC90 [−42.0, 58.0]. 38.6% del tiempo activo. |\n"
    "| EMXC | 2 | **PRIOR con tope 40%** | Regla N<5. 2022-2025 = un solo régimen. |\n"
    "| ORO | 2 | **SACAR DEL RECORTE DE TECHO** | A4: fwd6m tras activar −10.4% vs incond +6.0%. D2: ORO domina siempre el agregado. |\n"
    "| WLG | 5 | **NO VERIFICADO con tope 20%** | P/E fwd sin point-in-time; con P/E=20 daría trim 45% hoy. |\n"
    "| URANIO | 0 | **NO VERIFICADO con tope 40%** | Input Spot/LT no reconstruible; queda siempre SAFE. |\n\n"
    "**NINGÚN detector queda VALIDADO.** El sistema completo queda como capa de cola sin calibrar.\n\n")

# ---------- 8) §7 ranking con números reparados ----------
s = swap_section(
    s, "## 7. Ranking de 3 cambios", "\n---\n\n## 8.",
    "## 7. Ranking de 3 cambios (números reparados)\n\n"
    "1. **Sacar el ORO del recorte de techo / caparlo a 30%.** Activo 65.5% del tiempo, 2 episodios (a 26/52 sem),\n"
    "   premisa DFII10 sin respaldo (A4 fwd6m −10.4% vs +6.0% incondicional). Cap 30% con el motor reparado:\n"
    "   CAGR 4.17% → 7.05% y ops 432 → 219. *(§11-C4, §11-D2)*\n"
    "2. **Interpolar los cliffs por rampa NEUTRA** (0 en DXY≤103; anclas reales 106/110/115). Elimina los saltos de\n"
    "   30-35 pp a coste de P&L ≈ 0 y corrige el falso 26% en DXY 102.9 de la rampa antigua. Habilita la histéresis.\n"
    "   *(§11-C1, §11-C2)*\n"
    "3. **Reclasificar WLG a NO VERIFICADO con tope y bajar todo el sistema a capa de cola.** Ningún detector bate\n"
    "   la tasa base (A2: 5/5 IC90 del Δ conteniendo 0). La histéresis sobre la ENTRADA ahorra 8 ops y 223 € de\n"
    "   impuestos; el trim agregado debe ir PONDERADO, no sumado. *(§11-A2, §11-C3, §11-D2, §11-E2)*\n\n")

# ---------- 9) §10 en una frase ----------
s = swap_section(
    s, "## 10. En una frase", "\n---\n\n## 11.",
    "## 10. En una frase (corregida en M3)\n\n"
    "**El sistema de techos de ciclo no es un detector de techos: es un seguro de cola caro y sin calibrar.**\n"
    "Con el harness reparado (target = (1−trim)·NAV, 8/8 tests PASS) el coste real del recorte es mucho menor que\n"
    "el que reportó M2 (BTC OFF→ON-TBILL −70.7 pp de CAGR, no −134.7 pp; EMXC MaxDD ON=OFF=−62.6%), pero el\n"
    "hallazgo central no cambia y de hecho se refuerza: con separación de 26 semanas **ningún** detector supera la\n"
    "tasa base (los cinco IC90 del diferencial contienen 0) y el ORO —activo 65.5% del tiempo— es el que más recorta\n"
    "y siempre domina el trim agregado. Lo que sí funciona tras la reparación son las correcciones de diseño:\n"
    "capar el recorte a 30%, usar la rampa neutra en el DXY y aplicar la histéresis sobre la entrada. La recomendación\n"
    "final no es \"arreglar el detector\": es bajarlo de categoría — PRIOR/NO VERIFICADO con tope, capa de cola.\n\n")

# ---------- 10) nota §3.1: una sola convención ----------
s = s.replace(
    "La verificación del generador remonta esta limitación.",
    "La verificación del generador (v4, ronda M3) remonta esta limitación: el generador usa la MISMA convención "
    "(semanas con input, desde `summary`) en todas las tablas.",
    1)

io.open(P, "w", encoding="utf-8").write(s)
print("OK — informe corregido. Lineas:", s.count("\n") + 1)
