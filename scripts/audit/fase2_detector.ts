// ============================================================
// scripts/audit/fase2_detector.ts — FASE 2: test decisivo por detector
// IMPORTA el código REAL de src/core/risk/cycleTopDetector.ts (0 líneas de src modificadas).
// Datos reales de scripts/audit/data/ (FRED, Yahoo, Coin Metrics — ver README.md).
//
// SUPUESTOS DECLARADOS A PRIORI:
//   - Cadencia: semanal (último día hábil del mes ISO), grid = calendario ^GSPC.
//   - "Acierto" (fijado ANTES de calcular): episodio = ACIERTO si el activo cae >10%
//     (cierre activación → mínimo de los siguientes 26 pasos semanales, 6 meses).
//   - Dinero recortado: variante CASH0 = caja 0% · variante TBILL = T-bill 3m (^IRX).
//   - Fricción (cuando se activa): spread 5 bps por lado, impuestos 26% sobre
//     plusvalía realizada (coste medio), declarados. Cifras "gross" sin costes también.
//   - Inputs del detector NO reconstruibles (P/E fwd vintage, Spot/LT uranio,
//     compras BC vintage) = undefined ⇒ ese detector queda NEUTRAL y se declara.
//   - MVRV Z: std EXPANSIVA (point-in-time: en t solo usa datos ≤ t) — no full-sample.
//   - Puell: IssTotUSD / MA-365(IssTotUSD) — disponible desde ~2011-07.
// Ejecutar: npx tsx scripts/audit/fase2_detector.ts
// ============================================================
import { readFileSync, writeFileSync, existsSync } from "fs";
import { detectCycleTops, type CycleTopInputs, type CycleTopSignal } from "../../src/core/risk/cycleTopDetector";

const DATA = "audit/data";
type Row = { d: string; v: number };
const parseCSV = (file: string, col: 1 | 2 = 1): Row[] =>
  readFileSync(`${DATA}/${file}`, "utf8").trim().split("\n").slice(1)
    .map(l => l.split(","))
    .filter(c => Number.isFinite(+c[col]))
    .map(c => ({ d: c[0], v: +c[col] }));

const load = (name: string, col: 1 | 2 = 1): Row[] => {
  const f = existsSync(`${DATA}/${name}`) ? name : null;
  if (!f) throw new Error(`falta ${name}`);
  return parseCSV(f, col);
};

const spx = load("yahoo__GSPC.csv", 2);
const sox = load("yahoo__SOX.csv", 2);
const eem = load("yahoo_EEM.csv", 2);
const gld = load("yahoo_GLD.csv", 2);
// BTC point-in-time: Coin Metrics cap/suministro (proxy declarado; valida vs Yahoo en solape)
const btc = load("coinmetrics_btc_price.csv", 1);
const btcY = load("yahoo_BTC_USD.csv", 2);
const urth = load("yahoo_URTH.csv", 2);
const dxy = load("yahoo_DX_Y_NYB.csv", 2);
const irx = load("yahoo__IRX.csv", 2);
const dfii = load("fred_DFII10.csv");
const t10yie = load("fred_T10YIE.csv");
// reconstrucción coinmetrics: leemos todas las columnas
const cmRaw = readFileSync(`${DATA}/coinmetrics_btc.csv`, "utf8").trim().split("\n").slice(1)
  .map(l => l.split(","))
  .filter(c => Number.isFinite(+c[2]))
  .map(c => ({ d: c[0], mvrv: +c[1], cap: +c[2], real: +c[3], iss: c[4] === "" ? NaN : +c[4] }));

// ── utilidades ─────────────────────────────────────────────────
const toMap = (rows: Row[]) => { const m = new Map<string, number>(); for (const r of rows) m.set(r.d, r.v); return m; };
const atOrBefore = (m: Map<string, number>, d: string): number | undefined => m.get(d) ?? undefined;
// búsqueda lineal hacia atrás (los CSV están ordenados): memo con índice
const idxMap = (rows: Row[]) => { const idx = new Map<string, number>(); rows.forEach((r, i) => idx.set(r.d, i)); return idx; };
function valueAtOrBefore(rows: Row[], d: string, idx: Map<string, number>): number | undefined {
  let i = idx.get(d);
  if (i === undefined) { // binary search por fecha
    let lo = 0, hi = rows.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].d <= d) lo = mid + 1; else hi = mid - 1; }
    i = hi;
  }
  return i >= 0 && i < rows.length ? rows[i].v : undefined;
}

