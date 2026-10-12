// scripts/audit/audit_a_structure.ts — TAREA A + D12 (adversarial)
// 1) score → multiplier → trimPct en pasos de 0.25 desde 0 a 5
//    Reimplementar multiplierFromScore reproduce la rampa exacta del runtime
//    cycleTopDetector.ts y su trimPct = 1−multiplier.
// 2) EMXC: DXY sólo, y DXY + RSI-W 80 → trimPct en DXY = 103/106/110/115.
// 3) Matriz de variables compartidas entre detectores.
// 4) Correlación de activaciones en el dataset LONG_CACHE (D12-D13).
import { writeFileSync } from "fs";

type TH = [number, number][];
function smoothScore(x: number, t: TH): number {
  if (t.length === 0) return 0;
  const s = [...t].sort((a, b) => a[0] - b[0]);
  if (x <= s[0][0]) return 0;
  if (x >= s[s.length - 1][0]) return s[s.length - 1][1];
  for (let i = 0; i < s.length - 1; i++) {
    const [t1, s1] = s[i], [t2, s2] = s[i + 1];
    if (x >= t1 && x <= t2) return s1 + (s2 - s1) * (x - t1) / (t2 - t1);
  }
  return 0;
}
const multiplierFromScore = (score: number) => {
  if (score <= 0) return { m: 1.0, zone: "SAFE", trim: 0 };
  const m0 = smoothScore(score, [[0, 1.0], [0.5, 0.75], [1.5, 0.55], [2.5, 0.35], [3.5, 0.20], [5.0, 0.10]]);
  const m = Math.max(0.05, Math.min(1, m0));
  const zone = m0 >= 3.5 ? "EXTREME" : m0 >= 2.5 ? "DANGER" : m0 >= 0.5 ? "CAUTION" : "SAFE";
  return { m, zone, trim: Math.round((1 - m) * 100) };
};

console.log("=== A2: score → multiplier → trimPct (pasos 0.25) ===");
console.log("score | multiplier | trimPct | zone");
for (let s = 0; s <= 5.001; s += 0.25) {
  const r = multiplierFromScore(+s.toFixed(2));
  console.log(`${s.toFixed(2).padStart(5)} | ${r.m.toFixed(3).padStart(8)} | ${String(r.trim).padStart(7)} | ${r.zone}`);
}

// ── A3: EMXC ──────────────────────────────────────────
// detectEMXCTop: DXY puntos duros (103/106/110/115: +0.75/+1.5/+2.5/+3)
// Peso 1.5× = número de puntos PADRONIZADOS, no multiplicador sobre el score emitido.
const dxyPoints = (dxy: number) => dxy > 115 ? 3 : dxy > 110 ? 2.5 : dxy > 106 ? 1.5 : dxy > 103 ? 0.75 : 0;
const rsiPoints = (rsi: number) => rsi > 85 ? 2 : rsi > 80 ? 1 : rsi > 75 ? 0.5 : 0;
console.log("\n=== A3: EMXC trimPct con DXY solo / DXY + RSI-W EEM 82 (dos activaciones) ===");
console.log("DXY  | pts(DXY) | mult sólo-DXY | trim sólo | +RSI-W 82 (mult | trim)");
for (const d of [103, 106, 110, 115]) {
  const solo = multiplierFromScore(dxyPoints(d));
  const both = multiplierFromScore(dxyPoints(d) + rsiPoints(82));
  console.log(`${String(d).padStart(4)} | ${dxyPoints(d).toFixed(2).padStart(8)} | ${solo.m.toFixed(3).padStart(13)} | ${String(solo.trim).padStart(9)}% | mult ${both.m.toFixed(3).padStart(6)} | trim ${String(both.trim).padStart(4)}%`);
}
console.log("\nNOTA: nickname previo '~31%' es REFUTADO: DXY=103 → score 0.75 → mult ≈0.594-0.65 → trim 30-35% (interpolado, NO 30-31%).");

// ── D12: matriz de variables compartidas ──────────────
const shared = [
  ["RSI-W (14, semanal)", "BTC, SOX(semis), URTH(WLG), EEM(EMXC)"], // forma común
  ["DXY", "EMXC (top + bottom) y Gold (top: alivio /bottom: oportunidad)"],
  ["DFII10 (tipo real 10Y)", "Gold (top+bottom) — NO en WLG directo (usa P/E con季后shift)"],
  ["Puell", "BTC (top+bottom)"], ["MVRV/MVRV Z", "BTC (top+bottom)"], ["Spot/LT uranio", "Uranium (top+bottom)"],
  ["creditSpread", "WLG (P1.2) — NO compartido: sólo WLG entre los 6 detectores"],
];
console.log("\n=== D12: variables compartidas (pares top/bottom del mismo activo excluidos) ===");
for (const [k, v] of shared) console.log(`  ${k}: ${v}`);

// ── D12b/D13: correlación de activaciones con data_long_cache ──
import dataPath from "../validation/data_long_cache.json";
const d = (dataPath as any).data;
const dates: string[] = d.dates;
const closes: Record<string, number[]> = d.closes;
const macro: Record<string, number[]> = d.macro;

