// ===============================================
// ARCHIVO: src/core/engine/olympusV3.ts
// OLYMPUS ENGINE V5 — Motor Institucional Anti-Frágil
// ===============================================
// CAPAS DE ASIGNACIÓN (en orden de aplicación):
//   0. BTC CYCLE OVERLAY  → MVRV/Puell/RSI → btcNumeric [0,1]
//   1. META-INTELIGENCIA  → confidenceMultiplier [0.70, 1.0] si modelo falla
//   2. RÉGIMEN UNIFICADO  → masterRegime con penalty continuo [0.4, 1.0]
//   3. FACTOR SCORES      → momentum + value + quality + lowVol
//   4. KELLY FRACTION     → half-kelly cap 0.20, modulado por coreSignalScore
//   5. CORRELACIÓN        → penalización si correlación media > 0.5
//   6. BLEND 2-PATH       → BL×0.24 + HRP×0.76 + MinVar×0.00 (MinVar eliminado — ablation study 14-Jul-2026)
//   7. VOL TARGET         → reduce exposición total (cash implícito preservado)
//   8. TAIL RISK V5       → kill switch 5 niveles DD 5/10/15/20/25%
//   9. BTC CAP            → máximo 20% sobre el tramo invertido
//  10. META-CONFIDENCE    → ajuste final por salud del modelo
// ===============================================
//
// HISTORIAL DE FIXES (esta versión):
//
// FIX-V5-1 (audit ronda 2): adjustedRegimePenalty — LÓGICA INVERTIDA
//   ANTES: Math.max(regimePenalty, regimePenalty / confidenceMultiplier)
//   Con confidence=0.70: 0.40/0.70=0.571 → penalización MÁS LAXA cuando modelo falla.
//   INTENCIÓN: confianza baja → más conservador (penalización más alta = inversión menor).
//   CORRECCIÓN: regimePenalty × confidenceMultiplier (reduce exposición si modelo degradado).
//
// FIX-V5-2 (audit ronda 2): volTarget y tailRisk CANCELADOS por renormalización
//   ANTES: final = blended × volMultiplier × tailOverlay → /totalFinal → siempre 100% invertido.
//   El kill switch y el vol target eran decorativos: nunca reducían la exposición real.
//   CORRECCIÓN: los pesos relativos se normalizan primero; luego se aplica la exposición
//   total (volMultiplier × tailOverlay) como fracción del portafolio. El resto es cash.
//
// FIX-V5-3 (audit ronda 2): minimumVarianceWeights llamada N veces dentro del map
//   ANTES: blendWeights = assets.map(() => { const minVarW = minimumVarianceWeights(...) })
//   Para N=7: 7 llamadas × 500 iters × 49 ops = 171,500 ops por recálculo.
//   CORRECCIÓN: llamar minimumVarianceWeights UNA vez antes del map (24,500 ops).
//
// FIX-V5-4 (audit ronda 2): computeScenarioProbabilities normalización incoherente
//   ANTES: pNeutral se calculaba usando pBull normalizado pero pBear SIN normalizar.
//   Resultado: probabilidades no sumaban 1.0 limpio antes de la segunda normalización.
//   CORRECCIÓN: normalización en un único paso claro con floor mínimo de 0.05.
//
// FIX-V5-5 (audit ronda 2): totalPortfolioValue ?? 0 → DCA siempre retorna 0
//   Si totalPortfolioValue no se pasa, el default 0 produce investAmount=0 siempre.
//   CORRECCIÓN: warning explícito en output + señal isDataMissing para el dashboard.
//
// FIX-R2-C10 (audit ronda 2): DISCRETIONARY_OVERLAY — renamed from REGIME_TACTICAL_ALLOCATIONS.
// Blend ahora da prioridad al motor cuantitativo cuando el estrés aumenta:
//   EXPANSION: 70% cuant / 30% overlay, CONTRACTION: 80%/20%, CRISIS: 100%/0%.
//   CORRECCIÓN: eliminado de la lista de imports.
// ===============================================

// FIX-V5-7: BL-TICKER-MISMATCH corregido (assetNames usa ticker, no name).
// FIX-V5-8: ERP-DEFAULT-BOOST corregido (sin dato → neutro, no +5% boost).
// FIX-V5-9: coreVolEstimate ponderado por pesos reales (no media aritmética).
// FIX-V5-10: isERPCritical con guard input.erpValue !== undefined.
// FIX-V5-11: BTC Bear Gate condicionado a MVRV > 2.5 o régimen != EXPANSION.
// FIX-CLIFF-CREDIT-01 (Oct-2026) v5.4.1:
//   1. globalStress: contribución de credit spread CONTINUA (piecewise 2%→6%: 0→2 pts)
//      en vez de escalones enteros +1/+2 en 3.0/5.0. Causa raíz del evento "225 URNU":
//      10 pb (2.98→3.08) volteaban CONTRACTION→CRISIS con resto-de-inputs=5 y saltaban
//      el penalty 0.925→0.550 en una observación. Backtest canónico BIT-IDÉNTICO.
//   2. rebalancer: ORDER GUARD de ejecución para BUYs — min(deficit, 25% NAV, €2.500),
//      límites en ORDER_GUARD_CONFIG (engineConfig), déficit no ejecutado en
//      suggestion.pendingDeficit (no se elimina). Sells sin cap. No es un segundo motor.
// FIX-PHASE13-INSTITUTIONAL (Oct-2026) v5.4.3 — coherencia DCA/Attack/Liquidez:
//   1. PROBE alcanzable (off-by-one): 3/8 = PROBE [25%,0%] — antes ENTRY [50%,33%]
//      consumía 39% de la liquidez total con 3 señales débiles y persistentes.
//   2. regimeAttackScale = clamp(0.60, penalty+0.15, 1.0): el régimen modula el
//      VOLUMEN del ataque (antes solo KS/recovery; CONTRACTION desplegaba igual que EXPANSION).
//   3. War chest (defensiva) SOLO en full attack (≥2 macro) — BTC-only no la toca.
//   4. Banda BTC_TOTAL ≥33.7% → ataque BTC en pausa / BTC skip en full attack.
//   5. Mutex rebalance∩DCA (pendingRebalanceTickers) — sin doble compra del mismo gap.
//   6. "Régimen Mejorando" mide TRANSICIÓN real (previousRegime), no nivel persistente.
//   7. totalLiquidityFraction: % de TODA la liquidez (el buyFraction histórico era solo broker).
//   Auditoría origen: PHASE13_FORENSIC (01-oct-2026), informe en deliverables.
// FIX-CLIFF-STRESS-02 (Oct-2026) v5.4.4 — Brent, CB-Liquidity y MOVE continuos
//   en globalStress (misma plantilla que FIX-CLIFF-CREDIT-01). Caso live
//   01-oct-2026: CRISIS espurio con VIX 16 (Brent $100 +2 cliff, QT −0.28% +2
//   cliff, MOVE 110.5 +1 cliff); perturbaciones de $0.20/2bp/0.2 volteaban
//   regímenes; Brent contaba dos veces (score Y ×0.70). Anclas preservadas
//   (75/95/115 · 0/−5 · 110/140); wtiPenalty interpolado 1.00→0.50 en $75→$130.
//   Backtest canónico: headline bit-idéntico; 1 día de label marginal.
// FIX-MUTEX-V2 (Oct-2026) v5.4.5 — Phase 13.1, mutex rebalance∩DCA por PORCIÓN
//   FINANCIADA del gap (no binario). El mutex v1 (FIX-PHASE13-INSTITUTIONAL #5)
//   prohibía a Smart DCA comprar cualquier ticker SUGERIDO por el panel de
//   rebalanceo. Como las sugerencias persisten toda la semana y cubren los
//   MISMOS gaps (WLG/EMXC/PPFB), DCA quedaba auto-bloqueado → actualDeployed=0
//   → €0 desplegados durante un mes mientras el rebalanceo se aplazaba (bug live
//   01-oct-2026, €3.900 en caja del bróker sin invertir).
//   AHORA: nuevo input pendingRebalanceBuys (ticker + cost) — el DCA trata la
//   porción YA financiada del gap como cubierta y solo top-a el resto:
//   allowed = max(0, gapValue − funded); allow≤0.01 → sin doble compra (razón
//   "gap ya cubierto por el rebalanceo"); actualCost>allowed → cap + razón
//   "top-up: el rebalanceo ya cubre €X del gap". Legacy pendingRebalanceTickers
//   conservado como fallback (binario) si no llega el mapa de costes.
//   Bug incidental corregido: el cap usaba a.price (campo inexistente en
//   DCAAllocation) → NaN shares; el campo real es a.pricePerShare.
//   Replay (scripts/replay-dca-mutex-v2.ts, temporal): caso live €0 → €1.094,92
//   (9,8% de la liquidez total); rebalanceo financiado mismo ciclo → €0 (correcto,
//   sin doble gasto); gap parcialmente financiado → top-up a €954,42.
//   No toca el camino de backtest → fingerprint canónico sin cambios.
// FIX-MUTEX-V3 (Oct-2026) v5.4.6 — "un hueco, un euro" por CAPAS. Sustituye al
//   candado rebalanceo∩DCA por SUGERENCIA (v1 binario de v5.4.3, v2 porción
//   financiada de v5.4.5), que seguía dejando €0 desplegados un mes con €3.900
//   en el bróker (bug live 01-oct-2026). Un candado debe medir COMPROMISO, no
//   INTENCIÓN: el candado se activaba con las sugerencias del panel, que
//   persisten todo el ciclo; con cadencia MENSUAL (rebalanceo) + SEMANAL (DCA)
//   bloqueaba hasta 4 tranches semanales seguidas.
//   AHORA la exclusión mutua depende del ESTADO (pesos + cash operativo), que se
//   actualiza al confirmar cada ejecución. Reparto por capas:
//     1ª capa (semanal) → Smart DCA despliega su tranche por drift, SIN veto
//        (se eliminan pendingRebalanceTickers / pendingRebalanceBuys del input).
//     2ª capa (mensual) → computeRebalanceSuggestions(..., dcaCommitted) cierra
//        solo el REMANENTE del hueco (deficitValue − dcaCommitted) con el cash
//        no comprometido (cashForBuys − ΣdcaCommitted); matching por ticker base.
//   Invariante: gap_i = dca_i + buy_i  ·  Σdca + Σbuy ≤ cashReserve.
//   Dashboard: rebalanceBase se calcula DESPUÉS de smartDCAResult (orden de capas)
//   y el bloque SmartDCA se muestra también con despliegue €0 con banda
//   "Despliegue €0 — motivo" (antes se ocultaba justo cuando hacía falta).
//   No toca el camino de backtest → fingerprint canónico sin cambios.
export const ENGINE_VERSION = "v5.4.6"; // OLYMPUS CORE v1.0 intacto (perfil opt-in, enabled:false).

// ── Estado del overlay Trend Gate del Core (serializable, determinista) ──
// Persistido entre rebalanceos por el caller (backtest/dashboard).
export interface CoreTrendGateState {
  lastGateCallIndex: number; // nº de evaluaciones del gate hasta ahora
  reentryCount: number;      // rebalanceos limpios consecutivos acumulados
  engaged: boolean;          // true mientras haya un episodio de gate activo
}

// OLYMPUS CORE v1.0 — Trend Gate overlay (especificación exacta del test E_both,
// Phase 12 / TREND_GATE_FINAL_TEST.csv). NO introduce thresholds nuevos: reusa
// la señal del gate legacy (>50% de activos con returns3m < 0) y añade los dos
// mecanismos validados:
//   - STAGED EXIT: primera activación tras un periodo limpio reduce a cap parcial.
//   - CONFIRMED RE-ENTRY: exposición completa solo tras N rebalanceos limpios
//     consecutivos (evita el whipsaw V-recovery, defecto dominante del gate legacy).
function computeCoreTrendGate(
  assets: AssetInput[],
  state: CoreTrendGateState | undefined,
  enabled: boolean,
): { multiplier: number; reason: string; active: boolean; newState: CoreTrendGateState } {
  const cfg = OLYMPUS_CORE.overlay.trendGate;
  const newState: CoreTrendGateState = {
    lastGateCallIndex: (state?.lastGateCallIndex ?? -1) + 1,
    reentryCount: state?.reentryCount ?? 0,
    engaged: state?.engaged ?? false,
  };
  if (!enabled) {
    return { multiplier: 1.0, reason: 'CORE v1.0: Trend Gate overlay OFF (opcional, evidencia EPISODIC — 1 de 9 episodios)', active: false, newState };
  }
  const bearishPct = assets.length > 0 ? assets.filter(a => a.returns3m < 0).length / assets.length : 0;
  const bearish = bearishPct > 0.50; // misma señal que ABSOLUTE_TREND_GATE majority
  let multiplier = 1.0;
  let reason = `CORE gate: ${(bearishPct * 100).toFixed(0)}% activos negativos 3m → sin restricción`;
  if (bearish) {
    const freshActivation = !newState.engaged; // venía limpio ≥ N rebalanceos
    multiplier = freshActivation
      ? cfg.stagedFirstActivationCap
      : ABSOLUTE_TREND_GATE.MAJORITY_BEARISH_CAP;
    reason = `CORE gate E_both: ${(bearishPct * 100).toFixed(0)}% bearish 3m → cap ${(multiplier * 100).toFixed(0)}%${freshActivation ? ' (staged: primera activación)' : ' (confirmado)'}`;
    newState.engaged = true;
    newState.reentryCount = 0;
  } else if (newState.engaged) {
    newState.reentryCount = newState.reentryCount + 1;
    if (newState.reentryCount >= cfg.reentryCleanRebalances) {
      newState.engaged = false;
      newState.reentryCount = 0;
      reason = `CORE gate re-entry completado: ${cfg.reentryCleanRebalances} rebalanceos limpios → exposición plena`;
    } else {
      multiplier = cfg.stagedFirstActivationCap;
      reason = `CORE gate re-entry: ${newState.reentryCount}/${cfg.reentryCleanRebalances} rebalanceos limpios → cap parcial ${(multiplier * 100).toFixed(0)}%`;
    }
  }
  return { multiplier, reason, active: multiplier < 1.0, newState };
}

