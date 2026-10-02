// ============================================================
// scripts/validation/fase3a_test3.ts
// FASE 3A · TEST 3 — CAPA DE ATAQUE: reconstruir cycleBottomSignals con el
//   detector REAL (detectCycleBottoms) y reejecutar la cuenta.
//   Inputs disponibles: mvrvRatio (proxy BTC/MA252, DECLARADO), btcRsiWeekly (RSI14 semanal),
//   wlgRsiWeekly (RSI14 semanal URTH), bondYield10y (^TNX).
//   NO disponibles → puellMultiple, mvrvZScore, uranium spot/LT, siaSalesYoY, soxRsiWeekly,
//   brentOil, wlgPERatio (señales de esos campos = NEUTRAL).
// Ejecutar: npx tsx scripts/validation/fase3a_test3.ts
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, simulate, pct, CFG } from './sim_core';
import { full, slice, WINDOWS } from './metrics_unified';
import { detectCycleBottoms } from '../../src/core/risk/cycleTopDetector';
import { ASSETS } from '../../src/lib/constants';

function rsi14(closes: number[]): number {
  if (closes.length < 15) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - 14; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l += Math.abs(d); }
  const ag = g / 14, al = l / 14; if (al === 0) return 100; return 100 - 100 / (1 + ag / al);
}
function weekKey(dstr: string): string {
  const d = new Date(dstr + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10);
}
/** Último cierre de cada semana (lunes como clave) — sin lookahead: weekEnd = último día hábil ≤ hoy. */
function weeklyCloses(dates: string[], closes: number[]): { weekEnd: string; close: number }[] {
  const out: { weekEnd: string; close: number }[] = []; let cur = '';
  for (let i = 0; i < dates.length; i++) {
    const key = weekKey(dates[i]);
    if (key !== cur) { cur = key; out.push({ weekEnd: dates[i], close: closes[i] }); }
    else out[out.length - 1] = { weekEnd: dates[i], close: closes[i] };
  }
  return out;
}

