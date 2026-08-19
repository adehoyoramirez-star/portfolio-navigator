// ============================================================
// scripts/rebuild_history.mjs — VÍA 1 (auditoría forense Ronda 8)
// Reconstruye el histórico con TICKERS EUR REALES desde Yahoo.
//
// PROBLEMA QUE RESUELVE:
//   El CSV antiguo (2015-2026) usaba proxies americanos en USD
//   (BTC-USD, SMH, QQQ, EEM, GLD, URA) etiquetados como si fueran
//   los ETFs europeos reales (BTC-EUR, VVSM.DE, XNAS.DE, EMXC.DE,
//   PPFB.DE, URNU.DE). Esto corrompía TODA la serie de activos.
//
// SOLUCIÓN:
//   Ventana = max(inception de los tickers EUR reales) = 2022-04-17
//   (URNU.DE) → hoy. Activos: tickers EUR reales de Yahoo
//   (range=5y, interval=1d). Macro: Yahoo donde hay serie
//   (^VIX, HYG, LQD, ^MOVE, DX-Y.NYB); ^TNX/^IRX solo existen el
//   último mes en Yahoo → se heredan del CSV actual, con
//   carry-forward DOCUMENTADO en el hueco 2026-04-10→2026-07-22.
//
// CONVENCIONES (idénticas a las del CSV original):
//   - Calendar-daily: todos los días naturales, festivos/fines de
//     semana con el último valor (forward-fill).
//   - BTC_VOL: vol. realizada BTC 90d, anualizada sqrt(365),
//     EN DECIMAL (0.50 = 50%) — unidad que espera el motor
//     (globalStress: umbral 0.80). El CSV antiguo guardaba % (49.87)
//     lo que hacía que globalStress sumara +1 permanentemente (bug).
//
// SALIDA (limpia, LF, SIN CR):
//   - historical_data_daily.csv             (13 cols: Date + 7 activos + ^VIX,^TNX,^IRX,HYG,LQD)
//   - historical_data_daily_augmented.csv   (16 cols: + ^MOVE, DX-Y.NYB, BTC_VOL)
//   - public/... (copias para el dashboard / csvBacktestProvider)
//
// Ejecutar: node scripts/rebuild_history.mjs
// ============================================================

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CSV_BASE = path.join(ROOT, 'historical_data_daily.csv');
const CSV_AUG = path.join(ROOT, 'historical_data_daily_augmented.csv');
const LEGACY_AUG = CSV_AUG;

const ASSET_TICKERS = ['BTC-EUR', 'EMXC.DE', '0P00000WLG.F', 'PPFB.DE', 'URNU.DE', 'VVSM.DE', 'XNAS.DE'];
const MACRO_FROM_YAHOO = ['^VIX', 'HYG', 'LQD', '^MOVE', 'DX-Y.NYB'];
const TNX_IRX_FROM_LEGACY_CUTOFF = '2026-07-23';

const RANGE = '5y';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSeries(ticker) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=' + RANGE + '&interval=1d';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (OlympusRebuild/1.0)' } });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    if (!r) return null;
    const ts = r.timestamp || [];
    const closes = r.indicators?.quote?.[0]?.close || [];
    if (ts.length === 0) return null;
    const dates = [];
    const values = [];
    for (let i = 0; i < ts.length; i++) {
      const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      const c = closes[i];
      if (c !== null && c !== undefined && isFinite(c) && c > 0) {
        dates.push(d);
        values.push(c);
      }
    }
    if (dates.length === 0) return null;
    return { ticker, dates, closes: values };
  } catch {
    return null;
  }
}