// ── Imports ─────────────────────────────────────────────────────────────────
import { calculateMomentum } from "../factors/momentum";
import { calculateValue, computeUniverseStats, ValueInput } from "../factors/value";
import { calculateQuality, computeQualityUniverseStats, QualityInput } from "../factors/quality";
import { calculateLowVol, computeLowVolUniverseStats } from "../factors/lowVolatility";
import { computeHRP } from "../risk/hrp";
import { getMasterRegime, MasterRegimeOutput, RegimeHistoryEntry, RegimeLock } from "../macro/masterRegime";
import type { CEWSDataPoint } from "../macro/crisisEarlyWarning";
import { calculateKelly } from "../portfolio/kelly";
import { correlationPenalty } from "../portfolio/correlation";
import { computeRiskParityWeights, DEFAULT_SECTOR_BUDGETS } from "../risk/riskBudget";
import { computeVolTargetMultiplier } from "../risk/volatilityTarget";
import { computeTailRiskOverlay } from "../risk/tailRisk";
import { runBlackLitterman, generateViewsExternal, BLView } from "../portfolio/blackLitterman";
import { calibrateExpectedReturn } from "../factors/factorCalibration";
import { computeBTCCycleOverlay, BTCCycleInput } from "../crypto/btcCycleOverlay";
import { computeDCADecision, type PortfolioRegime } from "../dca/dcaEngine";
import { computeMetaIntelligence, loadPredictionHistory } from "../risk/metaIntelligence";
// detectCycleTops removed — auto-detect fallback eliminated (FIX-AUDIT-TRANSVERSAL-R3 #2).
// cycleTopSignals from dashboard is the single source of truth.
import { VOLATILITY_CONFIG, ERP_CONFIG, CORRELATION_PANIC_CONFIG, ABSOLUTE_TREND_GATE, BREADTH_RISK_POLICY, CORE_SIGNAL_WEIGHTS, ALPHA_BOOST_CONFIG, BTC_CAPS_BY_REGIME, getFactorWeightsByRegime, REGIME_TILT, OLYMPUS_CORE } from "../config/engineConfig";
import {
  evaluateInstitutionalBreadth,
  resolveInstitutionalBreadthConfig,
  type InstitutionalBreadthConfig,
  type InstitutionalBreadthResult,
  type InstitutionalBreadthState,
} from "../risk/institutionalBreadth";
// FIX-R2-C10: renombrado DISCRETIONARY_OVERLAY. Import usado para allocationProvenance.
// FIX-AUDIT-R10: allocationProvenance (transparencia del overlay discrecional)
// FIX-R2-C10: REGIME_TACTICAL_ALLOCATIONS → DISCRETIONARY_OVERLAY
import {
  getTacticalWeights,
  applyTacticalConstraints,
  enforceClusterCap,
  DISCRETIONARY_OVERLAY,
} from "./regimeTacticalAllocation";

// ── Blend weights (fuente de verdad dinámica) ───────────────────────────────────
// FIX-ABLATION-MINVAR (14-Jul-2026): MIN_VAR eliminado del blend.
// Ablation study demostró que MinVar destruye Sharpe (−0.061 al usarse solo,
// +0.013 al eliminarse del blend). No protege drawdown (diferencia −0.2pp,
// insignificante). Es complejidad sin beneficio.
// CONSERVATIVE: BL 0.20→0.24, HRP 0.65→0.76 (redistribución proporcional del 15% liberado)
// AGGRESSIVE:   BL 0.40→0.50, HRP 0.40→0.50 (redistribución proporcional del 20% liberado)
const BLEND_WEIGHTS = {
  WITH_COV: {
    CONSERVATIVE: { BL: 0.24, HRP: 0.76, MIN_VAR: 0.00 },
    AGGRESSIVE:   { BL: 0.50, HRP: 0.50, MIN_VAR: 0.00 },
  },
  WITHOUT_COV: {
    CONSERVATIVE: { KELLY: 0.25, HRP: 0.75 },
    AGGRESSIVE:   { KELLY: 0.40, HRP: 0.60 },
  }
} as const;

// ── Interfaces ───────────────────────────────────────────────────────────────
export interface AssetInput {
  name: string;
  ticker?: string;      // ticker del activo (fallback: name para BL views)
  returns12m: number;
  returns3m: number;
  returns1m: number;
  earningsYield: number;
  volatility: number;   // decimal anualizado (0.60 = 60%)
  sector?: string;
}

// FEAT-PROVENANCE (Jul-2026): trazabilidad por capa para cada activo.
// Cada campo captura el peso relativo del activo DESPUÉS de aplicar cada capa.
// Esto permite al dashboard mostrar "¿Por qué este peso?" desglosado paso a paso.
// Los pesos son relativos (suman 1.0 en cada etapa) hasta finalAllocation.
export interface AllocationProvenance {
  regimeTiltMultiplier: number;   // × por REGIME_TILT (EXPANSION: crypto +40%, CONTRACTION: gold +40%)
  btcCapMultiplier: number;       // × por BTC cap dinámico (1.0 = sin cap, <1.0 = cap aplicado)
  cycleTopMultiplier: number;     // × por Cycle Top detection (1.0 = SAFE, <1.0 = CAUTION/DANGER trim)
  finalPreExposure: number;       // peso relativo final (suma 1.0) antes de × totalInvested
}

export interface OlympusOutput {
  name: string;
  momentumScore: number;
  valueScore: number;
  valuePercentileRank: number;
  qualityScore: number;
  lowVolScore: number;
  expectedReturn: number;
  normalizedExpectedReturn: number;
  kellyFraction: number;
  rawKelly: number;
  isCapped: boolean;
  isFloored: boolean;    // FIX M1: true si floor=0 por expectativa negativa
  effectiveCap: number;   // cap de Kelly realmente aplicado
  kellyAllocation: number;
  markowitzAllocation: number;
  riskParityAllocation: number;
  blendedAllocation: number;
  volAdjustedAllocation: number;
  finalAllocation: number;
  // FEAT-PROVENANCE: trazabilidad por capa
  provenance?: AllocationProvenance;
}

export type { PortfolioRegime };

export interface ScenarioProbabilities {
  bull: number;
  neutral: number;
  bear: number;
  expectedExposure: number;
}

// ── Modo sombra: cartera v5.3 legacy en paralelo (SOLO observabilidad) ──
// Permite comparar CORE vs v5.3 en el dashboard durante el periodo de sombra
// del plan de cutover. Cero estado, cero efectos, cero riesgo: es lectura.
export interface CoreShadowResult {
  engineVersion: string;
  regime: string;
  allocations: { name: string; ticker?: string; finalAllocation: number }[];
  totalInvested: number;
}

export interface EngineOutput {
  allocations: OlympusOutput[];
  regime: PortfolioRegime;
  masterRegime: MasterRegimeOutput;
  correlationPenalty: number;
  totalAllocation: number;
  // FIX-V5-2: ahora refleja la exposición real invertida (< 1.0 cuando tail/vol activos)
  totalInvested: number;
  volTargetMultiplier: number;
  tailRiskOverlay: number;
  tailRiskActive: boolean;
  tailRiskReason: string;
  engineVersion: string;
  meta: {
    allCash: boolean;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    dominantSignal: string;
    hasRealCovMatrix: boolean;
    // FIX-V5-5: flag cuando totalPortfolioValue no fue proporcionado
    dcaDataMissing: boolean;
    // ERP Trigger: equity risk premium comprimido
    erpTriggered: boolean;
    erpValue: number;
    // Correlation Panic: convergencia de correlaciones
    correlationPanicTriggered: boolean;
    avgCorrelationValue: number;
    // FIX-POSTMORTEM: absolute trend gates (Oct 2026)
    absoluteTrendGateActive: boolean;
    absoluteTrendGateMultiplier: number;
    absoluteTrendGateReason: string;
    absoluteTrendGateNegativeCount: number;
    absoluteTrendGateNegativePct: number;
    totalInvestedAlpha: number;
    totalInvestedAfterGate: number;
    totalInvestedBase: number;
    erpCapFactor: number;
    breadthPolicy: typeof BREADTH_RISK_POLICY.productionMode;
    riskOverlayPriority: typeof BREADTH_RISK_POLICY.institutionalPriority;
    regimeBreadthDivergence: boolean;
    institutionalBreadthShadow: InstitutionalBreadthResult | null;
    institutionalBreadthShadowApplied: boolean;
    breadthEffectiveMultiplier: number;
    breadthEffectiveSource: 'legacy' | 'institutional_shadow' | 'legacy_and_institutional_shadow';
    // OLYMPUS CORE v1.0: trazabilidad del perfil y del overlay Trend Gate
    coreMode: boolean;
    coreTrendGateActive: boolean;
    coreTrendGateMultiplier: number;
    coreTrendGateReason: string;
    coreShadow?: CoreShadowResult | null;
    // FIX-AUDIT-R10: transparencia del overlay discrecional
    allocationProvenance: {
      quantWeight: number;
      discretionaryWeight: number;
      source: 'quant' | 'mixed' | 'overlay';
      overlayActive: boolean;
      reason: string;
    };
  };
  btcCycle?: {
    btcScore: number;
    btcNumeric: number;
    signal: 'STRONG_BUY' | 'BUY' | 'ACCUMULATE' | 'HOLD' | 'REDUCE';
    boostActive: boolean;
    breakdown: { mvrvScore: number; puellScore: number; rsiScore: number };
  };
  dca?: {
    investPercent: number;
    investAmount: number;
    frequency: 'weekly' | 'biweekly' | 'monthly' | 'none';
    boostMultiplier: number;
    effectiveIntensity: number;
  };
  coreSignal: {
    regimeComponent: number;
    btcComponent: number;
    riskComponent: number;
    finalScore: number;
  };
  scenarioProbabilities: ScenarioProbabilities;
  metaIntelligence: {
    modelHealth: 'RELIABLE' | 'DEGRADED' | 'UNRELIABLE';
    confidenceMultiplier: number;
    consecutiveErrors: number;
    recommendation: string;
  };
  killSwitchLevel: 0 | 1 | 1.5 | 2 | 3 | 4 | 5;
  killSwitchName: string;
}

export interface OlympusEngineInput {
  assets: AssetInput[];
  correlationMatrix: number[][];
  macro: {
    vix: number;
    yieldSpread: number;
    creditSpread: number;
    move: number;
    dxyTrend: number;
    btcVol: number;
    m2Growth: number;
    wtiOil?: number;
    cbLiquidityGrowth?: number;  // Global CB Liquidity Growth YoY%
  };
  covMatrix?: number[][];
  portfolioDrawdown?: number;
  portfolioRealizedVol?: number;
  targetVol?: number;
  erpValue?: number;
  blViews?: BLView[];
  // FIX-AUDIT-C3: liquidityGrowth está en PUNTOS PORCENTUALES (ej: 3.2 = 3.2%), no decimal.
  // Esta es la convención histórica del dashboard y de liquidityCycle.ts.
  // Internamente, computeScenarioProbabilities escala los umbrales acordemente.
  liquidityGrowth?: number;
  cewsHistory?: CEWSDataPoint[];
  regimeHistory?: RegimeHistoryEntry[];
  adaptiveFactorWeights?: {
    momentum: number;
    value: number;
    quality: number;
    lowVol: number;
  };
  btcOnChain?: {
    mvrvRatio?: number;
    mvrvZScore?: number;   // MVRV Z-Score — primario sobre ratio bruto (era ETF, Glassnode canónico)
    puellMultiple?: number;
    rsiWeekly?: number;
  };
  availableCash?: number;
  totalPortfolioValue?: number;
  // FIX-HYSTERESIS (01-Jun-2026): el backtest necesita saltarse la hysteresis
  // porque todas las llamadas ocurren en milisegundos.
  bypassHysteresis?: boolean;
  avgCorrelation?: number;
  // FIX-AUDIT-R9 5: SOX RSI semanal + inflation breakeven para CycleTop detection
  soxRsiWeekly?: number;
  inflationBreakeven?: number;
  // FIX-CYCLE-DATA (09-Jul-2026): activar cycle top detectors para los 5 activos no-BTC.
  // Los datos vienen del pipeline marketData → dashboard → engine.
  uraniumSpotPrice?: number;
  uraniumLTPrice?: number;
  siaSalesYoY?: number;
  wlgRsiWeekly?: number;
  wlgPERatio?: number;
  emxcRsiWeekly?: number;
  emxcPERatio?: number;
  // FIX-INSTITUCIONAL (Jul-2026): Shiller CAPE + DXY spot para cycle top detection.
  // CAPE: estándar institucional de valoración (Shiller, Nobel 2013). Vía FRED.
  // DXY: #1 factor de riesgo EM (BIS research). Vía Yahoo DX-Y.NYB.
  cape?: number;
  dxySpot?: number;
  cycleTopSignals?: { ticker: string; allocationMultiplier: number }[];
  regimeLock?: RegimeLock | null;
  blendWeights?: {
    BL?: number;
    HRP?: number;
    MIN_VAR?: number;
    KELLY?: number;
    kelly?: number;
    hrp?: number;
    markowitz?: number;
  };
  // OLYMPUS CORE v1.0 (evidencia Phases 9-12, ver OLYMPUS_CORE_v1.0_SPEC.md):
  // perfil canónico opt-in — blend HRP puro, stack defensivo OFF, caps BTC OFF.
  // Default undefined → comportamiento v5.3 completo (cero cambios en producción).
  coreMode?: boolean;
  // Modo sombra: ejecuta la cartera v5.3 legacy en paralelo (misma matemática
  // exacta, sin tocar el resultado principal). Cero estado y cero coste de
  // riesgo: es SOLO observabilidad (comparativa CORE vs v5.3, plan de cutover).
  coreShadowMode?: boolean;
  // Covarianza canónica del CORE (Ledoit-Wolf, spec OLYMPUS_CORE v1.0 §4).
  // SOLO la consume la ejecución en sombra: el CORE validado en Phase 12 usa LW,
  // mientras el motor principal puede operar con covarianza dinámica (DCC).
  // Sin fidelidad de covarianza, la sombra mediría "CORE con DCC" — que es
  // exactamente la configuración que el criterio pre-registrado RECHAZÓ.
  coreCovMatrix?: number[][];
  // Overlay OPCIONAL del Trend Gate (solo relevante si coreMode). Requiere estado
  // persistente entre rebalanceos para el mecanismo re-entry.
  coreTrendGate?: boolean;
  coreTrendGateState?: CoreTrendGateState;
  // Diagnostic-only counterfactual controls. Defaults preserve production behavior.
  absoluteTrendGateOverride?: {
    enabled?: boolean;
    /** Disables only the legacy breadth branch while preserving BTC/correlation gates. */
    disableMajority?: boolean;
    majorityThreshold?: number;
    majorityCap?: number;
  };
  // Institutional breadth candidate. Shadow mode by default; never changes
  // production allocations unless explicitly promoted after OOS approval.
  institutionalBreadthShadow?: {
    enabled?: boolean;
    applyToAllocations?: boolean;
    state?: InstitutionalBreadthState;
    config?: Partial<InstitutionalBreadthConfig>;
  };
}

