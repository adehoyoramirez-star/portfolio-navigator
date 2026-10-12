// ============================================================
// scripts/audit/fase0_realcode.ts — FASE 0 (0.1, 0.2, 0.3)
// IMPORTA el código REAL de src/ — nada re-implementado.
// 0.1: tabla score → multiplier → trimPct → zone con detectCycleTops() real.
//      multiplierFromScore NO es exportable ⇒ la invocamos indirectamente a
//      través del detector BTC, invertiendo su rampa mvrvRatio ([[2,0],[3.5,1],
//      [4.5,2],[6,3],[7.5,3.5]]) para fijar topSignals exactos, y usando
//      btcRsiWeekly (rampa [[80,0],[85,2]]) para scores > 3.5.
// 0.2: EMXC con DXY (y + RSI-W 81) en 103.00/103.01/106.01/110.01/115.00/115.01
//      — comparaciones ESTRICTAS verificadas con el código real.
// Ejecutar: npx tsx scripts/audit/fase0_realcode.ts
// ============================================================
import { detectCycleTops, type CycleTopInputs } from "../../src/core/risk/cycleTopDetector";

// Inversa de la rampa mvrvRatio del detector BTC (líneas ~262-275 de src):
function ratioForScore(x: number): number {
  if (x <= 0) return 2.0;
  if (x <= 1) return 2.0 + 1.5 * x;        // [2.0→0, 3.5→1]  (1.5 ratio/score)
  if (x <= 2) return 3.5 + 1.0 * (x - 1);  // [3.5→1, 4.5→2]  (1.0 ratio/score)
  if (x <= 3) return 4.5 + 1.5 * (x - 2);  // [4.5→2, 6.0→3]  (1.5 ratio/score)
  return 6.0 + 3.0 * (x - 3);              // [6.0→3, 7.5→3.5] (3.0 ratio/score — FIX: slope 3.0, no 1.5)
}
function buildBTCInputs(score: number): CycleTopInputs {
  const inputs: CycleTopInputs = { bondYield10y: 4.0 };
  const mvr = score <= 3.5 ? ratioForScore(score) : 7.5;
  if (score > 0) (inputs as any).mvrvRatio = +mvr.toFixed(4);
  if (score > 3.5) {
    // rampa RSI-W BTC: [[80,0],[85,2]] → inversa: rsi = 80 + 2.5*(score-3.5)
    const rsi = Math.min(100, 80 + 2.5 * (score - 3.5));
    (inputs as any).btcRsiWeekly = +rsi.toFixed(2);
  }
  return inputs;
}

console.log("=== FASE 0.1: tabla A2 con el código REAL (detectCycleTops → detectBTCTop) ===");
console.log("score | mvrvRatio(alimentado) | multiplier | trimPct | zone");
for (let s = 0; s <= 5.001; s += 0.25) {
  const sv = +s.toFixed(2);
  const inputs = buildBTCInputs(sv);
  const sig = detectCycleTops(inputs).signals.find(x => x.ticker === "BTC-EUR")!;
  console.log(`${sv.toFixed(2).padStart(5)} | ${((inputs as any).mvrvRatio ?? "—").toString().padStart(14)} | ${sig.allocationMultiplier.toFixed(3).padStart(10)} | ${String(sig.trimPct).padStart(7)} | ${sig.zone}`);
}

// Verificación de interpolación lineal (no escalones): pendientes por segmento
console.log("\n=== 0.1b: interpolación vs escalones — test de pendiente ===");
const at = (score: number) => {
  const sig = detectCycleTops(buildBTCInputs(score)).signals.find(x => x.ticker === "BTC-EUR")!;
  return { m: sig.allocationMultiplier, trim: sig.trimPct, zone: sig.zone };
};
const a = at(1.0), b = at(1.25), c = at(1.5);
console.log(`score 1.00 → mult ${a.m.toFixed(3)} (ancla 0.55?)  NO: ancla [1.5,0.55]; [1.0] interpolado`);
console.log(`score 1.25 → mult ${b.m.toFixed(3)} — debe ser 0.55+(0.35-0.55)...  interp entre [1.0?].`);
console.log(`Espera: anclas son [0.5,0.75] y [1.5,0.55] ⇒ en 1.0 → ${a.m.toFixed(3)} (=media), en 1.25 → ${b.m.toFixed(3)} (=cuarto de camino), en 1.5 → ${c.m.toFixed(3)} (=ancla).`);
console.log(`Lineal CONFIRMADA si 1.25 ≈ (a+c)/2 = ${((a.m + c.m) / 2).toFixed(3)}`);
const d = at(2.75), e = at(3.0);
console.log(`score 2.75 → ${d.m.toFixed(3)} (entre anclas 2.5→0.35 y 3.5→0.20; lineal = 0.3125); 3.00 → ${e.m.toFixed(3)} (lineal = 0.275)`);
console.log(`zone con score 2.00 (mult 0.450): ${at(2.0).zone} — la zone depende del SCORE (≥0.5=CAUTION), no del multiplier`);
console.log(`zone con score 0.75 (mult 0.700): ${at(0.75).zone}`);

// ── 0.2: EMXC con código real ──────────────────────────────────
console.log("\n=== FASE 0.2: EMXC con el código REAL — comparaciones estrictas ===");
const emxcTrim = (dxy?: number, rsi?: number) => {
  const inputs: CycleTopInputs = { bondYield10y: 4.0 };
  if (dxy !== undefined) (inputs as any).dxy = dxy;
  if (rsi !== undefined) (inputs as any).emxcRsiWeekly = rsi;
  const sig = detectCycleTops(inputs).signals.find(x => x.ticker === "EMXC.DE")!;
  return { m: sig.allocationMultiplier, trim: sig.trimPct, zone: sig.zone, reason: sig.reason };
};
console.log("DXY     | RSI-W | score implied        | mult   | trim  | zone");
const cases: [number | undefined, number | undefined][] = [
  [103.00, undefined], [103.01, undefined], [103.01, 81],
  [106.00, undefined], [106.01, undefined], [106.01, 81],
  [110.00, undefined], [110.01, undefined], [110.01, 81],
  [115.00, undefined], [115.01, undefined], [115.01, 81],
  [115.01, 85.01],
];
for (const [dxy, rsi] of cases) {
  const r = emxcTrim(dxy, rsi);
  console.log(`${(dxy ?? "—").toString().padStart(7)} | ${(rsi ?? "—").toString().padStart(5)} | mult ${r.m.toFixed(3).padStart(6)} | trim ${String(r.trim).padStart(3)}% | ${r.zone}`);
}
console.log("\nEsperado según rampa real (anclas [0.5→0.75, 1.5→0.55, 2.5→0.35, 3.5→0.20, 5.0→0.10]):");
console.log("  103.01 → 0.75 → mult 0.70 trim 30% · +RSI81 (1.75) → mult 0.475? interpolación [1.5→0.55]-[2.5→0.35] en 1.75 = 0.475 → trim 53% (round)");
console.log("  110.01 → 2.5 → mult 0.35 trim 65% · +RSI81 (3.5) → mult 0.20 trim 80%");
console.log("  115.01 → 3.0 → mult 0.275 trim 73% · +RSI81 (4.0) → mult ~0.167 trim 83%");
console.log("  115.00 → >115 FALSE → 2.5 → mult 0.35 trim 65% (comparación ESTRICTA)");
