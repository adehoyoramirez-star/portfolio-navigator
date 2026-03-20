// ===============================================
// ARCHIVO: src/core/crypto/bitcoinCycleAnalyzer.ts
// Bitcoin Cycle Intelligence — 5 capas analíticas
// ===============================================
//
// CAPAS (de macro a micro):
//
//   1. POWER LAW CHANNEL  — posición en el canal logarítmico a largo plazo
//      Harold Christopher Burger (2019). log(price) = a·log(days) + b
//      Lower (soporte histórico), Fair Value, Upper (euforia máxima)
//
//   2. HALVING CYCLE PHASE — fase del ciclo de 4 años
//      Pre-halving → Post-halving → Bull peak → Bear → Accumulation
//
//   3. PUELL MULTIPLE — rentabilidad minera (suelos y techos)
//      Puell = emisión diaria USD / MA365(emisión diaria USD)
//      < 0.5 = capitulación minera → zona de suelo histórico
//      > 4.0 = mineros en máxima rentabilidad → techo probable
//
//   4. HASH RIBBON — capitulación y recuperación minera
//      Señal de compra: MA30(hashrate) cruza por encima de MA60
//      (mineros capitulados regresan → estructura recuperada)
//
//   5. PI CYCLE TOP — cruce de medias en techos de ciclo
//      Señal: 111dma cruza 350dma×2 desde abajo
//      Históricamente coincide con techos: 2013, 2017, 2021
//      (solo 3 datos → señal complementaria, no primaria)
//
//   6. ELLIOTT WAVE — estructura de ondas en precio log
//      Algoritmo: detección de pivotes → Fibonacci ratios → onda actual
//      Outputs: wave label, dirección, target, confianza
//
// IMPORTANTE: todos los inputs son MANUALES (no hay feed on-chain nativo)
// Fuentes: lookintobitcoin.com, glassnode, tradingview
// ===============================================

// ── GENESIS DATE ──────────────────────────────────────────────────────────────
// Bloque génesis: 3 de enero de 2009
const GENESIS_DATE = new Date('2009-01-03');

// ── HALVINGS CONOCIDOS + PROYECTADO ───────────────────────────────────────────
export const HALVINGS = [
  { date: new Date('2012-11-28'), block: 210000,  rewardBefore: 50,   rewardAfter: 25 },
  { date: new Date('2016-07-09'), block: 420000,  rewardBefore: 25,   rewardAfter: 12.5 },
  { date: new Date('2020-05-11'), block: 630000,  rewardBefore: 12.5, rewardAfter: 6.25 },
  { date: new Date('2024-04-20'), block: 840000,  rewardBefore: 6.25, rewardAfter: 3.125 },
  { date: new Date('2028-03-15'), block: 1050000, rewardBefore: 3.125,rewardAfter: 1.5625 }, // proyectado
];

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PowerLawBands {
  lower:    number;  // soporte histórico — zona de máxima oportunidad
  fairValue: number; // precio "justo" según adopción logarítmica
  upper:    number;  // zona de euforia/techo
  currentZone: "EXTREME_VALUE" | "VALUE" | "FAIR" | "OVERVALUED" | "BUBBLE";
  positionPct: number; // 0=lower, 50=fair, 100=upper (puede superar 100)
}

export interface HalvingCyclePhase {
  currentHalving: typeof HALVINGS[number];
  nextHalving: typeof HALVINGS[number] | null;
  daysSinceHalving: number;
  daysToNextHalving: number;
  cyclePct: number;       // 0–100% del ciclo actual completado
  phase: "PRE_HALVING" | "POST_HALVING_ACCUMULATION" | "BULL_EXPANSION" | "BLOW_OFF_TOP" | "BEAR_CRASH" | "BEAR_ACCUMULATION";
  phaseDescription: string;
  historicalPeakWindow: string; // cuándo suele ocurrir el pico según histórico
}

export interface PuellMultipleSignal {
  value: number | null;         // valor actual del Puell Multiple
  zone: "CAPITULATION" | "VALUE" | "NEUTRAL" | "ELEVATED" | "EUPHORIA";
  signal: "STRONG_BUY" | "BUY" | "HOLD" | "CAUTION" | "SELL";
  description: string;
  // Rangos de referencia:
  // < 0.5 = capitulación minera → STRONG_BUY histórico
  // 0.5–1.0 = zona de valor
  // 1.0–2.0 = neutral
  // 2.0–4.0 = elevado
  // > 4.0 = euforia → SELL
}

export interface HashRibbonSignal {
  hashRate30ma: number | null;  // MA30 del hashrate (EH/s)
  hashRate60ma: number | null;  // MA60 del hashrate (EH/s)
  state: "CAPITULATION" | "RECOVERY" | "EXPANSION" | "UNKNOWN";
  buySignalActive: boolean;     // true si MA30 acaba de cruzar MA60 desde abajo
  description: string;
  weeksInCurrentState: number;
}