// ── ESCENARIOS PROBABILÍSTICOS ────────────────────────────────────────────────
function computeScenarioProbabilities(
  regimeProbs: { expansion: number; contraction: number; crisis: number },
  btcNumeric: number,
  liquidityGrowth: number
): ScenarioProbabilities {
  let pBull    = regimeProbs.expansion;
  let pNeutral = regimeProbs.contraction;
  let pBear    = regimeProbs.crisis;

  // Ajuste por BTC on-chain
  const btcAdjustment = (btcNumeric - 0.5) * 0.40;
  pBull = Math.max(0.05, Math.min(0.90, pBull + btcAdjustment));
  pBear = Math.max(0.05, Math.min(0.90, pBear - btcAdjustment));

  // Ajuste por liquidez M2
  if (liquidityGrowth < 0) {
    const penalty = Math.min(0.15, Math.abs(liquidityGrowth) / 10);
    pBull = Math.max(0.05, pBull - penalty);
    pBear = Math.min(0.90, pBear + penalty);
  } else if (liquidityGrowth > 5) {
    const boost = Math.min(0.10, (liquidityGrowth - 5) / 20);
    pBull = Math.min(0.90, pBull + boost);
    pBear = Math.max(0.05, pBear - boost);
  }

  // FIX-V5-4: normalización coherente en un único paso.
  // ANTES: pNeutral se calculaba usando pBull ya normalizado pero pBear aún sin normalizar.
  //   → resultado: pBull/total - pBear_original en lugar de pBear/total
  //   → total2 ≠ 1.0 limpio → segunda normalización necesaria para compensar
  // AHORA: normalizar los tres simultáneamente, luego aplicar floor de 0.05 a cada uno,
  //   luego una única renormalización final. Sin mezclar normalizados/no-normalizados.
  const total = pBull + pNeutral + pBear;
  if (total > 0) {
    pBull    /= total;
    pNeutral /= total;
    pBear    /= total;
  }
  // Floor mínimo: ninguna probabilidad puede ser < 5%
  pBull    = Math.max(0.05, pBull);
  pNeutral = Math.max(0.05, pNeutral);
  pBear    = Math.max(0.05, pBear);
  // Normalización final
  const total2 = pBull + pNeutral + pBear;
  pBull    /= total2;
  pNeutral /= total2;
  pBear    /= total2;

  const expectedExposure = pBull * 1.0 + pNeutral * 0.60 + pBear * 0.20;
  return { bull: pBull, neutral: pNeutral, bear: pBear, expectedExposure };
}

