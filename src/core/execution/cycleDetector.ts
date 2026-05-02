// ===============================================
// ARCHIVO: src/core/execution/cycleDetector.ts
// OLYMPUS X — Detector de Ciclos Multi-Activo
// ===============================================
// Detecta el estado del ciclo (alcista/bajista) de CADA activo del portfolio.
// No solo BTC — también equities, gold, uranium, commodities.
//
// METODOLOGÍA POR CAPA:
//
//   CAPA 1 — ESTRUCTURA DE PRECIO (técnica pura):
//     - Higher Highs + Higher Lows → Tendencia alcista confirmada
//     - Lower Highs + Lower Lows   → Tendencia bajista confirmada
//     - Posición vs MA50/MA200     → Tendencia de largo plazo
//
//   CAPA 2 — MOMENTUM (cuantitativo):
//     - Rate of Change (ROC) a 20, 60, 120 días
//     - RSI semanal (datos diarios comprimidos × 5)
//     - Distancia al ATH (all-time high en ventana disponible)
//
//   CAPA 3 — VOLATILIDAD DE CICLO:
//     - ATR ratio (volatilidad actual / media histórica)
//     - Índice de capitulación (VIX proxy local del activo)
//
//   CAPA 4 — DETECCIÓN DE PUNTOS DE GIRO:
//     - Algoritmo Zigzag con threshold adaptativo por activo
//     - Identifica correcciones vs reversiones estructurales
//     - Drawdown desde máximo local → señal de entrada
//
// OUTPUT POR ACTIVO:
//   cycle: BULL_EARLY | BULL_EXPANSION | BULL_LATE | DISTRIBUTION |
//           BEAR_EARLY | BEAR_DEEP | ACCUMULATION | RECOVERY
//   strength: [0, 1] — fuerza de la señal
//   drawdownFromPeak: % caída desde máximo local
//   attackOpportunity: boolean — ¿es buen momento para atacar?
//   attackConfidence: HIGH | MEDIUM | LOW
//   suggestedAction: BUY_AGGRESSIVE | BUY | HOLD | REDUCE | SELL
//
// DIFERENCIA VS TACTICALSCREENER (que ya existe):
//   TacticalScreener busca entries de corto plazo (semanas).
//   CycleDetector identifica el RÉGIMEN del activo (meses/trimestres).
//   Usa ambos juntos: cycle confirma dirección, screener afina el timing.
//
// REFERENCIAS:
//   - Weinstein (1988): "Secrets for Profiting in Bull and Bear Markets"
//     Etapa 1 (base) → 2 (avance) → 3 (techo) → 4 (declive)
//   - Hurst (1970): "The Profit Magic of Stock Transaction Timing"
//     Ciclos dominantes + ciclos subordinados
// ===============================================

export type CyclePhase =
  | 'BULL_EARLY'      // Weinstein Stage 2 inicio — volumen sube, precio rompe resistencia
  | 'BULL_EXPANSION'  // Tendencia alcista confirmada, momentum fuerte
  | 'BULL_LATE'       // Weinstein Stage 3 — techo posible, momentum débil
  | 'DISTRIBUTION'    // Rango lateral tras rally, manos fuertes vendiendo
  | 'BEAR_EARLY'      // Weinstein Stage 4 inicio — rotura de soporte
  | 'BEAR_DEEP'       // Bear confirmado, momentum negativo
  | 'ACCUMULATION'    // Weinstein Stage 1 — suelo lateral, acumulación institucional
  | 'RECOVERY';       // V-recovery o inicio de reversión desde oversold extremo

export type CycleAction =
  | 'BUY_AGGRESSIVE'  // Alta convicción, atacar con tamaño
  | 'BUY'             // Comprar con sizing normal
  | 'ACCUMULATE'      // Comprar en pequeñas raciones (DCA)
  | 'HOLD'            // Mantener posición actual
  | 'REDUCE'          // Reducir posición parcialmente
  | 'SELL'            // Salir de la posición
  | 'AVOID';          // No tomar posición, activo en fase desfavorable