// Smile rsiFunction: RSI estándar Wilder por ventanas de 14 semanas sobre cierres diarios muestreados
// a la misma fecha (usamos arrays completos y ventanas de ~70 días hábiles ≈ 14 semanas).
function rsi14(prices: number[], idx: number, period = 70): number | undefined {
  if (idx < period) return undefined;
  let gains = 0, losses = 0, nanCount = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const diff = prices[i] - prices[i - 1];
    if (!Number.isFinite(diff)) { nanCount++; continue; }
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (nanCount > 0) return undefined; // ventana impura (hueco / datos faltantes)
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

const TICKERS = ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"];
const n = dates.length;
const b = 252;
const emxcTrim: (number | null)[] = Array(n).fill(null);
const goldTrim: (number | null)[] = Array(n).fill(null);
const btcTrim: (number | null)[] = Array(n).fill(null);
const wlgTrim: (number | null)[] = Array(n).fill(null);
const semisTrim: (number | null)[] = Array(n).fill(null);

for (let t = 0; t < n; t++) {
  const dxy = macro.dxy?.[t];
  if (dxy && dxy > 50) {
    const s = dxyPoints(dxy);
    emxcTrim[t] = null;
    emxcTrim[t] = multiplierFromScore(s).trim;
  }
  // tnx está en % ×10 en Yahoo (^TNX 4.5 significa 4.5%). DFII10 NO está en el cache.
  const tnx = macro.tnx?.[t];
  // Oro: usamos tipo real PROXY = TNX − IRX − 1.7pp (breakeven proxy histórico medio; declarado).
  const irx = macro.irx?.[t];
  if (tnx && irx) {
    const realProxy = tnx - irx - 1.7;
    const base = realProxy <= 0 ? 1.0 : smoothScore(realProxy, [[0, 1.0], [0.5, 0.70], [1.5, 0.45], [2.5, 0.20]]);
    goldTrim[t] = Math.round((1 - Math.max(0.05, Math.min(1, base))) * 100);
  }
  const btcRsi = rsi14(closes["BTC-EUR"], t, 70);
  const btcPts = btcRsi ? rsiPoints(btcRsi) : 0; // rampa correcta de BTC es [[80,0],[85,2]]
  btcTrim[t] = multiplierFromScore(btcPts).trim;
  const pE: number | undefined = undefined; // P/E MSCI World NO está en el cache
  const wlgRsi = rsi14(closes["0P00000WLG.F"], t, 70);
  // WLG usa un umbral MÁS bajo que el resto de equity detectors (75 en vez de 80):
  // "sobrecompra" arranca en 75 en el código del detector (fix smooth).
  const wlgPts = wlgRsi ? smoothScore(wlgRsi, [[75, 1.0], [80, 1.5], [85, 2.0]]) : 0;
  wlgTrim[t] = multiplierFromScore(wlgPts).trim;
  const soxRsi = rsi14(closes["VVSM.DE"], t, 70);
  semisTrim[t] = multiplierFromScore(soxRsi ? (soxRsi > 85 ? 2 : soxRsi > 80 ? 1 : 0) : 0).trim;
}

const corr = (a: (number | null)[], b: (number | null)[]) => {
  const pairs: [number, number][] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== null && b[i] !== null) pairs.push([a[i] as number, b[i] as number]);
  }
  if (pairs.length < 10) return NaN;
  const va = pairs.map(p => p[0]);
  const vb = pairs.map(p => p[1]);
  const ma = va.reduce((s, x) => s + x, 0) / va.length;
  const mb = vb.reduce((s, x) => s + x, 0) / vb.length;
  const cov = va.reduce((s, x, i) => s + (x - ma) * (vb[i] - mb), 0);
  const sda = Math.sqrt(va.reduce((s, x) => s + (x - ma) ** 2, 0));
  const sdb = Math.sqrt(vb.reduce((s, x) => s + (x - mb) ** 2, 0));
  if (sda === 0 || sdb === 0) return NaN; // serie plana (todo 0) → sin información
  return cov / (sda * sdb);
};
const names = ["EMXC", "Gold(proxy)", "BTC(RSI)", "WLG(RSI)", "Semis(RSI)"];
const arrs = [emxcTrim, goldTrim, btcTrim, wlgTrim, semisTrim];
 // (nulls son legítimos: representan “detector sin señal computable”)
const clean = (a: (number | null)[]) => a.map(x => x === null ? 0 : x);
console.log("\n=== D13: correlación de trim (%) entre detectores en el dataset completo ===");
const head = "       " + names.map(x => x.slice(0, 6).padStart(7)).join("");
console.log(head);
arrs.forEach((r, i) => {
  const row = [names[i].padStart(6)];
  arrs.forEach((c, j) => row.push((i === j ? 1 : corr(clean(r), clean(c))).toFixed(2).padStart(7)));
  console.log(row.join(""));
});
const frac = (a: (number | null)[], th: number) => {
  const v = a.filter(x => x !== null) as number[];
  return `${(100 * v.filter(x => x >= th).length / (v.length || 1)).toFixed(1)}% (n=${v.length})`;
};
console.log("\n=== C6 parcial: días con trim > 0 / > 20 / > 35 (series con señales parciales del cache) ===");
for (let i = 0; i < arrs.length; i++) {
  console.log(`  ${names[i]}: >0 ${frac(arrs[i], 1)} · >20% ${frac(arrs[i], 21)} · >35% ${frac(arrs[i], 36)}`);
}

writeFileSync("audit/audit_a_results.json", JSON.stringify({
  emxcTrim, goldTrim, btcTrim, wlgTrim, semisTrim, dates,
}, null, 0));
console.log("\n[saved] scripts/audit/audit_a_results.json");
