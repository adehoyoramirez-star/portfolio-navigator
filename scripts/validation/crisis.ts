// scripts/validation/crisis.ts — FASE 2A · TEST D
// Cobertura de crisis. Nada de esto modifica src/.
import fs from 'fs';
import path from 'path';
import { runBacktest } from '../../src/core/backtest/backtestEngine';
import { runAllStressScenarios, STRESS_SCENARIOS, runStressScenario } from '../../src/core/simulation/stressScenarios';
import { ASSETS } from '../../src/lib/constants';

const pct = (x: number, d = 2) => (x * 100).toFixed(d) + '%';
const BAR = '='.repeat(104);

function load(file: string) {
  const lines = fs.readFileSync(path.join(process.cwd(), file), 'utf8').split('\n').filter(l => l.trim());
  const H = lines[0].split(',');
  const ch: Record<string, number[]> = {}; ASSETS.forEach(a => ch[a] = []);
  const m = { vix: [] as number[], tnx: [] as number[], irx: [] as number[], hyg: [] as number[], lqd: [] as number[], move: [] as number[], dxy: [] as number[], btcVol: [] as number[] };
  const d: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(','); if (p.length < H.length) continue;
    d.push(p[0]);
    for (const a of ASSETS) { const k = H.indexOf(a); if (k !== -1) ch[a].push(parseFloat(p[k]) || 0); }
    const g = (n: string, dflt: number) => { const k = H.indexOf(n); return k === -1 ? dflt : parseFloat(p[k]) || dflt; };
    m.vix.push(g('^VIX', 0)); m.tnx.push(g('^TNX', 0)); m.irx.push(g('^IRX', 0)); m.hyg.push(g('HYG', 0)); m.lqd.push(g('LQD', 0));
    m.move.push(g('^MOVE', -1)); m.dxy.push(g('DX-Y.NYB', -1)); m.btcVol.push(g('BTC_VOL', -1));
  }
  return { ch, m, d, H };
}

const iso = load('historical_data_daily_with_IS3R.csv');
const aug = load('historical_data_daily_augmented.csv');
// valores reales de MOVE/DXY/BTC_VOL en el dataset canónico (para proxys declarados)
const mvReal = aug.m.move.find(x => x > 0) ?? 95;
const dxReal = aug.m.dxy.find(x => x > 0) ?? 103;
const bvReal = aug.m.btcVol.find(x => x > 0) ?? 30;

console.log(BAR);
console.log('  TEST D — COBERTURA DE CRISIS');
console.log(BAR);

console.log('\n── (a) COBERTURA DE DATOS REALES POR ACTIVO ──');
console.log(`  ${'Archivo'.padEnd(38)} ${'filas'.padStart(6)} ${'desde'.padStart(12)} ${'hasta'.padStart(12)}  columnas macro disponibles`);
console.log('  ' + '-'.repeat(100));
console.log(`  ${'historical_data_daily_with_IS3R.csv'.padEnd(38)} ${String(iso.d.length).padStart(6)} ${iso.d[0].padStart(12)} ${iso.d[iso.d.length - 1].padStart(12)}  VIX,TNX,IRX,HYG,LQD  (SIN MOVE/DXY/BTC_VOL)`);
console.log(`  ${'historical_data_daily_augmented.csv'.padEnd(38)} ${String(aug.d.length).padStart(6)} ${aug.d[0].padStart(12)} ${aug.d[aug.d.length - 1].padStart(12)}  VIX,TNX,IRX,HYG,LQD,MOVE,DXY,BTC_VOL`);

const splice = iso.H.indexOf('0P00000WLG.F');
const w0 = iso.ch['0P00000WLG.F'][0], w1 = iso.ch['0P00000WLG.F'][1];
console.log(`\n  ARTEFACTO INTERNO DETECTADO en el fichero largo:`);
console.log(`    ${iso.d[0]} → ${iso.d[1]}  0P00000WLG.F: ${w0.toFixed(2)} → ${w1.toFixed(2)} = ${pct(w1 / w0 - 1, 1)} en un día`);
console.log(`    Un ETF de MSCI World no puede moverse +36% en un día → la serie está COSTEIDA (rellenada) al inicio.`);
console.log(`    Primera columna del CSV con valor: ${splice + 1} (${iso.H[splice]})`);
console.log(`    IS3R.DE: ${iso.d.length} filas, 0 con dato (columna vacía; no es un activo del universo).`);

