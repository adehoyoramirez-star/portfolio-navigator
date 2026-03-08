// ===============================================
// CVaR — Conditional Value at Risk (Expected Shortfall)
// ===============================================
// El VaR tradicional dice: "en el peor 5% de escenarios, pierdes al menos X"
// El CVaR dice: "en el peor 5% de escenarios, pierdes de MEDIA X"
// CVaR es más honesto porque captura la cola completa, no solo el umbral.
//
// Reguladores financieros (Basel III/IV) exigen CVaR sobre VaR precisamente
// porque el VaR ignora cuán catastrófico puede ser lo catastrófico.
//
// Ejemplo real:
//   Distribución A: 95 escenarios de +5%, 5 escenarios de -10%  → VaR = -10%, CVaR = -10%
//   Distribución B: 95 escenarios de +5%, 4 de -10%, 1 de -50%  → VaR = -10%, CVaR = -18%
//   El VaR no distingue A de B. El CVaR sí.
// ===============================================

export interface CVaRResult {
  var95: number;          // Value at Risk al 95% (peor 5% umbral) — en decimal, ej: -0.12
  cvar95: number;         // CVaR al 95% (media del peor 5%) — siempre ≤ var95
  var99: number;          // VaR al 99% (peor 1% umbral)
  cvar99: number;         // CVaR al 99% — el más relevante para stress institutcional
  expectedShortfall: number; // Alias de cvar95 — nombre regulatorio (Basel)
  tailRatio: number;      // cvar95 / var95 — ratio > 1.5 indica cola muy pesada (fat tail)
}

/**
 * Calcula CVaR a partir de los resultados del Monte Carlo.
 * Recibe el array de valores finales del portfolio (ya ordenados o no).
 *
 * @param simResults  Array de multiplicadores finales (ej: 2.3 = +130%, 0.4 = -60%)
 * @param confidence  Nivel de confianza (default 0.95 = percentil 5% de peores escenarios)
 */
export function calculateCVaR(
  simResults: number[],
  confidence = 0.95
): CVaRResult {
  // Convertir multiplicadores a retornos (2.3 → +130%, 0.4 → -60%)
  const returns = simResults.map(r => r - 1);
  const sorted  = [...returns].sort((a, b) => a - b);
  const n       = sorted.length;

  // VaR 95% — el retorno en el percentil 5 (umbral del peor 5%)
  const var95Idx  = Math.floor(n * (1 - confidence));       // índice percentil 5
  const var95     = sorted[var95Idx];

  // CVaR 95% — media de todos los retornos peores que el VaR95
  const tail95    = sorted.slice(0, var95Idx + 1);
  const cvar95    = tail95.reduce((a, b) => a + b, 0) / tail95.length;

  // VaR 99% — percentil 1
  const var99Idx  = Math.floor(n * 0.01);
  const var99     = sorted[var99Idx];

  // CVaR 99% — media del peor 1% — el número que más impacta a gestores de riesgo
  const tail99    = sorted.slice(0, var99Idx + 1);
  const cvar99    = tail99.length > 0
    ? tail99.reduce((a, b) => a + b, 0) / tail99.length
    : var99;

  // Tail ratio — cuánto peor es la media del peor 5% vs el umbral
  // ratio cercano a 1.0 = cola ligera (distribución normal)
  // ratio > 1.5 = cola pesada (BTC-like, fat tails)
  const tailRatio = var95 !== 0 ? Math.abs(cvar95 / var95) : 1;

  return {
    var95,
    cvar95,
    var99,
    cvar99,
    expectedShortfall: cvar95,  // nombre regulatorio Basel
    tailRatio,
  };
}

/**
 * CVaR en términos de capital absoluto (euros).
 * Útil para mostrar al usuario "en el peor 5% perderías de media €X"
 */
export function calculateCVaRAbsolute(
  simResults: number[],
  initialCapital: number,
  monthlyContribution: number,
  years: number
): {
  cvar95Euros: number;
  cvar99Euros: number;
  var95Euros: number;
  totalInvested: number;
  cvarRatio: CVaRResult;
} {
  const totalInvested = initialCapital + monthlyContribution * 12 * years;
  const cvarRatio = calculateCVaR(simResults);

  // Los simResults son multiplicadores sobre el capital inicial + aportes
  // Para calcular el valor final absoluto en euros usamos los percentiles directos
  const finalValues = simResults.map(r => r * initialCapital + monthlyContribution * 12 * years);
  const sorted = [...finalValues].sort((a, b) => a - b);
  const n = sorted.length;

  const var95AbsValue  = sorted[Math.floor(n * 0.05)];
  const cvar95AbsValue = sorted.slice(0, Math.floor(n * 0.05) + 1)
    .reduce((a, b) => a + b, 0) / Math.floor(n * 0.05 + 1);
  const cvar99AbsValue = sorted.slice(0, Math.floor(n * 0.01) + 1)
    .reduce((a, b) => a + b, 0) / Math.floor(n * 0.01 + 1);

  return {
    var95Euros:   var95AbsValue,
    cvar95Euros:  cvar95AbsValue,
    cvar99Euros:  cvar99AbsValue,
    totalInvested,
    cvarRatio,
  };
}