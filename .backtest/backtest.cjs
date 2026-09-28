// =============================================
// BACKTEST del plan de tramos T0-T4 (EUR) — v2 (valoración cronológica)
// Estrategia: tras el primer gran rebote desde el suelo de ciclo (H),
// escalera de órdenes límite sobre retracements de R = (H - L):
//   T0 (10%)  = confirmación de continuación: primer cierre > H
//   T1 (30%)  = límite en H - 0.270*R   (retroceso 27%)
//   T2 (25%)  = límite en H - 0.457*R   (retroceso 45.7%)
//   T3 (10%)  = límite en H - 0.620*R   (retroceso 62%)
//   T4 (25%)  = límite en H - 0.950*R   (fat pitch: retest del suelo)
// Capital: 10.000 EUR. Sin relleno en 730 días => queda en cash.
// v2: la valoración diaria respeta la cronología real de los fills
//     (cash + acciones según fechas), corrigiendo el drawdown inicial.
// =============================================
const fs = require('fs');
const eur = JSON.parse(fs.readFileSync('btc_eur_yahoo.json', 'utf8')).chart.result[0];
const usd = JSON.parse(fs.readFileSync('btc_usd_yahoo.json', 'utf8')).chart.result[0];

const tsE = eur.timestamp, clE = eur.indicators.quote[0].close;
const tsU = usd.timestamp, clU = usd.indicators.quote[0].close;
const usdByDate = new Map();
for (let i = 0; i < tsU.length; i++) if (clU[i] != null) usdByDate.set(new Date(tsU[i] * 1000).toISOString().slice(0, 10), clU[i]);

const days = [];
for (let i = 0; i < tsE.length; i++) {
  if (clE[i] == null) continue;
  const d = new Date(tsE[i] * 1000).toISOString().slice(0, 10);
  days.push({ d, eur: clE[i], usd: usdByDate.get(d) ?? null });
}
days.sort((a, b) => (a.d < b.d ? -1 : 1));

const idx = (d) => days.findIndex((x) => x.d >= d);
function stat(from, to, key, mode) {
  let best = null;
  for (const x of days) {
    if (x.d >= from && x.d <= to && x[key] != null) {
      if (best == null || (mode === 'min' ? x[key] < best.v : x[key] > best.v)) best = { d: x.d, v: x[key] };
    }
  }
  return best;
}
function firstAfter(from, pred, maxDays) {
  const s = idx(from);
  if (s < 0) return null;
  for (let j = s; j < days.length && j < s + maxDays; j++) if (pred(days[j])) return days[j];
  return null;
}

const AMT = { T0: 1000, T1: 3000, T2: 2500, T3: 1000, T4: 2500 };
const BANDS = { T1: 0.270, T2: 0.457, T3: 0.620, T4: 0.950 };

const cycles = [
  { name: '2014-15', lowFrom: '2014-10-01', lowTo: '2015-03-31', highFrom: '2015-04-01', highTo: '2015-09-30', peakFrom: '2016-11-01', peakTo: '2018-04-30' },
  { name: '2018-19', lowFrom: '2018-10-01', lowTo: '2019-03-31', highFrom: '2019-04-01', highTo: '2019-09-30', peakFrom: '2020-10-01', peakTo: '2022-05-31' },
  { name: '2022-23', lowFrom: '2022-08-01', lowTo: '2023-03-31', highFrom: '2023-04-01', highTo: '2023-09-30', peakFrom: '2024-09-01', peakTo: '2026-01-31' },
  { name: '2026', lowFrom: '2026-04-01', lowTo: '2026-07-31', highFrom: '2026-08-01', highTo: '2026-08-26', peakFrom: null, peakTo: null },
];