// ── MOTOR PRINCIPAL ───────────────────────────────────────────────────────────
export function runOlympusEngine(input: OlympusEngineInput): EngineOutput {
  // FIX-R4.4b (09-Jul-2026): sanitizar NaN/Inf en assets ANTES de que
  // contaminen momentum → Kelly → blend → toda la cadena de allocations.
  // Sin este guard, un solo returns12m=NaN produce finalAllocation=NaN
  // para TODOS los activos, y el guard R4.4 al final corrige allocations
  // pero no totalInvested (que ya fue calculado con pesos corruptos).
  const sanityAssets = input.assets.map(a => ({
    ...a,
    returns12m:     Number.isFinite(a.returns12m)     ? a.returns12m     : 0,
    returns3m:      Number.isFinite(a.returns3m)      ? a.returns3m      : 0,
    returns1m:      Number.isFinite(a.returns1m)      ? a.returns1m      : 0,
    earningsYield:  Number.isFinite(a.earningsYield)  ? a.earningsYield  : 0,
    volatility:     Number.isFinite(a.volatility) && a.volatility > 0 && a.volatility < 10
                      ? a.volatility : 0.25,
  }));
  const assets = sanityAssets;
  const { correlationMatrix, macro } = input;

  // FIX-ERP-DEFAULT: sin dato explícito del usuario → erpMultiplier = 1.0 (neutro).
  // ANTES: erpRaw ?? 0.02 producía erpMultiplier=1.05 → +5% boost a equity sin justificación.
  // AHORA: solo se aplica boost/penalty cuando el usuario introduce ERP explícitamente.
  const erpRaw        = input.erpValue ?? 0.02;  // 0.02 para display, no para boost
  const erpMultiplier = input.erpValue !== undefined
    ? Math.max(0.85, Math.min(1.10, 1 + erpRaw * 2.5))
    : 1.0;
  // CORRECCIÓN: verificar también que las dimensiones de covMatrix coinciden con assets.length.
  // Antes solo se comprobaba length > 0, lo que provocaba que minimumVarianceWeights,
  // HRP y BL recibieran una matriz de dimensión distinta → warning en cada ejecución
  // y fallback a equal weight silencioso.
  const hasRealCovMatrix = !!(input.covMatrix && input.covMatrix.length === assets.length && input.covMatrix.every(row => row.length === assets.length));

  // OLYMPUS CORE v1.0 (FIX-PHASE12): el perfil Core puede activarse por llamada
  // (input.coreMode) o globalmente (OLYMPUS_CORE.enabled, change-control §18).
  const coreMode = input.coreMode ?? OLYMPUS_CORE.enabled;
  // Blend Core y pesos carry: coreCarry[i] === 0.0 exacto ∀i → suma idempotente
  // (preserva bit-idéntico el blend HRP puro validado en Phase 12 y no altera
  // ninguna suma en modo no-Core).
  const coreBlend = OLYMPUS_CORE.blend;
  const coreCarry: number[] = assets.map(() => 0);

  // ====== CAPA 0: BTC CYCLE OVERLAY ======
  const btcCycleInput: BTCCycleInput = {
    mvrvRatio:    input.btcOnChain?.mvrvRatio,
    mvrvZScore:   input.btcOnChain?.mvrvZScore,
    puellMultiple: input.btcOnChain?.puellMultiple,
    rsiWeekly:    input.btcOnChain?.rsiWeekly,
  };
  const btcCycle = computeBTCCycleOverlay(btcCycleInput);

  // ====== CAPA 1: META-INTELIGENCIA ======
  const predictionHistory = loadPredictionHistory();
  const metaIntelligence  = computeMetaIntelligence(predictionHistory);

  // ====== CAPA 2: RÉGIMEN UNIFICADO ======
  const masterRegime = getMasterRegime(
    {
      vix:         macro.vix,
      yieldSpread: macro.yieldSpread,
      creditSpread: macro.creditSpread,
      move:        macro.move,
      dxyTrend:    macro.dxyTrend,
      btcVol:      macro.btcVol,
      m2Growth:    macro.m2Growth,
      wtiOil:      macro.wtiOil,
      cbLiquidityGrowth: macro.cbLiquidityGrowth,
    },
    input.cewsHistory,
    input.regimeHistory,
    input.bypassHysteresis,  // FIX-HYSTERESIS: backtest pasa true
    input.regimeLock
  );

  // SPRINT-5-A: adjustedRegimePenalty — fórmula correcta + justificación empírica.
  //
  // PROBLEMA DETECTADO (FIX-V5-1):
  //   ANTES: Math.max(regimePenalty, regimePenalty / confidenceMultiplier)
  //   Con confidence=0.70 y regimePenalty=0.40 → 0.40/0.70=0.571
  //   Esto INVERTÍA la lógica: modelo degradado → penalización MÁS LAXA (5% más de exposición).
  //   Es el error clásico de confundir "ajustar" con "compensar".
  //
  // FÓRMULA ACTUAL (CORREGIDA):
  //   adjustedRegimePenalty = regimePenalty × confidenceMultiplier
  //   confidence=1.0 (RELIABLE)   → sin cambio: 0.40 × 1.0 = 0.40
  //   confidence=0.85 (DEGRADED)  → penalización +15%: 0.40 × 0.85 = 0.34
  //   confidence=0.70 (UNRELIABLE) → penalización +30%: 0.40 × 0.70 = 0.28
  //
  // JUSTIFICACIÓN EMPÍRICA:
  //   El penalty [0.4, 1.0] alimenta dos rutas:
  //     a) coreSignalScore vía regimeNumeric → modula kellyAllocation
  //     b) volTarget vía regimeFactor → escala el target de volatilidad
  //
  //   Un multiplicador de 0.70 en ambas rutas produce:
  //     - Kelly: kellyAlloc × 0.70 → asset allocation ~30% más conservadora
  //     - Vol: adjustedTarget = 20% × (0.60 + (0.28-0.4)×(0.40/0.60)) = 20% × 0.52 = 10.4%
  //     - Efecto combinado: ~40-50% de la exposición original
  //
  //   Esto es correcto: si el modelo ha fallado 3+ veces consecutivas, el sistema
  //   debe operar al 40-50% de su capacidad normal hasta que el modelo se recalibre.
  //
  // ALCANCE:
  //   - CRISIS: sí (el riesgo de falso positivo es bajo, el de falso negativo es catastrófico)
  //   - CONTRACTION: sí (misma lógica, riesgo asimétrico)
  //   - EXPANSION: no (el riesgo en EXPANSION es sobreexposición, manejado por Kill Switch)
  const adjustedRegimePenalty =
    (masterRegime.regime === 'CRISIS' || masterRegime.regime === 'CONTRACTION')
      ? Math.min(1.0, masterRegime.regimePenalty * metaIntelligence.confidenceMultiplier)  // FIX-CLAMP: CONTRACTION nunca debe exceder EXPANSION (penalty <= 1.0). Con binary=0.85 y confidence=1.30, 0.84*1.30=1.09 sin clamp → boost en vez de reduccion.
      : masterRegime.regimePenalty;

  const corrPenalty = correlationPenalty(correlationMatrix);

  // ====== CORE SIGNAL ======
  // coreSignalScore modula kellyAlloc directamente (no es decorativo).
  //
  // SPRINT-5-B: pesos recalibrados — justificación empírica:
  //   ANTES: regime 45%, BTC 35%, risk 20%
  //     BTC con peso 35% dominaba el score cuando btcSignal = STRONG_BUY (score=0.8-1.0).
  //     Un activo que sube 80% anual no es necesariamente "señal de compra agresiva"
  //     para el portafolio total (BTC ya tiene su propio cap en CAPA 9).
  //     Resultado: Alpha-Boost + coreSignal alto → sobreexposición crónica.
  //
  //   AHORA: regime 55%, BTC 20%, risk 25%
  //     - Régimen como señal dominante (55%): el VIX, credit spreads y yield curve
  //       capturan el estado macro general del mercado. Es la señal más robusta.
  //     - Risk sube a 25%: la volatilidad realizada del portafolio actúa como freno
  //       natural. Si el portafolio está saltando >40% vol anual, el score baja.
  //     - BTC baja a 20%: sigue siendo relevante pero deja de dominar. Su efecto
  //       principal se canaliza por BTC CAP (CAPA 9), no por coreSignal.
  const regimeNumeric  = adjustedRegimePenalty;
  const btcNumeric     = btcCycle.btcNumeric;
  // ── RiskNumeric usa vol CORE (ex-BTC) ─────────────────────────────────────
  // BTC con vol ~72% contamina la métrica de riesgo del portfolio completo.
  // Para el coreSignalScore usamos la vol media ponderada de los activos NO-BTC,
  // para que EMXC/PPFB/URNU/VVSM/WLG no sean penalizados por BTC.
  const btcIdxRisk = assets.findIndex(a => {
    const n = a.name.toLowerCase();
    return n.includes('btc') || n.includes('bitcoin');
  });
  let coreVolEstimate = input.portfolioRealizedVol ?? 0.18;
  if (btcIdxRisk >= 0) {
    const nonBtcAssets = assets.filter((_, i) => i !== btcIdxRisk);
    if (nonBtcAssets.length > 0) {
      // FIX A4: media ponderada — pero relativeWeights aún no existe aquí.
      // Usamos equal weight como aproximación inicial; el vol target final
      // (CAPA 7) usa relativeWeightsAfterCap que SÍ está disponible entonces.
      coreVolEstimate = nonBtcAssets.reduce((s, a) => s + a.volatility, 0) / nonBtcAssets.length;
    }
  }
  const riskNumeric    = 1 - (coreVolEstimate / 0.50);
  const coreSignalScore = CORE_SIGNAL_WEIGHTS.REGIME * regimeNumeric
                        + CORE_SIGNAL_WEIGHTS.BTC * btcNumeric
                        + CORE_SIGNAL_WEIGHTS.RISK * Math.max(0, riskNumeric);

  // ====== ESCENARIOS PROBABILÍSTICOS ======
  // FIX-AUDIT-TRANSVERSAL #3 (Jul-2026): usar macro.cbLiquidityGrowth en vez
  //   de input.liquidityGrowth (que es M2 growth del dashboard state).
  //   cbLiquidityGrowth mide la base monetaria (QE/QT directo de bancos
  //   centrales), que es el driver correcto para ajustar pBull/pBear.
  //   Fallback a input.liquidityGrowth si cbLiquidityGrowth no está disponible.
  const scenarioProbabilities = computeScenarioProbabilities(
    masterRegime.regimeProbs,
    btcNumeric,
    macro.cbLiquidityGrowth ?? input.liquidityGrowth ?? 0
  );

  // ====== CAPA 3: FACTOR SCORES ======
  const universeStats  = computeUniverseStats(assets as ValueInput[]);
  const qualityStats   = computeQualityUniverseStats(assets as QualityInput[]);
  const lowVolStats    = computeLowVolUniverseStats(assets);

  const rawScores = assets.map((asset) => {
    const momentum = calculateMomentum({
      returns12m: asset.returns12m,
      returns1m:  asset.returns1m,
      returns3m:  asset.returns3m,
    });
    const value   = calculateValue({ earningsYield: asset.earningsYield }, universeStats);
    const quality = calculateQuality(asset as QualityInput, qualityStats);
    const lowVol  = calculateLowVol(asset, lowVolStats);

    // FIX-BIMODAL (30-May-2026): Factor weights dinámicos por régimen.
    // Si el usuario pasa adaptiveFactorWeights explícito, se respeta.
    // Si no, se usan los weights dinámicos según el régimen detectado.
    const fw = input.adaptiveFactorWeights ?? getFactorWeightsByRegime(masterRegime.regime);
    const calibrated = calibrateExpectedReturn({
      momentumScore: momentum.momentumScore,
      valueScore:    value.valueScore,
      qualityScore:  quality.qualityScore,
      lowVolScore:   lowVol.lowVolScore + lowVol.downsideVolPenalty,
    }, fw);

    return { asset, momentum, value, quality, lowVol, rawExpectedReturn: calibrated.expectedReturn, calibrated };
  });

  // ====== CAPA 4: KELLY ======
  // coreSignalScore integra régimen + BTC on-chain + vol-risk como modulador global.
  const kellyAllocations = rawScores.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn, calibrated }) => {
    const kelly   = calculateKelly({ expectedReturn: rawExpectedReturn, volatility: asset.volatility });
    const isEquity = asset.earningsYield > 0;
    const erpAdj  = isEquity ? erpMultiplier : (erpRaw < -0.005 ? 1.03 : 1.0);
    const kellyAlloc = kelly.kellyFraction * coreSignalScore * erpAdj;  // FIX-CALIBRATION: eliminado * corrPenalty (redundante con Correlation Panic + Absolute Trend Gates)
    return { asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn: rawExpectedReturn, calibrated, kelly, kellyAlloc };
  });

  const totalKelly = kellyAllocations.reduce((s, a) => s + a.kellyAlloc, 0);
  if (totalKelly === 0) {
    // FIX-STATE-MASKING (Jul-2026): ANTES hardcodeaba killSwitchLevel:0, tailRiskActive:false,
    // volTargetMultiplier:0. Si el totalKelly cae a 0 en un colapso de mercado, el dashboard
    // veía "SIN TRIGGER" cuando en realidad el Kill Switch estaba en L4-L5.
    // AHORA: computamos tailRisk y volTarget reales AUNQUE la exposición sea 0.
    // El inversor necesita saber la verdad, no una mentira tranquilizadora.
    const estimatedRealizedVol = input.portfolioRealizedVol ?? 0.18;
    const allCashTailRisk = computeTailRiskOverlay({
      drawdown:           input.portfolioDrawdown ?? 0,
      vix:                macro.vix,
      creditSpread:       macro.creditSpread,
      stressScore:        masterRegime.stressDetail.score,
      portfolioVolatility: estimatedRealizedVol,
      avgCorrelation:     input.avgCorrelation,
    });
    const allCashVolTarget = computeVolTargetMultiplier({
      targetVol:     input.targetVol ?? VOLATILITY_CONFIG.DEFAULT_TARGET_VOL,
      realizedVol:   estimatedRealizedVol,
      regimePenalty: adjustedRegimePenalty,
    });

    const empty = kellyAllocations.map(({ asset, momentum, value, quality, lowVol, rawExpectedReturn, kelly }) => ({
      name: asset.name, momentumScore: momentum.momentumScore, valueScore: value.valueScore,
      valuePercentileRank: value.percentileRank, qualityScore: quality.qualityScore,
      lowVolScore: lowVol.lowVolScore, expectedReturn: rawExpectedReturn,
      normalizedExpectedReturn: rawExpectedReturn, kellyFraction: kelly.kellyFraction, rawKelly: kelly.rawKelly,
      isCapped: kelly.isCapped,
      isFloored: kelly.isFloored,
      effectiveCap: kelly.effectiveCap, kellyAllocation: 0, markowitzAllocation: 0,
      riskParityAllocation: 0, blendedAllocation: 0, volAdjustedAllocation: 0, finalAllocation: 0,
    }));
    return {
      allocations: empty, regime: "ALL_CASH", masterRegime, correlationPenalty: corrPenalty,
      totalAllocation: 0, totalInvested: 0,
      volTargetMultiplier: allCashVolTarget.multiplier,
      tailRiskOverlay:     allCashTailRisk.overlay,
      tailRiskActive:      allCashTailRisk.isActive,
      tailRiskReason:      allCashTailRisk.triggerReason,
      engineVersion: ENGINE_VERSION,
      meta: { allCash: true, confidence: masterRegime.confidence, dominantSignal: masterRegime.dominantSignal, hasRealCovMatrix, dcaDataMissing: !input.totalPortfolioValue, erpTriggered: input.erpValue !== undefined && erpRaw < ERP_CONFIG.TRIGGER_THRESHOLD, erpValue: erpRaw, correlationPanicTriggered: input.avgCorrelation !== undefined && input.avgCorrelation > CORRELATION_PANIC_CONFIG.PANIC_THRESHOLD, avgCorrelationValue: input.avgCorrelation ?? 0, absoluteTrendGateActive: false, absoluteTrendGateMultiplier: 1.0, absoluteTrendGateReason: 'ALL_CASH: gates bypassed (zero exposure)', absoluteTrendGateNegativeCount: 0, absoluteTrendGateNegativePct: 0, totalInvestedAlpha: 0, totalInvestedAfterGate: 0, totalInvestedBase: 0, erpCapFactor: 1, breadthPolicy: BREADTH_RISK_POLICY.productionMode, riskOverlayPriority: BREADTH_RISK_POLICY.institutionalPriority, regimeBreadthDivergence: false, institutionalBreadthShadow: null, institutionalBreadthShadowApplied: false, breadthEffectiveMultiplier: 1.0, breadthEffectiveSource: 'legacy',      coreMode,
      coreShadow: null, // ALL_CASH: sin sombra (borde de emergencia, no comparativa)
      coreTrendGateActive: false, coreTrendGateMultiplier: 1.0, coreTrendGateReason: 'ALL_CASH: gates bypassed', allocationProvenance: { quantWeight: 1, discretionaryWeight: 0, source: 'quant', overlayActive: false, reason: 'ALL_CASH: 100% cuantitativo (sin exposición)' } },
      btcCycle: { btcScore: btcCycle.btcScore, btcNumeric: btcCycle.btcNumeric, signal: btcCycle.signal, boostActive: btcCycle.boostActive, breakdown: btcCycle.breakdown },
      dca: { investPercent: 0, investAmount: 0, frequency: 'monthly', boostMultiplier: 1, effectiveIntensity: 0 },
      coreSignal: { regimeComponent: CORE_SIGNAL_WEIGHTS.REGIME * regimeNumeric, btcComponent: CORE_SIGNAL_WEIGHTS.BTC * btcNumeric, riskComponent: CORE_SIGNAL_WEIGHTS.RISK * Math.max(0, riskNumeric), finalScore: coreSignalScore },
      scenarioProbabilities,
      metaIntelligence: { modelHealth: metaIntelligence.modelHealth, confidenceMultiplier: metaIntelligence.confidenceMultiplier, consecutiveErrors: metaIntelligence.consecutiveErrors, recommendation: metaIntelligence.recommendation },
      killSwitchLevel: allCashTailRisk.killSwitchLevel,
      killSwitchName:  allCashTailRisk.killSwitchName,
    };
  }

  const kellyNorm = kellyAllocations.map(a => ({ ...a, kellyNormalized: a.kellyAlloc / totalKelly }));

  // ====== CAPA 5: HRP ======
  const hrpResult  = computeHRP(hasRealCovMatrix ? input.covMatrix! : [], assets.length);
  const hrpWeights = hrpResult.weights;

  // ====== CAPA 6: BLACK-LITTERMAN ======
  let blWeights: number[] = assets.map(() => 1 / assets.length);
  if (hasRealCovMatrix && input.covMatrix) {
    try {
      // FIX-R2-B9: generateViewsExternal usa ranking cross-sectional (no scores del motor).
      // Rompe el bucle tautológico identificado en auditoría ronda 2.
      // generateViewsFromEngine se mantiene como fallback legacy.
      const blViews = input.blViews ?? generateViewsExternal(
        rawScores.map(s => ({
          name:               s.asset.name,
          ticker:             s.asset.ticker ?? s.asset.name,
          returns12m:         s.asset.returns12m,
          earningsYield:      s.asset.earningsYield,
          volatility:         s.asset.volatility,
        })),
        masterRegime.regime,
        input.liquidityGrowth ?? 0
      );
      // Prior de mercado: volatilidad inversa (proxy de capitalización).
      // Activos de alta vol (BTC) → menor peso en prior → prior más defensivo.
      const invVols    = assets.map(a => 1 / Math.max(a.volatility, 0.05));
      const invVolSum  = invVols.reduce((s, v) => s + v, 0);
      const marketWeights = invVols.map(v => v / invVolSum);
      const blResult = runBlackLitterman({
        // FIX-BL-TICKER: usar ticker (no name) para que las views matcheen.
        // generateViewsFromEngine crea views con assets: [asset.ticker] (ej: "PPFB.DE").
        // buildPickingMatrices busca por assetNames.indexOf(ticker) — si recibe "Gold (ETC)"
        // en vez de "PPFB.DE", la picking matrix queda en ceros → views sin efecto.
        assetNames:    assets.map(a => a.ticker ?? a.name),
        covMatrix:     input.covMatrix,
        marketWeights,
        views:         blViews,
        riskAversion:  masterRegime.regime === "CRISIS" ? 4.0 : masterRegime.regime === "CONTRACTION" ? 3.0 : 2.5,
        tau:           0.05,
      });
      blWeights = blResult.posteriorWeights;
    } catch {
      blWeights = assets.map(() => 1 / assets.length);
    }
  }

  // ====== BLEND FINAL: Dinámico según Régimen ──────────────────────────────────
  // Slicing de Blend: En EXPANSION somos más agresivos con las Views (BL)
  const useAggressiveBlend = masterRegime.regime === 'EXPANSION';
  const currentBlend = useAggressiveBlend
    ? (hasRealCovMatrix ? BLEND_WEIGHTS.WITH_COV.AGGRESSIVE : BLEND_WEIGHTS.WITHOUT_COV.AGGRESSIVE)
    : (hasRealCovMatrix ? BLEND_WEIGHTS.WITH_COV.CONSERVATIVE : BLEND_WEIGHTS.WITHOUT_COV.CONSERVATIVE);

  const minVarW = hasRealCovMatrix
    ? minimumVarianceWeights(input.covMatrix!, assets.length)
    : assets.map(() => 1 / assets.length);

  const currentBlendAccess = currentBlend as Record<string, number>;

  const blendWeights = assets.map((_, i) => {
    if (coreMode) {
      // OLYMPUS CORE v1.0: HRP puro (bit-idéntico a blendWeights={HRP:1},
      // el fingerprint validado en los 3 runs OOS de Phase 12).
      return hrpWeights[i] * coreBlend.HRP;
    }
    if (hasRealCovMatrix) {
      const weights = input.blendWeights ?? currentBlendAccess;
      return blWeights[i]             * (weights.BL ?? weights.kelly ?? 0.20)
           + hrpWeights[i]            * (weights.HRP ?? weights.hrp ?? 0.65)
           + minVarW[i]               * (weights.MIN_VAR ?? weights.markowitz ?? 0.00)  // FIX-ABLATION-MINVAR: fallback a 0.00 (MinVar eliminado por ablation study)
           + coreCarry[i]             * (weights.BL ?? weights.kelly ?? 0.20);
    } else {
      const weights = input.blendWeights ?? currentBlendAccess;
      return kellyNorm[i].kellyNormalized * (weights.KELLY ?? weights.kelly ?? 0.25)
           + hrpWeights[i]               * (weights.HRP ?? weights.hrp ?? 0.75)
           + coreCarry[i]                * (weights.KELLY ?? weights.kelly ?? 0.25);
    }
  });

  const totalBlend = blendWeights.reduce((s, w) => s + w, 0) || 1;
  const blendNorm  = blendWeights.map(w => w / totalBlend);

  // CAPA 8.7: ABSOLUTE TREND GATES (Post-Mortem Oct 2026) ──────────────────
