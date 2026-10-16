// ============================================================
// src/core/risk/optionsVolShadow.ts
// OPT-SHADOW v1.0.0 — Capa de opciones en MODO SOMBRA (solo observabilidad).
//
// Especificación congelada: scripts/validation/PREREGISTRO_OPCIONES_SOMBRA.md
//
// INVARIANTES (ver preregistro §1):
//   I1 Aislamiento: este módulo NO importa nada del motor y NINGÚN otro archivo
//      de src/ lo importa (lo verifica src/test/optionsVolShadow.test.ts).
//   I3 Sin fallbacks silenciosos: dato ausente → NO_DATA, nunca CALM por defecto.
//   I5 Sin look-ahead: la fila de la fecha t usa solo datos con índice <= t;
//      los z-scores usan los 252 valores válidos ANTERIORES a t (excluye t).
//
// Es una librería PURA: sin red, sin reloj, sin disco. Mismo input → mismo output.
// ============================================================

export const OPT_SHADOW_SPEC = Object.freeze({
  version: "1.0.0",
  zWindow: 252,
  zThreshold: 2.0,
  tsBackwardation: 1.0,
  rvWindowSpx: 21,
  rvWindowBtc: 30,
  annualizationSpx: 252,
  annualizationBtc: 365,
});

export type ShadowState =
  | "CALM"
  | "WATCH"
  | "CONFIRM"
  | "NO_DATA"
  | "INSUFFICIENT_HISTORY";

/** Series alineadas por índice con `dates` (ISO YYYY-MM-DD, estrictamente ascendentes). */
export interface ShadowSeries {
  dates: string[];
  vix: Array<number | null>;
  vix3m: Array<number | null>;
  vvix: Array<number | null>;
  skew: Array<number | null>;
  /** ^GSPC */
  spx: Array<number | null>;
  /** BTC-USD */
  btc: Array<number | null>;
  /** Índice DVOL (Deribit) */
  dvol: Array<number | null>;
}

export interface OptionsShadowFlags {
  tsBackwardation: boolean | null;
  vrpNegativa: boolean | null;
  vvixVixZ: boolean | null;
  skewZ: boolean | null;
  dvolZ: boolean | null;
  vrpBtcNegativa: boolean | null;
}

export interface OptionsShadowRow {
  asOf: string;
  specVersion: string;
  /** Series requeridas sin barra válida en la fecha exacta. */
  missing: string[];
  // Renta variable
  vix: number | null;
  vix3m: number | null;
  ts: number | null;
  rv21: number | null;
  vrp: number | null;
  vvix: number | null;
  vvixVix: number | null;
  vvixVixZ: number | null;
  skew: number | null;
  skewZ: number | null;
  eqState: ShadowState;
  // BTC
  dvol: number | null;
  rv30Btc: number | null;
  vrpBtc: number | null;
  dvolZ: number | null;
  btcState: ShadowState;
  flags: OptionsShadowFlags;
}

// ── Helpers numéricos ────────────────────────────────────────────────────

const isPos = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0;

