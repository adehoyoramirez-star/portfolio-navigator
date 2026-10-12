// ============================================================
// scripts/audit/gen_report_tables.ts — B3 (v4, ronda M3)
// Regenera TODAS las tablas de INFORME_FINAL.md DESDE LOS DATOS:
//   - audit/fase2_series.json  → summary (denominador ÚNICO = "semanas con input"),
//                                episodes, peaks
//   - audit/m3_output.txt      → ON/OFF del harness REPARADO (target=(1−trim)·NAV),
//                                cartera D1 y variantes C3/C4
// y compara cada tabla contra INFORME_FINAL.md VALOR A VALOR.
//
// Regla M3 #6: si el informe y el generador discrepan, se corrige el INFORME.
// El generador NO justifica discrepancias como inocuas: o el token está en el
// informe (OK) o se lista como discrepancia y el informe se arregla.
//
// Convención ÚNICA de denominador (antes había dos): todos los porcentajes de
// actividad (>0 / >20 / >35) y los forward medios usan n = semanas CON INPUT
// (summary.n: BTC 843, SEMIS 1679, ORO 1241, EMXC 2441, WLG 756). El grid
// completo de 2441 semanas NO se usa para porcentajes.
//
// Ejecutar: npx tsx scripts/audit/gen_report_tables.ts  (cwd = scripts/)
// ============================================================
import { readFileSync, writeFileSync } from "fs";

const f2 = JSON.parse(readFileSync("audit/fase2_series.json", "utf8"));
const m3 = readFileSync("audit/m3_output.txt", "utf8").split("\n");
const informeRaw = readFileSync("audit/INFORME_FINAL.md", "utf8");
// Normalizar el informe: U+2212 '−' → '-'; quitar separadores de miles; quitar '€'.
const informe = informeRaw.replace(/\u2212/g, "-").replace(/(\d) (\d{3})(\D|$)/g, "$1$2$3").replace(/€/g, "");

const p1 = (x: number) => x.toFixed(1) + "%";
const sign = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1) + "%";

// ── TABLA 1: actividad + episodios + bootstrap + forwards (TODO de summary) ──
const t1: string[] = [];
for (const det of ["BTC", "SEMIS", "ORO", "EMXC", "WLG"] as const) {
  const s = f2.summary[det];
  if (!s) continue;
  t1.push(
    `${det} | n=${s.n} | desde ${s.firstInput.slice(0, 7)} | >0=${p1(s.pctTrim0)} | >20=${p1(s.pctTrim20)} | >35=${p1(s.pctTrim35)} | max=${s.maxTrim}% ` +
    `| N=${s.episodes} | dur=${s.meanDur.toFixed(1)} | acierto=${s.hits}/${s.episodes} (${s.bootHit.toFixed(1)}%) | IC90=[${s.bootLo.toFixed(1)},${s.bootHi.toFixed(1)}] ` +
    `| fwd3m=${sign(s.meanFwd3m * 100)} fwd6m=${sign(s.meanFwd6m * 100)} fwd12m=${sign(s.meanFwd12m * 100)}`
  );
}
t1.push("URANIO | NO VERIFICADO (input Spot/LT no reconstruible) — excluido de FASE 2 y de cartera");

// ── TABLA 2: ON/OFF del harness REPARADO (m3_output.txt, §0.1+0.3) ──
const t2: string[] = [];
for (const line of m3) {
  const c = line.split("|").map(s => s.trim());
  if (c.length !== 11) continue;
  if (!/^(BTC|SEMIS|ORO|EMXC|WLG)$/.test(c[0])) continue;
  if (!/^(OFF|ON-CASH0|ON-TBILL)$/.test(c[1])) continue;
  const num = (s: string) => s.replace(/[€%\s]/g, "").replace(",", ".");
  t2.push(`${c[0]} ${c[1]} | CAGR=${num(c[2])}% vol=${num(c[3])}% MaxDD=${num(c[4])}% ops=${num(c[5])} impuestos=${num(c[6])} spreads=${num(c[7])} expoMedia=${num(c[8])}% expo<50=${num(c[9])}%`);
}

