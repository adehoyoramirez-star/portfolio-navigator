// ============================================================
// scripts/validation/fase2c_test1.ts
// FASE 2C · TEST 1 — ABLACIÓN HOLDOUT (V1-V6 congeladas, sin variantes nuevas).
//   Dataset LARGO validado (2017-07 → 2026-10). Ventanas HOLDOUT/VISTA/FULL + crisis.
//   Criterios congelados: PREREGISTRO_2C.md §3.
// Ejecutar: npx tsx scripts/validation/fase2c_test1.ts
// ============================================================

import { loadLongDataset, validate } from './data_long';
import { runEngine, shadowSim, deriveMacro, CFG, pct } from './sim_core';
import { full, slice, bootstrapDeltaSharpe, WINDOWS, type WindowKey } from './metrics_unified';
import { computeHRP } from '../../src/core/risk/hrp';
import { computeVolTargetMultiplier } from '../../src/core/risk/volatilityTarget';
import { computeTailRiskOverlay } from '../../src/core/risk/tailRisk';
import { ASSETS } from '../../src/lib/constants';

(async () => {
  const ds = await loadLongDataset();
  const v = validate(ds);
  console.log('='.repeat(126));
  console.log('  TEST 1 — ABLACIÓN HOLDOUT (V1-V6 congeladas · harness común €10k, 21d, costes reales)');
  console.log('='.repeat(126));
  console.log(`  Dataset largo: ${ds.dates.length} filas · ${ds.dates[0]} → ${ds.dates[ds.dates.length - 1]} · gate: ${v.valid ? 'VÁLIDO' : 'INVÁLIDO'}`);
  if (!v.valid) { console.log('  NO VÁLIDO → TEST 1 = NO VERIFICADO.'); return; }

  const R = runEngine(ds);
  const { closes } = ds;
  const N = ASSETS.length;
  const REC = R.recs.length;
  const { creditSpread } = deriveMacro(ds);
  console.log(`  Warm-up 252d → primera evaluación ${R.dates[0]} · ${REC} días de estrategia`);

  function retWindow(a: string, di: number, w: number): number[] {
    const r: number[] = [];
    for (let i = Math.max(1, di - w + 1); i <= di; i++) r.push(closes[a][i] / closes[a][i - 1] - 1);
    return r;
  }
  function covAt(di: number, w: number): number[][] {
    const rs = ASSETS.map(a => retWindow(a, di, w));
    const m = rs[0].length;
    const means = rs.map(x => x.reduce((s, q) => s + q, 0) / m);
    const C: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { let s = 0; for (let k = 0; k < m; k++) s += (rs[i][k] - means[i]) * (rs[j][k] - means[j]); C[i][j] = s / m; }
    return C;
  }
  function portVolAt(weights: number[], di: number, w: number): number {
    const C = covAt(di, w); let s = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) s += weights[i] * weights[j] * C[i][j];
    return Math.sqrt(Math.max(0, s) * CFG.dpy);
  }
  const mkTarget = (w: number[], mult = 1): Record<string, number> => { const t: Record<string, number> = {}; ASSETS.forEach((a, i) => t[a] = w[i] * mult); return t; };

  // ── V1 / V2 / V3 / V4 targets ──
  const t1: Record<string, number>[] = new Array(REC).fill(0).map(() => mkTarget(new Array(N).fill(1 / N)));
  const hrp0 = computeHRP(covAt(CFG.lookbackDays, 252), N).weights;
  const t2: Record<string, number>[] = new Array(REC).fill(0).map(() => mkTarget(hrp0));
  const t3: Record<string, number>[] = []; const t4: Record<string, number>[] = [];
  let idx4 = 1, peak4 = 1;
  let cur3: Record<string, number> | null = null, cur4: Record<string, number> | null = null;
  for (let k = 0; k < REC; k++) {
    const di = CFG.lookbackDays + k;
    if (k % 21 === 0) {
      const w = computeHRP(covAt(di, 252), N).weights;
      const vt = computeVolTargetMultiplier({ targetVol: 0.20, realizedVol: portVolAt(w, di, 63), regimePenalty: 1.0 }).multiplier;
      cur3 = mkTarget(w, vt);
      const dd4 = idx4 / peak4 - 1;
      const tr = computeTailRiskOverlay({ drawdown: dd4, vix: ds.macro.vix[di], creditSpread: creditSpread[di], stressScore: 0, portfolioVolatility: portVolAt(w, di, 63), avgCorrelation: 0 });
      cur4 = mkTarget(w, vt * tr.overlay);
    }
    t3.push({ ...cur3! }); t4.push({ ...cur4! });
    if (k > 0) {
      const r = ASSETS.reduce((s, a) => s + (t4[k][a] ?? 0) * (closes[a][di] / closes[a][di - 1] - 1), 0);
      idx4 *= (1 + r); if (idx4 > peak4) peak4 = idx4;
    }
  }

  const s1 = shadowSim(ds, t1), s2 = shadowSim(ds, t2), s3 = shadowSim(ds, t3), s4 = shadowSim(ds, t4);
  const s5p = shadowSim(ds, R.recs.map(r => r.allocations as Record<string, number>));
  const s6 = shadowSim(ds, t1, { rebalanceEvery: 1_000_000_000 });

  const variants: [string, number[], string[], number][] = [
    ['V1 equal-weight', s1.twr, s1.dates, s1.costs],
    ['V2 HRP estático', s2.twr, s2.dates, s2.costs],
    ['V3 HRP+volTarget', s3.twr, s3.dates, s3.costs],
    ['V4 V3+tailRisk/KS', s4.twr, s4.dates, s4.costs],
    ['V5 MOTOR', R.twr, R.dates, 0],
    ["V5' shadow del motor", s5p.twr, s5p.dates, s5p.costs],
    ['V6 B&H equal (costes)', s6.twr, s6.dates, s6.costs],
  ];

  const KEYS: WindowKey[] = ['HOLDOUT', 'VISTA', 'FULL'];
  console.log(`\n  ${'Variante'.padEnd(22)} ${'HO shut'.padStart(9)} ${'HO Cad'.padStart(8)} ${'HO MxDD'.padStart(9)} ${'VI shut'.padStart(9)} ${'VI Cad'.padStart(8)} ${'VI MxDD'.padStart(9)} ${'FU shut'.padStart(9)} ${'FU Cad'.padStart(8)} ${'FU MxDD'.padStart(9)} ${'FU CVaR'.padStart(8)} ${'Costes'.padStart(8)}`);
  console.log('  ' + '-'.repeat(126));
  const win: Record<string, Record<WindowKey, { sharpe: number; cagr: number; maxDD: number; cvar95: number } | null>> = {};
  for (const [name, twr, dt, c] of variants) {
    const per: any = {};
    const cells: string[] = [];
    for (const K of KEYS) {
      const [f, t] = WINDOWS[K]; const r = slice(twr, dt, f, t);
      per[K] = r ? { sharpe: r.m.sharpe, cagr: r.m.cagr, maxDD: r.m.maxDD, cvar95: r.m.cvar95 } : null;
      cells.push(r ? r.m.sharpe.toFixed(3).padStart(9) : '   n/a'.padStart(9));
      cells.push(r ? pct(r.m.cagr).padStart(8) : '   n/a'.padStart(8));
      cells.push(r ? pct(r.m.maxDD, 1).padStart(9) : '   n/a'.padStart(9));
    }
    const fu = per.FULL;
    console.log(`  ${name.padEnd(22)} ${cells.join(' ')} ${pct(fu.cvar95).padStart(8)} ${('€' + c.toFixed(0)).padStart(8)}`);
    win[name] = per;
  }

  console.log(`\n── VENTANAS DE CRISIS (Sharpe / CAGR / MaxDD) ──`);
  for (const K of ['Q4_2018', 'COVID', 'Y2022'] as WindowKey[]) {
    const [f, t] = WINDOWS[K];
    const parts = variants.map(([name, twr, dt]) => { const r = slice(twr, dt, f, t); return `${name.split(' ')[0]}: ${r ? r.m.sharpe.toFixed(2) : 'n/a'}/${r ? pct(r.m.cagr, 0) : 'n/a'}/${r ? pct(r.m.maxDD, 0) : 'n/a'}`; });
    console.log(`  ${K.padEnd(9)} (${f}→${t})`);
    console.log('    ' + parts.join('  ·  '));
  }

  // ── Criterios congelados §3 ──
  const v3 = win['V3 HRP+volTarget'], v5 = win['V5 MOTOR'];
  const r3full = s3.twr, r5full = R.twr;
  const dFull = bootstrapDeltaSharpe(r3full, r5full);           // V3 − Motor (FULL)
  const hoStart = (dt: string[]) => dt.findIndex((d, i) => i > 0 && d >= WINDOWS.HOLDOUT[0]) - 1;
  const hoEnd = (dt: string[]) => dt.findIndex((d, i) => i > 0 && d > WINDOWS.HOLDOUT[1]) - 1;
  const sliceR = (twr: number[], dt: string[]) => twr.slice(hoStart(dt), hoEnd(dt) < 0 ? twr.length : hoEnd(dt));
  const r3ho = sliceR(s3.twr, s3.dates), r5ho = sliceR(R.twr, R.dates);
  const dHoMotorMinusV3 = bootstrapDeltaSharpe(r5ho, r3ho);     // Motor − V3 (HOLDOUT)

  const c1 = v3.HOLDOUT!.sharpe >= v5.HOLDOUT!.sharpe;
  const c2 = v3.HOLDOUT!.maxDD >= v5.HOLDOUT!.maxDD - 0.02;
  const c3 = dFull.lo >= -0.20;                                  // sin pérdida relevante (>−0.20)
  const v3Confirmed = c1 && c2 && c3;
  const m1 = v5.HOLDOUT!.sharpe > v3.HOLDOUT!.sharpe;
  const m2 = v5.HOLDOUT!.maxDD > v3.HOLDOUT!.maxDD;
  const m3 = dHoMotorMinusV3.lo > 0;
  const motorJustified = m1 && m2 && m3;
  const v3Vista = v3.VISTA!.sharpe >= v5.VISTA!.sharpe;

  console.log(`\n── CRITERIOS PREREGISTRADOS (§3) ──`);
  console.log(`  HOLDOUT  V3 Sharpe ${v3.HOLDOUT!.sharpe.toFixed(3)} vs Motor ${v5.HOLDOUT!.sharpe.toFixed(3)} → ${c1 ? 'CUMPLE' : 'NO CUMPLE'}`);
  console.log(`  HOLDOUT  V3 MaxDD  ${pct(v3.HOLDOUT!.maxDD, 1)} vs Motor ${pct(v5.HOLDOUT!.maxDD, 1)} (tolerancia 2pp) → ${c2 ? 'CUMPLE' : 'NO CUMPLE'}`);
  console.log(`  FULL     ΔSharpe (V3−Motor) IC95 [${dFull.lo.toFixed(3)}, ${dFull.hi.toFixed(3)}] mediana ${dFull.median.toFixed(3)} → ${c3 ? 'sin pérdida relevante (≥−0.20)' : 'PÉRDIDA RELEVANTE'}`);
  console.log(`  → V3 ${v3Confirmed ? 'CONFIRMADA' : 'NO CONFIRMADA'} fuera de muestra.`);
  console.log(`\n  Motor vs V3 (HOLDOUT): Sharpe ${m1 ? 'sí' : 'no'} supera · MaxDD ${m2 ? 'sí' : 'no'} supera · IC95 ΔSharpe (Motor−V3) [${dHoMotorMinusV3.lo.toFixed(3)}, ${dHoMotorMinusV3.hi.toFixed(3)}] ${m3 ? 'excluye 0' : 'incluye 0'}`);
  console.log(`  → Motor completo ${motorJustified ? 'JUSTIFICADO' : 'NO JUSTIFICADO'} frente a V3.`);
  console.log(`\n  VISTA: V3 Sharpe ${v3.VISTA!.sharpe.toFixed(3)} vs Motor ${v5.VISTA!.sharpe.toFixed(3)} → V3 ${v3Vista ? 'gana' : 'pierde'} en VISTA.`);
  const veredicto = motorJustified ? 'MOTOR JUSTIFICADO' : v3Confirmed ? 'SIMPLIFICAR A V3 (confirmada fuera de muestra)' : (v3Vista && !c1) ? 'INCONCLUSO (V3 gana en VISTA pero no en HOLDOUT)' : 'INCONCLUSO / NO DEMOSTRADO';
  console.log(`\n  VEREDICTO TEST 1: ${veredicto}`);
})();
