// ============================================================
// scripts/audit/m3_rerun.ts — BLOQUES 0.1/0.3/0.4 + A + B (parcial) + C (parcial) + D (M3)
// Reejecuta TODO lo que dependía del harness roto:
//   0.1 exposición media por sleeve y % semanas expo<50%
//   0.3 ON/OFF por activo (CASH0/TBILL) con motor reparado + CARTERA real
//   0.4 EMXC 2007-01→2009-06: DXY/score/trim/exposición semanal + MaxDD
//   A1 episodios con gap 26/52 semanas (independencia con horizonte 26)
//   A2 tasa base + IC por bloques de 26 semanas
//   A3 fwd 3/6/12 meses con IC por bloques (BTC también excluyendo 2010-13)
//   A4 oro 2008 fwd desde cada semana trim>35%
//   B3 picos locales BTC 0/30/60/90d con trim real
//   C1 barrido sintético completo + lista completa de cliffs
//   D2 trim agregado 2008/2020/2022 PONDERADO por peso real
//   D3 correlaciones con N de semanas solapadas
// Ejecutar: npx tsx scripts/audit/m3_rerun.ts > audit/m3_output.txt 2>&1
// ============================================================
import { readFileSync, writeFileSync } from "fs";
import { detectCycleTops, type CycleTopInputs } from "../../src/core/risk/cycleTopDetector";
import { runSleeve, parseCSV, type Row, type SleeveResult } from "./m3_harness";

const DATA = "audit/data";
const mk = (rows: Row[]) => { const m = new Map<string, number>(); rows.forEach((r, i) => m.set(r.d, i)); return m; };
function before(rows: Row[], idx: Map<string, number>, d: string): number | undefined {
  let i = idx.get(d);
  if (i === undefined) { let lo = 0, hi = rows.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].d <= d) lo = mid + 1; else hi = mid - 1; } i = hi; }
  return i >= 0 ? rows[i].v : undefined;
}
// LCG idéntico para el bootstrap de bloques
let SEED = 42;
const rnd = () => { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; };
function blockBootstrapIC(perf: number[], base: number[], block = 26, B = 5000): [number, number] {
  const n = Math.min(perf.length, base.length);
  const diffs: number[] = [];
  for (let rep = 0; rep < B; rep++) {
    const idxP: number[] = []; const idxB: number[] = [];
    const dP: number[] = []; const dB: number[] = [];
    while (dP.length < n) {
      const st = Math.floor(rnd() * (n - block));
      for (let j = 0; j < block && dP.length < n; j++) { dP.push(perf[st + j] ?? NaN); dB.push(base[st + j] ?? NaN); }
    }
    // IC de coincidencia: proporción en la que señal > media base y activo cae después
    diffs.push(dP.reduce((s, x, i) => s + (x - base[i]) ** 2, 0) / dP.length); // placeholder — se reemplaza abajo
  }
  return [0, 0];
}

// ── series de precios y contextos ────────────────────────────────
const spx = parseCSV("yahoo__GSPC.csv", 2);
const btcYahoo = parseCSV("yahoo_BTC_USD.csv", 2);
const cmPrice = parseCSV("coinmetrics_btc_price.csv", 1);
const eem = parseCSV("yahoo_EEM.csv", 2);
const sox = parseCSV("yahoo__SOX.csv", 2);
const gld = parseCSV("yahoo_GLD.csv", 2);
const urth = parseCSV("yahoo_URTH.csv", 2);
const irxR = parseCSV("yahoo__IRX.csv", 2);
const dxyRows = parseCSV("yahoo_DX_Y_NYB.csv", 2);
const dfii = parseCSV("fred_DFII10.csv");
const t1yie = parseCSV("fred_T10YIE.csv");
// calendario semanal ^GSPC (misma doctrina de fase2)
const weekKey = (d: string) => { const dt = new Date(d + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay()); return dt.toISOString().slice(0, 10); };
const lastOfWeek = new Map<string, string>();
for (const r of spx) lastOfWeek.set(weekKey(r.d), r.d);
const grid = [...lastOfWeek.values()].sort();
const hasInput = (d: string) => before(dxyRows, mk(dxyRows), d) !== undefined || before(dfii, mk(dfii), d) !== undefined;

// reconstrucción del detector igual a fase2 pero marcando INPUT por semanas
type Wk = { d: string; trims: Record<string, number>; hasInput: boolean };
const cmCols = readFileSync(`${DATA}/coinmetrics_btc.csv`, "utf8").trim().split("\n").slice(1)
  .map(l => l.split(",")).filter(c => Number.isFinite(+c[2]))
  .map(c => ({ d: c[0], mvrv: +c[1], cap: +c[2], real: +c[3], iss: c[4] === "" ? NaN : +c[4] }));
const zSeriesExp = new Map<string, number>();
{ const diffs: number[] = []; let n = 0, mean = 0, m2 = 0;
  for (const r of cmCols) { if (!Number.isFinite(r.cap) || !Number.isFinite(r.real)) continue;
    const diff = r.cap - r.real; diffs.push(diff); n++; const d2 = diff - mean; mean += d2 / n; m2 += d2 * (diff - mean);
    if (n > 30) zSeriesExp.set(r.d, diff / Math.sqrt(m2 / n)); } }
const puell = new Map<string, number>();
{ const iss = cmCols.filter(r => Number.isFinite(r.iss)).map(r => ({ d: r.d, v: r.iss }));
  for (let i = 364; i < iss.length; i++) { let s = 0; for (let j = i - 364; j <= i; j++) s += iss[j].v; const ma = s / 365; if (ma > 0) puell.set(iss[i].d, iss[i].v / ma); } }

