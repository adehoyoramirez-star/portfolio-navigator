// ============================================================
// scripts/validation/data_long.ts
// FASE 2B · TEST 1a — Dataset largo con proxies REALES.
//   · Fuentes: Yahoo chart API (precios ajustados) — RED DISPONIBLE.
//   · Sin rellenado hacia atrás: cada serie empieza en su 1ª barra real.
//   · Validación (gate): saltos >25% diarios listados; huecos >5 días listados.
//   · Cache: scripts/validation/data_long_cache.json (para re-ejecutar sin red).
// Ejecutar: npx tsx scripts/validation/data_long.ts
// ============================================================

import fs from 'fs';
import path from 'path';

const P = { period1: 978307200 }; // 2001-01-01

const EQUITY_PROXIES: { asset: string; yahoo: string; why: string }[] = [
  { asset: 'BTC-EUR',        yahoo: 'BTC-USD',  why: 'BTC-USD real; EUR vía EURUSD=X real (BTC-EUR directo en Yahoo tiene menos historia)' },
  { asset: 'EMXC.DE',        yahoo: 'EMXC',     why: 'iShares MSCI EM ex-China (mismo índice que EMXC.DE)' },
  { asset: 'PPFB.DE',        yahoo: 'GLD',      why: 'oro físico (SPDR Gold Shares)' },
  { asset: 'URNU.DE',        yahoo: 'URA',      why: 'mismo sector: mineras de uranio (Global X Uranium)' },
  { asset: 'VVSM.DE',        yahoo: 'SOXX',     why: 'semiconductores US (iShares Semiconductor)' },
  { asset: '0P00000WLG.F',   yahoo: 'URTH',     why: 'MSCI World (iShares MSCI World)' },
];
const MACRO_PROXIES: { key: string; yahoo: string; why: string }[] = [
  { key: 'vix',  yahoo: '^VIX',     why: 'VIX real' },
  { key: 'tnx',  yahoo: '^TNX',     why: 'yield 10Y real' },
  { key: 'irx',  yahoo: '^IRX',     why: 'T-Bill 3M real' },
  { key: 'hyg',  yahoo: 'HYG',      why: 'high yield real' },
  { key: 'lqd',  yahoo: 'LQD',      why: 'investment grade real' },
  { key: 'move', yahoo: '^MOVE',    why: 'MOVE real (vol. bonos)' },
  { key: 'dxy',  yahoo: 'DX-Y.NYB', why: 'DXY real' },
];
const FX_TICKER = 'EURUSD=X';

interface Chart { map: Map<string, number>; first: string | null; n: number; }

async function fetchChart(ticker: string): Promise<Chart> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${P.period1}&period2=9999999999&interval=1d&events=div%2Csplit`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (validation script)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      const r = j?.chart?.result?.[0];
      if (!r) throw new Error('sin result');
      const ts: number[] = r.timestamp ?? [];
      const adj = r.indicators?.adjclose?.[0]?.adjclose ?? r.indicators?.quote?.[0]?.close ?? [];
      const map = new Map<string, number>();
      for (let i = 0; i < ts.length; i++) {
        const px = adj[i];
        if (px == null || !isFinite(px) || px <= 0) continue;
        const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
        map.set(d, px);
      }
      const first = ts.length ? new Date(ts[0] * 1000).toISOString().slice(0, 10) : null;
      return { map, first, n: map.size };
    } catch (e: any) {
      if (attempt === 2) throw new Error(`${ticker}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw new Error('unreachable');
}

export interface LongDataset {
  dates: string[];
  closes: Record<string, number[]>;
  macro: { vix: number[]; tnx: number[]; irx: number[]; hyg: number[]; lqd: number[]; move: number[]; dxy: number[]; btcVol: number[] };
  meta: Record<string, any>;
}

const cachePath = () => path.join(process.cwd(), 'scripts/validation/data_long_cache.json');

export async function loadLongDataset(): Promise<LongDataset> {
  if (fs.existsSync(cachePath())) {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8')).data as LongDataset;
  }
  const built = await buildDataset();
  fs.writeFileSync(cachePath(), JSON.stringify({ builtAt: new Date().toISOString(), data: built }, null, 1));
  return built;
}