export interface AssetPriceData {
  ticker: string;
  closes: number[];     // precios de cierre, orden cronológico (más antiguo primero)
  volumes?: number[];
  highs?: number[];
  lows?: number[];
  assetClass?: 'EQUITY' | 'CRYPTO' | 'COMMODITY' | 'BOND' | 'REIT';
}

export interface AssetCycleOutput {
  ticker: string;
  assetClass: string;

  // Estado del ciclo
  phase: CyclePhase;
  phaseDescription: string;

  // Métricas clave
  drawdownFromPeak: number;       // caída desde máximo local (positivo = pérdida)
  gainFromTrough: number;         // ganancia desde mínimo local
  momentum20d: number;            // ROC 20 días
  momentum60d: number;            // ROC 60 días
  momentum120d: number;           // ROC 120 días
  rsiWeekly: number;              // RSI semanal aproximado

  // Posición en medias
  aboveMA50: boolean;
  aboveMA200: boolean;
  ma50vsMA200: 'GOLDEN_CROSS' | 'DEATH_CROSS' | 'NEUTRAL';
  distanceToMA200pct: number;     // % sobre o bajo la MA200

  // Volatilidad
  atrRatio: number;               // ATR actual / ATR promedio histórico (1.0 = normal)
  isCapitulation: boolean;        // Spike de vol + caída extrema = capitulación

  // Decisión de ataque
  attackOpportunity: boolean;
  attackConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
  suggestedAction: CycleAction;
  actionReason: string;

  // Score numérico [0, 100]
  cycleScore: number;             // 0 = bear extremo, 50 = neutral, 100 = bull extremo
  bullishScore: number;           // Componente alcista [0, 100]
  bearishScore: number;           // Componente bajista [0, 100]

  // Señal de giro próximo
  reversalProbability: number;    // [0, 1] probabilidad de giro en 30 días
  reversalDirection: 'BULLISH_REVERSAL' | 'BEARISH_REVERSAL' | 'NONE';
}

export interface PortfolioCycleOutput {
  assetCycles: AssetCycleOutput[];
  portfolioCycleScore: number;    // media ponderada de cycleScore
  attackOpportunities: {
    ticker: string;
    confidence: string;
    action: CycleAction;
    drawdown: number;
    reason: string;
  }[];
  riskAssets: {                   // activos en fase peligrosa
    ticker: string;
    phase: CyclePhase;
    reason: string;
  }[];
  marketStructure: 'RISK_ON' | 'RISK_OFF' | 'MIXED' | 'TRANSITION';
}

// ── UTILIDADES TÉCNICAS ───────────────────────────────────────────────────────