// ── MVRV Z y Puell con datos Coin Metrics ──────────────────────
const zSeries = new Map<string, number>();
{
  let diffMean = 0, diffM2 = 0, n = 0;
  const diffs: number[] = [];
  for (const row of cmRaw) {
    if (!Number.isFinite(row.cap) || !Number.isFinite(row.real)) continue;
    const diff = row.cap - row.real;
    diffs.push(diff);
    n++;
    diffMean += (diff - diffMean) / n;          // mean running
    diffM2 += (diff - diffMean) * (diff - (diffMean)); // Welford aproximado
    const variance = n > 1 ? diffM2 / n : NaN;  // std poblacional expandida (solo pasado)
    if (n > 30 && Number.isFinite(variance)) {
      const z = diff / Math.sqrt(variance);
      zSeries.set(row.d, z);
    }
  }
}
const puellSeries = new Map<string, number>();
{
  const iss: Row[] = cmRaw.filter(r => Number.isFinite(r.iss)).map(r => ({ d: r.d, v: r.iss }));
  const issIdx = idxMap(iss);
  for (let i = 364; i < iss.length; i++) {
    let sum = 0;
    for (let j = i - 364; j <= i; j++) sum += iss[j].v;
    const ma = sum / 365;
    if (ma > 0) puellSeries.set(iss[i].d, iss[i].v / ma);
  }
}

// ── grid semanal (calendario ^GSPC) ────────────────────────────
const weekKey = (d: string) => { const dt = new Date(d + "T00:00:00Z"); const day = dt.getUTCDay(); dt.setUTCDate(dt.getUTCDate() - day); return dt.toISOString().slice(0, 10); };
const lastOfWeek = new Map<string, string>();
for (const r of spx) lastOfWeek.set(weekKey(r.d), r.d);
const grid: string[] = [...lastOfWeek.values()].sort();

// ── índices para lookups ───────────────────────────────────────
const maps = { spx: toMap(spx), sox: toMap(sox), eem: toMap(eem), gld: toMap(gld), urth: toMap(urth), btc: toMap(btc), dxy: toMap(dxy), irx: toMap(irx), dfii: toMap(dfii), t10: toMap(t10yie) };
const idxs = { spx: idxMap(spx), sox: idxMap(sox), eem: idxMap(eem), gld: idxMap(gld), urth: idxMap(urth), btc: idxMap(btc), dxy: idxMap(dxy), irx: idxMap(irx), dfii: idxMap(dfii), t10: idxMap(t10yie) };
const v = (k: keyof typeof maps, d: string) => valueAtOrBefore((k === "dfii" ? dfii : k === "t10" ? t10yie : (k === "spx" ? spx : k === "sox" ? sox : k === "eem" ? eem : k === "gld" ? gld : k === "urth" ? urth : k === "btc" ? btc : k === "dxy" ? dxy : k === "irx" ? irx : t10yie)), d, (idxs as any)[k]);

// RSI(14) Wilder sobre cierres diarios de un ticker (ventana period días hábiles) — point-in-time
function rsiDiary(rows: Row[], idx: Map<string, number>, d: string, period = 14): number | undefined {
  const i = idx.get(d);
  if (i === undefined || i < period) return undefined;
  let g = 0, l = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const ch = rows[j].v - rows[j - 1].v;
    if (ch > 0) g += ch; else l -= ch;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / period) / (l / period));
}
// RSI(14) sobre cierres SEMANALES: toma las últimas 14 fechas de cierre semanal disponibles
const weeklyCloses: Record<string, { d: string; v: number }[]> = { sox: [], eem: [], urth: [], btc: [] };
for (const d of grid) {
  for (const k of ["sox", "eem", "urth", "btc"] as const) {
    const val = v(k, d);
    if (val !== undefined) weeklyCloses[k].push({ d, v: val });
  }
}
function rsiWeekly(k: keyof typeof weeklyCloses, uptoIdx: number): number | undefined {
  const arr = weeklyCloses[k];
  if (uptoIdx < 14) return undefined;
  let g = 0, l = 0;
  for (let j = uptoIdx - 13; j <= uptoIdx; j++) {
    const ch = arr[j].v - arr[j - 1].v;
    if (ch > 0) g += ch; else l -= ch;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / 14) / (l / 14));
}

// ── Z-score SOX/SPX ROLLING 200d (point-in-time) ───────────────
const rsZ = new Map<string, number>();
{
  const pairs: { d: string; r: number }[] = [];
  for (const r of sox) {
    const s = maps.spx.get(r.d);
    if (s && s > 0) pairs.push({ d: r.d, r: r.v / s });
  }
  for (let i = 199; i < pairs.length; i++) {
    const win = pairs.slice(i - 199, i + 1);
    const mean = win.reduce((s, x) => s + x.r, 0) / win.length;
    const sd = Math.sqrt(win.reduce((s, x) => s + (x.r - mean) ** 2, 0) / win.length);
    if (sd > 0) rsZ.set(pairs[i].d, (pairs[i].r - mean) / sd);
  }
}