// ── TABLA 3: picos locales BTC (f2.peaks) ──
const t3: string[] = [];
for (const key of Object.keys(f2.peaks ?? {})) {
  const p = f2.peaks[key];
  t3.push(`pico ${key} ${p.peek_at} | precio=${p.P ?? "?"} | Z=${p.Z} Puell=${p.Puell} | trim pico=${p.trim[0]}% | -30d=${p.trim[1]}% -60d=${p.trim[2]}% -90d=${p.trim[3]}%`);
}

// ── TABLA 4: cartera D1 (m3_output.txt) ──
const t4: string[] = [];
for (const line of m3) {
  const m = line.match(/^\s*(TBILL|CASH0|TBILL-gross)\s+\|\s+CAGR\s+([\d.]+)%\(aprox\)\s+\|\s+vol\s+([\d.]+)%\s+\|\s+MaxDD\s+(-[\d.]+)%\s+\|\s+ops\s+(\d+)\s+\|\s+impuestos€\s+(\d+)\s+\|\s+spreads€\s+(\d+)/);
  if (m) t4.push(`${m[1]} | CAGR=${m[2]}% vol=${m[3]}% MaxDD=${m[4]}% ops=${m[5]} impuestos=${m[6]} spreads=${m[7]} (aprox)`);
}

// ── TABLA 5: variantes C3 (histéresis entrada) + C4 (topes) de m3_output.txt ──
const t5: string[] = [];
for (const line of m3) {
  const h = line.match(/^\s*(raw \(step\)|\+hyst ENTRADA)\s+CAGR\s+([\d.]+)%\s+·\s+MaxDD\s+(-[\d.]+)%\s+·\s+ops\s+(\d+)\s+·\s+impuestos€\s+(\d+)\s+·\s+spreads€\s+(\d+)/);
  if (h) t5.push(`${h[1]} | CAGR=${h[2]}% MaxDD=${h[3]}% ops=${h[4]} impuestos=${h[5]} spreads=${h[6]}`);
  const cap = line.match(/^\s*(raw|cap30|cap40)\s+ops=(\d+)\s+·\s+impuestos€\s+(\d+)\s+·\s+spreads€\s+(\d+)\s+·\s+CAGR\s+([\d.]+)%\s+·\s+MaxDD\s+(-[\d.]+)%/);
  if (cap) t5.push(`cap | ${cap[1]} | ops=${cap[2]} impuestos=${cap[3]} spreads=${cap[4]} CAGR=${cap[5]}% MaxDD=${cap[6]}%`);
}

// ── escribir tablas ──
const tables = [t1, t2, t3, t4, t5].map(t => t.join("\n")).join("\n\n===== TABLE =====\n\n");
writeFileSync("audit/_gen_tables.txt", tables);
console.log(tables);

// ── VERIFICACIÓN valor a valor contra el informe ──
const missing: string[] = [];
const numerics = (s: string) => s.match(/\d+(?:[.,]\d+)?/g) ?? [];
for (const [ti, block] of [t1, t2, t3, t4, t5].entries()) {
  for (const row of block) {
    for (const tok of numerics(row)) {
      const t = tok.replace(",", ".");
      if (/^(19|20)\d{2}(-\d{2})?$/.test(t)) continue; // fecha/año
      if (!informe.includes(t)) missing.push(`t${ti + 1}  ${t}  → "${row.slice(0, 80)}"`);
    }
  }
}
const uniq = [...new Set(missing)];
console.log("\n=== VERIFICACIÓN (números generados vs INFORME_FINAL.md) ===");
if (!uniq.length) console.log("OK — 0 discrepancias: todos los números de las 5 tablas aparecen en INFORME_FINAL.md");
else {
  console.log(`DISCREPANCIAS: ${uniq.length}`);
  uniq.forEach(m => console.log("  " + m));
  console.log("\nPOR REGLA M3 #6 estas discrepancias se corrigen EN EL INFORME (no se clasifican como inocuas).");
}
console.log("\n[escrito] audit/_gen_tables.txt");
