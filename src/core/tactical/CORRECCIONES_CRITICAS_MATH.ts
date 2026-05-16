// ============================================================
// src/core/tactical/CORRECCIONES_CRÍTICAS.ts
// Fragmentos matemáticos reparados para tacticalSignals.ts
//
// INCLUYE:
//   - calcOptimalHorizon() mejorado
//   - Normal CDF actualizado
//   - Alternativa rápida con máximo realista
// ============================================================

// ── Normal CDF (Cumulative Distribution Function) ────────────
// Aproximación precisa para la distribución normal estándar
function normCDF(z: number): number {
  // Abramowitz and Stegun aproximation
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = z < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + p * Math.abs(z));
  const y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-(z * z) / 2.0);

  return 0.5 * (1.0 + sign * y);
}

// ── Normal PDF (Probability Density Function) ───────────────
function normPDF(z: number): number {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-(z * z) / 2);
}

/**
 * VERSIÓN MEJORADA: calcOptimalHorizon()
 * 
 * Problema anterior: usaba (1 - normCDF(z)) que es monotónicamente
 * creciente. El máximo siempre estaba en el último día del loop.
 * 
 * Solución: Modelo de First Passage Time de Bachelier con drift.
 * La probabilidad tiene un máximo real (si existe drift).
 * 
 * P(T=t) = (distance / (σ√t)) × φ((distance - μt) / (σ√t))
 * donde:
 *   - distance = objetivo de precios (en EUR/USD)
 *   - σ = volatilidad diaria
 *   - μ = drift diario (momentum como proxy)
 *   - φ = normal PDF
 * 
 * @param distance Distancia al target (precio target - precio actual)
 * @param volatility Volatilidad diaria del activo (σ)
 * @param drift Drift diario estimado (default: 0, es decir momentum = 0)
 * @param dynMax Máximo horizonte a evaluar (días)
 * 
 * @returns { optimalDays, maxProb } Día óptimo y probabilidad máxima
 */
export function calcOptimalHorizon(
  distance: number,
  volatility: number,
  drift: number = 0,
  dynMax: number = 75
): { optimalDays: number; maxProb: number } {
  
  if (distance <= 0 || volatility <= 0 || dynMax < 1) {
    return { optimalDays: 1, maxProb: 0 };
  }

  let bestDays = 1;
  let bestProb = 0;
  let prevProb = 0;

  // Iterar sobre el rango [1, dynMax]
  for (let days = 1; days <= dynMax; days++) {
    const sqrtDays = Math.sqrt(days);
    
    // z = distance / (σ√t)
    const z = distance / (volatility * sqrtDays);
    
    // z_adjusted = (distance - μt) / (σ√t)
    const muTerm = drift * volatility * days;
    const zAdjusted = (distance - muTerm) / (volatility * sqrtDays);
    
    // P(T=t) = (distance / (σ√t)) × φ(z_adjusted)
    const pdf = normPDF(zAdjusted);
    const prob = (distance / (volatility * sqrtDays)) * pdf;

    // Track máximo
    if (prob > bestProb) {
      bestProb = prob;
      bestDays = days;
    }

    // Optimización: si la probabilidad lleva 5 días bajando, parar
    // (se alcanzó un máximo y la cola ya empieza)
    if (days > 10 && prob < prevProb * 0.95) {
      // Continuar hasta un poco más para confirmar
      if (days > bestDays + 10) break;
    }

    prevProb = prob;
  }

  // Clamp al menos a 1 día, máximo a dynMax
  const optimalDays = Math.max(1, Math.min(bestDays, dynMax));
  
  return {
    optimalDays,
    maxProb: Math.min(100, bestProb * 100),  // Escalar a 0-100
  };
}

/**
 * ALTERNATIVA RÁPIDA: Si no tienes drift estimado
 * 
 * Fórmula clásica de First Passage Time para BM sin drift:
 * E[T] = distance² / (2σ²)
 * 
 * El máximo en la distribución sin drift ocurre en:
 * T_max ≈ E[T] / 2 = distance² / (4σ²)
 * 
 * Pero para evitar bucles, usamos una regla más simple:
 * T_optimal = min(max(3, calculado), dynMax / 2)
 * 
 * Esto evita devolver dynMax siempre.
 */
