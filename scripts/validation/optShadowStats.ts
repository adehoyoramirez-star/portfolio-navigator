// ============================================================
// scripts/validation/optShadowStats.ts
// OPT-SHADOW v1.0.0 — estadística PURA del backtest en histórico largo.
// Especificación: scripts/validation/PREREGISTRO_OPCIONES_SOMBRA.md §5 (congelada).
// Sin red, sin disco, sin reloj: mismo input → mismo output (semilla fija).
// ============================================================

import {
  computeOptionsShadowRow,
  type OptionsShadowRow,
  type ShadowSeries,
} from "../../src/core/risk/optionsVolShadow";

// ── Constantes congeladas (preregistro §5) ───────────────────────────────
export const BT_SPEC = Object.freeze({
  horizon: 20,            // jornadas hacia delante del evento E
  eventThreshold: -0.07,  // E: min retorno forward <= -7%
  l1Threshold: 0.12,      // cruce de L1 (TAIL_RISK_CONFIG.KILL_SWITCH.L1.threshold)
  leadLookback: 20,       // ventana previa al cruce para buscar CONFIRM
  vixLevelCut: 25,        // A2: VIX en nivel < 25
  liftMin: 1.5,           // A1/A2: elevación mínima
  falsePositiveMax: 0.6,  // A3
  minEpisodes: 5,         // guardia de potencia
  bootstrapBlock: 20,
  bootstrapReps: 2000,
  seed: 20261016,
  ciPrimary: 0.95,
  ciExploratory: 0.99,    // Bonferroni: α = 0,05 / 5
});

// ── Utilidades ───────────────────────────────────────────────────────────
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** E en t: min_{k=1..horizon}(S_{t+k}/S_t − 1) <= thr. null si no evaluable. */
export function forwardEvent(
  closes: Array<number | null>,
  t: number,
  horizon: number,
  thr: number,
): boolean | null {
  const s0 = closes[t];
  if (typeof s0 !== "number" || !(s0 > 0)) return null;
  if (t + horizon > closes.length - 1) return null;
  let min = Infinity;
  for (let k = 1; k <= horizon; k++) {
    const v = closes[t + k];
    if (typeof v !== "number" || !(v > 0)) return null;
    min = Math.min(min, v / s0 - 1);
  }
  return min <= thr;
}

/** Índices donde empieza una racha de `true`. */
export function runStarts(flags: boolean[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < flags.length; i++) if (flags[i] && (i === 0 || !flags[i - 1])) out.push(i);
  return out;
}

/**
 * Cruces de drawdown >= threshold desde el último máximo. Se rearma solo con un nuevo máximo.
 * Devuelve los índices de cruce.
 */
export function drawdownCrossings(values: number[], threshold: number): number[] {
  const out: number[] = [];
  let peak = -Infinity;
  let armed = true;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(v > 0)) continue;
    if (v >= peak) {
      peak = v;
      armed = true;
    }
    if (armed && 1 - v / peak >= threshold) {
      out.push(i);
      armed = false;
    }
  }
  return out;
}

/**
 * Adelanto de un cruce (en filas): primer CONFIRM en [cross-lookback, cross].
 * 0 si no hay aviso ("sin aviso").
 */
export function leadRows(crossRow: number, confirmRows: Set<number>, lookback: number): { lead: number; warned: boolean } {
  for (let r = Math.max(0, crossRow - lookback); r <= crossRow; r++) {
    if (confirmRows.has(r)) return { lead: crossRow - r, warned: true };
  }
  return { lead: 0, warned: false };
}

// ── Bootstrap por bloques de la elevación (lift) ─────────────────────────
export interface LiftResult {
  nBase: number;          // días en la base (máscara)
  nState: number;         // días en el estado dentro de la base
  pBase: number | null;   // P(E | base)
  pState: number | null;  // P(E | estado ∧ base)
  lift: number | null;
  lo: number | null;
  hi: number | null;
  replicatesUsed: number;
  replicatesSkipped: number;
}

function liftOf(
  state: boolean[], e: boolean[], mask: boolean[], idx: ArrayLike<number>, n: number,
): { lift: number; ok: true } | { ok: false } {
  let nb = 0, eb = 0, ns = 0, es = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    if (!mask[i]) continue;
    nb++;
    if (e[i]) eb++;
    if (state[i]) {
      ns++;
      if (e[i]) es++;
    }
  }
  if (nb === 0 || ns === 0 || eb === 0) return { ok: false };
  return { ok: true, lift: es / ns / (eb / nb) };
}

