// src/lib/montecarlo.ts
/**
 * Genera una variable aleatoria con distribución t-Student (aproximación)
 */
function randomT(df: number): number {
  const u = Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); // normal estándar
  const chi2 = -2 * Math.log(v); // aproximación a chi-cuadrado con 2 df (para simplificar)
  return z / Math.sqrt(chi2 / df);
}

/**
 * Simulación Monte Carlo con distribución t-Student y aportes mensuales.
 * @param currentValue Valor inicial de la cartera (incluye efectivo)
 * @param monthlyContribution Aporte mensual
 * @param years Horizonte en años
 * @param muAnnual Rentabilidad esperada anual
 * @param volAnnual Volatilidad anual
 * @param df Grados de libertad para t-Student (menor = colas más pesadas, típicamente 5)
 * @param nSims Número de simulaciones
 * @returns Objeto con resultados, probabilidad y percentiles 5, 50, 95
 */
export function monteCarloInstitutional(
  currentValue: number,
  monthlyContribution: number,
  years: number,
  muAnnual: number,
  volAnnual: number,
  df: number = 5,
  nSims: number = 2000
): {
  results: number[];
  probability: number;
  p5: number;
  p50: number;
  p95: number;
} {
  const months = years * 12;
  const monthlyMu = muAnnual / 12;
  const monthlyVol = volAnnual / Math.sqrt(12);
  const results: number[] = [];

  for (let sim = 0; sim < nSims; sim++) {
    let value = currentValue;
    for (let m = 0; m < months; m++) {
      const shock = randomT(df);
      const ret = monthlyMu + monthlyVol * shock;
      value = value * (1 + ret) + monthlyContribution;
    }
    results.push(value);
  }

  const sorted = [...results].sort((a, b) => a - b);
  const probability = results.filter(v => v >= 150000).length / nSims;

  return {
    results,
    probability,
    p5: sorted[Math.floor(0.05 * nSims)],
    p50: sorted[Math.floor(0.5 * nSims)],
    p95: sorted[Math.floor(0.95 * nSims)]
  };
}