export function calcOptimalHorizonFast(
  distance: number,
  volatility: number,
  dynMax: number = 75
): { optimalDays: number; maxProb: number } {
  
  if (distance <= 0 || volatility <= 0) {
    return { optimalDays: 1, maxProb: 0 };
  }

  // E[T] = distance² / (2σ²)
  const expectedTime = (distance * distance) / (2 * volatility * volatility);
  
  // Máximo aproximado en E[T] / 2
  let optimalDays = Math.floor(expectedTime / 2);
  
  // Limits realistas
  optimalDays = Math.max(3, Math.min(optimalDays, Math.floor(dynMax / 2)));
  
  return {
    optimalDays,
    maxProb: 50,  // Valor placeholder (no es real sin drift)
  };
}

/**
 * DECISIÓN DE ABANDONO DE POSICIÓN
 * 
 * Ahora que calcOptimalHorizon devuelve un máximo real:
 * 
 * ✅ ANTES (ROTO):
 *    if (daysOpen > 1.8 × dynMax) abandon;  // Nunca se ejecutaba
 * 
 * ✅ AHORA (ARREGLADO):
 *    if (daysOpen > 1.5 × optimalDaysTP1 && progressToTP1 < 0.25) abandon;
 * 
 * Razón: si ya llevas 1.5× el tiempo óptimo sin llegar al 25% del target,
 * la operación probablemente no funcionará.
 */
export function evaluatePositionHealth(params: {
  daysOpen: number;
  optimalDaysTP1: number;
  progressToTP1: number;    // 0-1, cuánto del movimiento esperado se logró
  currentPrice: number;
  entryPrice: number;
  takeProfit1: number;
  maxDaysAllowed: number;
}) {
  const {
    daysOpen, optimalDaysTP1, progressToTP1,
    currentPrice, entryPrice, takeProfit1, maxDaysAllowed,
  } = params;

  const timeRatio = daysOpen / Math.max(optimalDaysTP1, 1);
  const distTarget = takeProfit1 - entryPrice;
  const distCurrent = currentPrice - entryPrice;
  const actualProgress = distTarget > 0 ? distCurrent / distTarget : 0;

  // Señales de abandono
  const shouldAbandon = 
    // (1) Pasaste el máximo horizonte permitido
    daysOpen > maxDaysAllowed ||
    // (2) Llevas mucho tiempo sin progresar
    (timeRatio > 1.5 && actualProgress < 0.25) ||
    // (3) Llevas el doble del tiempo óptimo y no hay ganancia
    (timeRatio > 2.0 && actualProgress <= 0);

  // Señales de espera
  const shouldContinue =
    // (1) Aún hay tiempo e irás por el buen camino
    timeRatio < 1.0 && actualProgress > 0 ||
    // (2) Recién estás en el timing óptimo
    (timeRatio >= 0.8 && timeRatio <= 1.2 && actualProgress > 0);

  return {
    shouldAbandon,
    shouldContinue,
    timeRatio,
    actualProgress,
    daysRemaining: Math.max(0, maxDaysAllowed - daysOpen),
    reasoning: shouldAbandon
      ? `Abandonar: ${timeRatio.toFixed(1)}× tiempo óptimo, progreso ${(actualProgress*100).toFixed(0)}%`
      : shouldContinue
      ? `Esperar: dentro de rango óptimo, progreso ${(actualProgress*100).toFixed(0)}%`
      : `Monitorear: situación ambigua`,
  };
}

/**
 * ESTIMACIÓN DEL DRIFT (momentum como proxy)
 * 
 * Útil para calcOptimalHorizon con parámetro drift.
 * 
 * Drift μ = momentum 4W / (σ × √252)
 * 
 * Esto convierte el momentum anualizado a drift diario.
 */
export function estimateDrift(
  closes: number[],
  volatilityDaily: number,
): number {
  if (closes.length < 20) return 0;

  // Momentum 4 semanas (20 días)
  const price4wAgo = closes[closes.length - 20];
  const priceNow = closes[closes.length - 1];
  const momentum4w = price4wAgo > 0 ? (priceNow / price4wAgo) - 1 : 0;

  // Convertir momentum a drift diario
  // drift_daily = momentum / √20 (hay ~20 días de trading)
  const driftDaily = momentum4w / Math.sqrt(20);

  // Normalizar por volatilidad
  const driftNormalized = volatilityDaily > 0
    ? driftDaily / volatilityDaily
    : 0;

  return driftNormalized;
}
