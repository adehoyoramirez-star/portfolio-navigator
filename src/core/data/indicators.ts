// src/core/data/indicators.ts
// FIX MATH-NEW-01: calculateRSI ahora usa Wilder's Smoothed Moving Average
// El RSI estándar (J. Welles Wilder, 1978) usa EMA con factor α = 1/period,
// NO una Simple Moving Average.
//
// ALGORITMO CORRECTO (Wilder's Smoothed EMA):
//   1. Calcular el SMA de los primeros `period` cambios (seed)
//   2. Para cada período siguiente:
//      avgGain = (prevAvgGain × (period - 1) + currentGain) / period
//      avgLoss = (prevAvgLoss × (period - 1) + currentLoss) / period
//
// Esto elimina la divergencia de 8-12 puntos respecto a TradingView/Bloomberg.
// Las señales de SmartDCA basadas en RSI < 35 son ahora compatibles con
// fuentes externas — el usuario puede verificar la señal en cualquier plataforma.

export function calculateRSI(prices: number[], period: number = 14): number {
  // Necesitamos al menos (period + 1) precios para el seed + 1 período de confirmación
  if (prices.length < period + 1) return 50;

  // Calcular todos los cambios diarios
  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  // Si no hay suficientes cambios para el seed period, devolver neutral
  if (changes.length < period) return 50;

  // PASO 1: Seed — SMA simple de los primeros `period` cambios
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // PASO 2: Wilder's Smoothed EMA para los cambios restantes
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    // Wilder's: avgGain = (prevAvgGain × (period - 1) + currentGain) / period
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  // RS y RSI finales
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calculateZScore(prices: number[], period: number = 200): number {
  if (prices.length < period) return 0;
  const recent = prices.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  const current = prices[prices.length - 1];
  return (current - mean) / stdDev;
}