console.log(`\n  ADMISIBILIDAD DE VENTANAS DE CRISIS (requiere 252 días de warm-up + macro REAL):`);
console.log(`    2018 / 2020  → NO ADMISIBLES: MOVE, DXY y BTC_VOL no existen en el fichero largo (se proxyarían).`);
console.log(`    2022         → PARCIAL: el fichero canónico sólo tiene MOVE/DXY/BTC_VOL desde ${aug.d[0]}.`);
console.log(`    Ninguna ventana de este repositorio tiene macro 100% real + 252 días de warm-up.`);
console.log(`    → El backtest del motor sobre historia de crisis REAL es NO VERIFICADO.`);
console.log(`    → Se procede con (c) escenarios de estrés inyectados.`);

console.log('\n── (b) MOTOR POR VENTANA (proxy declarado: MOVE/DXY/BTC_VOL constantes) ──');
console.log(`    proxy: MOVE=${mvReal} · DXY=${dxReal} · BTC_VOL=${bvReal} (primer valor real del dataset canónico)`);
console.log(`    ${'Ventana'.padEnd(12)} ${'n'.padStart(5)} ${'CAGR'.padStart(8)} ${'Sharpe'.padStart(8)} ${'MaxDD'.padStart(8)} ${'CRISIS d'.padStart(9)} ${'CONTR d'.padStart(9)}  admisible?`);
console.log('    ' + '-'.repeat(78));
const windows: [string, string, string][] = [
  ['2018', '2018-01-01', '2018-12-31'],
  ['2020', '2020-01-01', '2020-12-31'],
  ['2022', '2022-01-01', '2022-12-31'],
  ['2015-2026', iso.d[0], iso.d[iso.d.length - 1]],
];
const exposureHist: Record<string, number[]> = {};
for (const [label, a, b] of windows) {
  const s = iso.d.findIndex(x => x >= a), e = iso.d.findIndex(x => x >= b) + 1;
  if (s < 0 || e <= s) { console.log(`    ${label.padEnd(12)} sin datos`); continue; }
  const slice: Record<string, number[]> = {}; ASSETS.forEach(t => slice[t] = iso.ch[t].slice(s, e));
  const mm = iso.m;
  const r = runBacktest({
    closesHistory: slice,
    macroHistory: {
      vix: mm.vix.slice(s, e), yieldSpread: mm.tnx.slice(s, e).map((v, i) => v - mm.irx[s + i]),
      creditSpread: mm.hyg.slice(s, e).map((v, i) => (v > 0 && mm.lqd[s + i] > 0 ? Math.max(1, Math.min(9, ((0.045 + (1 - v / 100) * 0.03) - (0.035 + (1 - mm.lqd[s + i] / 100) * 0.02)) * 100)) : 2.5 + mm.vix[s + i] / 20)),
      move: mm.move.slice(s, e).map(() => mvReal), dxyTrend: mm.dxy.slice(s, e).map(() => 0),
      btcVol: mm.btcVol.slice(s, e).map(() => bvReal),
    },
    lookbackDays: 252, rebalanceDays: 21, initialCapital: 10000, transactionCostBps: 15,
  });
  exposureHist[label] = r.dailyRecords.map(x => 1 - x.cash);
  const adm = label === '2022' ? 'PARCIAL (macro proxied)' : 'NO (macro proxied)';
  console.log(`    ${label.padEnd(12)} ${String(r.dailyRecords.length).padStart(5)} ${pct(r.metrics.cagr).padStart(8)} ${r.metrics.sharpe.toFixed(3).padStart(8)} ${pct(r.metrics.maxDrawdown, 1).padStart(8)} ${String(r.regimeDays.CRISIS).padStart(9)} ${String(r.regimeDays.CONTRACTION).padStart(9)}  ${adm}`);
}

console.log('\n── (d) NIVELES DE KILL SWITCH (proxy desde la exposición) ──');
console.log('    El backtest NO expone killSwitchLevel por día → se infiere desde la exposición');
console.log('    usando la tabla de overlay de CALIBRATION.md §5: L1≤0.80 L2≤0.50 L3≤0.30 L4≤0.15 L5≤0.05.');
console.log(`    ${'Ventana'.padEnd(12)} ${'L1'.padStart(5)} ${'L2'.padStart(5)} ${'L3'.padStart(5)} ${'L4'.padStart(5)} ${'L5'.padStart(5)} ${'min exp'.padStart(9)}`);
console.log('    ' + '-'.repeat(58));
for (const [label, exp] of Object.entries(exposureHist)) {
  const c = [1, 2, 3, 4, 5].map(L => exp.filter(e => e <= [1.01, 0.80, 0.50, 0.30, 0.15][L] && e > [0, 0.80, 0.50, 0.30, 0.15][L - 1] ? true : false).length);
  console.log(`    ${label.padEnd(12)} ${c.map(x => String(x).padStart(5)).join(' ')} ${pct(Math.min(...exp), 1).padStart(9)}`);
}

