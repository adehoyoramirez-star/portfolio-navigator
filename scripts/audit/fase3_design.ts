// ============================================================
// scripts/audit/fase3_design.ts — FASE 3: variantes de diseño MEDIDAS
// No toca src/. Consume la serie semanal YA generada por fase2 (audit/fase2_series.json),
// que a su vez importa el detector REAL. Aquí se aplican transformaciones EXTERNAS
// (interpolación de cliffs, deadband+histeresis, topes, presupuesto agregado) y se
// miden sobre operaciones/impuestos/MaxDD (CAGR = secundario).
// Ejecutar: npx tsx scripts/audit/fase3_design.ts
// ============================================================
import { readFileSync, writeFileSync } from "fs";

const DATA = "audit/data";
type Row = { d: string; v: number };
const parseCSV = (file: string, col = 1): Row[] =>
  readFileSync(`${DATA}/${file}`, "utf8").trim().split("\n").slice(1)
    .map(l => l.split(",")).filter(c => Number.isFinite(+c[col]))
    .map(c => ({ d: c[0], v: +c[col] }));

const eem = parseCSV("yahoo_EEM.csv", 2);
const sox = parseCSV("yahoo__SOX.csv", 2);
const gld = parseCSV("yahoo_GLD.csv", 2);
const urth = parseCSV("yahoo_URTH.csv", 2);
const irx = parseCSV("yahoo__IRX.csv", 2);
const dxy = parseCSV("yahoo_DX_Y_NYB.csv", 2);
const mk = (rows: Row[]) => { const m = new Map<string, number>(); rows.forEach((r, i) => m.set(r.d, i)); return m; };
const idxE = mk(eem), idxS = mk(sox), idxG = mk(gld), idxU = mk(urth), idxX = mk(dxy), idxI = mk(irx);
function before(rows: Row[], idx: Map<string, number>, d: string): number | undefined {
  let i = idx.get(d);
  if (i === undefined) { let lo = 0, hi = rows.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].d <= d) lo = mid + 1; else hi = mid - 1; } i = hi; }
  return i >= 0 ? rows[i].v : undefined;
}

const series = JSON.parse(readFileSync("audit/fase2_series.json", "utf8")) as { weeks: { d: string; trims: Record<string, number> }[] };
const weeks = series.weeks;
const priceOf: Record<string, (d: string) => number | undefined> = {
  "EMXC.DE": d => before(eem, idxE, d), "VVSM.DE": d => before(sox, idxS, d),
  "PPFB.DE": d => before(gld, idxG, d), "0P00000WLG.F": d => before(urth, idxU, d),
};

// ── réplica declarada de multiplierFromScore (anclas reales verificadas en FASE 0) ──
const ANCH: [number, number][] = [[0, 1.0], [0.5, 0.75], [1.5, 0.55], [2.5, 0.35], [3.5, 0.20], [5.0, 0.10]];
function multFromScore(score: number): number {
  if (score <= 0) return 1.0;
  let m = ANCH[ANCH.length - 1][1];
  for (let i = 1; i < ANCH.length; i++) { const [x0, y0] = ANCH[i - 1], [x1, y1] = ANCH[i]; if (score <= x1) { m = y0 + (y1 - y0) * (score - x0) / (x1 - x0); break; } }
  return Math.max(0.05, Math.min(1, m));
}
const trimFromScore = (s: number) => 1 - multFromScore(s);

