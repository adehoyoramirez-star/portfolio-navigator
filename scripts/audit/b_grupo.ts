// ============================================================
// scripts/audit/b_grupo.ts — BLOQUE B (B2, B4, B5, B6)
// B2: BTC OFF ventana común Yahoo/CM + validación de precios en ≥10 fechas
// B4: barrido sintético con detectCycleTops() REAL, max Δtrim contiguo antes/después
// B5: MVRV Z expansiva vs ventana completa en los picos
// B6: trim por detector y agregado en 2008 / mar-2020 / 2022 (declara participantes)
// No toca src/. Ejecutar: npx tsx scripts/audit/b_grupo.ts
// ============================================================
import { readFileSync } from "fs";
import { detectCycleTops, type CycleTopInputs } from "../../src/core/risk/cycleTopDetector";

const DATA = "audit/data";
type Row = { d: string; v: number };
const parseCSV = (file: string, col = 1): Row[] =>
  readFileSync(`${DATA}/${file}`, "utf8").trim().split("\n").slice(1)
    .map(l => l.split(",")).filter(c => Number.isFinite(+c[col]))
    .map(c => ({ d: c[0], v: +c[col] }));

// ── B2: BTC Yahoo vs Coin Metrics ────────────────────────────────
const y = parseCSV("yahoo_BTC_USD.csv", 2);
const yIdx = new Map<string, number>(); y.forEach((r, i) => yIdx.set(r.d, i));
const ycloses = new Map<string, number>(); y.forEach(r => ycloses.set(r.d, r.v));

// precio Coin Metrics RECONSTRUIDO con la MISMA receta que fase1/fase2:
// price = CapMrktCurUSD / SplyCur → idéntico a phase2_base = CapMVRVCur UM
const cmCols = readFileSync(`${DATA}/coinmetrics_btc.csv`, "utf8").trim().split("\n").slice(1)
  .map(l => l.split(","))
  .filter(c => Number.isFinite(+c[2]))
  .map(c => ({ d: c[0], mvrv: +c[1], cap: +c[2], real: +c[3], iss: c[4] === "" ? NaN : +c[4] }));
// SplyCur NO está en coinmetrics_btc.csv; coinmetrics_btc_price.csv ya la tiene precomputada
const cmPrice = parseCSV("coinmetrics_btc_price.csv", 1);
const cmIdx = new Map<string, number>(); cmPrice.forEach((r, i) => cmIdx.set(r.d, i));
const cmCloses = new Map<string, number>(); cmPrice.forEach(r => cmCloses.set(r.d, r.v));

function atOrBefore(m: Map<string, number>, idx: Map<string, number>, rows: Row[], d: string): number | undefined {
  let i = idx.get(d);
  if (i === undefined) { let lo = 0, hi = rows.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].d <= d) lo = mid + 1; else hi = mid - 1; } i = hi; }
  return i >= 0 ? rows[i].v : undefined;
}
const yAt = (d: string) => atOrBefore(ycloses, yIdx, y, d);
const cmAt = (d: string) => atOrBefore(cmCloses, cmIdx, cmPrice, d);

console.log("=== B2a: precios BTC (CM vs Yahoo) en 14 fechas — validación (intersección 2014-09→2026-10) ===");
const DATES = ["2014-10-01", "2015-06-15", "2016-03-01", "2017-01-10", "2017-12-15", "2018-12-15",
  "2020-03-23", "2021-04-16", "2022-06-18", "2023-01-01", "2024-03-14", "2024-09-17", "2025-04-01", "2026-03-01"];
let maxRelErr = 0, worstDate = "";
for (const d of DATES) {
  const cm = cmAt(d), yv = yAt(d);
  if (cm === undefined || yv === undefined) { console.log(`  ${d}: (CM ${cm ?? "—"}, Yahoo ${yv ?? "—"}) → sin dato`); continue; }
  const rel = Math.abs(cm - yv) / yv;
  if (rel > maxRelErr) { maxRelErr = rel; worstDate = d; }
  console.log(`  ${d}: CM ${(cm).toFixed(2)} vs Yahoo ${(yv).toFixed(2)} → err rel ${(100 * rel).toFixed(3)}%`);
}
console.log(`  MAX err rel ${(100 * maxRelErr).toFixed(3)}% (${worstDate})`);