function buildCalendar(startDate, endDate) {
  const out = [];
  const cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function ffillOntoCalendar(series, calendar) {
  const map = new Map();
  for (let i = 0; i < series.dates.length; i++) map.set(series.dates[i], series.closes[i]);
  const out = [];
  let last = null;
  for (const d of calendar) {
    if (map.has(d)) last = map.get(d);
    out.push(last);
  }
  return out;
}

function computeBtcVolDecimal(btcCloses) {
  const N = 90;
  const out = [];
  for (let i = 0; i < btcCloses.length; i++) {
    if (i < N) { out.push(0.5); continue; }
    const lr = [];
    for (let j = i - N + 1; j <= i; j++) {
      const prev = btcCloses[j - 1];
      const curr = btcCloses[j];
      if (prev > 0 && curr > 0) lr.push(Math.log(curr / prev));
    }
    if (lr.length < 20) { out.push(0.5); continue; }
    const mean = lr.reduce((a, b) => a + b, 0) / lr.length;
    const variance = lr.reduce((s, x) => s + (x - mean) ** 2, 0) / (lr.length - 1);
    out.push(Math.sqrt(Math.max(0, variance)) * Math.sqrt(365));
  }
  return out;
}

function readLegacyTnxIrx() {
  const content = fs.readFileSync(LEGACY_AUG, 'utf8').replace(/\r/g, '');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const headers = lines[0].split(',');
  const ti = headers.indexOf('^TNX');
  const ii = headers.indexOf('^IRX');
  const dates = [];
  const tnx = [];
  const irx = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 16) continue;
    const d = parts[0];
    const t = parseFloat(parts[ti]);
    const r = parseFloat(parts[ii]);
    if (d && isFinite(t) && t > 0 && isFinite(r) && r > 0) {
      dates.push(d);
      tnx.push(t);
      irx.push(r);
    }
  }
  return { dates, tnx, irx };
}

