// ================================================================
// scope_b.ts — ALCANCE de la opción (b): cambiar la REGLA DE FRONTERA
// de smoothScore (`x <= primer ancla ⇒ 0`).
//
// NATURALEZA: script de ANÁLISIS. NO implementa el cambio (b), no toca el
// motor. Solo INVENTARÍA los acantilados de frontera vigentes, llamando al
// detector REAL sobre un barrido fino por cada input con curva propia: para
// cada clave, el mayor |Δtrim| entre dos muestras consecutivas y dónde ocurre.
//
// Lectura: un |Δtrim| > 5 pp en un paso fino (0.01) = discontinuidad de
// frontera en el primer ancla. Bajo la interpretación (ii) de (b) — «x = a1 ⇒
// score(a1)» — solo se mueven esas curvas. Bajo (i) — «extender la rampa por
// debajo de a1» — se mueve ADEMÁS el tramo sub-ancla de TODAS las curvas, que
// es exactamente el tramo que este barrido marca como «0 pp» (sin señal).
//
// Ejecutar desde scripts/:  npx tsx audit/propuesta_wlg_pe/scope_b.ts
// ================================================================
import {
  detectCycleTops,
  type CycleTopInputs,
} from "../../../src/core/risk/cycleTopDetector";

type Probe = { key: keyof CycleTopInputs; ticker: string; from: number; to: number; step: number };
const PROBES: Probe[] = [
  { key: "wlgRsiWeekly", ticker: "0P00000WLG.F", from: 40, to: 100, step: 0.01 },
  { key: "wlgPERatio", ticker: "0P00000WLG.F", from: 5, to: 35, step: 0.01 },
  { key: "wlgCAPE", ticker: "0P00000WLG.F", from: 5, to: 35, step: 0.01 },
  { key: "mvrvZScore", ticker: "BTC-EUR", from: 0, to: 10, step: 0.01 },
  { key: "mvrvRatio", ticker: "BTC-EUR", from: 1, to: 9, step: 0.01 },
  { key: "puellMultiple", ticker: "BTC-EUR", from: 0, to: 8, step: 0.01 },
  { key: "btcRsiWeekly", ticker: "BTC-EUR", from: 40, to: 100, step: 0.01 },
  { key: "dxy", ticker: "EMXC.DE", from: 90, to: 130, step: 0.01 },
  { key: "emxcRsiWeekly", ticker: "EMXC.DE", from: 40, to: 100, step: 0.01 },
  { key: "soxRsiWeekly", ticker: "VVSM.DE", from: 40, to: 100, step: 0.01 },
  { key: "soxSpyRelativeStrength", ticker: "VVSM.DE", from: -4, to: 4, step: 0.01 },
  { key: "realYield10y", ticker: "PPFB.DE", from: -2, to: 5, step: 0.01 },
  { key: "brentOil", ticker: "PPFB.DE", from: 40, to: 140, step: 0.01 },
  { key: "goldCbPurchases", ticker: "PPFB.DE", from: 0, to: 2000, step: 1 },
  { key: "uraniumSpotPrice", ticker: "URNU.DE", from: 0.5, to: 2.0, step: 0.005 },
];

const trimAt = (key: keyof CycleTopInputs, ticker: string, x: number): number => {
  const inp: CycleTopInputs = { bondYield10y: 4.0 } as CycleTopInputs;
  (inp as Record<string, unknown>)[key as string] = x;
  if (key === "uraniumSpotPrice") (inp as Record<string, unknown>).uraniumLTPrice = 1;
  if (key === "realYield10y") inp.inflationBreakeven = 0; // fuerza ruta directa
  // Brent/CB solo actúan como RELIEF sobre un trim de oro ya existente: activamos
  // el tipo real para que la ruta del oro esté viva y la fila sea informativa.
  if (key === "brentOil" || key === "goldCbPurchases") inp.realYield10y = 2;
  const out = detectCycleTops(inp);
  return out.signals.find(s => s.ticker === ticker)?.trimPct ?? 0;
};

console.log("=== ALCANCE DE (b): acantilados de frontera vigentes por input (detector REAL) ===");
console.log("clave | ticker | max|Δtrim| en un paso fino | dónde | trim(izq)→trim(der) | trim en el extremo alto");
const rows: string[] = [];
for (const p of PROBES) {
  let best = 0, bestX = NaN, bestA = 0, bestB = 0, prev = trimAt(p.key, p.ticker, p.from), nJumps = 0;
  const dec = Math.max(0, Math.ceil(-Math.log10(p.step)));
  for (let i = 1; ; i++) {
    const x = Number((p.from + i * p.step).toFixed(dec)); // índice entero: evita deriva flotante en el extremo
    if (x > p.to + 1e-9) break;
    const cur = trimAt(p.key, p.ticker, x);
    const d = Math.abs(cur - prev);
    if (d >= 5) nJumps++;
    if (d > best) { best = d; bestX = x; bestA = prev; bestB = cur; }
    prev = cur;
    if (i > 100000) break; // guarda anti-bucle
  }
  const hi = trimAt(p.key, p.ticker, p.to);
  rows.push(`${String(p.key).padEnd(26)} | ${p.ticker.padEnd(12)} | ${best.toFixed(1).padStart(5)} pp | x=${bestX.toFixed(3).padStart(7)} | ${bestA.toFixed(0).padStart(3)}% → ${bestB.toFixed(0).padStart(3)}% | trim(x=${p.to})=${hi}% · saltos≥5pp=${nJumps}`);
}
for (const r of rows) console.log(r);

console.log("\nNota: las claves con max|Δtrim| = 0 pp no tienen frontera activa en su rango útil");
console.log("(su primer ancla tiene score 0, o existe un guard explícito antes de smoothScore).");