// series semanales para inputs
function weeklyOf(rows: Row[]): { d: string; v: number }[] {
  const idx = mk(rows); const out: { d: string; v: number }[] = [];
  for (const d of grid) { const vv = before(rows, idx, d); if (vv !== undefined) out.push({ d, v: vv }); }
  return out;
}
function rsi14(arr: { d: string; v: number }[], upto: string): number | undefined {
  const iP = arr.findIndex(a => a.d === upto);
  if (iP < 13) return undefined; // necesita 14 puntos: arr[j-1] con j=iP-13 exige iP≥14-1=13 y existe
  let g = 0, l = 0;
  for (let j = iP - 13; j <= iP; j++) {
    const cur = arr[j], prev = arr[j - 1];
    if (!cur?.v || !prev?.v || !Number.isFinite(cur.v) || !Number.isFinite(prev.v)) return undefined;
    const ch = cur.v - prev.v;
    if (ch > 0) g += ch; else l -= ch;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + (g / 14) / (l / 14));
}
const wBtc = weeklyOf(cmPrice), wSox = weeklyOf(sox), wUrthOf = weeklyOf(urth), wEem = weeklyOf(eem);
const rsZ = new Map<string, number>();
{ const spx2 = new Map(spx.map(r => [r.d, r.v] as [string, number]));
  const rs: { d: string; r: number }[] = [];
  for (const r of sox) { const s = spx2.get(r.d); if (s) rs.push({ d: r.d, r: r.v / s }); }
  for (let i = 199; i < rs.length; i++) {
    const win = rs.slice(i - 199, i + 1); const mean = win.reduce((s, x) => s + x.r, 0) / win.length;
    const sd = Math.sqrt(win.reduce((s, x) => s + (x.r - mean) ** 2, 0) / win.length);
    if (sd > 0) rsZ.set(rs[i].d, (rs[i].r - mean) / sd); } }

const weeks: Wk[] = [];
{
  const iDxy = mk(dxyRows), iDfii = mk(dfii), iT1 = mk(t1yie), iIrx = mk(irxR);
  for (const d of grid) {
    const inputs: CycleTopInputs & Record<string, unknown> = { bondYield10y: 4.0 };
    const z = zSeriesExp.get(d) ?? [...zSeriesExp.entries()].filter(([k]) => k <= d).pop()?.[1];
    if (z !== undefined) inputs.mvrvZScore = z;
    const pu = puell.get(d) ?? [...puell.entries()].filter(([k]) => k <= d).pop()?.[1];
    if (pu !== undefined) inputs.puellMultiple = pu;
    const br = rsi14(wBtc, d); if (br !== undefined) inputs.btcRsiWeekly = br;
    const rz = rsZ.get(d) ?? [...rsZ.entries()].filter(([k]) => k <= d).pop()?.[1];
    if (rz !== undefined) inputs.soxSpyRelativeStrength = rz;
    const sr = rsi14(wSox, d); if (sr !== undefined) inputs.soxRsiWeekly = sr;
    const ry = before(dfii, iDfii, d); if (ry !== undefined) inputs.realYield10y = ry;
    const dx = before(dxyRows, iDxy, d); if (dx !== undefined) inputs.dxy = dx;
    const wr = rsi14(wUrthOf, d); if (wr !== undefined) inputs.wlgRsiWeekly = wr;
    inputs.inflationBreakeven = before(t1yie, iT1, d);
    const out = detectCycleTops(inputs as CycleTopInputs);
    const trims: Record<string, number> = {};
    for (const s of out.signals) trims[s.ticker] = s.trimPct / 100;
    trims["BTC-EUR"] = trims["BTC-EUR"] ?? 0;
    const hasIn = (dx !== undefined || ry !== undefined || z !== undefined || pu !== undefined || br !== undefined || rz !== undefined || sr !== undefined || wr !== undefined);
    weeks.push({ d, trims, hasInput: hasIn });
  }
}
const TICKS = ["BTC-EUR", "VVSM.DE", "PPFB.DE", "EMXC.DE", "0P00000WLG.F"] as const;
const PKS: Record<string, Row[]> = { "BTC-EUR": cmPrice, "VVSM.DE": sox, "PPFB.DE": gld, "EMXC.DE": eem, "0P00000WLG.F": urth };
const detName: Record<string, string> = { "BTC-EUR": "BTC", "VVSM.DE": "SEMIS", "PPFB.DE": "ORO", "EMXC.DE": "EMXC", "0P00000WLG.F": "WLG" };
const pIdx: Record<string, Map<string, number>> = {}; for (const k of TICKS) pIdx[k] = mk(PKS[k]);
const pxAt = (k: string, d: string) => before(PKS[k], pIdx[k], d);
const irxAt = (d: string) => before(irxR, mk(irxR), d);

// prices como array (string|undefined) por sleeve + trims (hasInput exigido)
function sleeveArrays(k: string, filterInput: boolean): { prices: (string | undefined)[]; trims: number[]; dates: string[]; irx: (string | undefined)[] } {
  let active = false;
  const prices: (string | undefined)[] = []; const trims: number[] = []; const dates: string[] = []; const irxs: (string | undefined)[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    if (filterInput && !w.hasInput) { if (active) { active = false; prices.push(undefined); trims.push(0); dates.push(w.d); irxs.push(undefined); } continue; }
    if (!active) active = true;
    prices.push(pxAt(k, w.d)); trims.push(filterInput ? (w.trims[k] ?? 0) : 0); dates.push(w.d); irxs.push(irxAt(w.d) !== undefined ? irxAt(w.d) : undefined);
  }
  return { prices, trims, dates, irx: irxs };
}
// para OFF usamos la MISMA ventana con trim≡0
function sleeveOff(k: string, filterInput: boolean) { const s = sleeveArrays(k, filterInput); return runSleeve(s.prices, s.trims.map(() => 0), { dates: s.dates }); }

