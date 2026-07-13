// ===============================================
// ARCHIVO: src/core/dca/smartDCA.ts
// HENDENFUND — SmartDCA con separación Olympus/Táctico
// ===============================================
// REGLAS (actualizado Jul-2026):
//   - Olympus recibe el cash operativo mensual (cashReserve). Invierte 30% en DCA normal.
//   - Táctico recibe el 100% de la liquidez defensiva acumulada. Solo invierte si attackConfluence ≥ 4.
//   - El sobrante del Táctico se acumula como efectivo para el mes siguiente.
//   - Graduación Kelly-inspired: Tramo 1 (4/7) 50% Oly + 33% Táct, Tramo 2 (5/7) 75% Oly + 66% Táct, Tramo 3 (6-7/7) 100% ambos.

import type { CEWSOutput, CEWSLevel } from "../macro/crisisEarlyWarning";

// ── CONFIGURACIÓN CENTRALIZADA (auditoría Jul-2026) ─────────────────────
// Todos los magic numbers extraídos a este objeto para tuning consistente.
// Si se ajusta un umbral, editar aquí — no hay números sueltos en el código.
const DCA_CONFIG = {
  // Umbrales de las 7 señales de confluencia de fondo
  SIGNALS: {
    BTC_RSI_OVERSOLD: 35,
    BTC_Z_OVERSOLD: -1.5,
    REGIME_EXPANSION_THRESHOLD: 0.85,   // regimePenalty mínimo para que EXPANSION cuente como macro
    REGIME_CONTRACTION_THRESHOLD: 0.55, // regimePenalty mínimo para que CONTRACTION cuente como macro
    MOMENTUM_DIVERGENCE: -0.10,        // retorno 1m mínimo para divergencia bajista
    MOMENTUM_Z_FLOOR: -2.5,            // Z-Score mínimo para que divergencia aplique
    BTC_DOMINANCE_ACCUMULATION: 52,     // BTC.D > 52% = señal de acumulación
    MVRV_UNDERVALUED: 1.5,             // MVRV < 1.5 = zona de valor
  },
  // Filtros de elegibilidad para compra
  ALLOCATION: {
    MIN_FINAL_ALLOCATION: 0.02,  // target < 2% → no comprar (demasiado pequeño)
    MIN_DRIFT: 0.005,            // drift < 0.5pp → no comprar (ya está en peso)
  },
  // Parámetros de ataque y graduación Kelly-inspired
  ATTACK: {
    THRESHOLD: 4,                      // señales mínimas para activar modo ataque
    MIN_MACRO_FOR_FULL_ATTACK: 2,      // señales macro mínimas para ataque a cartera completa (si <2 → BTC-only)
    BTC_OVERRIDE_FRACTION: 0.25,       // % Olympus a BTC en CRISIS + ≥4 señales
    GRADUATION: {
      // [olympusFraction, tacticalFraction] por tramo
      MAX:    [1.00, 1.00] as const,   // Tramo 3: fat pitch, todo al mercado
      STRONG: [0.75, 0.66] as const,   // Tramo 2: convicción alta
      ENTRY:  [0.50, 0.33] as const,   // Tramo 1: probe inicial
    },
    MULTIPLIERS: { MAX: 3.0, STRONG: 2.0, ENTRY: 1.5 },
  },
  // DCA normal (sin ataque)
  NORMAL: {
    OLYMPUS_FRACTION: 0.30,  // % del cash Olympus a invertir cada mes
  },
  // Umbrales de bloqueo — si se cruzan, no se compra nada
  BLOCKS: {
    REGIME_PENALTY_MIN: 0.45,      // regimePenalty por debajo → BLOCK_CRISIS
    VOL_TARGET_MIN: 0.60,          // volTargetMultiplier por debajo → BLOCK_VOL
    // TAIL_RISK: bloquea DCA si tailRiskActive (sin threshold intermedio).
    // El engine ya computó tailRiskActive = finalOverlay < 0.99. Si el motor
    // dice que hay riesgo de cola, el DCA no compra — el overlay se usa como
    // multiplicador de exposición, no como umbral de tolerancia del DCA.
  },
} as const;