async function buildDataset(): Promise<LongDataset> {
  const charts: Record<string, Chart> = {};
  const meta: Record<string, any> = { proxies: {}, macro: {} };
  for (const p of EQUITY_PROXIES) { charts[p.yahoo] = await fetchChart(p.yahoo); meta.proxies[p.asset] = { yahoo: p.yahoo, first: charts[p.yahoo].first, n: charts[p.yahoo].n, why: p.why }; }
  for (const m of MACRO_PROXIES) { charts[m.yahoo] = await fetchChart(m.yahoo); meta.macro[m.key] = { yahoo: m.yahoo, first: charts[m.yahoo].first, n: charts[m.yahoo].n, why: m.why }; }
  charts[FX_TICKER] = await fetchChart(FX_TICKER);
  meta.fx = { yahoo: FX_TICKER, first: charts[FX_TICKER].first, n: charts[FX_TICKER].n };

  // calendario = días con datos del proxy World (URTH) — calendario US común
  const cal = [...charts['URTH'].map.keys()].sort();
  const get = (c: Chart, d: string, maxBack = 5): number | null => {
    if (c.map.has(d)) return c.map.get(d)!;
    let k = new Date(d + 'T00:00:00Z').getTime();
    for (let i = 1; i <= maxBack; i++) {
      const prev = new Date(k - i * 86400000).toISOString().slice(0, 10);
      if (c.map.has(prev)) return c.map.get(prev)!;
    }
    return null;
  };

  // primera fecha real conjunta (sin backfill): max de primeras fechas de los 6 proxies
  const firstDates = EQUITY_PROXIES.map(p => charts[p.yahoo].first!).sort();
  const start = firstDates[firstDates.length - 1];

  const dates: string[] = [];
  const closes: Record<string, number[]> = {}; EQUITY_PROXIES.forEach(p => closes[p.asset] = []);
  const raw: Record<string, number[]> = { vix: [], tnx: [], irx: [], hyg: [], lqd: [], move: [], dxy: [], btc: [] };
  let missingEquity = 0;
  for (const d of cal) {
    if (d < start) continue;
    const eur = get(charts[FX_TICKER], d, 5);
    const row: Record<string, number | null> = {};
    for (const p of EQUITY_PROXIES) {
      const px = get(charts[p.yahoo], d, 5);
      row[p.yahoo] = px;
      if (px == null && p.yahoo !== 'BTC-USD') missingEquity++;
    }
    if (row['URTH'] == null || row['EMXC'] == null || row['GLD'] == null || row['URA'] == null || row['SOXX'] == null || eur == null) continue;
    dates.push(d);
    closes['BTC-EUR'].push((row['BTC-USD'] ?? NaN) / eur);
    closes['EMXC.DE'].push(row['EMXC']! / eur);
    closes['PPFB.DE'].push(row['GLD']! / eur);
    closes['URNU.DE'].push(row['URA']! / eur);
    closes['VVSM.DE'].push(row['SOXX']! / eur);
    closes['0P00000WLG.F'].push(row['URTH']! / eur);
    raw.vix.push(get(charts['^VIX'], d, 5) ?? NaN);
    raw.tnx.push(get(charts['^TNX'], d, 5) ?? NaN);
    raw.irx.push(get(charts['^IRX'], d, 5) ?? NaN);
    raw.hyg.push(get(charts['HYG'], d, 5) ?? NaN);
    raw.lqd.push(get(charts['LQD'], d, 5) ?? NaN);
    raw.move.push(get(charts['^MOVE'], d, 5) ?? NaN);
    raw.dxy.push(get(charts['DX-Y.NYB'], d, 5) ?? NaN);
    raw.btc.push(row['BTC-USD'] ?? NaN);
  }
  if (missingEquity > 0) meta.missingEquityBars = missingEquity;
  meta.start = dates[0]; meta.end = dates[dates.length - 1]; meta.rows = dates.length;

  // BTC_VOL proxy = vol realizada 60d anualizada (decimal); validada contra CSV en el solape
  const btcVol: number[] = dates.map((_, i) => {
    if (i < 61) return 0.5;
    const rs: number[] = [];
    for (let k = i - 60; k <= i; k++) { const a = raw.btc[k - 1], b = raw.btc[k]; if (a > 0 && b > 0) rs.push(b / a - 1); }
    const mu = rs.reduce((s, r) => s + r, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((s, r) => s + (r - mu) ** 2, 0) / rs.length);
    return Math.min(1.5, Math.max(0.15, sd * Math.sqrt(365)));
  });

  // LOCF declarado para huecos de macro (≤ pocos días; p.ej. 4 barras de ^IRX). No es backfill:
  // solo rellena NaN puntuales con el último valor real anterior.
  const locf: Record<string, number> = {};
  for (const k of Object.keys(raw)) {
    for (let i = 0; i < raw[k].length; i++) {
      if (!isFinite(raw[k][i])) { raw[k][i] = i > 0 ? raw[k][i - 1] : (raw[k][i + 1] ?? 0); locf[k] = (locf[k] ?? 0) + 1; }
    }
  }
  meta.macroLocf = locf;

  const nans: [string, string][] = [];
  dates.forEach((d, i) => {
    for (const a of Object.keys(closes)) if (!isFinite(closes[a][i])) nans.push([d, a]);
    for (const k of Object.keys(raw)) if (!isFinite(raw[k][i])) nans.push([d, k]);
  });
  if (nans.length) meta.nanBars = nans.slice(0, 10);

  return { dates, closes, macro: { vix: raw.vix, tnx: raw.tnx, irx: raw.irx, hyg: raw.hyg, lqd: raw.lqd, move: raw.move, dxy: raw.dxy, btcVol }, meta };
}