/** Elevación P(E | state ∧ mask) / P(E | mask) con IC por bootstrap de bloques móviles. */
export function blockBootstrapLift(
  state: boolean[],
  e: boolean[],
  mask: boolean[] | null,
  opts: { reps: number; block: number; seed: number; ci: number },
): LiftResult {
  const n = state.length;
  if (e.length !== n || (mask && mask.length !== n)) throw new Error("longitudes desalineadas");
  const m = mask ?? new Array<boolean>(n).fill(true);

  let nb = 0, eb = 0, ns = 0, es = 0;
  for (let i = 0; i < n; i++) {
    if (!m[i]) continue;
    nb++;
    if (e[i]) eb++;
    if (state[i]) {
      ns++;
      if (e[i]) es++;
    }
  }
  const res: LiftResult = {
    nBase: nb, nState: ns,
    pBase: nb ? eb / nb : null,
    pState: ns ? es / ns : null,
    lift: ns && eb ? es / ns / (eb / nb) : null,
    lo: null, hi: null, replicatesUsed: 0, replicatesSkipped: 0,
  };
  if (res.lift === null || n < opts.block) return res;

  const rnd = lcg(opts.seed);
  const idx = new Int32Array(n);
  const lifts: number[] = [];
  for (let r = 0; r < opts.reps; r++) {
    let k = 0;
    while (k < n) {
      const start = Math.floor(rnd() * (n - opts.block + 1));
      for (let j = 0; j < opts.block && k < n; j++) idx[k++] = start + j;
    }
    const out = liftOf(state, e, m, idx, n);
    if (out.ok) lifts.push(out.lift);
    else res.replicatesSkipped++;
  }
  res.replicatesUsed = lifts.length;
  if (lifts.length >= 50) {
    lifts.sort((a, b) => a - b);
    const alpha = 1 - opts.ci;
    res.lo = lifts[Math.floor((alpha / 2) * lifts.length)];
    res.hi = lifts[Math.min(lifts.length - 1, Math.floor((1 - alpha / 2) * lifts.length))];
  }
  return res;
}

// ── Orquestación ─────────────────────────────────────────────────────────
export type Verdict = "PASA" | "FALLA" | "NO_CONCLUYENTE";

export interface EngineCurve {
  dates: string[];
  values: number[];
}

export interface BacktestResult {
  sample: {
    firstDate: string | null; lastDate: string | null;
    rows: number; evaluable: number;
    stateShare: Record<string, number>;
    confirmDays: number; confirmEpisodes: number;
    baseRateE: number | null;
  };
  a1: LiftResult & { verdict: Verdict };
  a2: LiftResult & { verdict: Verdict };
  a3: { episodes: number; falsePositives: number; rate: number | null; verdict: Verdict };
  a4: {
    crossings: Array<{ date: string; warned: boolean; lead: number }>;
    medianLead: number | null; n: number; descriptiveOnly: boolean; verdict: Verdict;
  };
  exploratory: Record<string, LiftResult>;
  kill: { K1: boolean; K2: boolean };
}

function liftVerdict(r: LiftResult, episodes: number): Verdict {
  if (episodes < BT_SPEC.minEpisodes) return "NO_CONCLUYENTE";
  if (r.lift === null || r.lo === null) return "NO_CONCLUYENTE";
  return r.lift >= BT_SPEC.liftMin && r.lo > 1.0 ? "PASA" : "FALLA";
}

