// FIX BUG-IMPORT-PATH: la ruta canónica es @/core/types/portfolio (no @/data/portfolio que es un duplicado obsoleto)
import { Asset } from "@/core/types/portfolio";

/**
 * Calcula la volatilidad realizada a partir de un array de retornos diarios.
 * Los retornos deben estar en tanto por uno (ej. 0.01 = 1%).
 * Devuelve la volatilidad anualizada.
 */
export function realizedVolatility(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

/**
 * Calcula los retornos diarios de la cartera ponderados por el valor de cada activo.
 */
export function calculatePortfolioReturns(assets: Asset[], totalValue: number): number[] {
  if (assets.length === 0 || assets[0].history.length < 2) return [];
  const numDays = assets[0].history.length;
  const weights = assets.map(a => (a.price * a.shares) / totalValue);
  const returns: number[] = [];
  for (let t = 1; t < numDays; t++) {
    let portfolioReturn = 0;
    for (let i = 0; i < assets.length; i++) {
      const dailyReturn = (assets[i].history[t] / assets[i].history[t - 1]) - 1;
      portfolioReturn += weights[i] * dailyReturn;
    }
    returns.push(portfolioReturn);
  }
  return returns;
}

/**
 * Calcula la matriz de correlación entre los activos a partir de sus historiales.
 */
export function calculateCorrelationMatrix(assets: Asset[]): number[][] {
  const n = assets.length;
  if (n === 0) return [];
  const returnsPerAsset: number[][] = assets.map(asset => {
    const hist = asset.history;
    const rets: number[] = [];
    for (let i = 1; i < hist.length; i++) {
      rets.push(hist[i] / hist[i - 1] - 1);
    }
    return rets;
  });
  const minLen = Math.min(...returnsPerAsset.map(r => r.length));
  const matrix: number[][] = Array(n).fill(0).map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1;
        continue;
      }
      const retsI = returnsPerAsset[i].slice(0, minLen);
      const retsJ = returnsPerAsset[j].slice(0, minLen);
      const meanI = retsI.reduce((a, b) => a + b, 0) / minLen;
      const meanJ = retsJ.reduce((a, b) => a + b, 0) / minLen;
      let cov = 0, varI = 0, varJ = 0;
      for (let k = 0; k < minLen; k++) {
        const diffI = retsI[k] - meanI;
        const diffJ = retsJ[k] - meanJ;
        cov += diffI * diffJ;
        varI += diffI * diffI;
        varJ += diffJ * diffJ;
      }
      const corr = cov / Math.sqrt(varI * varJ);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }
  return matrix;
}

/**
 * Calcula el drawdown actual respecto al máximo histórico.
 */
export function calculateDrawdown(assets: Asset[], currentTotal: number): number {
  if (assets.length === 0 || assets[0].history.length === 0) return 0;
  const numDays = assets[0].history.length;
  let maxValue = -Infinity;
  for (let t = 0; t < numDays; t++) {
    let dayValue = 0;
    for (let i = 0; i < assets.length; i++) {
      dayValue += assets[i].history[t] * assets[i].shares;
    }
    if (dayValue > maxValue) maxValue = dayValue;
  }
  return (currentTotal - maxValue) / maxValue;
}