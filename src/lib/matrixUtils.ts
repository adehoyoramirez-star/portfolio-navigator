// ============================================================
// src/lib/matrixUtils.ts — Utilidades de álgebra matricial
// ============================================================
// FIX-AUDIT-R10 PSD-CHECK: Validación de Positive Semi-Definiteness
// de la matriz de covarianza antes de pasarla a BL, HRP y MinVar.
//
// PROBLEMA: Una covMatrix no-PSD (autovalores negativos) produce:
//   - Black-Litterman: inversión de matriz singular → NaN/Inf en μ_BL
//   - HRP: distancias de correlación imaginarias → clustering roto
//   - MinVar: weights pueden diverger → cualquier activo al 100%
//   - Cholesky-MC: fallo silencioso → simulación vacía
//
// SOLUCIÓN:
//   1. isPSD(): test de Cholesky — si falla, la matriz no es PSD
//   2. nearestPSD(): proyección de Higham (2002) — covMatrix PSD más cercana
//   3. eigenvaluesSymmetric(): algoritmo Jacobi para diagnóstico
//
// Referencias:
//   Higham, N.J. (2002) "Computing the nearest correlation matrix"
//   Golub & Van Loan (2013) "Matrix Computations", §8.4 (Jacobi)
// ============================================================

/**
 * Test de Cholesky: intenta descomponer A = LL^T.
 * Si falla (raíz negativa), A no es PSD.
 */
export function isPSD(A: number[][], epsilon: number = 1e-8): boolean {
  const n = A.length;
  if (n === 0) return true;
  if (A.some(row => row.length !== n)) return false;

  const L: number[][] = A.map(row => [...row]);

  for (let j = 0; j < n; j++) {
    let diagSum = 0;
    for (let k = 0; k < j; k++) {
      if (!isFinite(L[j][k])) return false;
      diagSum += L[j][k] * L[j][k];
    }
    const diag = L[j][j] - diagSum;
    if (diag <= epsilon) return false;
    L[j][j] = Math.sqrt(diag);

    for (let i = j + 1; i < n; i++) {
      let offDiagSum = 0;
      for (let k = 0; k < j; k++) {
        offDiagSum += L[i][k] * L[j][k];
      }
      L[i][j] = (L[i][j] - offDiagSum) / L[j][j];
    }
  }

  return true;
}

/**
 * Proyección de Higham (2002): encuentra la matriz PSD más cercana
 * en norma Frobenius.
 *
 * Algoritmo:
 *   1. Descomposición espectral: A = QΛQ^T
 *   2. Reemplazar autovalores negativos por 0
 *   3. Reconstruir: Â = QΛ⁺Q^T
 *   4. Asegurar simetría: Â = (Â + Â^T) / 2
 */
export function nearestPSD(A: number[][], epsilon: number = 1e-10): number[][] {
  const n = A.length;
  if (n === 0) return [];
  if (A.some(row => row.length !== n)) {
    console.warn('[matrixUtils] nearestPSD: non-square matrix, returning identity');
    return Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
    );
  }

  const { eigenvalues, eigenvectors } = eigenvaluesSymmetric(A);
  const posEigenvalues = eigenvalues.map(v => (v > epsilon ? v : 0));

  const result: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        if (posEigenvalues[k] > 0) {
          sum += eigenvectors[i][k] * posEigenvalues[k] * eigenvectors[j][k];
        }
      }
      result[i][j] = sum;
    }
  }

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      result[i][j] = (result[i][j] + result[j][i]) / 2;
    }
  }

  return result;
}

/**
 * Descomposición espectral de matriz simétrica via Jacobi
 * (rotaciones de Givens iterativas). Numéricamente estable
 * para matrices pequeñas (n ≤ 20).
 */
export function eigenvaluesSymmetric(
  A: number[][],
  maxIter: number = 100,
  tol: number = 1e-12
): { eigenvalues: number[]; eigenvectors: number[][] } {
  const n = A.length;
  if (n === 0) return { eigenvalues: [], eigenvectors: [] };

  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
  const M: number[][] = A.map(row => [...row]);

  for (let iter = 0; iter < maxIter; iter++) {
    let maxOff = 0;
    let p = 0, q = 1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(M[i][j]) > Math.abs(maxOff)) {
          maxOff = M[i][j];
          p = i;
          q = j;
        }
      }
    }

    if (Math.abs(maxOff) < tol) break;

    const theta = (M[q][q] - M[p][p]) / (2 * M[p][q]);
    const t = theta >= 0
      ? 1 / (theta + Math.sqrt(theta * theta + 1))
      : 1 / (theta - Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;

    for (let i = 0; i < n; i++) {
      const mip = M[i][p], miq = M[i][q];
      M[i][p] = c * mip - s * miq;
      M[i][q] = s * mip + c * miq;
    }
    for (let j = 0; j < n; j++) {
      const mpj = M[p][j], mqj = M[q][j];
      M[p][j] = c * mpj - s * mqj;
      M[q][j] = s * mpj + c * mqj;
    }
    for (let i = 0; i < n; i++) {
      const vip = V[i][p], viq = V[i][q];
      V[i][p] = c * vip - s * viq;
      V[i][q] = s * vip + c * viq;
    }

    M[p][q] = 0;
    M[q][p] = 0;
  }

  const eigenvalues: number[] = [];
  for (let i = 0; i < n; i++) eigenvalues.push(M[i][i]);

  return { eigenvalues, eigenvectors: V };
}

/**
 * Diagnóstico rápido: verifica si la matriz es PSD.
 * Si no lo es, aplica nearestPSD y reporta autovalores negativos.
 */
export function ensurePSD(
  covMatrix: number[][],
  label: string = 'covMatrix'
): { matrix: number[][]; wasRepaired: boolean; negativeEigenvalues: number[] } {
  if (isPSD(covMatrix)) {
    return { matrix: covMatrix, wasRepaired: false, negativeEigenvalues: [] };
  }

  const { eigenvalues } = eigenvaluesSymmetric(covMatrix);
  const negativeEigenvalues = eigenvalues.filter(v => v < -1e-10);

  if (negativeEigenvalues.length > 0) {
    const tickerNames = label.includes(',') ? label.split(',').map(s => s.trim()) : [label];
    const worstEig = Math.min(...negativeEigenvalues).toExponential(2);
    console.warn(
      `[matrixUtils] ⚠️ ${label} no es PSD: ${negativeEigenvalues.length} autovalores negativos ` +
      `(peor=${worstEig}). Reparando con nearestPSD (Higham 2002).`
    );
  }

  const repaired = nearestPSD(covMatrix);
  return { matrix: repaired, wasRepaired: true, negativeEigenvalues };
}
