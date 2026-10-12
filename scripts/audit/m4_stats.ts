// ============================================================
// scripts/audit/m4_stats.ts — BLOQUE 1.5 (A1/A2/A3) con
// bootstrap por bloques DOCUMENTADO y no degenerado.
//
// NO re-ejecuta el detector: lee las trim semanales ya emitidas por el
// detector real (scripts/audit/m3_results.json, generado por m3_rerun.ts).
// Precios: CSV crudos de scripts/audit/data (misma convención "at-or-before").
//
// MÉTODO (declarado ANTES de mirar resultados):
//  - A1: episodio = racha de semanas con trim>0; se cierra cuando pasan
//        >= gap semanas SIN trim. gap = 26 y 52 (>= horizonte de acierto).
//  - A2: acierto = caída >10% (cierre→mínimo de las 26 semanas siguientes).
//        Tasa base = prob incondicional sobre todas las semanas evaluables.
//        IC del DIFERENCIAL (señal − base): el acierto de la señal se mantiene
//        fijo (N episodios observados); la tasa base se remuestrea por bloques
//        contiguos de 26 semanas (5000 rep). IC90 = [señal − q95(base*),
//        señal − q05(base*)]. Si contiene 0 → NO DISCRIMINA.
//  - A3: rendimiento forward 3/6/12m tras activación; IC90 del incondicional
//        por bloques de 26 sem (5000 rep). Veredicto sólo si el forward de la
//        señal queda fuera del IC del incondicional.
// Ejecutar: cd scripts && npx tsx audit/m4_stats.ts
// ============================================================
import { readFileSync } from "fs";

const DATA = "audit/data";
type Row = { d: string; v: number };
const parseCSV = (file: string, col = 1): Row[] =>
  readFileSync(`${DATA}/${file}`, "utf8").trim().split("\n").slice(1)
    .map(l => l.split(",")).filter(c => Number.isFinite(+c[col]))
    .map(c => ({ d: c[0], v: +c[col] }));
function before(rows: Row[], d: string): number | undefined {
  const m = mkCache(rows);
  let i = m.get(d);
  if (i === undefined) { let lo = 0, hi = rows.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].d <= d) lo = mid + 1; else hi = mid - 1; } i = hi; }
  const r = (i >= 0 && i < rows.length) ? rows[i] : undefined;
  return r ? r.v : undefined;
}
const cache = new WeakMap<Row[], Map<string, number>>();
function mkCache(rows: Row[]) { let m = cache.get(rows); if (!m) { m = new Map(); rows.forEach((r, i) => m!.set(r.d, i)); cache.set(rows, m); } return m; }

// PRNG determinista (LCG) para reproducibilidad
let SEED = 20261012;
const rnd = () => { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; };

/** Media bootstrap por bloques contiguos de `block` (5000 rep). */
function bootBlockMean(y: number[], block = 26, B = 5000): number[] {
  const n = y.length; const out: number[] = [];
  for (let rep = 0; rep < B; rep++) {
    let s = 0, c = 0;
    while (c < n) { const st = Math.floor(rnd() * (n - block)); for (let j = 0; j < block && c < n; j++, c++) s += y[st + j]; }
    out.push(s / n);
  }
  out.sort((a, b) => a - b);
  return out;
}
const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];

// ── semanas/trim del detector real ──────────────────────────────
type Wk = { d: string; trims: Record<string, number>; hasInput: boolean };
const J = JSON.parse(readFileSync("audit/m3_results.json", "utf8")) as { weeks: Wk[] };
const weeks = J.weeks;
console.log(`[input] semanas=${weeks.length} · con input=${weeks.filter(w => w.hasInput).length} · desde ${weeks[0].d} hasta ${weeks[weeks.length - 1].d}`);

const PKS: Record<string, Row[]> = {
  "BTC-EUR": parseCSV("coinmetrics_btc_price.csv", 1),
  "VVSM.DE": parseCSV("yahoo__SOX.csv", 2),
  "PPFB.DE": parseCSV("yahoo_GLD.csv", 2),
  "EMXC.DE": parseCSV("yahoo_EEM.csv", 2),
  "0P00000WLG.F": parseCSV("yahoo_URTH.csv", 2),
};
const TICKS = Object.keys(PKS);
const NOM: Record<string, string> = { "BTC-EUR": "BTC", "VVSM.DE": "SEMIS", "PPFB.DE": "ORO", "EMXC.DE": "EMXC", "0P00000WLG.F": "WLG" };
const pxAt = (k: string, d: string) => before(PKS[k], d);

