// ============================================================
// scripts/validation/core_def_profile.ts
// VALIDACIÓN del perfil CORE-DEF (CORE + vol target + Kill Switch, OPT-IN)
// frente a LEGACY y CORE, con criterios PREREGISTRADOS en
// scripts/validation/PREREGISTRO_CORE_DEF.md (leerlo ANTES de mirar resultados).
//
// El perfil se activa POR LLAMADA (`coreMode: true` + `coreDefensive`), así que la ruta por
// defecto sigue bit-idéntica. Mismo dataset, split y costes que core_simplificado.ts.
//
// Ejecutar: npx tsx scripts/validation/core_def_profile.ts
// ============================================================

import { runBacktest, type BacktestInput } from '../../src/core/backtest/backtestEngine';
import { runWalkForwardTest } from '../../src/core/backtest/walkForwardTest';
import { buildCanonicalDataset, metrics, CFG, pct, deriveMacro } from './sim_core';
import { ASSETS } from '../../src/lib/constants';

const SPLIT = '2023-10-28';
const SEED = 20261017;
const BLOCK = 21;
const REPS = 10000;

const ds = buildCanonicalDataset();
const { yieldSpread, creditSpread, dxyTrend } = deriveMacro(ds);

type Profile = 'legacy' | 'core' | 'coreDef';

function mkInput(profile: Profile): BacktestInput {
  return {
    closesHistory: ds.closes,
    macroHistory: {
      vix: ds.macro.vix,
      yieldSpread,
      creditSpread,
      move: ds.macro.move,
      dxyTrend,
      btcVol: ds.macro.btcVol,
    },
    lookbackDays: CFG.lookbackDays,
    rebalanceDays: CFG.rebalanceDays,
    initialCapital: CFG.initialCapital,
    transactionCostBps: 15,
    coreMode: profile !== 'legacy',
    ...(profile === 'coreDef' ? { coreDefensive: { volTarget: true, killSwitch: true } } : {}),
  };
}

function sliceMetrics(twr: number[], values: number[], dates: string[], from: string, to: string) {
  const rs: number[] = [], vv: number[] = [], dd: string[] = [];
  for (let i = 0; i < twr.length; i++) {
    const d = dates[i];
    if (d >= from && d <= to) { rs.push(twr[i]); vv.push(values[i]); dd.push(d); }
  }
  if (!rs.length) return null;
  return metrics(rs, vv, dd);
}

function summarize(bt: ReturnType<typeof runBacktest>, label: string) {
  const recs = bt.dailyRecords;
  const dates = ds.dates.slice(CFG.lookbackDays, CFG.lookbackDays + recs.length);
  const values = recs.map(r => r.portfolioValue);
  const twr: number[] = [];
  for (let i = 1; i < recs.length; i++) twr.push(values[i] / values[i - 1] - 1);

  let oneWay = 0;
  let prev: Record<string, number> | null = null;
  let investedSum = 0;
  for (const r of recs) {
    const a = r.allocations as Record<string, number>;
    if (prev) for (const t of ASSETS) oneWay += Math.abs((a[t] ?? 0) - (prev[t] ?? 0));
    investedSum += ASSETS.reduce((s, t) => s + (a[t] ?? 0), 0);
    prev = a;
  }
  const years = recs.length / 365;
  return {
    label,
    full: metrics(twr, values, dates),
    is: sliceMetrics(twr, values, dates, '2000-01-01', '2023-10-27'),
    oos: sliceMetrics(twr, values, dates, SPLIT, '2030-01-01'),
    turnoverPerYear: (oneWay / 2) / Math.max(1e-9, years),
    avgInvested: investedSum / Math.max(1, recs.length),
    costs: (bt as unknown as { totalTransactionCosts?: number }).totalTransactionCosts ?? NaN,
    fallbacks: bt.macroFallbacksUsed,
    daily: { twr, dates },
  };
}

type Row = ReturnType<typeof summarize>;
const f = (m: { cagr: number; sharpe: number; maxDD: number } | null) =>
  m ? `${pct(m.cagr).padStart(8)} ${m.sharpe.toFixed(3).padStart(7)} ${pct(m.maxDD, 1).padStart(8)}` : '(sin datos)';

console.log('='.repeat(118));
console.log('  PERFIL CORE-DEF vs CORE vs LEGACY — criterios PREREGISTRADOS en PREREGISTRO_CORE_DEF.md');
console.log('='.repeat(118));