// OFF en la MISMA ventana (intersección) y el MISMO cadence semanal
const weekKey = (d: string) => { const dt = new Date(d + "T00:00:00Z"); const day = dt.getUTCDay(); dt.setUTCDate(dt.getUTCDate() - day); return dt.toISOString().slice(0, 10); };
const spx = parseCSV("yahoo__GSPC.csv", 2);
const lastOfWeek = new Map<string, string>();
for (const r of spx) lastOfWeek.set(weekKey(r.d), r.d);
const grid = [...lastOfWeek.values()].sort();
const gridCommon = grid.filter(d => {
  const sy = cmAt(d), yy = yAt(d);
  return sy !== undefined && yy !== undefined;
});
const START = gridCommon[0], END = gridCommon[gridCommon.length - 1];
console.log(`\n=== B2b: BTC OFF (hold, cero costes, mismo grid), ventana común ${START} → ${END} (${gridCommon.length} semanas) ===`);
for (const [lbl, f] of [["CoinMetrics", cmAt], ["Yahoo", yAt]] as const) {
  const p0 = f(START)!, p1 = f(END)!;
  const years = (new Date(END).getTime() - new Date(START).getTime()) / 86400000 / 365.25;
  const cagr = Math.pow(p1 / p0, 1 / years) - 1;
  console.log(`  ${lbl.padEnd(12)}: P0 ${START} ${p0.toFixed(2)} → P1 ${END} ${p1.toFixed(2)} · CAGR ${(100 * cagr).toFixed(2)}%`);
}

// ── helpers del detector (idénticos a fase2: std EXPANSIVA point-in-time) ──
const zSeriesExp = new Map<string, number>();
const zSeriesFull = new Map<string, number>();
{
  const diffs: number[] = [];
  let n = 0, mean = 0, m2 = 0;
  for (const r of cmCols) {
    if (!Number.isFinite(r.cap) || !Number.isFinite(r.real)) continue;
    const diff = r.cap - r.real;
    diffs.push(diff);
    n++; const d = diff - mean; mean += d / n; m2 += d * (diff - mean);
    if (n > 30) zSeriesExp.set(r.d, diff / Math.sqrt(m2 / n)); // std EXPANSIVA
  }
  const meanFull = diffs.reduce((s, x) => s + x, 0) / diffs.length;
  const sdFull = Math.sqrt(diffs.reduce((s, x) => s + (x - meanFull) ** 2, 0) / diffs.length);
  for (const r of cmCols) if (Number.isFinite(r.cap) && Number.isFinite(r.real) && sdFull > 0)
    zSeriesFull.set(r.d, (r.cap - r.real - meanFull) / sdFull); // std VENTANA COMPLETA (leak look-ahead)
}
// Puell identico a fase2 (MA-365 días)
const puell = new Map<string, number>();
{
  const iss: Row[] = cmCols.filter(r => Number.isFinite(r.iss)).map(r => ({ d: r.d, v: r.iss }));
  for (let i = 364; i < iss.length; i++) { let s = 0; for (let j = i - 364; j <= i; j++) s += iss[j].v; const ma = s / 365; if (ma > 0) puell.set(iss[i].d, iss[i].v / ma); }
}

