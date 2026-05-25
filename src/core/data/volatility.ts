// ===============================================
// ARCHIVO: src/core/data/volatility.ts
// Estimadores de volatilidad y covarianza
// ===============================================
//
// Ledoit-Wolf Shrinkage (2004):
//   Σ_shrunk = δ × F + (1 - δ) × S
//   donde:
//     S = sample covariance matrix (MLE)
//     F = target matrix (constant-correlation model)
//     δ = oracle shrinkage intensity [0,1]
//
// Referencia: Ledoit & Wolf (2004) "A well-conditioned
//   estimator for large-dimensional covariance matrices",
//   Journal of Multivariate Analysis, 88(2), 365-411.
//
// El target de correlación constante asume que todas las
// correlaciones son iguales a la media de las correlaciones
// muestrales. Esto introduce un sesgo controlado que reduce
// drásticamente el error de estimación (MSE) frente a S,
// especialmente cuando T < N (muchos activos, pocos datos).
//
// Para nuestro caso (N=7-8 activos, T=500-1000 días):
//   δ ≈ 0.10-0.35 — shrinkage ligero pero significativo.
// ===============================================

import { mean, isPositiveFinite } from '@/lib/stats';

/**
 * Volatilidad realizada anualizada de una serie univariante.
 * Usa desviación estándar muestral con factor √252.
 */
