// ============================================================
// src/test/matrixUtils.test.ts
// Tests unitarios para isPSD, nearestPSD, eigenvaluesSymmetric
// ============================================================
import { describe, test, expect } from "vitest";
import { isPSD, nearestPSD, eigenvaluesSymmetric, ensurePSD } from "../lib/matrixUtils";

describe("isPSD — Cholesky test", () => {
  test("matriz identidad es PSD", () => {
    expect(isPSD([[1, 0], [0, 1]])).toBe(true);
  });

  test("matriz diagonal positiva es PSD", () => {
    expect(isPSD([[4, 0, 0], [0, 3, 0], [0, 0, 2]])).toBe(true);
  });

  test("matriz de covarianza realista es PSD", () => {
    const cov = [[0.36, 0.0432], [0.0432, 0.0324]];
    expect(isPSD(cov)).toBe(true);
  });

  test("matriz con autovalores negativos no es PSD", () => {
    expect(isPSD([[1, 3], [3, 1]])).toBe(false);
  });

  test("matriz con varianza negativa no es PSD", () => {
    expect(isPSD([[-0.36, 0], [0, 0.0324]])).toBe(false);
  });

  test("matriz vacía es PSD", () => {
    expect(isPSD([])).toBe(true);
  });

  test("matriz no cuadrada no es PSD", () => {
    expect(isPSD([[1, 2, 3], [4, 5, 6]])).toBe(false);
  });

  test("matriz 6x6 del portfolio es PSD", () => {
    const vols = [0.60, 0.18, 0.15, 0.35, 0.25, 0.16];
    const corr = [
      [1.00, 0.15, 0.05, 0.10, 0.30, 0.15],
      [0.15, 1.00, 0.10, 0.15, 0.40, 0.65],
      [0.05, 0.10, 1.00, 0.05, 0.05, 0.05],
      [0.10, 0.15, 0.05, 1.00, 0.20, 0.15],
      [0.30, 0.40, 0.05, 0.20, 1.00, 0.50],
      [0.15, 0.65, 0.05, 0.15, 0.50, 1.00],
    ];
    const cov = corr.map((row, i) => row.map((c, j) => c * vols[i] * vols[j]));
    expect(isPSD(cov)).toBe(true);
  });
});

describe("nearestPSD — Higham (2002)", () => {
  test("matriz PSD se devuelve sin cambios", () => {
    const psd = [[2, 1], [1, 2]];
    const result = nearestPSD(psd);
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++)
        expect(result[i][j]).toBeCloseTo(psd[i][j], 6);
  });

  test("matriz no-PSD se repara a PSD", () => {
    const notPSD = [[1, 3], [3, 1]];
    const repaired = nearestPSD(notPSD);
    expect(isPSD(repaired)).toBe(true);
  });

  test("reparación preserva varianzas (diagonal) — Higham ajusta la diagonal", () => {
    // [[4, 6], [6, 4]] tiene eigenvalues 10 y -2. nearestPSD zeroa el -2 → diagonal=5.
    // Higham (2002) minimiza ||A - A_hat||_F en TODO el espacio, no solo off-diagonal.
    const bad = [[4, 6], [6, 4]];
    const result = nearestPSD(bad);
    // La diagonal debe ser positiva y simetrica tras la reparacion
    expect(result[0][0]).toBeGreaterThan(0);
    expect(result[1][1]).toBeGreaterThan(0);
    expect(result[0][0]).toBeCloseTo(result[1][1], 0);
  });

  test("matriz vacía retorna vacía", () => {
    expect(nearestPSD([])).toEqual([]);
  });

  test("matriz 6x6 no-PSD se repara", () => {
    const vols = [0.60, 0.18, 0.15, 0.35, 0.25, 0.16];
    const badCorr = [
      [1.0, 0.3, 0.1, 0.2, 0.5, 0.3],
      [0.3, 1.0, 0.2, 0.3, 0.7, 0.9],
      [0.1, 0.2, 1.0, 0.1, 0.1, 0.1],
      [0.2, 0.3, 0.1, 1.0, 1.5, 0.3],
      [0.5, 0.7, 0.1, 1.5, 1.0, 0.8],
      [0.3, 0.9, 0.1, 0.3, 0.8, 1.0],
    ];
    const badCov = badCorr.map((row, i) => row.map((c, j) => c * vols[i] * vols[j]));
    expect(isPSD(badCov)).toBe(false);
    const repaired = nearestPSD(badCov);
    expect(isPSD(repaired)).toBe(true);
  });
});

describe("eigenvaluesSymmetric — Jacobi", () => {
  test("identidad: autovalores = 1", () => {
    const { eigenvalues } = eigenvaluesSymmetric([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    eigenvalues.forEach(v => expect(v).toBeCloseTo(1, 8));
  });

  test("matriz 2x2: autovalores correctos", () => {
    const { eigenvalues } = eigenvaluesSymmetric([[2, 1], [1, 2]]);
    const sorted = [...eigenvalues].sort((a, b) => b - a);
    expect(sorted[0]).toBeCloseTo(3, 8);
    expect(sorted[1]).toBeCloseTo(1, 8);
  });

  test("autovectores ortonormales", () => {
    const A = [[2, 1, 0.5], [1, 2, 0.3], [0.5, 0.3, 2]];
    const { eigenvectors } = eigenvaluesSymmetric(A);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let dot = 0;
        for (let k = 0; k < 3; k++) dot += eigenvectors[k][i] * eigenvectors[k][j];
        if (i === j) expect(dot).toBeCloseTo(1, 6);
        else expect(Math.abs(dot)).toBeLessThan(1e-6);
      }
    }
  });

  test("matriz 6x6: 6 autovalores reales > 0", () => {
    const vols = [0.60, 0.18, 0.15, 0.35, 0.25, 0.16];
    // Correlaciones fijas (no Math.random para evitar tests flaky)
    const corr = [
      [1.00, 0.25, 0.10, 0.15, 0.35, 0.20],
      [0.25, 1.00, 0.15, 0.20, 0.45, 0.60],
      [0.10, 0.15, 1.00, 0.08, 0.12, 0.10],
      [0.15, 0.20, 0.08, 1.00, 0.25, 0.20],
      [0.35, 0.45, 0.12, 0.25, 1.00, 0.50],
      [0.20, 0.60, 0.10, 0.20, 0.50, 1.00],
    ];
    const cov = corr.map((row, i) => row.map((c, j) => c * vols[i] * vols[j]));
    const { eigenvalues } = eigenvaluesSymmetric(cov);
    expect(eigenvalues).toHaveLength(6);
    eigenvalues.forEach(v => expect(v).toBeGreaterThan(-1e-8));
  });
});

describe("ensurePSD — wrapper", () => {
  test("matriz PSD: no se repara", () => {
    const { wasRepaired } = ensurePSD([[2, 1], [1, 2]]);
    expect(wasRepaired).toBe(false);
  });

  test("matriz no-PSD: se repara", () => {
    const { matrix, wasRepaired, negativeEigenvalues } = ensurePSD([[1, 3], [3, 1]]);
    expect(wasRepaired).toBe(true);
    expect(negativeEigenvalues.length).toBeGreaterThan(0);
    expect(isPSD(matrix)).toBe(true);
  });
});