/** Últimos `count` valores válidos con índice <= endInclusive, en orden cronológico. null si no hay suficientes. */
function lastValid(
  arr: Array<number | null>,
  endInclusive: number,
  count: number,
): number[] | null {
  const out: number[] = [];
  for (let j = endInclusive; j >= 0 && out.length < count; j--) {
    const v = arr[j];
    if (isPos(v)) out.push(v);
  }
  if (out.length < count) return null;
  return out.reverse();
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Desviación típica muestral (n-1). */
function sampleStd(xs: number[]): number {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** z-score de `value` frente a `history` (excluye `value`). null si la dispersión es 0. */
export function zScore(value: number, history: number[]): number | null {
  if (history.length < 2) return null;
  const sd = sampleStd(history);
  if (!(sd > 0)) return null;
  return (value - mean(history)) / sd;
}

/** Volatilidad realizada anualizada en % a partir de `closes` (n+1 cierres → n retornos log). */
export function realizedVolPct(closes: number[], annualization: number): number {
  const rets: number[] = [];
  for (let k = 1; k < closes.length; k++) {
    rets.push(Math.log(closes[k] / closes[k - 1]));
  }
  return sampleStd(rets) * Math.sqrt(annualization) * 100;
}

/** Serie del ratio VVIX/VIX: valores válidos con índice < endExclusive, últimos `count`. */
function lastVvixVix(
  vvix: Array<number | null>,
  vix: Array<number | null>,
  endExclusive: number,
  count: number,
): number[] | null {
  const out: number[] = [];
  for (let j = endExclusive - 1; j >= 0 && out.length < count; j--) {
    const a = vvix[j];
    const b = vix[j];
    if (isPos(a) && isPos(b)) out.push(a / b);
  }
  if (out.length < count) return null;
  return out.reverse();
}

function validateSeries(s: ShadowSeries): void {
  const n = s.dates.length;
  const names: Array<keyof ShadowSeries> = ["vix", "vix3m", "vvix", "skew", "spx", "btc", "dvol"];
  for (const k of names) {
    if ((s[k] as unknown[]).length !== n) {
      throw new Error(`ShadowSeries.${k} longitud ${(s[k] as unknown[]).length} != dates ${n}`);
    }
  }
  for (let i = 1; i < n; i++) {
    if (!(s.dates[i] > s.dates[i - 1])) {
      throw new Error(`ShadowSeries.dates no estrictamente ascendente en índice ${i}`);
    }
  }
}

// ── Función principal ────────────────────────────────────────────────────

/**
 * Calcula la fila sombra para la fecha `s.dates[index]`.
 * Errores de programación (series desalineadas, índice fuera de rango) lanzan excepción;
 * errores de DATOS (barras ausentes) se reflejan en estados NO_DATA / INSUFFICIENT_HISTORY.
 */
export function computeOptionsShadowRow(s: ShadowSeries, index: number): OptionsShadowRow {
  validateSeries(s);
  if (!Number.isInteger(index) || index < 0 || index >= s.dates.length) {
    throw new Error(`índice fuera de rango: ${index}`);
  }
  const { zWindow, zThreshold, tsBackwardation, rvWindowSpx, rvWindowBtc, annualizationSpx, annualizationBtc } =
    OPT_SHADOW_SPEC;

  const at = (a: Array<number | null>): number | null => (isPos(a[index]) ? (a[index] as number) : null);
  const vix = at(s.vix);
  const vix3m = at(s.vix3m);
  const vvix = at(s.vvix);
  const skew = at(s.skew);
  const spxNow = at(s.spx);
  const dvol = at(s.dvol);
  const btcNow = at(s.btc);

  const missing: string[] = [];
  if (vix === null) missing.push("vix");
  if (vix3m === null) missing.push("vix3m");
  if (vvix === null) missing.push("vvix");
  if (skew === null) missing.push("skew");
  if (spxNow === null) missing.push("spx");
  if (dvol === null) missing.push("dvol");
  if (btcNow === null) missing.push("btc");

  const flags: OptionsShadowFlags = {
    tsBackwardation: null,
    vrpNegativa: null,
    vvixVixZ: null,
    skewZ: null,
    dvolZ: null,
    vrpBtcNegativa: null,
  };

  const row: OptionsShadowRow = {
    asOf: s.dates[index],
    specVersion: OPT_SHADOW_SPEC.version,
    missing,
    vix, vix3m, ts: null, rv21: null, vrp: null,
    vvix, vvixVix: null, vvixVixZ: null,
    skew, skewZ: null,
    eqState: "NO_DATA",
    dvol, rv30Btc: null, vrpBtc: null, dvolZ: null,
    btcState: "NO_DATA",
    flags,
  };

  // ── Renta variable ─────────────────────────────────────────────────────
  const eqMissing = ["vix", "vix3m", "vvix", "skew", "spx"].some((m) => missing.includes(m));
  if (!eqMissing) {
    row.ts = (vix as number) / (vix3m as number);
    row.vvixVix = (vvix as number) / (vix as number);
    flags.tsBackwardation = row.ts > tsBackwardation;

    const closes = lastValid(s.spx, index, rvWindowSpx + 1);
    if (closes) {
      row.rv21 = realizedVolPct(closes, annualizationSpx);
      row.vrp = (vix as number) - row.rv21;
      flags.vrpNegativa = row.vrp < 0;
    }

    const vvHist = lastVvixVix(s.vvix, s.vix, index, zWindow);
    if (vvHist) row.vvixVixZ = zScore(row.vvixVix, vvHist);
    const skHist = lastValid(s.skew, index - 1, zWindow);
    if (skHist) row.skewZ = zScore(skew as number, skHist);

    if (row.vvixVixZ !== null) flags.vvixVixZ = row.vvixVixZ >= zThreshold;
    if (row.skewZ !== null) flags.skewZ = row.skewZ >= zThreshold;

    if (row.rv21 === null || row.vvixVixZ === null || row.skewZ === null) {
      row.eqState = "INSUFFICIENT_HISTORY";
    } else {
      const others = [flags.vrpNegativa, flags.vvixVixZ, flags.skewZ];
      const anyOther = others.some((f) => f === true);
      const anyFlag = flags.tsBackwardation === true || anyOther;
      if (flags.tsBackwardation === true && anyOther) row.eqState = "CONFIRM";
      else if (anyFlag) row.eqState = "WATCH";
      else row.eqState = "CALM";
    }
  }

  // ── BTC (independiente) ────────────────────────────────────────────────
  const btcMissing = ["dvol", "btc"].some((m) => missing.includes(m));
  if (!btcMissing) {
    const closes = lastValid(s.btc, index, rvWindowBtc + 1);
    const dvHist = lastValid(s.dvol, index - 1, zWindow);
    if (closes) {
      row.rv30Btc = realizedVolPct(closes, annualizationBtc);
      row.vrpBtc = (dvol as number) - row.rv30Btc;
      flags.vrpBtcNegativa = row.vrpBtc < 0;
    }
    if (dvHist) row.dvolZ = zScore(dvol as number, dvHist);
    if (row.dvolZ !== null) flags.dvolZ = row.dvolZ >= zThreshold;

    if (row.rv30Btc === null || row.dvolZ === null) {
      row.btcState = "INSUFFICIENT_HISTORY";
    } else {
      const n = (flags.dvolZ === true ? 1 : 0) + (flags.vrpBtcNegativa === true ? 1 : 0);
      row.btcState = n === 2 ? "CONFIRM" : n === 1 ? "WATCH" : "CALM";
    }
  }

  return row;
}

// ── Serialización CSV (columnas fijas, append-only) ──────────────────────

export const OPT_SHADOW_CSV_COLUMNS = [
  "asOf", "specVersion", "preregSha", "missing",
  "vix", "vix3m", "ts", "rv21", "vrp", "vvix", "vvixVix", "vvixVixZ", "skew", "skewZ",
  "flagTs", "flagVrpNeg", "flagVvixVixZ", "flagSkewZ", "eqState",
  "dvol", "rv30Btc", "vrpBtc", "dvolZ", "flagDvolZ", "flagVrpBtcNeg", "btcState",
  "runTs",
] as const;

const num = (x: number | null): string => (x === null ? "" : String(Math.round(x * 1e6) / 1e6));
const flag = (x: boolean | null): string => (x === null ? "" : x ? "1" : "0");

export function optionsShadowCsvHeader(): string {
  return OPT_SHADOW_CSV_COLUMNS.join(",");
}

export function optionsShadowCsvLine(row: OptionsShadowRow, preregSha: string, runTs: string): string {
  const f = row.flags;
  const cells: Record<(typeof OPT_SHADOW_CSV_COLUMNS)[number], string> = {
    asOf: row.asOf,
    specVersion: row.specVersion,
    preregSha,
    missing: row.missing.join("|"),
    vix: num(row.vix), vix3m: num(row.vix3m), ts: num(row.ts), rv21: num(row.rv21), vrp: num(row.vrp),
    vvix: num(row.vvix), vvixVix: num(row.vvixVix), vvixVixZ: num(row.vvixVixZ),
    skew: num(row.skew), skewZ: num(row.skewZ),
    flagTs: flag(f.tsBackwardation), flagVrpNeg: flag(f.vrpNegativa),
    flagVvixVixZ: flag(f.vvixVixZ), flagSkewZ: flag(f.skewZ),
    eqState: row.eqState,
    dvol: num(row.dvol), rv30Btc: num(row.rv30Btc), vrpBtc: num(row.vrpBtc), dvolZ: num(row.dvolZ),
    flagDvolZ: flag(f.dvolZ), flagVrpBtcNeg: flag(f.vrpBtcNegativa),
    btcState: row.btcState,
    runTs,
  };
  return OPT_SHADOW_CSV_COLUMNS.map((c) => cells[c]).join(",");
}
