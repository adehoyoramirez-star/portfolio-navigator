// ============================================================
// src/core/quant/capitalAllocator.ts
// Capital Allocation Layer — quien manda el dinero y cuándo
// Decide dinámicamente cuánto va a Olympus vs Motor Táctico
// ============================================================

export type AllocationState =
  | 'AGGRESSIVE'          // Mercado bueno, táctico funcionando
  | 'BALANCED'            // Condiciones normales
  | 'DEFENSIVE'           // Incertidumbre, reducir riesgo
  | 'CAPITAL_PRESERVATION'; // Drawdown activo, proteger todo

export interface CapitalAllocation {
  olympusWeight:    number;  // % del capital total para Olympus
  tacticalWeight:   number;  // % del capital total para Táctico
  riskMultiplier:   number;  // Escalar tamaño de posición
  state:            AllocationState;
  reason:           string;
  // Distribución real en euros
  olympusEur:       number;
  tacticalEur:      number;
  riskPerTradeEur:  number;
}

export interface AllocationInput {
  regime:               string;   // Del marketRegimeFilter
  vix:                  number;
  tacticalWinRate:      number;   // Win rate reciente (últimos 10 trades)
  tacticalConsecLosses: number;   // Pérdidas consecutivas actuales
  olympusDrawdown:      number;   // Drawdown actual Olympus (0.05 = -5%)
  tacticalDrawdown:     number;   // Drawdown actual motor táctico
  totalCapital:         number;   // Capital total disponible
  baseRiskPct:          number;   // Riesgo base por trade (0.01 = 1%)
  defensiveLiquidity:   number;   // Liquidez defensiva acumulada
}

// ════════════════════════════════════════════════════════════
// LÓGICA PRINCIPAL — jerárquica, de más crítico a menos
// ════════════════════════════════════════════════════════════
export function computeAllocation(input: AllocationInput): CapitalAllocation {
  const {
    regime, vix, tacticalWinRate, tacticalConsecLosses,
    olympusDrawdown, tacticalDrawdown, totalCapital,
    baseRiskPct, defensiveLiquidity,
  } = input;

  // ── NIVEL 0: Protección máxima ─────────────────────────
  // Drawdown combinado > 20% → modo supervivencia
  if (olympusDrawdown > 0.20 || tacticalDrawdown > 0.25) {
    return build('CAPITAL_PRESERVATION', 0.95, 0.05, 0.4,
      `Drawdown crítico (Olympus -${(olympusDrawdown*100).toFixed(0)}% / Táctico -${(tacticalDrawdown*100).toFixed(0)}%). Motor táctico casi parado.`,
      totalCapital, baseRiskPct, defensiveLiquidity);
  }

  // ── NIVEL 1: Performance decay del motor táctico ───────
  // 5+ pérdidas consecutivas → reduce capital táctico
  if (tacticalConsecLosses >= 5) {
    return build('DEFENSIVE', 0.85, 0.15, 0.5,
      `${tacticalConsecLosses} pérdidas consecutivas en motor táctico. Capital táctico reducido al 15% hasta recuperar.`,
      totalCapital, baseRiskPct, defensiveLiquidity);
  }

  // ── NIVEL 2: Mercado peligroso ─────────────────────────
  if (vix > 30 || regime === 'CRASH') {
    return build('DEFENSIVE', 0.80, 0.20, 0.6,
      `VIX=${vix.toFixed(1)} > 30 o régimen CRASH. Motor táctico solo con Blood in Streets de máximo score.`,
      totalCapital, baseRiskPct, defensiveLiquidity);
  }

  // ── NIVEL 3: Mercado incierto ──────────────────────────
  if (vix > 22 || regime === 'TRENDING_DOWN') {
    return build('DEFENSIVE', 0.80, 0.20, 0.75,
      `VIX elevado (${vix.toFixed(1)}) o tendencia bajista. Precaución aumentada.`,
      totalCapital, baseRiskPct, defensiveLiquidity);
  }

  // ── NIVEL 4: Mercado alcista + táctico funcionando ─────
  if (regime === 'TRENDING_UP' && tacticalWinRate > 55 && tacticalConsecLosses === 0) {
    return build('AGGRESSIVE', 0.65, 0.35, 1.2,
      `Mercado alcista + táctico con ${tacticalWinRate.toFixed(0)}% win rate. Aumentando exposición táctica.`,
      totalCapital, baseRiskPct, defensiveLiquidity);
  }

  // ── NIVEL 5: Condiciones normales ──────────────────────
  return build('BALANCED', 0.75, 0.25, 1.0,
    'Condiciones de mercado normales. Asignación estándar 75/25.',
    totalCapital, baseRiskPct, defensiveLiquidity);
}

function build(
  state:         AllocationState,
  olympusW:      number,
  tacticalW:     number,
  riskMult:      number,
  reason:        string,
  total:         number,
  baseRisk:      number,
  defLiq:        number,
): CapitalAllocation {
  // Capital táctico = min(% del total asignado, 20% de la liquidez defensiva)
  const tacticalFromTotal = total * tacticalW;
  const tacticalFromDefLiq = defLiq * 0.20;
  const tacticalEur = Math.min(tacticalFromTotal, tacticalFromDefLiq > 0 ? tacticalFromDefLiq : tacticalFromTotal);

  return {
    state, reason,
    olympusWeight:   olympusW,
    tacticalWeight:  tacticalW,
    riskMultiplier:  riskMult,
    olympusEur:      total * olympusW,
    tacticalEur,
    riskPerTradeEur: tacticalEur * baseRisk * riskMult,
  };
}

// ── Paleta de colores por estado ──────────────────────────────
export const STATE_COLORS: Record<AllocationState, string> = {
  AGGRESSIVE:          '#22c55e',
  BALANCED:            '#3b82f6',
  DEFENSIVE:           '#f59e0b',
  CAPITAL_PRESERVATION:'#ef4444',
};

export const STATE_LABELS: Record<AllocationState, string> = {
  AGGRESSIVE:          '🚀 Agresivo',
  BALANCED:            '⚖️ Balanceado',
  DEFENSIVE:           '🛡 Defensivo',
  CAPITAL_PRESERVATION:'🚨 Preservación',
};