export function realizedVolatility(returns: number[]): number {
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - m, 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

/**
 * Matriz de covarianza con shrinkage Ledoit-Wolf (2004).
 *
 * @param returnsSeries - Array de series de retornos diarios (decimal, ej: -0.02 = -2%).
 *                        Cada elemento del array exterior es un activo.
 *                        Cada activo tiene un array de retornos diarios (no necesariamente
 *                        de la misma longitud — el algoritmo trunca al mínimo común).
 * @returns Matriz de covarianza anualizada (factor √252) con shrinkage Ledoit-Wolf.
 *          Dimensión: N x N, donde N = returnsSeries.length.
 *
 * @example
 *   const returns = [
 *     [0.01, -0.02, 0.015, ...],  // BTC-EUR daily returns
 *     [0.001, -0.003, 0.002, ...], // IS3Q.DE daily returns
 *   ];
 *   const cov = ledoitWolfCovariance(returns);
 *   // cov[0][0] = varianza anualizada BTC
 *   // cov[0][1] = covarianza anualizada BTC-IS3Q
 */
export function ledoitWolfCovariance(returnsSeries: number[][]): number[][] {
  const N = returnsSeries.length; // número de activos

  // ── Validación de entrada ─────────────────────────────────────────────
  if (N === 0) return [];
  if (!returnsSeries.every(r => Array.isArray(r))) {
    console.warn('[LedoitWolf] entrada inválida: algún elemento no es array');
    return Array.from({ length: N }, () => new Array(N).fill(0));
  }

  const safeLengths = returnsSeries.map(r => r.filter(isPositiveFinite).length);
  const minLen = Math.min(...safeLengths);

  // Guardia: si no hay datos suficientes para covarianzas pairwise,
  // usamos identity-based shrinkage en lugar de diagonal pura.
  //   Target: traceMean × I (identidad escalada por varianza media)
  //   Sample: diag(varianzas individuales de cada activo, computadas desde
  //           su serie completa — no truncadas a minLen global)
  //   Shrinkage: α adaptativo según cuántos activos tienen series cortas
  //
  // La ventaja sobre diagonal pura: las varianzas se regularizan hacia la
  // media del portafolio, evitando estimaciones extremas en activos cortos.
  if (minLen < 2) {
    // Varianzas de cada activo desde su serie COMPLETA (no truncada)
    const variances = returnsSeries.map(r => {
      const clean = r.filter(isPositiveFinite);
      if (clean.length < 2) return 0.04;
      const m = mean(clean);
      return Math.max(0.0001, clean.reduce((s, v) => s + (v - m) ** 2, 0) / (clean.length - 1) * 252);
    });

    // Varianza media (target para identity shrinkage)
    const traceMean = variances.reduce((s, v) => s + v, 0) / variances.length;

    // Intensidad adaptativa: más shrinkage cuantos más activos con series cortas
    const shortCount = returnsSeries.filter(r => r.filter(isPositiveFinite).length < 20).length;
    const alpha = Math.min(0.9, 0.5 + 0.3 * (shortCount / N));

    console.warn(
      '[LedoitWolf] minLen=' + minLen + ' < 2, ' +
      'identity-based shrinkage (α=' + alpha.toFixed(2) + ')' +
      ' | meanVar=' + traceMean.toFixed(4) +
      ' | shortSeries=' + shortCount + '/' + N
    );

    return Array.from({ length: N }, (_, i) =>
      Array.from({ length: N }, (_, j) => {
        if (i === j) {
          const shrunk = (1 - alpha) * variances[i] + alpha * traceMean;
          return isFinite(shrunk) ? shrunk : 0.04;
        }
        return 0;
      })
    );
  }

  const T = minLen; // número de observaciones comunes

  // Truncar todas las series a la misma longitud (desde el final)
  const trimmed = returnsSeries.map(r => {
    const clean = r.filter(isPositiveFinite);
    return clean.slice(clean.length - T);
  });

  // ── Paso 1: Sample covariance matrix (MLE, no Bessel) ────────────────
  // Usamos MLE (división por T, no T-1) porque Ledoit-Wolf deriva el
  // Oracle shrinkage con MLE. Luego anualizamos ×252.
  const means = trimmed.map(mean);

  // Matriz S: sample covariance (sin anualizar aún)
  const S: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      let sum = 0;
      for (let k = 0; k < T; k++) {
        sum += (trimmed[i][k] - means[i]) * (trimmed[j][k] - means[j]);
      }
      const cov_ij = isFinite(sum) ? sum / T : 0;
      S[i][j] = cov_ij;
      S[j][i] = cov_ij;
    }
  }

  if (N <= 1) {
    // Un solo activo: anualizar y devolver
    return [[S[0][0] * 252]];
  }

  // ── Paso 2: Target matrix F (constant-correlation model) ─────────────
  // F_ij = √(S_ii × S_jj) × ρ̄  para i ≠ j
  // F_ii = S_ii (misma varianza en la diagonal)
  //
  // donde ρ̄ es la correlación media muestral:

  const sampleVars = S.map((row, i) => row[i]); // σ²_i

  // Correlaciones muestrales y su media
  let sumCorr = 0;
  let countCorr = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const denom = Math.sqrt(Math.max(1e-16, sampleVars[i] * sampleVars[j]));
      if (denom > 0 && isFinite(denom)) {
        sumCorr += S[i][j] / denom;
        countCorr++;
      }
    }
  }
  const rhoBar = countCorr > 0 ? sumCorr / countCorr : 0;
  const rhoBarClipped = Math.max(-0.99, Math.min(0.99, rhoBar));

  // Matriz F: target de correlación constante
  const F: number[][] = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => {
      if (i === j) return sampleVars[i];
      const std_i = Math.sqrt(Math.max(1e-16, sampleVars[i]));
      const std_j = Math.sqrt(Math.max(1e-16, sampleVars[j]));
      return std_i * std_j * rhoBarClipped;
    })
  );

  // ── Paso 3: Oracle shrinkage intensity δ̂* ────────────────────────────
  let pi_hat = 0;
  let rho_hat = 0;

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let sumSq = 0;
      for (let k = 0; k < T; k++) {
        const dev = (trimmed[i][k] - means[i]) * (trimmed[j][k] - means[j]) - S[i][j];
        sumSq += dev * dev;
      }
      const var_sij = isFinite(sumSq) ? sumSq / T : 0;

      pi_hat += var_sij;

      if (i === j) {
        rho_hat += var_sij;
      } else {
        const ratio = Math.abs(S[i][j]) > 1e-12
          ? F[i][j] / S[i][j]
          : 0;
        rho_hat += var_sij * Math.max(-1, Math.min(1, ratio));
      }
    }
  }

  let gamma_hat = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const diff = F[i][j] - S[i][j];
      gamma_hat += diff * diff;
    }
  }

  let delta = 0;
  if (gamma_hat > 1e-16 && isFinite(pi_hat) && isFinite(rho_hat)) {
    const kappa = Math.max(0, pi_hat - rho_hat);
    delta = Math.min(1, kappa / gamma_hat / T);
  }

  delta = Math.max(0, Math.min(1, delta));

  // ── Paso 4: Matriz shrunk = δ × F + (1 - δ) × S ─────────────────────
  const shrunk: number[][] = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => {
      const raw = delta * F[i][j] + (1 - delta) * S[i][j];
      return isFinite(raw) ? raw * 252 : (i === j ? 0.04 : 0);
    })
  );

  // ── Diagnóstico (solo en desarrollo) ────────────────────────────────────
  // Controlado por import.meta.env.DEV (Vite) — true en `npm run dev`,
  // false automáticamente en producción (`npm run build`).
  // Evita ~60+ líneas de log por backtest en producción.
  const devMode = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
  if (devMode) {
    console.log(
      '[LedoitWolf] δ=' + delta.toFixed(4) +
      ' | γ̂=' + gamma_hat.toFixed(6) +
      ' | π̂=' + pi_hat.toFixed(6) +
      ' | ρ̂=' + rho_hat.toFixed(6) +
      ' | ρ̄=' + rhoBarClipped.toFixed(4) +
      ' | N=' + N + ' | T=' + T
    );
  }
  const hasNaN = shrunk.some(row => row.some(v => !isFinite(v)));
  if (hasNaN) {
    console.warn('[LedoitWolf] \u26a0\ufe0f  matriz shrunk contiene NaN/Inf');
  }

  return shrunk;
}