// ── Validación (gate del TEST 1) ───────────────────────────────────────────
export function validate(ds: LongDataset): { valid: boolean; issues: string[]; report: string[] } {
  const out: string[] = []; const issues: string[] = [];
  for (const a of Object.keys(ds.closes)) {
    const c = ds.closes[a]; const bad: { d: string; r: number }[] = [];
    for (let i = 1; i < c.length; i++) { const r = c[i] / c[i - 1] - 1; if (isFinite(r) && Math.abs(r) > 0.25) bad.push({ d: ds.dates[i], r }); }
    const worst = bad.length ? bad.reduce((m, x) => (Math.abs(x.r) > Math.abs(m.r) ? x : m)) : null;
    out.push(`  ${a.padEnd(14)} primera real ${metaFirst(ds, a)} · saltos>25%: ${bad.length}${worst ? ` (peor ${worst.d} ${(worst.r * 100).toFixed(1)}%)` : ''}`);
    if (bad.length && !a.includes('BTC')) issues.push(`${a}: ${bad.length} saltos de equity >25%`);
  }
  for (let i = 1; i < ds.dates.length; i++) {
    const g = Math.round((new Date(ds.dates[i]).getTime() - new Date(ds.dates[i - 1]).getTime()) / 86400000);
    if (g > 5) issues.push(`hueco ${ds.dates[i - 1]} → ${ds.dates[i]} (${g} días)`);
  }
  const mk = (k: string) => ds.macro[k as keyof typeof ds.macro];
  for (const k of ['vix', 'tnx', 'irx', 'hyg', 'lqd', 'move', 'dxy']) {
    const arr = mk(k); const nBad = arr.filter(v => !isFinite(v)).length;
    out.push(`  macro ${k.padEnd(6)} primera real ${metaFirst(ds, k)} · NaN: ${nBad} · LOCF: ${ds.meta.macroLocf?.[k] ?? 0}`);
    if (nBad > 0) issues.push(`macro ${k}: ${nBad} NaN`);
  }
  // Validación declarada: BTC_VOL proxy vs columna del CSV aumentado (solape)
  try {
    const lines2 = fs.readFileSync(path.join(process.cwd(), 'historical_data_daily_augmented.csv'), 'utf8').split('\n').filter(l => l.trim());
    const H2 = lines2[0].split(','); const kVol = H2.indexOf('BTC_VOL');
    const csvVol = new Map<string, number>();
    for (let i = 1; i < lines2.length; i++) { const p = lines2[i].split(','); if (p.length < H2.length || kVol === -1) continue; const v = parseFloat(p[kVol]); if (isFinite(v)) csvVol.set(p[0], v); }
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < ds.dates.length; i++) { const v = csvVol.get(ds.dates[i]); if (v !== undefined && isFinite(ds.macro.btcVol[i])) { xs.push(v); ys.push(ds.macro.btcVol[i]); } }
    if (xs.length > 30) {
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sx = 0, sy = 0;
      for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy; }
      const corr = sxy / Math.sqrt(Math.max(1e-12, sx * sy));
      const ratio = xs.reduce((a, b, i) => a + ys[i] / Math.max(1e-9, b), 0) / xs.length;
      out.push(`  BTC_VOL proxy (vol 60d): vs CSV solape n=${xs.length} · corr=${corr.toFixed(3)} · ratio medio=${ratio.toFixed(2)}`);
    }
  } catch { out.push('  BTC_VOL proxy: sin CSV para validar'); }
  return { valid: issues.length === 0, issues, report: out };
}
function metaFirst(ds: LongDataset, k: string): string {
  const m = ds.meta.proxies[k] ?? ds.meta.macro[k];
  return m?.first ?? (k === 'BTC-EUR' ? ds.meta.proxies['BTC-EUR'].first : '?');
}

if (process.argv[1]?.includes('data_long')) {
  (async () => {
    console.log('='.repeat(100));
    console.log('  TEST 1a — DATASET LARGO CON PROXIES REALES (Yahoo, ajustados, USD→EUR con EURUSD=X real)');
    console.log('='.repeat(100));
    const ds = await loadLongDataset();
    const v = validate(ds);
    console.log(`  Filas: ${ds.dates.length} · ${ds.dates[0]} → ${ds.dates[ds.dates.length - 1]}`);
    for (const l of v.report) console.log(l);
    console.log(`  Gate: ${v.valid ? 'VALIDO — sin saltos injustificados ni huecos >5d' : 'INVALIDO: ' + v.issues.join(' | ')}`);
    console.log(`  Cache: scripts/validation/data_long_cache.json`);
  })();
}
