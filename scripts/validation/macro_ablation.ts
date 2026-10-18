// ============================================================
// scripts/validation/macro_ablation.ts
// ABLACIÓN (solo lectura, no toca src/): ¿los datos macro CAMBIAN las decisiones del motor LEGACY,
// y con qué efecto en rentabilidad y riesgo?
//
// HIPÓTESIS (fijada ANTES de ejecutar):
//   H0: quitar macroHistory no cambia materialmente el resultado (los macro no deciden).
//   H1: lo cambia (los macro deciden).
//
// PROCEDIMIENTO: mismo dataset canónico, mismas ventanas, mismos costes.
//   A) LEGACY con macroHistory completo   B) LEGACY sin macroHistory (fallback neutro CLEAR, registrado)
//   C) CORE con macro   D) CORE sin macro  (control: CORE debería ignorar el macro → diferencia ≈ 0)
//   Se mide: L1 medio de pesos entre A y B (días con rebalanceo y todos los días), exposición media,
//   % días con régimen distinto, CAGR/Sharpe/MaxDD completos y por mitades (1ª / 2ª).
//
// REGLA DE DECISIÓN (fijada antes de ejecutar):
//   · L1 medio de pesos < 2 pp Y |ΔSharpe| < 0,05 Y |ΔMaxDD| < 1 pp → macro NO decide (H0).
//   · Si no → decide (H1); el signo de ΔSharpe/ΔMaxDD dice si ayuda o perjudica.
//   · Si C vs D ≠ 0, el control falla y se reporta.
//   Es una sola muestra histórica: diagnóstico, no prueba.
//
// Ejecutar: npx tsx scripts/validation/macro_ablation.ts
// ============================================================
import { runBacktest, type BacktestInput, type DailyRecord } from '../../src/core/backtest/backtestEngine';
import { buildCanonicalDataset, CFG, deriveMacro, pct } from './sim_core';

const ds = buildCanonicalDataset();
const { yieldSpread, creditSpread, dxyTrend } = deriveMacro(ds);

function mk(core: boolean, macro: boolean): BacktestInput {
  return {
    closesHistory: ds.closes,
    ...(macro ? { macroHistory: { vix: ds.macro.vix, yieldSpread, creditSpread, move: ds.macro.move, dxyTrend, btcVol: ds.macro.btcVol } } : {}),
    lookbackDays: CFG.lookbackDays, rebalanceDays: CFG.rebalanceDays,
    initialCapital: CFG.initialCapital, transactionCostBps: 15, coreMode: core,
  };
}
const l1 = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys({ ...a, ...b }).reduce((s, k) => s + Math.abs((a[k] ?? 0) - (b[k] ?? 0)), 0);
const avg = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);

function stats(recs: DailyRecord[]) {
  const r: number[] = [];
  for (let i = 1; i < recs.length; i++) r.push(recs[i].portfolioValue / recs[i - 1].portfolioValue - 1);
  const m = avg(r), sd = Math.sqrt(avg(r.map(x => (x - m) ** 2)));
  let peak = -Infinity, dd = 0;
  for (const x of recs) { peak = Math.max(peak, x.portfolioValue); dd = Math.min(dd, x.portfolioValue / peak - 1); }
  const yrs = r.length / 252;
  const cagr = Math.pow(recs[recs.length - 1].portfolioValue / recs[0].portfolioValue, 1 / yrs) - 1;
  return { cagr, sharpe: sd > 0 ? (m / sd) * Math.sqrt(252) : 0, dd };
}
const invested = (d: DailyRecord) => 1 - d.cash;

function compare(label: string, core: boolean) {
  const A = runBacktest(mk(core, true)), B = runBacktest(mk(core, false));
  const n = Math.min(A.dailyRecords.length, B.dailyRecords.length);
  const dL1 = Array.from({ length: n }, (_, i) => l1(A.dailyRecords[i].allocations, B.dailyRecords[i].allocations));
  const diffReg = A.dailyRecords.slice(0, n).filter((d, i) => d.regime !== B.dailyRecords[i].regime).length;
  console.log(`\n  ── ${label} ──`);
  console.log(`  Fallbacks neutros en la versión sin macro: ${B.macroFallbacksUsed.join(', ') || '(ninguno)'}`);
  console.log(`  L1 medio de pesos (todos los días): ${(avg(dL1) * 100).toFixed(2)} pp · máx ${(Math.max(...dL1) * 100).toFixed(1)} pp · días con régimen distinto: ${diffReg}/${n}`);
  console.log(`  Exposición media: con macro ${(avg(A.dailyRecords.map(invested)) * 100).toFixed(1)}% · sin macro ${(avg(B.dailyRecords.map(invested)) * 100).toFixed(1)}%`);
  const rows: [string, DailyRecord[], DailyRecord[]][] = [
    ['completa', A.dailyRecords, B.dailyRecords],
    ['1ª mitad', A.dailyRecords.slice(0, n >> 1), B.dailyRecords.slice(0, n >> 1)],
    ['2ª mitad', A.dailyRecords.slice(n >> 1, n), B.dailyRecords.slice(n >> 1, n)],
  ];
  let full = { dS: 0, dD: 0 };
  for (const [nm, a, b] of rows) {
    const sa = stats(a), sb = stats(b);
    if (nm === 'completa') full = { dS: sa.sharpe - sb.sharpe, dD: sa.dd - sb.dd };
    console.log(`  ${nm.padEnd(9)} CON macro: ${pct(sa.cagr)} / Sharpe ${sa.sharpe.toFixed(3)} / DD ${pct(sa.dd, 1)}  ·  SIN macro: ${pct(sb.cagr)} / Sharpe ${sb.sharpe.toFixed(3)} / DD ${pct(sb.dd, 1)}`);
  }
  return { l1: avg(dL1) * 100, ...full };
}

console.log('='.repeat(112));
console.log('  ABLACIÓN MACRO (hipótesis y regla fijadas en la cabecera)');
console.log('='.repeat(112));
const L = compare('LEGACY: con vs sin datos macro', false);
const C = compare('CORE (control): con vs sin datos macro', true);

console.log('\n' + '='.repeat(112));
const decides = !(L.l1 < 2 && Math.abs(L.dS) < 0.05 && Math.abs(L.dD * 100) < 1);
console.log(`  LEGACY: L1 ${L.l1.toFixed(2)} pp · ΔSharpe ${L.dS.toFixed(3)} · ΔMaxDD ${(L.dD * 100).toFixed(2)} pp → ${decides ? 'H1: el macro SÍ decide' : 'H0: el macro NO decide materialmente'}`);
console.log(`  Control CORE: L1 ${C.l1.toFixed(2)} pp · ΔSharpe ${C.dS.toFixed(3)} ${C.l1 < 0.01 ? '✅ ignora el macro, como se esperaba' : '⚠️ el control NO es cero: CORE usa macro de algún modo'}`);
if (decides) console.log(`  Sentido: ΔSharpe>0 y ΔMaxDD>0 (menos profundo) = el macro ayuda; lo contrario = perjudica.`);
console.log('  Aviso: una sola muestra histórica; diagnóstico, no prueba.');
