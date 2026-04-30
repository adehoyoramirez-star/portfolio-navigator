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

/**
 * FIX-IMP-4: Sortino ratio con semi-desviación REAL sobre retornos históricos negativos.
 *
 * PROBLEMA ANTERIOR en InstitutionalDashboard.tsx línea 1235:
 *   downsideVol = portfolioVol / Math.sqrt(2)
 *   Esta aproximación asume distribución perfectamente normal (gaussiana).
 *   Con BTC en cartera (fat tails, skewness negativa), el downside deviation real
 *   es materialmente mayor → Sortino inflado hasta 1.4× el valor real.
 *   Un Sortino de 2.1 puede ser en realidad 1.5 — por debajo del umbral institucional de 2.0.
 *
 * CORRECCIÓN: calcular semi-desviación real filtrando retornos diarios < 0.
 *   downsideDev = std(retornos < rf_diario) × √252
 *   sortino = (retorno_anual - rf) / downsideDev
 *
 * @param dailyReturns - array de retornos diarios del portfolio (decimal, ej: -0.02 = -2%)
 * @param annualReturn - retorno anualizado esperado (decimal)
 * @param riskFreeRate - tasa libre de riesgo anualizada (decimal, ej: 0.04 = 4%)
 */
export function sortinoRatioReal(
  dailyReturns: number[],
  annualReturn: number,
  riskFreeRate = 0.04
): number {
  if (dailyReturns.length < 10) return 0;
  const rfDaily = riskFreeRate / 252;
  // Solo retornos por debajo del MAR (Minimum Acceptable Return = rf diario)
  const negativeExcess = dailyReturns.filter(r => r < rfDaily);
  if (negativeExcess.length === 0) return Infinity; // sin retornos negativos = Sortino perfecto
  // Semi-desviación: std de los retornos negativos en exceso del MAR
  const meanNeg = negativeExcess.reduce((a, b) => a + b, 0) / negativeExcess.length;
  const variance = negativeExcess.reduce((s, r) => s + (r - meanNeg) ** 2, 0) / negativeExcess.length;
  const downsideDev = Math.sqrt(variance) * Math.sqrt(252); // anualizar
  if (downsideDev === 0) return 0;
  return (annualReturn - riskFreeRate) / downsideDev;
}

/**
 * FIX-IMP-6-BETA: Beta del portfolio vs benchmark (MSCI World / S&P 500 proxy).
 *
 * Beta = Cov(r_portfolio, r_benchmark) / Var(r_benchmark)
 *
 * Interpretación:
 *   β < 1: portfolio menos volátil que el mercado → defensivo
 *   β = 1: movimiento igual al mercado
 *   β > 1: portfolio más volátil → agresivo (típico con BTC y semis)
 *   β < 0: cobertura negativa (oro en parte)
 *
 * @param portfolioReturns - retornos diarios del portfolio
 * @param benchmarkReturns - retornos diarios del benchmark (IS3Q.DE o ^GSPC proxy)
 */
export function betaVsBenchmark(
  portfolioReturns: number[],
  benchmarkReturns: number[]
): number {
  const n = Math.min(portfolioReturns.length, benchmarkReturns.length);
  if (n < 20) return 1; // fallback neutro con pocos datos
  const pRet = portfolioReturns.slice(0, n);
  const bRet = benchmarkReturns.slice(0, n);
  const pMean = pRet.reduce((a, b) => a + b, 0) / n;
  const bMean = bRet.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov  += (pRet[i] - pMean) * (bRet[i] - bMean);
    varB += (bRet[i] - bMean) ** 2;
  }
  if (varB === 0) return 1;
  return cov / varB;
}

/**
 * Alpha de Jensen: retorno ajustado por riesgo sistemático.
 *
 * α = r_portfolio - [rf + β × (r_benchmark - rf)]
 *
 * Alpha positivo = el motor genera valor más allá de lo explicado por el mercado.
 */
export function jensenAlpha(
  annualReturn: number,
  beta: number,
  benchmarkReturn: number,
  riskFreeRate = 0.04
): number {
  return annualReturn - (riskFreeRate + beta * (benchmarkReturn - riskFreeRate));
}