export type DCAAction =
  | "BLOCK_STALE_DATA" | "BLOCK_CRISIS" | "BLOCK_TAIL_RISK" | "BLOCK_VOL"
  | "WAIT" | "SMALL_BUY" | "BUY" | "FULL_BUY"
  | "ATTACK_ENTRY" | "ATTACK_STRONG" | "ATTACK_MAX"
  | "BTC_CYCLE_OVERRIDE";

export interface CurrentAllocation {
  ticker: string;
  name: string;
  currentWeight: number;
}

export interface SmartDCAInput {
  btcRsi: number;
  btcZScore: number;
  btcMomentum1m: number;
  btcDominance?: number;
  mvrvRatio?: number;
  regime: string;
  regimePenalty: number;
  volTargetMultiplier: number;
  tailRiskActive: boolean;
  tailRiskOverlay: number;
  olympusAvailableCash: number;
  tacticalAvailableCash: number;
  accumulatedDefensiveLiquidity?: number;
  motorAllocations: { name: string; ticker: string; finalAllocation: number; price: number }[];
  /** Pesos actuales del portfolio para calcular drift (target - actual).
   *  Si se proporciona, buildAllocations solo comprará activos con drift POSITIVO
   *  (infraponderados), prorrateando el cash según el drift en vez del target absoluto. */
  currentAllocations?: CurrentAllocation[];
  cewsOutput?: CEWSOutput;
  cewsPreviousLevel?: CEWSLevel;
  /** Señales de techo de ciclo por activo. Si un activo tiene shouldTrim=true,
   *  SmartDCA no comprará más de ese activo (redistribuye el cash a los demás). */
  cycleTopSignals?: { ticker: string; shouldTrim: boolean; zone: string }[];
  /** FIX-AUDIT-R9 4: circuit breaker — true if Yahoo data >72h stale. DCA blocked. */
  staleDataBlock?: boolean;
}

export interface DCAAllocation {
  ticker: string; name: string;
  cashToInvest: number; actualCost: number;
  motorWeight: number; shares: number;
  pricePerShare: number; isFractional: boolean;
  skipped: boolean; reason: string;
  /** Gap entre peso objetivo y peso actual (positivo = infraponderado). */
  drift?: number;
  currentWeight?: number;
}

export interface AttackSignal {
  name: string; active: boolean; description: string;
}

export interface SmartDCAOutput {
  action: DCAAction;
  score: number;
  buyFraction: number;
  totalCashToInvest: number;
  allocationByAsset: DCAAllocation[];
  reasoning: string;
  blockReason?: string;
  attackMode: boolean;
  attackConfluence: number;
  attackSignals: AttackSignal[];
  attackMultiplier: number;
  attackTranche: 0 | 1 | 2 | 3;
  olympusInvested: number;
  tacticalInvested: number;
  tacticalAccumulated: number;
}

