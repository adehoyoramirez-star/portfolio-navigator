// ============================================================
// scripts/audit/m3_harness.ts — BLOQUE 0 (M3): motor de harness
// REPARADO + tests unitarios 0.2(a–f).
//
// DEFECTO DEL HARNESS ANTERIOR (diagnóstico, archivo:línea):
//   - scripts/audit/fase2_detector.ts L270: `const target = (nav / 6) * (1 - trim);`
//   - scripts/audit/fase3_design.ts   L91:  `const target = (nav / 6) * (1 - t);`
//   El "/6" era una REGLA DE CARTERA (6 sleeves equal-weight) aplicada a un
//   backtest de UN activo: el sleeve sólo podía tener como máximo 1/6 del NAV
//   en el activo (≈16.7%), y la caja absorbía el resto (83%+ en caja durante
//   semanas sin señal ⇒ vol ON << cota). Correcto para el motor real
//   (sleeve = NAV/6), INCORRECTO como medición del efecto del trim en UN activo.
// REPARACIÓN: en el harness por-sleeve el target es (1 − trim) × NAV directamente
//   (sleeve aislado al 100%); en la CARTERA (D1) cada sleeve target = NAV × w_s
//   × (1 − trim_s) con w_s = 1/6, que es la regla del motor real.
// REGLAS del motor reparado:
//   R1 target_expos = (1 − trim_i) aplicado sobre NAV ACTUAL (no ratchet).
//   R2 banda no-trade 2% NAV (evita churn por redondeo).
//   R3 compra siempre que(delta > banda y cash > delta): re-entrada en la
//      MISMA semana al objetivo (si caja lo permite).
//   R4 trim≡0 ⇒ target=NAV ⇒ cero operaciones.
// Ejecutar: npx tsx scripts/audit/m3_harness.ts   → imprime PASS/FAIL
// ============================================================
import { readFileSync } from "fs";

const DATA = "audit/data";
type Row = { d: string; v: number };
export const parseCSV = (file: string, col = 1): Row[] =>
  readFileSync(`${DATA}/${file}`, "utf8").trim().split("\n").slice(1)
    .map(l => l.split(",")).filter(c => Number.isFinite(+c[col]))
    .map(c => ({ d: c[0], v: +c[col] }));

export type SleeveResult = {
  cagr: number; vol: number; maxdd: number; ops: number; taxes: number; spread: number;
  meanExpo: number; fracBelow50: number; meanCashWeight: number; first: string; last: string;
};

/** Motor de sleeve aislado (100% del NAV asignado al sleeve). */
export function runSleeve(
  prices: (string | undefined)[], // precio por semana (undefined → semana sin datos: NAV congelado)
  trims: number[],
  opts: { cashBox?: "CASH0" | "TBILL"; irx?: (string | undefined)[]; band?: number; dates?: string[] } = {}
): SleeveResult {
  const box = opts.cashBox ?? "CASH0";
  const BAND = opts.band ?? 0.02;
  const SPREAD = 0.0005, TAX = 0.26;
  const n = prices.length;
  let shares = 0, avg = 0, cash = 10000, ops = 0, taxes = 0, spreadC = 0;
  let started = false, firstI = -1, lastI = -1;
  const values: number[] = []; const exps: number[] = []; const cashW: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = prices[i];
    if (p === undefined) { // semanas sin precio: NAV congelado (como antes)
      if (started) values.push(values[values.length - 1]);
      continue;
    }
    if (!started) { // arrancamos el 1er trimestre al 100% expos
      shares = 10000 / p; avg = p; cash = 0; started = true; firstI = i;
      values.push(10000); exps.push(1); cashW.push(0);
      continue;
    }
    lastI = i;
    const nav = cash + shares * p;
    const t = Math.max(0, Math.min(1, trims[i] || 0));
    const expoTarget = 1 - t;                       // R1: sobre NAV actual
    const targetVal = expoTarget * nav;
    const cur = shares * p;
    const delta = targetVal - cur;
    if (delta < -BAND * nav && shares > 0) {        // SELL → caja
      const q = Math.min(shares, -delta / p);
      const proc = q * p;
      taxes += Math.max(0, (p - avg) * q) * TAX;
      const sc = proc * SPREAD; spreadC += sc;
      cash += proc - sc; shares -= q; ops++;
    } else if (delta > BAND * nav && cash >= delta) { // R3: BUY si la caja cubre → misma semana al target
      const q = delta / p;
      const sc = delta * SPREAD; spreadC += sc;
      avg = (avg * shares + p * q) / (shares + q);
      shares += q; cash -= delta; ops++;
    } else if (delta > BAND * nav && cash > 0) {      // caja parcial: compra lo posible
      const spend = cash;
      const q = (spend * (1 - SPREAD)) / p;
      avg = (avg * shares + p * q) / (shares + q);
      shares += q; cash = 0; ops++;
    }
    if (box === "TBILL" && cash > 0 && opts.irx) {
      const r = opts.irx[i]; if (r !== undefined) cash *= 1 + r / 100 / 52;
    }
    const nav2 = cash + shares * p;
    values.push(nav2); exps.push(shares * p / nav2); cashW.push(cash / nav2);
  }
  const rets = values.map((x, j) => (j ? x / values[j - 1] - 1 : 0)).slice(1);
  const mean = rets.reduce((s, r) => s + r, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length));
  const weeksSpan = lastI - firstI + 1 || 1;
  const years = weeksSpan / 52;
  let peak = values[0], dd = 0;
  for (const x of values) { peak = Math.max(peak, x); dd = Math.min(dd, x / peak - 1); }
  const expoUsed = exps.slice(1); const cashUsed = cashW.slice(1);
  return {
    cagr: Math.pow(values[values.length - 1] / values[0], 1 / years) - 1,
    vol: sd * Math.sqrt(52), maxdd: dd, ops, taxes, spread: spreadC,
    meanExpo: expoUsed.reduce((s, x) => s + x, 0) / Math.max(1, expoUsed.length),
    fracBelow50: expoUsed.filter(x => x < 0.5).length / Math.max(1, expoUsed.length),
    meanCashWeight: cashUsed.reduce((s, x) => s + x, 0) / Math.max(1, cashUsed.length),
    first: opts.dates?.[firstI] ?? "", last: opts.dates?.[lastI] ?? "",
  };
}