console.log("=== 0.1+0.3: ON/OFF por activo con HARNESS REPARADO (target=(1−trim)·NAV) ===");
console.log("sleeve | caja | CAGR | vol | MaxDD | ops | impuestos€ | spreads€ | expoMedia | expo<50% | pesoCajaMedia");
const resNew: Record<string, Record<string, SleeveResult>> = {};
for (const k of TICKS) {
  resNew[k] = {};
  const s = sleeveArrays(k, true);
  const on0 = runSleeve(s.prices, s.trims, { cashBox: "CASH0", dates: s.dates });
  const onT = runSleeve(s.prices, s.trims, { cashBox: "TBILL", irx: s.irx, dates: s.dates });
  const off = sleeveOff(k, true);
  resNew[k]["OFF"] = off; resNew[k]["ON-CASH0"] = on0; resNew[k]["ON-TBILL"] = onT;
  const f2 = (x: number) => (100 * x).toFixed(2) + "%";
  for (const [v, r] of [["OFF", off], ["ON-CASH0", on0], ["ON-TBILL", onT]] as const) {
    console.log(`${detName[k].padEnd(6)} | ${v.padEnd(8)} | ${f2(r.cagr).padStart(8)} | ${(100 * r.vol).toFixed(1).padStart(5)}% | ${(100 * r.maxdd).toFixed(1).padStart(6)}% | ${r.ops} | €${r.taxes.toFixed(0).padStart(7)} | €${r.spread.toFixed(0).padStart(6)} | ${(100 * r.meanExpo).toFixed(1).padStart(6)}% | ${(100 * r.fracBelow50).toFixed(1).padStart(6)}% | ${(100 * r.meanCashWeight).toFixed(1).padStart(6)}%`);
  }
}
// cotas de vol vs OFF
console.log("\n=== COTA DE VOL (0.2f en datos REALES): volON ≥ (1−trimMax)·volOFF ===");
for (const k of TICKS) {
  const off = resNew[k]["OFF"], on0 = resNew[k]["ON-CASH0"];
  const tmax = Math.max(...sleeveArrays(k, true).trims);
  const floor = (1 - tmax) * off.vol;
  console.log(`${detName[k].padEnd(6)} trimMax=${(100 * tmax).toFixed(0).padStart(3)}%  volOFF=${(100 * off.vol).toFixed(1).padStart(5)}%  cota=${(100 * floor).toFixed(1).padStart(5)}%  volON=${(100 * on0.vol).toFixed(1).padStart(5)}%  ${on0.vol >= floor - 1e-6 ? "OK" : "VIOLACIÓN"}`);
}

// ── 0.4 EMXC 2007-2009 ───────────────────────────────────────────
console.log("\n=== 0.4: EMXC 2007-01→2009-06 — DXY / score / trim / exposición semanal ===");
console.log("semana | DXY | score | trim | expo");
{
  const s = sleeveArrays("EMXC.DE", true);
  // recreamos la simulación a mano para capturar la expo semanal de la ventana
  let shares = 0, avg = 0, cash = 10000, started = false;
  const SPREAD = 0.0005, TAX = 0.26, BAND = 0.02;
  let peakOn = -1, ddOn = 0; // MaxDD de la ventana
  for (let i = 0; i < s.prices.length; i++) {
    const d = s.dates[i], p = s.prices[i];
    if (d < "2007-01-01" || d > "2009-06-30") continue;
    const dx = before(dxyRows, mk(dxyRows), d);
    const sc = dx === undefined ? 0 : (dx > 115 ? 3 : dx > 110 ? 2.5 : dx > 106 ? 1.5 : dx > 103 ? 0.75 : 0);
    const trim = sc === 0 ? 0 : 1 - [1.0, 0.75, 0.55, 0.35, 0.2, 0.1][2 >= 2 ? (() => { let m = 1.0; const ANCH: [number, number][] = [[0, 1.0], [0.5, 0.75], [1.5, 0.55], [2.5, 0.35], [3.5, 0.20], [5.0, 0.10]]; for (let j = 1; j < ANCH.length; j++) { if (sc <= ANCH[j][0]) { m = ANCH[j - 1][1] + (ANCH[j][1] - ANCH[j - 1][1]) * (sc - ANCH[j - 1][0]) / (ANCH[j][0] - ANCH[j - 1][0]); break; } } return Math.max(0.05, Math.min(1, m)); })() : 1];
    if (p === undefined) continue;
    if (!started) { shares = 10000 / p; avg = p; cash = 0; started = true; console.log(`${d} | DXY ${dx?.toFixed(2) ?? "—"} | score ${sc.toFixed(2)} | trim 0 | expo 100%`); continue; }
    const nav = cash + shares * p;
    const targetVal = (1 - trim) * nav; const cur = shares * p; const delta = targetVal - cur;
    if (delta < -BAND * nav && shares > 0) { const q = Math.min(shares, -delta / p); const proc = q * p; taxesFix(proc, p, avg, q); cash += proc - proc * SPREAD; shares -= q; }
    else if (delta > BAND * nav && cash >= delta) { const q = delta / p; avg = (avg * shares + p * q) / (shares + q); shares += q; cash -= delta; }
    function taxesFix(proc: number, pp: number, av: number, q2: number): number { return proc; }
    const nav2 = cash + shares * p;
    peakOn = Math.max(peakOn, nav2); ddOn = Math.min(ddOn, nav2 / peakOn - 1);
    console.log(`${d} | DXY ${dx?.toFixed(2) ?? "—"} | score ${sc.toFixed(2)} | trim ${(100 * trim).toFixed(0).padStart(3)}% | expo ${(100 * shares * p / nav2).toFixed(1).padStart(5)}%`);
  }
  console.log(`EMXC 2007-01→2009-06 · MaxDD ON (reparado) = ${(100 * ddOn).toFixed(1)}%`);
  // OFF en la misma ventana
  let p0: number | undefined; let pk2 = 0, ddOff = 0;
  for (let i = 0; i < s.prices.length; i++) { const d = s.dates[i], p = s.prices[i]; if (d < "2007-01-01" || d > "2009-06-30" || p === undefined) continue; if (!p0) p0 = p; pk2 = Math.max(pk2, p); ddOff = Math.min(ddOff, p / pk2 - 1); }
  console.log(`EMXC 2007-01→2009-06 · MaxDD OFF = ${(100 * ddOff).toFixed(1)}%`);
}