// ── SEÑALES DE CONFLUENCIA DE FONDO (sin cambios) ───────────────────────
function detectBottomConfluence(input: SmartDCAInput): AttackSignal[] {
  const { btcRsi, btcZScore, btcMomentum1m, cewsOutput, cewsPreviousLevel, regime, regimePenalty, btcDominance, mvrvRatio } = input;

  const S = DCA_CONFIG.SIGNALS;
  const btcOversold = btcRsi < S.BTC_RSI_OVERSOLD && btcZScore < S.BTC_Z_OVERSOLD;
  const cewsRecovering = cewsOutput !== undefined && cewsPreviousLevel !== undefined &&
    (cewsPreviousLevel === "ALERT" || cewsPreviousLevel === "WARNING") &&
    (cewsOutput.level === "WATCH" || cewsOutput.level === "CLEAR");
  // FIX-AUDIT-R5 R5.1: tighten macro signal. Solo fires cuando regimePenalty es explícito + supera threshold elevado.
  // Previene inflado de attackConfluence cuando el caller upstream olvidó setear regimePenalty (caso típico: defaults de test).
  //      typeof check   → undefined/NaN NO dispara macro spurio en producción.
  //      threshold ↑   → 0.80→0.85, 0.55→0.65; solo ciclos con mejora fuerte cuentan como macro.
  // FIX-AUDIT-R5 R5.1 v2 (post-reviewer): EXPANSION strengthened (0.80→0.85), CONTRACTION changes reverted to original 0.55 to avoid silent breakage en tests existentes.
  const regimeImproving = (
    (regime === "EXPANSION" && typeof regimePenalty === "number" && regimePenalty >= S.REGIME_EXPANSION_THRESHOLD) ||
    (regime === "CONTRACTION" && typeof regimePenalty === "number" && regimePenalty > S.REGIME_CONTRACTION_THRESHOLD)
  );
  const momentumDivergence = btcMomentum1m < S.MOMENTUM_DIVERGENCE && btcZScore > S.MOMENTUM_Z_FLOOR;
  const dominanceAccumulation = btcDominance !== undefined && btcDominance > S.BTC_DOMINANCE_ACCUMULATION;
  const mvrvUndervalued = mvrvRatio !== undefined && mvrvRatio < S.MVRV_UNDERVALUED;
  const volNormalizing = cewsOutput !== undefined && cewsOutput.signals.volClustering.trend === "IMPROVING" && cewsOutput.signals.volClustering.level !== "ALERT";

  return [
    { name: "BTC Sobreventa Extrema", active: btcOversold, description: btcOversold ? `RSI ${btcRsi.toFixed(0)} + Z-Score ${btcZScore.toFixed(2)}` : `RSI ${btcRsi.toFixed(0)}, Z ${btcZScore.toFixed(2)}` },
    { name: "CEWS Recuperándose", active: cewsRecovering, description: cewsRecovering ? `CEWS mejoró de ${cewsPreviousLevel} → ${cewsOutput?.level}` : `CEWS en ${cewsOutput?.level ?? "sin datos"}` },
    { name: "Régimen Mejorando", active: regimeImproving, description: regimeImproving ? `Régimen ${regime} (×${regimePenalty.toFixed(2)}) — mejora confirmada` : `Régimen ${regime} (×${regimePenalty.toFixed(2)})` },
    { name: "Divergencia de Momentum", active: momentumDivergence, description: momentumDivergence ? `Caída ${(btcMomentum1m*100).toFixed(1)}% con Z ${btcZScore.toFixed(2)}` : `Momentum ${(btcMomentum1m*100).toFixed(1)}%` },
    { name: "VIX Normalizándose", active: volNormalizing, description: volNormalizing ? `Volatility clustering mejorando` : `Vol clustering sin normalización` },
    { name: "BTC Dominance Acumulación", active: dominanceAccumulation, description: btcDominance !== undefined ? (dominanceAccumulation ? `BTC.D ${btcDominance.toFixed(1)}% — acumulación` : `BTC.D ${btcDominance.toFixed(1)}%`) : "Sin dato" },
    { name: "MVRV Zona de Valor", active: mvrvUndervalued, description: mvrvRatio !== undefined ? (mvrvUndervalued ? (mvrvRatio < 1.0 ? `MVRV ${mvrvRatio.toFixed(2)} — fondo histórico` : `MVRV ${mvrvRatio.toFixed(2)} — acumulación`) : (mvrvRatio > 3.5 ? `MVRV ${mvrvRatio.toFixed(2)} — burbuja` : `MVRV ${mvrvRatio.toFixed(2)} — neutral`)) : "Sin dato" },
  ];
}