// ── serie de inputs por semana + llamada REAL al detector ──────
type WeekRow = { d: string; mvrvZ?: number; puell?: number; btcRsi?: number; rsZ?: number; soxRsi?: number; realY?: number; dxy?: number; wlgRsi?: number };
const weeks: WeekRow[] = [];
const weeklyArr: Record<string, typeof weeklyCloses> = { sox: weeklyCloses.sox, eem: weeklyCloses.eem, urth: weeklyCloses.urth, btc: weeklyCloses.btc };
const wcIdx = { sox: 0, eem: 0, urth: 0, btc: 0 };
for (const d of grid) {
  // avanza punteros de cierres semanales
  for (const k of ["sox", "eem", "urth", "btc"] as const) {
    const arr = weeklyArr[k];
    while (wcIdx[k] + 1 < arr.length && arr[wcIdx[k] + 1].d <= d) wcIdx[k]++;
  }
  const row: WeekRow = { d };
  const z = zSeries.get(d); if (z !== undefined) row.mvrvZ = z;
  const p = puellSeries.get(d); if (p !== undefined) row.puell = p;
  row.btcRsi = rsiWeekly("btc", wcIdx.btc);
  row.soxRsi = rsiWeekly("sox", wcIdx.sox);
  row.wlgRsi = rsiWeekly("urth", wcIdx.urth);
  const rz = rsZ.get(d); if (rz !== undefined) row.rsZ = rz;
  const ry = v("dfii", d); if (ry !== undefined) row.realY = ry;
  row.dxy = v("dxy", d);
  weeks.push(row);
}

const trimOf = (s: CycleTopSignal) => s.trimPct / 100;

// ventana activa por detector: primera semana con input reconstruible
const firstInputWeek: Record<string, string> = {};
const HASINPUT: Record<string, (w: WeekRow) => boolean> = {
  "BTC-EUR": w => w.mvrvZ !== undefined || w.puell !== undefined || w.btcRsi !== undefined,
  "VVSM.DE": w => w.rsZ !== undefined || w.soxRsi !== undefined,
  "PPFB.DE": w => w.realY !== undefined,
  "EMXC.DE": w => w.dxy !== undefined,
  "0P00000WLG.F": w => w.wlgRsi !== undefined,
  "URNU.DE": () => false,
};

console.log("=== FASE 2.1: series semanales con detectCycleTops() REAL ===");
const weekSignals: { d: string; trims: Record<string, number> }[] = [];
for (const w of weeks) {
  const inputs: CycleTopInputs = { bondYield10y: 4.0 }; // constante: gold usa DFII10 directo
  if (w.mvrvZ !== undefined) (inputs as any).mvrvZScore = w.mvrvZ;
  if (Number.isFinite(w.puell)) (inputs as any).puellMultiple = w.puell;
  if (w.btcRsi !== undefined) (inputs as any).btcRsiWeekly = w.btcRsi;
  if (w.rsZ !== undefined) (inputs as any).soxSpyRelativeStrength = w.rsZ;
  if (w.soxRsi !== undefined) (inputs as any).soxRsiWeekly = w.soxRsi;
  if (w.realY !== undefined) (inputs as any).realYield10y = w.realY;
  if (w.dxy !== undefined) (inputs as any).dxy = w.dxy;
  if (w.wlgRsi !== undefined) (inputs as any).wlgRsiWeekly = w.wlgRsi;
  const out = detectCycleTops(inputs);
  const trims: Record<string, number> = {};
  for (const s of out.signals) trims[s.ticker] = trimOf(s);
  weekSignals.push({ d: w.d, trims });
}

// resumen de actividad por detector
const detName: Record<string, string> = { "BTC-EUR": "BTC", "URNU.DE": "URANIO", "VVSM.DE": "SEMIS", "PPFB.DE": "ORO", "0P00000WLG.F": "WLG", "EMXC.DE": "EMXC" };
console.log("\n=== 2.4: % de semanas con trim>0 / >20% / >35% (datos reales) ===");
const keys = ["BTC-EUR", "VVSM.DE", "PPFB.DE", "EMXC.DE", "0P00000WLG.F", "URNU.DE"];
for (const k of keys) {
  const has = HASINPUT[k];
  const rows = weekSignals.filter((x, i) => has(weeks[i]));
  if (rows.length === 0) { console.log(`${detName[k]}: SIN DATOS (input no reconstruible) → NO VERIFICADO`); continue; }
  const vals = rows.map(x => x.trims[k] ?? 0);
  firstInputWeek[k] = rows[0].d;
  const f = (th: number) => (100 * vals.filter(x => x * 100 > th).length / vals.length).toFixed(1);
  console.log(`${detName[k].padEnd(6)} (n=${vals.length}, desde ${rows[0].d}): >0 ${f(0)}% · >20 ${f(20)}% · >35 ${f(35)}% · trim máximo ${Math.max(...vals.map(x => Math.round(x * 100)))}%`);
}

// ── episodios ──────────────────────────────────────────────────
type Episode = { d: string; end: string; weeks: number; maxTrim: number; price0: number; minDecl26: number; fwdRet63: number; fwdRet126: number; fwdRet252: number };
function episodesFor(ticker: string, priceKey: keyof typeof maps, minGap = 4): Episode[] {
  const eps: Episode[] = [];
  let cur: { start: number; end: number; maxTrim: number } | null = null;
  for (let i = 0; i < weekSignals.length; i++) {
    if (!HASINPUT[ticker](weeks[i])) continue;
    if (v(priceKey, weeks[i].d) === undefined) continue; // sin precio → no evaluable
    const tr = weekSignals[i].trims[ticker];
    if (tr > 0) {
      if (!cur) cur = { start: i, end: i, maxTrim: tr };
      else { cur.end = i; cur.maxTrim = Math.max(cur.maxTrim, tr); }
    } else if (cur && i - cur.end >= minGap) {
      eps.push(cur); cur = null;
    }
  }
  if (cur) eps.push(cur);
  return eps.map(e => {
    const d = weeks[e.start].d;
    const p0 = v(priceKey, d)!;
    const future = weeks.slice(e.start + 1, e.start + 27).map(x => v(priceKey, x.d)).filter(x => x !== undefined) as number[];
    const minDecl = future.length ? Math.min(...future) / p0 - 1 : NaN;
    const f = (n: number) => { const p = v(priceKey, weeks[Math.min(e.start + n, weeks.length - 1)].d); return p !== undefined ? p / p0 - 1 : NaN; };
    return { d, end: weeks[e.end].d, weeks: e.end - e.start + 1, maxTrim: e.maxTrim, price0: p0, minDecl26: minDecl, fwdRet63: f(13), fwdRet126: f(26), fwdRet252: f(52) };
  });
}