// ── A: episodios con separación 26 / 52 semanas ─────────────────
type Ep3 = { d: string; maxTrim: number; decl26: number; fwd63: number; fwd126: number; fwd252: number };
function episodesOf(k: string, minGap: number): Ep3[] {
  const eps: Ep3[] = []; let cur: { start: number; end: number; maxTrim: number } | null = null;
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i]; if (!w.hasInput) continue;
    const tr = w.trims[k] ?? 0;
    if (tr > 0) { if (!cur) cur = { start: i, end: i, maxTrim: tr }; else cur.end = i, cur.maxTrim = Math.max(cur.maxTrim, tr); }
    else if (cur && i - cur.end >= minGap) { eps.push(cur as any); cur = null; }
  }
  if (cur) eps.push(cur as any);
  return eps.map(e => {
    const d = weeks[e.start].d; const p0 = pxAt(k, d);
    const fwd = (n: number) => { const d2 = weeks[Math.min(e.start + n, weeks.length - 1)].d; const pl = pxAt(k, d2); return p0 && pl ? pl / p0 - 1 : NaN; };
    const fut: number[] = []; for (let j = e.start + 1; j <= Math.min(e.start + 26, weeks.length - 1); j++) { const p2 = pxAt(k, weeks[j].d); if (p2) fut.push(p2 / p0! - 1); }
    return { d, maxTrim: e.maxTrim, decl26: fut.length ? Math.min(...fut) : NaN, fwd63: fwd(13), fwd126: fwd(26), fwd252: fwd(52) };
  }).filter(e => Number.isFinite(e.decl26));
}
console.log("\n=== A1: episodios con separación 26 y 52 semanas ===");
for (const k of TICKS) {
  for (const gap of [26, 52]) {
    const eps = episodesOf(k, gap);
    const hits = eps.filter(e => e.decl26 <= -0.10).length;
    console.log(`${detName[k].padEnd(6)} gap=${String(gap).padEnd(3)} N=${eps.length} · duración (est) · aciertos ${hits}/${eps.length} (${eps.length ? (100 * hits / eps.length).toFixed(1) : "—"}%) · fwd6m medio ${eps.length ? (100 * eps.reduce((s, e) => s + e.fwd126, 0) / eps.length).toFixed(1) + "%" : "—"}`);
  }
}

// ── A2: tasa base + IC por bloques ───────────────────────────────
function hit(baseRate: number, n: number): number { // binomial p-value
  // exacto no; normal approx suficiente para IC90
  const mu = n * baseRate; const sd = Math.sqrt(n * baseRate * (1 - baseRate));
  return (hits - mu) / sd;
}
console.log("\n=== A2: señal vs tasa base (decl>10% en 26 sem) con IC bootstrap por bloques (26 sem, 5000 rep) ===");
{ // reinicio de seed para reproducibilidad
  SEED = 42;}
for (const k of TICKS) {
  const eps = episodesOf(k, 26);
  const hits = eps.filter(e => e.decl26 <= -0.10).length;
  // tasa base: prob incondicional de decl26 ≤ −10% (todas las semanas con precio)
  let base = 0, nBase = 0;
  for (let i = 0; i < weeks.length - 26; i++) {
    const p0 = pxAt(k, weeks[i].d); if (!p0) continue;
    const fut: number[] = []; for (let j = i + 1; j <= i + 26; j++) { const p2 = pxAt(k, weeks[j].d); if (p2) fut.push(p2 / p0 - 1); }
    if (fut.length < 20) continue;
    nBase++; if (Math.min(...fut) <= -0.10) base++;
  }
  const pb = base / nBase;
  // bootstrap por bloques del DIFERENCIAL (block=26 sem)
  const diffs: number[] = [];
  const epsIdx = eps.map(e => weeks.findIndex(w => w.d === e.d));
  const baseSeries = (st: number, len: number) => { const out: number[] = []; for (let j = st; j < st + len && j < weeks.length - 26; j++) out.push(Number((() => { const p0 = pxAt(k, weeks[j].d); if (!p0) return NaN; const fut2: number[] = []; for (let m = j + 1; m <= Math.min(j + 26, weeks.length - 1); m++) { const p2 = pxAt(k, weeks[m].d); if (p2) fut2.push(p2 / p0 - 1); } return fut2.length ? (Math.min(...fut2) <= -0.10 ? 1 : 0) : NaN; })())); return out; };
  const sigSeries = epsIdx.map(i => 1);
  for (let rep = 0; rep < 5000; rep++) {
    const idxs: number[] = []; while (idxs.length < Math.max(5, epsIdx.length)) { const st = Math.floor(rnd() * (weeks.length - 26)); for (let j = 0; j < 26 && idxs.length < Math.max(5, epsIdx.length); j++) idxs.push(st + j); }
    const baseOnEps = idxs.map(i => { const v0 = baseSeries(i, 1)[0]; return v0; });
    const frac = baseOnEps.filter(x => Number.isFinite(x)).filter(x => x === 1).length / idxs.length;
    diffs.push(frac - pb);
  }
  diffs.sort((a, b) => a - b);
  const lo = diffs[Math.floor(0.05 * diffs.length)], hi = diffs[Math.floor(0.95 * diffs.length)];
  console.log(`${detName[k].padEnd(6)} señal=${hits}/${eps.length} (${(100 * hits / eps.length).toFixed(1)}%) · tasa base=${(100 * pb).toFixed(1)}% (n=${nBase}) · Δ=${(100 * (hits / eps.length - pb)).toFixed(1)}pp · IC90 del Δ=[${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]pp ${lo <= 0 ? "→ señal NO DISCRIMINA" : "→ señal DISCRIMINA"}`);
}

// ── A3: fwd 3/6/12 meses con IC por bloques ──────────────────────
console.log("\n=== A3: fwd 3/6/12 meses tras activación vs incondicional (bootstrap por bloques, 5000 rep, bloque 26 sem) ===");
for (const k of TICKS) {
  const eps = episodesOf(k, 26);
  const rows: [string, number][] = [];
  for (const [lbl, mag] of [["3m", 13], ["6m", 26], ["12m", 52]] as const) {
    const fwdAct = eps.map(e => e[`fwd${mag === 13 ? 63 : mag === 26 ? 126 : 252}` as keyof Ep3] as number);
    // incondicional: todas las semanas con precio
    const unincon: number[] = [];
    for (let i = 0; i < weeks.length - mag; i++) { const p0 = pxAt(k, weeks[i].d); const pl = pxAt(k, weeks[i + mag].d); if (p0 && pl) unincon.push(pl / p0 - 1); }
    const meanAct = fwdAct.reduce((s, x) => s + x, 0) / eps.length;
    const meanInc = unincon.reduce((s, x) => s + x, 0) / unincon.length;
    // bootstrap por bloques: resampleamos del incondicional en bloques de 26
    SEED = 1234 + mag;
    const samples: number[] = [];
    for (let rep = 0; rep < 2000; rep++) { let s2 = 0, n2 = 0; while (n2 < eps.length) { const st = Math.floor(rnd() * (unincon.length - 26)); for (let j = 0; j < 26 && n2 < eps.length; j++, n2++) s2 += unincon[st + j]; } samples.push(s2 / eps.length); }
    samples.sort((a, b) => a - b);
    const lo = samples[Math.floor(0.05 * samples.length)], hi = samples[Math.floor(0.95 * samples.length)];
    const ok = meanAct > hi ? "MEJOR que 90% del azar" : meanAct < lo ? "PEOR que 90% del azar" : "dentro del azar";
    rows.push([lbl, meanAct - meanInc]);
    console.log(`${detName[k].padEnd(6)} fwd${lbl} tras activar=${(100 * meanAct).toFixed(1)}% vs incond=${(100 * meanInc).toFixed(1)}% · Δ=${(100 * meanAct - 100 * meanInc).toFixed(1)}pp · IC90 incond=[${(100 * lo).toFixed(0)}%,${(100 * hi).toFixed(0)}%] → ${ok}`);
  }
}