function sma(arr: number[], n: number): number {
  if (arr.length < n) return arr[arr.length - 1] ?? 0;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < period + 1) return 0;
  const trValues: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trValues.push(tr);
  }
  const recent = trValues.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function roc(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  if (past === 0) return 0;
  return (current - past) / past;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const diffs = closes.slice(1).map((c, i) => c - closes[i]);
  const recent = diffs.slice(-period * 2);
  let avgG = 0, avgL = 0;
  const init = recent.slice(0, period);
  init.forEach(d => { if (d > 0) avgG += d; else avgL += Math.abs(d); });
  avgG /= period; avgL /= period;
  for (let i = period; i < recent.length; i++) {
    const g = recent[i] > 0 ? recent[i] : 0;
    const l = recent[i] < 0 ? Math.abs(recent[i]) : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function maxDrawdownFromPeak(closes: number[]): number {
  // Buscar el máximo en la ventana y calcular la caída desde él
  const windowSize = Math.min(closes.length, 252); // últimos 252 días
  const window = closes.slice(-windowSize);
  let peak = window[0];
  let maxDD = 0;
  for (const price of window) {
    if (price > peak) peak = price;
    const dd = (peak - price) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function gainFromTrough(closes: number[]): number {
  const windowSize = Math.min(closes.length, 252);
  const window = closes.slice(-windowSize);
  const trough = Math.min(...window);
  const current = closes[closes.length - 1];
  if (trough === 0) return 0;
  return (current - trough) / trough;
}

/**
 * Detecta si hay un golden cross o death cross reciente (últimas 20 sesiones)
 */
function detectMACrossover(
  closes: number[]
): 'GOLDEN_CROSS' | 'DEATH_CROSS' | 'NEUTRAL' {
  if (closes.length < 220) return 'NEUTRAL';
  const lookback = 20;
  const recent = closes.slice(-lookback);
  const older = closes.slice(-lookback - 20, -lookback);

  const currentMA50 = sma(closes, 50);
  const currentMA200 = sma(closes, 200);
  const prevMA50 = sma(closes.slice(0, -lookback + 10), 50);
  const prevMA200 = sma(closes.slice(0, -lookback + 10), 200);

  const nowAbove = currentMA50 > currentMA200;
  const prevAbove = prevMA50 > prevMA200;

  if (nowAbove && !prevAbove) return 'GOLDEN_CROSS';
  if (!nowAbove && prevAbove) return 'DEATH_CROSS';
  return 'NEUTRAL';
}

// ── MOTOR DE CICLO POR ACTIVO ─────────────────────────────────────────────────

export function analyzeAssetCycle(assetData: AssetPriceData): AssetCycleOutput {
  const { ticker, closes, volumes, highs, lows, assetClass = 'EQUITY' } = assetData;

  if (closes.length < 50) {
    return buildInsufficientDataOutput(ticker, assetClass);
  }

  const price = closes[closes.length - 1];
  const ma50 = sma(closes, 50);
  const ma200 = closes.length >= 200 ? sma(closes, 200) : sma(closes, closes.length);

  const aboveMA50 = price > ma50;
  const aboveMA200 = price > ma200;
  const distanceToMA200pct = ma200 > 0 ? (price - ma200) / ma200 : 0;

  const momentum20d = roc(closes, 20);
  const momentum60d = roc(closes, 60);
  const momentum120d = closes.length >= 120 ? roc(closes, 120) : roc(closes, closes.length - 1);

  // RSI semanal: comprimir cierres diarios a semanales
  const weeklyCloses = closes.filter((_, i) => i % 5 === 0);
  const rsiWeekly = calcRSI(weeklyCloses, 14);

  const drawdownFromPeak = maxDrawdownFromPeak(closes);
  const gainFromTrough_ = gainFromTrough(closes);

  // ATR ratio (volatilidad actual vs histórica)
  const h = highs ?? closes.map(c => c * 1.01);
  const l = lows ?? closes.map(c => c * 0.99);
  const currentATR = atr(h, l, closes, 14);
  const historicATR = atr(
    h.slice(0, Math.max(1, h.length - 14)),
    l.slice(0, Math.max(1, l.length - 14)),
    closes.slice(0, Math.max(1, closes.length - 14)),
    Math.min(30, Math.floor(closes.length / 2))
  );
  const atrRatio = historicATR > 0 ? currentATR / historicATR : 1;

  // Capitulación: caída > 15% + ATR ratio > 2
  const isCapitulation = drawdownFromPeak > 0.15 && atrRatio > 2.0;

  const maCross = detectMACrossover(closes);

  // ── SCORING ───────────────────────────────────────────────────────────────
  // Puntuación alcista [0, 100]
  let bullScore = 50; // neutral

  // Posición vs medias (0-25 pts)
  if (aboveMA200) bullScore += 12;
  if (aboveMA50) bullScore += 8;
  if (maCross === 'GOLDEN_CROSS') bullScore += 5;
  if (maCross === 'DEATH_CROSS') bullScore -= 15;

  // Momentum (0-35 pts)
  bullScore += Math.min(15, Math.max(-15, momentum20d * 100));  // ROC 20d
  bullScore += Math.min(10, Math.max(-10, momentum60d * 50));   // ROC 60d
  bullScore += Math.min(10, Math.max(-10, momentum120d * 25));  // ROC 120d

  // RSI semanal (0-15 pts)
  if (rsiWeekly < 30) bullScore += 15;  // oversold extremo
  else if (rsiWeekly < 45) bullScore += 8;
  else if (rsiWeekly > 75) bullScore -= 12;
  else if (rsiWeekly > 60) bullScore -= 5;

  // Drawdown desde pico (-10 pts si > 10%, +10 si < 5%)
  if (drawdownFromPeak > 0.20) bullScore -= 10;
  else if (drawdownFromPeak < 0.05) bullScore += 5;

  // Capitulación es paradójicamente alcista (oportunidad)
  if (isCapitulation) bullScore += 8; // zona de suelo históricamente

  bullScore = Math.max(0, Math.min(100, bullScore));
  const bearScore = 100 - bullScore;
  const cycleScore = bullScore;

  // ── FASE DEL CICLO ────────────────────────────────────────────────────────
  const phase = determineCyclePhase(
    bullScore, aboveMA50, aboveMA200, maCross,
    momentum20d, momentum60d, drawdownFromPeak, rsiWeekly, isCapitulation
  );

  // ── ACCIÓN SUGERIDA ───────────────────────────────────────────────────────
  const { action, attackOpportunity, attackConfidence, actionReason } =
    determineAction(phase, bullScore, drawdownFromPeak, isCapitulation, assetClass);

  // ── PROBABILIDAD DE GIRO ──────────────────────────────────────────────────
  const { reversalProb, reversalDir } = estimateReversal(
    phase, rsiWeekly, atrRatio, momentum20d, drawdownFromPeak
  );

  return {
    ticker,
    assetClass,
    phase,
    phaseDescription: PHASE_DESCRIPTIONS[phase],
    drawdownFromPeak,
    gainFromTrough: gainFromTrough_,
    momentum20d,
    momentum60d,
    momentum120d,
    rsiWeekly,
    aboveMA50,
    aboveMA200,
    ma50vsMA200: maCross,
    distanceToMA200pct,
    atrRatio,
    isCapitulation,
    attackOpportunity,
    attackConfidence,
    suggestedAction: action,
    actionReason,
    cycleScore,
    bullishScore: bullScore,
    bearishScore: bearScore,
    reversalProbability: reversalProb,
    reversalDirection: reversalDir,
  };
}

const PHASE_DESCRIPTIONS: Record<CyclePhase, string> = {
  BULL_EARLY:     'Inicio de ciclo alcista — rotura de resistencia con volumen',
  BULL_EXPANSION: 'Expansión alcista — trend confirmado, momentum fuerte',
  BULL_LATE:      'Final del ciclo alcista — momentum débil, posible techo',
  DISTRIBUTION:   'Distribución — lateral tras rally, salida institucional',
  BEAR_EARLY:     'Inicio bajista — rotura de soporte, momentum negativo',
  BEAR_DEEP:      'Bear profundo — trend bajista confirmado, evitar',
  ACCUMULATION:   'Acumulación — suelo lateral, manos fuertes comprando',
  RECOVERY:       'Recuperación — inversión desde sobreventa extrema',
};

function determineCyclePhase(
  bullScore: number,
  aboveMA50: boolean,
  aboveMA200: boolean,
  maCross: string,
  mom20: number,
  mom60: number,
  drawdown: number,
  rsi: number,
  isCapitulation: boolean
): CyclePhase {
  if (isCapitulation && rsi < 35) return 'ACCUMULATION';

  if (bullScore >= 75) {
    if (mom20 < 0 && mom60 > 0) return 'DISTRIBUTION';
    if (rsi > 72) return 'BULL_LATE';
    return 'BULL_EXPANSION';
  }
  if (bullScore >= 60) {
    if (maCross === 'GOLDEN_CROSS') return 'BULL_EARLY';
    if (aboveMA50 && aboveMA200) return 'BULL_EXPANSION';
    return 'RECOVERY';
  }
  if (bullScore >= 45) {
    if (drawdown > 0.10) return 'ACCUMULATION';
    return 'DISTRIBUTION';
  }
  if (bullScore >= 30) {
    if (maCross === 'DEATH_CROSS') return 'BEAR_EARLY';
    return 'BEAR_EARLY';
  }
  // < 30
  if (rsi < 25 && drawdown > 0.30) return 'ACCUMULATION'; // capitulación extrema
  return 'BEAR_DEEP';
}

function determineAction(
  phase: CyclePhase,
  bullScore: number,
  drawdown: number,
  isCapitulation: boolean,
  assetClass: string
): {
  action: CycleAction;
  attackOpportunity: boolean;
  attackConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
  actionReason: string;
} {
  // Oportunidades de ataque: fases de acumulación/recovery/bull_early con caída
  if (phase === 'ACCUMULATION' && drawdown > 0.10) {
    return {
      action: 'BUY_AGGRESSIVE',
      attackOpportunity: true,
      attackConfidence: 'HIGH',
      actionReason: `Zona de acumulación con drawdown ${(drawdown * 100).toFixed(0)}% — oportunidad estructural`,
    };
  }
  if (phase === 'RECOVERY' || (isCapitulation && phase === 'ACCUMULATION')) {
    return {
      action: 'BUY',
      attackOpportunity: true,
      attackConfidence: 'MEDIUM',
      actionReason: 'Recuperación desde sobreventa — entrada con riesgo controlado',
    };
  }
  if (phase === 'BULL_EARLY') {
    return {
      action: 'BUY',
      attackOpportunity: drawdown > 0.05,
      attackConfidence: 'HIGH',
      actionReason: 'Ciclo alcista temprano — mejor risk/reward del ciclo',
    };
  }
  if (phase === 'BULL_EXPANSION' && drawdown > 0.08) {
    return {
      action: 'BUY',
      attackOpportunity: true,
      attackConfidence: 'MEDIUM',
      actionReason: `Pullback ${(drawdown * 100).toFixed(0)}% en trend alcista confirmado`,
    };
  }
  if (phase === 'BULL_EXPANSION') {
    return {
      action: 'HOLD',
      attackOpportunity: false,
      attackConfidence: 'LOW',
      actionReason: 'Mantener — trend alcista, sin punto de entrada claro',
    };
  }
  if (phase === 'BULL_LATE') {
    return {
      action: 'REDUCE',
      attackOpportunity: false,
      attackConfidence: 'LOW',
      actionReason: 'Reducir — momentum débil, posible techo de ciclo',
    };
  }
  if (phase === 'DISTRIBUTION') {
    return {
      action: 'REDUCE',
      attackOpportunity: false,
      attackConfidence: 'LOW',
      actionReason: 'Distribución activa — institucionales vendiendo, reducir',
    };
  }
  if (phase === 'BEAR_EARLY') {
    return {
      action: 'SELL',
      attackOpportunity: false,
      attackConfidence: 'LOW',
      actionReason: 'Bear temprano — salir antes de que el daño sea mayor',
    };
  }
  // BEAR_DEEP
  return {
    action: 'AVOID',
    attackOpportunity: false,
    attackConfidence: 'LOW',
    actionReason: 'Bear profundo — no incrementar, esperar señales de suelo',
  };
}

function estimateReversal(
  phase: CyclePhase,
  rsi: number,
  atrRatio: number,
  mom20: number,
  drawdown: number
): { reversalProb: number; reversalDir: AssetCycleOutput['reversalDirection'] } {
  // Reversión alcista probable cuando: bear + oversold + vol spike
  if (['BEAR_DEEP', 'ACCUMULATION'].includes(phase) && rsi < 30 && atrRatio > 1.5) {
    return { reversalProb: 0.65, reversalDir: 'BULLISH_REVERSAL' };
  }
  if (phase === 'ACCUMULATION' && rsi < 40) {
    return { reversalProb: 0.50, reversalDir: 'BULLISH_REVERSAL' };
  }
  // Reversión bajista probable cuando: bull_late + overbought
  if (['BULL_LATE', 'DISTRIBUTION'].includes(phase) && rsi > 70) {
    return { reversalProb: 0.55, reversalDir: 'BEARISH_REVERSAL' };
  }
  return { reversalProb: 0.15, reversalDir: 'NONE' };
}

function buildInsufficientDataOutput(ticker: string, assetClass: string): AssetCycleOutput {
  return {
    ticker,
    assetClass,
    phase: 'ACCUMULATION',
    phaseDescription: 'Datos insuficientes — mínimo 50 cierres requeridos',
    drawdownFromPeak: 0,
    gainFromTrough: 0,
    momentum20d: 0,
    momentum60d: 0,
    momentum120d: 0,
    rsiWeekly: 50,
    aboveMA50: false,
    aboveMA200: false,
    ma50vsMA200: 'NEUTRAL',
    distanceToMA200pct: 0,
    atrRatio: 1,
    isCapitulation: false,
    attackOpportunity: false,
    attackConfidence: 'LOW',
    suggestedAction: 'HOLD',
    actionReason: 'Datos insuficientes para análisis de ciclo',
    cycleScore: 50,
    bullishScore: 50,
    bearishScore: 50,
    reversalProbability: 0,
    reversalDirection: 'NONE',
  };
}

// ── ANÁLISIS DE PORTFOLIO COMPLETO ────────────────────────────────────────────

export function analyzePortfolioCycles(
  assets: AssetPriceData[]
): PortfolioCycleOutput {
  const assetCycles = assets.map(analyzeAssetCycle);

  // Score medio del portfolio
  const portfolioCycleScore =
    assetCycles.reduce((s, a) => s + a.cycleScore, 0) / assetCycles.length;

  // Oportunidades de ataque
  const attackOpportunities = assetCycles
    .filter(a => a.attackOpportunity)
    .map(a => ({
      ticker: a.ticker,
      confidence: a.attackConfidence,
      action: a.suggestedAction,
      drawdown: a.drawdownFromPeak,
      reason: a.actionReason,
    }))
    .sort((a, b) => b.drawdown - a.drawdown);

  // Activos en riesgo
  const riskAssets = assetCycles
    .filter(a => ['BEAR_EARLY', 'BEAR_DEEP', 'DISTRIBUTION', 'BULL_LATE'].includes(a.phase))
    .map(a => ({
      ticker: a.ticker,
      phase: a.phase,
      reason: a.actionReason,
    }));

  // Estructura de mercado
  const bullCount = assetCycles.filter(a =>
    ['BULL_EARLY', 'BULL_EXPANSION', 'RECOVERY'].includes(a.phase)
  ).length;
  const bearCount = assetCycles.filter(a =>
    ['BEAR_EARLY', 'BEAR_DEEP'].includes(a.phase)
  ).length;
  const total = assetCycles.length;

  let marketStructure: PortfolioCycleOutput['marketStructure'];
  if (bullCount / total > 0.6) marketStructure = 'RISK_ON';
  else if (bearCount / total > 0.4) marketStructure = 'RISK_OFF';
  else if (bullCount > bearCount) marketStructure = 'TRANSITION';
  else marketStructure = 'MIXED';

  return { assetCycles, portfolioCycleScore, attackOpportunities, riskAssets, marketStructure };
}