const legacy = summarize(runBacktest(mkInput('legacy')), 'LEGACY (v5.3)');
const core = summarize(runBacktest(mkInput('core')), 'CORE');
const def = summarize(runBacktest(mkInput('coreDef')), 'CORE-DEF');
const def2 = summarize(runBacktest(mkInput('coreDef')), 'CORE-DEF corrida 2');

console.log('\n  Fila                    CAGR      Sharpe     MaxDD    Turn/año  Invertido  Costes €  fallbacks');
console.log('  ' + '-'.repeat(112));
for (const s of [legacy, core, def, def2]) {
  console.log(
    `  ${s.label.padEnd(20)} ${f(s.full)}   ${s.turnoverPerYear.toFixed(1).padStart(6)}   ${pct(s.avgInvested, 1).padStart(7)}  ${Number.isFinite(s.costs) ? s.costs.toFixed(0).padStart(7) : '    n/d'}   ${s.fallbacks.length}`,
  );
}
console.log('\n  ── IS (≤ 2023-10-27) ──');
for (const s of [legacy, core, def]) console.log(`  ${s.label.padEnd(12)} ${f(s.is)}`);
console.log('\n  ── OOS (≥ 2023-10-28) ──');
for (const s of [legacy, core, def]) console.log(`  ${s.label.padEnd(12)} ${f(s.oos)}`);

// ── Criterios ────────────────────────────────────────────────────
const r2 = (x: number, d: number) => Number(x.toFixed(d));
const legOk = r2(legacy.full.cagr * 100, 2) === 23.14 && r2(legacy.full.sharpe, 3) === 1.266 && r2(legacy.full.maxDD * 100, 1) === -15.4;
const coreOk = r2(core.full.cagr * 100, 2) === 24.8 && r2(core.full.sharpe, 3) === 1.638 && r2(core.full.maxDD * 100, 1) === -15.0;
const B1a = legOk && coreOk;
const B2 = Math.abs(def.full.cagr - def2.full.cagr) < 1e-12;
const defOos = def.oos!, legOos = legacy.oos!;
const B3 = defOos.sharpe >= legOos.sharpe;
const B4 = defOos.maxDD >= legOos.maxDD;
const B5 = def.turnoverPerYear <= 15 && Number.isFinite(def.costs) && Number.isFinite(legacy.costs) && def.costs <= legacy.costs;
const B6 = def.fallbacks.length === 0;

// ── WFA (informativo) ────────────────────────────────────────────
console.log('\n  ── WFA (walk-forward, informativo) ──');
function wfa(input: BacktestInput, label: string): Record<string, number> {
  const r = runWalkForwardTest(input, {}) as unknown as Record<string, unknown>;
  console.log(`  ${label}:`);
  for (const k of [
    'sharpeIsAvg', 'sharpeOosAvg', 'avgSharpeDegradation', 'overallConsistency',
    'pctWindowsPositiveSharpe', 'deflatedSharpeRatio', 'probabilisticSharpeRatio',
    'beatsEqualWeight', 'robustnessGrade', 'overfittingRisk',
  ]) {
    const v = r[k];
    if (v !== undefined) console.log(`    ${k.padEnd(28)} = ${typeof v === 'number' ? v.toFixed(4) : String(v)}`);
  }
  return r as unknown as Record<string, number>;
}
const wfaL = wfa(mkInput('legacy'), 'LEGACY');
const wfaC = wfa(mkInput('core'), 'CORE');
const wfaD = wfa(mkInput('coreDef'), 'CORE-DEF');