// FIX-POSTMORTEM: cierra la brecha entre el motor cross-sectional (BL+HRP)
// y el riesgo de mercado absoluto. El motor rankea activos relativamente —
// el "mejor" activo en un bear market sigue teniendo retorno negativo.
//
// Cuatro señales absolutas que el motor ignoraba hasta ahora:
//   1. AbsTrend Gate: si TODOS los activos tienen returns3m < 0, la
//      diversificación no protege → cap exposición al 50%
//   2. BTC Bear Gate: si BTC returns12m < -30% (proxy de BTC < MA200)
//      Y (MVRV > 2.5 → sobrevalorado O régimen != EXPANSION),
//      → cap adicional al 35%. En EXPANSION con MVRV ≤ 2.5, el gate
//      se DESACTIVA: BTC infravalorado + macro favorable = acumulación.
//   3. DXY Risk-Off: si DXY acelera >5% en 3 meses, es tightening
//      financiero global → -10pp adicional
//   4. Corr Convergence: si avgCorrelation > 0.60, la diversificación
//      ya está erosionada → -5pp (antes de llegar al panic >0.85)
//
// Floor: 25% — los gates no van a 0; Tail Risk + Kill Switch deciden si
// hay que ir a cash total.
// ==========================================================================
  function computeAbsoluteTrendGates(
    assets: AssetInput[],
    avgCorrelation: number | undefined,
    btcMVRV?: number,
    regime?: string,
    override: OlympusEngineInput['absoluteTrendGateOverride'] = {},
  ): { multiplier: number; reason: string; active: boolean } {
    if (override.enabled === false) return { multiplier: 1.0, reason: 'disabled by diagnostic counterfactual', active: false };

    let multiplier = 1.0;
    const reasons: string[] = [];

    // Encontrar BTC para obtener returns12m
    const btcAsset = assets.find(a => {
      const n = (a.ticker ?? a.name).toLowerCase();
      return n.includes('btc') || n.includes('bitcoin');
    });
    const btcReturns12m = btcAsset?.returns12m;

    // FEAT-BEAR-VETO (Jul-2026): price-action circuit breaker.
    // Cross-sectional models (BL+HRP) are blind to absolute market direction.
    // In synchronized bear markets, the "best" asset is still losing money.
    // These gates trigger BEFORE the engine concentrates into relative winners.
    //
    // Gate 1a: Majority Bearish — >50% of assets negative in 3 months
    //   → exposure cap 60%. The engine can still invest but must diversify.
    const negativeCount = assets.filter(a => a.returns3m < 0).length;
    const negativePct = assets.length > 0 ? negativeCount / assets.length : 0;
    
    const majorityThreshold = override.majorityThreshold ?? 0.50;
    const majorityCap = override.majorityCap ?? ABSOLUTE_TREND_GATE.MAJORITY_BEARISH_CAP;
    if (override.disableMajority !== true) {
      if (negativePct > 0.75) {
        multiplier = Math.min(multiplier, ABSOLUTE_TREND_GATE.MOST_BEARISH_CAP);
        reasons.push(`bear-veto: ${(negativePct*100).toFixed(0)}% activos negativos 3m → cap ${(ABSOLUTE_TREND_GATE.MOST_BEARISH_CAP * 100).toFixed(0)}%`);
      } else if (negativePct > majorityThreshold) {
        multiplier = Math.min(multiplier, majorityCap);
        reasons.push(`bear-veto: ${(negativePct*100).toFixed(0)}% activos negativos 3m → cap ${(majorityCap * 100).toFixed(0)}%`);
      }

      // Gate 1b (legacy): ALL assets negative — superado por MOST (75%).
      if (assets.length > 0 && assets.every(a => a.returns3m < 0)) {
        multiplier = Math.min(multiplier, ABSOLUTE_TREND_GATE.ALL_BEARISH_CAP);
        if (!reasons.some(r => r.includes('bear-veto'))) {
          reasons.push(`abs-trend: todos los activos negativos 3m → cap ${(ABSOLUTE_TREND_GATE.ALL_BEARISH_CAP * 100).toFixed(0)}%`);
        }
      }
    }

    // Gate 2: BTC Bear Market — returns12m < -30%
    // FIX-BTCBEAR-MVRV (09-Jul-2026): solo activar si BTC está sobrevalorado (MVRV > 2.5)
    // o si el régimen NO es EXPANSION. En EXPANSION con MVRV < 2.5, BTC está
    // infravalorado → el bear market es oportunidad de acumulación, no peligro.
    const btcMvrvOvervalued = btcMVRV !== undefined && btcMVRV > 2.5;
    const regimeNotExpansion = regime !== undefined && regime !== 'EXPANSION';
    const btcBearGateGuard = btcMvrvOvervalued || regimeNotExpansion;
    if (btcReturns12m !== undefined && btcReturns12m < ABSOLUTE_TREND_GATE.BTC_BEAR_THRESHOLD && btcBearGateGuard) {
      multiplier = Math.min(multiplier, ABSOLUTE_TREND_GATE.BTC_BEAR_CAP);
      const reasonTag = btcMvrvOvervalued ? `MVRV ${btcMVRV!.toFixed(2)} > 2.5 (sobrevalorado)` : `régimen ${regime}`;
      reasons.push(`btc-bear: returns12m ${(btcReturns12m * 100).toFixed(0)}% < ${(ABSOLUTE_TREND_GATE.BTC_BEAR_THRESHOLD * 100).toFixed(0)}% + ${reasonTag} → cap ${(ABSOLUTE_TREND_GATE.BTC_BEAR_CAP * 100).toFixed(0)}%`);
    } else if (btcReturns12m !== undefined && btcReturns12m < ABSOLUTE_TREND_GATE.BTC_BEAR_THRESHOLD) {
      // BTC en bear market pero gate DESACTIVADO: MVRV bajo + EXPANSION = oportunidad de compra
      reasons.push(`btc-bear bypassed: returns12m ${(btcReturns12m * 100).toFixed(0)}% < -30% pero MVRV ${btcMVRV?.toFixed(2) ?? '?'} ≤ 2.5 y régimen EXPANSION → acumulación`);
    }

    // DXY Risk-Off Accelerometer — ELIMINADO (auditoría Jul-2026)
    //   dxyTrend ya entra en computeGlobalStress() vía masterRegime.
    //   Mantenerlo también aquí era doble conteo de la misma señal macro
    //   en dos capas independientes. La regla institucional: una señal,
    //   una capa. Ver AGENTS.md → REGLA INSTITUCIONAL: SEÑALES EN MÚLTIPLES CAPAS.

    // Gate 3: Correlation Convergence — early warning (antes de panic >0.85)
    if (avgCorrelation !== undefined && avgCorrelation > CORRELATION_PANIC_CONFIG.DIVERSIFICATION_COLLAPSE && avgCorrelation <= CORRELATION_PANIC_CONFIG.PANIC_THRESHOLD) {
      multiplier = Math.max(ABSOLUTE_TREND_GATE.FLOOR, multiplier - ABSOLUTE_TREND_GATE.CORR_EARLY_PENALTY);
      reasons.push(`corr-convergence: ${(avgCorrelation * 100).toFixed(0)}% → -${(ABSOLUTE_TREND_GATE.CORR_EARLY_PENALTY * 100).toFixed(0)}pp diversificación`);
    }

    const active = multiplier < 1.0;
    const reason = reasons.length > 0 ? reasons.join(' | ') : 'all-clear';

    return { multiplier, reason, active };
  }
  // ── CAPA TÁCTICA POR RÉGIMEN ────────────────────────────────────────────────
  // FIX-OVERPERF: blendToTacticalRatio bajado de 0.60 → 0.50
  // Con 0.60 → BL 60% da ~5% BTC → BTC final ~14% (vs benchmark 14.29%)
  // El ratio se define en regimeTacticalAllocation.ts → applyTacticalConstraints()
  // FIX-BTC-GATE + FIX-VVSM-GATE: pasar métricas para que los pesos tácticos
  // de BTC y VVSM se reduzcan cuando están sobrevalorados o sobrecalentados.
  // FEAT-ZSCORE-ENGINE (Jul-2026): Z-Score primario, ratio bruto fallback.
  // MVRV Z-Score (Glassnode) normaliza por volatilidad histórica → más robusto en era ETF.
  const btcMVRV = input.btcOnChain?.mvrvZScore ?? input.btcOnChain?.mvrvRatio;
  const vvsmIdx = assets.findIndex(a => {
    const t = (a.ticker ?? a.name).toLowerCase();
    return t === 'vvsm.de' || t.includes('vvsm');
  });
  const vvsmReturns12m = vvsmIdx >= 0 ? assets[vvsmIdx].returns12m : undefined;
  // OLYMPUS CORE v1.0 (FIX-PHASE12-DECISION-MATRIX): el overlay táctico discrecional
  // (-1.27pp CAGR, -0.09 Sharpe vs 100% cuantitativo) y el cluster cap dependen del
  // régimen macro — clasificados REMOVE del Core por la matriz de decisión final.
  // En coreMode el blend cuant (HRP puro) pasa intacto a capas posteriores.
  const tacticalWeights   = coreMode
    ? blendNorm // bypass: sin overlay discrecional
    : getTacticalWeights(masterRegime.regime, assets, btcMVRV, vvsmReturns12m);
  const blendedWithTactical = coreMode
    ? blendNorm // bypass: 100% cuant
    : applyTacticalConstraints(blendNorm, tacticalWeights, masterRegime.regime);
  const finalWeightsBeforeCap = coreMode
    ? blendNorm // bypass: sin cluster cap por régimen
    : enforceClusterCap(blendedWithTactical, assets, masterRegime.regime);
  const totalFinalWeights  = finalWeightsBeforeCap.reduce((s, w) => s + w, 0) || 1;
  // relativeWeights: pesos relativos normalizados a 1.0 (fracción del tramo invertido)
  const relativeWeights = finalWeightsBeforeCap.map(w => w / totalFinalWeights);

  // ── CAPA 6.5: REGIME-CONDITIONAL ASSET TILTING ──────────────────────────────
  // Multiplica los pesos relativos por el tilt del sector/régimen y renormaliza.
  // EXPANSION: +40% crypto, +30% semis, -20% gold → tilt hacia growth
  // CONTRACTION: +40% gold, +15% equity, -40% crypto → tilt hacia defensivos
  // CRISIS: +60% gold, -70% crypto → concentracion en safe havens
  // El breadth ya no modifica el tilt sectorial: evita doble conteo.
  // Su único uso productivo es el control de exposición total más abajo.
  // CAPA 6.5 — OLYMPUS CORE v1.0: el tilting sectorial depende del régimen macro
  // (clasificado OFF/UNVERIFIED). En coreMode los pesos pasan sin tilt.
  const tiltedRelativeWeights = coreMode
    ? relativeWeights
    : applyRegimeTilt(relativeWeights, assets, masterRegime.regime);

  // ── PESOS DE REFERENCIA ─────────────────────────────────────────────────────
  // FIX M5: etiqueta corregida — es equal weight, no Markowitz.
  // El verdadero mínima varianza es minVarW (que sí entra en el blend).
  const equalWeightRef = assets.map(() => 1 / assets.length);
  const rpInputs  = assets.map(a => ({
    name:       a.name,
    volatility: a.volatility,
    riskBudget: DEFAULT_SECTOR_BUDGETS[a.sector ?? ""] ?? 1,
  }));
  const rpResult  = computeRiskParityWeights(rpInputs);
  const rpWeights = assets.map(a => rpResult.find(r => r.name === a.name)?.weight ?? 1 / assets.length);



  // ── BTC CAP (SISTEMA DINÁMICO) ──────────────────────────────────────────────────
  // SPRINT-5-C: auditoría de parámetros del BTC CAP.
  //
  // Parámetro       | Valor | Justificación empírica
  // ────────────────┼───────┼──────────────────────────────────────────────────
  // Default cap     | 20%   | Half-Kelly sobre BTC 50-60% vol → 8-10% óptimo.
  //                 |       | Con Alpha-Boost activo (STRONG_BUY + EXPANSION),
  //                 |       | el límite de 20% permite correr el rally sin
  //                 |       | sobreexposición catastrófica (-80% drawdown BTC).
  //                 |       | Peor caso: 20% del portafolio × -80% = -16% total.
  // STRONG_BUY cap  | 35%   | Solo cuando MVRV < 3.0 (no burbuja). Permite
  //                 |       | sobreponderar BTC en la fase temprana del bull
  //                 |       | sin exceder el límite de Kelly puro (~8% × 4 = 32%).
  //                 |       | Riesgo: -80% × 35% = -28% total (aceptable en early bull).
  // MVRV > 3.5 cap  | 10%   | Zona de burbuja (MVRV alto → precio >> cost basis).
  //                 |       | Históricamente: MVRV > 3.5 precede correcciones
  //                 |       | de 40-60% en BTC (2017 pico, 2021 pico).
  //                 |       | Límite a 10% → drawdown máximo de -8% total.
  //
  // FEAT-ZSCORE-ENGINE (Jul-2026): Z-Score primario para BTC cap dinámico.
  // mvrv = Z-Score ?? ratio bruto. Umbral > 3.5 funciona para ambos:
  // Z-Score: 3.5+ elevado, 5+ muy elevado, 7+ techo canónico
  // Ratio bruto: > 3.5 zona de burbuja (legacy)
  const mvrvZ = input.btcOnChain?.mvrvZScore;
  const mvrvRatioRaw = input.btcOnChain?.mvrvRatio ?? 0;
  const mvrv = mvrvZ ?? mvrvRatioRaw;
  // FIX-AUDIT-C7: BTC caps dinámicos centralizados en BTC_CAPS_BY_REGIME.
  // Antes hardcodeados como 0.20, 0.35, 0.10.
  let dynamicBtcCap = coreMode
    ? 1.0 // OLYMPUS CORE v1.0: caps BTC eliminados (ablación bit-idéntica — nunca binding).
          // El control real de BTC es allocation + Trend Gate + satélite → BTC_TOTAL.
    : (BTC_CAPS_BY_REGIME[masterRegime.regime] ?? 0.20);
  if (!coreMode) {
    if (btcCycle.signal === 'STRONG_BUY' && mvrv < 3.0) {
      dynamicBtcCap = 0.35; // Permite correr el rally
    } else if (mvrv > 3.5) {
      dynamicBtcCap = 0.10; // Protección contra euforia (Z-Score o ratio > 3.5)
    }
  }

  const relativeWeightsAfterCap = [...tiltedRelativeWeights];
  const btcIdx = relativeWeightsAfterCap.findIndex(
    (_, i) => {
      const name = assets[i].name.toLowerCase();
      return name.includes('btc') || name.includes('bitcoin');
    }
  );
  if (btcIdx >= 0 && relativeWeightsAfterCap[btcIdx] > dynamicBtcCap) {
    const excess    = relativeWeightsAfterCap[btcIdx] - dynamicBtcCap;
    relativeWeightsAfterCap[btcIdx] = dynamicBtcCap;
    const otherTotal = relativeWeightsAfterCap.reduce((s, w, i) => i !== btcIdx ? s + w : s, 0);
    if (otherTotal > 0) {
      relativeWeightsAfterCap.forEach((_, i) => {
        if (i !== btcIdx) {
          relativeWeightsAfterCap[i] += excess * (relativeWeightsAfterCap[i] / otherTotal);
        }
      });
    }
  }
  // Re-normalizar pesos relativos tras el cap (pueden no sumar 1.0 exacto por redondeo)
  const relCapTotal = relativeWeightsAfterCap.reduce((s, w) => s + w, 0) || 1;
  relativeWeightsAfterCap.forEach((_, i) => {
    relativeWeightsAfterCap[i] /= relCapTotal;
  });
  // CAPA 8.5: CYCLE TOP OVERLAY (FIX-CYCLE-MOTOR)
  // FIX-AUDIT-TRANSVERSAL-R3 #2 (Jul-2026): el fallback de auto-detección ha sido
  //   eliminado. Usaba datos (uraniumSpotPrice, wlgRsiWeekly, emxcPERatio, dxySpot,
  //   cape, etc.) que el dashboard NUNCA pasaba al engine → detectCycleTops() devolvía
  //   SAFE para todos los no-BTC. Era una falsa red de seguridad.
  //
  //   AHORA: cycleTopSignals es la ÚNICA fuente de verdad. El dashboard precomputa
  //   detectCycleTops() con todos los datos disponibles (uraniumSpot, uraniumLT,
  //   wlgRsiWeekly, wlgPERatio, emxcRsiWeekly, emxcPERatio, dxy, marketData.per).
  //   Si el dashboard no pasa cycleTopSignals, el motor asume [] (sin restricciones).
  //
  //   La función detectCycleTops() sigue disponible para backtests y scripts que
  //   sí tengan acceso a los datos completos (ver scripts/run-backtest-*.ts).
  const activeCycleSignals = input.cycleTopSignals ?? [];
  if (activeCycleSignals.length > 0) {
    for (let i = 0; i < assets.length; i++) {
      const ticker = assets[i].ticker ?? assets[i].name;
      const baseTicker = ticker.split(".")[0];
      const cycleSignal = activeCycleSignals.find(function(s) {
        return s.ticker === ticker || s.ticker.split(".")[0] === baseTicker;
      });
      if (cycleSignal && cycleSignal.allocationMultiplier < 1.0) {
        relativeWeightsAfterCap[i] *= cycleSignal.allocationMultiplier;
      }
    }
    const cycleTotal = relativeWeightsAfterCap.reduce(function(s,w){return s+w;},0) || 1;
    relativeWeightsAfterCap.forEach(function(_,i){relativeWeightsAfterCap[i] /= cycleTotal;});
  }

  // Candidato institucional en shadow mode. Usa el riesgo marginal de la
  // cartera pre-exposición y no interviene en relativeWeightsAfterCap.
  // CORE v1.0: el breadth no forma parte del Core (matriz de decisión Phase 12,
  // componente UNVERIFIED) — se neutraliza en coreMode para que el perfil sea
  // exactamente HRP+LW, y el componente v5.3 queda visible vía shadow dual.
  const institutionalBreadthShadow = !coreMode && input.institutionalBreadthShadow?.enabled === true
    ? evaluateInstitutionalBreadth(
        assets.map((asset, index) => ({
          ticker: asset.ticker ?? asset.name,
          returns3m: asset.returns3m,
          volatility: asset.volatility,
          weight: relativeWeightsAfterCap[index] ?? 0,
          riskContribution: computeMarginalRiskContribution(
            relativeWeightsAfterCap,
            input.covMatrix,
            index,
            asset.volatility,
          ),
        })),
        input.institutionalBreadthShadow?.state,
        resolveInstitutionalBreadthConfig(input.institutionalBreadthShadow?.config),
      )
    : null;

  // ====== CAPA 7: VOL TARGET (reordenado post-BTC-cap) ======
  // FIX-V5-7 (audit ronda 2): realizedVol usa relativeWeightsAfterCap (post-BTC-cap)
  //   ANTES: se computaba con relativeWeights (pre-cap), ignorando el ajuste de BTC cap
  //   AHORA: se computa después del BTC cap, usando los pesos reales del portfolio
  const realizedVol = input.portfolioRealizedVol ?? estimatePortfolioVol(assets, relativeWeightsAfterCap, input.covMatrix, input.avgCorrelation); // FIX-AUDIT-C2

  // ── Core realized vol (ex-BTC) ──────────────────────────────────────────────
  // BTC con vol ~72% anual contamina el VolTarget: si BTC es ~50% del portfolio,
  // la vol realizada es ~43% → VolTarget = 20%/43% = 0.47 → 53% a cash forzoso.
  // Para que EMXC/IS3Q/PPFB/URNU/VVSM/XNAS operen sin esta penalización,
  // calculamos la vol del CORE (6 activos sin BTC) y la usamos para VolTarget.
  // BTC sigue limitado por BTC CAP (CAPA 9), Tail Risk (full vol) y el régimen.
  const btcCoreIdx = assets.findIndex(a => {
    const n = a.name.toLowerCase();
    return n.includes('btc') || n.includes('bitcoin');
  });
  let coreRealizedVol = realizedVol;
  if (btcCoreIdx >= 0) {
    const nonBtcAssets = assets.filter((_, i) => i !== btcCoreIdx);
    const nonBtcWeights = relativeWeightsAfterCap.filter((_, i) => i !== btcCoreIdx);
    const nonBtcSum = nonBtcWeights.reduce((s, w) => s + w, 0);
    if (nonBtcSum > 0) {
      const normW = nonBtcWeights.map(w => w / nonBtcSum);
      const nonBtcCov = input.covMatrix
        ?.map(r => r.filter((_, j) => j !== btcCoreIdx))
        .filter((_, i) => i !== btcCoreIdx);
      coreRealizedVol = estimatePortfolioVol(nonBtcAssets, normW, nonBtcCov);
    }
  }

  // OLYMPUS CORE v1.0 (FIX-PHASE12): Vol Target y Kill Switch OFF por evidencia.
  //   - Kill Switch: coste robusto (bootstrap CI excluye 0) con MaxDD bit-idéntico.
  //   - Vol Target: coste -0.64pp con MaxDD idéntico (nunca binding en decisiones).
  // El stack completo (VT con régimen + KS L1-L5 + crisis sistémica + correlación)
  // queda intacto al ejecutar sin coreMode.
  const volTarget = coreMode
    ? { multiplier: 1.0, effectiveVol: coreRealizedVol, isScaledDown: false, isScaledUp: false }
    : computeVolTargetMultiplier({
        targetVol:     input.targetVol ?? VOLATILITY_CONFIG.DEFAULT_TARGET_VOL,
        realizedVol:   coreRealizedVol,  // ← usa vol del CORE (ex-BTC)
        regimePenalty: adjustedRegimePenalty,
      });

  // ====== CAPA 8: TAIL RISK ======
  const tailRisk = coreMode
    ? { overlay: 1.0, isActive: false, triggerReason: 'CORE v1.0: Kill Switch OFF (evidencia Phase 11: coste robusto sin reducción de MaxDD)', killSwitchLevel: 0 as const, killSwitchName: 'CORE_KILLSWITCH_OFF', exposureReduction: 0, drawdownOverlay: 1.0, volatilityReduction: 0, correlationPenalty: 0, maxBtcWeightActive: false }
    : computeTailRiskOverlay({
        drawdown:           input.portfolioDrawdown ?? 0,
        vix:                macro.vix,
        creditSpread:       macro.creditSpread,
        stressScore:        masterRegime.stressDetail.score,
        portfolioVolatility: realizedVol,  // ← vol FULL (incluye BTC) para la red de seguridad
        avgCorrelation:     input.avgCorrelation,
      });

  // FIX-V5-2: aplicación correcta de vol target y tail risk.
  // ANTES: final = blended × volMultiplier × tailOverlay → luego /totalFinal → ambos cancelados.
  //   El portafolio era 100% invertido siempre. Kill switch = decorativo.
  // AHORA: los pesos relativos (relativeWeights) ya están normalizados a 1.0.
  //   La exposición total (totalInvested) = volTarget × tailRisk, clamped a [0.05, 1.0].
  //   finalAllocation[i] = relativeWeight[i] × totalInvested
  //   La parte no invertida (1 - totalInvested) es cash implícito.
  const totalInvested_raw = Math.max(0.05, Math.min(1.0, volTarget.multiplier * tailRisk.overlay));

  // 🚀 ALPHA-BOOST: "The Perfect Storm"
  // Si Régimen=EXPANSION, BTC=STRONG_BUY y Liquidez M2 > 0 → Forzamos exposición máxima.
  //
  // FIX-ALPHA-01: añadida condición killSwitchLevel === 0 (CRÍTICO).
  //   El Kill Switch es el control de riesgo de mayor prioridad del sistema.
  //   Sin esta condición, Alpha-Boost podía forzar exposición al 95% con un
  //   drawdown activo de hasta -20% (L3, overlay 0.50), neutralizando completamente
  //   la protección de capital.
  //   Regla: si hay un Kill Switch activo (L1–L5), Alpha-Boost queda deshabilitado
  //   independientemente de las condiciones macro. El capital en drawdown no es
  //   capital de ataque — primero proteger, luego optimizar.
  const isAlphaMode = (
    masterRegime.regime === 'EXPANSION' &&
    btcCycle.signal === 'STRONG_BUY' &&
    (input.liquidityGrowth ?? 0) > 0 &&
    tailRisk.killSwitchLevel === 0   // FIX-ALPHA-01: Kill Switch activo → Alpha-Boost deshabilitado
  );
  const totalInvested_alpha = isAlphaMode ? Math.max(totalInvested_raw, ALPHA_BOOST_CONFIG.EXPOSURE) : totalInvested_raw;  // FIX-AUDIT-C9: antes 0.95 hardcodeado

  // 📉 CAPA 8b: CORRELATION PANIC TRIGGER — Convergencia de correlaciones
  // ================================================================
  // Cuando las correlaciones entre activos convergen a niveles de
  // pánico (>0.85), toda la diversificación del portafolio colapsa.
  // HRP, MinVar, y Black-Litterman asumen que las correlaciones son
  // estables y diferenciadas — en pánico, todos los activos caen juntos.
  //
  // Señal empírica: durante COVID 2020, la correlación media entre
  // activos globales saltó de ~0.35 a ~0.92. En 2008, de ~0.40 a ~0.88.
  // En ambos casos, la diversificación falló exactamente cuando más
  // se necesitaba.
  //
  // Lógica:
  //   - avgCorrelation > 0.85 → exposición máxima 50%
  //   - avgCorrelation > 0.95 → exposición máxima 35%
  //   - Se aplica DESPUÉS de ERP trigger y Alpha-Boost
  //   - Solo se activa si avgCorrelation fue proporcionado explícitamente
  const isCorrelationPanic = input.avgCorrelation !== undefined &&
    input.avgCorrelation > CORRELATION_PANIC_CONFIG.PANIC_THRESHOLD;
  const isCorrelationCritical = input.avgCorrelation !== undefined &&
    input.avgCorrelation > CORRELATION_PANIC_CONFIG.CRITICAL_THRESHOLD;
  const corrMaxExposure = isCorrelationCritical
    ? CORRELATION_PANIC_CONFIG.CRITICAL_EXPOSURE
    : CORRELATION_PANIC_CONFIG.MAX_EXPOSURE;

  // ================================================================
  // 🛡 CAPA 8.7: ABSOLUTE TREND GATES (Post-Mortem Oct 2026)
  // ================================================================
  // Aplica multiplicadores sobre totalInvested_alpha basados en señales
  // de mercado absolutas (no cross-sectional). Detecta "bear market
  // silencioso": mercado cae -2%/mes sin picos de VIX → el motor
  // sigue en EXPANSION sin saber que todo baja.
  // OLYMPUS CORE v1.0: overlay Trend Gate opcional (especificación E_both).
  const coreTrendGate = coreMode
    ? computeCoreTrendGate(assets, input.coreTrendGateState, input.coreTrendGate === true)
    : null;
  if (coreTrendGate && input.coreTrendGateState) {
    input.coreTrendGateState.lastGateCallIndex = coreTrendGate.newState.lastGateCallIndex;
    input.coreTrendGateState.reentryCount = coreTrendGate.newState.reentryCount;
    input.coreTrendGateState.engaged = coreTrendGate.newState.engaged;
  }
  const absTrendGate = coreMode && coreTrendGate
    ? { multiplier: coreTrendGate.multiplier, reason: coreTrendGate.reason, active: coreTrendGate.active }
    : computeAbsoluteTrendGates(
        assets,
        input.avgCorrelation,
        btcMVRV,
        masterRegime.regime,
        input.absoluteTrendGateOverride,
      );
  const institutionalBreadthShadowApplied = !coreMode && input.institutionalBreadthShadow?.applyToAllocations === true && institutionalBreadthShadow !== null;
  const breadthEffectiveMultiplier = institutionalBreadthShadowApplied
    ? Math.min(absTrendGate.multiplier, institutionalBreadthShadow.multiplier)
    : absTrendGate.multiplier;
  const breadthEffectiveSource = institutionalBreadthShadowApplied
    ? absTrendGate.active ? 'legacy_and_institutional_shadow' as const : 'institutional_shadow' as const
    : 'legacy' as const;
  const totalInvested_afterGate = totalInvested_alpha * breadthEffectiveMultiplier;

  // ================================================================
  // 📉 CAPA 8c: ERP TRIGGER — Equity-Only Cap (FIX-ERP-EQUITY)
  // ============================================================
  // Cuando el ERP cae por debajo del umbral, forzamos una reducción
  // de exposición SOLO en la porción EQUITY del portafolio.
  //
  // FIX-ERP-EQUITY (01-Jun-2026):
  //   ANTES: el ERP capsulaba TODO el portafolio al 35%, penalizando
  //     activos no-equity (BTC, Gold, Uranio) que no están correlacionados
  //     con el equity risk premium del S&P 500.
  //     Con ERP = −1.4% → totalInvested = 35% → CAGR ~13% vs Equal Weight 19%
  //   AHORA: solo activos con earningsYield > 0 se capsulan.
  //     Non-equity opera sin cap de ERP.
  //     Ej: equityWeight=52%, erpMax=35% → capFactor=0.35/0.52=0.673
  //     Non-equity 48% al 100%, equity 52% al 67.3% → total ~83%
  //
  // Lógica:
  //   - ERP < 2.5%  → equity capped al 60% del portfolio total
  //   - ERP < 1.0%  → equity capped al 35% (peligro extremo)
  //   - Non-equity (earningsYield === 0): sin cap por ERP
  //   - Solo se activa si erpValue fue explícitamente proporcionado
  // FIX-ERP-HIGHRATES (09-Jul-2026): en EXPANSION usar umbrales mas permisivos.
  // ERP negativo con bonos al 4.5%+ no indica peligro inminente — es estructural.
  const erpCfg = masterRegime.regime === 'EXPANSION' ? ERP_CONFIG.EXPANSION : ERP_CONFIG;
  const isERPTriggered = input.erpValue !== undefined && erpRaw < erpCfg.TRIGGER_THRESHOLD;
  const isERPCritical = input.erpValue !== undefined && erpRaw < erpCfg.CRITICAL_THRESHOLD;
  const erpMaxExposure = isERPCritical ? erpCfg.CRITICAL_EXPOSURE : erpCfg.MAX_EXPOSURE;

  // Fracción equity vs non-equity de los pesos relativos
  const equityWeight = relativeWeightsAfterCap.reduce((s, w, i) =>
    s + (assets[i].earningsYield > 0 ? w : 0), 0);

  // ERP cap factor: escala DOWN los activos equity para que equity total ≤ erpMaxExposure.
  // Ej: equityWeight=52%, base=1.0, erpMax=35% → capFactor = 0.35/0.52 = 0.673
  // FIX-POSTMORTEM: ERP denominator uses totalInvested_afterGate (not _alpha) to prevent
  // double-reduction when both Absolute Trend Gate and ERP Trigger are active simultaneously.
  // When the gate already reduced exposure to 50%, ERP should not further reduce from
  // that already-lowered base — the gate already accounts for the bearish environment.
  const erpCapFactor = (isERPTriggered && equityWeight > 0 && totalInvested_afterGate > 0)
    ? Math.min(1.0, erpMaxExposure / (equityWeight * totalInvested_afterGate))
    : 1.0;

  // Correlation panic aplica a TODOS los activos (en pánico todo correlaciona)
  const totalInvested_base = isCorrelationPanic
    ? Math.min(totalInvested_afterGate, corrMaxExposure)
    : totalInvested_afterGate;

  // totalInvested real: equity usa erpCapFactor, non-equity sin cap
  const actualTotalInvested = relativeWeightsAfterCap.reduce((sum, w, i) =>
    sum + w * totalInvested_base * (assets[i].earningsYield > 0 ? erpCapFactor : 1.0), 0);

  // ====== CAPA 9: DCA CONTRACÍCLICO ======
  // FIX-V5-5: warning cuando totalPortfolioValue no fue proporcionado.
  // FIX-R2-F (auditoría institucional ronda 2): DCA guard en Kill Switch L4-L5.
  //   ANTES: computeDCADecision se llamaba incondicionalmente. En L4 (DD -25%)
  //     o L5 (DD -32%) el boost podía acelerar compras cuando el motor está
  //     en "SALIDA CASI TOTAL" / "PROTECCIÓN MÁXIMA" → contradicción con el
  //     kill switch. El DCA contracíclico NO debe acelerar entradas cuando el
  //     sistema está en modo preservación de capital extrema.
  //   AHORA: si killSwitchLevel >= 4, el DCA se desactiva (investAmount=0,
  //     effectiveIntensity=0, reason explícito). L1-L3 siguen operando
  //     porque son reducciones preventivas donde comprar la caída tiene sentido.
  //   Prioridad documentada (mayor → menor):
  //     1. Kill Switch L5 (protección de capital, override todo)
  //     2. Kill Switch L4 (salida casi total)
  //     3. tailRisk overlay (VIX+creditSpread sistémico)
  //     4. Correlation Panic (>0.85)
  //     5. ERP Trigger (equity-only cap)
  //     6. Alpha-Boost (solo si 1-5 inactivos)
  //     7. VolTarget
  //     8. DCA contracíclico (desactivado si L4+)
  const dcaDataMissing = (input.totalPortfolioValue === undefined || input.totalPortfolioValue === null);
  // FIX-H27 (Jul-2026): dcaEngine es capa de compatibilidad.
  //   El dashboard usa computeSmartDCA() como fuente unica de verdad
  //   para las decisiones de compra diarias. Este bloque solo alimenta
  //   output.dca para retrocompatibilidad con el motor.
  const dcaBlockedByKillSwitch = tailRisk.killSwitchLevel >= 4;
  const dcaDecision = dcaBlockedByKillSwitch
    ? {
        investAmount:         0,
        investPercent:        0,
        baseIntensity:        0,
        boostMultiplier:      0,
        effectiveIntensity:   0,
        frequency:            'monthly' as const,
        frequencyDays:        30,
        riskConstraintActive: true,
        riskConstraintReason: `🛑 DCA desactivado por Kill Switch L${tailRisk.killSwitchLevel} (${tailRisk.killSwitchName}). Preservación de capital máxima — no acelerar entradas.`,
        cashConstrained:      false,
        description:          `DCA bloqueado en Kill Switch L${tailRisk.killSwitchLevel}.`,
      }
    : computeDCADecision({
        regime:               (masterRegime.regime as PortfolioRegime) === 'ALL_CASH' ? 'CRISIS' : masterRegime.regime as PortfolioRegime,
        btcCycle,
        totalPortfolioValue:  input.totalPortfolioValue ?? 0,
        availableCash:        input.availableCash ?? 0,
        portfolioVolatility:  coreRealizedVol ?? input.portfolioRealizedVol ?? 0.18,
        portfolioDrawdown:    input.portfolioDrawdown ?? 0,
      });
  const dca = {
    investPercent:      dcaDecision.effectiveIntensity,
    investAmount:       dcaDecision.investAmount,
    frequency:          dcaDecision.frequency,
    boostMultiplier:    dcaDecision.boostMultiplier,
    effectiveIntensity: dcaDecision.effectiveIntensity,
  };

  // ====== OUTPUT FINAL ======
  // FEAT-PROVENANCE (Jul-2026): computar multiplicadores por capa para trazabilidad.
  // Cada activo recibe un objeto provenance que el dashboard puede desplegar.
  const regimeTiltMult = relativeWeights.map((w, i) => {
    const denom = w > 0.00001 ? w : 0.00001;
    return tiltedRelativeWeights[i] / denom;
  });
  const btcIdxProv = assets.findIndex(a => {
    const n = (a.ticker ?? a.name).toLowerCase();
    return n.includes('btc') || n.includes('bitcoin');
  });
  // CycleTop multipliers per asset (capturados ANTES de aplicar al array)
  const cycleTopMult = assets.map((_, i) => {
    const ticker = assets[i].ticker ?? assets[i].name;
    const baseTicker = ticker.split(".")[0];
    const sig = activeCycleSignals.find(s => s.ticker === ticker || s.ticker.split(".")[0] === baseTicker);
    return sig?.allocationMultiplier ?? 1.0;
  });

  const allocations: OlympusOutput[] = kellyNorm.map(
    ({ asset, momentum, value, quality, lowVol, rawExpectedReturn, normalizedExpectedReturn, kelly, kellyNormalized }, i) => {
      const relW   = relativeWeightsAfterCap[i];
      const volAdj = relW * volTarget.multiplier;        // para display (antes de tail)
      // FIX-ERP-EQUITY: ERP cap solo para equity, non-equity sin cap
      const isEquityAsset = assets[i].earningsYield > 0;
      const final  = relW * totalInvested_base * (isEquityAsset ? erpCapFactor : 1.0);

      // FEAT-PROVENANCE: trazabilidad por capa
      const btcCapped = (i === btcIdxProv) && tiltedRelativeWeights[i] > dynamicBtcCap;
      const btcCapMult = btcCapped
        ? dynamicBtcCap / Math.max(0.00001, tiltedRelativeWeights[i])
        : 1.0;
      const provenance: AllocationProvenance = {
        regimeTiltMultiplier: parseFloat(regimeTiltMult[i].toFixed(3)),
        btcCapMultiplier:     parseFloat(btcCapMult.toFixed(3)),
        cycleTopMultiplier:   parseFloat(cycleTopMult[i].toFixed(3)),
        finalPreExposure:     parseFloat(relW.toFixed(6)),
      };

      return {
        name:                     asset.name,
        momentumScore:            momentum.momentumScore,
        valueScore:               value.valueScore,
        valuePercentileRank:      value.percentileRank,
        qualityScore:             quality.qualityScore,
        lowVolScore:              lowVol.lowVolScore,
        expectedReturn:           rawExpectedReturn,
        normalizedExpectedReturn,
        kellyFraction:            kelly.kellyFraction,
        rawKelly:                 kelly.rawKelly,
        isCapped:                 kelly.isCapped,
        isFloored:                kelly.isFloored,
        effectiveCap:             kelly.effectiveCap,
        kellyAllocation:          kellyNormalized,
        markowitzAllocation:      equalWeightRef[i],
        riskParityAllocation:     rpWeights[i],
        blendedAllocation:        relW,
        volAdjustedAllocation:    volAdj,
        finalAllocation:          final,
        provenance,
      };
    }
  );

  // ── Modo sombra dual (SOLO observabilidad: sin estado, sin efectos, sin riesgo) ──
  // Periodo actual (default = v5.3): la sombra ejecuta CORE (HRP+LW, overlay OFF)
  //   para comparar en el dashboard qué haría el Core con los mismos inputs.
  // Tras el cutover (CORE = default): la sombra pasará a ejecutar v5.3 legacy.
  //   (stub PENDING_CUTOVER hasta entonces — imposible confundirlo con cartera real).
  // Guard de recursión: input.coreShadowMode === true → no se crea sombra.
  // La ejecución sombra nunca muta estado (coreTrendGateState: undefined) y un
  // fallo suyo JAMÁS propaga al resultado principal (try/catch → null).
  const coreShadow: CoreShadowResult | null = input.coreShadowMode === true
    ? null
    : coreMode
      ? {
          engineVersion: ENGINE_VERSION + "+shadow-stub-v5.3",
          regime: "PENDING_CUTOVER",
          allocations: [],
          totalInvested: 0,
        }
      : (() => {
          try {
            const shadow = runOlympusEngine({
              ...input,
              // FIDELIDAD SPEC v1.0: la sombra CORE consume la covarianza
              // Ledoit-Wolf canónica (coreCovMatrix), no la covarianza activa
              // del principal (que puede ser DCC).
              covMatrix: input.coreCovMatrix ?? input.covMatrix,
              coreMode: true,
              coreTrendGate: false,
              coreTrendGateState: undefined,
              coreShadowMode: true,
            });
            return {
              engineVersion: shadow.engineVersion,
              regime: shadow.regime as string,
              allocations: shadow.allocations.map(a => ({ name: a.name, finalAllocation: a.finalAllocation })),
              totalInvested: shadow.totalInvested,
            };
          } catch {
            // Observabilidad: si la sombra falla, el principal sigue intacto.
            return null;
          }
        })();

  const result: EngineOutput = {
    allocations,
    regime:              masterRegime.regime,
    masterRegime,
    correlationPenalty:  corrPenalty,
    totalAllocation:     allocations.reduce((s, a) => s + a.finalAllocation, 0),
    totalInvested:       actualTotalInvested, // FIX-ERP-EQUITY: refleja cap solo equity
    volTargetMultiplier: volTarget.multiplier,
    tailRiskOverlay:     tailRisk.overlay,
    tailRiskActive:      tailRisk.isActive,
    tailRiskReason:      tailRisk.triggerReason,
    engineVersion:       ENGINE_VERSION,
    meta: {
      allCash:         false,
      confidence:      masterRegime.confidence,
      dominantSignal:  masterRegime.dominantSignal,
      hasRealCovMatrix,
      dcaDataMissing,  // FIX-V5-5
      erpTriggered:    isERPTriggered,
      erpValue:        erpRaw,
      correlationPanicTriggered: isCorrelationPanic,
      avgCorrelationValue: input.avgCorrelation ?? 0,
      // FIX-POSTMORTEM: absolute trend gates metadata
      absoluteTrendGateActive: absTrendGate.active,
      absoluteTrendGateMultiplier: absTrendGate.multiplier,
      absoluteTrendGateReason: absTrendGate.reason,
      absoluteTrendGateNegativeCount: assets.filter(a => a.returns3m < 0).length,
      absoluteTrendGateNegativePct: assets.length > 0 ? assets.filter(a => a.returns3m < 0).length / assets.length : 0,
      totalInvestedAlpha: totalInvested_alpha,
      totalInvestedAfterGate: totalInvested_afterGate,
      totalInvestedBase: totalInvested_base,
      erpCapFactor,
      breadthPolicy: BREADTH_RISK_POLICY.productionMode,
      riskOverlayPriority: BREADTH_RISK_POLICY.institutionalPriority,
      regimeBreadthDivergence: masterRegime.regime === 'EXPANSION' && (
        absTrendGate.active || institutionalBreadthShadow?.active === true
      ),
      institutionalBreadthShadow,
      institutionalBreadthShadowApplied,
      breadthEffectiveMultiplier,
      breadthEffectiveSource,
      // OLYMPUS CORE v1.0: trazabilidad del perfil y del overlay Trend Gate
      coreMode,
      coreTrendGateActive: coreTrendGate?.active ?? false,
      coreTrendGateMultiplier: coreTrendGate?.multiplier ?? 1.0,
      coreTrendGateReason: coreTrendGate?.reason ?? 'CORE v1.0: Trend Gate overlay OFF',
      // FIX-AUDIT-R10: transparencia del overlay discrecional
      // effectiveBlendRatio = blendQuantWeight (fracción del output que viene del motor cuantitativo)
      allocationProvenance: (() => {
        const tacticalConfig = DISCRETIONARY_OVERLAY[masterRegime.regime] ?? DISCRETIONARY_OVERLAY['EXPANSION'];
        const quantW = tacticalConfig.blendToTacticalRatio;
        return {
          quantWeight:       quantW,
          discretionaryWeight: 1 - quantW,
          source:            quantW >= 0.70 ? 'quant' as const : quantW <= 0.30 ? 'overlay' as const : 'mixed' as const,
          overlayActive:     quantW < 0.70,
          reason:            `${masterRegime.regime}: ${(quantW * 100).toFixed(0)}% cuant / ${((1 - quantW) * 100).toFixed(0)}% discrecional`,
        };
      })(),
    },
    btcCycle: {
      btcScore:   btcCycle.btcScore,
      btcNumeric: btcCycle.btcNumeric,
      signal:     btcCycle.signal,
      boostActive: btcCycle.boostActive,
      breakdown:  btcCycle.breakdown,
    },
    dca,
    coreSignal: {
      regimeComponent: CORE_SIGNAL_WEIGHTS.REGIME * regimeNumeric,
      btcComponent:    CORE_SIGNAL_WEIGHTS.BTC * btcNumeric,
      riskComponent:   CORE_SIGNAL_WEIGHTS.RISK * Math.max(0, riskNumeric),
      finalScore:      coreSignalScore,
    },
    scenarioProbabilities,
    metaIntelligence: {
      modelHealth:            metaIntelligence.modelHealth,
      confidenceMultiplier:   metaIntelligence.confidenceMultiplier,
      consecutiveErrors:      metaIntelligence.consecutiveErrors,
      recommendation:         metaIntelligence.recommendation,
    },
    killSwitchLevel: tailRisk.killSwitchLevel,
    killSwitchName:  tailRisk.killSwitchName,
  };

  // FIX-AUDIT-R5 R4.4: NaN/Inf output guard at final return.
  // Covers the mu-NaN / post-rebalance path that bypasses minimumVarianceWeights mid-pipeline guards.
  // Strategy: if any allocation is non-finite, redistribute ITS weight pro-rata across valid neighbors
  //   (preserva sum=1 invariant y shape completo OlympusOutput{} por allocation).
  // If ALL corrupt or array empty: equal-weight fallback.
  // FIX-R4.4b: también recalcula totalInvested y totalAllocation post-guard.
  const _allocs = result.allocations ?? [];
  if (_allocs.length > 0 && _allocs.some(a => !Number.isFinite(a.finalAllocation))) {
    const _validCount = _allocs.filter(a => Number.isFinite(a.finalAllocation)).length;
    const _sumCorrupt = _allocs.reduce((s, a) => s + (Number.isFinite(a.finalAllocation) ? 0 : Math.max(0, a.finalAllocation || 0)), 0);
    if (_validCount === 0) {
      // All corrupt: equal-weight fallback (1/n for each)
      const _eqFallback = 1 / _allocs.length;
      console.warn(`[OlympusV3 R4.4] ALL ${_allocs.length} allocations corrupt; equal-weight fallback`);
      result.allocations = _allocs.map(a => ({ ...a, finalAllocation: _eqFallback }));
    } else {
      // Redistribute corrupt weight pro-rata across valid neighbors; preserves sum=1
      //   invariant: equalMass = sumCorrupt / validCount; each valid gets +equalMass.
      const _equalMass = _sumCorrupt / _validCount;
      console.warn(`[OlympusV3 R4.4] ${_allocs.length - _validCount}/${_allocs.length} allocations corrupt; redistributing pro-rata`);
      result.allocations = _allocs.map(a => {
        if (!Number.isFinite(a.finalAllocation)) return { ...a, finalAllocation: 0 };
        return { ...a, finalAllocation: a.finalAllocation + _equalMass };
      });
    }
    // Recalcular totalInvested y totalAllocation tras el fix de allocations
    result.totalAllocation = result.allocations.reduce((s, a) => s + a.finalAllocation, 0);
    result.totalInvested = result.totalAllocation;
  }
  if (coreShadow) result.meta.coreShadow = coreShadow;
  return result;
}