// ── tramos REALES de detectEMXCTop (DXY) vs rampa propuesta ──────────
const emxcStep = (x: number) => x > 115 ? 3 : x > 110 ? 2.5 : x > 106 ? 1.5 : x > 103 ? 0.75 : 0;
const RAMP: [number, number][] = [[98, 0], [104.5, 0.75], [108, 1.5], [112.5, 2.5], [118, 3.0]];
function emxcRamp(x: number): number {
  if (x <= RAMP[0][0]) return 0; if (x >= RAMP[RAMP.length - 1][0]) return 3.0;
  for (let i = 1; i < RAMP.length; i++) { const [x0, y0] = RAMP[i - 1], [x1, y1] = RAMP[i]; if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  return 3.0;
}
// mult continuo para rampa (mismo esquema que multiplierFromScore del detector)
function multRamp(points: number): number {
  // puntos ya están en escala de topSignals (≈ lo que iría a multiplierFromScore)
  return multFromScore(points);
}

console.log("=== 3.1: cliff del umbral DXY 103 (EMXC) — tramos reales vs rampa ===");
console.log("  DXY     | step pts | trim step | ramp pts | trim ramp");
for (const x of [102.9, 103.0, 103.01, 105.99, 106.0, 106.01, 110.0, 110.01, 115.0, 115.01]) {
  const ts = Math.round(100 * trimFromScore(emxcStep(x))) / 100;
  const tr = Math.round(100 * trimFromScore(emxcRamp(x))) / 100;
  console.log(`  ${x.toFixed(2).padStart(8)} | ${emxcStep(x).toFixed(2).padStart(8)} | ${(100 * ts).toFixed(0).padStart(8)}% | ${emxcRamp(x).toFixed(2).padStart(8)} | ${(100 * tr).toFixed(0).padStart(8)}%`);
}

// ── backtest genérico con un accesor de trim ─────────────────────────
type BT = { cagr: number; maxdd: number; vol: number; ops: number; taxes: number; spread: number; first: string };
function bt(getTrim: (i: number) => number, priceKey: string, label = ""): BT {
  const px = priceOf[priceKey];
  const SPREAD = 0.0005, TAX = 0.26;
  const startIdx = weeks.findIndex((_, i) => px(weeks[i].d) !== undefined);
  let cash = 10000, sh = 0, avg = 0, ops = 0, taxes = 0, spread = 0;
  const vals: number[] = [];
  for (let i = startIdx; i < weeks.length; i++) {
    const p = px(weeks[i].d)!; const t = getTrim(i);
    const nav = cash + sh * p; const target = (nav / 6) * (1 - t); const delta = target - sh * p;
    if (delta < -1e-9 && sh > 0) { const q = Math.min(sh, -delta / p); const proc = q * p; taxes += Math.max(0, (p - avg) * q) * TAX; const sc = proc * SPREAD; spread += sc; cash += proc - sc; sh -= q; ops++; }
    else if (delta > 1e-9 && cash > 0) { const spend = Math.min(cash, delta); const sc = spend * SPREAD; spread += sc; const q = (spend - sc) / p; avg = (avg * sh + p * q) / ((sh + q) || 1); sh += q; cash -= spend; }
    if (cash > 0) cash *= 1 + ((before(irx, idxI, weeks[i].d) ?? 4) / 100 / 52);
    vals.push(cash + sh * p);
  }
  const rets = vals.map((x, j) => j ? x / vals[j - 1] - 1 : 0).slice(1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const days = (new Date(weeks[weeks.length - 1].d).getTime() - new Date(weeks[startIdx].d).getTime()) / 86400000;
  let peak = vals[0], dd = 0; for (const x of vals) { peak = Math.max(peak, x); dd = Math.min(dd, x / peak - 1); }
  void label;
  return { cagr: Math.pow(vals[vals.length - 1] / vals[0], 365 / days) - 1, maxdd: dd, vol: sd * Math.sqrt(52), ops, taxes, spread, first: weeks[startIdx].d };
}
const row = (lbl: string, b: BT) => `${lbl.padEnd(20)} | CAGR ${(100 * b.cagr).toFixed(2).padStart(6)}% | MaxDD ${(100 * b.maxdd).toFixed(1).padStart(6)}% | ops ${String(b.ops).padStart(4)} | impuestos€ ${b.taxes.toFixed(0).padStart(6)} | spreads€ ${b.spread.toFixed(0)}`;

console.log("\n=== 3.1b: EMXC (EEM) con trim STEP (real) vs RAMP (suavizado) ===");
{
  const dxyAt = (i: number) => before(dxy, idxX, weeks[i].d);
  const stepTrim = weeks.map((w, i) => { const x = dxyAt(i); return x === undefined ? 0 : trimFromScore(emxcStep(x)); });
  const rampTrim = weeks.map((w, i) => { const x = dxyAt(i); return x === undefined ? 0 : trimFromScore(emxcRamp(x)); });
  console.log(row("EMXC step (real)", bt(i => stepTrim[i], "EMXC.DE")));
  console.log(row("EMXC ramp (prop.)", bt(i => rampTrim[i], "EMXC.DE")));
}

// ── deadband + histéresis externa ────────────────────────────────────
function hysteresis(raw: number[], enter: number, exit: number): number[] {
  let on = false; return raw.map(t => { if (!on && t > enter) on = true; else if (on && t < exit) on = false; return on ? t : 0; });
}
console.log("\n=== 3.2: deadband + histéresis (enter trim>20%, exit trim<5%), estado externo ===");
for (const k of ["EMXC.DE", "VVSM.DE", "PPFB.DE"] as const) {
  if (!priceOf[k]) continue;
  const raw = weeks.map((w, i) => w.trims[k] ?? 0);
  const hyst = hysteresis(raw, 0.20, 0.05);
  console.log(row(`${k} raw`, bt(i => raw[i], k)));
  console.log(row(`${k} +hyst`, bt(i => hyst[i], k)));
}

// ── topes por familia (cap del trim) ─────────────────────────────────
console.log("\n=== 3.3: topes de trim por activo (cap 30% / 40%) ===");
for (const k of ["PPFB.DE", "EMXC.DE", "VVSM.DE"] as const) {
  const raw = weeks.map((w, i) => w.trims[k] ?? 0);
  console.log(row(`${k} raw (máx ${Math.round(100 * Math.max(...raw))}%)`, bt(i => raw[i], k)));
  console.log(row(`${k} cap30`, bt(i => Math.min(0.30, raw[i]), k)));
  console.log(row(`${k} cap40`, bt(i => Math.min(0.40, raw[i]), k)));
}

// ── presupuesto agregado (cap de la suma de trims entre detectores) ──
console.log("\n=== 3.4: presupuesto agregado (cap de la suma de trims del universo) ===");
{
  const recon = ["BTC-EUR", "VVSM.DE", "PPFB.DE", "EMXC.DE", "0P00000WLG.F"];
  const rawSum = weeks.map(w => recon.reduce((s, k) => s + (w.trims[k] ?? 0), 0));
  const budget = weeks.map(w => {
    const sum = recon.reduce((s, k) => s + (w.trims[k] ?? 0), 0);
    const scale = sum > 1.0 ? 1.0 / sum : 1; // tope 1.0 de trim agregado
    const out: Record<string, number> = {};
    for (const k of recon) out[k] = (w.trims[k] ?? 0) * scale;
    return out;
  });
  console.log(`  semanas con suma>1.0: ${rawSum.filter(x => x > 1).length}/${weeks.length}`);
  // medir sobre la caja liberada total (proxy): media de trim agregado
  const meanRaw = rawSum.reduce((s, x) => s + x, 0) / rawSum.length;
  const meanCap = budget.reduce((s, o) => s + recon.reduce((a, k) => a + o[k], 0), 0) / budget.length;
  console.log(`  trim agregado medio: raw ${meanRaw.toFixed(3)} → con presupuesto ${meanCap.toFixed(3)}`);
  // diferencia de operaciones por activo al aplicar presupuesto
  for (const k of recon) {
    if (!priceOf[k]) continue;
    const raw = weeks.map((w, i) => w.trims[k] ?? 0);
    const capped = weeks.map((_, i) => budget[i][k] ?? 0);
    const a = bt(i => raw[i], k), b = bt(i => capped[i], k);
    console.log(`    ${k.padEnd(14)} ops ${a.ops}→${b.ops} · impuestos €${a.taxes.toFixed(0)}→€${b.taxes.toFixed(0)} · MaxDD ${(100 * a.maxdd).toFixed(1)}%→${(100 * b.maxdd).toFixed(1)}%`);
  }
}

writeFileSync("audit/fase3_results.json", JSON.stringify({ generated: new Date().toISOString() }, null, 1));
console.log("\n[saved] audit/fase3_results.json");