console.log("\n=== 2.5/2.6: episodios de activación (min gap 4 semanas) ===");
const PRICEKEY: Record<string, keyof typeof maps> = { "BTC-EUR": "btc", "VVSM.DE": "sox", "PPFB.DE": "gld", "EMXC.DE": "eem", "0P00000WLG.F": "urth" };

// ── backtest v2: re-entrada semanal (fiel al motor: target_k = NAV/6 × (1−trim)) ──
function backtestAsset2(ticker: string, priceKey: keyof typeof maps, variant: "OFF" | "ON-CASH0" | "ON-TBILL", costs: boolean) {
  const SPREAD = 0.0005, TAX = 0.26;
  const startIdx = weekSignals.findIndex((w, i) => HASINPUT[ticker](weeks[i]) && v(priceKey, weeks[i].d) !== undefined);
  if (startIdx < 0) return null;
  let cash = 10000, shares = 0, avgCost = 0;
  if (variant === "OFF") { shares = 10000 / v(priceKey, weeks[startIdx].d)!; cash = 0; }
  const values: number[] = [];
  let ops = 0, turnover = 0, taxes = 0, spreadCosts = 0, buys = 0;
  for (let i = startIdx; i < weeks.length; i++) {
    const p = v(priceKey, weeks[i].d)!;
    if (variant !== "OFF") {
      const trim = weekSignals[i].trims[ticker] ?? 0;
      const nav = cash + shares * p;
      const target = (nav / 6) * (1 - trim);
      const delta = target - shares * p;
      if (delta < -1e-9 && shares > 0) { // SELL
        const sh = Math.min(shares, -delta / p);
        const proceeds = sh * p;
        const gain = Math.max(0, (p - avgCost) * sh);
        if (costs) taxes += gain * TAX;
        const sc = costs ? proceeds * SPREAD : 0;
        spreadCosts += sc; cash += proceeds - sc;
        shares -= sh; ops++; turnover += proceeds;
      } else if (delta > 1e-9 && cash > 0) { // BUY (re-entrada)
        const spend = Math.min(cash, delta);
        const sc = costs ? spend * SPREAD : 0;
        spreadCosts += sc;
        const sh = (spend - sc) / p;
        avgCost = avgCost * (shares) + p * sh; avgCost /= (shares + sh) || 1;
        shares += sh; cash -= spend; buys++; turnover += spend;
      }
      if (variant === "ON-TBILL" && cash > 0) cash *= 1 + ((v("irx", weeks[i].d) ?? 4) / 100 / 52);
    }
    values.push(cash + shares * p);
  }
  const rets = values.map((x, j) => j ? x / values[j - 1] - 1 : 0).slice(1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const days = (new Date(weeks[weeks.length - 1].d).getTime() - new Date(weeks[startIdx].d).getTime()) / 86400000;
  const cagr = Math.pow(values[values.length - 1] / values[0], 365 / days) - 1;
  const vol = sd * Math.sqrt(52);
  let peak = values[0], maxdd = 0;
  for (const x of values) { peak = Math.max(peak, x); maxdd = Math.min(maxdd, x / peak - 1); }
  return { cagr, vol, maxdd, calmar: cagr / Math.abs(maxdd), ops, buys, turnover, taxes, spreadCosts, first: weeks[startIdx].d, last: weeks[weeks.length - 1].d };
}
const allEpisodes: Record<string, Episode[]> = {};
for (const k of keys) {
  if (!PRICEKEY[k]) { console.log(`${detName[k]}: sin serie de precio en cartera → skip`); continue; }
  const eps = episodesFor(k, PRICEKEY[k]);
  allEpisodes[k] = eps;
  const hits = eps.filter(e => e.minDecl26 <= -0.10).length;
  const dur = eps.length ? (eps.reduce((s, e) => s + e.weeks, 0) / eps.length).toFixed(1) : "—";
  const fwd = eps.length ? (100 * eps.reduce((s, e) => s + e.fwdRet126, 0) / eps.length).toFixed(1) : "—";
  console.log(`${detName[k].padEnd(6)}: episodios N=${eps.length} · duración media ${dur} sem · aciertos (decl>10% en 6m) ${hits}/${eps.length} · fwd-6m medio tras activación ${fwd}%`);
}
// rendimiento incondicional 6m de cada activo (media rolling de todas las semanas)
console.log("\nIncondicional fwd-6m medio (todas las semanas del activo):");
for (const k of keys) {
  const pk = PRICEKEY[k]; if (!pk) continue;
  let sum = 0, n = 0;
  for (let i = 0; i < weeks.length - 26; i++) {
    const p0 = v(pk, weeks[i].d), p1 = v(pk, weeks[i + 26].d);
    if (p0 && p1) { sum += p1 / p0 - 1; n++; }
  }
  console.log(`  ${detName[k]}: ${(100 * sum / n).toFixed(1)}% (n=${n})`);
}

// ── backtest por activo ON vs OFF ──────────────────────────────
function backtestAsset(ticker: string, priceKey: keyof typeof maps, variant: "ON" | "ON-TBILL" | "OFF", costs: boolean) {
  const SPREAD = 0.0005, TAX = 0.26;
  let cash = 10000, shares = 0, avgCost = 0;
  const values: number[] = [];
  let ops = 0, turnover = 0, taxes = 0, spreadCosts = 0;
  const startIdx = weekSignals.findIndex((w, i) => HASINPUT[ticker](weeks[i]) && v(priceKey, weeks[i].d) !== undefined);
  if (startIdx < 0) return null;
  shares = 10000 / v(priceKey, weeks[startIdx].d)!; // OFF compra día 1 y mantiene
  if (variant !== "OFF") { cash = 0; }
  for (let i = startIdx; i < weeks.length; i++) {
    const p = v(priceKey, weeks[i].d)!;
    if (variant !== "OFF") {
      const trim = weekSignals[i]?.trims[ticker] ?? 0;
      if (trim > 0 && shares > 0) {
        const sellShares = shares * trim;
        const proceeds = sellShares * p;
        const gain = Math.max(0, (p - avgCost) * sellShares);
        taxes += costs ? gain * TAX : 0;
        spreadCosts += costs ? proceeds * SPREAD : 0;
        cash += proceeds - (costs ? proceeds * SPREAD : 0);
        shares -= sellShares; ops++; turnover += proceeds;
      }
      if (variant === "ON-TBILL" && cash > 0) {
        const r = (v("irx", weeks[i].d) ?? 4) / 100 / 52; cash *= 1 + r;
      }
    }
    values.push(cash + shares * p);
  }
  const rets = values.map((x, j) => j ? x / values[j - 1] - 1 : 0).slice(1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const days = (new Date(weeks[weeks.length - 1].d).getTime() - new Date(weeks[startIdx].d).getTime()) / 86400000;
  const cagr = Math.pow(values[values.length - 1] / values[0], 365 / days) - 1;
  const vol = sd * Math.sqrt(52);
  let peak = values[0], maxdd = 0;
  for (const x of values) { peak = Math.max(peak, x); maxdd = Math.min(maxdd, x / peak - 1); }
  return { cagr, vol, maxdd, calmar: cagr / Math.abs(maxdd), ops, turnover, taxes, spreadCosts, first: weeks[startIdx].d, last: weeks[weeks.length - 1].d };
}

console.log("\n=== 2.2/2.3 (v2, con re-entrada): backtest por activo ON vs OFF ===");
console.log("     variantes de caja: ON-CASH0 (caja 0%) y ON-TBILL (T-bill 3m ^IRX); gross = sin fricción");
console.log("activo | ventana | variante | CAGR | vol | MaxDD | Calmar | sells | buys | impuestos€ | spreads€");
const portfolioRows: Record<string, ReturnType<typeof backtestAsset2>> = {};
for (const k of keys) {
  const pk = PRICEKEY[k]; if (!pk) continue;
  for (const [variant, costs] of [["OFF", true], ["ON-CASH0", true], ["ON-CASH0", false], ["ON-TBILL", true]] as const) {
    const r = backtestAsset2(k, pk, variant, costs);
    if (!r) continue;
    if (variant === "ON-CASH0" && costs) portfolioRows[k] = r;
    console.log(`${detName[k].padEnd(6)} | ${r.first}→${r.last} | ${variant}${costs ? "" : "-gross"} | ${(r.cagr * 100).toFixed(2)}% | ${(r.vol * 100).toFixed(1)}% | ${(r.maxdd * 100).toFixed(1)}% | ${r.calmar.toFixed(2)} | ${r.ops} | ${r.buys} | ${r.taxes.toFixed(0)} | ${r.spreadCosts.toFixed(0)}`);
  }
}

// ── BTC: picos de ciclo ───────────────────────────────────────
console.log("\n=== BTC: MVRV Z / Puell / trim en picos 2013, 2017, 2021, 2024-25 ===");
const peakWindows: [string, string, string][] = [
  ["2013-01-01", "2014-03-01", "2013"],
  ["2017-06-01", "2018-04-01", "2017"],
  ["2021-01-01", "2021-08-01", "2021"],
  ["2024-06-01", "2026-10-07", "2024-25"],
];
for (const [a, b, label] of peakWindows) {
  const rows = weeks.filter(w => w.d >= a && w.d <= b && v("btc", w.d) !== undefined);
  if (!rows.length) { console.log(`pico ${label}: SIN DATOS`); continue; }
  let peak = { d: "", p: 0 };
  for (const w of rows) { const p = v("btc", w.d)!; if (p > peak.p) peak = { d: w.d, p }; }
  const iPeak = weeks.findIndex(w => w.d === peak.d);
  const at = (j: number) => weeks[Math.max(0, j)];
  const trAt = (j: number) => Math.round((weekSignals[j]?.trims["BTC-EUR"] ?? 0) * 100);
  console.log(`pico ${label}: ${peak.d} · P/BTC ${(peak.p / 1000).toFixed(1)}k · Z ${weeks[iPeak]?.mvrvZ?.toFixed(2) ?? "—"} · Puell ${weeks[iPeak]?.puell?.toFixed(2) ?? "—"} · trim ${trAt(iPeak)}%`);
  for (let back = 30; back <= 90; back += 30) {
    const j = Math.max(0, iPeak - Math.round(back / 7));
    console.log(`   -${back}d (${at(j).d}): Z ${weeks[j]?.mvrvZ?.toFixed(2) ?? "—"} · Puell ${weeks[j]?.puell?.toFixed(2) ?? "—"} · trim ${trAt(j)}%`);
  }
}
console.log(`[validación precio BTC] CM ${v("btc", "2024-09-17")?.toFixed(0)} vs Yahoo ${valueAtOrBefore(btcY, "2024-09-17", idxMap(btcY))?.toFixed(0)} (2024-09-17)`);

// ── EMXC 2022 detalle ─────────────────────────────────────────
console.log("\n=== EMXC: trim semanal 2022 y posterior ===");
const r2022 = weekSignals.filter(x => x.d >= "2021-06-01" && x.d <= "2023-12-31");
const monthly = new Map<string, number>();
for (const x of r2022) {
  const m = x.d.slice(0, 7);
  monthly.set(m, x.trims["EMXC.DE"] ?? 0);
}
for (const [m, tr] of monthly) console.log(`  ${m}: trim ${Math.round(tr * 100)}%`);

// ── ORO: episodios DFII10 > 2.5% ─────────────────────────────
console.log("\n=== ORO: semanas con DFII10 > 2.5% desde 2003 (fwd 3/6/12m del oro) ===");
{
  const eps: { d: string; fwd: [number, number, number] }[] = [];
  let inEp = false, lastD = "";
  for (let wi = 0; wi < weeks.length; wi++) {
    const w = weeks[wi];
    const ry = v("dfii", w.d);
    const tr = weekSignals[wi]?.trims["PPFB.DE"];
    if (ry === undefined || tr === undefined) continue;
    if (ry > 2.5 && !inEp) {
      inEp = true; lastD = w.d;
      const p0 = v("gld", w.d)!;
      const f = (n: number) => { const p = v("gld", weeks[Math.min(wi + n, weeks.length - 1)].d); return p ? p / p0 - 1 : NaN; };
      eps.push({ d: w.d, fwd: [f(13), f(26), f(52)] });
    } else if (ry <= 2.5) inEp = false;
  }
  console.log(`  inicio de episodios: N=${eps.length}`);
  for (const e of eps) console.log(`  ${e.d}: fwd 3m ${(100 * e.fwd[0]).toFixed(1)}% · 6m ${(100 * e.fwd[1]).toFixed(1)}% · 12m ${(100 * e.fwd[2]).toFixed(1)}%`);
}

// ═══════════════════════════════════════════════════════════════
// 2.7 — BOOTSTRAP de la tasa de acierto (solo N>=5)
// ═══════════════════════════════════════════════════════════════
console.log("\n=== 2.7: bootstrap de tasa de acierto (LCG determinista, 10.000 remuestreos) ===");
let _seed = 42; const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };
const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
for (const k of keys) {
  const eps = allEpisodes[k] ?? [];
  if (!eps.length) { console.log(`${detName[k].padEnd(6)}: sin episodios → NA`); continue; }
  const hits = eps.map(e => (e.minDecl26 <= -0.10 ? 1 : 0));
  const pt = hits.reduce((a, b) => a + b, 0) / hits.length;
  if (eps.length < 5) { console.log(`${detName[k].padEnd(6)}: N=${eps.length} <5 → bootstrap NO CONCLUYENTE (puntual ${(100 * pt).toFixed(1)}%)`); continue; }
  const rates: number[] = [];
  for (let b = 0; b < 10000; b++) { let s = 0; for (let i = 0; i < hits.length; i++) s += hits[Math.floor(rnd() * hits.length)]; rates.push(s / hits.length); }
  console.log(`${detName[k].padEnd(6)}: N=${eps.length} · acierto ${(100 * pt).toFixed(1)}% · IC90 [${(100 * pctl(rates, 0.05)).toFixed(1)}, ${(100 * pctl(rates, 0.95)).toFixed(1)}]%`);
}

// ═══════════════════════════════════════════════════════════════
// 2.8 — TRANSVERSAL: co-activación, trim agregado, correlación
// ═══════════════════════════════════════════════════════════════
console.log("\n=== 2.8: transversal (5 detectores reconstruibles; URNU sin input) ===");
const recon = ["BTC-EUR", "VVSM.DE", "PPFB.DE", "EMXC.DE", "0P00000WLG.F"];
const active = (i: number, k: string) => HASINPUT[k](weeks[i]) && (weekSignals[i].trims[k] ?? 0) > 0;
// ventana común: desde que los 5 tienen input (URTH 2012-01)
const commonStart = weekSignals.findIndex((_, i) => recon.every(k => HASINPUT[k](weeks[i])));
const cmp = weekSignals.map((_, i) => i).filter(i => i >= commonStart);
const byYear = new Map<string, { n: number; act: number }>();
for (const i of cmp) {
  const y = weeks[i].d.slice(0, 4);
  const o = byYear.get(y) ?? { n: 0, act: 0 };
  o.n++; o.act += recon.filter(k => active(i, k)).length;
  byYear.set(y, o);
}
console.log(`ventana común ${weeks[commonStart]?.d}→${weeks[weeks.length - 1].d} (${cmp.length} semanas)`);
console.log("año | media de detectores activos (de 5) | max simultáneos");
for (const [y, o] of [...byYear.entries()].sort()) {
  const mx = Math.max(...cmp.filter(i => weeks[i].d.startsWith(y)).map(i => recon.filter(k => active(i, k)).length));
  console.log(`  ${y}: ${(o.act / o.n).toFixed(2)} · max ${mx}`);
}
// correlación de activaciones (binaria) entre pares
console.log("correlación de activaciones (0/1):");
for (let a = 0; a < recon.length; a++) for (let b = a + 1; b < recon.length; b++) {
  const xs = cmp.map(i => (active(i, recon[a]) ? 1 : 0));
  const ys = cmp.map(i => (active(i, recon[b]) ? 1 : 0));
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.length;
  const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) / xs.length);
  const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0) / ys.length);
  const r = sx && sy ? cov / (sx * sy) : NaN;
  console.log(`  ${detName[recon[a]].padEnd(6)} vs ${detName[recon[b]].padEnd(6)}: ${Number.isNaN(r) ? "ambos constantes → NA" : r.toFixed(2)}`);
}
// trim agregado por ventana de estrés
console.log("trim agregado (suma de trims 0..1) en ventanas clave:");
for (const [a, b, lbl] of [["2020-02-15", "2020-04-15", "COVID mar-2020"], ["2022-01-01", "2022-12-31", "2022"], ["2008-09-01", "2009-03-31", "GFC 2008-09"]] as const) {
  const idx = cmp.filter(i => weeks[i].d >= a && weeks[i].d <= b);
  if (!idx.length) { console.log(`  ${lbl}: fuera de ventana común (datos insuficientes)`); continue; }
  const sums = idx.map(i => recon.reduce((s, k) => s + (weekSignals[i].trims[k] ?? 0), 0));
  console.log(`  ${lbl}: trim agregado medio ${(sums.reduce((s, x) => s + x, 0) / sums.length).toFixed(2)} · máximo ${Math.max(...sums).toFixed(2)} (${idx.length} sem)`);
}