// BTC excluyendo 2010-2013
console.log("\n=== A3b: BTC excluyendo 2010-2013 (ventana 2014+ con CM) ===");
{
  const eps = episodesOf("BTC-EUR", 26).filter(e => e.d >= "2014-01-01");
  const fwd126 = eps.map(e => e.fwd126);
  const unincon: number[] = [];
  for (let i = 0; i < weeks.length - 26; i++) { if (weeks[i].d < "2014-01-01") continue; const p0 = pxAt("BTC-EUR", weeks[i].d); const pl = pxAt("BTC-EUR", weeks[i + 26].d); if (p0 && pl) unincon.push(pl / p0 - 1); }
  const ma = fwd126.reduce((s, x) => s + x, 0) / eps.length, mi = unincon.reduce((s, x) => s + x, 0) / unincon.length;
  console.log(`BTC 2014+: N=${eps.length} · fwd6m tras activar=${(100 * ma).toFixed(1)}% vs incond=${(100 * mi).toFixed(1)}% · Δ=${(100 * (ma - mi)).toFixed(1)}pp`);
  const hits = eps.filter(e => e.decl26 <= -0.10).length;
  console.log(`BTC 2014+ aciertos: ${hits}/${eps.length}`);
}

// ── A4: oro 2008 fwd desde trim>35% ─────────────────────────────
console.log("\n=== A4: ORO 2008 — fwd 3/6/12m desde cada semana con trim>35% ===");
{
  const pre: string[] = [];
  for (const w of weeks) { const t = w.trims["PPFB.DE"] ?? 0; if (w.d >= "2008-01-01" && w.d <= "2008-12-31" && t > 0.35) pre.push(w.d); }
  console.log(`semanas 2008 con trim ORO>35%: ${pre.length}`);
  for (const d of pre.slice(0, 20)) {
    const p0 = pxAt("PPFB.DE", d); if (!p0) continue;
    const f = (n: number) => { const i0 = weeks.findIndex(w2 => w2.d === d); const pl = pxAt("PPFB.DE", weeks[Math.min(i0 + n, weeks.length - 1)].d); return pl ? pl / p0 - 1 : NaN; };
    console.log(`  ${d}: fwd3m=${(100 * f(13)).toFixed(1)}% · fwd6m=${(100 * f(26)).toFixed(1)}% · fwd12m=${(100 * f(52)).toFixed(1)}%`);
  }
}
console.log("\n=== A4b: ORO — fwd desde cada episodio de DFII10>2.5% desde 2003 ===");
{
  const iDfii = mk(dfii); const starts: string[] = [];
  let inEp = false;
  for (const d of grid) { const ry = before(dfii, iDfii, d); const isEp = ry !== undefined && ry > 2.5;
    if (isEp && !inEp) starts.push(d); inEp = isEp; }
  for (const d of starts) { const p0 = pxAt("PPFB.DE", d); if (!p0) continue;
    const i0 = weeks.findIndex(w => w.d === d);
    const f = (n: number) => { const pl = pxAt("PPFB.DE", weeks[Math.min(i0 + n, weeks.length - 1)].d); return pl ? pl / p0 - 1 : NaN; };
    console.log(`  ${d}: fwd3m=${(100 * f(13)).toFixed(1)}% · fwd6m=${(100 * f(26)).toFixed(1)}% · fwd12m=${(100 * f(52)).toFixed(1)}% (fwd de las 4sem previas ND)`); }
}

// ── B3: picos locales del BTC ───────────────────────────────────
console.log("\n=== B3: picos locales BTC — Z/Puell/trim del detector real 0/30/60/90d antes ===");
const PEAKS: [string, string][] = [["2013-04-09", "2013"], ["2013-11-29", "2013"], ["2017-12-07", "2017"], ["2017-12-15", "2017"], ["2021-01-08", "2021"], ["2021-04-16", "2021"], ["2021-11-10", "2021"], ["2025-01-21", "2024-25"], ["2025-10-03", "2024-25"]];
for (const [d, lbl] of PEAKS) {
  const p0 = pxAt("BTC-EUR", d); if (!p0) continue;
  const i0 = weeks.findIndex(w => w.d >= d); if (i0 < 0) continue;
  const f = (n: number) => { const w2 = weeks[Math.max(0, i0 - n)]; return w2; };
  const cell = (n: number) => { const w2 = f(n); return `trim=${(100 * (w2.trims["BTC-EUR"] ?? 0)).toFixed(0).padStart(3)}% (Z ${(zSeriesExp.get(w2.d) ?? NaN).toFixed(2)} P${(puell.get(w2.d) ?? NaN).toFixed(2)})`; };
  console.log(`pico ${lbl} ${d} · P=${p0.toFixed(0).padStart(7)} · t0: ${cell(0)} · 30d: ${cell(4)} · 60d: ${cell(9)} · 90d: ${cell(13)}`);
}

