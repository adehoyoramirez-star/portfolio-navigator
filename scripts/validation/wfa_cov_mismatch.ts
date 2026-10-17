// ============================================================
// scripts/validation/wfa_cov_mismatch.ts
// DIAGNÓSTICO (solo lectura, no toca src/): ¿el grado C / sobreajuste HIGH del WFA para CORE y
// CORE-DEF viene de que el WFA mide OTRA configuración que la validada?
//
// HECHO VERIFICADO EN EL CÓDIGO (17-oct-2026):
//   · runWalkForwardTest fuerza `useDynamicCovariance: true` (DCC-GARCH) en cada ventana IS y OOS.
//   · Las corridas principales de core_simplificado.ts / core_def_profile.ts NO lo piden
//     (covarianza por defecto, no DCC). El propio motor documenta que el CORE validado usa
//     Ledoit-Wolf y que "CORE con DCC" es la configuración que el criterio preregistrado RECHAZÓ.
//
// HIPÓTESIS (fijada ANTES de ejecutar):
//   H1: el WFA grada "CORE con DCC", no el perfil CORE validado. Si se repite el WFA con la
//       covarianza del perfil (useDynamicCovariance=false), la degradación media IS→OOS cambia.
//
// PROCEDIMIENTO (fijado antes de ejecutar):
//   1. Replicar el bucle IS/OOS del WFA con useDynamicCovariance=true y exigir que reproduzca los
//      números nativos (sharpeIsAvg, sharpeOosAvg, avgSharpeDegradation) a 1e-9 para los TRES
//      perfiles. Si no coincide: abortar (no hay réplica fiable, no se concluye nada).
//   2. Repetir con useDynamicCovariance=false, mismas ventanas y misma función de Sharpe.
//   3. Comparar la degradación media con los umbrales de gradeResults(): B < 0,8 · MODERATE < 0,6.
//      (La consistencia no se recalcula: se reporta solo la degradación; el grado completo
//      requiere computeConsistency, que no está exportada.)
//
// REGLA DE DECISIÓN (fijada antes de ejecutar):
//   · Si con covarianza no-DCC la degradación de CORE o CORE-DEF baja de 0,8 → una parte del
//     bloqueo es artefacto de covarianza distinta a la validada.
//   · Si sigue ≥ 0,8 en ambos → no lo es; el bloqueo viene de otra cosa.
//   · Con 5 ventanas OOS de ~67 días el ruido de cada Sharpe es ≈ ±2,3: es diagnóstico, no prueba.
//
// Ejecutar: npx tsx scripts/validation/wfa_cov_mismatch.ts
// ============================================================

import { runBacktest, type BacktestInput } from '../../src/core/backtest/backtestEngine';
import { runWalkForwardTest, DEFAULT_WF_CONFIG } from '../../src/core/backtest/walkForwardTest';
import { buildCanonicalDataset, CFG, deriveMacro, pct } from './sim_core';

const ds = buildCanonicalDataset();
const { yieldSpread, creditSpread, dxyTrend } = deriveMacro(ds);
const WF = DEFAULT_WF_CONFIG;

type Profile = 'legacy' | 'core' | 'coreDef';
const PROFILES: Profile[] = ['legacy', 'core', 'coreDef'];
const LABEL: Record<Profile, string> = { legacy: 'LEGACY', core: 'CORE', coreDef: 'CORE-DEF' };

function mkInput(p: Profile): BacktestInput {
  return {
    closesHistory: ds.closes,
    macroHistory: { vix: ds.macro.vix, yieldSpread, creditSpread, move: ds.macro.move, dxyTrend, btcVol: ds.macro.btcVol },
    lookbackDays: CFG.lookbackDays,
    rebalanceDays: CFG.rebalanceDays,
    initialCapital: CFG.initialCapital,
    transactionCostBps: 15,
    coreMode: p !== 'legacy',
    ...(p === 'coreDef' ? { coreDefensive: { volTarget: true, killSwitch: true } } : {}),
  };
}

function sliced(input: BacktestInput, start: number, end: number, dcc: boolean): BacktestInput {
  const closes: Record<string, number[]> = {};
  for (const k of Object.keys(input.closesHistory)) closes[k] = input.closesHistory[k].slice(start, end);
  const macro: Record<string, number[]> = {};
  const m = (input.macroHistory ?? {}) as Record<string, number[] | undefined>;
  for (const k of Object.keys(m)) { const v = m[k]; if (v) macro[k] = v.slice(start, end); }
  return {
    ...input,
    closesHistory: closes,
    macroHistory: macro as BacktestInput['macroHistory'],
    lookbackDays: WF.lookbackDays,
    rebalanceDays: WF.rebalanceDays,
    initialCapital: WF.initialCapital,
    transactionCostBps: WF.transactionCostBps,
    useDynamicCovariance: dcc,
  };
}

