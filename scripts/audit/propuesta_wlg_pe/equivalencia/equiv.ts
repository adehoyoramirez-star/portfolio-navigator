// ================================================================
// Equivalencia HEAD vs working tree del detector de techo
// ================================================================
// Objetivo: demostrar que el cambio ESTRUCTURAL del paquete WLG (extraer las
// curvas de WLG a constantes INYECTABLES con default = calibración APROBADA)
// NO altera ninguna salida del detector. Compara `detectCycleTops` del commit
// BASE pre-paquete (copia congelada en este directorio) contra el de `src/` sobre un grid de
// inputs que cubre la ruta WLG (RSI × P/E × CAPE × shift × credit spread) y
// TODOS los demás detectores.
//
// Ejecutar desde scripts/:
//   npx tsx audit/propuesta_wlg_pe/equivalencia/equiv.ts
// Salida: "EQUIVALENCIA OK — N casos" (exit 0) o el listado de discrepancias (exit 1).
// ================================================================
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { detectCycleTops as current } from "../../../../src/core/risk/cycleTopDetector";
import { detectCycleTops as head } from "./head_cycleTopDetector";

// ── CHECK DE INTEGRIDAD de la copia congelada (§8.2 del informe) ─────────────
// La copia debe ser EXACTAMENTE el detector del commit BASE ANTERIOR al paquete
// A+D — el «antes» que compara la equivalencia estructural. Detecta que la copia
// se haya quedado obsoleta (o se haya tocado a mano) antes de dar por buena la
// comparación.
// NO se compara contra HEAD a propósito: HEAD se mueve en cada commit y ya
// contiene el propio cambio A+D, así que un check contra HEAD sería falso ya en
// el commit del paquete y no detectaría deriva real. El commit base es inmutable:
// por eso se ancla a un SHA.
const FROZEN_BASE = "5512770"; // = 4ab4417^ (padre del commit del paquete A+D)
const FROZEN_SRC = "src/core/risk/cycleTopDetector.ts";
const FROZEN_COPY = fileURLToPath(new URL("./head_cycleTopDetector.ts", import.meta.url));
const REGEN_CMD = `git show ${FROZEN_BASE}:${FROZEN_SRC} > scripts/audit/propuesta_wlg_pe/equivalencia/head_cycleTopDetector.ts`;
const lf = (s: string) => s.replace(/\r\n?/g, "\n"); // hash estable entre checkouts CRLF/LF

