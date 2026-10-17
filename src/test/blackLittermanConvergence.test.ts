// ============================================================
// Auditoría 18-oct-2026: el aviso "convergió en 1/200 iteraciones" salía 2.026 veces en la suite.
// Causa: activos sintéticos idénticos → gradiente igual en todos → la proyección al simplex lo anula →
// 1/n es el óptimo correcto. El aviso solo debe saltar con dispersión real de pesos.
// ============================================================
import { describe, test, expect, vi, afterEach } from "vitest";
import { runBlackLitterman } from "../core/portfolio/blackLitterman";

const names = ["A", "B", "C", "D"];
const mw = [0.25, 0.25, 0.25, 0.25];
const identicalCov = names.map((_, i) => names.map((__, j) => (i === j ? 0.04 : 0.04)));
const realCov = (() => {
  const v = [0.6, 0.18, 0.14, 0.25];
  return v.map((a, i) => v.map((b, j) => (i === j ? a * a : 0.3 * a * b)));
})();

afterEach(() => vi.restoreAllMocks());

describe("BL: aviso de convergencia prematura", () => {
  test("activos idénticos: devuelve 1/n y NO avisa", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = runBlackLitterman({ assetNames: names, covMatrix: identicalCov, marketWeights: mw, views: [], riskAversion: 2.5, tau: 0.05 });
    r.posteriorWeights.forEach(w => expect(w).toBeCloseTo(0.25, 6));
    expect(warn.mock.calls.filter(c => String(c[0]).includes("minimumVarianceBL"))).toHaveLength(0);
  });

  test("covarianza realista: pesos diferenciados, suman 1 y sin aviso", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = runBlackLitterman({ assetNames: names, covMatrix: realCov, marketWeights: mw, views: [], riskAversion: 2.5, tau: 0.05 });
    expect(r.posteriorWeights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 10);
    expect(Math.max(...r.posteriorWeights) - Math.min(...r.posteriorWeights)).toBeGreaterThan(0.01);
    expect(warn.mock.calls.filter(c => String(c[0]).includes("minimumVarianceBL"))).toHaveLength(0);
  });
});