// ── HELPERS INTERNOS ──────────────────────────────────────────────────────────

function computeMarginalRiskContribution(
  weights: number[],
  covMatrix: number[][] | undefined,
  index: number,
  fallbackVolatility: number,
): number {
  const fallback = Math.max(0, (weights[index] ?? 0) * fallbackVolatility);
  if (!covMatrix || covMatrix.length !== weights.length || covMatrix.some(row => row.length !== weights.length)) {
    return fallback;
  }

  const marginal = covMatrix[index]?.reduce(
    (sum, covariance, j) => sum + covariance * (weights[j] ?? 0),
    0,
  ) ?? 0;
  const portfolioVariance = weights.reduce(
    (variance, weight, i) => variance + weight * (covMatrix[i]?.reduce(
      (sum, covariance, j) => sum + covariance * (weights[j] ?? 0),
      0,
    ) ?? 0),
    0,
  );
  const portfolioVolatility = Math.sqrt(Math.max(0, portfolioVariance));
  const contribution = portfolioVolatility > 0
    ? (weights[index] ?? 0) * marginal / portfolioVolatility
    : fallback;
  return Number.isFinite(contribution) && contribution > 0 ? contribution : fallback;
}

/**
 * Aplica tilting de pesos por régimen macro.
 * Multiplica cada peso por el multiplicador correspondiente a su sector/régimen
 * y renormaliza para que la suma siga siendo 1.0 (preservando totalInvested).
 *
 * EXPANSION: +40% crypto, +30% semis, -20% gold → tilt hacia growth
 * CONTRACTION: +40% gold, -40% crypto → tilt hacia defensivos
 * CRISIS: +60% gold, -70% crypto → concentración en safe havens
 */