type Ep = { d: string; end: string; n: number; maxTrim: number; decl26: number; fwd63: number; fwd126: number; fwd252: number };
function episodesOf(k: string, gap: number): Ep[] {
  const eps: { start: number; end: number; maxTrim: number }[] = [];
  let cur: { start: number; end: number; maxTrim: number } | null = null;
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i]; if (!w.hasInput) continue;
    const tr = w.trims[k] ?? 0;
    if (tr > 0) { if (!cur) cur = { start: i, end: i, maxTrim: tr }; else { cur.end = i; cur.maxTrim = Math.max(cur.maxTrim, tr); } }
    else if (cur && i - cur.end >= gap) { eps.push(cur); cur = null; }
  }
  if (cur) eps.push(cur);
  return eps.map(e => {
    const d = weeks[e.start].d; const p0 = pxAt(k, d);
    const fwd = (n: number) => { const pl = pxAt(k, weeks[Math.min(e.start + n, weeks.length - 1)].d); return p0 && pl ? pl / p0 - 1 : NaN; };
    const fut: number[] = [];
    for (let j = e.start + 1; j <= Math.min(e.start + 26, weeks.length - 1); j++) { const p2 = pxAt(k, weeks[j].d); if (p2 && p0) fut.push(p2 / p0 - 1); }
    return { d, end: weeks[e.end].d, n: e.end - e.start + 1, maxTrim: e.maxTrim, decl26: fut.length ? Math.min(...fut) : NaN, fwd63: fwd(13), fwd126: fwd(26), fwd252: fwd(52) };
  }).filter(e => Number.isFinite(e.decl26));
}

console.log("\n=== A1: N de episodios con separación 26 y 52 semanas (gap >= horizonte) ===");
console.log("detector | gap | N | aciertos decl>10% en 26 sem | fwd6m medio");
for (const k of TICKS) {
  for (const gap of [26, 52]) {
    const eps = episodesOf(k, gap);
    const hits = eps.filter(e => e.decl26 <= -0.10).length;
    const f6 = eps.length ? eps.reduce((s, e) => s + e.fwd126, 0) / eps.length : NaN;
    const tag = eps.length < 5 ? "  <-- PRIOR CON TOPE (N<5)" : "";
    console.log(`${NOM[k].padEnd(6)} | ${String(gap).padStart(3)} | ${String(eps.length).padStart(2)} | ${hits}/${eps.length}${tag} | ${Number.isFinite(f6) ? (100 * f6).toFixed(1) + "%" : "—"}`);
  }
}

console.log("\n=== A2: acierto vs tasa base (caída >10% en 26 sem) · test de aleatorización por bloques (26 sem) ===");
console.log("detector | señal (IC90 Wilson) | tasa base (n) | Δ | IC90 del NULO (N semanas al azar) | veredicto");
// Wilson 90% para una proporción (captura el error binomial del acierto con N chico)
function wilson90(s: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.645, p = s / n;
  const den = 1 + z * z / n, c = (p + z * z / (2 * n)) / den;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [Math.max(0, c - half), Math.min(1, c + half)];
}
for (const k of TICKS) {
  const eps = episodesOf(k, 26);
  const hits = eps.filter(e => e.decl26 <= -0.10).map(e => 1);
  const miss = eps.map(e => (e.decl26 <= -0.10 ? 0 : 1));
  const sig = eps.length ? hits.length / eps.length : NaN;
  const [wlo, whi] = wilson90(hits.length, eps.length);
  // serie semanal de acierto (para la tasa base)
  const y: number[] = [];
  for (let i = 0; i < weeks.length - 26; i++) {
    const p0 = pxAt(k, weeks[i].d); if (!p0) continue;
    const fut: number[] = [];
    for (let j = i + 1; j <= i + 26; j++) { const p2 = pxAt(k, weeks[j].d); if (p2) fut.push(p2 / p0 - 1); }
    if (fut.length < 20) continue;
    y.push(Math.min(...fut) <= -0.10 ? 1 : 0);
  }
  const pb = y.reduce((s, x) => s + x, 0) / y.length;
  // NULO: si el detector no discrimina, su acierto (sobre sus N episodios) es
  // una muestra de N semanas cualesquiera. Remuestreamos N semanas por bloques
  // contiguos de 26 (respeta autocorrelación) y comparamos el acierto observado.
  SEED = 20261012;
  const N = Math.max(1, eps.length), nullHits: number[] = [];
  for (let rep = 0; rep < 5000; rep++) {
    let s = 0, c = 0;
    while (c < N) { const st = Math.floor(rnd() * (y.length - 26)); const take = Math.min(26, N - c); for (let j = 0; j < take; j++, c++) s += y[st + j]; }
    nullHits.push(s / N);
  }
  nullHits.sort((a, b) => a - b);
  const lo = q(nullHits, 0.05), hi = q(nullHits, 0.95);
  const disc = sig < lo ? `DISCRIMINA (acierta MENOS que el azar)` : sig > hi ? `DISCRIMINA (acierta MÁS que el azar)` : "NO DISCRIMINA";
  console.log(`${NOM[k].padEnd(6)} | ${(100 * sig).toFixed(1)}% [${(100 * wlo).toFixed(0)}–${(100 * whi).toFixed(0)}%] (${hits.length}/${eps.length}) | ${(100 * pb).toFixed(1)}% (n=${y.length}) | ${(100 * (sig - pb)).toFixed(1)}pp | [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]pp | ${disc}`);
}

