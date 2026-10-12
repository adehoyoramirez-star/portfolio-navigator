// ============================================================
// scripts/validation/core_simplificado.ts
// VALIDACIÓN IS + OOS + WFA del perfil simplificado (OLYMPUS CORE v1.0)
// frente a la ruta legacy, con criterios PREREGISTRADOS
// (scripts/validation/PREREGISTRO_CORE_V11.md — leerlo ANTES de mirar resultados).
//
// "Quitar capas del motor hacia V3" ya existe en el código: OLYMPUS_CORE.enabled
// desactiva kill switch, vol target, correlation panic, absolute trend gate, BL
// y MinVar. Solo se pasa `coreMode: true` POR LLAMADA → NO se toca src/ y la
// ruta por defecto sigue bit-idéntica a v5.3.
//
// Ejecutar: npx tsx scripts/validation/core_simplificado.ts
// ============================================================

import { runBacktest, type BacktestInput } from '../../src/core/backtest/backtestEngine';
import { runWalkForwardTest } from '../../src/core/backtest/walkForwardTest';
import { buildCanonicalDataset, metrics, CFG, pct, deriveMacro } from './sim_core';
import { ASSETS } from '../../src/lib/constants';

const SPLIT = '2023-10-28';

const ds = buildCanonicalDataset();
const { yieldSpread, creditSpread, dxyTrend } = deriveMacro(ds);

function mkInput(core: boolean): BacktestInput {
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
    coreMode: core,
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

  // Turnover one-way anualizado: 0.5 * Σ|Δw| entre pesos consecutivos.
  let oneWay = 0;
  let prev: Record<string, number> | null = null;
  for (const r of recs) {
    const a = r.allocations as Record<string, number>;
    if (prev) for (const t of ASSETS) oneWay += Math.abs((a[t] ?? 0) - (prev[t] ?? 0));
    prev = a;
  }
  const years = recs.length / 365;
  const turnoverPerYear = (oneWay / 2) / Math.max(1e-9, years);

  return {
    label,
    full: metrics(twr, values, dates),
    is: sliceMetrics(twr, values, dates, '2000-01-01', '2023-10-27'),
    oos: sliceMetrics(twr, values, dates, SPLIT, '2030-01-01'),
    turnoverPerYear,
    rebalances: bt.rebalanceCount,
    coreMode: bt.coreMode,
    fallbacks: bt.macroFallbacksUsed,
    daily: { twr, values, dates },
  };
}

console.log('='.repeat(118));
console.log('  PERFIL SIMPLIFICADO (CORE v1.0) vs LEGACY — criterios PREREGISTRADOS en PREREGISTRO_CORE_V11.md');
console.log('='.repeat(118));

const legacy = summarize(runBacktest(mkInput(false)), 'LEGACY (v5.3)');
const core = summarize(runBacktest(mkInput(true)), 'CORE (simplificado)');
const core2 = summarize(runBacktest(mkInput(true)), 'CORE corrida 2');

const f = (m: { cagr: number; sharpe: number; maxDD: number } | null) =>
  m ? `${pct(m.cagr).padStart(8)} ${m.sharpe.toFixed(3).padStart(7)} ${pct(m.maxDD, 1).padStart(8)}` : '(sin datos)';

console.log('\n  Fila                 CAGR      Sharpe     MaxDD     Turn/año  coreMode  fallbacks');
console.log('  ' + '-'.repeat(108));
for (const s of [legacy, core, core2]) {
  console.log(`  ${s.label.padEnd(20)} ${f(s.full)}   ${s.turnoverPerYear.toFixed(1).padStart(6)}   ${String(s.coreMode).padStart(6)}   ${s.fallbacks.length}`);
}

console.log('\n  ── IS (≤ 2023-10-27) ──');
console.log(`  LEGACY  ${f(legacy.is)}`);
console.log(`  CORE    ${f(core.is)}`);
console.log('\n  ── OOS (≥ 2023-10-28) ──');
console.log(`  LEGACY  ${f(legacy.oos)}`);
console.log(`  CORE    ${f(core.oos)}`);

// ── A1: determinismo ─────────────────────────────────────────────
const d1 = core.full.cagr, d2 = core2.full.cagr;
const deterministic = Math.abs(d1 - d2) < 1e-12;

// ── A3 / A4 / K1 / K2: la comparación decisiva (misma ventana) ────
const coreOos = core.oos!, legOos = legacy.oos!;
const A3 = coreOos.sharpe > legOos.sharpe;
const A4 = coreOos.maxDD >= legOos.maxDD - 0.02;
const K1 = !A3;
const K2 = !A4;
const A5 = core.turnoverPerYear <= 15;
const A6 = core.fallbacks.length === 0;

// ── A2: rango documentado (informativo, ventana distinta) ────────
const inRange =
  coreOos.cagr >= 0.238 && coreOos.cagr <= 0.278 &&
  coreOos.sharpe >= 1.57 && coreOos.sharpe <= 1.87 &&
  coreOos.maxDD >= -0.187 && coreOos.maxDD <= -0.147;

