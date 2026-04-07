// ===============================================
// ARCHIVO: src/core/crypto/btcCycleOverlay.ts
// OLYMPUS V4.1 PRO — BTC Cycle Integration
// ===============================================
// Este módulo convierte señales on-chain (MVRV, Puell, RSI semanal)
// en un score numérico [0, 1] que alimenta el motor de decisiones.
//
// Según spec V4.1 PRO:
//   "el edge viene del BTC cycle + DCA contracíclico"
//   "BTC domina, pero no rompe el sistema"
// ===============================================

export interface BTCCycleInput {
  // On-chain metrics (manuales o desde API)
  mvrvRatio?: number;       // MVRV Z-score o ratio actual
  puellMultiple?: number;   // Puell Multiple actual
  rsiWeekly?: number;       // RSI semanal de BTC

  // Opcionales para contexto adicional
  btcPrice?: number;        // Precio actual para power law bands
  daysSinceHalving?: number; // Días desde último halving
}

export interface BTCCycleOutput {
  btcScore: number;         // Score crudo [0, 100]
  btcNumeric: number;       // Score normalizado [0, 1] para fórmula core
  signal: 'STRONG_BUY' | 'BUY' | 'ACCUMULATE' | 'HOLD' | 'REDUCE';
  breakdown: {
    mvrvScore: number;      // Contribución de MVRV [0, 35]
    puellScore: number;     // Contribución de Puell [0, 30]
    rsiScore: number;       // Contribución de RSI [0, 25]
  };
  boostActive: boolean;     // true si MVRV<1.5 Y Puell<1 → multiplicador 1.4x
  description: string;
}

// ===============================================
// SCORING SEGÚN SPEC V4.1 PRO
// ===============================================
// MVRV: <1.5: +35, 1.5-2.5: +20, >2.5: 0
// Puell: <1: +30, 1-2: +15, >2: 0
// RSI:   <40: +25, 40-60: +10, >60: 0
// ===============================================

function scoreMvrv(mvrv?: number): number {
  if (mvrv === undefined || mvrv === null) return 17; // neutral (mid-range)

  if (mvrv < 1.5) return 35;      // Zona de acumulación extrema
  if (mvrv < 2.5) return 20;      // Zona neutral
  return 0;                        // Sobrevalorado
}

function scorePuell(puell?: number): number {
  if (puell === undefined || puell === null) return 15; // neutral

  if (puell < 1) return 30;       // Capitulación minera
  if (puell < 2) return 15;       // Neutral
  return 0;                        // Euforia
}

function scoreRsi(rsiWeekly?: number): number {
  if (rsiWeekly === undefined || rsiWeekly === null) return 17; // neutral

  if (rsiWeekly < 40) return 25;  // Oversold semanal
  if (rsiWeekly < 60) return 10;  // Neutral
  return 0;                        // Overbought
}

function determineSignal(btcScore: number, boostActive: boolean): BTCCycleOutput['signal'] {
  // Con boost activo, upgrading de señal
  if (boostActive) {
    if (btcScore >= 70) return 'STRONG_BUY';
    if (btcScore >= 55) return 'BUY';
    return 'ACCUMULATE';
  }

  // Sin boost, thresholds normales
  if (btcScore >= 80) return 'STRONG_BUY';
  if (btcScore >= 60) return 'BUY';
  if (btcScore >= 40) return 'ACCUMULATE';
  if (btcScore >= 25) return 'HOLD';
  return 'REDUCE';
}

/**
 * Calcula el score de ciclo BTC según spec V4.1 PRO.
 *
 * La fórmula core del motor usa btcNumeric (0-1):
 *   final_score = 0.35*regime + 0.45*btc_numeric + 0.20*risk
 *
 * El boost se aplica cuando MVRV<1.5 Y Puell<1 (zona de acumulación histórica).
 */
export function computeBTCCycleOverlay(input: BTCCycleInput): BTCCycleOutput {
  const mvrvScore = scoreMvrv(input.mvrvRatio);
  const puellScore = scorePuell(input.puellMultiple);
  const rsiScore = scoreRsi(input.rsiWeekly);

  const btcScore = mvrvScore + puellScore + rsiScore; // [0, 100]
  const btcNumeric = btcScore / 100; // [0, 1]

  // Boost activo: MVRV < 1.5 Y Puell < 1
  const boostActive = (input.mvrvRatio !== undefined && input.mvrvRatio < 1.5) &&
                      (input.puellMultiple !== undefined && input.puellMultiple < 1);

  const signal = determineSignal(btcScore, boostActive);

  // Descripción contextual
  let description = `BTC Score: ${btcScore}/100. `;
  if (boostActive) {
    description += '⚡ BOOST ACTIVO: MVRV<1.5 y Puell<1 — zona de acumulación histórica. ';
  }

  if (mvrvScore === 35) description += 'MVRV en zona de valor extremo. ';
  else if (mvrvScore === 20) description += 'MVRV neutral. ';
  else if (mvrvScore === 0) description += 'MVRV sobrevalorado. ';

  if (puellScore === 30) description += 'Puell en capitulación minera. ';
  else if (puellScore === 15) description += 'Puell neutral. ';
  else if (puellScore === 0) description += 'Puell en euforia. ';

  if (rsiScore === 25) description += 'RSI semanal oversold. ';
  else if (rsiScore === 10) description += 'RSI semanal neutral. ';
  else if (rsiScore === 0) description += 'RSI semanal overbought. ';

  return {
    btcScore,
    btcNumeric,
    signal,
    breakdown: {
      mvrvScore,
      puellScore,
      rsiScore,
    },
    boostActive,
    description,
  };
}

// ===============================================
// DCA MULTIPLIER SEGÚN RÉGIMEN + BOOST BTC
// ===============================================
// Spec V4.1 PRO:
//   CRISIS: 60% invest, weekly
//   CONTRACTION: 35% invest, biweekly
//   EXPANSION: 15% invest, monthly
//
// Boost BTC: si MVRV<1.5 AND Puell<1 → invest_multiplier = 1.4
// ===============================================

export interface DCAMultiplierInput {
  regime: 'EXPANSION' | 'CONTRACTION' | 'CRISIS';
  btcCycle?: BTCCycleOutput;
}

export interface DCAMultiplierOutput {
  dcaIntensity: number;       // % de capital a invertir [0.15, 0.60]
  frequency: 'weekly' | 'biweekly' | 'monthly';
  boostMultiplier: number;    // 1.4 si boost activo, 1.0 si no
  effectiveIntensity: number; // dcaIntensity × boostMultiplier
}

export function computeDCAMultiplier(input: DCAMultiplierInput): DCAMultiplierOutput {
  // Intensidad base por régimen
  let dcaIntensity: number;
  let frequency: 'weekly' | 'biweekly' | 'monthly';

  switch (input.regime) {
    case 'CRISIS':
      dcaIntensity = 0.60;
      frequency = 'weekly';
      break;
    case 'CONTRACTION':
      dcaIntensity = 0.35;
      frequency = 'biweekly';
      break;
    case 'EXPANSION':
      dcaIntensity = 0.15;
      frequency = 'monthly';
      break;
  }

  // Boost multiplier
  const boostMultiplier = input.btcCycle?.boostActive ? 1.4 : 1.0;
  const effectiveIntensity = dcaIntensity * boostMultiplier;

  return {
    dcaIntensity,
    frequency,
    boostMultiplier,
    effectiveIntensity,
  };
}
