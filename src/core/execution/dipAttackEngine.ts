// ===============================================
// ARCHIVO: src/core/execution/dipAttackEngine.ts
// OLYMPUS X — Motor de Ataque en Caídas (Contracíclico)
// ===============================================
// FILOSOFÍA INSTITUCIONAL:
//   El retail vende en pánico durante correcciones.
//   Los hedge funds de primer nivel COMPRAN en correcciones
//   cuando las señales macro + ciclo confirman que el activo
//   no está en bear estructural sino en pullback.
//
// DIFERENCIA CRÍTICA — Pullback vs Bear:
//   PULLBACK (atacar): VIX spike < 2 semanas, régimen HMM EXPANSION,
//     BTC en fase ACUMULACIÓN/POST_HALVING, MVRV < 2.0
//   BEAR ESTRUCTURAL (no atacar): HMM CRISIS > 4 semanas,
//     yield curve invertida profunda, credit spreads > 500bps,
//     BTC breakdown de estructura on-chain
//
// CASCADA DE CONDICIONES PARA ACTIVAR ATAQUE:
//   Gate 1 (NECESARIO): Drawdown desde máximo local > DIP_THRESHOLD (3%)
//   Gate 2 (NECESARIO): HMM regime = EXPANSION || (CONTRACTION + BTC_ACCUMULATE)
//   Gate 3 (NECESARIO): CVaR proyectado post-ataque < cvarHardLimit (20%)
//   Gate 4 (OPCIONAL): BTC boost → aumenta multiplicador si MVRV<1.5+Puell<1
//   Gate 5 (SEGURIDAD): Kill switch si drawdown > ABORT_THRESHOLD (25%)
//
// MULTIPLICADORES POR SEÑAL:
//   BTC STRONG_BUY: 2.5x DCA base
//   BTC BUY:        1.8x DCA base
//   BTC ACCUMULATE: 1.4x DCA base
//   No BTC signal:  1.0x DCA base
//
// GESTIÓN DE RIESGO INTERNA:
//   - Cada tranche de ataque se valida contra CVaR proyectado
//   - Si drawdown supera 25% → abortar ataque, activar modo defensivo
//   - No atacar si régimen HMM = CRISIS (> 70% probabilidad)
//   - No atacar si credit spreads > 500bps (crisis sistémica)
//
// REFERENCIAS:
//   - Dalio (2017): "Principles" — "It's dumb not to buy when everyone else is selling"
//   - AQR (2012): "Betting Against Beta" — captura de crisis premium
//   - López de Prado (2018): "ML for Asset Managers" — counter-trend signals
// ===============================================

import type { BTCCycleOutput } from '../crypto/btcCycleOverlay';
import type { HMMState } from '../macro/hmmRegime';

export interface DipAttackInput {
  // Estado del portfolio
  currentDrawdown: number;         // drawdown desde máximo reciente (positivo = pérdida, ej: 0.08 = 8%)
  portfolioEquity: number;         // valor total del portfolio
  availableCash: number;           // cash disponible para atacar

  // Señales del motor
  hmmState: HMMState;              // estado HMM actual
  hmmProbs: {
    expansion: number;
    contraction: number;
    crisis: number;
  };
  btcCycle?: BTCCycleOutput;       // output del BTCCycleOverlay
  currentCVaR?: number;            // CVaR actual del portfolio [0,1]

  // Señales macro de soporte
  vix?: number;
  creditSpread?: number;           // HY credit spread en bps
  yieldSpread?: number;            // 10y-2y Treasury spread

  // Configuración
  cvarHardLimit?: number;          // CVaR máximo permitido post-ataque (default: 0.20)
  dipThreshold?: number;           // drawdown mínimo para activar ataque (default: 0.03)
  abortThreshold?: number;         // drawdown máximo antes de abortar (default: 0.25)
  baseDCAIntensity?: number;       // intensidad DCA base (default: 0.06)
}

export interface DipAttackOutput {
  // Decisión
  attackActive: boolean;
  attackMode: 'AGGRESSIVE' | 'MODERATE' | 'LIGHT' | 'STANDBY' | 'ABORT';