function applyRegimeTilt(
  weights: number[],
  assets: AssetInput[],
  regime: string,
): number[] {
  const tilts = (REGIME_TILT as Record<string, Record<string, number>>)[regime]
    ?? (REGIME_TILT as Record<string, Record<string, number>>)['EXPANSION'];

  const tilted = weights.map((w, i) => {
    const sector = assets[i].sector ?? 'equity';
    const multiplier = tilts[sector] ?? 1.0;
    return w * multiplier;
  });

  const total = tilted.reduce((s, w) => s + w, 0);
  if (total <= 0 || !isFinite(total)) return weights; // safety fallback
  return tilted.map(w => w / total);
}

function minimumVarianceWeights(covMatrix: number[][], n: number): number[] {
  // Guardia: NaN / Inf
  if (covMatrix.some(row => row.some(v => !isFinite(v)))) {
    console.warn('[Olympus] minimumVarianceWeights: covMatrix contiene NaN/Inf → fallback equal weight');
    return Array(n).fill(1 / n);
  }
  if (covMatrix.length !== n || covMatrix.some(row => row.length !== n)) {
    console.warn('[Olympus] minimumVarianceWeights: dimensión n no coincide con covMatrix → fallback');
    return Array(n).fill(1 / n);
  }

  // Gradient descent proyectado (500 iteraciones, convergencia suficiente para n≤10)
  const iters = 500;
  let weights = Array(n).fill(1 / n);
  for (let iter = 0; iter < iters; iter++) {
    const grad = Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        grad[i] += 2 * weights[j] * covMatrix[i][j];
      }
    }
    if (grad.some(g => !isFinite(g))) {
      console.warn('[Olympus] minimumVarianceWeights: gradiente NaN en iteración', iter, '→ fallback');
      return Array(n).fill(1 / n);
    }
    const lr = 0.05 / (1 + iter * 0.01);
    const updated = weights.map((w, i) => Math.max(0.01, w - lr * grad[i]));
    const sum     = updated.reduce((a, b) => a + b, 0);
    if (sum <= 0 || !isFinite(sum)) return Array(n).fill(1 / n);
    weights = updated.map(w => w / sum);
  }
  return weights;
}

