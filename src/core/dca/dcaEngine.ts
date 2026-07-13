import type { BTCCycleOutput } from '../crypto/btcCycleOverlay';

export type PortfolioRegime = 'EXPANSION' | 'CONTRACTION' | 'CRISIS' | 'ALL_CASH';

export interface DCAEngineInput {
  regime: PortfolioRegime;
  btcCycle?: BTCCycleOutput;
  portfolioVolatility?: number;
  availableCash: number;
  totalPortfolioValue: number;
  // FIX-DCA-2: añadido portfolioDrawdown para activar boost solo en recuperación real
  portfolioDrawdown?: number;
}

export interface DCAEngineOutput {
  investAmount: number;
  investPercent: number;
  baseIntensity: number;
  boostMultiplier: number;
  effectiveIntensity: number;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'none';
  frequencyDays: number;
  riskConstraintActive: boolean;
  riskConstraintReason: string;
  // FIX-DCA-3: añadido flag explícito cuando cash limita la inversión
  cashConstrained: boolean;
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORIAL DE FIXES:
//
// FIX-BUG-3 (auditoría anterior): PANIC_VOLATILITY era 0.04 (vol DIARIA).
//   portfolioVolatility siempre se pasa como vol ANUALIZADA (e.g. 0.18 = 18%).
//   0.18 > 0.04 = TRUE → modo pánico PERMANENTE → vendía 30% del portafolio siempre.
//   CORRECCIÓN: umbral 0.40 (vol anual). Rango normal: 0.14–0.25. Crisis: 0.40+.
//
// FIX-DCA-1: frequency hardcodeada a 'monthly' siempre.
//   La interfaz declara 'weekly'|'biweekly'|'monthly' pero el código devolvía
//   'monthly' en todos los casos, ignorando el régimen y la intensidad.
//   CORRECCIÓN: frecuencia ajustada por régimen → CRISIS mensual, EXPANSION semanal.
//
// FIX-DCA-2: boostMultiplier 3.5× sin validar contexto de recuperación.
//   Condición anterior: regime==='EXPANSION' && btcCycle.boostActive
//   Un portafolio con +30% YTD también activaba el boost → invertir 28% de golpe.
//   CORRECCIÓN: el boost solo se activa si portfolioDrawdown < -5% (recuperación real).
//   Si el portafolio está en máximos, no hay recuperación que impulsar.
//
// FIX-DCA-3: sin distinción entre investAmount=0 por falta de cash vs por totalPortfolio=0.
//   Ambos casos devolvían el mismo output — fallo silencioso difícil de diagnosticar.
//   CORRECCIÓN: flag cashConstrained explícito en el output.
// ─────────────────────────────────────────────────────────────────────────────

const DCA_CONFIG = {
  INTENSITY: {
    CRISIS:      0.02,
    CONTRACTION: 0.05,
    EXPANSION:   0.08,
    ALL_CASH:    0.00,  // type-safety only: olympusV3 maps ALL_CASH→CRISIS before calling computeDCADecision
  },
  // FIX-DCA-1: frecuencia por régimen (antes hardcodeado a monthly siempre)
  FREQUENCY: {
    CRISIS:      { label: 'monthly',   days: 30 } as const,
    CONTRACTION: { label: 'biweekly',  days: 14 } as const,
    EXPANSION:   { label: 'weekly',    days:  7 } as const,
    ALL_CASH:    { label: 'none',      days:  0 } as const,  // type-safety only (see INTENSITY note)
  },
  ATTACK_MODE: {
    RECOVERY_BOOST:          2.0,  // FIX-DCA-2: reducido de 3.5× → 2.0× (28%→16% max)
    MIN_DRAWDOWN_FOR_BOOST: -0.05, // FIX-DCA-2: boost solo si portafolio en DD real ≥ 5%
  },
  RISK_LIMITS: {
    // FIX-BUG-3: era 0.04 (vol DIARIA calibrado en producción como anualizado).
    // 0.18 (vol anual normal) > 0.04 → pánico SIEMPRE. Umbral correcto: 0.40 anual.
    PANIC_VOLATILITY:  0.40,
    LIQUIDATION_RATIO: 0.30,
  },
} as const;

export function computeDCADecision(input: DCAEngineInput): DCAEngineOutput {
  const {
    regime,
    btcCycle,
    totalPortfolioValue,
    portfolioVolatility,
    availableCash,
    portfolioDrawdown = 0,
  } = input;

  // ── GUARDIA: vol pánico ──────────────────────────────────────────────────
  // FIX-BUG-3: portfolioVolatility es vol anualizada. PANIC_VOLATILITY = 0.40.
  // Antes: 0.04 → cualquier portafolio normal (vol 14-25%) activaba venta de emergencia.
  // FIX-AUDIT-R2 N5: isPanic ahora default a 0.15 (vol normal máxima) si undefined.
  // ANTES: ?? 0 -> 0>0.40=false -> panic SIEMPRE off durante data outage -> motor sigue
  // comprando sin freno de volatilidad. Ahora: si falta dato, asume vol normal
  // (no dispara panic pero tampoco admite el falso "todo OK"). Log warn para trazabilidad.
  const usedFallbackVol = portfolioVolatility === undefined;
  // FIX-AUDIT-R2 N5 v2: console.warn solo en runtime real (NO test ni backtest).
  // El backtest invoca esta función ~250 veces por run; sin gating serían 250 warns idnticos.
  // Asume process.env NODE_ENV disponible (Vite, Deno, Node.js). La producción siempre emite; tests/CLI no.
  if (usedFallbackVol && typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'test') {
    console.warn('[DCA] portfolioVolatility undefined → asumiendo 15% anual como fallback');
  }
  const effectiveVol = portfolioVolatility ?? 0.15;
  const isPanic = effectiveVol > DCA_CONFIG.RISK_LIMITS.PANIC_VOLATILITY;

  if (isPanic && totalPortfolioValue > 100) {
    const sellAmount = totalPortfolioValue * DCA_CONFIG.RISK_LIMITS.LIQUIDATION_RATIO;
    return {
      investAmount:         -sellAmount,
      investPercent:        -DCA_CONFIG.RISK_LIMITS.LIQUIDATION_RATIO,
      baseIntensity:         0,
      boostMultiplier:       0,
      effectiveIntensity:    0,
      frequency:            'monthly',
      frequencyDays:         30,
      riskConstraintActive:  true,
      cashConstrained:       false,
      riskConstraintReason: `🚨 VENTA DE EMERGENCIA — vol ${(effectiveVol * 100).toFixed(0)}% > umbral ${(DCA_CONFIG.RISK_LIMITS.PANIC_VOLATILITY * 100).toFixed(0)}%`,
      description:          `Liquidando ${(DCA_CONFIG.RISK_LIMITS.LIQUIDATION_RATIO * 100).toFixed(0)}% por volatilidad extrema (${(effectiveVol * 100).toFixed(0)}% anual).`,
    };
  }

  // ── INTENSIDAD BASE ──────────────────────────────────────────────────────
  const baseIntensity = DCA_CONFIG.INTENSITY[regime] ?? 0.05;

  // ── BOOST (FIX-DCA-2) ────────────────────────────────────────────────────
  // Antes: boost si regime=EXPANSION && btcCycle.boostActive (sin importar si hay DD real)
  // Ahora: además se requiere que el portafolio esté en drawdown real (recuperación activa)
  const inRecovery = portfolioDrawdown <= DCA_CONFIG.ATTACK_MODE.MIN_DRAWDOWN_FOR_BOOST;
  const boostActive = regime === 'EXPANSION' && (btcCycle?.boostActive ?? false) && inRecovery;
  const boostMultiplier = boostActive ? DCA_CONFIG.ATTACK_MODE.RECOVERY_BOOST : 1.0;

  const effectiveIntensity = baseIntensity * boostMultiplier;

  // ── AMOUNT ───────────────────────────────────────────────────────────────
  const targetAmount   = totalPortfolioValue * effectiveIntensity;
  const investAmount   = Math.min(targetAmount, availableCash);
  // FIX-DCA-3: flag explícito cuando el cash limita la inversión
  const cashConstrained = availableCash < targetAmount && availableCash >= 0;

  // ── FRECUENCIA (FIX-DCA-1) ───────────────────────────────────────────────
  // Antes: siempre 'monthly' / 30 días, ignorando el régimen.
  // Ahora: ajustado por régimen. CRISIS mensual (bajo riesgo DCA), EXPANSION semanal.
  const freqConfig = DCA_CONFIG.FREQUENCY[regime] ?? DCA_CONFIG.FREQUENCY.CONTRACTION;

  // ── DESCRIPTION ─────────────────────────────────────────────────────────
  let description: string;
  if (boostActive) {
    description = `Modo recuperación activo: DCA acelerado ${(effectiveIntensity * 100).toFixed(0)}% en ${freqConfig.label} (DD ${(portfolioDrawdown * 100).toFixed(1)}%).`;
  } else if (cashConstrained) {
    description = `Inversión limitada por cash disponible (€${availableCash.toFixed(0)} de €${targetAmount.toFixed(0)} objetivo).`;
  } else {
    const labels: Record<PortfolioRegime, string> = {
      EXPANSION:   `Inversión estándar expansión: ${(effectiveIntensity * 100).toFixed(0)}% ${freqConfig.label}.`,
      CONTRACTION: `Inversión defensiva contracción: ${(effectiveIntensity * 100).toFixed(0)}% ${freqConfig.label}.`,
      CRISIS:      `Inversión mínima crisis: ${(effectiveIntensity * 100).toFixed(0)}% ${freqConfig.label}.`,
      ALL_CASH:    `Inversión nula — motor en ALL_CASH (sin exposición).`,  // type-safety only (see INTENSITY note)
    };
    description = labels[regime];
  }

  return {
    investAmount,
    investPercent:        totalPortfolioValue > 0 ? investAmount / totalPortfolioValue : 0,
    baseIntensity,
    boostMultiplier,
    effectiveIntensity,
    frequency:            freqConfig.label,
    frequencyDays:        freqConfig.days,
    riskConstraintActive: false,
    cashConstrained,
    riskConstraintReason: cashConstrained
      ? `Cash insuficiente: €${availableCash.toFixed(0)} disponible, €${targetAmount.toFixed(0)} objetivo`
      : 'Normal',
    description,
  };
}