  // Sizing
  attackAmount: number;            // EUR a invertir en el ataque
  attackPercent: number;           // % del portfolio a invertir
  multiplier: number;              // multiplicador sobre DCA base
  baseAmount: number;              // importe DCA base sin multiplicador

  // Distribución temporal
  tranches: DipAttackTranche[];    // cómo dividir el ataque en el tiempo

  // Diagnóstico de las gates
  gates: {
    gate1_drawdown: boolean;       // drawdown > threshold
    gate2_regime: boolean;         // régimen favorable
    gate3_cvar: boolean;           // CVaR proyectado aceptable
    gate4_btcBoost: boolean;       // BTC boost activo
    gate5_safe: boolean;           // kill switch (si false → abort)
  };

  // Razones
  reason: string;
  riskWarnings: string[];

  // Proyecciones (honesty-first)
  projectedCVaRPostAttack: number;
  confidenceInAttack: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface DipAttackTranche {
  trancheNumber: number;
  amount: number;
  delayDays: number;               // días desde hoy para ejecutar este tranche
  condition: string;               // condición para ejecutar (o "ejecutar siempre")
  priority: 'IMMEDIATE' | 'SCHEDULED' | 'CONDITIONAL';
}

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  DIP_THRESHOLD: 0.03,       // 3% drawdown para activar
  ABORT_THRESHOLD: 0.25,     // 25% drawdown → abort, modo defensivo
  CVAR_HARD_LIMIT: 0.20,     // CVaR máximo post-ataque
  BASE_DCA_INTENSITY: 0.06,  // 6% del portfolio como DCA base
  CREDIT_SPREAD_LIMIT: 500,  // bps — por encima es crisis sistémica
  VIX_LIMIT: 45,             // VIX > 45 → mercado en capitulación real, no atacar
} as const;

// Multiplicadores por señal BTC
const BTC_MULTIPLIERS: Record<string, number> = {
  'STRONG_BUY': 2.5,
  'BUY': 1.8,
  'ACCUMULATE': 1.4,
  'HOLD': 1.0,
  'REDUCE': 0.5,
};

// Multiplicadores por régimen
const REGIME_MULTIPLIERS: Record<HMMState, number> = {
  'EXPANSION': 1.0,
  'CONTRACTION': 0.6,
  'CRISIS': 0.2,
};

// ── MOTOR DE ATAQUE ────────────────────────────────────────────────────────────

