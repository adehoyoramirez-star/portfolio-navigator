// ================================================================
// cliff_stats.ts — CUANTIFICACIÓN del precipicio de WLG sobre el
// histórico REAL disponible (URTH semanal, 2012-2026).
//
// NATURALEZA: script de ANÁLISIS (no toca motor, ni harness, ni datos).
// Reconstruye el RSI semanal de WLG exactamente como m3_rerun.ts (misma
// doctrina: grid del calendario semanal de ^GSPC, RSI-14 de Wilder sobre
// cierres semanales de URTH) y evalúa el detector REAL con las dos curvas
// inyectadas, para contar cruces, saltos y whipsaws.
//
// Ejecutar desde scripts/:  npx tsx audit/propuesta_wlg_pe/cliff_stats.ts
// ================================================================
import { readFileSync } from "fs";
import {
  detectCycleTops,
  WLG_RSI_CURVE_APPROVED,
  WLG_RSI_CURVE_CANDIDATE,
  type CycleTopInputs,
  type WlgCurve,
} from "../../../src/core/risk/cycleTopDetector";
import { parseCSV, type Row } from "../m3_harness";

const DATA = "audit/data";

// ── grid semanal idéntico a m3_rerun.ts ─────────────────────────
const spx = parseCSV("yahoo__GSPC.csv", 2);
const urth = parseCSV("yahoo_URTH.csv", 2);
const weekKey = (d: string) => { const dt = new Date(d + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay()); return dt.toISOString().slice(0, 10); };
const lastOfWeek = new Map<string, string>();
for (const r of spx) lastOfWeek.set(weekKey(r.d), r.d);
const grid = [...lastOfWeek.values()].sort();

const mk = (rows: Row[]) => { const m = new Map<string, number>(); rows.forEach((r, i) => m.set(r.d, i)); return m; };
function before(rows: Row[], idx: Map<string, number>, d: string): number | undefined {
  let i = idx.get(d);
  if (i === undefined) { let lo = 0, hi = rows.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].d <= d) lo = mid + 1; else hi = mid - 1; } i = hi; }
  return i >= 0 ? rows[i].v : undefined;
}
function weeklyOf(rows: Row[]): { d: string; v: number }[] {
  const idx = mk(rows); const out: { d: string; v: number }[] = [];
  for (const d of grid) { const vv = before(rows, idx, d); if (vv !== undefined) out.push({ d, v: vv }); }
  return out;
}
function rsi14(arr: { d: string; v: number }[], upto: string): number | undefined {
  const iP = arr.findIndex(a => a.d === upto);
  if (iP < 13) return undefined;
  let g = 0, l = 0;
  for (let j = iP - 13; j <= iP; j++) {
    const cur = arr[j], prev = arr[j - 1];
    if (!cur?.v || !prev?.v || !Number.isFinite(cur.v) || !Number.isFinite(prev.v)) return undefined;
    const ch = cur.v - prev.v;
    if (ch > 0) g += ch; else l -= ch;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + (g / 14) / (l / 14));
}
const wUrth = weeklyOf(urth);

// ── serie semanal: RSI-W, trim APROBADA vs CANDIDATA (motor real) ──
const trimOf = (rsi: number, curve: WlgCurve): number => {
  const inp: CycleTopInputs = { bondYield10y: 4.0, wlgRsiWeekly: rsi };
  const out = detectCycleTops(inp, { rsiCurve: curve });
  return (out.signals.find(s => s.ticker === "0P00000WLG.F")?.trimPct ?? 0) / 100;
};
type W = { d: string; rsi: number; tA: number; tB: number };
const series: W[] = [];
let noRsi = 0;
for (const d of grid) {
  const rsi = rsi14(wUrth, d);
  if (rsi === undefined) { noRsi++; continue; }
  series.push({ d, rsi, tA: trimOf(rsi, WLG_RSI_CURVE_APPROVED), tB: trimOf(rsi, WLG_RSI_CURVE_CANDIDATE) });
}
const THR = 75;
const f2 = (x: number) => x.toFixed(2);
console.log("=== WLG-CLIFF: cuantificación sobre URTH semanal (histórico REAL del repo) ===");
console.log(`archivo: audit/data/yahoo_URTH.csv · semanas en el grid: ${grid.length} · con RSI-W disponible: ${series.length} (sin RSI: ${noRsi})`);
console.log(`rango efectivo: ${series[0].d} → ${series[series.length - 1].d}`);

// referencia: el motor sin inyección debe dar EXACTAMENTE la curva aprobada
let mismatchDefault = 0;
for (const w of series) {
  const out = detectCycleTops({ bondYield10y: 4.0, wlgRsiWeekly: w.rsi } as CycleTopInputs);
  const t = (out.signals.find(s => s.ticker === "0P00000WLG.F")?.trimPct ?? 0) / 100;
  if (Math.abs(t - w.tA) > 1e-12) mismatchDefault++;
}
console.log(`control: semanas donde el DEFAULT del motor ≠ curva APROBADA: ${mismatchDefault} (esperado 0)`);