// ── WFA: robustez de la ventaja al mover la ventana ──────────────
console.log('\n  ── WFA (walk-forward) ──');
function wfa(input: BacktestInput, label: string) {
  const r = runWalkForwardTest(input, {}) as unknown as Record<string, unknown>;
  const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : NaN);
  console.log(`  ${label}:`);
  for (const k of [
    'sharpeIsAvg', 'sharpeOosAvg', 'avgSharpeDegradation',
    'overallConsistency', 'pctWindowsPositiveSharpe',
    'deflatedSharpeRatio', 'probabilisticSharpeRatio',
    'beatsEqualWeight', 'robustnessGrade', 'overfittingRisk',
  ]) {
    const v = r[k];
    if (v !== undefined) {
      console.log(`    ${k.padEnd(28)} = ${typeof v === 'number' ? v.toFixed(4) : String(v)}`);
    }
  }
  return r;
}
const wfaL = wfa(mkInput(false), 'LEGACY') as unknown as Record<string, number>;
const wfaC = wfa(mkInput(true), 'CORE') as unknown as Record<string, number>;

// K4 tal y como está ESCRITO en el preregistro: "la ventaja del simplificado
// desaparece al mover la ventana (Sharpe OOS por ventana <= legacy)".
// Se usa sharpeOosAvg como agregador. overallConsistency / avgSharpeDegradation
// se reportan como EVIDENCIA ADICIONAL, no como parte del criterio congelado.
const K4 = wfaC.sharpeOosAvg <= wfaL.sharpeOosAvg;
const kills: string[] = [];

// ── Veredicto ────────────────────────────────────────────────────
console.log('\n' + '='.repeat(118));
console.log('  VEREDICTO — criterios PREREGISTRADOS');
console.log('='.repeat(118));
const rows: [string, boolean, string][] = [
  ['A1 determinismo', deterministic, `ΔCAGR entre dos corridas CORE = ${Math.abs(d1 - d2).toExponential(2)}`],
  ['A3 Sharpe OOS gana', A3, `CORE ${coreOos.sharpe.toFixed(3)} vs LEGACY ${legOos.sharpe.toFixed(3)}`],
  ['A4 MaxDD cede ≤2pp', A4, `CORE ${pct(coreOos.maxDD, 1)} vs LEGACY ${pct(legOos.maxDD, 1)}`],
  ['A5 turnover ≤15/año', A5, `${core.turnoverPerYear.toFixed(1)}/año`],
  ['A6 data policy (sin fallbacks silenciosos)', A6, `${core.fallbacks.length} fallback(s)`],
  ['K4 Sharpe OOS por ventana gana', !K4, `CORE ${wfaC.sharpeOosAvg.toFixed(3)} vs LEGACY ${wfaL.sharpeOosAvg.toFixed(3)} · degradación IS→OOS ${wfaC.avgSharpeDegradation.toFixed(3)} vs ${wfaL.avgSharpeDegradation.toFixed(3)} · consistencia ${wfaC.overallConsistency.toFixed(3)} vs ${wfaL.overallConsistency.toFixed(3)}`],
  ['rango spec (§13.2) [informativo]', inRange, `CAGR ${pct(coreOos.cagr)} · Sharpe ${coreOos.sharpe.toFixed(3)} · DD ${pct(coreOos.maxDD, 1)} (ventana distinta a Phase 12)`],
];
for (const [n, ok, detail] of rows) console.log(`  ${ok ? '✅' : '❌'} ${n.padEnd(44)} — ${detail}`);

if (K1) kills.push('K1: Sharpe OOS del simplificado no gana al legacy');
if (K2) kills.push(`K2: MaxDD OOS peor por ${(100 * (legOos.maxDD - coreOos.maxDD)).toFixed(2)} pp (>2pp)`);
if (!deterministic) kills.push('K3: no determinista');
if (K4) {
  kills.push(
    `K4: Sharpe OOS por ventana del simplificado NO supera al legacy ` +
      `(${wfaC.sharpeOosAvg.toFixed(3)} vs ${wfaL.sharpeOosAvg.toFixed(3)})`,
  );
}

console.log('\n  ── Regla de decisión (§5 del preregistro) ──');
if (kills.length === 0) {
  console.log('  ✅ NINGÚN CRITERIO ANIQUILADOR DISPARADO → se propone activar el perfil');
  console.log('     (commit aparte: OLYMPUS_CORE.enabled = true + ENGINE_CONFIG_VERSION 4.0.0)');
} else {
  console.log('  ❌ NO ACTIVAR. Criterios aniquiladores disparados:');
  for (const k of kills) console.log(`     · ${k}`);
  console.log('     El perfil queda enabled: false, tal y como está hoy.');
}