(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(118));
  console.log('  TEST 3 — RECONSTRUCCIÓN DE SEÑALES DE ATAQUE (detector REAL)');
  console.log('='.repeat(118));
  if (!v.valid) { console.log('  NO VÁLIDO'); return; }
  const R = runEngine(ds); const REC = R.recs.length;
  const dates = ds.dates; const btc = ds.closes['BTC-EUR']; const wlg = ds.closes['0P00000WLG.F'];

  const wB = weeklyCloses(dates, btc); const wW = weeklyCloses(dates, wlg);
  const wBrsi: number[] = wB.map((_, i) => i < 14 ? 50 : rsi14(wB.slice(0, i + 1).map(x => x.close)));
  const wWrsi: number[] = wW.map((_, i) => i < 14 ? 50 : rsi14(wW.slice(0, i + 1).map(x => x.close)));
  const lastWeekIdx = (arr: { weekEnd: string }[], d: string) => { let r = -1; for (let i = 0; i < arr.length; i++) { if (arr[i].weekEnd <= d) r = i; else break; } return r; };

  const signalsByDay: { ticker: string; attackMultiplier: number; shouldAccumulate: boolean; zone: string }[][] = [];
  const zoneCount: Record<string, number> = {}; const tickCount: Record<string, number> = {};
  for (let k = 0; k < REC; k++) {
    const di = CFG.lookbackDays + k; const d = dates[di];
    const win = btc.slice(Math.max(0, di - 251), di + 1); const ma252 = win.reduce((a, b) => a + b, 0) / win.length;
    const mvrvRatio = ma252 > 0 ? btc[di] / ma252 : 1;
    const bw = lastWeekIdx(wB, d), ww = lastWeekIdx(wW, d);
    const out = detectCycleBottoms({
      mvrvRatio, btcRsiWeekly: bw >= 14 ? wBrsi[bw] : undefined,
      wlgRsiWeekly: ww >= 14 ? wWrsi[ww] : undefined, bondYield10y: ds.macro.tnx[di],
    });
    const sig = out.signals.filter(s => s.shouldAccumulate).map(s => ({ ticker: s.ticker, attackMultiplier: s.attackMultiplier, shouldAccumulate: s.shouldAccumulate, zone: s.zone }));
    signalsByDay.push(sig);
    for (const s of sig) { zoneCount[s.zone] = (zoneCount[s.zone] ?? 0) + 1; tickCount[s.ticker] = (tickCount[s.ticker] ?? 0) + 1; }
  }
  const totalSig = Object.values(tickCount).reduce((a, b) => a + b, 0);
  console.log(`  Señales shouldAccumulate reconstruidas: ${totalSig} días-señal en ${REC} días`);
  console.log(`    por zona: ${JSON.stringify(zoneCount)}`);
  console.log(`    por ticker: ${JSON.stringify(tickCount)}`);
  console.log(`  INPUTS NO DISPONIBLES (declarado): puellMultiple, mvrvZScore, uranium spot/LT, siaSalesYoY, soxRsiWeekly, brentOil, wlgPERatio.`);
  console.log(`  → Las señales de URNU/PPFB/vVSM/EMXC quedan NEUTRAL; solo BTC/WLG pueden activarse.`);

  const A = simulate(ds);                                                                  // ataque desactivado (2B/2C)
  const B = simulate(ds, { cycleBottomByDay: signalsByDay });                              // ataque reconstruido
  const mA = full(A.twr, A.dates), mB = full(B.twr, B.dates);
  const covA = slice(A.twr, A.dates, ...WINDOWS.COVID)!, covB = slice(B.twr, B.dates, ...WINDOWS.COVID)!;

  console.log(`\n── IMPACTO (FULL largo) ──`);
  console.log(`  ${'caso'.padEnd(22)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(8)} ${'COVID DD'.padStart(9)} ${'XIRR'.padStart(7)} ${'costes'.padStart(8)} ${'compras'.padStart(8)}`);
  console.log(`  ${'ataque DESACTIVADO'.padEnd(22)} ${pct(mA.cagr).padStart(8)} ${mA.sharpe.toFixed(3).padStart(7)} ${pct(mA.maxDD, 1).padStart(8)} ${pct(covA.m.maxDD, 1).padStart(9)} ${pct(A.xirr).padStart(7)} ${('€' + A.costs.toFixed(0)).padStart(8)} ${String(A.dcaBuyCount).padStart(8)}`);
  console.log(`  ${'ataque RECONSTRUIDO'.padEnd(22)} ${pct(mB.cagr).padStart(8)} ${mB.sharpe.toFixed(3).padStart(7)} ${pct(mB.maxDD, 1).padStart(8)} ${pct(covB.m.maxDD, 1).padStart(9)} ${pct(B.xirr).padStart(7)} ${('€' + B.costs.toFixed(0)).padStart(8)} ${String(B.dcaBuyCount).padStart(8)}`);

  const extreme = B.orderLog.filter(o => o.source === 'DCA' && o.notional > 0 && o.reason.includes('ATTACK'));
  const override = B.orderLog.filter(o => o.reason === 'BTC_CYCLE_OVERRIDE');
  const overrideBreach = override.filter(o => { const k = o.day; const bw = (R.recs[k]?.allocations as any)?.['BTC-EUR'] ?? 0; return bw >= 0.337; });
  console.log(`\n── ATAQUE ──`);
  console.log(`  compras DCA ejecutadas: ${B.dcaBuyCount} (ataque desactivado: ${A.dcaBuyCount})`);
  console.log(`  compras con acción ATTACK: ${extreme.length}`);
  console.log(`  BTC_CYCLE_OVERRIDE disparado: ${override.length} · con BTC del motor ≥0.337: ${overrideBreach.length}`);
  console.log(`  (nota: el simulador usa btcTotalExposure(olympusPct=1.0) → el gate 0.337 compara solo el peso BTC del motor.)`);
  console.log(`  RESULTADO: ${overrideBreach.length > 0 ? 'CONFIRMADO disparo del override sobre la banda' : 'NO CONFIRMADO en la reconstrucción (0 disparos sobre banda)'}`);
  console.log(`\n  FIDELIDAD: la reconstrucción NO es fiel al 100% (faltan inputs on-chain y de uranio).`);
  console.log(`  → El impacto medido es el de las señales REPRODUCIBLES (BTC por proxy MVRV+RSI-W, WG por RSI-W),`);
  console.log(`    NO el de la app completa. Declarado como NO VERIFICADO para el resto de activos.`);
})();