console.log("\n=== B5: MVRV Z en picos (expansiva [fase2] vs ventana completa) + Puell ===");
console.log("pico | fecha | Z_exp | Z_full | Δ | Puell | (publicado, de memoria)");
const PUB: Record<string, [number, number]> = {
  "2013-11-29": [7.9, 6.2],  // de memoria: Glassnode ~7-8; McNutt ~6
  "2017-12-15": [7.2, 6.1],  // de memoria: Glassnode ~7.4
  "2021-04-16": [6.4, 5.5],  // de memoria: Glassnode ~6.2
  "2025-10-03": [-1, -1],    // de memoria: no recuerdo dato publicado
};
const weeks: string[] = grid.filter(d => zSeriesExp.has(d) || zSeriesFull.has(d));
for (const [d, [pubExp, pubOther]] of Object.entries(PUB)) {
  const ze = zSeriesExp.get(d), zf = zSeriesFull.get(d), pu = puell.get(d);
  if (ze === undefined) { console.log(`  ${d}: sin dato de reconstrucción`); continue; }
  const tag = pubExp === -1 ? "sin ref publicada (de memoria)" : `Glassnode ~${pubExp} (de memoria)`;
  console.log(`  ${d}: Z_exp ${(ze).toFixed(2)} | Z_full ${(zf ?? NaN).toFixed(2)} | Δ ${(ze - (zf ?? NaN)).toFixed(2)} | Puell ${(pu ?? NaN).toFixed(2)} | ${tag}`);
}
// picos reales (máximo Z de cada año de pico)
for (const yr of [2013, 2017, 2021, 2025]) {
  const inYr = [...zSeriesExp.entries()].filter(([d]) => d.startsWith(String(yr)));
  const best = inYr.reduce<{ d: string; v: number }>((b, [d, v]) => (v > b.v ? { d, v } : b), { d: "", v: -1e9 });
  const zf = zSeriesFull.get(best.d) ?? NaN;
  console.log(`  maxZ ${yr}: ${best.d} · Z_exp ${best.v.toFixed(2)} · Z_full ${zf.toFixed(2)} · Δ ${(best.v - zf).toFixed(2)}`);
}