// FIX-AUDIT-C2: el fallback sin covMatrix asumía correlación=0 (cota inferior).
// Con avgCorrelation (opcional), se usa como correlación off-diagonal implícita:
//   portfolioVar = sum(w_i² * σ_i²) + avgCorr * sum_{i≠j}(w_i * w_j * σ_i * σ_j)
// Esto da una estimación más realista que el peor/mejor caso.
export function estimatePortfolioVol(assets: AssetInput[], weights: number[], covMatrix?: number[][], avgCorrelation?: number): number {
  if (covMatrix && covMatrix.length === assets.length) {
    let portfolioVar = 0;
    for (let i = 0; i < assets.length; i++) {
      for (let j = 0; j < assets.length; j++) {
        portfolioVar += weights[i] * weights[j] * covMatrix[i][j];
      }
    }
    return Math.sqrt(Math.max(0, portfolioVar));
  }
  // Fallback sin covMatrix: usar avgCorrelation si está disponible
  const n = assets.length;
  let diagonalVar = 0;
  for (let i = 0; i < n; i++) {
    diagonalVar += weights[i] * weights[i] * assets[i].volatility * assets[i].volatility;
  }
  // FIX-AUDIT-C2: añadir off-diagonal con correlación media si está disponible
  if (avgCorrelation !== undefined && avgCorrelation > 0 && n > 1) {
    let offDiagVar = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          offDiagVar += weights[i] * weights[j] * assets[i].volatility * assets[j].volatility;
        }
      }
    }
    return Math.sqrt(Math.max(0, diagonalVar + avgCorrelation * offDiagVar));
  }
  return Math.sqrt(Math.max(0, diagonalVar));
}