console.log("\n=== A3: forward 3/6/12m tras activación vs incondicional · IC90 del incondicional (bloques 26 sem) ===");
console.log("detector | horizonte | fwd señal | fwd incond | IC90 incond | veredicto");
for (const k of TICKS) {
  const eps = episodesOf(k, 26);
  for (const [lbl, mag] of [["3m", 13], ["6m", 26], ["12m", 52]] as const) {
    const fwdSig = eps.map(e => (mag === 13 ? e.fwd63 : mag === 26 ? e.fwd126 : e.fwd252)).filter(Number.isFinite);
    const unc: number[] = [];
    for (let i = 0; i < weeks.length - mag; i++) { const p0 = pxAt(k, weeks[i].d); const pl = pxAt(k, weeks[i + mag].d); if (p0 && pl) unc.push(pl / p0 - 1); }
    if (!fwdSig.length || unc.length < 60) { console.log(`${NOM[k].padEnd(6)} | ${lbl.padEnd(3)} | sin datos suficientes`); continue; }
    const ms = fwdSig.reduce((s, x) => s + x, 0) / fwdSig.length;
    const mu = unc.reduce((s, x) => s + x, 0) / unc.length;
    SEED = 20261012 + mag; const boot = bootBlockMean(unc, 26, 5000);
    const lo = q(boot, 0.05), hi = q(boot, 0.95);
    const v = lo > ms ? "señal PEOR" : hi < ms ? "señal MEJOR" : "dentro del azar";
    console.log(`${NOM[k].padEnd(6)} | ${lbl.padEnd(3)} | ${(100 * ms).toFixed(1)}% (N=${fwdSig.length}) | ${(100 * mu).toFixed(1)}% | [${(100 * lo).toFixed(0)}%, ${(100 * hi).toFixed(0)}%] | ${v}`);
  }
}

console.log("\n=== A3b: BTC excluyendo 2010-2013 ===");
{
  const eps = episodesOf("BTC-EUR", 26).filter(e => e.d >= "2014-01-01");
  const unc: number[] = [];
  for (let i = 0; i < weeks.length - 26; i++) { if (weeks[i].d < "2014-01-01") continue; const p0 = pxAt("BTC-EUR", weeks[i].d); const pl = pxAt("BTC-EUR", weeks[i + 26].d); if (p0 && pl) unc.push(pl / p0 - 1); }
  const ms = eps.reduce((s, e) => s + e.fwd126, 0) / eps.length, mu = unc.reduce((s, x) => s + x, 0) / unc.length;
  SEED = 7; const boot = bootBlockMean(unc, 26, 5000);
  console.log(`BTC 2014+ | fwd6m señal=${(100 * ms).toFixed(1)}% (N=${eps.length}) | incond=${(100 * mu).toFixed(1)}% | IC90 incond=[${(100 * q(boot, 0.05)).toFixed(0)}%, ${(100 * q(boot, 0.95)).toFixed(0)}%] | aciertos ${eps.filter(e => e.decl26 <= -0.10).length}/${eps.length}`);
}