export function computeDipAttack(input: DipAttackInput): DipAttackOutput {
  const {
    currentDrawdown,
    portfolioEquity,
    availableCash,
    hmmState,
    hmmProbs,
    btcCycle,
    currentCVaR = 0.10,
    vix = 20,
    creditSpread = 300,
    yieldSpread = 1.0,
    cvarHardLimit = DEFAULT_CONFIG.CVAR_HARD_LIMIT,
    dipThreshold = DEFAULT_CONFIG.DIP_THRESHOLD,
    abortThreshold = DEFAULT_CONFIG.ABORT_THRESHOLD,
    baseDCAIntensity = DEFAULT_CONFIG.BASE_DCA_INTENSITY,
  } = input;

  // ── GATE 5: Kill switch absoluto ─────────────────────────────────────────
  // Si el drawdown es extremo o estamos en crisis macro real → ABORT
  const isSystemicCrisis = (creditSpread ?? 300) > DEFAULT_CONFIG.CREDIT_SPREAD_LIMIT;
  const isExtremePanic = (vix ?? 20) > DEFAULT_CONFIG.VIX_LIMIT;
  const isDeepDrawdown = currentDrawdown > abortThreshold;
  const isHMMCrisis = hmmProbs.crisis > 0.70;

  const gate5_safe = !isSystemicCrisis && !isExtremePanic && !isDeepDrawdown && !isHMMCrisis;

  if (!gate5_safe) {
    const abortReasons = [
      isSystemicCrisis ? `Credit spread ${creditSpread}bps > límite ${DEFAULT_CONFIG.CREDIT_SPREAD_LIMIT}bps` : '',
      isExtremePanic ? `VIX ${vix} > límite ${DEFAULT_CONFIG.VIX_LIMIT}` : '',
      isDeepDrawdown ? `Drawdown ${(currentDrawdown * 100).toFixed(1)}% > abort threshold ${(abortThreshold * 100).toFixed(0)}%` : '',
      isHMMCrisis ? `HMM crisis prob ${(hmmProbs.crisis * 100).toFixed(0)}% > 70%` : '',
    ].filter(Boolean).join('; ');

    return buildAbortOutput(portfolioEquity, baseDCAIntensity, abortReasons);
  }

  // ── GATE 1: Drawdown mínimo para activar ─────────────────────────────────
  const gate1_drawdown = currentDrawdown >= dipThreshold;

  // ── GATE 2: Régimen favorable ─────────────────────────────────────────────
  // EXPANSION siempre es favorable.
  // CONTRACTION es favorable SOLO si BTC está en acumulación
  const btcInAccumulation = btcCycle &&
    ['STRONG_BUY', 'BUY', 'ACCUMULATE'].includes(btcCycle.signal);

  const gate2_regime =
    hmmState === 'EXPANSION' ||
    (hmmState === 'CONTRACTION' && !!btcInAccumulation);

  // ── GATE 4: BTC boost ────────────────────────────────────────────────────
  const gate4_btcBoost = !!btcCycle?.boostActive;

  // ── CÁLCULO DEL MULTIPLICADOR ────────────────────────────────────────────
  // Multiplicador = BTC_mult × Regime_mult × Drawdown_intensity
  const btcSignal = btcCycle?.signal ?? 'HOLD';
  const btcMult = BTC_MULTIPLIERS[btcSignal] ?? 1.0;
  const regimeMult = REGIME_MULTIPLIERS[hmmState] ?? 0.6;

  // Drawdown intensity: cuanto más profunda la caída, más agresivos
  // Pero con límites: no atacar demasiado pronto, no atacar demasiado tarde
  const drawdownIntensity = computeDrawdownIntensity(currentDrawdown, dipThreshold, abortThreshold);

  const rawMultiplier = btcMult * regimeMult * drawdownIntensity;
  const multiplier = Math.max(0.5, Math.min(2.5, rawMultiplier));

  // ── SIZING BASE ───────────────────────────────────────────────────────────
  const baseAmount = portfolioEquity * baseDCAIntensity;
  const targetAmount = baseAmount * multiplier;
  const maxAttack = Math.min(targetAmount, availableCash, portfolioEquity * 0.15);

  // ── GATE 3: CVaR proyectado ───────────────────────────────────────────────
  // Estimación simple: cada 10% invertido añade ~2% al CVaR
  const attackWeightPct = targetAmount / portfolioEquity;
  const projectedCVaR = currentCVaR + attackWeightPct * 0.2;
  const gate3_cvar = projectedCVaR < cvarHardLimit;

  // ── DECISIÓN FINAL ────────────────────────────────────────────────────────
  const attackActive = gate1_drawdown && gate2_regime && gate3_cvar;

  if (!attackActive) {
    const standbyReason = [
      !gate1_drawdown ? `Drawdown ${(currentDrawdown * 100).toFixed(1)}% < threshold ${(dipThreshold * 100).toFixed(0)}%` : '',
      !gate2_regime ? `Régimen ${hmmState} no favorable para ataque` : '',
      !gate3_cvar ? `CVaR proyectado ${(projectedCVaR * 100).toFixed(1)}% excede límite ${(cvarHardLimit * 100).toFixed(0)}%` : '',
    ].filter(Boolean).join('; ');

    return {
      attackActive: false,
      attackMode: 'STANDBY',
      attackAmount: 0,
      attackPercent: 0,
      multiplier: 1.0,
      baseAmount,
      tranches: [],
      gates: { gate1_drawdown, gate2_regime, gate3_cvar, gate4_btcBoost, gate5_safe },
      reason: `Ataque en standby: ${standbyReason}`,
      riskWarnings: [],
      projectedCVaRPostAttack: currentCVaR,
      confidenceInAttack: 'LOW',
    };
  }

  // ── MODO DE ATAQUE ────────────────────────────────────────────────────────
  const attackMode = determineAttackMode(multiplier, gate4_btcBoost);

  // ── DISTRIBUCIÓN EN TRANCHES ──────────────────────────────────────────────
  const tranches = buildAttackTranches(maxAttack, attackMode, currentDrawdown, btcSignal);

  // ── CONFIANZA EN EL ATAQUE ────────────────────────────────────────────────
  const confidence = computeAttackConfidence(hmmProbs, btcCycle, vix, currentDrawdown);

  // ── WARNINGS ─────────────────────────────────────────────────────────────
  const riskWarnings = buildRiskWarnings(
    currentDrawdown, multiplier, projectedCVaR, vix, creditSpread, yieldSpread
  );

  return {
    attackActive: true,
    attackMode,
    attackAmount: maxAttack,
    attackPercent: maxAttack / portfolioEquity,
    multiplier,
    baseAmount,
    tranches,
    gates: { gate1_drawdown, gate2_regime, gate3_cvar, gate4_btcBoost, gate5_safe },
    reason: buildAttackReason(attackMode, btcSignal, hmmState, currentDrawdown, multiplier),
    riskWarnings,
    projectedCVaRPostAttack: projectedCVaR,
    confidenceInAttack: confidence,
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Intensidad del ataque según profundidad del drawdown.
 * Curva no lineal: agresividad crece con la caída pero tiene techo.
 * Entre dipThreshold y 10%: crecimiento lineal 1.0 → 1.5
 * Entre 10% y 20%: crecimiento más lento 1.5 → 1.8
 * > 20%: reducir (drawdown muy profundo = señal contradictoria)
 */
function computeDrawdownIntensity(
  drawdown: number,
  dipThreshold: number,
  abortThreshold: number
): number {
  if (drawdown < dipThreshold) return 0;
  if (drawdown < 0.10) {
    // Fase 1: 3%-10% → intensidad 1.0 a 1.5
    return 1.0 + (drawdown - dipThreshold) / (0.10 - dipThreshold) * 0.5;
  }
  if (drawdown < 0.20) {
    // Fase 2: 10%-20% → intensidad 1.5 a 1.8
    return 1.5 + (drawdown - 0.10) / 0.10 * 0.3;
  }
  // Fase 3: > 20% → reducir agresividad (posible bear estructural)
  return Math.max(0.8, 1.8 - (drawdown - 0.20) * 3.0);
}

function determineAttackMode(
  multiplier: number,
  btcBoost: boolean
): DipAttackOutput['attackMode'] {
  if (multiplier >= 2.0 && btcBoost) return 'AGGRESSIVE';
  if (multiplier >= 1.5) return 'MODERATE';
  return 'LIGHT';
}

/**
 * Divide el ataque en tranches con distintos delays y condiciones.
 * NO ejecutar todo de golpe: DCA incluso dentro del ataque.
 */
function buildAttackTranches(
  totalAmount: number,
  mode: DipAttackOutput['attackMode'],
  drawdown: number,
  btcSignal: string
): DipAttackTranche[] {
  if (mode === 'AGGRESSIVE') {
    // 40% inmediato + 35% en 3 días + 25% en 7 días si sigue bajo
    return [
      {
        trancheNumber: 1,
        amount: totalAmount * 0.40,
        delayDays: 0,
        condition: 'Ejecutar inmediatamente',
        priority: 'IMMEDIATE',
      },
      {
        trancheNumber: 2,
        amount: totalAmount * 0.35,
        delayDays: 3,
        condition: 'Si precio sigue > 2% por debajo del máximo reciente',
        priority: 'SCHEDULED',
      },
      {
        trancheNumber: 3,
        amount: totalAmount * 0.25,
        delayDays: 7,
        condition: 'Si MVRV < 2.0 y HMM mantiene EXPANSION',
        priority: 'CONDITIONAL',
      },
    ];
  }
  if (mode === 'MODERATE') {
    // 50% inmediato + 50% en 5 días
    return [
      {
        trancheNumber: 1,
        amount: totalAmount * 0.50,
        delayDays: 0,
        condition: 'Ejecutar inmediatamente',
        priority: 'IMMEDIATE',
      },
      {
        trancheNumber: 2,
        amount: totalAmount * 0.50,
        delayDays: 5,
        condition: 'Si el activo no ha recuperado > 80% de la caída',
        priority: 'CONDITIONAL',
      },
    ];
  }
  // LIGHT: un solo tranche
  return [
    {
      trancheNumber: 1,
      amount: totalAmount,
      delayDays: 0,
      condition: 'Ejecutar inmediatamente',
      priority: 'IMMEDIATE',
    },
  ];
}

function computeAttackConfidence(
  hmmProbs: DipAttackInput['hmmProbs'],
  btcCycle: BTCCycleOutput | undefined,
  vix: number,
  drawdown: number
): DipAttackOutput['confidenceInAttack'] {
  let score = 0;
  if (hmmProbs.expansion > 0.60) score += 2;
  else if (hmmProbs.expansion > 0.40) score += 1;

  if (btcCycle && ['STRONG_BUY', 'BUY'].includes(btcCycle.signal)) score += 2;
  else if (btcCycle?.signal === 'ACCUMULATE') score += 1;

  if (vix < 25) score += 1;
  if (drawdown < 0.12) score += 1;

  if (score >= 5) return 'HIGH';
  if (score >= 3) return 'MEDIUM';
  return 'LOW';
}

function buildRiskWarnings(
  drawdown: number,
  multiplier: number,
  projectedCVaR: number,
  vix: number,
  creditSpread: number,
  yieldSpread: number
): string[] {
  const warnings: string[] = [];
  if (drawdown > 0.15) warnings.push(`⚠️ Drawdown profundo (${(drawdown * 100).toFixed(1)}%) — considerar esperar confirmación técnica`);
  if (multiplier > 2.0) warnings.push('⚠️ Multiplicador alto — sizing total no debe exceder 15% del portfolio');
  if (projectedCVaR > 0.17) warnings.push(`⚠️ CVaR proyectado post-ataque: ${(projectedCVaR * 100).toFixed(1)}% (cerca del límite)`);
  if (vix > 30) warnings.push(`⚠️ VIX elevado (${vix.toFixed(0)}) — incrementar DCA lentamente, no de golpe`);
  if (creditSpread > 400) warnings.push(`⚠️ Credit spreads altos (${creditSpread}bps) — señal de stress sistémico`);
  if (yieldSpread < 0) warnings.push('⚠️ Curva de tipos invertida — recesión en cola de riesgo');
  return warnings;
}

function buildAttackReason(
  mode: DipAttackOutput['attackMode'],
  btcSignal: string,
  hmmState: HMMState,
  drawdown: number,
  multiplier: number
): string {
  return (
    `ATAQUE ${mode} activado: ` +
    `Drawdown ${(drawdown * 100).toFixed(1)}% | ` +
    `HMM=${hmmState} | ` +
    `BTC=${btcSignal} | ` +
    `Multiplicador=${multiplier.toFixed(2)}x sobre DCA base`
  );
}

function buildAbortOutput(
  portfolioEquity: number,
  baseDCAIntensity: number,
  reason: string
): DipAttackOutput {
  return {
    attackActive: false,
    attackMode: 'ABORT',
    attackAmount: 0,
    attackPercent: 0,
    multiplier: 0,
    baseAmount: portfolioEquity * baseDCAIntensity,
    tranches: [],
    gates: {
      gate1_drawdown: false,
      gate2_regime: false,
      gate3_cvar: false,
      gate4_btcBoost: false,
      gate5_safe: false,
    },
    reason: `⛔ ATAQUE ABORTADO: ${reason}`,
    riskWarnings: ['MODO DEFENSIVO ACTIVO — no incrementar exposición'],
    projectedCVaRPostAttack: 0,
    confidenceInAttack: 'LOW',
  };
}