async function main() {
  console.log('OLYMPUS VÍA 1 — Reconstrucción con tickers EUR reales');
  console.log('='.repeat(60));

  const assetSeries = {};
  for (const t of ASSET_TICKERS) {
    process.stdout.write('  fetch ' + t + '... ');
    const s = await fetchSeries(t);
    if (s) {
      console.log(s.dates.length + ' pts (' + s.dates[0] + ' → ' + s.dates[s.dates.length - 1] + ')');
    } else {
      console.log('FALLÓ');
    }
    assetSeries[t] = s;
    await sleep(300);
  }

  const macroSeries = {};
  for (const t of MACRO_FROM_YAHOO) {
    process.stdout.write('  fetch ' + t + '... ');
    const s = await fetchSeries(t);
    if (s) {
      console.log(s.dates.length + ' pts (' + s.dates[0] + ' → ' + s.dates[s.dates.length - 1] + ')');
    } else {
      console.log('FALLÓ');
    }
    macroSeries[t] = s;
    await sleep(300);
  }

  const tnxY = await fetchSeries('^TNX');
  await sleep(300);
  const irxY = await fetchSeries('^IRX');
  await sleep(300);
  const legacy = readLegacyTnxIrx();
  console.log('  ^TNX Yahoo: ' + (tnxY ? tnxY.dates.length : 0) + ' pts | ^IRX Yahoo: ' + (irxY ? irxY.dates.length : 0) + ' pts | legacy: ' + legacy.dates.length + ' pts');

  const allStarts = Object.values(assetSeries).filter(Boolean).map((s) => s.dates[0]);
  const allEnds = Object.values(assetSeries).filter(Boolean).map((s) => s.dates[s.dates.length - 1]);
  if (allStarts.length < ASSET_TICKERS.length) {
    console.error('ERROR: no todas las series de activos están disponibles. Aborto.');
    process.exit(1);
  }
  const start = allStarts.sort()[allStarts.length - 1];
  const end = allEnds.sort()[0];
  console.log('\nVentana: ' + start + ' → ' + end);

  const calendar = buildCalendar(start, end);
  console.log('Grilla: ' + calendar.length + ' días de calendario');

  const filled = {};
  for (const t of ASSET_TICKERS) filled[t] = ffillOntoCalendar(assetSeries[t], calendar);
  for (const t of MACRO_FROM_YAHOO) {
    if (macroSeries[t]) filled[t] = ffillOntoCalendar(macroSeries[t], calendar);
  }

  const tnxLegacyMap = new Map();
  const irxLegacyMap = new Map();
  for (let i = 0; i < legacy.dates.length; i++) {
    tnxLegacyMap.set(legacy.dates[i], legacy.tnx[i]);
    irxLegacyMap.set(legacy.dates[i], legacy.irx[i]);
  }
  const tnxYMap = new Map();
  const irxYMap = new Map();
  if (tnxY) for (let i = 0; i < tnxY.dates.length; i++) tnxYMap.set(tnxY.dates[i], tnxY.closes[i]);
  if (irxY) for (let i = 0; i < irxY.dates.length; i++) irxYMap.set(irxY.dates[i], irxY.closes[i]);

  const tnxArr = [];
  const irxArr = [];
  for (const d of calendar) {
    let tv = d < TNX_IRX_FROM_LEGACY_CUTOFF ? (tnxLegacyMap.get(d) ?? null) : (tnxYMap.get(d) ?? null);
    let iv = d < TNX_IRX_FROM_LEGACY_CUTOFF ? (irxLegacyMap.get(d) ?? null) : (irxYMap.get(d) ?? null);
    if (tv === null && tnxArr.length > 0) tv = tnxArr[tnxArr.length - 1];
    if (iv === null && irxArr.length > 0) iv = irxArr[irxArr.length - 1];
    tnxArr.push(tv);
    irxArr.push(iv);
  }
  filled['^TNX'] = tnxArr;
  filled['^IRX'] = irxArr;

  const btcVol = computeBtcVolDecimal(filled['BTC-EUR']);
  filled['BTC_VOL'] = btcVol;

  console.log('\n── COBERTURA ──');
  for (const col of [...ASSET_TICKERS, ...MACRO_FROM_YAHOO, '^TNX', '^IRX', 'BTC_VOL']) {
    const arr = filled[col];
    const nonNull = arr.filter((v) => v !== null && isFinite(v)).length;
    console.log('  ' + col.padEnd(14) + ' ' + String(nonNull).padStart(5) + '/' + arr.length + ' (' + ((nonNull / arr.length) * 100).toFixed(1) + '%)');
  }

  console.log('\n── SANITY RETORNOS (outliers ±30%) ──');
  for (const t of ASSET_TICKERS) {
    const arr = filled[t];
    let nOut = 0;
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1];
      const curr = arr[i];
      if (prev > 0 && curr > 0) {
        const r = curr / prev - 1;
        if (Math.abs(r) > 0.3) nOut++;
      }
    }
    console.log('  ' + t.padEnd(14) + ' outliers>±30%: ' + nOut);
  }
  const iApr = calendar.indexOf('2026-04-09');
  const iJul = calendar.indexOf('2026-07-14');
  if (iApr !== -1 && iJul !== -1) {
    const btcApr = filled['BTC-EUR'][iApr];
    const btcJul = filled['BTC-EUR'][iJul];
    console.log('  [gap] BTC 2026-04-09=' + (btcApr ?? 0).toFixed(2) + ' → 2026-07-14=' + (btcJul ?? 0).toFixed(2));
  }

  const hdrBase = ['Date', ...ASSET_TICKERS, '^VIX', '^TNX', '^IRX', 'HYG', 'LQD'];
  const hdrAug = [...hdrBase, '^MOVE', 'DX-Y.NYB', 'BTC_VOL'];

  const fmt = (v) => (v === null || !isFinite(v) ? '' : Number(v).toFixed(6));

  const linesBase = [hdrBase.join(',')];
  const linesAug = [hdrAug.join(',')];
  for (let i = 0; i < calendar.length; i++) {
    const rowBase = [calendar[i], ...ASSET_TICKERS.map((t) => fmt(filled[t][i])), ...['^VIX', '^TNX', '^IRX', 'HYG', 'LQD'].map((t) => fmt(filled[t][i]))];
    const rowAug = [...rowBase, ...['^MOVE', 'DX-Y.NYB', 'BTC_VOL'].map((t) => fmt(filled[t][i]))];
    linesBase.push(rowBase.join(','));
    linesAug.push(rowAug.join(','));
  }

  fs.writeFileSync(CSV_BASE, linesBase.join('\n') + '\n', 'utf8');
  fs.writeFileSync(CSV_AUG, linesAug.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, 'public', 'historical_data_daily.csv'), linesBase.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, 'public', 'historical_data_daily_augmented.csv'), linesAug.join('\n') + '\n', 'utf8');

  console.log('\n✅ CSVs escritos (LF, sin CR):');
  console.log('  ' + CSV_BASE + ' (' + (linesBase.length - 1) + ' filas)');
  console.log('  ' + CSV_AUG + ' (' + (linesAug.length - 1) + ' filas)');
  console.log('  public/ (copias)');

  const check = fs.readFileSync(CSV_AUG, 'utf8');
  console.log('  CR presente:', check.includes('\r') ? '❌ SÍ (bug)' : '✅ NO');
  console.log('\nHecho.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