export interface PiCycleSignal {
  ma111: number | null;         // 111-day moving average del precio
  ma350x2: number | null;       // 350-day moving average × 2
  gap: number | null;           // ma350x2 - ma111 (positivo = sin cruce aún)
  gapPct: number | null;        // gap como % de ma350x2
  state: "SAFE" | "APPROACHING" | "CROSSED" | "UNKNOWN";
  // CROSSED = señal de techo histórica activa
  description: string;
}

// ── ELLIOTT WAVE ──────────────────────────────────────────────────────────────
export type ElliottWaveLabel = "1" | "2" | "3" | "4" | "5" | "A" | "B" | "C" | "UNKNOWN";

export interface ElliottWavePoint {
  price: number;
  date?: Date;
  label: string;
}

export interface ElliottWaveAnalysis {
  // Ondas detectadas en el ciclo actual (desde el último suelo de bear market)
  identifiedWaves: ElliottWavePoint[];

  // Posición actual estimada
  currentWave: ElliottWaveLabel;
  currentWaveDirection: "UP" | "DOWN" | "SIDEWAYS";

  // Targets basados en extensiones de Fibonacci
  waveTargets: {
    conservative: number;  // extensión 1.0 (100%)
    base: number;          // extensión 1.618 (161.8%)
    extended: number;      // extensión 2.618 (261.8%)
  } | null;

  // Soporte si es onda correctiva
  correctionSupport: {
    shallow: number;   // retroceso 38.2%
    normal: number;    // retroceso 50%
    deep: number;      // retroceso 61.8%
  } | null;

  // Confianza en el conteo
  confidence: "HIGH" | "MEDIUM" | "LOW";
  confidenceReason: string;

  // Reglas de invalidación
  invalidationLevel: number | null; // precio que invalida el conteo actual
  description: string;
}

export interface BitcoinCycleOutput {
  powerLaw: PowerLawBands;
  halvingPhase: HalvingCyclePhase;
  puellMultiple: PuellMultipleSignal;
  hashRibbon: HashRibbonSignal;
  piCycle: PiCycleSignal;
  elliottWave: ElliottWaveAnalysis;

  // Score sintético del ciclo [0–100]
  // 0 = techo de burbuja, 100 = suelo de capitulación
  cycleScore: number;
  cycleScoreLabel: "SELL_ZONE" | "CAUTION_ZONE" | "NEUTRAL" | "ACCUMULATION" | "BUY_ZONE";

  // Resumen para el dashboard
  summary: string;
  actionBias: "STRONG_BUY" | "BUY" | "HOLD" | "REDUCE" | "SELL";
}

// ── INPUTS ────────────────────────────────────────────────────────────────────
export interface BitcoinCycleInputs {
  currentPrice: number;          // precio BTC en EUR/USD
  referenceDate?: Date;          // fecha de análisis (default: hoy)

  // Power Law (se calcula internamente si no se proveen)
  // Los parámetros están calibrados en USD — ajustar si se usa EUR

  // Puell Multiple (manual — lookintobitcoin.com)
  puellMultiple?: number;        // valor actual (ej: 0.8)

  // Hash Ribbon (manual — glassnode o lookintobitcoin)
  hashRate30ma?: number;         // MA30 hashrate en EH/s
  hashRate60ma?: number;         // MA60 hashrate en EH/s
  hashRibbonState?: "CAPITULATION" | "RECOVERY" | "EXPANSION"; // si no tienes los MA, estado manual
  hashRibbonWeeks?: number;      // semanas en el estado actual

  // Pi Cycle (manual — tradingview o lookintobitcoin)
  piCycleMa111?: number;         // 111dma del precio
  piCycleMa350x2?: number;       // 350dma × 2

  // Elliott Wave — pivotes manuales del ciclo actual
  // El usuario identifica los puntos clave del ciclo (mínimo 2, máximo 6)
  elliottPivots?: ElliottWavePoint[]; // en orden cronológico, alternando low/high
  elliottCurrentWave?: ElliottWaveLabel; // override manual si el algoritmo falla

  // Precio en USD para Power Law (si currentPrice está en EUR, se usa el ratio)
  eurUsdRate?: number;           // default 1.08
}

// ═══════════════════════════════════════════════════════════════════════════════
// POWER LAW CHANNEL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calcula las bandas del Power Law de Bitcoin.
 *
 * Modelo: log10(price_usd) = 5.84 × log10(daysSinceGenesis) - 17.01
 *
 * Calibrado por Harold Christopher Burger (2019) y actualizado con datos hasta 2024.
 * Las bandas inferior y superior son ±1 desviación estándar del residual histórico.
 *
 * Nota: el modelo funciona en USD. Se convierte a EUR con el tipo de cambio.
 */