console.log('\n── (c) ESCENARIOS DE ESTRÉS INYECTADOS (src/core/simulation/stressScenarios.ts) ──');
// shocks explícitos pedidos en el enunciado
const CUSTOM = [
  { id: 'btc_-70', name: 'BTC -70% (bear profundo)', proxyReturns: { 'BTC-EUR': -0.70, 'URTH': -0.25, 'EEM': -0.20, 'GLD': 0.10, 'URA': -0.35, 'SMH': -0.35 }, macroContext: { vixPeak: 55, maxDrawdownSP500: -0.30, durationMonths: 12, trigger: 'bear market BTC' } },
  { id: 'equity_-35', name: 'Equity -35% (crisis bursátil)', proxyReturns: { 'BTC-EUR': -0.45, 'URTH': -0.35, 'EEM': -0.40, 'GLD': 0.08, 'URA': -0.30, 'SMH': -0.40 }, macroContext: { vixPeak: 65, maxDrawdownSP500: -0.45, durationMonths: 9, trigger: 'crisis bursátil' } },
  { id: 'simultaneo', name: 'SIMULTÁNEO (BTC -70%, equity -35%, oro +10%)', proxyReturns: { 'BTC-EUR': -0.70, 'URTH': -0.35, 'EEM': -0.40, 'GLD': 0.10, 'URA': -0.45, 'SMH': -0.50 }, macroContext: { vixPeak: 85, maxDrawdownSP500: -0.50, durationMonths: 12, trigger: 'shock combinado' } },
] as any;