export function evaluateOptShadow(series: ShadowSeries, engine?: EngineCurve): BacktestResult {
  const n = series.dates.length;
  const rows: OptionsShadowRow[] = [];
  for (let i = 0; i < n; i++) rows.push(computeOptionsShadowRow(series, i));

  const valid = (r: OptionsShadowRow) =>
    r.eqState === "CALM" || r.eqState === "WATCH" || r.eqState === "CONFIRM";

  // Muestra evaluable: fila válida y E calculable.
  const evalIdx: number[] = [];
  const eArr: boolean[] = [];
  for (let i = 0; i < n; i++) {
    if (!valid(rows[i])) continue;
    const ev = forwardEvent(series.spx, i, BT_SPEC.horizon, BT_SPEC.eventThreshold);
    if (ev === null) continue;
    evalIdx.push(i);
    eArr.push(ev);
  }
  const at = <T>(f: (r: OptionsShadowRow) => T) => evalIdx.map((i) => f(rows[i]));
  const isConfirm = at((r) => r.eqState === "CONFIRM");
  const vixLow = at((r) => (r.vix as number) < BT_SPEC.vixLevelCut);
  const opts = (ci: number) => ({
    reps: BT_SPEC.bootstrapReps, block: BT_SPEC.bootstrapBlock, seed: BT_SPEC.seed, ci,
  });

  // Episodios CONFIRM sobre TODAS las filas (consecutivas por índice de fila).
  const confirmRowFlags = rows.map((r) => r.eqState === "CONFIRM");
  const starts = runStarts(confirmRowFlags);
  const confirmRows = new Set<number>();
  confirmRowFlags.forEach((f, i) => { if (f) confirmRows.add(i); });

  // A1 / A2
  const a1r = blockBootstrapLift(isConfirm, eArr, null, opts(BT_SPEC.ciPrimary));
  const a2r = blockBootstrapLift(isConfirm, eArr, vixLow, opts(BT_SPEC.ciPrimary));

  // A3: falsos positivos por episodio (E en el primer día del episodio)
  let evaluableEpisodes = 0, falsePos = 0;
  for (const s of starts) {
    const ev = forwardEvent(series.spx, s, BT_SPEC.horizon, BT_SPEC.eventThreshold);
    if (ev === null) continue;
    evaluableEpisodes++;
    if (!ev) falsePos++;
  }
  const fpRate = evaluableEpisodes ? falsePos / evaluableEpisodes : null;
  const a3Verdict: Verdict =
    starts.length < BT_SPEC.minEpisodes || fpRate === null
      ? "NO_CONCLUYENTE"
      : fpRate <= BT_SPEC.falsePositiveMax ? "PASA" : "FALLA";

  // A4: adelanto frente al cruce de L1
  const crossings: BacktestResult["a4"]["crossings"] = [];
  if (engine) {
    const cross = drawdownCrossings(engine.values, BT_SPEC.l1Threshold);
    for (const c of cross) {
      const d = engine.dates[c];
      if (d > series.dates[n - 1]) continue; // cruce posterior al fin de la serie: no evaluable
      // última fila de la serie con fecha <= d
      let lo = 0, hi = n - 1, row = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (series.dates[mid] <= d) { row = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (row < 0) continue;
      const { lead, warned } = leadRows(row, confirmRows, BT_SPEC.leadLookback);
      crossings.push({ date: d, warned, lead });
    }
  }
  const medLead = median(crossings.map((c) => c.lead));
  const a4Desc = crossings.length < BT_SPEC.minEpisodes;
  const a4Verdict: Verdict =
    medLead === null || a4Desc ? "NO_CONCLUYENTE" : medLead > 0 ? "PASA" : "FALLA";

  // Exploratorio: flags individuales (IC99) y CONFIRM sin SKEW_Z
  const exploratory: Record<string, LiftResult> = {};
  const flagOf = (k: keyof OptionsShadowRow["flags"]) => at((r) => r.flags[k] === true);
  for (const [name, key] of [
    ["TS_BACKWARDATION", "tsBackwardation"], ["VRP_NEGATIVA", "vrpNegativa"],
    ["VVIXVIX_Z", "vvixVixZ"], ["SKEW_Z", "skewZ"],
  ] as const) {
    exploratory[name] = blockBootstrapLift(flagOf(key), eArr, null, opts(BT_SPEC.ciExploratory));
  }
  const noSkew = at((r) =>
    r.flags.tsBackwardation === true && (r.flags.vrpNegativa === true || r.flags.vvixVixZ === true));
  exploratory["CONFIRM_SIN_SKEW_Z"] = blockBootstrapLift(noSkew, eArr, null, opts(BT_SPEC.ciExploratory));
  exploratory["CONFIRM_SIN_SKEW_Z|VIX<25"] = blockBootstrapLift(noSkew, eArr, vixLow, opts(BT_SPEC.ciExploratory));

  const a1v = liftVerdict(a1r, starts.length);
  const a2v = liftVerdict(a2r, starts.length);

  const stateShare: Record<string, number> = {};
  for (const r of rows) stateShare[r.eqState] = (stateShare[r.eqState] ?? 0) + 1;
  for (const k of Object.keys(stateShare)) stateShare[k] = stateShare[k] / (n || 1);

  const validDates = rows.filter(valid).map((r) => r.asOf);
  return {
    sample: {
      firstDate: validDates[0] ?? null,
      lastDate: validDates[validDates.length - 1] ?? null,
      rows: n,
      evaluable: evalIdx.length,
      stateShare,
      confirmDays: confirmRows.size,
      confirmEpisodes: starts.length,
      baseRateE: a1r.pBase,
    },
    a1: { ...a1r, verdict: a1v },
    a2: { ...a2r, verdict: a2v },
    a3: { episodes: evaluableEpisodes, falsePositives: falsePos, rate: fpRate, verdict: a3Verdict },
    a4: { crossings, medianLead: medLead, n: crossings.length, descriptiveOnly: a4Desc, verdict: a4Verdict },
    exploratory,
    kill: { K1: a2v === "FALLA", K2: a3Verdict === "FALLA" },
  };
}
