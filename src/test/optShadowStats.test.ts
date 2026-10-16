// ============================================================
// src/test/optShadowStats.test.ts
// OPT-SHADOW v1.0.0 — tests de la estadística del backtest en histórico largo.
// ============================================================
import { describe, it, expect } from "vitest";
import {
  BT_SPEC,
  lcg,
  median,
  forwardEvent,
  runStarts,
  drawdownCrossings,
  leadRows,
  blockBootstrapLift,
  evaluateOptShadow,
} from "../../scripts/validation/optShadowStats";
import type { ShadowSeries } from "../core/risk/optionsVolShadow";

describe("primitivas", () => {
  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("forwardEvent: mínimo forward, umbral inclusivo, no evaluable → null", () => {
    const c = [100, 99, 95, 92, 101];
    expect(forwardEvent(c, 0, 3, -0.07)).toBe(true);   // min = -8%
    expect(forwardEvent(c, 0, 3, -0.09)).toBe(false);
    expect(forwardEvent(c, 0, 2, -0.05)).toBe(true);   // -5% exacto es <= -5%
    expect(forwardEvent(c, 3, 3, -0.07)).toBeNull();   // faltan jornadas
    expect(forwardEvent([100, null, 90, 90], 0, 3, -0.07)).toBeNull();
  });

  it("runStarts agrupa rachas consecutivas", () => {
    expect(runStarts([false, true, true, false, true])).toEqual([1, 4]);
    expect(runStarts([true, true])).toEqual([0]);
    expect(runStarts([])).toEqual([]);
  });

  it("drawdownCrossings: un cruce por episodio y rearme solo con nuevo máximo", () => {
    //            0    1    2   3   4    5    6
    const v = [100, 110, 95, 90, 120, 100, 104];
    expect(drawdownCrossings(v, 0.12)).toEqual([2, 5]);
  });

  it("leadRows: primer CONFIRM de la ventana; sin aviso → 0", () => {
    const rows = new Set([8, 9]);
    expect(leadRows(12, rows, 5)).toEqual({ lead: 4, warned: true });
    expect(leadRows(12, rows, 2)).toEqual({ lead: 0, warned: false });
    expect(leadRows(9, rows, 5)).toEqual({ lead: 1, warned: true });
  });

  it("lcg es determinista", () => {
    const a = lcg(1), b = lcg(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("blockBootstrapLift", () => {
  const opts = { reps: 600, block: 20, seed: 42, ci: 0.95 };

  function synth(n: number, informative: boolean) {
    const r = lcg(99);
    const state: boolean[] = [];
    const e: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const s = r() < 0.1;
      state.push(s);
      e.push(informative ? (s ? r() < 0.5 : r() < 0.05) : r() < 0.1);
    }
    return { state, e };
  }

  it("estado informativo → lift alto y límite inferior > 1,5", () => {
    const { state, e } = synth(3000, true);
    const r = blockBootstrapLift(state, e, null, opts);
    expect(r.lift as number).toBeGreaterThan(3);
    expect(r.lo as number).toBeGreaterThan(1.5);
  });

  it("estado independiente → el IC incluye 1", () => {
    const { state, e } = synth(3000, false);
    const r = blockBootstrapLift(state, e, null, opts);
    expect(r.lo as number).toBeLessThan(1);
    expect(r.hi as number).toBeGreaterThan(1);
  });

  it("determinismo con semilla fija", () => {
    const { state, e } = synth(1000, true);
    expect(blockBootstrapLift(state, e, null, opts)).toEqual(blockBootstrapLift(state, e, null, opts));
  });

  it("la máscara restringe la base y el estado", () => {
    const state = [true, true, false, false];
    const e = [true, false, true, false];
    const mask = [true, false, true, true];
    const r = blockBootstrapLift(state, e, mask, { ...opts, block: 2 });
    expect(r.nBase).toBe(3);
    expect(r.nState).toBe(1);
    expect(r.pState).toBe(1);          // fila 0: estado y E
    expect(r.pBase).toBeCloseTo(2 / 3, 12); // filas 0,2,3: E en 0 y 2
    expect(r.lift as number).toBeCloseTo(1 / (2 / 3), 12);
  });

  it("sin días de estado → lift null (no se inventa)", () => {
    const r = blockBootstrapLift([false, false, false], [true, false, true], null, { ...opts, block: 2 });
    expect(r.lift).toBeNull();
    expect(r.lo).toBeNull();
  });

  it("longitudes desalineadas lanzan error", () => {
    expect(() => blockBootstrapLift([true], [true, false], null, opts)).toThrow();
  });
});

// ── Extremo a extremo con datos sintéticos ──────────────────────────────
function plantedSeries(n: number, episodeStarts: number[]): ShadowSeries {
  const r = lcg(7);
  const t0 = Date.parse("2020-01-01T00:00:00Z");
  const dates: string[] = [];
  const vix: number[] = [], vix3m: number[] = [], vvix: number[] = [], skew: number[] = [], spx: number[] = [];
  let sp = 3000;
  for (let i = 0; i < n; i++) {
    dates.push(new Date(t0 + i * 86400_000).toISOString().slice(0, 10));
    vix.push(15 + (r() - 0.5));
    vix3m.push(17 + (r() - 0.5));
    vvix.push(85 + 4 * (r() - 0.5));
    skew.push(120 + 4 * (r() - 0.5));
    sp *= Math.exp(0.0004 + 0.003 * (r() - 0.5));
    spx.push(sp);
  }
  for (const e of episodeStarts) {
    for (let k = 0; k < 4; k++) {
      vix[e + k] = 22; vix3m[e + k] = 20; skew[e + k] = 140; // backwardation + SKEW z alto, VIX < 25
    }
    for (let j = e + 4; j < n; j++) spx[j] *= 0.9;           // caída del 10% tras el aviso
  }
  const nulls = new Array<number | null>(n).fill(null);
  return { dates, vix, vix3m, vvix, skew, spx, btc: [...nulls], dvol: [...nulls] };
}

describe("evaluateOptShadow (sintético)", () => {
  const starts = [300, 450, 600, 750, 900, 1050];
  const series = plantedSeries(1200, starts);

  // Cartera de referencia: cruza L1 justo tras el primer aviso (índice 454) y se recupera.
  const values = series.dates.map((_, i) => (i < 454 ? 100 : i < 470 ? 85 : 105));
  const engine = { dates: series.dates, values };

  const res = evaluateOptShadow(series, engine);

  it("detecta los episodios plantados", () => {
    expect(res.sample.confirmEpisodes).toBe(starts.length);
    expect(res.sample.confirmDays).toBe(starts.length * 4);
  });

  it("A1 y A2 pasan: el estado anticipa la caída incluso con VIX < 25", () => {
    expect(res.a1.lift as number).toBeGreaterThan(BT_SPEC.liftMin);
    expect(res.a1.verdict).toBe("PASA");
    expect(res.a2.verdict).toBe("PASA");
  });

  it("A3: ningún falso positivo", () => {
    expect(res.a3.rate).toBe(0);
    expect(res.a3.verdict).toBe("PASA");
  });

  it("A4: un cruce de L1 con aviso a 4 jornadas, pero n<5 → no concluyente", () => {
    expect(res.a4.crossings).toEqual([{ date: series.dates[454], warned: true, lead: 4 }]);
    expect(res.a4.descriptiveOnly).toBe(true);
    expect(res.a4.verdict).toBe("NO_CONCLUYENTE");
  });

  it("K1 y K2 no se activan", () => {
    expect(res.kill).toEqual({ K1: false, K2: false });
  });

  it("determinismo: dos corridas dan resultado idéntico", () => {
    expect(evaluateOptShadow(series, engine)).toEqual(res);
  });

  it("un cruce de L1 posterior al fin de la serie se ignora (no se ancla a la última fila)", () => {
    const lateDates = [...series.dates];
    lateDates[1199] = "2099-01-01"; // fecha de la cartera de referencia fuera de la serie
    const lateValues = series.dates.map((_, i) => (i < 1199 ? 100 : 80));
    const out = evaluateOptShadow(series, { dates: lateDates, values: lateValues });
    expect(out.a4.crossings).toEqual([]);
  });

  it("guardia de potencia: con < 5 episodios, A1–A3 son NO_CONCLUYENTE", () => {
    const few = evaluateOptShadow(plantedSeries(1200, [300, 600]), engine);
    expect(few.sample.confirmEpisodes).toBe(2);
    expect(few.a1.verdict).toBe("NO_CONCLUYENTE");
    expect(few.a2.verdict).toBe("NO_CONCLUYENTE");
    expect(few.a3.verdict).toBe("NO_CONCLUYENTE");
    expect(few.kill).toEqual({ K1: false, K2: false });
  });

  it("serie sin ninguna señal: no hay episodios y todo es NO_CONCLUYENTE", () => {
    const none = evaluateOptShadow(plantedSeries(600, []));
    expect(none.sample.confirmEpisodes).toBe(0);
    expect(none.a1.lift).toBeNull();
    expect(none.a1.verdict).toBe("NO_CONCLUYENTE");
    expect(none.a4.crossings).toEqual([]);
  });

  it("señal inútil (aviso sin caída) → A3 falla con suficientes episodios", () => {
    // mismas señales, pero sin la caída del 10%
    const s = plantedSeries(1200, starts);
    const r = lcg(7);
    let sp = 3000;
    for (let i = 0; i < s.spx.length; i++) {
      r(); r(); r(); r(); // consume las mismas 4 tiradas que el generador para mantener la sincronía
      sp *= Math.exp(0.0004 + 0.003 * (r() - 0.5));
      s.spx[i] = sp;
    }
    const out = evaluateOptShadow(s);
    expect(out.a3.rate).toBe(1);
    expect(out.a3.verdict).toBe("FALLA");
    expect(out.kill.K2).toBe(true);
  });
});
