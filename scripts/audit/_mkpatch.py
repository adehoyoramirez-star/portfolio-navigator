# -*- coding: utf-8 -*-
"""Genera scripts/audit/proposed_patches/*.diff SIN modificar src/.
Lee el archivo real (preservando CRLF) y emite un diff unificado (difflib).
"""
import difflib, io, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "src", "core", "risk", "cycleTopDetector.ts")
OUT = os.path.join(os.path.dirname(__file__), "proposed_patches")
os.makedirs(OUT, exist_ok=True)

with io.open(SRC, encoding="utf-8", newline="") as f:
    original = f.read().splitlines(keepends=True)
TEXT = "".join(original)
NL = "\r\n" if "\r\n" in TEXT[:4000] else "\n"


def make(name, title, repls):
    text = TEXT
    for old, new in repls:
        o = old.replace("\n", NL)
        n = new.replace("\n", NL)
        if o not in text:
            raise SystemExit("NO ENCONTRADO en %s:\n%r" % (name, o[:160]))
        text = text.replace(o, n, 1)
    new_lines = text.splitlines(keepends=True)
    diff = list(difflib.unified_diff(
        original, new_lines,
        fromfile="a/src/core/risk/cycleTopDetector.ts",
        tofile="b/src/core/risk/cycleTopDetector.ts",
        n=3,
    ))
    header = "# PROPUESTA (NO APLICADA) - %s\n# Generado por scripts/audit/_mkpatch.py (M4)\n" % title
    with io.open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as g:
        g.write(header)
        g.writelines(diff)
    print("escrito", name, "(%d lineas de diff)" % len(diff))


make("01_dxy_interpolation.diff",
     "Interpolacion del escalon DXY de EMXC (rampa que arranca en 0 en 103)",
     [(
"""  if (isValidReading(dxy, 50)) {
    if (dxy > 115) {
      topSignals += 3;
      reasons.push(`DXY ${dxy.toFixed(1)} \u2014 d\u00f3lar en niveles de crisis EM (M\u00e9xico 1994, Asia 1997, Argentina 2018)`);
    } else if (dxy > 110) {
      topSignals += 2.5;
      reasons.push(`DXY ${dxy.toFixed(1)} \u2014 d\u00f3lar extremadamente fuerte. Capital huyendo de emergentes.`);
    } else if (dxy > 106) {
      topSignals += 1.5;
      reasons.push(`DXY ${dxy.toFixed(1)} \u2014 d\u00f3lar fuerte. Presi\u00f3n significativa sobre emergentes y commodities.`);
    } else if (dxy > 103) {
      topSignals += 0.75;
      reasons.push(`DXY ${dxy.toFixed(1)} \u2014 d\u00f3lar apreci\u00e1ndose. Vigilar flujos EM.`);
    }
  }""",
"""  // FIX-CLIFF-DXY (propuesto M4): rampa continua que arranca en 0 EXACTAMENTE
  //   en DXY=103 (mismo punto que el escalon) y conserva los niveles de trim
  //   30/45/65/73% repartidos en 103-118. Elimina el salto de 30 pp a cambio de
  //   retrasar el primer tramo (ver m4_cliffs.ts: 4 cliffs -> 0).
  if (isValidReading(dxy, 50)) {
    const dxyScore = smoothScore(dxy, [
      [103, 0],
      [106, 0.75],
      [110, 1.5],
      [115, 2.5],
      [118, 3],
    ]);
    topSignals += dxyScore;
    if (dxy > 115)      reasons.push(`DXY ${dxy.toFixed(1)} \u2014 d\u00f3lar en niveles de crisis EM (M\u00e9xico 1994, Asia 1997, Argentina 2018)`);
    else if (dxy > 110) reasons.push(`DXY ${dxy.toFixed(1)} \u2014 d\u00f3lar extremadamente fuerte. Capital huyendo de emergentes.`);
    else if (dxy > 106) reasons.push(`DXY ${dxy.toFixed(1)} \u2014 d\u00f3lar fuerte. Presi\u00f3n significativa sobre emergentes y commodities.`);
    else if (dxy > 103) reasons.push(`DXY ${dxy.toFixed(1)} \u2014 d\u00f3lar apreci\u00e1ndose. Vigilar flujos EM.`);
  }""")])

make("03_caps_por_detector.diff",
     "Tope por detector: EMXC 30% (capa de viento en contra)",
     [("  const { multiplier, zone, trimPct } = multiplierFromScore(topSignals);\n\n  const parts: string[] = [];\n  if (isValidReading(dxy, 50)) parts.push(`DXY ${dxy.toFixed(1)}`);",
       "  const { multiplier, zone, trimPct: trimRaw } = multiplierFromScore(topSignals);\n  // FIX-CAP-EMXC (propuesto M4): tope duro 30% por detector (capa de viento en\n  //   contra, no techo). Ver C4/D1: cap30 reduce ops 455->213 en SEMIS a 0 coste.\n  const trimPct = Math.min(30, trimRaw);\n\n  const parts: string[] = [];\n  if (isValidReading(dxy, 50)) parts.push(`DXY ${dxy.toFixed(1)}`);")])

make("04_reclasificar_oro.diff",
     "Reclasifica el oro a capa de viento en contra (tope 20%)",
     [("  const trimPct = Math.round((1 - multiplier) * 100);\n\n  return {\n    asset: \"Gold (ETC)\",",
       "  // FIX-RECLASS-GOLD (propuesto M4): el oro NO es un techo: es viento en contra.\n  //   A4: fwd6m tras activar -10.4% vs incondicional +6.0% => el recorte llega tras\n  //   la subida, no antes. Tope duro 20%.\n  const trimPct = Math.min(20, Math.round((1 - multiplier) * 100));\n\n  return {\n    asset: \"Gold (ETC)\",")])

make("02_hysteresis_entrada.diff",
     "Histeresis sobre la ENTRADA (estado DXY) — requiere campo nuevo en CycleTopInputs",
     [("  brentOil?: number;           // $/barril \u2014 si >$95 la guerra/inflaci\u00f3n protege al oro \u2192 override HOLD\n",
       "  brentOil?: number;           // $/barril \u2014 si >$95 la guerra/inflaci\u00f3n protege al oro \u2192 override HOLD\n  emxcDxyActive?: boolean;     // FIX-HYST (propuesto M4): estado de histeresis DXY\n                               //   (entrar >103 / salir <101). Lo gestiona el dashboard.\n"),
      ("  if (isValidReading(dxy, 50)) {\n    if (dxy > 115) {",
       "  // FIX-HYST (propuesto M4): histeresis sobre la ENTRADA, no sobre el trim.\n  //   El estado entra en 103 y NO sale hasta 101 (banda 2 pt). Sube el score\n  //   solo mientras el r\u00e9gimen de d\u00f3lar fuerte sigue activo.\n  if (isValidReading(dxy, 50) && inputs.emxcDxyActive) {\n    if (dxy > 115) {")])

make("05_deuda_comentario_L805.diff",
     "Corrige el comentario obsoleto del peso 1.5x del DXY",
     [("// El DXY tiene peso 1.5\u00d7 sobre P/E porque es m\u00e1s predictivo en ciclos EM.",
       "// NOTA (M4): el DXY se SUMA como score, NO se multiplica por 1.5. El P/E de EMXC\n// fue ELIMINADO del scoring de techo (Jul-2026). El comentario anterior era obsoleto.")])

print("OK ->", OUT)