function simulate(c) {
  const L = stat(c.lowFrom, c.lowTo, 'eur', 'min');
  const H = stat(c.highFrom, c.highTo, 'eur', 'max');
  const R = H.v - L.v;
  const limits = {};
  for (const t of Object.keys(BANDS)) limits[t] = H.v - BANDS[t] * R;

  // Rellenos (cronología)
  const fills = {};
  const t0 = firstAfter(H.d, (x) => x.eur > H.v, 730);
  if (t0) fills.T0 = { d: t0.d, p: t0.eur };
  for (const t of ['T1', 'T2', 'T3', 'T4']) {
    const f = firstAfter(H.d, (x) => x.eur <= limits[t], 730);
    if (f) fills[t] = { d: f.d, p: limits[t] };
  }
  const seq = Object.entries(fills).sort((a, b) => (a[1].d < b[1].d ? -1 : 1));

  const s = idx(H.d);
  let endIdx = days.length - 1, peak = null;
  if (c.peakFrom) { peak = stat(c.peakFrom, c.peakTo, 'eur', 'max'); endIdx = idx(peak.d); }

  // ---- Valoración cronológica día a día ----
  let cash = 10000, shares = 0;
  const fillIdx = new Map();           // tranche -> índice de días donde se ejecuta
  for (const [t, f] of seq) fillIdx.set(t, idx(f.d));
  const fillAtDay = [];                // por índice de día, lista de tranches
  for (let j = s; j <= endIdx; j++) {
    const list = [];
    for (const [t, f] of seq) if (fillIdx.get(t) === j) list.push(t);
    fillAtDay.push(list);
  }
  const valuePath = [];
  let maxV = 10000, mdd = 0;
  let min365 = 10000, min365D = H.d;
  let recoverDay = null;
  for (let j = s; j <= endIdx; j++) {
    // ejecutar fills de HOY (al cierre, precio del día)
    for (const t of fillAtDay[j - s]) { cash -= AMT[t]; shares += AMT[t] / fills[t].p; }
    const v = cash + shares * days[j].eur;
    valuePath.push({ d: days[j].d, v });
    if (v > maxV) maxV = v;
    const dd = 1 - v / maxV;
    if (dd > mdd) mdd = dd;
    const age = j - s;
    if (age <= 365 && v < min365) { min365 = v; min365D = days[j].d; }
    if (recoverDay == null && v >= 10000) recoverDay = days[j].d;
  }
  const planVal = valuePath[valuePath.length - 1].v;

  // ---- Lump at S (100% en H.d) ----
  let maxVL = 10000, mddL = 0, min365L = 10000, min365DL = H.d;
  for (let j = s; j <= endIdx; j++) {
    const v = (10000 / H.v) * days[j].eur;
    if (v > maxVL) maxVL = v;
    const dd = 1 - v / maxVL;
    if (dd > mddL) mddL = dd;
    const age = j - s;
    if (age <= 365 && v < min365L) { min365L = v; min365DL = days[j].d; }
  }
  const lumpS = (10000 / H.v) * days[endIdx].eur;
  const lumpL = (10000 / L.v) * days[endIdx].eur;

  // ---- Métricas ----
  let minClose = Infinity, minD = null;
  for (let j = s; j < days.length && j < s + 730; j++) if (days[j].eur < minClose) { minClose = days[j].eur; minD = days[j].d; }
  const maxRetrace = (H.v - minClose) / R;
  const deployed = 10000 - cash;
  const cmp = deployed > 0 ? (10000 - cash) / shares : null;
  const firstFill = seq.length ? seq[0][1] : null;
  const daysToFirst = firstFill ? Math.round((new Date(firstFill.d) - new Date(H.d)) / 86400000) : null;

  return { c, L, H, R, limits, seq, cash, shares, cmp, planVal, lumpS, lumpL, mdd, mddL, min365, min365D, min365L, min365DL, maxRetrace, daysToFirst, endD: days[endIdx].d, endEur: days[endIdx].eur, minClose, minD, peak, deployed, recoverDay };
}