// ── 1) cruces del umbral 75 ─────────────────────────────────────
let up = 0, down = 0, aboveA = 0, aboveB = 0, jumpA = 0, jumpB = 0;
let maxJumpA = 0, maxJumpB = 0;
const upDates: string[] = [], jumpDates: { d: string; prev: number; cur: number; rsi: number }[] = [];
for (let i = 0; i < series.length; i++) {
  const w = series[i];
  if (w.tA > 0) aboveA++; if (w.tB > 0) aboveB++;
  if (i > 0) {
    const p = series[i - 1];
    if (p.rsi < THR && w.rsi >= THR) { up++; upDates.push(w.d); }
    if (p.rsi >= THR && w.rsi < THR) down++;
    maxJumpA = Math.max(maxJumpA, Math.abs(w.tA - p.tA));
    maxJumpB = Math.max(maxJumpB, Math.abs(w.tB - p.tB));
    if (Math.abs(w.tA - p.tA) >= 0.30) { jumpA++; jumpDates.push({ d: w.d, prev: p.tA, cur: w.tA, rsi: w.rsi }); }
    if (Math.abs(w.tB - p.tB) >= 0.30) jumpB++;
  }
}
console.log(`\n[1] Cruces del umbral ${THR} en RSI semanal:`);
console.log(`    cruces al ALZA (pasa a ≥${THR}): ${up} · cruces a la BAJA (vuelve a <${THR}): ${down}`);
console.log(`    semanas con trim>0: curva APROBADA=${aboveA} · curva CANDIDATA=${aboveB}`);
console.log(`    saltos de |Δtrim| ≥ 30 pp entre semanas consecutivas: APROBADA=${jumpA} · CANDIDATA=${jumpB}`);
console.log(`    salto MÁXIMO observado |Δtrim| entre semanas: APROBADA=${(100 * maxJumpA).toFixed(1)} pp · CANDIDATA=${(100 * maxJumpB).toFixed(1)} pp`);
for (const j of jumpDates) console.log(`      · ${j.d}: RSI ${f2(j.rsi)} → trim ${(100 * j.prev).toFixed(1)}% → ${(100 * j.cur).toFixed(1)}%`);

// ── 2) whipsaws: episodios ≥75 de duración ≤ 4 semanas ──────────
type Ep = { start: string; end: string; len: number; maxRsi: number };
const eps: Ep[] = [];
let cur: Ep | null = null;
for (const w of series) {
  if (w.rsi >= THR) {
    if (!cur) cur = { start: w.d, end: w.d, len: 1, maxRsi: w.rsi };
    else { cur.end = w.d; cur.len++; cur.maxRsi = Math.max(cur.maxRsi, w.rsi); }
  } else if (cur) { eps.push(cur); cur = null; }
}
if (cur) eps.push(cur);
const whip = eps.filter(e => e.len <= 4);
console.log(`\n[2] Episodios con RSI ≥ ${THR} (cruces al alza materializados): ${eps.length}`);
console.log(`    duración ≤ 4 semanas (WHIPSAW): ${whip.length} · duración mediana: ${eps.length ? eps.slice().sort((a, b) => a.len - b.len)[Math.floor(eps.length / 2)].len : 0} semanas`);
console.log(`    duración en semanas: ${eps.map(e => e.len).join(", ")}`);
for (const e of whip) console.log(`      · whipsaw ${e.start}→${e.end} (${e.len} sem, RSI máx ${f2(e.maxRsi)})`);

// ── 3) coste del salto: exposición y Δtrim agregados ────────────
const sumA = series.reduce((s, w) => s + w.tA, 0), sumB = series.reduce((s, w) => s + w.tB, 0);
const meanA = sumA / series.length, meanB = sumB / series.length;
const band = series.filter(w => w.rsi >= 75 && w.rsi < 80);
console.log(`\n[3] Exposición / esfuerzo de recorte:`);
console.log(`    trim medio (aprobada)=${(100 * meanA).toFixed(2)}% vs (candidata)=${(100 * meanB).toFixed(2)}% · Δ=${(100 * (meanB - meanA)).toFixed(2)} pp`);
console.log(`    semanas en la banda 75–80 (donde la candidata retrasa el recorte): ${band.length}`);
if (band.length) {
  const dA = band.reduce((s, w) => s + w.tA, 0) / band.length, dB = band.reduce((s, w) => s + w.tB, 0) / band.length;
  console.log(`      · trim medio en la banda: aprobada ${(100 * dA).toFixed(1)}% vs candidata ${(100 * dB).toFixed(1)}% (Δ ${(100 * (dB - dA)).toFixed(1)} pp)`);
  console.log(`      · semanas de la banda con RSI ≥ 70: ${band.filter(w => w.rsi >= 70).length} (todas por construcción)`);
}
const maxA = Math.max(...series.map(w => w.tA)), maxB = Math.max(...series.map(w => w.tB));
console.log(`    trim máximo alcanzado en el histórico: aprobada ${(100 * maxA).toFixed(1)}% · candidata ${(100 * maxB).toFixed(1)}%`);

// ── 4) ruta de VALORACIÓN (P/E): ¿cuántas semanas medibles? ─────
const csvPe = `${DATA}/wlg_forward_pe.csv`;
let peExists = true;
try { readFileSync(csvPe, "utf8"); } catch { peExists = false; }
console.log(`\n[4] Ruta de VALORACIÓN (P/E efectivo):`);
console.log(`    ${csvPe} presente: ${peExists ? "SÍ" : "NO"}`);
console.log(`    semanas del histórico con P/E efectivo disponible: 0 (el harness canónico no pasa wlgPERatio; ver m3_rerun.ts, modo A)`);
console.log(`    → banda P/E 13–16 sobre histórico REAL: NO MEDIBLE con las fuentes del repo (0 semanas de datos, no 0 semanas observadas).`);