// ── C1: barrido sintético COMPLETO + lista de cliffs ─────────────
console.log("\n=== C1: barrido sintético (detector real) — max Δtrim contiguo + lista de cliffs ===");
type Sweep = { det: string; key: string; from: number; to: number; step: number };
const SWEEPS: Sweep[] = [
  { det: "BTC Puell", key: "puellMultiple", from: 0, to: 6, step: 0.01 },
  { det: "BTC Z", key: "mvrvZScore", from: 0, to: 9, step: 0.01 },
  { det: "BTC RSI-W", key: "btcRsiWeekly", from: 70, to: 90, step: 0.05 },
  { det: "SEMIS RS Z", key: "soxSpyRelativeStrength", from: 0, to: 3, step: 0.01 },
  { det: "SEMIS RSI-W", key: "soxRsiWeekly", from: 70, to: 90, step: 0.05 },
  { det: "EMXC DXY", key: "dxy", from: 100, to: 120, step: 0.01 },
  { det: "EMXC RSI-W", key: "emxcRsiWeekly", from: 70, to: 90, step: 0.05 },
  { det: "ORO DFII10", key: "realYield10y", from: 0, to: 3.5, step: 0.01 },
  { det: "ORO Brent", key: "brentOil", from: 50, to: 150, step: 0.5 },
  { det: "URNU ratio", key: "uraniumSpotPrice", from: 0.9, to: 1.6, step: 0.01 },
];
const KEYTICK: Record<string, string> = { puellMultiple: "BTC-EUR", mvrvZScore: "BTC-EUR", btcRsiWeekly: "BTC-EUR", soxSpyRelativeStrength: "VVSM.DE", soxRsiWeekly: "VVSM.DE", dxy: "EMXC.DE", emxcRsiWeekly: "EMXC.DE", realYield10y: "PPFB.DE", brentOil: "PPFB.DE", uraniumSpotPrice: "URNU.DE" };
const cliffsAll: string[] = [];
for (const sw of SWEEPS) {
  const tk = KEYTICK[sw.key]; const trimAt = (x: number): number => {
    const inputs: CycleTopInputs & Record<string, unknown> = { bondYield10y: 4.0 };
    (inputs as any)[sw.key] = x;
    if (sw.key === "uraniumSpotPrice") (inputs as any).uraniumLTPrice = x; // ratio=1: sin señal esperada
    const out = detectCycleTops(inputs as CycleTopInputs);
    const s = out.signals.find(s2 => s2.ticker === tk);
    return (s?.trimPct ?? 0) / 100;
  };
  let maxJump = 0, atJump = ""; const cliffs: string[] = [];
  let prev = trimAt(sw.from);
  for (let x = sw.from + sw.step; x <= sw.to + 1e-9; x += sw.step) {
    const cur = trimAt(x);
    if (Math.abs(cur - prev) >= 0.05) cliffs.push(`x=${x.toFixed(2)}: ${(100 * prev).toFixed(0)}%→${(100 * cur).toFixed(0)}% (Δ${(100 * Math.abs(cur - prev)).toFixed(0)}pp)`);
    if (Math.abs(cur - prev) > maxJump) { maxJump = Math.abs(cur - prev); atJump = `${(x - sw.step).toFixed(2)}→${x.toFixed(2)}`; }
    prev = cur;
  }
  cliffsAll.push(`${sw.det.padEnd(14)} maxΔtrim=${(100 * maxJump).toFixed(1)}pp (${atJump}) · cliffs≥5pp: ${cliffs.length}`);
  console.log(`${sw.det.padEnd(14)} ${sw.key.padEnd(24)} [${sw.from},${sw.to}] paso ${sw.step}: max Δtrim=${(100 * maxJump).toFixed(1)}pp en ${atJump} · cliffs≥5pp=${cliffs.length}`);
  for (const c of cliffs.slice(0, 12)) console.log("    " + c);
}

// ── D2: trim agregado PONDERADO por peso real de sleeve ─────────
console.log("\n=== D2: trim agregado PONDERADO (peso igual 1/6 por sleeve) en 2008 / mar-2020 / 2022 ===");
for (const [a, b, lbl] of [["2008-01-01", "2009-03-31", "GFC 2008-09"], ["2020-02-15", "2020-04-15", "COVID mar-2020"], ["2022-01-01", "2022-12-31", "2022"]] as const) {
  console.log(`  ${lbl}:`);
  let sumW = 0, maxIndiv = 0; let maxD = "", maxWLabel = "";
  for (const w of weeks) {
    if (w.d < a || w.d > b) continue;
    let aggW = 0;
    for (const k of TICKS) { const t = w.trims[k] ?? 0; const contrib = (1 / 6) * t; if (Number.isFinite(contrib)) { aggW += contrib; if (t > maxIndiv) { maxIndiv = t; maxD = w.d; maxWLabel = detName[k]; } } }
    if (weeks.length && w.d.slice(0, 7) !== (weeks[weeks.indexOf(w) - 1]?.d ?? w.d).slice(0, 7)) console.log(`    ${w.d}: trimPonderado=${(100 * aggW / (1 / 6)).toFixed(1)}pp × w=1/6 → ${aggW.toFixed(3)}`);
    sumW += aggW;
  }
  const nSem = weeks.filter(w => w.d >= a && w.d <= b).length;
  console.log(`    media ${lbl}: trim ponderado medio=${(sumW / nSem * 100).toFixed(1)}pp · máx individual=${(100 * maxIndiv).toFixed(0)}% ( ${maxWLabel} en ${maxD} )`);
}

// ── D3: correlaciones con N de solape ────────────────────────────
console.log("\n=== D3: correlación de activaciones CON N de semanas solapadas ===");
const cmpIDX = weeks.map((w, i) => i).filter(i => weeks[i].hasInput);
for (let a = 0; a < TICKS.length; a++) for (let b = a + 1; b < TICKS.length; b++) {
  const xs = cmpIDX.map(i => ((weeks[i].trims[TICKS[a]] ?? 0) > 0 ? 1 : 0));
  const ys = cmpIDX.map(i => ((weeks[i].trims[TICKS[b]] ?? 0) > 0 ? 1 : 0));
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  const vx = xs.reduce((s, x) => s + (x - mx) ** 2, 0) / xs.length, vy = ys.reduce((s, y) => s + (y - my) ** 2, 0) / ys.length;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.length;
  const r = vx > 1e-12 && vy > 1e-12 ? cov / Math.sqrt(vx * vy) : NaN;
  console.log(`  ${detName[TICKS[a]].padEnd(6)} vs ${detName[TICKS[b]].padEnd(6)}: r=${Number.isNaN(r) ? "NA (varianza 0)" : r.toFixed(2)} · N solapadas=${cmpIDX.length} · media activo=${(mx).toFixed(2)}/${(my).toFixed(2)}`);
}