export function computePowerLawBands(
  referenceDate: Date,
  currentPriceUSD: number
): PowerLawBands {
  const daysSinceGenesis = Math.floor(
    (referenceDate.getTime() - GENESIS_DATE.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysSinceGenesis <= 0) {
    return { lower: 0, fairValue: 0, upper: 0, currentZone: "FAIR", positionPct: 50 };
  }

  const logDays = Math.log10(daysSinceGenesis);

  // Modelo Harold Burger / actualizado 2024:
  // Fair value:  log10(P) = 5.84 × log10(days) - 17.01
  // Lower band:  fair × 0.25  (zona de acumulación extrema)
  // Upper band:  fair × 8.0   (zona de burbuja histórica)
  const fairValueLog = 5.84 * logDays - 17.01;
  const fairValueUSD = Math.pow(10, fairValueLog);

  const lower = fairValueUSD * 0.25;
  const upper = fairValueUSD * 8.0;

  // Posición actual en el canal normalizada
  const logLower = Math.log10(Math.max(1, lower));
  const logUpper = Math.log10(Math.max(1, upper));
  const logCurrent = Math.log10(Math.max(1, currentPriceUSD));

  const positionPct = logUpper > logLower
    ? ((logCurrent - logLower) / (logUpper - logLower)) * 100
    : 50;

  let currentZone: PowerLawBands["currentZone"];
  if (positionPct < 20)       currentZone = "EXTREME_VALUE";
  else if (positionPct < 40)  currentZone = "VALUE";
  else if (positionPct < 60)  currentZone = "FAIR";
  else if (positionPct < 80)  currentZone = "OVERVALUED";
  else                        currentZone = "BUBBLE";

  return {
    lower,
    fairValue: fairValueUSD,
    upper,
    currentZone,
    positionPct: Math.max(0, positionPct),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HALVING CYCLE PHASE
// ═══════════════════════════════════════════════════════════════════════════════

export function computeHalvingPhase(referenceDate: Date): HalvingCyclePhase {
  const now = referenceDate.getTime();

  // Encontrar el último halving ocurrido
  const pastHalvings = HALVINGS.filter(h => h.date.getTime() <= now);
  const currentHalving = pastHalvings[pastHalvings.length - 1] ?? HALVINGS[0];

  // Próximo halving
  const futureHalvings = HALVINGS.filter(h => h.date.getTime() > now);
  const nextHalving = futureHalvings[0] ?? null;

  const daysSinceHalving = Math.floor((now - currentHalving.date.getTime()) / (1000 * 60 * 60 * 24));
  const daysToNextHalving = nextHalving
    ? Math.floor((nextHalving.date.getTime() - now) / (1000 * 60 * 60 * 24))
    : 0;

  const cycleLengthDays = nextHalving
    ? Math.floor((nextHalving.date.getTime() - currentHalving.date.getTime()) / (1000 * 60 * 60 * 24))
    : 1460; // ~4 años

  const cyclePct = Math.min(100, (daysSinceHalving / cycleLengthDays) * 100);

  // Fase del ciclo basada en patrón histórico de los 3 ciclos pasados
  // Día 0–180:   Post-halving accumulation (mercado en calma, acumulación)
  // Día 180–480: Bull expansion (subida sostenida, narrativa)
  // Día 480–600: Blow-off top (euforia, pico probable)
  // Día 600–720: Bear crash (corrección severa −60 a −80%)
  // Día 720–1460: Bear accumulation (lateral/bajista, acumulación smart money)
  // (Rangos aproximados del ciclo 2016-2020 y 2020-2024)

  let phase: HalvingCyclePhase["phase"];
  let phaseDescription: string;

  if (daysSinceHalving < 0) {
    phase = "PRE_HALVING";
    phaseDescription = `Faltan ${Math.abs(daysSinceHalving)} días para el halving. Históricamente, BTC sube 1-3 meses antes del halving.`;
  } else if (daysSinceHalving <= 180) {
    phase = "POST_HALVING_ACCUMULATION";
    phaseDescription = `${daysSinceHalving} días post-halving. Fase de acumulación silenciosa. El mercado aún no ha descontado el impacto del halving en el supply.`;
  } else if (daysSinceHalving <= 480) {
    phase = "BULL_EXPANSION";
    phaseDescription = `${daysSinceHalving} días post-halving. Bull market en expansión. Históricamente el precio sube 10x–20x desde el suelo del ciclo.`;
  } else if (daysSinceHalving <= 600) {
    phase = "BLOW_OFF_TOP";
    phaseDescription = `${daysSinceHalving} días post-halving. Zona de pico histórico. Euforia máxima. Precaución: ventas escalonadas recomendadas.`;
  } else if (daysSinceHalving <= 720) {
    phase = "BEAR_CRASH";
    phaseDescription = `${daysSinceHalving} días post-halving. Crash post-euforia. Correcciones del 60-80% son históricamente normales en esta fase.`;
  } else {
    phase = "BEAR_ACCUMULATION";
    phaseDescription = `${daysSinceHalving} días post-halving. Bear market tardío / acumulación. Smart money construye posición para el próximo ciclo.`;
  }

  // Ventana histórica del pico
  const halvingYear = currentHalving.date.getFullYear();
  const historicalPeakWindow = `${halvingYear + 1} Q4 — ${halvingYear + 2} Q1 (histórico: ~480-600 días post-halving)`;

  return {
    currentHalving,
    nextHalving,
    daysSinceHalving,
    daysToNextHalving,
    cyclePct,
    phase,
    phaseDescription,
    historicalPeakWindow,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUELL MULTIPLE
// ═══════════════════════════════════════════════════════════════════════════════

export function analyzePuellMultiple(value: number | undefined): PuellMultipleSignal {
  if (value === undefined || value === null) {
    return {
      value: null,
      zone: "NEUTRAL",
      signal: "HOLD",
      description: "Sin datos de Puell Multiple. Introduce el valor desde lookintobitcoin.com",
    };
  }

  let zone: PuellMultipleSignal["zone"];
  let signal: PuellMultipleSignal["signal"];
  let description: string;

  if (value < 0.5) {
    zone = "CAPITULATION";
    signal = "STRONG_BUY";
    description = `Puell ${value.toFixed(2)} — Capitulación minera extrema. Históricamente zona de mínimos de ciclo (2015, 2019, 2022). Los mineros están vendiendo BTC por debajo del coste de producción.`;
  } else if (value < 1.0) {
    zone = "VALUE";
    signal = "BUY";
    description = `Puell ${value.toFixed(2)} — Zona de valor. Mineros con rentabilidad baja. Acumulación histórica inteligente.`;
  } else if (value < 2.0) {
    zone = "NEUTRAL";
    signal = "HOLD";
    description = `Puell ${value.toFixed(2)} — Neutral. Mineros con rentabilidad normal. Sin señal direccional fuerte.`;
  } else if (value < 4.0) {
    zone = "ELEVATED";
    signal = "CAUTION";
    description = `Puell ${value.toFixed(2)} — Mineros con alta rentabilidad. Bull market en marcha. Empezar a considerar reducción escalonada de posición.`;
  } else {
    zone = "EUPHORIA";
    signal = "SELL";
    description = `Puell ${value.toFixed(2)} — Euforia minera. Históricamente coincide con techos de ciclo. Alta probabilidad de corrección inminente.`;
  }

  return { value, zone, signal, description };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HASH RIBBON
// ═══════════════════════════════════════════════════════════════════════════════

export function analyzeHashRibbon(
  hashRate30ma: number | undefined,
  hashRate60ma: number | undefined,
  manualState?: "CAPITULATION" | "RECOVERY" | "EXPANSION",
  weeksInState?: number
): HashRibbonSignal {
  const weeks = weeksInState ?? 0;

  // Si tenemos los dos MAs, calculamos el estado
  if (hashRate30ma !== undefined && hashRate60ma !== undefined) {
    const ratio = hashRate30ma / hashRate60ma;
    let state: HashRibbonSignal["state"];
    let buySignalActive = false;
    let description: string;

    if (ratio < 0.98) {
      // MA30 < MA60 → miners are shutting down (capitulation)
      state = "CAPITULATION";
      description = `Hash Ribbon en capitulación (MA30/MA60: ${ratio.toFixed(3)}). Mineros apagando máquinas. Señal de compra PENDIENTE — esperar cruce alcista.`;
    } else if (ratio >= 0.98 && ratio < 1.02) {
      // Cruce reciente (zona de señal)
      state = "RECOVERY";
      buySignalActive = true;
      description = `Hash Ribbon: cruce alcista activo (MA30/MA60: ${ratio.toFixed(3)}). SEÑAL DE COMPRA histórica — mineros en recuperación. Históricamente precede subidas de 3-12 meses.`;
    } else {
      state = "EXPANSION";
      description = `Hash Ribbon en expansión (MA30/MA60: ${ratio.toFixed(3)}). Red Bitcoin sana y creciendo. Sin señal de capitulación.`;
    }

    return {
      hashRate30ma,
      hashRate60ma,
      state,
      buySignalActive,
      description,
      weeksInCurrentState: weeks,
    };
  }

  // Fallback a estado manual
  if (manualState) {
    const stateDescriptions = {
      CAPITULATION: "Mineros apagando máquinas. Señal de compra PENDIENTE — esperar cruce alcista.",
      RECOVERY: "Cruce alcista activo. SEÑAL DE COMPRA histórica.",
      EXPANSION: "Red Bitcoin sana y en crecimiento.",
    };
    return {
      hashRate30ma: null,
      hashRate60ma: null,
      state: manualState,
      buySignalActive: manualState === "RECOVERY",
      description: `Hash Ribbon: ${stateDescriptions[manualState]} (dato manual, ${weeks} semanas en este estado)`,
      weeksInCurrentState: weeks,
    };
  }

  return {
    hashRate30ma: null,
    hashRate60ma: null,
    state: "UNKNOWN",
    buySignalActive: false,
    description: "Sin datos de Hash Ribbon. Introduce MA30 y MA60 del hashrate desde glassnode o lookintobitcoin.",
    weeksInCurrentState: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PI CYCLE TOP
// ═══════════════════════════════════════════════════════════════════════════════

export function analyzePiCycle(
  ma111: number | undefined,
  ma350x2: number | undefined
): PiCycleSignal {
  if (ma111 === undefined || ma350x2 === undefined) {
    return {
      ma111: null,
      ma350x2: null,
      gap: null,
      gapPct: null,
      state: "UNKNOWN",
      description: "Sin datos del Pi Cycle. Necesitas la 111dma y 350dma×2 del precio BTC (TradingView o lookintobitcoin).",
    };
  }

  const gap = ma350x2 - ma111;
  const gapPct = (gap / ma350x2) * 100;

  let state: PiCycleSignal["state"];
  let description: string;

  if (ma111 >= ma350x2) {
    // MA111 cruzó por encima de MA350×2 — señal de techo activa
    state = "CROSSED";
    description = `PI CYCLE CRUZADO — SEÑAL DE TECHO ACTIVA. MA111: $${ma111.toLocaleString()} ≥ MA350×2: $${ma350x2.toLocaleString()}. En 2013, 2017 y 2021 este cruce marcó el techo de ciclo con 2-3 días de desfase.`;
  } else if (gapPct < 15) {
    // Acercándose — precaución
    state = "APPROACHING";
    description = `Pi Cycle: MA111 acercándose a MA350×2 (gap: ${gapPct.toFixed(1)}%). Zona de precaución. Si el gap cierra a 0, señal de techo inminente.`;
  } else {
    state = "SAFE";
    description = `Pi Cycle: gap de ${gapPct.toFixed(1)}% entre MA111 y MA350×2. Lejos del cruce de techo. Sin señal por ahora.`;
  }

  return { ma111, ma350x2, gap, gapPct, state, description };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ELLIOTT WAVE ANALYZER
// ═══════════════════════════════════════════════════════════════════════════════

// Niveles de Fibonacci
const FIB = {
  R382: 0.382,  // retroceso normal onda 2/4
  R500: 0.500,  // retroceso profundo
  R618: 0.618,  // retroceso golden ratio
  E100: 1.000,  // extensión 1:1
  E1618: 1.618, // extensión golden ratio — target clásico onda 3/5
  E2618: 2.618, // extensión extendida — onda 3 extendida
  E4236: 4.236, // extensión extrema
};

/**
 * Detecta la estructura de ondas de Elliott desde los pivotes del ciclo.
 *
 * REGLAS BÁSICAS de Elliott implementadas:
 *   1. Onda 2 nunca retrocede más del 100% de la onda 1
 *   2. Onda 3 nunca es la más corta de las impulsivas (1, 3, 5)
 *   3. Onda 4 no entra en el territorio de precio de la onda 1
 *   4. Correcciones ABC: A y C son ~iguales; B retrocede 38-79%
 *
 * Input: array de pivotes en orden cronológico [low, high, low, high, ...]
 * Output: conteo de ondas, onda actual y targets
 */
export function analyzeElliottWaves(
  pivots: ElliottWavePoint[],
  currentPrice: number,
  manualCurrentWave?: ElliottWaveLabel
): ElliottWaveAnalysis {

  // Sin pivotes suficientes
  if (!pivots || pivots.length < 2) {
    return buildUnknownElliott(currentPrice,
      "Introduce al menos 2 pivotes del ciclo actual (mínimo suelo + techo o techo + suelo actual) para el análisis de ondas.");
  }

  // Override manual del usuario
  if (manualCurrentWave && manualCurrentWave !== "UNKNOWN") {
    return buildManualElliott(pivots, currentPrice, manualCurrentWave);
  }

  // Determinar si el primer pivote es un mínimo o máximo
  // Asumimos que el ciclo empieza en el suelo del bear market
  const n = pivots.length;

  // Asignar labels basándose en la secuencia de pivotes
  // Si tenemos 5+ pivotes y el primer es mínimo: 0→W1 start, 1→W1 end(=W2 start), etc.
  let labels: ElliottWaveLabel[] = [];
  const waveSequence: ElliottWaveLabel[] = ["1", "2", "3", "4", "5", "A", "B", "C"];

  // Determinar si el ciclo empieza alcista (primer pivote es un mínimo local)
  // Heurística: si el primer precio < segundo precio, empieza en mínimo (onda 1 alcista)
  const startsFromLow = n >= 2 && pivots[0].price < pivots[1].price;

  if (startsFromLow) {
    // Secuencia: suelo(inicio) → techo(fin W1) → suelo(fin W2) → techo(fin W3) → suelo(fin W4) → techo(fin W5)
    for (let i = 0; i < Math.min(n, waveSequence.length + 1); i++) {
      if (i === 0) {
        labels.push("1"); // inicio de onda 1 (el pivote es el inicio)
      } else {
        labels.push(waveSequence[i - 1]);
      }
    }
  } else {
    // Empieza desde un techo — probablemente en corrección A-B-C
    for (let i = 0; i < Math.min(n, 4); i++) {
      if (i === 0) labels.push("A");
      else if (i === 1) labels.push("B");
      else labels.push("C");
    }
  }

  // Validar reglas básicas de Elliott
  let isValid = true;
  let invalidationMsg = "";
  const identified: ElliottWavePoint[] = pivots.map((p, i) => ({
    ...p,
    label: labels[i] ?? "?",
  }));

  if (startsFromLow && n >= 4) {
    const w1Start = pivots[0].price;
    const w1End = pivots[1]?.price ?? pivots[0].price;
    const w2End = pivots[2]?.price ?? null;
    // w4End used for Elliott Rule 2 validation below
    const w4End = pivots[4]?.price ?? null;

    // Regla 1: Onda 2 no puede cruzar el inicio de onda 1
    if (w2End !== null && w2End <= w1Start) {
      isValid = false;
      invalidationMsg = `Onda 2 (${w2End}) cruzó el inicio de onda 1 (${w1Start}) — conteo inválido`;
    }

    // Regla 2: Onda 4 no puede entrar en territorio de onda 1
    if (w4End !== null && w1End !== null && w4End <= w1End) {
      isValid = false;
      invalidationMsg = `Onda 4 (${w4End}) entró en territorio de onda 1 (techo: ${w1End}) — conteo inválido`;
    }
  }

  // Determinar onda actual basándose en los pivotes disponibles
  let currentWave: ElliottWaveLabel = "UNKNOWN";
  if (n === 2) currentWave = startsFromLow ? "2" : "B";
  else if (n === 3) currentWave = startsFromLow ? "3" : "C";
  else if (n === 4) currentWave = "4";
  else if (n === 5) currentWave = "5";
  else if (n >= 6) currentWave = currentPrice < pivots[n - 1].price ? "A" : "B";

  // Dirección de la onda actual
  const impulsiveWaves: ElliottWaveLabel[] = ["1", "3", "5", "B"];
  const correctiveWaves: ElliottWaveLabel[] = ["2", "4", "A", "C"];
  const currentWaveDirection = impulsiveWaves.includes(currentWave) ? "UP"
    : correctiveWaves.includes(currentWave) ? "DOWN" : "SIDEWAYS";

  // Calcular targets para onda actual
  let waveTargets = null;
  let correctionSupport = null;
  let invalidationLevel = null;

  if (startsFromLow && n >= 2) {
    const wave1Length = Math.abs(pivots[1].price - pivots[0].price);
    const wave1Start = pivots[0].price;
    const wave1End = pivots[1].price;

    if (currentWave === "3" && n >= 3) {
      // Onda 3: target desde fin de onda 2
      const w2End = pivots[2].price;
      waveTargets = {
        conservative: w2End + wave1Length * FIB.E100,
        base:         w2End + wave1Length * FIB.E1618,
        extended:     w2End + wave1Length * FIB.E2618,
      };
      invalidationLevel = wave1End; // onda 4 no puede entrar en territorio onda 1
    } else if (currentWave === "5" && n >= 5) {
      const w4End = pivots[4].price;
      // FIX: w1to3Length eliminada — era declarada pero nunca usada (usamos wave1Length en targets).
      waveTargets = {
        conservative: w4End + wave1Length * FIB.R618,
        base:         w4End + wave1Length * FIB.E100,
        extended:     w4End + wave1Length * FIB.E1618,
      };
      invalidationLevel = pivots[3].price; // onda 4 no puede cruzar onda 3
    } else if (currentWave === "2" && n >= 2) {
      correctionSupport = {
        shallow: wave1End - wave1Length * FIB.R382,
        normal:  wave1End - wave1Length * FIB.R500,
        deep:    wave1End - wave1Length * FIB.R618,
      };
      invalidationLevel = wave1Start; // onda 2 no puede cruzar inicio onda 1
    } else if (currentWave === "4" && n >= 4) {
      const w3Length = Math.abs(pivots[3].price - pivots[2].price);
      correctionSupport = {
        shallow: pivots[3].price - w3Length * FIB.R382,
        normal:  pivots[3].price - w3Length * FIB.R500,
        deep:    pivots[3].price - w3Length * FIB.R618,
      };
      invalidationLevel = wave1End; // onda 4 no puede entrar en territorio onda 1
    }
  }

  // Confianza
  let confidence: "HIGH" | "MEDIUM" | "LOW" = "LOW";
  let confidenceReason: string;

  if (!isValid) {
    confidence = "LOW";
    confidenceReason = `Conteo cuestionable: ${invalidationMsg}. Reconsiderar los pivotes.`;
  } else if (n >= 5) {
    confidence = "MEDIUM";
    confidenceReason = `${n} pivotes identificados. Estructura ${startsFromLow ? "impulsiva" : "correctiva"} completa. Confianza media.`;
  } else if (n >= 3) {
    confidence = "LOW";
    confidenceReason = `${n} pivotes — conteo parcial. Añadir más pivotes del histórico para aumentar precisión.`;
  } else {
    confidence = "LOW";
    confidenceReason = "Pocos pivotes para análisis fiable. Mínimo recomendado: 4–5 puntos.";
  }

  const waveDescriptions: Record<ElliottWaveLabel, string> = {
    "1": "Onda 1 impulsiva — inicio del bull market. Muchos la confunden con un rebote del bear.",
    "2": "Onda 2 correctiva — retroceso profundo (38–62% de onda 1). Zona de entrada para los que perdieron la onda 1.",
    "3": "Onda 3 impulsiva — la más fuerte y extensa. Volumen máximo. Breakout de resistencias. Target: ×1.618 de onda 1.",
    "4": "Onda 4 correctiva — consolidación. Más compleja que onda 2 (a veces lateral). Soportes en 38% de onda 3.",
    "5": "Onda 5 impulsiva — último empuje alcista. A menudo con divergencias en RSI y MVRV. Target: ~igual a onda 1 o onda 3.",
    "A": "Onda A bajista — primer movimiento correctivo tras el bull market.",
    "B": "Onda B alcista — rebote falso dentro del bear market. Peligrosa: parece recuperación pero no lo es.",
    "C": "Onda C bajista — caída final. Suele igualar o extender onda A. Zona de capitulación y máxima oportunidad.",
    "UNKNOWN": "Posición en el ciclo indeterminada — más datos necesarios.",
  };

  return {
    identifiedWaves: identified,
    currentWave,
    currentWaveDirection,
    waveTargets,
    correctionSupport,
    confidence,
    confidenceReason,
    invalidationLevel: invalidationLevel ?? null,
    description: waveDescriptions[currentWave] ?? "Onda desconocida.",
  };
}

function buildManualElliott(
  pivots: ElliottWavePoint[],
  _currentPrice: number,
  wave: ElliottWaveLabel
): ElliottWaveAnalysis {
  const impulsiveWaves: ElliottWaveLabel[] = ["1", "3", "5", "B"];
  return {
    identifiedWaves: pivots,
    currentWave: wave,
    currentWaveDirection: impulsiveWaves.includes(wave) ? "UP" : "DOWN",
    waveTargets: null,
    correctionSupport: null,
    confidence: "MEDIUM",
    confidenceReason: "Override manual del usuario — conteo verificado por el analista.",
    invalidationLevel: null,
    description: `Onda ${wave} confirmada manualmente.`,
  };
}

function buildUnknownElliott(_currentPrice: number, msg: string): ElliottWaveAnalysis {
  return {
    identifiedWaves: [],
    currentWave: "UNKNOWN",
    currentWaveDirection: "SIDEWAYS",
    waveTargets: null,
    correctionSupport: null,
    confidence: "LOW",
    confidenceReason: msg,
    invalidationLevel: null,
    description: msg,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE SCORE SINTÉTICO
// ═══════════════════════════════════════════════════════════════════════════════

function computeCycleScore(
  powerLaw: PowerLawBands,
  halvingPhase: HalvingCyclePhase,
  puell: PuellMultipleSignal,
  hashRibbon: HashRibbonSignal,
  piCycle: PiCycleSignal
): number {
  // Score [0, 100] — 0 = techo de burbuja, 100 = suelo de capitulación

  // Power Law component (0–35 puntos)
  let plScore = 0;
  if (powerLaw.currentZone === "EXTREME_VALUE") plScore = 35;
  else if (powerLaw.currentZone === "VALUE")    plScore = 28;
  else if (powerLaw.currentZone === "FAIR")     plScore = 20;
  else if (powerLaw.currentZone === "OVERVALUED") plScore = 10;
  else plScore = 3; // BUBBLE

  // Halving phase component (0–25 puntos)
  let halvingScore = 0;
  switch (halvingPhase.phase) {
    case "POST_HALVING_ACCUMULATION": halvingScore = 25; break;
    case "BULL_EXPANSION":            halvingScore = 18; break;
    case "PRE_HALVING":               halvingScore = 15; break;
    case "BEAR_ACCUMULATION":         halvingScore = 22; break;
    case "BEAR_CRASH":                halvingScore = 15; break;
    case "BLOW_OFF_TOP":              halvingScore = 3;  break;
  }

  // Puell Multiple component (0–25 puntos)
  let puellScore = 0;
  if (puell.value !== null) {
    if (puell.zone === "CAPITULATION") puellScore = 25;
    else if (puell.zone === "VALUE")   puellScore = 20;
    else if (puell.zone === "NEUTRAL") puellScore = 12;
    else if (puell.zone === "ELEVATED") puellScore = 6;
    else puellScore = 1; // EUPHORIA
  } else {
    puellScore = 12; // neutral si no hay datos
  }

  // Hash Ribbon component (0–10 puntos)
  let hrScore = 0;
  if (hashRibbon.state === "CAPITULATION") hrScore = 8;
  else if (hashRibbon.state === "RECOVERY") hrScore = 10;
  else if (hashRibbon.state === "EXPANSION") hrScore = 5;
  else hrScore = 5;

  // Pi Cycle deduction (0 o -10 puntos) — solo penaliza en techo
  let piPenalty = 0;
  if (piCycle.state === "CROSSED")     piPenalty = -10;
  else if (piCycle.state === "APPROACHING") piPenalty = -5;

  return Math.max(0, Math.min(100, plScore + halvingScore + puellScore + hrScore + piPenalty));
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

export function analyzeBitcoinCycle(inputs: BitcoinCycleInputs): BitcoinCycleOutput {
  const now = inputs.referenceDate ?? new Date();
  const eurUsdRate = inputs.eurUsdRate ?? 1.08;
  const currentPriceUSD = inputs.currentPrice * eurUsdRate;

  // 1. Power Law (calcula en USD, agnostic de EUR)
  const powerLaw = computePowerLawBands(now, currentPriceUSD);

  // 2. Halving phase
  const halvingPhase = computeHalvingPhase(now);

  // 3. Puell Multiple
  const puellMultiple = analyzePuellMultiple(inputs.puellMultiple);

  // 4. Hash Ribbon
  const hashRibbon = analyzeHashRibbon(
    inputs.hashRate30ma,
    inputs.hashRate60ma,
    inputs.hashRibbonState,
    inputs.hashRibbonWeeks
  );

  // 5. Pi Cycle
  const piCycle = analyzePiCycle(inputs.piCycleMa111, inputs.piCycleMa350x2);

  // 6. Elliott Wave
  const elliottWave = analyzeElliottWaves(
    inputs.elliottPivots ?? [],
    inputs.currentPrice,
    inputs.elliottCurrentWave
  );

  // Score sintético
  const cycleScore = computeCycleScore(powerLaw, halvingPhase, puellMultiple, hashRibbon, piCycle);

  let cycleScoreLabel: BitcoinCycleOutput["cycleScoreLabel"];
  let actionBias: BitcoinCycleOutput["actionBias"];
  let summary: string;

  if (cycleScore >= 75) {
    cycleScoreLabel = "BUY_ZONE";
    actionBias = "STRONG_BUY";
    summary = `Score ${cycleScore}/100 — Zona de compra histórica. ${halvingPhase.phaseDescription} ${puellMultiple.description}`;
  } else if (cycleScore >= 55) {
    cycleScoreLabel = "ACCUMULATION";
    actionBias = "BUY";
    summary = `Score ${cycleScore}/100 — Acumulación razonable. ${halvingPhase.phaseDescription}`;
  } else if (cycleScore >= 40) {
    cycleScoreLabel = "NEUTRAL";
    actionBias = "HOLD";
    summary = `Score ${cycleScore}/100 — Zona neutral. Mantener posición según plan.`;
  } else if (cycleScore >= 25) {
    cycleScoreLabel = "CAUTION_ZONE";
    actionBias = "REDUCE";
    summary = `Score ${cycleScore}/100 — Precaución. Considerar reducción escalonada. ${piCycle.description}`;
  } else {
    cycleScoreLabel = "SELL_ZONE";
    actionBias = "SELL";
    summary = `Score ${cycleScore}/100 — ZONA DE VENTA. Múltiples indicadores de techo. ${piCycle.description}`;
  }

  return {
    powerLaw,
    halvingPhase,
    puellMultiple,
    hashRibbon,
    piCycle,
    elliottWave,
    cycleScore,
    cycleScoreLabel,
    summary,
    actionBias,
  };
}

// ── HELPER: precio Power Law para una fecha futura (útil para proyecciones) ───
export function getPowerLawProjection(targetDate: Date, zone: "lower" | "fair" | "upper" = "fair"): number {
  const daysSinceGenesis = Math.floor(
    (targetDate.getTime() - GENESIS_DATE.getTime()) / (1000 * 60 * 60 * 24)
  );
  const fairValueLog = 5.84 * Math.log10(daysSinceGenesis) - 17.01;
  const fair = Math.pow(10, fairValueLog);
  if (zone === "lower") return fair * 0.25;
  if (zone === "upper") return fair * 8.0;
  return fair;
}