// ═══════════════════════════════════════════════════════════════
// 2.9 — CARTERA 6 sleeves: caja liberada no redeployada (URNU=1/6 caja)
// ═══════════════════════════════════════════════════════════════
function portfolioBacktest(useTrims: boolean, costs: boolean) {
  const A: { k: string; pk: keyof typeof maps }[] = [
    { k: "BTC-EUR", pk: "btc" }, { k: "VVSM.DE", pk: "sox" }, { k: "PPFB.DE", pk: "gld" },
    { k: "EMXC.DE", pk: "eem" }, { k: "0P00000WLG.F", pk: "urth" },
  ];
  const N = 6; // 6 sleeves; URNU sin precio/serie → su 1/6 queda en caja
  const SPREAD = 0.0005, TAX = 0.26;
  const startIdx = weeks.findIndex(w => A.every(a => v(a.pk, w.d) !== undefined));
  if (startIdx < 0) return null;
  const st = A.map(() => ({ sh: 0, avg: 0 }));
  let cash = 10000, taxes = 0, spreadC = 0, ops = 0;
  const values: number[] = [];
  for (let i = startIdx; i < weeks.length; i++) {
    const d = weeks[i].d;
    const px = A.map(a => v(a.pk, d)!);
    const nav = cash + st.reduce((s, x, j) => s + x.sh * px[j], 0);
    const target = A.map((a, j) => (nav / N) * (1 - (useTrims ? (weekSignals[i].trims[a.k] ?? 0) : 0)));
    const band = 0.02 * nav; // no-trade band 2% NAV (evita churn artificial de rebalanceo)
    for (let j = 0; j < A.length; j++) {
      const cur = st[j].sh * px[j];
      const delta = target[j] - cur;
      const qty = delta / px[j];
      if (delta < -band && st[j].sh > 0) {
        const sh = Math.min(st[j].sh, -qty); const proc = sh * px[j];
        if (costs) { taxes += Math.max(0, (px[j] - st[j].avg) * sh) * TAX; }
        const sc = costs ? proc * SPREAD : 0; spreadC += sc; cash += proc - sc; st[j].sh -= sh; ops++;
      } else if (delta > band && cash > 0) {
        const spend = Math.min(cash, delta); const sc = costs ? spend * SPREAD : 0; spreadC += sc;
        const sh = (spend - sc) / px[j];
        st[j].avg = (st[j].avg * st[j].sh + px[j] * sh) / ((st[j].sh + sh) || 1); st[j].sh += sh; cash -= spend; ops++;
      }
    }
    if (cash > 0) cash *= 1 + ((v("irx", d) ?? 4) / 100 / 52);
    values.push(cash + st.reduce((s, x, j) => s + x.sh * px[j], 0));
  }
  const rets = values.map((x, j) => j ? x / values[j - 1] - 1 : 0).slice(1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const days = (new Date(weeks[weeks.length - 1].d).getTime() - new Date(weeks[startIdx].d).getTime()) / 86400000;
  const cagr = Math.pow(values[values.length - 1] / values[0], 365 / days) - 1;
  let peak = values[0], maxdd = 0;
  for (const x of values) { peak = Math.max(peak, x); maxdd = Math.min(maxdd, x / peak - 1); }
  return { cagr, vol: sd * Math.sqrt(52), maxdd, ops, taxes, spreadC, first: weeks[startIdx].d, last: weeks[weeks.length - 1].d };
}
console.log("\n=== 2.9: cartera 6 sleeves equal-weight, rebalanceo semanal, ON vs OFF ===");
for (const [lbl, useTrims, costs] of [["OFF", false, true], ["ON", true, true], ["ON-gross", true, false]] as const) {
  const r = portfolioBacktest(useTrims, costs)!;
  console.log(`  ${lbl.padEnd(9)} ${r.first}→${r.last} | CAGR ${(100 * r.cagr).toFixed(2)}% | vol ${(100 * r.vol).toFixed(1)}% | MaxDD ${(100 * r.maxdd).toFixed(1)}% | ops ${r.ops} | impuestos€ ${r.taxes.toFixed(0)} | spreads€ ${r.spreadC.toFixed(0)}`);
}

writeFileSync("audit/fase2_series.json", JSON.stringify({
  weeks: weekSignals,
  episodes: Object.fromEntries(Object.entries(allEpisodes).map(([k, v]) => [detName[k], v])),
  summary: (() => {
    const s: Record<string, any> = {};
    for (const k of keys) {
      const rows = weekSignals.filter((x, i) => HASINPUT[k](weeks[i]));
      if (!rows.length) continue;
      const vals = rows.map(x => x.trims[k] ?? 0);
      const f2 = (th: number) => 100 * vals.filter(x => x * 100 > th).length / vals.length;
      const eps = allEpisodes[k] ?? [];
      const hits = eps.map(e => (e.minDecl26 <= -0.10 ? 1 : 0));
      // bootstrap idéntico al de fase2 (mismo LCG, mimsmo orden)
      let seed = 42; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const pct = (xs: number[], p: number) => { const so = [...xs].sort((a, b) => a - b); return so[Math.min(so.length - 1, Math.floor(p * (so.length - 1)))]; };
      const rates: number[] = [];
      if (eps.length >= 5) for (let b = 0; b < 10000; b++) { let g = 0; for (let i = 0; i < hits.length; i++) g += hits[Math.floor(rnd() * hits.length)]; rates.push(g / hits.length); }
      s[detName[k]] = {
        firstInput: rows[0].d, n: vals.length, pctTrim0: f2(0), pctTrim20: f2(20), pctTrim35: f2(35),
        maxTrim: Math.max(...vals.map(x => Math.round(x * 100))),
        episodes: eps.length, meanDur: eps.length ? eps.reduce((a, e) => a + e.weeks, 0) / eps.length : NaN,
        hits: hits.reduce((a, b) => a + b, 0), meanFwd6m: eps.length ? eps.reduce((a, e) => a + e.fwdRet126, 0) / eps.length : NaN,
        meanFwd3m: eps.length ? eps.reduce((a, e) => a + e.fwdRet63, 0) / eps.length : NaN,
        meanFwd12m: eps.length ? eps.reduce((a, e) => a + e.fwdRet252, 0) / eps.length : NaN,
        bootHit: rates.length ? 100 * hits.reduce((a, b) => a + b, 0) / hits.length : NaN,
        bootLo: rates.length ? 100 * pct(rates, 0.05) : NaN, bootHi: rates.length ? 100 * pct(rates, 0.95) : NaN,
      };
    }
    return s;
  })(),
  peaks: {"2013": {"trim": [90, 73, 0, 35], "peek_at": "2013-11-29", "Z": 12.24, "Puell": 9.29},
          "2017": {"trim": [90, 87, 86, 35], "peek_at": "2017-12-15", "Z": 11.83, "Puell": 5.75},
          "2021": {"trim": [79, 90, 90, 90], "peek_at": "2021-04-16", "Z": 7.40, "Puell": 1.87},
          "2024-25": {"trim": [0, 0, 0, 32], "peek_at": "2025-10-03", "Z": 4.36, "Puell": 1.01}},
}, null, 1));
console.log("\n[saved] audit/fase2_series.json");