let baseSrc = "";
try {
  baseSrc = execFileSync("git", ["show", `${FROZEN_BASE}:${FROZEN_SRC}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
} catch {
  console.error(`[integridad] FALLO: no se pudo leer ${FROZEN_BASE}:${FROZEN_SRC} con git.`);
  console.error("[integridad] ¿Estás dentro del repo y con ese commit disponible (clon no superficial)?");
  console.error(`[integridad] Regenerar la copia: ${REGEN_CMD}`);
  process.exit(1);
}
const hBase = createHash("sha256").update(lf(baseSrc)).digest("hex");
const hCopy = createHash("sha256").update(lf(readFileSync(FROZEN_COPY, "utf8"))).digest("hex");
if (hBase !== hCopy) {
  console.error("[integridad] FALLO: la copia congelada NO es el detector del commit base.");
  console.error(`[integridad]   ${FROZEN_BASE}:${FROZEN_SRC} → sha256=${hBase}`);
  console.error(`[integridad]   ${FROZEN_COPY}`);
  console.error(`[integridad]   → sha256=${hCopy}`);
  console.error(`[integridad] Regenerar la copia: ${REGEN_CMD}`);
  process.exit(1);
}
console.log(`[integridad] copia congelada OK — idéntica a ${FROZEN_BASE}:${FROZEN_SRC} (sha256 ${hBase.slice(0, 12)}…)`);

type In = Record<string, number | undefined>;

const cases: In[] = [];

// 1) Ruta WLG completa: RSI × P/E
for (let rsi = 50; rsi <= 95; rsi += 0.25)
  for (let pe = 8; pe <= 30; pe += 0.5)
    cases.push({ bondYield10y: 4, wlgRsiWeekly: rsi, wlgPERatio: pe, wlgEpsGrowth: 3 });

// 2) Bordes exactos de las anclas + fallback CAPE + shift de régimen + credit spread
const rsis: (number | undefined)[] = [74.99, 75, 75.01, 79.99, 80, 80.01, 84.99, 85, 85.01, 99.99, 100, 0, undefined];
const pes: (number | undefined)[] = [12.99, 13, 13.01, 15.99, 16, 16.01, 19.99, 20, 20.01, 26.99, 27, 30, 0, undefined];
const capes: (number | undefined)[] = [10.99, 11, 11.01, 13.99, 14, 14.01, 40.5, undefined];
for (const rsi of rsis)
  for (const pe of pes)
    for (const cape of capes)
      for (const sh of [-1.5, 0, 1.5])
        for (const cs of [1.0, 1.2, 2.0, 4.0])
          cases.push({ bondYield10y: 4, wlgRsiWeekly: rsi, wlgPERatio: pe, wlgCAPE: cape, regimeShiftPE: sh, creditSpread: cs, wlgEpsGrowth: 3 });

// 3) Resto de detectores (no deben moverse)
for (let z = 0; z <= 9; z += 0.1) cases.push({ bondYield10y: 4, mvrvZScore: z });
for (let p = 0; p <= 6; p += 0.05) cases.push({ bondYield10y: 4, puellMultiple: p });
for (let u = 0.5; u <= 2; u += 0.005) cases.push({ bondYield10y: 4, uraniumSpotPrice: u, uraniumLTPrice: 1 });
for (let g = -0.5; g <= 3.5; g += 0.01) cases.push({ bondYield10y: 4, realYield10y: g });
for (let dx = 95; dx <= 120; dx += 0.05) cases.push({ bondYield10y: 4, dxy: dx });
for (let e = 60; e <= 90; e += 0.25) cases.push({ bondYield10y: 4, emxcRsiWeekly: e, emxcPERatio: 20 });
for (let s = 60; s <= 90; s += 0.25) cases.push({ bondYield10y: 4, soxRsiWeekly: s });
for (let b = 50; b <= 150; b += 0.5) cases.push({ bondYield10y: 4, brentOil: b, realYield10y: 1.0 });
cases.push({ bondYield10y: 4, goldCbPurchases: 1100, realYield10y: 1.0, dxy: 105, brentOil: 80 });
cases.push({ bondYield10y: 4 }); // vacío

// Canonicalización robusta del orden de claves
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort())
      : val,
  );

let mismatches = 0;
const shown: string[] = [];
for (const c of cases) {
  const a = canon(current({ ...c } as never));
  const b = canon(head({ ...c } as never));
  if (a !== b) {
    mismatches++;
    if (shown.length < 5) shown.push(`  input=${JSON.stringify(c)}\n    HEAD : ${b}\n    AHORA: ${a}`);
  }
}
console.log(`Casos comparados: ${cases.length}`);
console.log(`Discrepancias: ${mismatches}`);
for (const s of shown) console.log(s);

// Evidencia del cliff: el comportamiento APROBADO debe ser idéntico en ambos
const probe = (inp: In) => {
  const s = current({ ...inp } as never).signals.find(x => x.ticker === "0P00000WLG.F")!;
  const h = head({ ...inp } as never).signals.find(x => x.ticker === "0P00000WLG.F")!;
  return `RSI=${inp.wlgRsiWeekly ?? "—"} P/E=${inp.wlgPERatio ?? "—"} → HEAD trim=${h.trimPct}% zone=${h.zone} | AHORA trim=${s.trimPct}% zone=${s.zone}`;
};
console.log("\nMuestras (curva APROBADA = default en ambos):");
for (const inp of [{ bondYield10y: 4, wlgRsiWeekly: 74.99 }, { bondYield10y: 4, wlgRsiWeekly: 75 }, { bondYield10y: 4, wlgRsiWeekly: 76 }, { bondYield10y: 4, wlgPERatio: 15.99 }, { bondYield10y: 4, wlgPERatio: 16 }, { bondYield10y: 4, wlgPERatio: 17.9 }])
  console.log("  " + probe(inp as In));

if (mismatches > 0) { console.error("\nFALLO: el cambio estructural NO es comportamiento-neutro."); process.exit(1); }
console.log(`\nEQUIVALENCIA OK — ${cases.length} casos, 0 discrepancias (base ${FROZEN_BASE} ≡ working tree con la calibración APROBADA).`);