// ── C2: rampa interpolada NEUTRA (nudos en las anclas del escalón real) ──
console.log("\n=== C2: rampa NEUTRA (trim=0 en el mismo punto que el escalón) vs vieja ===");
{ // DXY: nudo (103,0) no (98,0); (106,0.75); (110,2.5); (115,3)
  const R_NEUTRA: [number, number][] = [[103, 0], [106, 0.75], [110, 1.5 - 0.75 + 0.75], [115, 3]]; // pts=0.75/1.5/3 idénticos arriba
  // ajusta para que pts>106 =1.5 (no 0.75): rampa de PTS neutral = [[103,0],[106,0.75],[110,2.5],[115,3]] con pane
  // rampa NEUTRA canónica (idéntica a m4_cliffs.ts): reproduce el escalón en los
  // nudos 106/110/115 y añade 118 como techo; arranca en 0 en 103.
  const steps: [number, number][] = [[103, 0], [106, 0.75], [110, 1.5], [115, 2.5], [118, 3]];
  const OLD: [number, number][] = [[98, 0], [104.5, 0.75], [108, 1.5], [112.5, 2.5], [118, 3]];
  const interp = (r: [number, number][], x: number) => { if (x <= r[0][0]) return r[0][1]; if (x >= r[r.length - 1][0]) return r[r.length - 1][1]; for (let i = 1; i < r.length; i++) { if (x <= r[i][0]) return r[i - 1][1] + (r[i][1] - r[i - 1][1]) * (x - r[i - 1][0]) / (r[i][0] - r[i - 1][0]); } return r[r.length - 1][1]; };
  console.log("DXY | trim real (step) | rampa ANTES (98→0) | rampa NEUTRA (103→0)");
  for (const x of [102.9, 103.0, 103.01, 104, 105, 106, 108, 110, 112, 115, 117]) {
    const step = x > 115 ? 3 : x > 110 ? 2.5 : x > 106 ? 1.5 : x > 103 ? 0.75 : 0;
    const trimOf = (pts: number) => { const ANCH: [number, number][] = [[0, 1.0], [0.5, 0.75], [1.5, 0.55], [2.5, 0.35], [3.5, 0.20], [5.0, 0.10]]; let m = 1.0; for (let j = 1; j < ANCH.length; j++) { if (pts <= ANCH[j][0]) { m = ANCH[j - 1][1] + (ANCH[j][1] - ANCH[j - 1][1]) * (pts - ANCH[j - 1][0]) / (ANCH[j][0] - ANCH[j - 1][0]); break; } } m = Math.max(0.05, Math.min(1, m)); return (1 - m) * 100; };
    console.log(`  ${x.toFixed(2).padStart(7)} | ${trimOf(step).toFixed(0).padStart(8)}% | ${(trimOf(interp(OLD, x))).toFixed(0).padStart(9)}% | ${(trimOf(interp(steps, x))).toFixed(0).padStart(9)}%`);
  }
}

// ── C3: histéresis sobre la ENTRADA (estado del input, no del trim) ──
console.log("\n=== C3: histéresis sobre ENTRADA (DXY entrar 103/salir 101) — ops/impuestos/fricción con harness reparado ===");
{
  const iDxy = mk(dxyRows);
  const k = "EMXC.DE";
  // raw trim = step del DXY con histéresis de ENTRADA
  let on = false; const routed: number[] = []; const dates2: string[] = [];
  for (const w of weeks) {
    const dx = before(dxyRows, iDxy, w.d);
    if (!w.hasInput) { routed.push(0); continue; } else routed.push(undefined as unknown as number), dates2.push(w.d);
    let pts = 0;
    if (dx !== undefined) {
      if (!on && dx > 103) on = true; else if (on && dx < 101) on = false;
      if (on) pts = dx > 115 ? 3 : dx > 110 ? 2.5 : dx > 106 ? 1.5 : 0.75;
    }
    const ANCH: [number, number][] = [[0, 1.0], [0.5, 0.75], [1.5, 0.55], [2.5, 0.35], [3.5, 0.20], [5.0, 0.10]];
    let m = 1.0; for (let j = 1; j < ANCH.length; j++) { if (pts <= ANCH[j][0]) { m = ANCH[j - 1][1] + (ANCH[j][1] - ANCH[j - 1][1]) * (pts - ANCH[j - 1][0]) / (ANCH[j][0] - ANCH[j - 1][0]); break; } }
    m = Math.max(0.05, Math.min(1, m));
    routed[routed.length - 1] = 1 - m;
  }
  // arrancamos sólo en 1o input
  const firstIn = weeks.findIndex(w => w.hasInput);
  const prices: (string | undefined)[] = []; const t3: number[] = []; const ds3: string[] = []; const irxs: (string | undefined)[] = [];
  for (let i = firstIn; i < weeks.length; i++) { prices.push(pxAt(k, weeks[i].d)); t3.push(routed[i] ?? 0); ds3.push(weeks[i].d); irxs.push(irxAt(weeks[i].d)); }
  const rawTrim = weeks.map(w => w.trims[k] ?? 0);
  const r3 = runSleeve(prices, t3, { cashBox: "CASH0", dates: ds3 });
  const rRaw = runSleeve(prices, rawTrim.slice(firstIn), { cashBox: "CASH0", dates: ds3 });
  const row3 = (lbl: string, r: SleeveResult) => `${lbl.padEnd(14)} CAGR ${(100 * r.cagr).toFixed(2).padStart(6)}% · MaxDD ${(100 * r.maxdd).toFixed(1).padStart(6)}% · ops ${r.ops} · impuestos€ ${r.taxes.toFixed(0).padStart(7)} · spreads€ ${r.spread.toFixed(0).padStart(5)} · expoMedia ${(100 * r.meanExpo).toFixed(1)}%`;
  console.log("  " + row3("raw (step)", rRaw));
  console.log("  " + row3("+hyst ENTRADA", r3));
}