interface WinRow { isS: number; oosS: number }
function wfLoop(p: Profile, dcc: boolean, wins: { trainEnd: number; testEnd: number }[]): WinRow[] {
  const input = mkInput(p);
  return wins.map(w => {
    const isRes = runBacktest(sliced(input, 0, w.trainEnd, dcc));
    const oosRes = runBacktest(sliced(input, Math.max(0, w.trainEnd - WF.lookbackDays), w.testEnd, dcc));
    return { isS: isRes.metrics.sharpe, oosS: oosRes.metrics.sharpe };
  });
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

console.log('='.repeat(112));
console.log('  ¿EL GRADO C / SOBREAJUSTE HIGH DEL WFA VIENE DE MEDIR OTRA COVARIANZA? (hipótesis y regla fijadas en la cabecera)');
console.log('='.repeat(112));

// 1. WFA nativo (ventanas y números oficiales)
const native = Object.fromEntries(PROFILES.map(p => [p, runWalkForwardTest(mkInput(p), {})])) as Record<Profile, ReturnType<typeof runWalkForwardTest>>;
const wins = native.core.windows.map(w => w.window);
console.log(`\n  Ventanas (${wins.length}): ` + wins.map(w => `[IS 0→${w.trainEnd} · OOS ${w.testStart}→${w.testEnd}, ${w.testEnd - w.testStart}d]`).join(' '));

// 2. Réplica con DCC (debe coincidir con lo nativo) y variante sin DCC
let replicaOk = true;
const res: Record<Profile, { dcc: WinRow[]; lw: WinRow[] }> = {} as never;
console.log('\n  ── PASO 1: la réplica con DCC debe reproducir el WFA nativo (tolerancia 1e-9) ──');
for (const p of PROFILES) {
  const dcc = wfLoop(p, true, wins);
  const lw = wfLoop(p, false, wins);
  res[p] = { dcc, lw };
  const isA = avg(dcc.map(r => r.isS)), oosA = avg(dcc.map(r => r.oosS)), deg = isA - oosA;
  const n = native[p];
  const d = [Math.abs(isA - n.sharpeIsAvg), Math.abs(oosA - n.sharpeOosAvg), Math.abs(deg - n.avgSharpeDegradation)];
  const ok = d.every(x => x < 1e-9);
  replicaOk &&= ok;
  console.log(`  ${LABEL[p].padEnd(9)} IS ${isA.toFixed(4)} vs ${n.sharpeIsAvg.toFixed(4)} · OOS ${oosA.toFixed(4)} vs ${n.sharpeOosAvg.toFixed(4)} · degradación ${deg.toFixed(4)} vs ${n.avgSharpeDegradation.toFixed(4)}  ${ok ? '✅ coincide' : '❌ NO coincide'}`);
}
if (!replicaOk) {
  console.log('\n  ❌ La réplica no reproduce el WFA nativo: no hay base para concluir nada. Se aborta.');
  process.exit(1);
}

// 3. Comparación DCC vs no-DCC
console.log('\n  ── PASO 2-3: mismas ventanas, covarianza DCC (lo que grada el WFA) vs la del perfil validado ──');
console.log('  Perfil     cov          IS medio  OOS medio  degradación   B(<0,8)  MODERATE(<0,6)   Sharpe IS por ventana → OOS por ventana');
const summary: Record<string, number> = {};
for (const p of PROFILES) {
  for (const [name, rows] of [['DCC (WFA)', res[p].dcc], ['no-DCC    ', res[p].lw]] as const) {
    const isA = avg(rows.map(r => r.isS)), oosA = avg(rows.map(r => r.oosS)), deg = isA - oosA;
    summary[`${p}|${name.trim()}`] = deg;
    console.log(
      `  ${LABEL[p].padEnd(9)} ${name} ${isA.toFixed(3).padStart(8)} ${oosA.toFixed(3).padStart(10)} ${deg.toFixed(3).padStart(11)}   ${deg < 0.8 ? ' sí ' : ' no '}      ${deg < 0.6 ? ' sí ' : ' no '}         ` +
        rows.map(r => r.isS.toFixed(2)).join('/') + ' → ' + rows.map(r => r.oosS.toFixed(2)).join('/'),
    );
  }
}

// 4. Efecto sobre la corrida COMPLETA (muestra entera)
console.log('\n  ── Corrida completa: el perfil con DCC frente a la covarianza por defecto (la validada) ──');
for (const p of PROFILES) {
  const a = runBacktest({ ...mkInput(p), useDynamicCovariance: false }).metrics;
  const b = runBacktest({ ...mkInput(p), useDynamicCovariance: true }).metrics;
  console.log(`  ${LABEL[p].padEnd(9)} por defecto: ${pct(a.cagr)} / Sharpe ${a.sharpe.toFixed(3)} / DD ${pct(a.maxDrawdown, 1)}   ·   con DCC: ${pct(b.cagr)} / Sharpe ${b.sharpe.toFixed(3)} / DD ${pct(b.maxDrawdown, 1)}`);
}

// 5. Regla de decisión
console.log('\n' + '='.repeat(112));
console.log('  REGLA DE DECISIÓN (fijada antes de ejecutar)');
console.log('='.repeat(112));
const cLw = summary['core|no-DCC'], dLw = summary['coreDef|no-DCC'];
console.log(`  Degradación sin DCC → CORE ${cLw.toFixed(3)} (con DCC ${summary['core|DCC (WFA)'].toFixed(3)}) · CORE-DEF ${dLw.toFixed(3)} (con DCC ${summary['coreDef|DCC (WFA)'].toFixed(3)})`);
if (cLw < 0.8 || dLw < 0.8) {
  console.log('  → Con la covarianza del perfil la degradación baja de 0,8: parte del bloqueo es artefacto de medir otra covarianza.');
} else {
  console.log('  → Sigue ≥ 0,8 en ambos: la covarianza NO explica el bloqueo; viene de otra cosa.');
}
console.log('  Aviso: 5 ventanas OOS de ~67 días (ruido de cada Sharpe ≈ ±2,3). Diagnóstico, no prueba.');