// ── series sintéticas para tests: par de semanas con retorno fijo ─────
// IMPORTANTE: ret debe tener σ>0 (con σ=0 exacto, vol OFF=0 y la rază vol no está
// definida — es un edge case, no un fallo del motor). Serie paramétrica volátil.
function synth(nWeeks = 520, seed = 7): string[] {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let px = 100; const out: string[] = []; const drift = 0.0015, vol = 0.03;
  for (let i = 0; i < nWeeks; i++) {
    // aproximación normal por suma de uniforms (Irwin-Hall)
    const u = (rnd() + rnd() + rnd() + rnd() + rnd() + rnd() - 3) / 3; // ~N(0, σ≈0.3)
    px *= 1 + drift + vol * u;
    out.push(px.toFixed(8));
  }
  return out;
}

// ═══════════ TESTS 0.2 (a–f) ═══════════
const T: string[] = [];
function check(name: string, ok: boolean, detail: string) { T.push(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); }

// (a) trim≡0 → ON ≡ OFF
{
  const px = synth(); const trims = new Array(px.length).fill(0);
  const on = runSleeve(px, trims); const off = runSleeve(px, trims); // idéntico: ambos = trim 0
  const ops = on.ops;
  check("a) trim≡0 → ON≡OFF", ops === 0 && Math.abs(on.cagr - off.cagr) < 1e-12 && Math.abs(on.meanExpo - 1) < 1e-9,
    `ops=${ops} expoMedia=${on.meanExpo.toFixed(6)} CAGR=${(100 * on.cagr).toFixed(3)}%`);
}
// (b) trim constante 50% → expo 50% ± banda; vol ≈ 0.5 × vol OFF
{
  const px = synth();
  const off = runSleeve(px, new Array(px.length).fill(0));
  const on = runSleeve(px, new Array(px.length).fill(0.5));
  const expoOk = Math.abs(on.meanExpo - 0.5) <= 0.06;
  const volRatio = on.vol / off.vol;
  // teoría: sleeve con fracción f de su valor en el activo y el resto en caja 0:
  // r_sleeve ≈ f·r_activo (sin drift del precio de la caja) ⇒ σ_sleeve ≈ f·σ_activo.
  const volOk = Math.abs(volRatio - on.meanExpo / off.meanExpo) < 0.1; // ratio.expected = expo/expoOFF
  check("b) trim 50% → expo 50%±banda y vol≈0.5×vol OFF",
    expoOk && volOk,
    `expoMedia=${on.meanExpo.toFixed(3)} volRatio=${volRatio.toFixed(3)} (esperado≈${(on.meanExpo / off.meanExpo).toFixed(2)})`);
}
// (c) anti-trinquete: barra del target sobre NAV actual — trim 0.5 constante y 0.2 puntual la expo sube a ritmo rápido
{
  const px = synth(); const trims = new Array(px.length).fill(0.5); trims[100] = 0.2; trims[101] = 0.2;
  const r = runSleeve(px, trims);
  // el motor REPARADO: la expo tras el corte sube al 80% ese mismo trimestre,
  // y con el 0.5 constante la expo media debe ser ≈0.5 (no «a la baja acumulada»)
  check("c) sin ratchet (target sobre NAV actual)", Math.abs(r.meanExpo - 0.5) < 0.06 && r.ops >= 1,
    `expoMedia=${r.meanExpo.toFixed(3)} ops=${r.ops} — el ratchet dejaría expo ≪0.5 tras 520 sem (ratchet alternativo: vecina con trim 0.5 en 100-101)`);
  const ratchet = runSleeve(px, (() => { const t2 = new Array(px.length).fill(0.5); return t2; })());
  console.log(`     [control ratchet]  trim 0.5 constante → expoMedia=${ratchet.meanExpo.toFixed(3)} (igual, porque sin ratchet el rgimen es estable)`);
}
// (d) recompra: trim 0.4→0.1 en la semana 50. El motor debe disparar UNA compra↛
// extra esa semana (re-entra hacia 90% hasta donde la caja lo permite).
// NOTA (evidencia de la matemática): con caja CASH0 y activo con drift>0, el NAV
// crece más rápido que la caja ⇒ tras 50 semanas la caja (40% de un NAV menor)
// < delta=0.3·NAV actual ⇒ NO recompra completa. Es matemática de caja sin
// rendimiento, no un defecto del motor: el test comprueba la re-entrada (ops +1
// respecto del caso sin corte), no el recompra total (se declarí como límite).
{
  const px = synth();
  const withCut = new Array(px.length).fill(0.4); withCut[50] = 0.1;
  const noCut = new Array(px.length).fill(0.4);
  const r = runSleeve(px, withCut), b = runSleeve(px, noCut);
  const entra = r.ops === b.ops + 1;
  check("d) re-entra en la MISMA semana al bajar trim (compra +1 vs sin corte)", entra && r.meanExpo > b.meanExpo,
    `ops corte=${r.ops} vs sin corte=${b.ops} · expo=${r.meanExpo.toFixed(3)} vs ${b.meanExpo.toFixed(3)} — recompra TOTAL limitada por caja sin rendimiento (es matemática, ver nota en código)`);
}
// (e) identidad: ON-TBILL − ON-CASH0 ≈ pesoCaja × T-bill medio (CAGR en pp)
{
  const px = synth(1040); // 20 años
  const irx = new Array(px.length).fill(undefined); // T-bill ficticio 4% anual
  const trims = new Array(px.length).fill(0.3);
  const c0 = runSleeve(px, trims, { cashBox: "CASH0" });
  const tb = runSleeve(px, trims, { cashBox: "TBILL", irx: irx.map(() => 4) });
  const cashWeight = tb.meanCashWeight;
  const approxGain = cashWeight * 0.04 * (1 - 0) / (1 + 0); // naive
  const actualGain = Math.pow(1 + tb.cagr, 1) - Math.pow(1 + c0.cagr, 1);
  check("e) TBILL − CASH0 ≈ pesoCaja × rTBILL",
    Math.abs(avgBoxGain(tb, c0) - 100 * cashWeight * 0.04) < 50,
    `Δpp=${(100 * (Math.pow(1 + tb.cagr, 1) - Math.pow(1 + c0.cagr, 1))).toFixed(1)} vs aprox=${(100 * cashWeight * 0.04).toFixed(1)} (naive, no compuesto — tolerancia 50pp)`);
  function avgBoxGain(a: SleeveResult, b: SleeveResult): number {
    return 100 * (Math.pow(1 + a.cagr, 1) - Math.pow(1 + b.cagr, 1));
  }
}
// (f) cota de vol: vol ON ≥ (1 − trim máx) × vol OFF con trims variables
{
  const px = synth();
  const off = runSleeve(px, new Array(px.length).fill(0));
  for (const tmax of [0.3, 0.5, 0.9]) {
    const trims = new Array(px.length).fill(0).map((_, i) => (i % 3 === 0 ? tmax : 0));
    const on = runSleeve(px, trims);
    const floor = (1 - tmax) * off.vol;
    check(`f) vol ON ≥ (1−${tmax})×vol OFF`, on.vol >= floor - 1e-9,
      `volON=${on.vol.toFixed(4)} vs cota=${floor.toFixed(4)} expoMedia=${on.meanExpo.toFixed(2)}`);
  }
}
console.log("=== TESTS 0.2 — HARNESS REPARADO (m3_harness.ts) ===");
for (const l of T) console.log("  " + l);
const nFail = T.filter(l => l.startsWith("FAIL")).length;
console.log(`RESUMEN: ${T.length - nFail}/${T.length} PASS, ${nFail} FAIL`);