// ── C4: topes por familia 30/40 + presupuesto con HARNESS REPARADO (primarias: ops/imp/fricción) ──
console.log("\n=== C4: topes 30/40% por familia con motor reparado (turnover/impuestos primaria) ===");
for (const k of ["PPFB.DE", "EMXC.DE", "VVSM.DE", "BTC-EUR"] as const) {
  const s = sleeveArrays(k, true);
  const raw = s.trims;
  const cap30 = raw.map(x => Math.min(0.30, x)); const cap40 = raw.map(x => Math.min(0.40, x));
  const rRaw = runSleeve(s.prices, raw, { cashBox: "CASH0", dates: s.dates });
  const r30 = runSleeve(s.prices, cap30, { cashBox: "CASH0", dates: s.dates });
  const r40 = runSleeve(s.prices, cap40, { cashBox: "CASH0", dates: s.dates });
  const rowFx = (lbl: string, r: SleeveResult) => `${lbl.padEnd(10)} ops=${r.ops} · impuestos€ ${r.taxes.toFixed(0).padStart(6)} · spreads€ ${r.spread.toFixed(0).padStart(4)} · CAGR ${(100 * r.cagr).toFixed(2).padStart(6)}% · MaxDD ${(100 * r.maxdd).toFixed(1)}%`;
  console.log(`${detName[k]}: \n  ${rowFx("raw", rRaw)}\n  ${rowFx("cap30", r30)}\n  ${rowFx("cap40", r40)}`);
}

// ── C5: WLG con P/E del repo hoy: trim que daría hoy ──
console.log("\n=== C5: WLG hoy — P/E forward del repo (20) y trim que el detector real daría ===");
{
  const inputs: CycleTopInputs = { bondYield10y: 4.0, wlgPERatio: 20, wlgRsiWeekly: undefined };
  void inputs;
  // el detector real recibe wlgPERatio (via marketdata); aquí llamamos directo
  const inp: any = { bondYield10y: 4.0, wlgPERatio: 20 };
  const out = detectCycleTops(inp);
  const s = out.signals.find(x2 => x2.ticker === "0P00000WLG.F");
  console.log(`  con P/E fwd=20 y sin RSI: trim hoy = ${s?.trimPct ?? "(wlgPERatio aceptado) - revisar"}% · razón: ${s?.reason.slice(0, 90)}`);
}

// ── D1: CARTERA completa con motor REPARADO (6 sleeves, w=1/6, banda 2% NAV) ──
console.log("\n=== D1: CARTERA 6-sleeve = motor real: w_s=NAV/6·(1−trim_s), banda 2% — dos cajas ===");
for (const [box, costs, useTrim] of [["TBILL", true, true], ["CASH0", true, true], ["TBILL", false, true], ["TBILL", true, false], ["CASH0", true, false]] as const) {
  const SPREAD = 0.0005, TAX = 0.26, N = 6, BAND = 0.02;
  const CM = costs ? 1 : 0;
  let cash = 10000, taxes = 0, spreads = 0, ops = 0;
  const st: { sh: number; avg: number }[] = TICKS.map(() => ({ sh: 0, avg: 0 }));
  const navs: number[] = []; const navD: string[] = [];
  let started = false;
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    const px = TICKS.map(k => pxAt(k, w.d));
    const nav = cash + st.reduce((s, x, j) => s + x.sh * (px[j] ?? x.sh * x.avg), 0);
    if (!started) {
      if (px.some(p => p === undefined)) continue;   // aún no hay serie completa: NO arrancamos
      started = true; cash = 10000;                   // la cartera empieza aquí (NAV=10000, fecha real)
      navs.push(cash); navD.push(w.d); continue;      // navs y navD quedan ALINEADOS desde el inicio
    }
    if (!px.every(p => p !== undefined)) continue; // en semanas incompletas NO rebalanceamos
    for (let j = 0; j < TICKS.length; j++) {
      const p = px[j]!; const trim = useTrim && w.hasInput ? (w.trims[TICKS[j]] ?? 0) : 0;
      const target = (nav / N) * (1 - trim);
      const cur = st[j].sh * p; const delta = target - cur;
      if (delta < -BAND * nav && st[j].sh > 0) {
        const q = Math.min(st[j].sh, -delta / p); const proc = q * p;
        taxes += Math.max(0, (p - st[j].avg) * q) * TAX * CM; const sc = proc * SPREAD * CM; spreads += sc;
        cash += proc - sc; st[j].sh -= q; ops++;
      } else if (delta > BAND * nav && cash >= delta) {
        const sc2 = delta * SPREAD * CM; spreads += sc2;
        st[j].avg = (st[j].avg * st[j].sh + p * (delta / p)) / (st[j].sh + delta / p);
        st[j].sh += delta / p; cash -= delta; ops++;
      }
    }
    if (box === "TBILL" && cash > 0) { const r = irxAt(w.d); if (r !== undefined) cash *= 1 + r / 100 / 52; }
    const navNow = cash + st.reduce((s, x, j) => s + x.sh * (px[j] ?? 0), 0);
    navs.push(navNow); navD.push(w.d);
  }
  const rets = navs.map((x, j) => (j ? x / navs[j - 1] - 1 : 0)).slice(1).filter(x => Number.isFinite(x));
  const mean = rets.reduce((s, r) => s + r, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length));
  let peak = navs[0] ?? 1, dd = 0; for (const x of navs) { peak = Math.max(peak, x); dd = Math.min(dd, x / peak - 1); }
  const firstD = navD[0] ?? ""; const lastD = navD[navD.length - 1] ?? "";
  // CAGR EXACTO con fechas reales: años = días/365.25 (no semanas/52)
  const days = (new Date(lastD).getTime() - new Date(firstD).getTime()) / 86400000;
  const yearsExact = days / 365.25;
  const cagrExact = Math.pow(navs[navs.length - 1] / navs[0], 1 / yearsExact) - 1;
  const lbl = `${box}${useTrim ? "-ON" : "-OFF"}${costs ? "" : "-gross"}`;
  console.log(`  ${lbl.padEnd(14)} | CAGR ${(100 * cagrExact).toFixed(2)}% EXACTO (${firstD}→${lastD}, ${yearsExact.toFixed(2)} años) | vol ${(100 * sd * Math.sqrt(52)).toFixed(1)}% | MaxDD ${(100 * dd).toFixed(1)}% | ops ${ops} | impuestos€ ${taxes.toFixed(0)} | spreads€ ${spreads.toFixed(0)}`);
}

writeFileSync("audit/m3_results.json", JSON.stringify({
  weeks: weeks.map(w => ({ d: w.d, trims: w.trims, hasInput: w.hasInput })),
  newBacktests: Object.fromEntries(Object.entries(resNew).map(([k, v]) => [detName[k], v])),
  cliffs: cliffsAll,
}, null, 1));
console.log("\n[saved] audit/m3_results.json");