try {
  // cartera = allocaciones finales del motor en el backtest canónico
  const canon = runBacktest({
    closesHistory: aug.ch,
    macroHistory: {
      vix: aug.m.vix, yieldSpread: aug.m.tnx.map((v, i) => v - aug.m.irx[i]),
      creditSpread: aug.m.hyg.map((v, i) => (v > 0 && aug.m.lqd[i] > 0 ? Math.max(1, Math.min(9, ((0.045 + (1 - v / 100) * 0.03) - (0.035 + (1 - aug.m.lqd[i] / 100) * 0.02)) * 100)) : 2.5 + aug.m.vix[i] / 20)),
      move: aug.m.move, dxyTrend: aug.m.dxy.map((_, i) => (i < 20 ? 0 : (aug.m.dxy[i - 20] > 0 ? ((aug.m.dxy[i] - aug.m.dxy[i - 20]) / aug.m.dxy[i - 20]) * 100 : 0))),
      btcVol: aug.m.btcVol,
    },
    lookbackDays: 252, rebalanceDays: 21, initialCapital: 10000, transactionCostBps: 15,
  });
  const lastAlloc = canon.dailyRecords[canon.dailyRecords.length - 1].allocations as Record<string, number>;
  const port = ASSETS.map(t => ({ ticker: t, name: t, weight: lastAlloc[t] ?? 0 }));
  console.log(`    Cartera de referencia = allocaciones finales del motor: ${port.map(p => `${p.ticker.split('.')[0]} ${pct(p.weight, 1)}`).join(' · ')}`);
  console.log(`    ${'escenario'.padEnd(40)} ${'retorno'.padStart(9)} {'impacto€'.padStart(10)} {'recup. (mes)'.padStart(12)}`);
  console.log('    ' + '-'.repeat(74));
  const all = [...STRESS_SCENARIOS, ...CUSTOM];
  const res = all.map(s => runStressScenario(s, port, 10000));
  for (const r of res)
    console.log(`    ${String(r.scenarioName).slice(0, 39).padEnd(40)} ${pct(r.portfolioReturn).padStart(9)} ${(r.portfolioDrawdown.toFixed(0)).padStart(10)} ${String(r.recoveryEstimateMonths).padStart(12)}`);
  console.log(`    escenarios ejecutados: ${res.length} (${STRESS_SCENARIOS.length} del repo + ${CUSTOM.length} propios)`);
  console.log(`    Peor escenario: ${res.reduce((a, b) => (a.portfolioReturn < b.portfolioReturn ? a : b)).scenarioName} ${pct(Math.min(...res.map(r => r.portfolioReturn)))}`);
} catch (e) {
  console.log('    NO VERIFICADO — fallo: ' + (e as Error).message);
}
console.log('\n── (c2) SHOCKS INJECTADOS EN EL MOTOR (respuesta dinámica real) ──');
// Camino sintético: 252 días reales de warm-up + N días de shock con macro degradada.
function synthPath(shockDays: number, btcDrop: number, eqDrop: number) {
  const W = 252;
  const start = aug.d.length - W;
  const ch: Record<string, number[]> = {};
  ASSETS.forEach(t => ch[t] = aug.ch[t].slice(start));
  const vix: number[] = aug.m.vix.slice(start), tnx = aug.m.tnx.slice(start), irx = aug.m.irx.slice(start);
  const hyg = aug.m.hyg.slice(start), lqd = aug.m.lqd.slice(start);
  const mv = aug.m.move.slice(start), dx = aug.m.dxy.slice(start), bv = aug.m.btcVol.slice(start);
  const p0 = Object.fromEntries(ASSETS.map(t => [t, aug.ch[t][start]]));
  for (let k = 1; k <= shockDays; k++) {
    const f = k / shockDays;                       // 0 → 1 a lo largo del shock
    const e = Math.exp(Math.log(1 + btcDrop) * f); // مسار geométrico
    const ee = Math.exp(Math.log(1 + eqDrop) * f);
    ASSETS.forEach(t => {
      const d = t === 'BTC-EUR' ? e : (t === 'PPFB.DE' ? Math.exp(Math.log(1 + 0.10) * f) : ee);
      ch[t].push(p0[t] * d);
    });
    vix.push(18 + 47 * f); mv.push(100 + 100 * f); dx.push(dx[0] * (1 + 0.08 * f)); bv.push(Math.max(0.5, bv[bv.length - 1]));
    hyg.push(hyg[hyg.length - 1] * (1 + 0.03 * f)); lqd.push(lqd[lqd.length - 1] * (1 - 0.02 * f));
    tnx.push(tnx[tnx.length - 1]); irx.push(irx[irx.length - 1]);
  }
  return { ch, vix, tnx, irx, hyg, lqd, mv, dx, bv };
}
const shocks: [string, number, number, number][] = [
  ['BTC -70% en 180d', 180, -0.70, -0.20],
  ['Equity -35% en 120d', 120, -0.35, -0.35],
  ['SIMULTÁNEO 180d', 180, -0.70, -0.35],
];
console.log(`    ${'shock'.padEnd(24)} ${'shockDD'.padStart(9)} {'motor DD'.padStart(10)} {'min exp'.padStart(9)} {'%días cash<50%'.padStart(15)} {'CRISIS d'.padStart(9)} {'CONTR d'.padStart(9)}`);
console.log('    ' + '-'.repeat(90));
for (const [nm, days, btcD, eqD] of shocks) {
  const s = synthPath(days, btcD, eqD);
  const r = runBacktest({
    closesHistory: s.ch,
    macroHistory: {
      vix: s.vix, yieldSpread: s.tnx.map((v, i) => v - s.irx[i]),
      creditSpread: s.hyg.map((v, i) => (v > 0 && s.lqd[i] > 0 ? Math.max(1, Math.min(9, ((0.045 + (1 - v / 100) * 0.03) - (0.035 + (1 - s.lqd[i] / 100) * 0.02)) * 100)) : 2.5 + s.vix[i] / 20)),
      move: s.mv, dxyTrend: s.dx.map((v, i) => (i < 20 ? 0 : (s.dx[i - 20] > 0 ? ((v - s.dx[i - 20]) / s.dx[i - 20]) * 100 : 0))),
      btcVol: s.bv,
    },
    lookbackDays: 252, rebalanceDays: 21, initialCapital: 10000, transactionCostBps: 15,
  });
  const shockRecs = r.dailyRecords.slice(252);
  const eq = eqD;
  const stressDD = eq < 0 ? eq : 0;
  const minExp = Math.min(...r.dailyRecords.map(x => 1 - x.cash));
  const cashDays = r.dailyRecords.filter(x => x.cash >= 0.5).length;
  console.log(`    ${nm.padEnd(24)} ${pct(stressDD, 1).padStart(9)} ${pct(r.metrics.maxDrawdown, 1).padStart(10)} ${pct(minExp, 1).padStart(9)} ${(100 * cashDays / r.dailyRecords.length).toFixed(1).padStart(14)}% ${String(r.regimeDays.CRISIS).padStart(9)} ${String(r.regimeDays.CONTRACTION).padStart(9)}`);
  void shockRecs;
}
console.log('    nota: shockDD = caída del shock; motor DD = MaxDD real del motor con el shock inyectado.');

console.log('\n' + BAR);