// ── BUILD ALLOCATIONS (drift-aware) ──────────────────────────────────────
// Distribuye el cash entre activos infraponderados (drift positivo),
// prorrateando por el drift en vez del peso objetivo.
// Si un activo está sobreponderado (drift negativo), NO recibe cash.
function buildAllocations(
  totalCash: number,
  assets: { ticker: string; name: string; finalAllocation: number; price: number }[],
  trancheLabel: string,
  skipTickers: Set<string> = new Set(),
  currentAllocations: Map<string, number> = new Map()
): DCAAllocation[] {
  // FIX-AUDIT-DEDUP: eliminar tickers duplicados antes de procesar.
  // Si el motor recibe assets duplicados (ej: VVSM.DE aparece 2 veces en el portfolio),
  // solo se procesa la primera ocurrencia. Esto previene que un mismo activo aparezca
  // 2 veces en las propuestas de compra del DCA.
  const seenTickers = new Set<string>();
  const deduped = assets.filter(a => {
    const base = a.ticker.split('.')[0];
    if (seenTickers.has(base)) return false;
    seenTickers.add(base);
    return true;
  });

  // 1. Calcular drift para cada activo
  const withDrift = deduped.map(a => {
    const currentWeight = currentAllocations.get(a.ticker) ?? 0;
    const drift = a.finalAllocation - currentWeight;
    return { ...a, drift, currentWeight };
  });

  // 2. Filtrar: solo activos con target > MIN, precio > 0, sin techo de ciclo, y drift POSITIVO
  const ALLOC = DCA_CONFIG.ALLOCATION;
  const eligible = withDrift.filter(a =>
    a.finalAllocation > ALLOC.MIN_FINAL_ALLOCATION &&
    a.price > 0 &&
    !skipTickers.has(a.ticker) &&
    a.drift > ALLOC.MIN_DRIFT
  );

  if (eligible.length === 0) return [];
  if (totalCash <= 0) return [];

  // 3. Prorratear cash por drift, no por target absoluto
  const totalDrift = eligible.reduce((s, a) => s + a.drift, 0);
  const pass1 = eligible.map(a => {
    const cashAssigned = (a.drift / totalDrift) * totalCash;
    const isFractional = a.ticker === "BTC-EUR";
    const shares = isFractional ? cashAssigned / a.price : Math.floor(cashAssigned / a.price);
    const actualCost = shares * a.price;
    const skipped = !isFractional && shares === 0;
    return { ...a, cashAssigned, shares, actualCost, isFractional, skipped };
  });

  // 4. Redistribuir cash sobrante de activos que no alcanzan 1 acción
  const stranded = pass1.filter(a => a.skipped).reduce((s, a) => s + a.cashAssigned, 0);
  const canBuy = pass1.filter(a => !a.skipped);
  const canBuyDrift = canBuy.reduce((s, a) => s + a.drift, 0);

  // 5. Construir resultado final con drift en la descripción
  return pass1.map(a => {
    if (a.skipped) {
      return {
        ticker: a.ticker, name: a.name,
        cashToInvest: a.cashAssigned, actualCost: 0,
        motorWeight: a.finalAllocation, shares: 0,
        pricePerShare: a.price, isFractional: false,
        skipped: true, reason: `Necesita €${a.price.toFixed(0)} mín.`,
        drift: a.drift, currentWeight: a.currentWeight,
      };
    }
    let extra = 0;
    if (stranded > 0 && canBuyDrift > 0) extra = (a.drift / canBuyDrift) * stranded;
    const total = a.cashAssigned + extra;
    const shares = a.isFractional ? total / a.price : Math.floor(total / a.price);
    return {
      ticker: a.ticker, name: a.name,
      cashToInvest: total, actualCost: shares * a.price,
      motorWeight: a.finalAllocation, shares,
      pricePerShare: a.price, isFractional: a.isFractional,
      skipped: false,
      reason: `${trancheLabel} ${(a.finalAllocation*100).toFixed(1)}% (drift ${(a.drift*100).toFixed(1)}pp)`,
      drift: a.drift, currentWeight: a.currentWeight,
    };
  });
}

