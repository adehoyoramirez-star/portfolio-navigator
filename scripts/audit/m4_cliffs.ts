// ============================================================
// scripts/audit/m4_cliffs.ts — BLOQUE 4.1(a): antes/después del parche de
// interpolación, medido con la MISMA lógica de anclajes que src/
// (multiplierFromScore) pero SIN tocar src/.
//
// ANTES  = escalón real del detector (dxy > 103/106/110/115).
// DESPUÉS = rampa neutra que arranca en 0 en dxy=103 (mismo punto que el escalón)
//           y llega a los mismos valores de trim en 106/110/115.
// Métrica de éxito del parche: cliff ≥5pp → 0 en DXY, sin cambiar el trim en
// los anclajes 106/110/115.
// Ejecutar: cd scripts && npx tsx audit/m4_cliffs.ts
// ============================================================

// multiplierFromScore (idéntico a src/core/risk/cycleTopDetector.ts L90-110)
const ANCH: [number, number][] = [[0, 1.0], [0.5, 0.75], [1.5, 0.55], [2.5, 0.35], [3.5, 0.20], [5.0, 0.10]];
function multiplierFromScore(score: number): number {
  if (score <= 0) return 1.0;
  let m = ANCH[ANCH.length - 1][1];
  for (let i = 1; i < ANCH.length; i++) if (score <= ANCH[i][0]) { m = ANCH[i - 1][1] + (ANCH[i][1] - ANCH[i - 1][1]) * (score - ANCH[i - 1][0]) / (ANCH[i][0] - ANCH[i - 1][0]); break; }
  return Math.max(0.05, Math.min(1, m));
}
const trimOf = (pts: number) => Math.round((1 - multiplierFromScore(pts)) * 100);

// ANTES — escalón real (precedencia descendente, estricto >)
function ptsBefore(dxy: number): number {
  if (dxy > 115) return 3; else if (dxy > 110) return 2.5; else if (dxy > 106) return 1.5; else if (dxy > 103) return 0.75; return 0;
}
// DESPUÉS — rampa neutra: nudos en pts = (103→0.75, 106→1.5, 110→2.5, 115→3),
// extrapolada hacia abajo hasta 0 en 103 (pendiente del primer tramo 0.75/(3))
function ptsAfter(dxy: number): number {
  const K: [number, number][] = [[103, 0], [106, 0.75], [110, 1.5], [115, 2.5], [118, 3]];
  if (dxy <= K[0][0]) return 0;
  if (dxy >= K[K.length - 1][0]) return K[K.length - 1][1];
  for (let i = 1; i < K.length; i++) if (dxy <= K[i][0]) return K[i - 1][1] + (K[i][1] - K[i - 1][1]) * (dxy - K[i - 1][0]) / (K[i][0] - K[i - 1][0]);
  return 0;
}
function sweep(fn: (x: number) => number, from: number, to: number, step: number) {
  let maxJump = 0, at = ""; const cliffs: string[] = [];
  let prev = trimOf(fn(from));
  for (let x = from + step; x <= to + 1e-9; x += step) {
    const cur = trimOf(fn(x));
    if (Math.abs(cur - prev) >= 5) cliffs.push(`x=${x.toFixed(2)}: ${prev}%→${cur}% (Δ${Math.abs(cur - prev)}pp)`);
    if (Math.abs(cur - prev) > maxJump) { maxJump = Math.abs(cur - prev); at = `${(x - step).toFixed(2)}→${x.toFixed(2)}`; }
    prev = cur;
  }
  return { maxJump, at, cliffs };
}
console.log("=== 4.1(a) DXY: ANTES (escalón real) vs DESPUÉS (rampa neutra) ===");
const b = sweep(ptsBefore, 100, 120, 0.01);
const a = sweep(ptsAfter, 100, 120, 0.01);
console.log(`ANTES  : maxΔtrim=${b.maxJump}pp en ${b.at} · cliffs≥5pp=${b.cliffs.length}`);
for (const c of b.cliffs) console.log("  " + c);
console.log(`DESPUÉS: maxΔtrim=${a.maxJump}pp en ${a.at || "—"} · cliffs≥5pp=${a.cliffs.length}`);
for (const c of a.cliffs) console.log("  " + c);
console.log("\nCONSECUENCIA (declarada): arrancar en 0 exactamente en 103 y quitar el cliff");
console.log("OBLIGA a retrasar el primer tramo (no se puede tener 0 en 103 y 30% en 103+).");
console.log("La rampa conserva TODOS los niveles de trim (30/45/65/73%) pero los reparte en 103→118.");
for (const x of [100, 102.99, 103.0, 104.75, 106, 108, 110, 115, 118]) console.log(`  DXY ${x.toFixed(2).padStart(7)}: antes ${String(trimOf(ptsBefore(x))).padStart(3)}% · después ${String(trimOf(ptsAfter(x))).padStart(3)}%`);