// ── B4: barrido sintético con detector REAL ───────────────────────
console.log("\n=== B4: barrido sintético con detectCycleTops() REAL — max Δtrim contiguo ===");
const BTC_Z = [4.36]; // placeholder sobrescrito abajo: barrido REAL
// (no se usan datos: inputs sintéticos puros, 1 detector por barrido)
type Sweep = { det: string; key: keyof CycleTopInputs; from: number; to: number; step: number; extra?: Partial<CycleTopInputs> };
const SWEEPS: Sweep[] = [
  { det: "BTC (Puell)", key: "puellMultiple", from: 0, to: 6, step: 0.01 },
  { det: "EMXC (DXY)", key: "dxy", from: 100, to: 120, step: 0.01 },
  { det: "SEMIS (RS Z)", key: "soxSpyRelativeStrength", from: 0, to: 3, step: 0.01 },
  { det: "SEMIS (RSI-W)", key: "soxRsiWeekly", from: 70, to: 90, step: 0.05 },
  { det: "BTC (RSI-W)", key: "btcRsiWeekly", from: 70, to: 90, step: 0.05 },
];
// rampas de interpolación PROPUESTAS (reemplazan los if/else duros; declarado en el script)
const R_PUELL: [number, number][] = [[0, 0], [2.5, 1], [3.5, 2], [5, 3], [6, 3.5]]; // sustituye tramos duros 2.5/3.5/5.0
const R_DXY: [number, number][] = [[98, 0], [104.5, 0.75], [108, 1.5], [112.5, 2.5], [118, 3]]; // sustituye 103/106/110/115
const R_RS: [number, number][] = [[0, 0], [1.0, 0.75], [1.5, 1.5], [2.0, 2], [3, 2.5]]; // sustituye 1.0/1.5/2.0
const R_RSI: [number, number][] = [[70, 0], [80, 1], [85, 2], [90, 2.5]]; // sustituye 80/85
function interp(ramp: [number, number][], x: number): number {
  if (x <= ramp[0][0]) return ramp[0][1];
  if (x >= ramp[ramp.length - 1][0]) return ramp[ramp.length - 1][1];
  for (let i = 1; i < ramp.length; i++) { const [x0, y0] = ramp[i - 1], [x1, y1] = ramp[i]; if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  return ramp[ramp.length - 1][1];
}
function detectoirReal(key: keyof CycleTopInputs, x: number, ramp?: [number, number][]): number {
  if (ramp) return interp(ramp, x); // VARIANTE INTERPOLADA → misma escala topSignals
  const inputs: CycleTopInputs = { bondYield10y: 4.0 } as CycleTopInputs;
  (inputs as any)[key] = x;
  const out = detectCycleTops(inputs);
  const s = out.signals.find(s2 => ({
    "puellMultiple": "BTC-EUR", "btcRsiWeekly": "BTC-EUR", "dxy": "EMXC.DE",
    "soxSpyRelativeStrength": "VVSM.DE", "soxRsiWeekly": "VVSM.DE",
  } as any)[key] === s2.ticker);
  return s ? s.trimPct : 0;
}
console.log("detector | input | trim real | trim interpolado (propuesta)");
for (const sw of SWEEPS) {
  let maxJ_Real = 0, atReal = ""; let maxJ_Int = 0, atInt = "";
  let prevR: number | null = null, prevI: number | null = null;
  for (let x = sw.from; x <= sw.to + 1e-9; x += sw.step) {
    const r = detectoirReal(sw.key, x, undefined);
    const i2 = detectoirReal(sw.key, x, undefined);
    // interpolación propuesta por rampa
    const iProp = interp(sw.key === "puellMultiple" ? R_PUELL : sw.key === "dxy" ? R_DXY : sw.key === "soxSpyRelativeStrength" ? R_RS : R_RSI, x);
    const trimProp = (() => { // mismo multiplierFromScore: trim = (1-mult(score))*100
      const ANCH: [number, number][] = [[0, 1.0], [0.5, 0.75], [1.5, 0.55], [2.5, 0.35], [3.5, 0.2], [5, 0.1]];
      let m = ANCH[ANCH.length - 1][1];
      for (let k = 1; k < ANCH.length; k++) { const [x0, y0] = ANCH[k - 1], [x1, y1] = ANCH[k]; if (iProp <= x1) { m = y0 + (y1 - y0) * (iProp - x0) / (x1 - x0); break; } }
      return (1 - Math.max(0.05, Math.min(1, m))) * 100;
    })();
    if (prevR !== null) { const j = Math.abs(r - prevR); if (j > maxJ_Real) { maxJ_Real = j; atReal = `${(x - sw.step).toFixed(2)}→${x.toFixed(2)}`; } }
    if (prevI !== null) { const j = Math.abs(trimProp - prevI); if (j > maxJ_Int) { maxJ_Int = j; atInt = `${(x - sw.step).toFixed(2)}→${x.toFixed(2)}`; } }
    prevR = r; prevI = trimProp;
  }
  console.log(`${sw.det.padEnd(15)} rango [${sw.from},${sw.to}] paso ${sw.step}: max Δtrim REAL ${(maxJ_Real).toFixed(1)}pp (${atReal}) → INTERP ${(maxJ_Int).toFixed(1)}pp (${atInt})`);
}

// ── B6: trim por detector y agregado en ventanas de estrés ───────
console.log("\n=== B6: trim por detector (detectCycleTops() real) en ventanas de estrés ===");
const dxyRows = parseCSV("yahoo_DX_Y_NYB.csv", 2);
const dfii = parseCSV("fred_DFII10.csv");
const t10yie = parseCSV("fred_T10YIE.csv");
const soxRows = parseCSV("yahoo__SOX.csv", 2);
const urth = parseCSV("yahoo_URTH.csv", 2);
const eem = parseCSV("yahoo_EEM.csv", 2);
const mk = (rows: Row[]) => { const idx = new Map<string, number>(); rows.forEach((r, i) => idx.set(r.d, i)); return idx; };
const iDxy = mk(dxyRows), iDfii = mk(dfii), iT10 = mk(t10yie), iSox = mk(soxRows), iUrth = mk(urth), iBtc = mk(cmPrice), iEem = mk(eem);
const val = (rows: Row[], idx: Map<string, number>, d: string) => atOrBefore(new Map(rows.map(r => [r.d, r.v])), idx, rows, d);
// RSI semanal (reconstrucción identica a fase2)
const grid2 = grid; // (calendario ^GSPC)
function makeWeekly(rows: Row[], idx: Map<string, number>) { const arr: { d: string; v: number }[] = []; for (const d of grid2) { const v = val(rows, idx, d); if (v !== undefined) arr.push({ d, v }); } return arr; }
const wSox = makeWeekly(soxRows, iSox), wUrth = makeWeekly(urth, iUrth), wBtc = makeWeekly(cmPrice, iBtc);
function rsiOf(arr: { d: string; v: number }[], upto: string): number | undefined {
  if (arr.length < 14) return undefined;
  const iP = arr.findIndex(a => a.d === upto);
  if (iP < 0 || iP < 13) return undefined;
  let g = 0, l = 0;
  for (let j = iP - 13; j <= iP; j++) { const ch = arr[j].v - arr[j - 1].v; if (ch > 0) g += ch; else l -= ch; }
  return l === 0 ? 100 : 100 - 100 / (1 + (g / 14) / (l / 14));
}
function rsZAt(d: string): number | undefined {
  const pairs: { d: string; r: number }[] = [];
  for (const r of soxRows) { const s = val(spx, mk(spx), r.d); void s; }
  // ventanal 200d del ratio SOX/SPX — heavy; reutiliza directo: precomputa serie diaria una vez
  return undefined; // placeholder sobrescrito abajo
}
// precomputa rsZ (roll 200d) una vez
const soxIdx2 = new Map<string, number>(); soxRows.forEach((r, i) => soxIdx2.set(r.d, i));
const spxIdx2 = new Map<string, number>(); spx.forEach((r, i) => spxIdx2.set(r.d, i));
const spxMap = new Map<string, number>(); spx.forEach(r => spxMap.set(r.d, r.v));
const rsZmap = new Map<string, number>();
{
  const pairs: { d: string; r: number }[] = [];
  for (const r of soxRows) { const s = spxMap.get(r.d); if (s && s > 0) pairs.push({ d: r.d, r: r.v / s }); }
  for (let i = 199; i < pairs.length; i++) {
    let m = 0, m2 = 0, n = 0;
    const lo = i - 199;
    for (let j = lo; j <= i; j++) { n++; const d = pairs[j].r - (pairs[j].r); m += pairs[j].r; }
    void m2;
    const win = pairs.slice(lo, i + 1); const mean = win.reduce((s, x) => s + x.r, 0) / win.length;
    const sd = Math.sqrt(win.reduce((s, x) => s + (x.r - mean) ** 2, 0) / win.length);
    if (sd > 0) rsZmap.set(pairs[i].d, (pairs[i].r - mean) / sd);
  }
}
function stressScan(a: string, b: string, label: string) {
  console.log(`  ${label} (${a}→${b}):`);
  const parts: string[] = [];
  for (const d of grid.filter(x => x >= a && x <= b)) {
    const inputs: CycleTopInputs = { bondYield10y: val(t10yie, iT10, d) ?? 4.0 };
    const z = zSeriesExp.get(d); if (z !== undefined) (inputs as any).mvrvZScore = z;
    const pu = puell.get(d); if (pu !== undefined) (inputs as any).puellMultiple = pu;
    const br = rsiOf(wBtc, d); if (br !== undefined) (inputs as any).btcRsiWeekly = br;
    const rz = rsZmap.get(d); if (rz !== undefined) (inputs as any).soxSpyRelativeStrength = rz;
    const sr = rsiOf(wSox, d); if (sr !== undefined) (inputs as any).soxRsiWeekly = sr;
    const ry = val(dfii, iDfii, d); if (ry !== undefined) (inputs as any).realYield10y = ry;
    const dx = val(dxyRows, iDxy, d); if (dx !== undefined) (inputs as any).dxy = dx;
    const wr = rsiOf(wUrth, d); if (wr !== undefined) (inputs as any).wlgRsiWeekly = wr;
    const out = detectCycleTops(inputs);
    const trims: Record<string, number> = {};
    for (const s of out.signals) trims[s.ticker] = s.trimPct;
    const who: string[] = [];
    let agg = 0;
    for (const [tk, nm] of [["BTC-EUR", "BTC"], ["VVSM.DE", "SEMIS"], ["PPFB.DE", "ORO"], ["EMXC.DE", "EMXC"], ["0P00000WLG.F", "WLG"], ["URNU.DE", "URANIO"]] as const) {
      if (trims[tk] > 0) { who.push(nm); agg += trims[tk]; }
    }
    parts.push(`    ${d}: activos ${who.length ? who.join("+") : "—"} · trim agregado ${agg.toFixed(2)}`);
  }
  console.log(parts.join("\n"));
}
stressScan("2008-09-01", "2009-03-31", "GFC 2008-09");
stressScan("2020-02-15", "2020-04-15", "COVID mar-2020");
stressScan("2022-01-01", "2022-12-31", "2022");