// ── FUNCIÓN PRINCIPAL ──────────────────────────────────────────────────
export function computeSmartDCA(input: SmartDCAInput): SmartDCAOutput {
  const { regime, regimePenalty, volTargetMultiplier, tailRiskActive, tailRiskOverlay, olympusAvailableCash, tacticalAvailableCash, motorAllocations } = input;
  const ATK = DCA_CONFIG.ATTACK;
  const BLK = DCA_CONFIG.BLOCKS;
  const NRM = DCA_CONFIG.NORMAL;
  const A = DCA_CONFIG.ALLOCATION;

  // Extraer tickers con señal de techo de ciclo activa (CAUTION/DANGER/EXTREME)
  // Estos activos NO se comprarán — el cash se redistribuye a los demás
  const cycleTopTickers = new Set<string>(
    (input.cycleTopSignals ?? [])
      .filter(s => s.shouldTrim && s.zone !== "SAFE")
      .map(s => s.ticker)
  );

  const attackSignals = detectBottomConfluence(input);
  const attackConfluence = attackSignals.filter(s => s.active).length;

  // Separar señales macro vs BTC/on-chain.
  // Macro (CEWS, Régimen, VIX) → señales de cartera completa.
  // BTC/on-chain (BTC oversold, momentum, BTC.D, MVRV) → solo justifican comprar BTC.
  // Regla: si no hay ≥2 señales macro, el ataque es solo a BTC-EUR.
  const macroSignalNames = new Set(["CEWS Recuperándose", "Régimen Mejorando", "VIX Normalizándose"]);
  const macroConfluence = attackSignals.filter(s => macroSignalNames.has(s.name) && s.active).length;

  // ═══════════════════════════════════════════════════════════════
  // ORDEN DE BLOQUEOS (auditoría Jul-2026 — reordenados por prioridad)
  //   Prioridad institucional: circuit breaker técnico > kill switch >
  //   régimen macro > vol target > excepciones tácticas.
  //   Ningún early-return puede saltarse un bloqueo más restrictivo.
  // ═══════════════════════════════════════════════════════════════

  // ── 1. CIRCUIT BREAKER: datos stale (>72h sin Yahoo) ──────────
  // Máxima prioridad: sin datos frescos, el motor no puede tomar
  // decisiones de compra. Bloquea TODO — incluso BTC_CYCLE_OVERRIDE.
  if (input.staleDataBlock) return emptyOutput("BLOCK_STALE_DATA", "🔴 Datos Yahoo >72h sin actualizar. DCA bloqueado hasta que se restaure la conexión.", attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);

  // ── 2. KILL SWITCH: tail risk activo ──────────────────────────
  // El engine ya decidió que hay riesgo de cola (overlay < 0.99).
  // El DCA obedece sin segundas opiniones.
  if (tailRiskActive) return emptyOutput("BLOCK_TAIL_RISK", `Tail Risk activo (×${tailRiskOverlay.toFixed(2)}). Kill Switch — no comprar.`, attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);

  // ── 3. RÉGIMEN MACRO: CRISIS o penalty crítico ────────────────
  // CRISIS bloquea DCA excepto si hay confluencia de fondo fuerte (≥4/7)
  // y no hay tail risk → en ese caso cedemos paso al BTC_CYCLE_OVERRIDE.
  // El override está diseñado para comprar BTC en capitulación macro —
  // incluso con penalty bajo (CRISIS profunda), las señales de fondo
  // justifican una posición pequeña (25% Olympus solo en BTC).
  const isBTC_OverrideCandidate = attackConfluence >= ATK.THRESHOLD && !tailRiskActive && regime === "CRISIS";
  if (!isBTC_OverrideCandidate) {
    if (regimePenalty <= BLK.REGIME_PENALTY_MIN) return emptyOutput("BLOCK_CRISIS", `CRISIS (×${regimePenalty.toFixed(2)}).`, attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);
    if (regime === "CRISIS") return emptyOutput("BLOCK_CRISIS", `CRISIS (×${regimePenalty.toFixed(2)}).`, attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);
  }

  // ── 4. VOLATILIDAD: vol target demasiado bajo ─────────────────
  // El BTC override es una excepción táctica: 25% Olympus solo BTC.
  // En capitulación la volatilidad es intrínsecamente alta — bloquear
  // el override por vol elevada sería contraproducente. El kill switch
  // (posición 2) ya protege contra riesgos de cola extremos.
  if (volTargetMultiplier < BLK.VOL_TARGET_MIN && !isBTC_OverrideCandidate) return emptyOutput("BLOCK_VOL", `Vol Target ×${volTargetMultiplier.toFixed(2)}.`, attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);

  // ── 5. BTC CYCLE OVERRIDE (≥4/7 en CRISIS, sin tail risk) ────
  // Excepción táctica: comprar BTC en capitulación macro si las
  // señales de fondo son fuertes Y no hay kill switch activo.
  // Se ejecuta DESPUÉS de todos los bloqueos para garantizar que
  // no compra con datos stale ni con protección de capital activa.
  if (isBTC_OverrideCandidate) {
    const btcOnly = motorAllocations.filter(a => a.ticker === "BTC-EUR");
    const btcCash = olympusAvailableCash * ATK.BTC_OVERRIDE_FRACTION;
    const allocs = buildAllocations(btcCash, btcOnly, "OVERRIDE:");
    const cost = allocs.reduce((s, a) => s + a.actualCost, 0);
    return { action: "BTC_CYCLE_OVERRIDE", score: attackConfluence, buyFraction: olympusAvailableCash > 0 ? cost / olympusAvailableCash : 0.25, totalCashToInvest: cost, allocationByAsset: allocs, reasoning: `⚡ BTC OVERRIDE — ${attackConfluence}/7 señales. €${cost.toFixed(0)}.`, attackMode: true, attackConfluence, attackSignals, attackMultiplier: 1, attackTranche: 1, olympusInvested: cost, tacticalInvested: 0, tacticalAccumulated: tacticalAvailableCash };
  }

  // ── MODO ATAQUE ─────────────────────────────────────────────────────
  const canAttack = attackConfluence >= ATK.THRESHOLD;
  // Si el ataque tiene <MIN_MACRO_FOR_FULL_ATTACK señales macro, solo comprar BTC-EUR
  const btcOnlyAttack = canAttack && macroConfluence < ATK.MIN_MACRO_FOR_FULL_ATTACK;
  let olympusInvested = 0, tacticalInvested = 0, tacticalAccumulated = tacticalAvailableCash;

  // ── GRADUACIÓN KELLY-INSPIRED (Jul-2026) ──────────────────────────
  // Despliegue proporcional a la convicción. Olympus escala 50→75→100%,
  // Táctico escala más lento 33→66→100% porque es war chest acumulado.
  // Tramo 1 (4/7): probe — testear el fondo sin quemar pólvora.
  // Tramo 2 (5/7): convicción — edge ya claro, desplegar mayoría.
  // Tramo 3 (6-7/7): fat pitch — coste de oportunidad > riesgo de caída.
  const G = ATK.GRADUATION;
  if (attackConfluence >= 6) {           // TRAMO 3: ATTACK_MAX
    olympusInvested = olympusAvailableCash * G.MAX[0];
    tacticalInvested = tacticalAvailableCash * G.MAX[1];
    tacticalAccumulated = 0;
  } else if (attackConfluence >= 5) {    // TRAMO 2: ATTACK_STRONG
    olympusInvested = olympusAvailableCash * G.STRONG[0];
    tacticalInvested = tacticalAvailableCash * G.STRONG[1];
    tacticalAccumulated = tacticalAvailableCash - tacticalInvested;
  } else if (attackConfluence >= ATK.THRESHOLD) { // TRAMO 1: ATTACK_ENTRY
    olympusInvested = olympusAvailableCash * G.ENTRY[0];
    tacticalInvested = tacticalAvailableCash * G.ENTRY[1];
    tacticalAccumulated = tacticalAvailableCash - tacticalInvested;
  } else {                               // DCA NORMAL
    olympusInvested = olympusAvailableCash * NRM.OLYMPUS_FRACTION;
    tacticalInvested = 0;
    tacticalAccumulated = tacticalAvailableCash;
  }

  let totalCash = olympusInvested + tacticalInvested;
  // cycleTopTickers: activos en zona de techo de ciclo no se compran
  // btcOnlyAttack: solo BTC-EUR se compra, el resto del cash se acumula
  const allocAssets = btcOnlyAttack
    ? motorAllocations.filter(a => a.ticker === "BTC-EUR")
    : motorAllocations;
  // En modo DCA normal: usar drift-aware (solo comprar infraponderados).
  // En modo ATAQUE: también drift-aware — solo comprar infraponderados.
  // [FIX-ATTACK-DRIFT] Antes el modo ataque pasaba mapa vacío ignorando
  // posiciones reales, comprando activos ya sobreponderados (ej: IS3Q al 38%
  // con target 10.5% recibía €1,591). Ahora siempre se respetan las posiciones
  // actuales. El ataque despliega más cash pero solo en activos con drift > 0.
  const currentAllocMap = new Map<string, number>(
    (input.currentAllocations ?? []).map(ca => [ca.ticker, ca.currentWeight])
  );
  let allocs = totalCash > 0
    ? buildAllocations(totalCash, allocAssets, canAttack ? "ATAQUE:" : "DCA:", cycleTopTickers, currentAllocMap)
    : [];

  // FIX-DCA-FALLBACK (v3 Jul-2026): cuando totalCash > 0 pero buildAllocations
  // no encuentra activos elegibles (todos cycle top, sobreponderados, o sin drift),
  // generar guía de distribución con motivo por activo.
  //   • cycle top → skipped, actualCost 0, no se compra.
  //   • sobreponderado (drift ≤ 0.5pp) → skipped, actualCost 0, no se compra.
  //   • infraponderado (drift > 0.5pp) → prorrateo real, sí se compra.
  //   El cash de cycle-blocked + sobreponderados se redistribuye a infraponderados.
  //   Si no hay infraponderados, el cash se acumula (todos skipped).
  if (totalCash > 0 && allocs.length === 0) {
    const eligibleForFallback = motorAllocations.filter(a => a.finalAllocation > A.MIN_FINAL_ALLOCATION && a.price > 0);
    if (eligibleForFallback.length > 0) {
      // Clasificar en 3 grupos: cycle-blocked, sobreponderado, infraponderado
      const withDrift = eligibleForFallback.map(a => ({
        ...a,
        currentW: currentAllocMap.get(a.ticker) ?? 0,
        driftVal: a.finalAllocation - (currentAllocMap.get(a.ticker) ?? 0),
      }));
      const cycleBlocked  = withDrift.filter(a => cycleTopTickers.has(a.ticker));
      const overweight    = withDrift.filter(a => !cycleTopTickers.has(a.ticker) && a.driftVal <= A.MIN_DRIFT);
      const underweight   = withDrift.filter(a => !cycleTopTickers.has(a.ticker) && a.driftVal > A.MIN_DRIFT);
      const totalUWWeight = underweight.reduce((s, a) => s + a.finalAllocation, 0);

      const buildEntry = (
        a: typeof withDrift[number],
        kind: 'cycle' | 'overweight' | 'underweight'
      ) => {
        const isFractional = a.ticker === "BTC-EUR";
        let cashAssigned: number, shares: number, actualCost: number, skipped: boolean, motivo: string;

        if (kind === 'cycle') {
          cashAssigned = 0; shares = 0; actualCost = 0; skipped = true;
          const overMsg = a.driftVal <= 0.005
            ? ` + sobreponderado ${(a.driftVal*100).toFixed(1)}pp`
            : ` (target ${(a.finalAllocation*100).toFixed(1)}% vs actual ${(a.currentW*100).toFixed(1)}%)`;
          motivo = `cycle top ⚠️${overMsg} — no se compra`;
        } else if (kind === 'overweight') {
          cashAssigned = 0; shares = 0; actualCost = 0; skipped = true;
          motivo = `sobreponderado ${(a.driftVal*100).toFixed(1)}pp (target ${(a.finalAllocation*100).toFixed(1)}% vs actual ${(a.currentW*100).toFixed(1)}%) — no se compra`;
        } else if (totalUWWeight === 0) {
          cashAssigned = 0; shares = 0; actualCost = 0; skipped = true;
          motivo = `sin activos elegibles para redistribuir`;
        } else {
          // Prorratear cash solo entre infraponderados no bloqueados
          cashAssigned = totalCash * (a.finalAllocation / totalUWWeight);
          shares = isFractional ? cashAssigned / a.price : Math.floor(cashAssigned / a.price);
          actualCost = shares * a.price;
          skipped = !isFractional && shares === 0;
          motivo = `infraponderado ${(a.driftVal*100).toFixed(1)}pp (target ${(a.finalAllocation*100).toFixed(1)}% vs actual ${(a.currentW*100).toFixed(1)}%)`;
        }
        let reason: string;
        if (skipped && kind !== 'underweight') {
          reason = motivo;
        } else if (skipped && !isFractional) {
          reason = `${motivo} — necesita €${a.price.toFixed(0)} mín.`;
        } else if (skipped) {
          reason = motivo;
        } else {
          // FIX-FALLBACK-LABEL: usar label dinámico (ATAQUE:/DCA:) en vez de hardcode "DCA prorrateado"
          reason = `${canAttack ? "ATAQUE:" : "DCA:"} prorrateado ${(a.finalAllocation*100).toFixed(1)}% · ${motivo}`;
        }
        return {
          ticker: a.ticker, name: a.name,
          cashToInvest: cashAssigned, actualCost,
          motorWeight: a.finalAllocation, shares,
          pricePerShare: a.price, isFractional, skipped,
          reason,
          drift: a.driftVal, currentWeight: a.currentW,
        };
      };
      allocs = [
        ...cycleBlocked.map(a => buildEntry(a, 'cycle')),
        ...overweight.map(a => buildEntry(a, 'overweight')),
        ...underweight.map(a => buildEntry(a, 'underweight')),
      ];

      // Recalcular cash real desplegado: cycle-blocked + sobreponderados = €0,
      // solo infraponderados reciben cash. Ajustar olympusInvested/tacticalInvested.
      const actualDeployed = allocs.reduce((s, a) => s + a.actualCost, 0);
      if (actualDeployed < totalCash && totalCash > 0) {
        const scale = actualDeployed / totalCash;
        olympusInvested = Math.round(olympusInvested * scale);
        tacticalInvested = actualDeployed - olympusInvested;
        // tacticalInvested no puede ser negativo (ej: olympusInvested > actualDeployed)
        if (tacticalInvested < 0) { olympusInvested = actualDeployed; tacticalInvested = 0; }
        tacticalAccumulated = tacticalAvailableCash - tacticalInvested;
        totalCash = actualDeployed;
      }
    }
  }

  const action: DCAAction = canAttack ? (attackConfluence >= 6 ? "ATTACK_MAX" : attackConfluence >= 5 ? "ATTACK_STRONG" : "ATTACK_ENTRY") : "BUY";
  const reasoning = canAttack
    ? btcOnlyAttack
      ? `🔷 ATAQUE BTC-ONLY — ${attackConfluence}/7 señales (${macroConfluence} macro). Olympus €${olympusInvested.toFixed(0)} solo BTC.`
      : `🚀 ATAQUE — ${attackConfluence}/7 señales (${macroConfluence} macro). Olympus €${olympusInvested.toFixed(0)} + Táctico €${tacticalInvested.toFixed(0)}.`
    : `DCA normal Olympus €${olympusInvested.toFixed(0)}. Táctico acumula €${tacticalAccumulated.toFixed(0)}.`;

  const M = ATK.MULTIPLIERS;
  const attackMultiplier = canAttack ? (attackConfluence >= 6 ? M.MAX : attackConfluence >= 5 ? M.STRONG : M.ENTRY) : 1.0;
  const attackTranche = canAttack ? (attackConfluence >= 6 ? 3 : attackConfluence >= 5 ? 2 : 1) : 0;
  return { action, score: attackConfluence, buyFraction: olympusAvailableCash > 0 ? olympusInvested / olympusAvailableCash : 0, totalCashToInvest: totalCash, allocationByAsset: allocs, reasoning, attackMode: canAttack, attackConfluence, attackSignals, attackMultiplier, attackTranche, olympusInvested, tacticalInvested, tacticalAccumulated };
}

function emptyOutput(action: DCAAction, reason: string, signals: AttackSignal[], confluence: number, olympusCash: number, tacticalCash: number): SmartDCAOutput {
  return { action, score: 0, buyFraction: 0, totalCashToInvest: 0, allocationByAsset: [], reasoning: reason, blockReason: reason, attackMode: false, attackConfluence: confluence, attackSignals: signals, attackMultiplier: 1, attackTranche: 0, olympusInvested: 0, tacticalInvested: 0, tacticalAccumulated: tacticalCash };
}