function fmt(n, d = 0) { return n == null ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function pct(n, d = 1) { return (n * 100).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%'; }

console.log('╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║  BACKTEST PLAN DE TRAMOS T0-T4 · BTC-EUR · Yahoo cierre diario · v2       ║');
console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');

const agg = { deployed: [], cmpDisc: [], mdd: [], mddL: [], min365r: [], ratioPeak: [], retrace: [], daysFirst: [], fills: {} };
for (const t of ['T0', 'T1', 'T2', 'T3', 'T4']) agg.fills[t] = [];

for (const c of cycles) {
  const r = simulate(c);
  const Lu = stat(c.lowFrom, c.lowTo, 'usd', 'min');
  const Hu = stat(c.highFrom, c.highTo, 'usd', 'max');
  console.log(`────────────── CICLO ${r.c.name} ──────────────`);
  console.log(`Suelo L:      ${r.L.d}  EUR ${fmt(r.L.v)}  (USD ${fmt(Lu.v)} · FX ${(Lu.v / r.L.v).toFixed(3)})`);
  console.log(`Techo rebote H: ${r.H.d}  EUR ${fmt(r.H.v)}  (USD ${fmt(Hu.v)} · FX ${(Hu.v / r.H.v).toFixed(3)})`);
  console.log(`Rango R:      ${fmt(r.R)} EUR`);
  console.log(`Límites:      T1 ${fmt(r.limits.T1)} · T2 ${fmt(r.limits.T2)} · T3 ${fmt(r.limits.T3)} · T4 ${fmt(r.limits.T4)}`);
  console.log(`Rellenos:`);
  if (r.seq.length === 0) console.log('   (ninguno)');
  for (const [t, f] of r.seq) {
    const d = Math.round((new Date(f.d) - new Date(r.H.d)) / 86400000);
    console.log(`   ${t}  ${f.d}  (día +${d})  €${fmt(f.p)}  · €${fmt(AMT[t])}`);
  }
  const isLive = r.c.name === '2026';
  if (!isLive) {
    agg.deployed.push(r.deployed / 10000);
    agg.cmpDisc.push(r.cmp ? (r.cmp - r.H.v) / r.H.v : null);
    agg.mdd.push(r.mdd); agg.mddL.push(r.mddL);
    agg.min365r.push(r.min365 / r.min365L);
    agg.retrace.push(r.maxRetrace);
    agg.ratioPeak.push(r.planVal / r.lumpS);
    if (r.daysToFirst != null) agg.daysFirst.push(r.daysToFirst);
    for (const t of Object.keys(agg.fills)) agg.fills[t].push(r.seq.some(([tt]) => tt === t) ? 1 : 0);
  }
  console.log(`Rellenos: ${r.seq.length}/5 · Capital: €${fmt(r.deployed)} (${pct(r.deployed / 10000)}) · CMP €${fmt(r.cmp)} vs S €${fmt(r.H.v)} → ${r.cmp ? pct((r.cmp - r.H.v) / r.H.v) : '—'}`);
  console.log(`Retrace máx. real post-H: ${pct(r.maxRetrace)} (mín. €${fmt(r.minClose)} el ${r.minD}) · días al 1er relleno: ${r.daysToFirst ?? '—'}`);
  if (!isLive) {
    console.log(`Dolor inicial (año 1) → Plan mínimo €${fmt(r.min365)} (${pct(r.min365 / 10000 - 1)}) · Lump-at-S mínimo €${fmt(r.min365L)} (${pct(r.min365L / 10000 - 1)})`);
    console.log(`Max drawdown (todo el periodo) → Plan: ${pct(r.mdd)} · Lump-at-S: ${pct(r.mddL)}`);
    console.log(`Pico ${r.peak.d} €${fmt(r.endEur)}: Plan €${fmt(r.planVal)} (×${(r.planVal / 10000).toFixed(2)}) · Lump-at-S €${fmt(r.lumpS)} (×${(r.lumpS / 10000).toFixed(2)}) · Lump-at-L €${fmt(r.lumpL)} (×${(r.lumpL / 10000).toFixed(2)}) · Cash €10.000`);
    console.log(`   Plan/Lump-at-S en pico: ×${(r.planVal / r.lumpS).toFixed(2)}`);
  } else {
    const today = days[days.length - 1];
    console.log(`Hoy ${today.d}: €${fmt(today.eur)} · distancia a T1 (€${fmt(r.limits.T1)}): ${pct((today.eur - r.limits.T1) / today.eur)} · T4 = retest del suelo (€${fmt(r.limits.T4)})`);
    console.log(`   ⚠️ Los pivotes del panel están en EUR: el suelo real del ciclo = €50.0-51.3k (jun-2026), no €45k`);
  }
  console.log('');
}

console.log('══════════════ RESUMEN ESTADÍSTICO (3 ciclos completados) ══════════════');
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sorted = (a) => a.slice().sort((x, y) => x - y);
console.log(`Despliegue medio de capital:              ${pct(mean(agg.deployed))}`);
console.log(`Descuento medio del CMP vs S:             ${pct(mean(agg.cmpDisc))}`);
console.log(`Retracement medio real post-H:            ${pct(mean(agg.retrace))} (mediana ${pct(sorted(agg.retrace)[1])})`);
console.log(`Días medios al 1er relleno (T1):          ${Math.round(mean(agg.daysFirst))}`);
console.log(`Dolor inicial año 1 → ratio Plan/Lump:    ${(mean(agg.min365r)).toFixed(2)} (plan sufre ${pct(1 - mean(agg.min365r))} menos)`);
console.log(`Max drawdown medio → Plan:                ${pct(mean(agg.mdd))} · Lump-at-S: ${pct(mean(agg.mddL))}`);
console.log(`Ratio Plan/Lump-at-S en pico (media):     ×${mean(agg.ratioPeak).toFixed(2)}`);
console.log(`  Plan bate a Lump-at-S en drawdown:      ${agg.mdd.filter((v, i) => v < agg.mddL[i]).length}/3 ciclos`);
console.log(`  Plan bate a Lump-at-S en valor en pico: ${agg.ratioPeak.filter((v) => v > 1).length}/3 ciclos`);
console.log('Fills por tramo (3 ciclos):');
for (const t of ['T1', 'T2', 'T3', 'T4', 'T0']) {
  const n = agg.fills[t].reduce((s, v) => s + v, 0);
  console.log(`   ${t} (€${fmt(AMT[t])}, banda ${t === 'T0' ? '>H' : pct(BANDS[t])}): ${n}/3 = ${pct(n / 3, 0)}`);
}
console.log('');
console.log('Lectura 2026 (ciclo en curso):');
console.log('  • T1 llena en 3/3 ciclos históricos (100%), en ~1-7 semanas.');
console.log('  • T2/T3 llenan en 2/3 (67%). Retrace medio real = 66-76% del rebote → zona €54-60k.');
console.log('  • T4 (fat pitch, retest del suelo) NO llenó en 3/3 ciclos (0%). El retest más profundo fue 82%.');
console.log('  • El fondo real en EUR fue ~€50-51k (jun-2026): el €45k del usuario = nivel de RUPTURA, no de retest.');