// ── Bootstrap pareado (informativo) ──────────────────────────────
function oosSeries(s: Row) {
  const r: number[] = [], d: string[] = [];
  for (let i = 0; i < s.daily.twr.length; i++) {
    const day = s.daily.dates[i + 1];
    if (day !== undefined && day >= SPLIT) { r.push(s.daily.twr[i]); d.push(day); }
  }
  return { r, d };
}
const sharpeOf = (x: number[]) => {
  const mu = x.reduce((a, b) => a + b, 0) / x.length;
  const sd = Math.sqrt(x.reduce((s, r) => s + (r - mu) ** 2, 0) / x.length);
  return sd > 0 ? (mu * CFG.dpy - CFG.rf) / (sd * Math.sqrt(CFG.dpy)) : 0;
};
function pairedBootstrap(a: Row, b: Row, label: string) {
  const oa = oosSeries(a), ob = oosSeries(b);
  if (oa.d.length !== ob.d.length || oa.d.some((x, i) => x !== ob.d[i])) {
    console.error(`  ❌ Series OOS no alineadas (${label}: ${oa.d.length} vs ${ob.d.length}). Se aborta.`);
    process.exit(1);
  }
  let seed = SEED;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const n = oa.r.length;
  const deltas: number[] = [];
  for (let k = 0; k < REPS; k++) {
    const x: number[] = [], y: number[] = []; let m = 0;
    while (m < n) {
      const st = Math.floor(rnd() * (n - BLOCK));
      for (let j = 0; j < BLOCK && m < n; j++, m++) { x.push(oa.r[st + j]); y.push(ob.r[st + j]); }
    }
    deltas.push(sharpeOf(x) - sharpeOf(y));
  }
  deltas.sort((p, q) => p - q);
  const lo = deltas[Math.floor(REPS * 0.025)], hi = deltas[Math.floor(REPS * 0.975)], med = deltas[Math.floor(REPS * 0.5)];
  const obs = sharpeOf(oa.r) - sharpeOf(ob.r);
  console.log(`  ${label.padEnd(22)} n=${n} · ΔSharpe observado ${obs.toFixed(3)} · mediana ${med.toFixed(3)} · IC95 [${lo.toFixed(3)}, ${hi.toFixed(3)}] ${lo > 0 || hi < 0 ? '(excluye 0)' : '(incluye 0)'}`);
}
console.log(`\n  ── BOOTSTRAP PAREADO ΔSharpe OOS (bloque ${BLOCK}d, ${REPS} réplicas, semilla ${SEED}; informativo) ──`);
pairedBootstrap(def, legacy, 'CORE-DEF − LEGACY');
pairedBootstrap(def, core, 'CORE-DEF − CORE');

// ── Veredicto ────────────────────────────────────────────────────
console.log('\n' + '='.repeat(118));
console.log('  VEREDICTO — criterios PREREGISTRADOS (B1 b/c: tsc y vitest se comprueban aparte)');
console.log('='.repeat(118));
const rows: [string, boolean, string][] = [
  ['B1a baselines reproducidos', B1a, `LEGACY ${pct(legacy.full.cagr)}/${legacy.full.sharpe.toFixed(3)}/${pct(legacy.full.maxDD, 1)} · CORE ${pct(core.full.cagr)}/${core.full.sharpe.toFixed(3)}/${pct(core.full.maxDD, 1)}`],
  ['B2 determinismo', B2, `ΔCAGR entre dos corridas = ${Math.abs(def.full.cagr - def2.full.cagr).toExponential(2)}`],
  ['B3 Sharpe OOS ≥ LEGACY', B3, `CORE-DEF ${defOos.sharpe.toFixed(3)} vs LEGACY ${legOos.sharpe.toFixed(3)}`],
  ['B4 MaxDD OOS no peor', B4, `CORE-DEF ${pct(defOos.maxDD, 1)} vs LEGACY ${pct(legOos.maxDD, 1)}`],
  ['B5 turnover ≤15/año y costes ≤ LEGACY', B5, `${def.turnoverPerYear.toFixed(1)}/año · €${def.costs.toFixed(0)} vs €${legacy.costs.toFixed(0)}`],
  ['B6 política de datos', B6, `${def.fallbacks.length} fallback(s)`],
];
for (const [n, ok, detail] of rows) console.log(`  ${ok ? '✅' : '❌'} ${n.padEnd(42)} — ${detail}`);

console.log('\n  WFA (informativo): sharpeOosAvg  LEGACY ' + wfaL.sharpeOosAvg?.toFixed(3) + ' · CORE ' + wfaC.sharpeOosAvg?.toFixed(3) + ' · CORE-DEF ' + wfaD.sharpeOosAvg?.toFixed(3));
console.log('  Recordatorio: los resultados NO son una confirmación independiente (preregistro §1).');

const kills: string[] = [];
if (!B3) kills.push('K1: Sharpe OOS de CORE-DEF peor que LEGACY');
if (!B4) kills.push(`K2: MaxDD OOS de CORE-DEF peor que LEGACY (${pct(defOos.maxDD, 1)} vs ${pct(legOos.maxDD, 1)})`);
if (!B1a) kills.push('K3: no se reproducen los baselines congelados → revertir el cambio en src/');
console.log('\n  ── Regla de decisión (§4-§5 del preregistro) ──');
if (kills.length === 0 && B2 && B5 && B6) {
  console.log('  ✅ B1a-B6 cumplidos → el perfil queda como OPT-IN válido (NO se promueve a producción).');
} else {
  console.log('  ❌ Perfil NO aceptado. Motivos:');
  for (const k of kills) console.log(`     · ${k}`);
  if (!B2) console.log('     · B2: no determinista');
  if (!B5) console.log('     · B5: turnover/costes fuera de criterio');
  if (!B6) console.log('     · B6: fallbacks silenciosos');
}
