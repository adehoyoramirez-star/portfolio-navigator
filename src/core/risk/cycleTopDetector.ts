// ===============================================
// ARCHIVO: src/core/risk/cycleTopDetector.ts
// Detección de techo de ciclo por activo
// ===============================================
// Cada activo tiene su propio driver de ciclo:
//   BTC       → MVRV ratio (on-chain)
//   Uranio    → Spot/LT ratio (mercado físico)
//   Semis     → Book-to-Bill ratio (SEMI.org)
//   Oro       → Tipo real (bono 10y − inflación implícita)
//   WLG       → RSI semanal MSCI World + P/E Forward MSCI World (manual, TradingView/Yardeni) — sustituye a IS3Q y XNAS
//   EMXC      → RSI semanal EEM + P/E Emergentes (manual)
//
// Output: un multiplicador [0, 1] por activo
//   1.0 = sin restricción (zona segura)
//   0.5 = reducir al 50% del peso objetivo
//   0.1 = reducir al 10% del peso objetivo (techo extremo)
//
// CONTRATO: allocationMultiplier ∈ [0, 1] — garantizado centralizadamente en
//           detectCycleTops() vía clamp post-map. Ningún detector individual
//           puede violarlo aunque su lógica interna se equivoque.
// ===============================================

// ── Validación de lecturas numéricas ─────────────────────────────
// FIX-VALID-READINGS (Jul-2026): helper reutilizable contra NaN y valores
//   imposibles. Si un fetch de FRED devuelve NaN (parseo fallido de CSV),
//   NaN > X es siempre false → fallo silencioso idéntico al bug dxy=0.
//   Number.isFinite() bloquea NaN, Infinity, y -Infinity de una vez.
const isValidReading = (
  v?: number,
  min = -Infinity,
  max = Infinity,
): v is number => {
  // FIX-H8 (Jul-2026): si el valor es exactamente 0 y min > 0, es probablemente
  //   un dato erroneo (ej: DXY=0 por fetch fallido de Yahoo).
  const valid = v !== undefined && Number.isFinite(v);
  if (!valid) return false;
  if (v === 0 && min > 0) return false; // dato claramente invalido
  // FIX-RSI-BOUNDARY (Ago-2026): límites inclusivos. Antes `v < max` invalidaba
  //   RSI=100 (legítimo: 14 semanas todas alcistas) → la lectura se caía del
  //   detector y el trimPct colapsaba (ej. 55%→0%). Un RSI en [0,100] es válido
  //   en ambos extremos. Por eso `>= min && <= max`, no `> min && < max`.
  return v >= min && v <= max;
}

// ── Clamp de RSI a [0,100] ──────────────────────────────────────
// FIX-RSI-CLAMP (Ago-2026, Comité): un RSI > 100 es un dato imposible
//   (RSI ∈ [0,100] por definición). ANTES isValidReading(...,0,100) lo
//   invalidaba → el indicador caía del detector → topSignals colapsaba
//   (ej. 55%→0%) y el panel mostraba SAFE con un dato basura. clampRSI lo
//   lleva al límite [0,100] y preserva la señal extrema. No añade
//   parámetros ni cambia thresholds.
const clampRSI = (v?: number): number | undefined => {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  return Math.min(100, Math.max(0, v));
}

// ── Interpolación lineal entre umbrales ──────────────────────────
// FIX-SMOOTH-THRESHOLDS (Jul-2026): reemplaza if/else duros con
//   interpolación lineal continua. Elimina el acantilado donde
//   P/E 18.99 → score 0 y P/E 19.01 → score 1.0.
//
//   thresholds: pares [umbral, score] ordenados de menor a mayor.
//   x ≤ thresholds[0][0] → 0
//   x ≥ thresholds[last][0] → thresholds[last][1]
//   entre medias → interpolación lineal
//
//   Ejemplo: P/E Forward 15.5 con thresholds [[14,1.0],[18,1.5],[25,2.5]]
//     → score = 1.0 + (1.5-1.0)×(15.5-14)/(18-14) = 1.0 + 0.19 = 1.19
const smoothScore = (
  x: number,
  thresholds: [number, number][],
): number => {
  if (thresholds.length === 0) return 0;
  const sorted = [...thresholds].sort((a, b) => a[0] - b[0]);
  if (x <= sorted[0][0]) return 0;
  if (x >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [t1, s1] = sorted[i];
    const [t2, s2] = sorted[i + 1];
    if (x >= t1 && x <= t2) {
      return s1 + (s2 - s1) * (x - t1) / (t2 - t1);
    }
  }
  return 0;
};

// ── Interpolación suave para topSignals → multiplier/trimPct ─────
// Convierte topSignals (0-7+) en [multiplier, zone, trimPct] usando
// rampas lineales entre los puntos de anclaje originales.
const multiplierFromScore = (score: number): { multiplier: number; zone: CycleTopSignal["zone"]; trimPct: number } => {
  // Guard: score 0 = no hay senales de techo. SAFE, sin trim.
  // smoothScore retorna 0 para x <= primer umbral → multiplier=0 → falso 95% trim.
  if (score <= 0) return { multiplier: 1.0, zone: "SAFE", trimPct: 0 };
  // Puntos de anclaje: [topSignals, multiplier]. [0, 1.0] sirve como ancla
  // para interpolar scores (0, 0.5) — el guard maneja score=0 por separado.
  const multiplier = smoothScore(score, [
    [0, 1.0],
    [0.5, 0.75],
    [1.5, 0.55],
    [2.5, 0.35],
    [3.5, 0.20],
    [5.0, 0.10],
  ]);
  // Zone: discreta por diseño (SAFE/CAUTION/DANGER/EXTREME son etiquetas cualitativas).
  // El multiplier SÍ es continuo gracias a smoothScore.
  const zone: CycleTopSignal["zone"] =
    score >= 3.5 ? "EXTREME" : score >= 2.5 ? "DANGER" : score >= 0.5 ? "CAUTION" : "SAFE";
  // trimPct = 1 − multiplier (consistente: ×0.55 = −45% trim, no 35% arbitrario)
  const trimPct = Math.round((1 - multiplier) * 100);
  return { multiplier: Math.max(0.05, Math.min(1, multiplier)), zone, trimPct };
};

export interface CycleTopInputs {
  // BTC
  mvrvRatio?: number;          // lookintobitcoin.com — umbral techo: >3.5
  btcDominanceFalling?: boolean; // BTC.D cayendo desde >58% (calculado en dashboard)
  btcRsiWeekly?: number;       // RSI semanal BTC — TradingView, período 14, timeframe W
  puellMultiple?: number;      // Puell Multiple — lookintobitcoin.com. Umbral techo: >3.5 (euforia minera)
                                //   Complementa MVRV midiendo supply-side (agotamiento de mineros).
                                //   Puell > 2.5 = mineros con alta rentabilidad, > 3.5 = euforia insostenible.
  mvrvZScore?: number;         // MVRV Z-Score — Glassnode (normalizado por volatilidad histórica).
                                //   Más robusto en era ETF que el ratio bruto. Umbral techo canónico: >7.
                                //   Si está disponible, se usa como PRIMARIO (reemplaza al ratio bruto).

  // Uranio
  uraniumSpotPrice?: number;   // $/lb — uxc.com o cameco.com/invest
  uraniumLTPrice?: number;     // $/lb precio largo plazo — misma fuente

  // Semiconductores
siaSalesYoY?: number;        // Crecimiento interanual de ventas globales de semis (%) — SIA/WSTS
soxRsiWeekly?: number;       // RSI semanal del índice PHLX Semiconductor (^SOX)
soxSpyRelativeStrength?: number; // SOX/SPX Relative Strength (Z-score 200d). Indicador líder de ciclo.
                                  //   Z > 2 = euforia semis vs mercado broad. Z > 1 = outperformance.
                                  //   Documentado como leading indicator del ciclo de semiconductores.

  // Oro
  bondYield10y: number;        // US10Y nominal, porcentaje; fallback del tipo real
  inflationBreakeven?: number; // Breakeven 5Y, porcentaje; fallback explícito
  realYield10y?: number;       // DFII10: rendimiento real 10Y TIPS, porcentaje; fuente preferida
  realYieldSource?: "DFII10" | "NOMINAL_MINUS_BREAKEVEN_5Y";
  brentOil?: number;           // $/barril — si >$95 la guerra/inflación protege al oro → override HOLD
  goldCbPurchases?: number;   // GOLD-CB-SENSOR (Ago-2026, Comité): compras netas de oro de
                              //   bancos centrales (toneladas/año, World Gold Council trimestral).
                              //   COINCIDENTE/estructural, NO leading → NO puntúa: actúa como
                              //   atenuador del trim (peso bajo) cuando los BC compran récord.
                              //   Media 2010-2020 ~450 t/año; 2022-2024 ~1.000-1.100 t/año (récord).
                              //   Rampa de atenuación: 500→0, 800→+0.10, 1200→+0.20 de relief.

  // WLG (Vanguard Global Stock — MSCI World)
  wlgRsiWeekly?: number;     // RSI semanal URTH (proxy MSCI World) — TradingView, período 14, timeframe W
  wlgPERatio?: number;       // P/E Forward del MSCI World (manual — TradingView: URTH · P/E Forward, o Yardeni)
                              //   Forward = precio / beneficios estimados próximos 12 meses.
                              //   Preferible a TTM cuando los beneficios crecen rápido (>20% YoY):
                              //   el TTM usa beneficios de hace 12 meses (menores) → infla el P/E artificialmente.
                              //   Media histórica forward: ~16 (10-15 años, post-2010, estándar institucional).
  wlgEpsGrowth?: number;     // Forward EPS Growth estimado (%) — FactSet, Yardeni, o TradingView.
                              //   Usado para calcular PEG = P/E ÷ EPS Growth y modular el score de valoración.
                              //   PEG < 1 → crecimiento justifica el múltiplo → reducir trim.
                              //   PEG > 2 → crecimiento no justifica → aumentar trim.
                              //   Impacto máximo: ±30% sobre valuationScore. Sin dato → sin ajuste.
  wlgCAPE?: number;          // Shiller CAPE del S&P 500 vía FRED. PROXY del MSCI World (USA ~70% del índice).
                              //   ⚠️ S&P 500 es estructuralmente más caro que el MSCI World por concentración Mag7/tech.
                              //   CAPE > 30 desde S&P 500 puede sobrestimar la valoración global. Los reasons
                              //   de la señal de techo aclaran que es "S&P 500 CAPE como proxy".

  // EMXC (Emerging Markets)
  emxcRsiWeekly?: number;     // RSI semanal EEM — TradingView, período 14, timeframe W
  emxcPERatio?: number;       // P/E del MSCI Emerging Markets (manual — Yardeni)
  dxy?: number;              // DXY spot — índice del dólar USA. #1 factor de riesgo EM (BIS).
                              //   DXY > 106 = estrés, > 110 = crisis EM.
                              //   Solo se considera válido si dxy > 50 (guarda sanitario contra 0 = fetch fallido).

  // P1.2: CREDIT-SPREAD (Jul 2026, Comité) — amplificador/atenuador de valoración
  //   Spreads estrechos (<1.5%): complacencia de crédito → confirma euforia → amplifica trim.
  //   Spreads normales (1.5-3.5%): sin ajuste.
  //   Spreads amplios (>3.5%): estrés en crédito → mercado de bonos huele problemas
  //     que equities aún no descuentan. Señal contrarian para techos: el miedo en crédito
  //     suele estar más cerca del suelo que del techo → atenúa trim.
  creditSpread?: number;

  // ── Capa Táctica Diaria (TACTICAL-DAILY Jul 2026) ──────────────
  //   Price histories desde Yahoo Finance (EOD closes) para computar
  //   indicadores diarios (RSI-14, Z-score MA50).
  //   INTRADAY-FIX (Jul-2026): currentPrices inyecta el precio near-real-time
  //     de Yahoo (delay 15min) como último elemento del array antes de calcular
  //     RSI y Z-score. Esto captura caídas intradía (-8% a las 14:00) sin
  //     esperar al cierre del mercado.
  priceHistories?: Record<string, number[]>;  // ticker → daily EOD closes
  currentPrices?: Record<string, number>;     // ticker → near-real-time price (Yahoo, ~15min delay)
  //   Guard de régimen: las señales tácticas solo se activan si el
  //   régimen NO es CRISIS (en crisis, el pánico diario = más pánico).
  regime?: string;

  // ── P1: REGIME-CONDITIONED VALUATION (Jul 2026, Comité) ───────
  //   Shift aplicado al indicador de valoración ANTES de smoothScore.
  //   Se computa en el dashboard con rampa temporal (5 sesiones) para
  //   evitar saltos bruscos al cambiar de régimen.
  //   EXPANSION → shift positivo (tolera más valoración, tipos bajos).
  //   CRISIS    → shift negativo (castiga valoración, liquidez escasa).
  //   El dashboard ya aplicó la rampa; el detector solo consume el shift.
  //   Calibrado a Forward P/E: ±1.5 equity, ±1.0 BTC.
  regimeShiftPE?: number;   // shift para P/E Forward (WLG) — ±1.5 suavizado por rampa
  regimeShiftBTC?: number;  // shift para MVRV Z-Score (BTC) — ±1.0 suavizado por rampa
}

export interface CycleTopSignal {
  asset: string;               // nombre del activo
  ticker: string;              // ticker ETF
  allocationMultiplier: number; // [0.1, 1.0] — multiplica el peso objetivo del motor
  zone: "SAFE" | "CAUTION" | "DANGER" | "EXTREME"; // zona de ciclo
  reason: string;              // explicación legible
  indicator: string;           // qué indicador disparó la señal
  indicatorValue: string;      // valor actual del indicador
  shouldTrim: boolean;         // true si hay que vender parcialmente
  trimPct: number;             // % de la posición actual a vender (0 = no vender)
}

export interface CycleTopOutput {
  signals: CycleTopSignal[];
  hasActiveWarnings: boolean;
  hasTrimSuggestions: boolean;
}

// ── BTC ──────────────────────────────────────────────────────────
function detectBTCTop(inputs: CycleTopInputs): CycleTopSignal {
  const { mvrvRatio, btcDominanceFalling, btcRsiWeekly, puellMultiple, mvrvZScore, regimeShiftBTC } = inputs;

  // Contar señales de techo activas
  let topSignals = 0;
  const reasons: string[] = [];

  // MVRV Z-Score — PRIMARIO si está disponible (más robusto en era ETF).
  //   Umbral canónico: Z > 7 = techo (solo 2013, 2017, 2021).
  //   Si no hay Z-Score, fallback al ratio bruto con smoothScore.
  // P1-REGIME (Jul 2026): aplicar shift de régimen (EXPANSION +1, CRISIS -1)
  //   para tolerar más valoración con tipos bajos y castigar con tipos altos.
  //   El dashboard ya suavizó la transición (rampa en 5 sesiones).
  if (isValidReading(mvrvZScore)) {
    const regimeShift = regimeShiftBTC ?? 0;
    const effectiveZ = mvrvZScore - regimeShift;
    // Z-Score: rampa suave [5→0, 6→1, 7→3, 8→4] — preserva el umbral canónico 7.
    const zScore = smoothScore(effectiveZ, [
      [5, 0],
      [6, 1],
      [7, 3],
      [8, 4],
    ]);
    topSignals += zScore;
    const zNote = regimeShift !== 0 ? ` (efectivo ${effectiveZ.toFixed(2)} por régimen)` : '';
    if (mvrvZScore > 8)       reasons.push(`MVRV Z ${mvrvZScore.toFixed(2)}${zNote} — techo confirmado (Z>8 solo en 2013, 2017, 2021)`);
    else if (mvrvZScore > 7)  reasons.push(`MVRV Z ${mvrvZScore.toFixed(2)}${zNote} — zona de techo canónico (>7)`);
    else if (mvrvZScore > 6)  reasons.push(`MVRV Z ${mvrvZScore.toFixed(2)}${zNote} — acercándose a techo`);
    else if (zScore > 0)      reasons.push(`MVRV Z ${mvrvZScore.toFixed(2)}${zNote} — por encima de la media`);
  } else if (isValidReading(mvrvRatio)) {
    // FIX-SMOOTH-MVRV (Jul-2026): rampa suave elimina el acantilado donde
    //   MVRV 4.49→+1 y 4.51→+2. Rampa: [2.0→0, 3.5→1, 4.5→2, 6.0→3, 7.5→3.5].
    //   MVRV 4.5 → 2.0 (anclaje). MVRV 3.0 → 0.67 (interpolado).
    const mrvrScore = smoothScore(mvrvRatio, [
      [2.0, 0],
      [3.5, 1],
      [4.5, 2],
      [6.0, 3],
      [7.5, 3.5],
    ]);
    topSignals += mrvrScore;
    if (mvrvRatio > 7.5)      reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — máximo histórico`);
    else if (mvrvRatio > 6.0) reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — extremo histórico`);
    else if (mvrvRatio > 4.5) reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — zona de burbuja`);
    else if (mvrvRatio > 3.5) reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — alerta de techo`);
    else if (mrvrScore > 0)   reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — elevado`);
  }

  // Puell Multiple — supply-side: agotamiento de mineros (complementa MVRV que mide demanda)
  // CALIBRACIÓN P0 (Comité Jul-2026): thresholds exactos del plan de auditoría.
  //   Puell > 5 = agotamiento extremo de mineros (solo 2013, 2017, 2021).
  //   Puell > 3.5 = euforia minera. Mineros ganando 3.5× la media anual.
  //   Puell > 2.5 = alta rentabilidad minera. Bull market maduro, empezar reducción.
  //   La combinación MVRV>3.5 + Puell>2.5 es el gold standard de techo de ciclo.
  if (isValidReading(puellMultiple)) {
    if (puellMultiple > 5)       { topSignals += 3; reasons.push(`Puell ${puellMultiple.toFixed(2)} — agotamiento extremo de mineros (solo 2013, 2017, 2021).`); }
    else if (puellMultiple > 3.5)  { topSignals += 2; reasons.push(`Puell ${puellMultiple.toFixed(2)} — euforia minera. Mineros ganando 3.5× la media anual.`); }
    else if (puellMultiple > 2.5)  { topSignals += 1; reasons.push(`Puell ${puellMultiple.toFixed(2)} — alta rentabilidad minera. Bull market maduro.`); }
  }

  if (btcDominanceFalling)     { topSignals += 1; reasons.push("BTC.D cayendo desde >58% — rotación a altcoins (fin de ciclo)"); }

  // FIX-RSI-CLAMP (Ago-2026): clamp [0,100] en vez de invalidar (fallo silencioso).
  // FIX-RSI-RAMP (Ago-2026, Comité): rampa suave [80→0, 85→2] sustituye al salto
  //   único +2 en 80. Preserva el cap +2 en sobrecompra extrema (≥85) y no
  //   recorta por debajo de 80. Elimina el cliff de 55pp (el mayor del sistema).
  const btcRsi = clampRSI(btcRsiWeekly);
  if (btcRsi !== undefined) {
    const btcRsiScore = smoothScore(btcRsi, [
      [80, 0],
      [85, 2],
    ]);
    topSignals += btcRsiScore;
    if (btcRsiScore >= 2) reasons.push(`RSI semanal ${btcRsi.toFixed(0)} — sobrecompra extrema en timeframe semanal`);
    else if (btcRsiScore > 0) reasons.push(`RSI semanal ${btcRsi.toFixed(0)} — zona de sobrecompra en timeframe semanal`);
  }

  // FIX-STRUCTURAL (Jul-2026): multiplier única fuente de verdad, trimPct derivado.
  //   multiplierFromScore usa rampas suaves entre los puntos de anclaje originales
  //   (0→1.0, 0.5→0.75, 1.5→0.55, 2.5→0.35, 3.5→0.20, 5.0→0.10).
  //   Sin acantilados: topSignals=1 → ~0.65 (antes 0.70), topSignals=3 → ~0.28 (antes 0.30).
  const { multiplier, zone, trimPct } = multiplierFromScore(topSignals);

  // MVRV como indicador primario para mostrar (+ Puell si disponible)
  const parts: string[] = [];
  if (isValidReading(mvrvRatio)) parts.push(`MVRV ${mvrvRatio.toFixed(2)}`);
  if (isValidReading(puellMultiple)) parts.push(`Puell ${puellMultiple.toFixed(2)}`);
  if (isValidReading(btcRsiWeekly)) parts.push(`RSI-W ${btcRsiWeekly.toFixed(0)}`);
  const indicatorValue = parts.join(" · ") || "Sin datos on-chain";

  return {
    asset: "Bitcoin",
    ticker: "BTC-EUR",
    allocationMultiplier: multiplier,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Zona segura — sin señales de techo de ciclo",
    indicator: "MVRV + Puell + BTC.D + RSI Semanal",
    indicatorValue,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── URANIO ───────────────────────────────────────────────────────
function detectUraniumTop(inputs: CycleTopInputs): CycleTopSignal {
  const { uraniumSpotPrice, uraniumLTPrice, priceHistories } = inputs;

  if (!isValidReading(uraniumSpotPrice) || !isValidReading(uraniumLTPrice) || uraniumLTPrice === 0) {
    return {
      asset: "Uranium",
      ticker: "URNU.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de precio spot/LT — introduce uraniumSpot y uraniumLT para activar esta señal",
      indicator: "Spot/LT Ratio",
      indicatorValue: "Sin datos",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  const ratio = uraniumSpotPrice / uraniumLTPrice;
  // Historial: en 2007 el spot llegó a 136$/lb con LT en 95$/lb → ratio 1.43 → techo
  // Rango normal: spot ≈ LT (ratio ~1.0). Peligro: ratio >1.20
  //
  // FIX-URANIUM-VALUE (Jul 2026): añadido boost cuando spot está barato vs LT.
  //   Spot < LT → contango → mercado anticipa escasez futura. Históricamente,
  //   ratios < 0.70-0.85 han precedido rallies de +100-300% (2016, 2020).
  //   El boost es asimétrico: el ratio alto castiga más de lo que el bajo premia,
  //   porque el uranio es un activo de alta volatilidad (URNU ~35% vol).

  // FIX-STRUCTURAL (Jul-2026): multiplier única fuente de verdad, trimPct derivado.
  //   Rampa suave en ratio Spot/LT. Ratio ≤ 1.0 → multiplier 1.0 (SAFE).
  //   Ratio > 1.0 castiga progresivamente: 1.10→0.75, 1.20→0.55, 1.30→0.35, 1.50→0.15, 1.70+→0.10.
  //   Ratio < 0.85 → zona de acumulación (multiplier sigue siendo 1.0 porque no hay techo).
  const multiplier = ratio <= 1.0 ? 1.0 : smoothScore(ratio, [
    [1.0, 1.0],
    [1.10, 0.75],
    [1.20, 0.55],
    [1.30, 0.35],
    [1.50, 0.15],
    [1.70, 0.10],
  ]);
  const zone: CycleTopSignal["zone"] =
    multiplier <= 0.20 ? "EXTREME" : multiplier <= 0.40 ? "DANGER" : multiplier < 1.0 ? "CAUTION" : "SAFE";
  const trimPct = Math.round((1 - multiplier) * 100);

  let reason: string;
  if (ratio < 0.70) {
    reason = `Spot/LT ${ratio.toFixed(2)} — descuento profundo. Spot muy por debajo del LT: utilities pagan fuerte prima por suministro futuro. Señal de acumulación agresiva.`;
  } else if (ratio < 0.85) {
    reason = `Spot/LT ${ratio.toFixed(2)} — spot barato vs contratos a largo plazo. Contango saludable: el mercado anticipa tightening futuro. Ventana de acumulación.`;
  } else if (ratio > 1.50) {
    reason = `Spot/LT ${ratio.toFixed(2)} — utilities comprando en pánico (como 2007). Techo de ciclo inminente.`;
  } else if (ratio > 1.30) {
    reason = `Spot/LT ${ratio.toFixed(2)} — fuerte backwardation. Demanda spot muy por encima de contratos LT.`;
  } else if (ratio > 1.20) {
    reason = `Spot/LT ${ratio.toFixed(2)} — alerta de ciclo. Spot superando LT en >20%.`;
  } else if (ratio > 1.10) {
    reason = `Spot/LT ${ratio.toFixed(2)} — ligera tensión. Spot empieza a superar al LT.`;
  } else if (ratio > 1.0) {
    reason = `Spot/LT ${ratio.toFixed(2)} — spot ligeramente por encima del LT. Prima modesta, sin señal de alerta.`;
  } else {
    reason = `Spot/LT ${ratio.toFixed(2)} — equilibrio normal entre spot y contratos a largo plazo.`;
  }

  // FIX-AUDIT-URANIO-CLAMP (Jul-2026): el clamp [0,1] ahora se aplica
  //   centralizadamente en detectCycleTops() para TODOS los detectores.
  //   Ver contrato del output al inicio del archivo.

  // ── Momentum 3m como indicador secundario (Jul 2026) ──────────
  //   URNU tiene σ~35% anual. Un rally de +50% en 3 meses es euforia
  //   (solo en 2007, 2020, 2023). +100% es burbuja especulativa.
  //   El Spot/LT ratio mide el mercado físico. El momentum mide el
  //   sentimiento del equity (URNU = ETF de mineras, no spot físico).
  let momentumNote = '';
  const urnuPrices = priceHistories?.['URNU.DE'];
  if (urnuPrices && urnuPrices.length >= 63) {
    const ret3m = (urnuPrices[urnuPrices.length - 1] / urnuPrices[urnuPrices.length - 63] - 1);
    if (ret3m > 1.0) {
      // +100% en 3 meses → euforia extrema
      momentumNote = ` · URNU +${(ret3m*100).toFixed(0)}% en 3 meses — euforia especulativa (solo 2007, 2020).`;
      reason += momentumNote;
    } else if (ret3m > 0.50) {
      // +50% en 3 meses → rally fuerte, posible techo táctico
      momentumNote = ` · URNU +${(ret3m*100).toFixed(0)}% en 3 meses — rally fuerte. Vigilar toma de beneficios.`;
      reason += momentumNote;
    }
  }

  return {
    asset: "Uranium",
    ticker: "URNU.DE",
    allocationMultiplier: multiplier,
    zone,
    reason,
    indicator: "Uranium Spot/LT Ratio",
    indicatorValue: `Spot $${uraniumSpotPrice}/lb · LT $${uraniumLTPrice}/lb → ratio ${ratio.toFixed(2)}`,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── SEMICONDUCTORES ──────────────────────────────────────────────
function detectSemisTop(inputs: CycleTopInputs): CycleTopSignal {
  const { siaSalesYoY, soxRsiWeekly, soxSpyRelativeStrength } = inputs;
  const soxRsi = clampRSI(soxRsiWeekly); // FIX-RSI-CLAMP: [0,100]

  // Si no hay datos de ningún indicador, señal neutra
  if (!isValidReading(siaSalesYoY, -100) && soxRsi === undefined && !isValidReading(soxSpyRelativeStrength, -10, 10)) {
    return {
      asset: "Semiconductors",
      ticker: "VVSM.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de ventas SIA, RSI del SOX ni SOX/SPX RS — introduce al menos uno para activar esta señal",
      indicator: "SIA Sales YoY + SOX RSI Semanal + SOX/SPX RS",
      indicatorValue: "Sin datos",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  // Contar señales de techo activas
  let topSignals = 0;
  const reasons: string[] = [];

  // SOX/SPX Relative Strength — INDICADOR LÍDER (cableado Jul 2026)
  //   Z-score del ratio SOX/SPX sobre ventana 200d.
  //   Z > 2 = semis en euforia vs mercado broad. Leading indicator documentado
  //   en literatura de ciclos de semiconductores. Captura burbujas sectoriales
  //   antes que SIA Sales (que es coincidente/lagging).
  //   Peso: +2 señales (mismo peso que SIA en modo primario, compatible con
  //   degradación de SIA a confirmatorio).
  if (isValidReading(soxSpyRelativeStrength, -10, 10)) {
    if (soxSpyRelativeStrength > 2.0)        { topSignals += 2; reasons.push(`SOX/SPX RS Z ${soxSpyRelativeStrength.toFixed(2)} — euforia sectorial extrema (semis 2σ+ vs mercado)`); }
    else if (soxSpyRelativeStrength > 1.5)   { topSignals += 1.5; reasons.push(`SOX/SPX RS Z ${soxSpyRelativeStrength.toFixed(2)} — fuerte outperformance de semis`); }
    else if (soxSpyRelativeStrength > 1.0)   { topSignals += 0.75; reasons.push(`SOX/SPX RS Z ${soxSpyRelativeStrength.toFixed(2)} — semis outperforming, vigilar`); }
  }

  // SIA Sales YoY% — ELIMINADO del scoring de techo (Jul 2026, Comité).
  //   Motivo: no puntúa (era informativo), no mueve el multiplier.
  //   SIA es COINCIDENTE/LAGGING: mide ventas YA realizadas, dato mensual.
  //   Los únicos triggers accionables son SOX/SPX RS (leading) y SOX RSI-W (momentum).
  //   SIA sigue puntuando en detectSemisBottom (suelos) donde la contracción
  //   de ventas (<0% YoY) sí es señal de recession pricing. Permanece en indicatorValue.

  // Evaluar RSI semanal del SOX (clamp [0,100])
  if (soxRsi !== undefined) {
    if (soxRsi > 85) {
      topSignals += 2;
      reasons.push(`RSI semanal SOX ${soxRsi.toFixed(0)} — sobrecompra extrema`);
    } else if (soxRsi > 80) {
      topSignals += 1;
      reasons.push(`RSI semanal SOX ${soxRsi.toFixed(0)} — sobrecompra`);
    }
  }

  // FIX-STRUCTURAL (Jul-2026): multiplier única fuente de verdad, trimPct derivado.
  //   multiplierFromScore con rampas suaves. Semis usa los mismos anclajes genéricos:
  //   topSignals=0.5→0.75, 1→0.65, 2→0.45, 3→0.28.
  //   La suavidad elimina el acantilado donde topSignals=1.99→0.35 y 2.01→0.55.
  const { multiplier, zone, trimPct } = multiplierFromScore(topSignals);

  // Construir valor del indicador para mostrar
  const parts: string[] = [];
  if (isValidReading(soxSpyRelativeStrength, -10, 10)) parts.push(`SOX/SPX Z ${soxSpyRelativeStrength.toFixed(2)}`);
  if (isValidReading(siaSalesYoY, -100)) parts.push(`SIA sales +${siaSalesYoY.toFixed(1)}% YoY`);
  if (soxRsi !== undefined) parts.push(`SOX RSI-W ${soxRsi.toFixed(0)}`);
  const indicatorValue = parts.join(" · ") || "Sin datos";

  return {
    asset: "Semiconductors",
    ticker: "VVSM.DE",
    allocationMultiplier: multiplier,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Ciclo saludable, sin señales de techo",
    indicator: "SOX/SPX RS + SIA Sales YoY + SOX RSI Semanal",
    indicatorValue,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── ORO ──────────────────────────────────────────────────────────
function detectGoldTop(inputs: CycleTopInputs): CycleTopSignal {
  const { bondYield10y, inflationBreakeven, realYield10y, brentOil, dxy, goldCbPurchases } = inputs;
  const hasDirectRealYield = isValidReading(realYield10y, -10, 50);
  const hasFallbackInputs = isValidReading(inflationBreakeven, -10, 50) && isValidReading(bondYield10y, -5, 50);

  if (!hasDirectRealYield && !hasFallbackInputs) {
    return {
      asset: "Gold (ETC)",
      ticker: "PPFB.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin DFII10 ni datos de fallback nominal/breakeven — introduce tipo real 10Y TIPS (DFII10) para activar esta señal",
      indicator: "Tipo Real 10Y TIPS (DFII10) · fallback nominal − BE5Y",
      indicatorValue: "Sin datos tipo real",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  // FIX-GOLD-STRUCTURAL (Jul-2026): multiplier es la ÚNICA fuente de verdad.
  //   trimPct se deriva, nunca se asigna. Elimina el bug donde Brent reducía
  //   trimPct pero no multiplier → motor reducía ×0.45 pero UI decía −20%.
  //   Rampas suaves en realRate y Brent (sin acantilados en $95 o 2.5%).
  //
  //   Con datos actuales (realRate 2.37%, Brent $94):
  //     baseMultiplier = smoothScore(2.37, [[0,1],[0.5,0.7],[1.5,0.45],[2.5,0.2]]) ≈ 0.23
  //     relief = smoothScore(94, [[75,0],[95,0.55]]) ≈ 0.52
  //     multiplier = min(1.0, 0.23+0.52) ≈ 0.75 → CAUTION, trim ~25%
  const realRate = hasDirectRealYield ? realYield10y! : bondYield10y - inflationBreakeven!;

  // Paso 1: base multiplier desde real rate (rampa suave).
  //   Guard: realRate ≤ 0 → 1.0 (tipos reales negativos = favorable para el oro).
  //   smoothScore devuelve 0 para x ≤ primer umbral → sin el guard, realRate=0 daría 0.
  const baseMultiplier = realRate <= 0 ? 1.0 : smoothScore(realRate, [
    [0, 1.0],
    [0.5, 0.70],
    [1.5, 0.45],
    [2.5, 0.20],
  ]);

  // Paso 2: Brent relief — rampa 75→95 (0→0.55 de alivio), cap en 0.55
  //   Prima de guerra: oro y crudo correlacionados en shock geopolítico.
  let relief = 0;
  let reason: string;
  if (realRate < -0.5) {
    reason = `Tipo real ${realRate.toFixed(2)}% — tipos reales negativos. Entorno favorable para el oro.`;
  } else if (brentOil !== undefined && brentOil >= 75) {
    relief = smoothScore(brentOil, [
      [75, 0],
      [95, 0.55],
    ]);
    reason = `Tipo real ${realRate.toFixed(2)}% — presión sobre el oro, mitigada por prima de guerra (Brent $${brentOil.toFixed(0)}, oro y crudo correlacionados en shock geopolítico).`;
  } else if (baseMultiplier < 1.0) {
    reason = `Tipo real ${realRate.toFixed(2)}% — presión clásica sobre el oro (coste de oportunidad vs bonos). Sin mitigante geopolítico.`;
  } else {
    reason = `Tipo real ${realRate.toFixed(2)}% — zona neutral. Sin presión significativa sobre el oro.`;
  }

  // Paso 3: multiplier = base + relief, clamp a [0.05, 1.0]
  let multiplier = Math.max(0.05, Math.min(1.0, baseMultiplier + relief));

  // ── DXY como indicador secundario (Jul 2026) ──────────────────
  //   DXY > 106: dólar fuerte → presión adicional sobre el oro
  //     (encarece el oro en otras divisas, flight-to-USD). ×0.85 al multiplier.
  //   DXY < 95: dólar débil → viento de cola para el oro. +0.10 relief.
  //   Evidencia: BIS, correlación inversa oro-DXY es -0.45 en 20 años.
  if (isValidReading(dxy, 50)) {
    if (dxy > 106) {
      multiplier = Math.max(0.05, multiplier * 0.85);
      reason += ` · DXY ${dxy.toFixed(1)} — dólar fuerte presiona al oro (×0.85 trim)`;
    } else if (dxy < 95) {
      multiplier = Math.min(1.0, multiplier + 0.10);
      reason += ` · DXY ${dxy.toFixed(1)} — dólar débil favorece al oro (+0.10 alivio)`;
    }
  }

  // ── GOLD-CB-SENSOR (Ago 2026, Comité) ──────────────────────────
  //   Compra de bancos centrales como atenuador del trim (NO puntúa).
  //   2022+ rompió la relación "tipo real ↑ → oro ↓": de-dolarización
  //   y compras récord de BC (China, India, Polonia…) sostienen el oro
  //   pese a tipos reales positivos. Si los BC compran récord, el
  //   detector degrada su agresividad (relief hasta +0.20) en vez de
  //   vender a ciegas. Es corroboración, no señal primaria: jamás
  //   convierte un SAFE en techo, solo suaviza un trim existente.
  if (isValidReading(goldCbPurchases, 0) && goldCbPurchases > 500) {
    const cbRelief = smoothScore(goldCbPurchases, [
      [500, 0],
      [800, 0.10],
      [1200, 0.20],
    ]);
    if (cbRelief > 0) {
      multiplier = Math.min(1.0, multiplier + cbRelief);
      reason += ` · Bancos centrales ~${goldCbPurchases.toFixed(0)} t/año (WGC) — de-dolarización: comprador estructural sostiene el oro pese al tipo real (régimen roto 2022+, +${Math.round(cbRelief * 100)} de alivio)`;
    }
  }
  const zone: CycleTopSignal["zone"] =
    multiplier <= 0.30 ? "DANGER" : multiplier < 1.0 ? "CAUTION" : "SAFE";
  const trimPct = Math.round((1 - multiplier) * 100);

  return {
    asset: "Gold (ETC)",
    ticker: "PPFB.DE",
    allocationMultiplier: multiplier,
    zone,
    reason,
    indicator: "Tipo Real 10Y TIPS (DFII10) + Brent + DXY + Bancos Centrales",
    indicatorValue: hasDirectRealYield
      ? `DFII10 ${realRate.toFixed(2)}% tipo real · Brent $${brentOil?.toFixed(0) ?? "—"} · DXY ${dxy?.toFixed(1) ?? "—"} · BC ${goldCbPurchases !== undefined ? goldCbPurchases.toFixed(0) + " t/año" : "—"}`
      : `${bondYield10y.toFixed(2)}% − ${inflationBreakeven!.toFixed(2)}% = ${realRate.toFixed(2)}% tipo real proxy (BE5Y) · Brent $${brentOil?.toFixed(0) ?? "—"} · DXY ${dxy?.toFixed(1) ?? "—"} · BC ${goldCbPurchases !== undefined ? goldCbPurchases.toFixed(0) + " t/año" : "—"}`,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── WLG (Vanguard Global Stock — MSCI World) ─────────────────────
// El MSCI World es el índice de developed markets más amplio.
// Señales de techo:
//   RSI Semanal > 75 → sobrecompra. > 80 → sobrecompra extrema.  //   P/E Forward MSCI World → indicador PRIMARIO (dato real del fondo, URTH vía TradingView).
//   Shiller CAPE S&P 500 → CONFIRMATORIO (+0.5 si confirma sobrevaloración).
//
// FIX-INSTITUTIONAL (Jul-2026): Jerarquía invertida por principios de ingeniería
//   cuantitativa institucional. El dato real del activo (P/E 19.4 de URTH) es
//   más defendible que un proxy de otro índice (CAPE 41.7 del S&P 500). Un hedge
//   fund debe poder explicar cada decisión en 10 segundos: "Vendimos porque el
//   P/E del MSCI World estaba a X" se defiende. "Vendimos porque el CAPE del
//   S&P 500..." no. El CAPE del S&P 500 sobrestima la valoración global por
//   concentración Mag7/tech — sirve como confirmación, no como driver.
//
//   Con datos actuales (P/E Forward ~15 + CAPE 40.5):
//   ANTES (TTM): P/E 19.3 → score 1.23 → CAUTION 40% (sobrestimado por TTM)
//   AHORA (Forward): P/E 15 → score 1.13 → CAUTION ~35% (beneficios creciendo +37.9%)
function detectWLGTop(inputs: CycleTopInputs): CycleTopSignal {
  const { wlgRsiWeekly, wlgPERatio, wlgEpsGrowth, wlgCAPE, regimeShiftPE, creditSpread } = inputs;

  if (!isValidReading(wlgRsiWeekly, 0, 100) && !isValidReading(wlgPERatio) && !isValidReading(wlgCAPE)) {
    return {
      asset: "Vanguard Global Stock",
      ticker: "0P00000WLG.F",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de RSI, P/E ni CAPE — introduce wlgRsiWeekly, wlgPERatio o wlgCAPE para activar esta señal",
      indicator: "RSI Semanal URTH + P/E MSCI World + CAPE",
      indicatorValue: "Sin datos",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  let topSignals = 0;
  const reasons: string[] = [];

  // RSI Semanal — interpolación suave (FIX-SMOOTH-THRESHOLDS)
  // Puntos de anclaje: RSI 75→score 0, RSI 80→1.0, RSI 85→1.5 (cap en 2.0)
  if (isValidReading(wlgRsiWeekly, 0, 100)) {
    const rsiScore = smoothScore(wlgRsiWeekly, [
      [75, 1.0],
      [80, 1.5],
      [85, 2.0],
    ]);
    topSignals += rsiScore;
    if (rsiScore >= 2.0) reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — sobrecompra extrema`);
    else if (rsiScore >= 1.5) reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — sobrecompra severa`);
    else if (rsiScore >= 1.0) reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — sobrecompra`);
    else if (rsiScore > 0) reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — zona elevada`);
  }

  // FIX-INSTITUTIONAL (Jul-2026) + FIX-SMOOTH-THRESHOLDS (Jul-2026):
  //   P/E PRIMARIO. CAPE/S&P 500 P/E DEGRADADO A INFORMATIVO (Jul 2026, Comité).
  //
  //   Tres razones institucionales:
  //   1. Es un PROXY de otro índice (S&P 500), no del MSCI World que poseemos.
  //      "Vendimos WLG porque el P/E del S&P 500 estaba a X" no se defiende.
  //   2. Naming incorrecto: el código decía "CAPE" pero el dato real es
  //      marketData.per = P/E TTM del S&P 500 vía FRED. Los umbrales de CAPE
  //      (27-44) no aplican a P/E TTM (15-25 es el rango normal).
  //   3. El P/E real del MSCI World (wlgPERatio) ya cubre la valoración
  //      del activo que poseemos. Usamos el dato del activo, no un proxy.
  //
  //   Umbrales P/E Forward: [16→1.0, 20→1.5, 23→2.0, 27→2.5] (media institucional ~16, 10-15 años).
  //   Con P/E Forward 15: score = 1.0 + (1.5-1.0)×(15-14)/(18-14) = 1.13.
  let valuationScore = 0;
  const valuationReasons: string[] = [];
  const hasPE = isValidReading(wlgPERatio);
  const hasCAPE = isValidReading(wlgCAPE);

  if (hasPE) {
    // P1-REGIME (Jul 2026): aplicar shift de régimen (EXPANSION +1.5, CRISIS -1.5)
    //   para tolerar más valoración con tipos bajos y castigar con tipos altos.
    //   Recalibrado a Forward P/E (±1.5) desde TTM (±2.0) — rango Forward ~10-25
    //   es más estrecho que TTM ~13-30, mismo impacto relativo (~13%).
    //   El dashboard ya suavizó la transición (rampa en 5 sesiones).
    const peShift = regimeShiftPE ?? 0;
    const effectivePE = wlgPERatio - peShift;
    valuationScore = smoothScore(effectivePE, [
      [16, 1.0],
      [20, 1.5],
      [23, 2.0],
      [27, 2.5],
    ]);
    if (peShift !== 0 && valuationScore > 0) {
      valuationReasons.push(`P/E ajustado por régimen: ${wlgPERatio.toFixed(1)} → ${effectivePE.toFixed(1)} efectivo`);
    }

    // P1.2: CREDIT-SPREAD (Jul 2026, Comité) — amplificador/atenuador de valoración.
    //   El credit spread es el "canario en la mina" del crédito corporativo.
    //   - Spreads estrechos (<1.5%): complacencia → el crédito y las equities
    //     están de acuerdo en que todo va bien. Si el P/E ya está alto, esto
    //     confirma euforia generalizada → ×1.25 al score de valoración.
    //   - Spreads normales (1.5-3.5%): sin ajuste. El crédito no añade información.
    //   - Spreads amplios (>3.5%): el mercado de bonos está en modo pánico.
    //     Señal contrarian para techos de equity: si el crédito ya descuenta
    //     problemas severos, estamos más cerca del suelo que del techo.
    //     → ×0.70 al score de valoración (el miedo contradice la euforia).
    if (valuationScore > 0 && isValidReading(creditSpread)) {
      if (creditSpread < 1.5) {
        valuationScore *= 1.25;
        valuationReasons.push(`Crédito ${creditSpread.toFixed(1)}% — spreads estrechos confirman complacencia (×1.25 valoración)`);
      } else if (creditSpread > 3.5) {
        valuationScore *= 0.70;
        valuationReasons.push(`Crédito ${creditSpread.toFixed(1)}% — estrés en bonos contradice techo de ciclo (×0.70 valoración)`);
      }
    }

    // P1.3: PEG MODIFIER (Jul 2026, Comité) — modular valoración por crecimiento de beneficios.
    //   PEG = P/E Forward ÷ EPS Growth (%). PEG < 1 → crecimiento justifica el múltiplo.
    //   PEG > 2 → crecimiento no justifica el múltiplo (caro aunque crezca).
    //   Impacto limitado a ±30% sobre valuationScore. No usa división directa del P/E
    //   (sería doble contabilidad: el Forward P/E ya incorpora el EPS estimado a 12m).
    //   Sin dato de EPS Growth → sin ajuste (el motor no asume nada).
    if (valuationScore > 0 && isValidReading(wlgEpsGrowth) && isValidReading(wlgPERatio)) {
      const peg = wlgPERatio / Math.max(1, wlgEpsGrowth); // EPS Growth floor 1% para evitar PEG infinito
      if (peg < 0.8) {
        valuationScore *= 0.70;
        valuationReasons.push(`PEG ${peg.toFixed(2)} — crecimiento (${wlgEpsGrowth.toFixed(0)}%) justifica el múltiplo (×0.70 valoración)`);
      } else if (peg >= 0.8 && peg <= 1.2) {
        // PEG razonable — sin ajuste, pero se documenta
        valuationReasons.push(`PEG ${peg.toFixed(2)} — valoración ajustada al crecimiento (sin modificación)`);
      } else if (peg > 2.0) {
        valuationScore *= 1.25;
        valuationReasons.push(`PEG ${peg.toFixed(2)} — crecimiento (${wlgEpsGrowth.toFixed(0)}%) no justifica el múltiplo (×1.25 valoración)`);
      } else if (peg > 1.2) {
        valuationScore *= 1.10;
        valuationReasons.push(`PEG ${peg.toFixed(2)} — múltiplo estirado para el crecimiento (×1.10 valoración)`);
      }
    }

    if (valuationScore >= 2.5) valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — valoración extrema (solo 2000 y 2021)`);
    else if (valuationScore >= 2.0) valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — mercado muy caro`);
    else if (valuationScore >= 1.5) valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — mercado caro`);
    else if (valuationScore >= 1.0) valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — por encima de la media (~16, forward)`);
    else if (valuationScore > 0) valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — ligeramente por encima de la media`);

    // ── CAPE / S&P 500 P/E — INFORMATIVO (Jul 2026, Comité) ──
    //   El dato es P/E TTM del S&P 500 vía FRED, no Shiller CAPE.
    //   Es un proxy de otro índice. Se muestra como contexto,
    //   pero NO modifica el multiplier. Mismo criterio que SIA y P/E EMXC.
    if (hasCAPE) {
      valuationReasons.push(`P/E S&P 500 ${wlgCAPE.toFixed(1)} — contexto: proxy de otro índice (dato informativo, no puntúa)`);
    }
  } else if (hasCAPE) {
    // FALLBACK sin P/E real — usar solo S&P 500 P/E como referencia
    //   (en este caso SÍ puntúa porque no hay dato del activo real)
    valuationScore = smoothScore(wlgCAPE, [
      [14, 1.0],
      [18, 1.5],
      [21, 2.0],
      [25, 2.5],
    ]);  // FALLBACK: usa 14 (P/E S&P 500 TTM, no Forward — media distinta)
    if (valuationScore >= 2.5) valuationReasons.push(`P/E S&P 500 ${wlgCAPE.toFixed(1)} — valoración extrema [fallback: sin P/E MSCI World]`);
    else if (valuationScore >= 2.0) valuationReasons.push(`P/E S&P 500 ${wlgCAPE.toFixed(1)} — mercado muy caro [fallback: sin P/E MSCI World]`);
    else if (valuationScore >= 1.5) valuationReasons.push(`P/E S&P 500 ${wlgCAPE.toFixed(1)} — mercado caro [fallback: sin P/E MSCI World]`);
    else if (valuationScore >= 1.0) valuationReasons.push(`P/E S&P 500 ${wlgCAPE.toFixed(1)} — por encima de la media [fallback: sin P/E MSCI World]`);
    else if (valuationScore > 0) valuationReasons.push(`P/E S&P 500 ${wlgCAPE.toFixed(1)} — ligeramente por encima de la media [fallback: sin P/E MSCI World]`);
  }

  topSignals += valuationScore;
  reasons.push(...valuationReasons);

  // FIX-SMOOTH-THRESHOLDS: interpolación lineal en vez de if/else duros
  const { multiplier, zone, trimPct } = multiplierFromScore(topSignals);

  const parts: string[] = [];
  if (isValidReading(wlgRsiWeekly, 0, 100)) parts.push(`RSI-W ${wlgRsiWeekly.toFixed(0)}`);
  if (isValidReading(wlgCAPE)) parts.push(`P/E S&P 500 ${wlgCAPE.toFixed(1)}`);
  if (isValidReading(wlgPERatio)) parts.push(`P/E ${wlgPERatio.toFixed(1)}`);
  const indicatorValue = parts.join(" · ") || "Sin datos";

  return {
    asset: "Vanguard Global Stock",
    ticker: "0P00000WLG.F",
    allocationMultiplier: multiplier,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "MSCI World en zona saludable — sin señales de techo",
    indicator: "CAPE Shiller + RSI Semanal URTH + P/E MSCI World",
    indicatorValue,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── EMXC (Emerging Markets) ────────────────────────────────────────
// Mercados emergentes son más volátiles que desarrollados y tienen
// rangos de P/E más comprimidos (12-15x media histórica).
//
// Señales de techo:
//   RSI Semanal > 80 → sobrecompra. > 85 → extrema.
//   P/E > 20 → Emergentes caros (solo en 2010-11 post-estímulos). > 25 → peligro.
//   DXY > 106 → dólar fuerte presiona EM. > 110 → crisis en EM (BIS research).
//
// DXY (índice del dólar USA) es el #1 factor de riesgo para emergentes según
// el Bank for International Settlements (BIS). Un dólar fuerte:
//   1. Encarece el servicio de deuda en USD para países EM
//   2. Provoca salida de capitales (flight-to-safety hacia USA)
//   3. Comprime los márgenes de exportadores EM (commodities nominados en USD)
// El DXY tiene peso 1.5× sobre P/E porque es más predictivo en ciclos EM.
function detectEMXCTop(inputs: CycleTopInputs): CycleTopSignal {
  const { emxcRsiWeekly, emxcPERatio, dxy } = inputs;
  const emxcRsi = clampRSI(emxcRsiWeekly); // FIX-RSI-CLAMP: [0,100]

  if (emxcRsi === undefined && !isValidReading(emxcPERatio) && !isValidReading(dxy, 50)) {
    return {
      asset: "Emerging Markets",
      ticker: "EMXC.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de RSI, P/E ni DXY — introduce emxcRsiWeekly, emxcPERatio o dxy para activar esta señal",
      indicator: "RSI Semanal EEM + P/E Emergentes + DXY",
      indicatorValue: "Sin datos",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  let topSignals = 0;
  const reasons: string[] = [];

  // DXY — indicador PRIMARIO para EM (peso 1.5×)
  // Justificación: BIS Quarterly Review 2023 confirma que el 60% de las crisis EM
  // estuvieron precedidas por una apreciación del DXY >10% en 12 meses.
  // DXY > 110 desencadena automáticamente salida de capitales de EM.
  //
  // FIX-AUDIT-MC (Jul-2026): guarda sanitario dxy > 50.
  //   Si Yahoo falla (dxy = 0), el valor 0 entra como dato válido pero no dispara
  //   ningún umbral (0 > 103 = false). El sistema reporta "EM en zona segura" con
  //   DXY 0.0 — un valor imposible (mínimo histórico ~70) que induce a error.
  //   Con isValidReading(dxy, 50) garantizamos que solo procesamos valores realistas
  //   y que un NaN de FRED/Yahoo no pase como "datos válidos".
  if (isValidReading(dxy, 50)) {
    if (dxy > 115) {
      topSignals += 3;
      reasons.push(`DXY ${dxy.toFixed(1)} — dólar en niveles de crisis EM (México 1994, Asia 1997, Argentina 2018)`);
    } else if (dxy > 110) {
      topSignals += 2.5;
      reasons.push(`DXY ${dxy.toFixed(1)} — dólar extremadamente fuerte. Capital huyendo de emergentes.`);
    } else if (dxy > 106) {
      topSignals += 1.5;
      reasons.push(`DXY ${dxy.toFixed(1)} — dólar fuerte. Presión significativa sobre emergentes y commodities.`);
    } else if (dxy > 103) {
      topSignals += 0.75;
      reasons.push(`DXY ${dxy.toFixed(1)} — dólar apreciándose. Vigilar flujos EM.`);
    }
  }

  // Evaluar RSI semanal (umbrales más altos porque EM es más volátil) — clamp [0,100]
  if (emxcRsi !== undefined) {
    if (emxcRsi > 85) {
      topSignals += 2;
      reasons.push(`RSI semanal EEM ${emxcRsi.toFixed(0)} — sobrecompra extrema en emergentes`);
    } else if (emxcRsi > 80) {
      topSignals += 1;
      reasons.push(`RSI semanal EEM ${emxcRsi.toFixed(0)} — sobrecompra en emergentes`);
    } else if (emxcRsi > 75) {
      topSignals += 0.5;
      reasons.push(`RSI semanal EEM ${emxcRsi.toFixed(0)} — zona de vigilancia`);
    }
  }

  // P/E del MSCI Emerging Markets — ELIMINADO del scoring de techo (Jul 2026, Comité).
  //   Motivo: no puntúa (era informativo), no mueve el multiplier.
  //   Los únicos triggers accionables son DXY (primario, BIS-documented) y RSI-W (momentum).
  //   El P/E sigue puntuando en detectEMXCBottom (suelos) donde los múltiplos bajos
  //   sí generan señales de acumulación. Permanece en indicatorValue como display.

  // FIX-STRUCTURAL (Jul-2026): multiplier única fuente de verdad, trimPct derivado.
  //   multiplierFromScore con rampas suaves. EMXC mapea casi exacto a los anclajes genéricos:
  //   topSignals=0.5→0.75, 1.5→0.55, 2.5→0.35, 3.5→0.20, 5.0→0.10 (idénticos a los antiguos).
  const { multiplier, zone, trimPct } = multiplierFromScore(topSignals);

  const parts: string[] = [];
  if (isValidReading(dxy, 50)) parts.push(`DXY ${dxy.toFixed(1)}`);
  if (emxcRsi !== undefined) parts.push(`RSI-W ${emxcRsi.toFixed(0)}`);
  if (isValidReading(emxcPERatio)) parts.push(`P/E ${emxcPERatio.toFixed(1)}`);
  const indicatorValue = parts.join(" · ") || "Sin datos";

  return {
    asset: "Emerging Markets",
    ticker: "EMXC.DE",
    allocationMultiplier: multiplier,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Emergentes en zona saludable — sin señales de techo",
    indicator: "DXY + RSI Semanal EEM + P/E Emergentes",
    indicatorValue,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── XNAS (NASDAQ 100) — ELIMINADO (redundante con WLG) ──────────
// La detección de techo del NASDAQ 100 ya está cubierta por WLG (MSCI World)
// que contiene todas las empresas del NASDAQ 100. VVSM cubre el tilt semis.

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────
export function detectCycleTops(inputs: CycleTopInputs): CycleTopOutput {
  const signals: CycleTopSignal[] = [
    detectBTCTop(inputs),
    detectUraniumTop(inputs),
    detectSemisTop(inputs),
    detectGoldTop(inputs),
    detectWLGTop(inputs),
    detectEMXCTop(inputs),
  ].map(s => ({
    ...s,
    // FIX-CENTRAL-CLAMP (Jul-2026): garantía centralizada del contrato
    //   allocationMultiplier ∈ [0, 1]. Si algún detector individual se
    //   equivoca (como ocurrió con uranio: 1.40 y 1.20), este clamp lo
    //   corrige sin depender de la disciplina de cada función interna.
    allocationMultiplier: Math.max(0, Math.min(1, s.allocationMultiplier)),
  }));

  return {
    signals,
    hasActiveWarnings: signals.some(s => s.zone !== "SAFE"),
    hasTrimSuggestions: signals.some(s => s.shouldTrim),
  };
}

// Helper: calcula si la dominancia de BTC está cayendo desde niveles altos
// Necesita dos lecturas consecutivas del dashboard
export function isBTCDominanceFalling(current: number, previous?: number): boolean {
  if (previous === undefined) return false;
  return previous > 58 && current < previous - 1.5; // caída de >1.5pp desde nivel alto
}

// ── P1: REGIME-CONDITIONED VALUATION SHIFT (Jul 2026, Comité) ──
//   Calcula el shift base para un tipo de valoración según el régimen.
//   NO aplica rampa temporal — esa responsabilidad es del dashboard
//   (interpola oldShift → newShift en 5 sesiones y pasa el resultado
//   como regimeShiftPE/regimeShiftBTC en CycleTopInputs).
//
//   TS: parámetro obligatorio 'type' precede al opcional 'regime'
//   (corrección del bug donde el opcional precedía al obligatorio).
//
//   EXPANSION:   tipos bajos, liquidez abundante → tolerar múltiplos más altos
//   CONTRACTION: baseline, sin ajuste
//   CRISIS:      tipos altos, liquidez escasa → castigar múltiplos más rápido
//
//   CALIBRACIÓN FORWARD P/E (Jul 2026): shift ±1.5 para equity (rango Forward
//   ~10-25, más estrecho que TTM ~13-30). ±2.0 era para TTM y resultaba
//   proporcionalmente ~40% más agresivo con Forward. ±1.5 preserva el mismo
//   impacto relativo (~13% del rango de valoración).
export function regimeValuationShift(type: 'equity' | 'btc', regime?: string): number {
  if (!regime || regime === 'CONTRACTION') return 0;
  if (regime === 'EXPANSION') return type === 'equity' ? 1.5 : 1.0;
  if (regime === 'CRISIS')     return type === 'equity' ? -1.5 : -1.0;
  return 0;
}

// ===============================================
// CYCLE BOTTOM DETECTION — Suelos de ciclo por activo
// ===============================================
// Extensión simétrica a Cycle Top: detecta activos infravalorados u
// oversold. Reutiliza los mismos indicadores del CycleTopInputs,
// invertidos. Misma arquitectura: una función por activo → agregador.
//
// Output: opportunityScore 0-100 + attackMultiplier para Smart DCA.
//   NEUTRAL     (0-39):  sin oportunidad especial — DCA normal
//   VALUE       (40-59): oportunidad moderada — DCA ×1.25
//   OPPORTUNITY (60-79): oportunidad fuerte — DCA ×1.5
//   EXTREME     (80-100): suelo histórico — DCA ×2.0 (ataque)
// ===============================================

export interface CycleBottomSignal {
  asset: string;
  ticker: string;
  opportunityScore: number;     // 0-100, mayor = mejor oportunidad
  zone: "NEUTRAL" | "VALUE" | "OPPORTUNITY" | "EXTREME";
  reason: string;
  indicator: string;
  indicatorValue: string;
  shouldAccumulate: boolean;     // true si hay que comprar más de lo normal
  attackMultiplier: number;      // 1.0 = normal, 1.25 = +25%, 1.5 = +50%, 2.0 = doble
}

export interface CycleBottomOutput {
  signals: CycleBottomSignal[];
  hasActiveOpportunities: boolean;
  maxOpportunityScore: number;
  topOpportunity: CycleBottomSignal | null;
}

// ── Helpers compartidos para bottom detection ────────────────────

function scoreToZone(score: number): CycleBottomSignal["zone"] {
  if (score >= 80) return "EXTREME";
  if (score >= 60) return "OPPORTUNITY";
  if (score >= 40) return "VALUE";
  return "NEUTRAL";
}

function attackMultiplierForScore(score: number): number {
  if (score >= 80) return 2.0;
  if (score >= 60) return 1.50;
  if (score >= 40) return 1.25;
  return 1.0;
}

// ── Helpers para Capa Táctica Diaria (TACTICAL-DAILY Jul 2026) ──
//   Computan indicadores de corto plazo desde arrays de precios diarios.
//   Capturan pánico intradía invisible para los detectores semanales.

/** RSI(14) diario — Wilder smoothing */
function computeDailyRSI(history: number[]): number | undefined {
  if (!history || history.length < 15) return undefined;
  const n = history.length;
  let gains = 0, losses = 0;
  for (let i = n - 14; i < n; i++) {
    const change = history[i] - history[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/** Z-score vs MA50 — (precio - MA50) / σ50 */
function computeZScoreMA50(history: number[]): number | undefined {
  if (!history || history.length < 50) return undefined;
  const n = history.length;
  const window = history.slice(n - 50);
  const ma50 = window.reduce((s, p) => s + p, 0) / 50;
  const variance = window.reduce((s, p) => s + (p - ma50) ** 2, 0) / 50;
  const std50 = Math.sqrt(variance);
  if (std50 === 0) return 0;
  return (history[n - 1] - ma50) / std50;
}

/** Retorno diario (1 día) */
function computeDailyReturn(history: number[]): number | undefined {
  if (!history || history.length < 2) return undefined;
  const n = history.length;
  return (history[n - 1] - history[n - 2]) / history[n - 2];
}

/** Aplica capa táctica diaria a un score de bottom detection.
 *  ADDITIVE-ONLY: solo puede subir el score, nunca bajarlo.
 *  Guard de régimen: si regime=CRISIS, no se aplica (pánico = más pánico).
 *  Retorna { score, reasons } para que el caller los añada.
 *
 *  FIX-SMOOTH-TACTICAL (Jul-2026): interpolación continua vía smoothScore.
 *    Reemplaza los if/else duros por rampas lineales, eliminando el cliff
 *    donde RSI 24.99→+10 y RSI 25.01→+0. Mismo tratamiento que
 *    detectGoldTop y detectWLGTop (commits 5f63b7c, 8259a9b).
 *
 *    RSI:     mapeado como smoothScore(100-RSI, ...). RSI bajo = más puntos.
 *    Z-score: mapeado como smoothScore(-Z, ...). Z muy negativo = más puntos.
 *    Ambos con interpolación lineal entre los umbrales originales. */
export function applyTacticalDaily(
  structuralScore: number,
  history: number[] | undefined,
  regime: string | undefined,
  assetName: string,
  rsiThresholds: [number, number][],   // [RSI_max, points] — RSI más bajo = más puntos
  zScoreThresholds: [number, number][], // [Z_min, points] — Z más negativo = más puntos
  currentPrice?: number,               // INTRADAY-FIX: near-real-time price (Yahoo, ~15min delay)
): { score: number; reasons: string[] } {
  if (regime === "CRISIS" || regime === "ALL_CASH") return { score: structuralScore, reasons: [] };
  if (!history || history.length < 50) return { score: structuralScore, reasons: [] };

  // INTRADAY-FIX (Jul-2026): inyectar currentPrice como último elemento para
  //   capturar caídas intradía. Ej: VVSM -8% a las 14:00 → RSI y Z-score lo ven.
  //   Sin esto, el array de EOD closes está desactualizado hasta el cierre.
  //   Guard: solo se inyecta si currentPrice es razonable (dentro del ±40% del
  //   último cierre para filtrar datos corruptos de Yahoo).
  let effectiveHistory = history;
  if (currentPrice !== undefined && Number.isFinite(currentPrice) && currentPrice > 0) {
    const lastClose = history[history.length - 1];
    if (lastClose > 0) {
      const pctChange = Math.abs((currentPrice - lastClose) / lastClose);
      if (pctChange < 0.40) { // sanity check: no más de ±40% del último cierre
        effectiveHistory = [...history, currentPrice];
      }
    }
  }

  let tacticalScore = 0;
  const tacticalReasons: string[] = [];

  const rsi = computeDailyRSI(effectiveHistory);
  const zScore = computeZScoreMA50(effectiveHistory);

  // RSI diario — smoothScore: RSI bajo = oversold = oportunidad.
  //   Convertimos RSI a escala 100-RSI (crece con la oportunidad).
  //   Ej: rsiThresholds [[20,15],[30,10],[40,5]] → mapeado [[50,0],[60,5],[70,10],[80,15]].
  //   RSI 25 → 100-25=75 → smoothScore(75) = 10 + (15-10)*(75-70)/(80-70) = 12.5
  if (rsi !== undefined) {
    const mapped: [number, number][] = [[50, 0]];
    for (const [t, p] of rsiThresholds) mapped.push([100 - t, p]);
    const pts = smoothScore(100 - rsi, mapped);
    if (pts > 0) {
      tacticalScore += pts;
      tacticalReasons.push(`RSI diario ${rsi.toFixed(0)} — oversold táctico (${assetName})`);
    }
  }

  // Z-score MA50 — smoothScore: Z muy negativo = pánico = oportunidad.
  //   Convertimos Z a escala -Z (crece con la oportunidad).
  //   Ej: zScoreThresholds [[-2.5,15],[-2.0,10],[-1.5,5]] → mapeado [[1.0,0],[1.5,5],[2.0,10],[2.5,15]].
  //   Z -2.25 → 2.25 → smoothScore(2.25) = 10 + (15-10)*(2.25-2.0)/(2.5-2.0) = 12.5
  if (zScore !== undefined) {
    const mapped: [number, number][] = [[1.0, 0]];
    for (const [t, p] of zScoreThresholds) mapped.push([-t, p]);
    const pts = smoothScore(-zScore, mapped);
    if (pts > 0) {
      tacticalScore += pts;
      tacticalReasons.push(`Z-score MA50 ${zScore.toFixed(2)} — pánico táctico (${assetName})`);
    }
  }

  return {
    score: structuralScore + tacticalScore,
    reasons: tacticalReasons,
  };
}

// ── BTC Bottom ───────────────────────────────────────────────────
// Invierte la lógica de detectBTCTop:
//   MVRV > 3.5 = techo  →  MVRV < 1.5 = suelo
//   RSI-W > 80 = techo  →  RSI-W < 30 = suelo
function detectBTCBottom(inputs: CycleTopInputs): CycleBottomSignal {
  const { mvrvRatio, mvrvZScore, btcRsiWeekly, puellMultiple, priceHistories, currentPrices, regime } = inputs;

  let score = 0;
  const reasons: string[] = [];

  // MVRV — invertido: bajo = infravalorado
  // CALIBRACIÓN: MVRV<1.5 + RSI<30 + Puell<0.5 debe alcanzar EXTREME (≥80).
  //   Históricamente: solo marzo 2020 (COVID) y nov 2022 (FTX).
  //
  // FIX-UNIFY-ZSCORE-BOTTOM (23-Jul-2026): mvrvZScore PRIMARIO con fallback a ratio.
  //   Fronteras Z alineadas con btcCycleOverlay.ts scoreMvrv (-1/0/1).
  //   Scores distintos (45/30/18 vs 35/32/25) porque son sistemas de puntuación diferentes.
  //   Antes: ignoraba mvrvZScore → bottom detector y motor usaban métricas distintas.
  if (isValidReading(mvrvZScore)) {
    // Z-Score path — umbrales equivalentes a los del ratio:
    //   Z<-1.0 (~ratio<1.5) → 45, Z<0 (~ratio<2.0) → 30, Z<1.0 (~ratio<2.5) → 18
    if (mvrvZScore < -1.0)     { score += 45; reasons.push(`MVRV Z ${mvrvZScore.toFixed(2)} — capitulación extrema (solo suelos históricos)`); }
    else if (mvrvZScore < 0)   { score += 30; reasons.push(`MVRV Z ${mvrvZScore.toFixed(2)} — infravalorado (bajo la media histórica)`); }
    else if (mvrvZScore < 1.0) { score += 18; reasons.push(`MVRV Z ${mvrvZScore.toFixed(2)} — zona de acumulación`); }
  } else if (isValidReading(mvrvRatio)) {
    if (mvrvRatio < 1.5)   { score += 45; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — infravaloración extrema (suelo de ciclo)`); }
    else if (mvrvRatio < 2.0)  { score += 30; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — zona de acumulación`); }
    else if (mvrvRatio < 2.5)  { score += 18; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — ligeramente infravalorado`); }
  }

  // Puell Multiple — INVERTIDO: bajo = capitulación minera (suelo de ciclo)
  //   Puell < 0.5 = capitulación extrema (solo 2015, 2019, 2022 = suelos históricos).
  //   Puell < 1.0 = zona de valor. Mineros con rentabilidad baja = acumulación inteligente.
  //   La confluencia MVRV<1.5 + Puell<0.5 es el gold standard de suelo de ciclo.
  if (isValidReading(puellMultiple)) {
    if (puellMultiple < 0.5)       { score += 25; reasons.push(`Puell ${puellMultiple.toFixed(2)} — capitulación minera extrema (solo 2015, 2019, 2022 = suelos históricos)`); }
    else if (puellMultiple < 1.0)  { score += 15; reasons.push(`Puell ${puellMultiple.toFixed(2)} — zona de valor. Mineros con rentabilidad baja.`); }
  }

  // RSI semanal — invertido: bajo = oversold
  if (isValidReading(btcRsiWeekly, 0, 100)) {
    if (btcRsiWeekly < 30)        { score += 35; reasons.push(`RSI semanal ${btcRsiWeekly.toFixed(0)} — oversold extremo`); }
    else if (btcRsiWeekly < 40)   { score += 20; reasons.push(`RSI semanal ${btcRsiWeekly.toFixed(0)} — oversold`); }
    else if (btcRsiWeekly < 45)   { score += 10; reasons.push(`RSI semanal ${btcRsiWeekly.toFixed(0)} — zona baja`); }
  }

  // ── Capa Táctica Diaria (BTC) ──────────────────────────────────
  //   Max +20 pts (+12 RSI +8 Z). BTC es el activo más volátil del universo
  //   (3-5% diario normal, σ~40% anual). Umbrales estrechos para evitar falsos
  //   positivos en su ruido diario intrínseco. La señal de suelo la da MVRV/Puell,
  //   la capa táctica solo añade precisión de timing.
  const btcTactical = applyTacticalDaily(
    score, priceHistories?.["BTC-EUR"], regime, "BTC",
    [[25, 12], [35, 8], [45, 4]],      // RSI: <25→+12, <35→+8, <45→+4
    [[-2.5, 8], [-1.5, 5], [-0.5, 3]], // Z: <-2.5→+8, <-1.5→+5, <-0.5→+3
    currentPrices?.["BTC-EUR"],         // INTRADAY-FIX: precio near-real-time
  );
  score = btcTactical.score;
  reasons.push(...btcTactical.reasons);

  const zone = scoreToZone(score);
  const parts: string[] = [];
  if (isValidReading(mvrvZScore)) parts.push(`MVRV Z ${mvrvZScore.toFixed(2)}`);
  else if (isValidReading(mvrvRatio)) parts.push(`MVRV ${mvrvRatio.toFixed(2)}`);
  if (isValidReading(puellMultiple)) parts.push(`Puell ${puellMultiple.toFixed(2)}`);
  if (isValidReading(btcRsiWeekly, 0, 100)) parts.push(`RSI-W ${btcRsiWeekly.toFixed(0)}`);
  const indicatorValue = parts.join(" · ") || "Sin datos on-chain";

  return {
    asset: "Bitcoin",
    ticker: "BTC-EUR",
    opportunityScore: score,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "BTC en zona neutra — sin señal de suelo de ciclo",
    indicator: "MVRV + Puell + RSI Semanal + Táctico Diario",
    indicatorValue,
    shouldAccumulate: score >= 40,
    attackMultiplier: attackMultiplierForScore(score),
  };
}

// ── Uranio Bottom ────────────────────────────────────────────────
// Invierte la lógica de detectUraniumTop:
//   Spot/LT > 1.20 = techo  →  Spot/LT < 0.70 = suelo
// El top detector ya reconoce ratios <0.85 como "ventana de acumulación"
// y <0.70 como "acumulación agresiva". Aquí lo convertimos en score.
function detectUraniumBottom(inputs: CycleTopInputs): CycleBottomSignal {
  const { uraniumSpotPrice, uraniumLTPrice, priceHistories, currentPrices, regime } = inputs;

  if (!isValidReading(uraniumSpotPrice) || !isValidReading(uraniumLTPrice) || uraniumLTPrice === 0) {
    return {
      asset: "Uranium",
      ticker: "URNU.DE",
      opportunityScore: 0,
      zone: "NEUTRAL",
      reason: "Sin datos de precio spot/LT — introduce uraniumSpot y uraniumLT para activar detección de suelo",
      indicator: "Spot/LT Ratio",
      indicatorValue: "Sin datos",
      shouldAccumulate: false,
      attackMultiplier: 1.0,
    };
  }

  const ratio = uraniumSpotPrice / uraniumLTPrice;
  let score = 0;
  let reason: string;

  if (ratio < 0.70) {
    score = 70;
    reason = `Spot/LT ${ratio.toFixed(2)} — descuento profundo. Spot muy por debajo del LT: utilities pagan fuerte prima por suministro futuro. Señal de acumulación agresiva (raro: solo 2016 y 2020).`;
  } else if (ratio < 0.85) {
    score = 45;
    reason = `Spot/LT ${ratio.toFixed(2)} — spot barato vs contratos a largo plazo. Contango saludable: el mercado anticipa tightening futuro. Ventana de acumulación.`;
  } else if (ratio < 1.0) {
    score = 20;
    reason = `Spot/LT ${ratio.toFixed(2)} — spot ligeramente por debajo del LT. Valor razonable, sin prima especulativa.`;
  } else {
    score = 0;
    reason = `Spot/LT ${ratio.toFixed(2)} — spot en prima o equilibrio. Sin señal de suelo.`;
  }

  // ── Capa Táctica Diaria (Uranio) ──────────────────────────────
  //   Max +30 pts (+15 RSI +15 Z). URNU tiene σ~35% anual y gaps frecuentes
  //   de -5/-8% en un día (mercado físico ilíquido). Umbrales amplios para
  //   capturar pánico real, no ruido. Es el activo más extremo del universo
  //   junto con Semis: caídas del -10% en 48h no son raras.
  const t_uran = applyTacticalDaily(
    score, priceHistories?.["URNU.DE"], regime, "Uranio",
    [[20, 15], [30, 10], [40, 5]],
    [[-2.5, 15], [-2.0, 10], [-1.5, 5]],
    currentPrices?.["URNU.DE"],
  );
  score = t_uran.score;
  if (t_uran.reasons.length > 0) reason = reason ? reason + " · " + t_uran.reasons.join(" · ") : t_uran.reasons.join(" · ");

  // ── Momentum 3m como indicador secundario (Jul 2026) ──────────
  //   URNU -30% en 3 meses = capitulación en el equity de mineras.
  //   El Spot/LT mide el mercado físico, el momentum mide el sentimiento.
  //   Ambos alineados (spot barato + equity castigado) = suelo de ciclo.
  const urnuPrices = priceHistories?.['URNU.DE'];
  if (urnuPrices && urnuPrices.length >= 63) {
    const ret3m = (urnuPrices[urnuPrices.length - 1] / urnuPrices[urnuPrices.length - 63] - 1);
    if (ret3m < -0.40) {
      score += 12;
      reason = (reason ? reason + ' · ' : '') + `URNU ${(ret3m*100).toFixed(0)}% en 3 meses — capitulación en el equity de mineras de uranio.`;
    } else if (ret3m < -0.30) {
      score += 8;
      reason = (reason ? reason + ' · ' : '') + `URNU ${(ret3m*100).toFixed(0)}% en 3 meses — castigo significativo.`;
    }
  }

const zone = scoreToZone(score);

  return {
    asset: "Uranium",
    ticker: "URNU.DE",
    opportunityScore: score,
    zone,
    reason,
    indicator: "Uranium Spot/LT Ratio",
    indicatorValue: `Spot $${uraniumSpotPrice}/lb · LT $${uraniumLTPrice}/lb → ratio ${ratio.toFixed(2)}`,
    shouldAccumulate: score >= 40,
    attackMultiplier: attackMultiplierForScore(score),
  };
}

// ── Semis Bottom ─────────────────────────────────────────────────
// Invierte la lógica de detectSemisTop:
//   SIA Sales > 25% + SOX RSI > 80 = techo
//   SOX RSI < 35 + SIA Sales < 0% = suelo (recession pricing)
function detectSemisBottom(inputs: CycleTopInputs): CycleBottomSignal {
  const { siaSalesYoY, soxRsiWeekly, priceHistories, currentPrices, regime } = inputs;

  if (!isValidReading(siaSalesYoY, -100) && !isValidReading(soxRsiWeekly, 0, 100)) {
    return {
      asset: "Semiconductors",
      ticker: "VVSM.DE",
      opportunityScore: 0,
      zone: "NEUTRAL",
      reason: "Sin datos de ventas SIA ni RSI del SOX — introduce ambos para activar detección de suelo",
      indicator: "SIA Sales YoY + SOX RSI Semanal",
      indicatorValue: "Sin datos",
      shouldAccumulate: false,
      attackMultiplier: 1.0,
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // SOX RSI — invertido: bajo = oversold
  if (isValidReading(soxRsiWeekly, 0, 100)) {
    if (soxRsiWeekly < 30)        { score += 35; reasons.push(`SOX RSI semanal ${soxRsiWeekly.toFixed(0)} — oversold extremo (pánico)`); }
    else if (soxRsiWeekly < 40)   { score += 20; reasons.push(`SOX RSI semanal ${soxRsiWeekly.toFixed(0)} — oversold`); }
    else if (soxRsiWeekly < 50)   { score += 8;  reasons.push(`SOX RSI semanal ${soxRsiWeekly.toFixed(0)} — zona baja`); }
  }

  // SIA Sales — invertido: crecimiento negativo = recession pricing
  if (isValidReading(siaSalesYoY, -100)) {
    if (siaSalesYoY < -10)        { score += 25; reasons.push(`Ventas SIA ${siaSalesYoY.toFixed(1)}% YoY — contracción severa (recession pricing)`); }
    else if (siaSalesYoY < 0)     { score += 15; reasons.push(`Ventas SIA ${siaSalesYoY.toFixed(1)}% YoY — contracción. Las caídas de semis preceden recuperaciones explosivas.`); }
    else if (siaSalesYoY < 10)    { score += 5;  reasons.push(`Ventas SIA +${siaSalesYoY.toFixed(1)}% YoY — crecimiento modesto, no es techo`); }
  }

  // ── Capa Táctica Diaria (Semis) ───────────────────────────────
  //   Max +30 pts (+15 RSI +15 Z). VVSM tiene σ~40% anual, el más volátil
  //   del universo equity. Gaps de -8% en el día son frecuentes en correcciones
  //   del SOX. Umbrales amplios para no perderse liquidaciones intradía.
  const t_semi = applyTacticalDaily(
    score, priceHistories?.["VVSM.DE"], regime, "Semis",
    [[20, 15], [30, 10], [40, 5]],
    [[-2.5, 15], [-2.0, 10], [-1.5, 5]],
    currentPrices?.["VVSM.DE"],
  );
  score = t_semi.score;
  reasons.push(...t_semi.reasons);

const zone = scoreToZone(score);
  const parts: string[] = [];
  if (isValidReading(siaSalesYoY, -100)) parts.push(`SIA sales ${siaSalesYoY > 0 ? "+" : ""}${siaSalesYoY.toFixed(1)}% YoY`);
  if (isValidReading(soxRsiWeekly, 0, 100)) parts.push(`SOX RSI-W ${soxRsiWeekly.toFixed(0)}`);

  return {
    asset: "Semiconductors",
    ticker: "VVSM.DE",
    opportunityScore: score,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Semis en zona neutra — sin señal de suelo de ciclo",
    indicator: "SOX RSI Semanal + SIA Sales YoY",
    indicatorValue: parts.join(" · ") || "Sin datos",
    shouldAccumulate: score >= 40,
    attackMultiplier: attackMultiplierForScore(score),
  };
}

// ── Oro Bottom ───────────────────────────────────────────────────
// Invierte la lógica de detectGoldTop:
//   Tipo real > 0.5% = presión (techo)  →  Tipo real > 2.0% = sobrecastigado (suelo)
//   Brent alto protege al oro en ambos casos.
function detectGoldBottom(inputs: CycleTopInputs): CycleBottomSignal {
  const { bondYield10y, inflationBreakeven, brentOil, dxy, priceHistories, currentPrices, regime } = inputs;

  if (!isValidReading(inflationBreakeven, -10, 50) || !isValidReading(bondYield10y, -5, 50)) {
    return {
      asset: "Gold (ETC)",
      ticker: "PPFB.DE",
      opportunityScore: 0,
      zone: "NEUTRAL",
      reason: "Sin datos de inflación implícita o bono 10y — introduce T5YIE y US10Y para activar detección de suelo",
      indicator: "Tipo Real (bono 10y − breakeven 5y)",
      indicatorValue: "Sin datos tipo real",
      shouldAccumulate: false,
      attackMultiplier: 1.0,
    };
  }

  const realRate = bondYield10y - inflationBreakeven;
  let score = 0;
  const reasons: string[] = [];

  // Tipo real MUY alto = oro está sobrecastigado (coste de oportunidad extremo ya priced in)
  // La lógica: si el tipo real está forzando ventas masivas de oro, el precio ya lo descuenta.
  // Un tipo real > 2.5% es históricamente insostenible y precede rallies de oro.
  // CALIBRACIÓN: realRate>2.5% + Brent>95 debe alcanzar OPPORTUNITY (≥60).
  //   El oro tiene menos indicadores → max teórico ~70 (OPPORTUNITY, no EXTREME).
  //   Documentado: las puntuaciones no son comparables entre activos.
  if (realRate > 2.5) {
    score += 45;
    reasons.push(`Tipo real ${realRate.toFixed(2)}% — oro sobrecastigado. Tipos reales >2.5% son históricamente insostenibles y han precedido rallies fuertes del oro.`);
  } else if (realRate > 2.0) {
    score += 25;
    reasons.push(`Tipo real ${realRate.toFixed(2)}% — presión extrema sobre el oro. El mercado ya descuenta el coste de oportunidad.`);
  } else if (realRate > 1.5) {
    score += 12;
    reasons.push(`Tipo real ${realRate.toFixed(2)}% — presión elevada. Potencial suelo si la Fed se acerca al final del ciclo.`);
  } else if (realRate < -0.5) {
    // Tipos reales negativos = oro barato en términos reales
    score += 15;
    reasons.push(`Tipo real ${realRate.toFixed(2)}% — tipos reales negativos. El oro protege el poder adquisitivo.`);
  }

  // Brent: petróleo alto → inflación → el oro sirve como cobertura
  if (isValidReading(brentOil, 0, 300)) {
    if (brentOil > 95) {
      score += 25;
      reasons.push(`Brent $${brentOil.toFixed(0)} — crisis energética. El oro es el activo refugio clásico en shocks de oferta.`);
    } else if (brentOil > 75) {
      score += 8;
      reasons.push(`Brent $${brentOil.toFixed(0)} — tensión geopolítica moderada`);
    }
  }

  // ── Capa Táctica Diaria (Oro) ─────────────────────────────────
  //   Max +30 pts (+15 RSI +15 Z). PPFB es defensivo (σ~15% anual) pero sensible
  //   a shocks de tipo real y Brent. Umbrales MUY estrictos (RSI<15, Z<-3.0):
  //   solo disparamos en pánico genuino, no en correcciones normales del -2%.
  //   El oro no debería tener falsos positivos tácticos — su señal real es el
  //   tipo real estructural, no el precio diario.

  // ── DXY como indicador secundario (Jul 2026) ──────────────────
  //   DXY > 106: dólar extremadamente fuerte → el oro está sobrecastigado
  //     por el flight-to-USD. Históricamente, DXY > 110 precede rallies de oro.
  //   DXY < 95: dólar débil → sin presión adicional (el oro ya debería estar bien).
  if (isValidReading(dxy, 50)) {
    if (dxy > 106) {
      score += 15;
      reasons.push(`DXY ${dxy.toFixed(1)} — dólar en niveles de estrés. Históricamente, DXY extremo precede rallies de oro (flight-to-USD se revierte).`);
    }
  }

  const t_oro = applyTacticalDaily(
    score, priceHistories?.["PPFB.DE"], regime, "Oro",
    [[15, 15], [25, 10], [35, 5]],
    [[-3.0, 15], [-2.5, 10], [-2.0, 5]],
    currentPrices?.["PPFB.DE"],
  );
  score = t_oro.score;
  reasons.push(...t_oro.reasons);

const zone = scoreToZone(score);

  return {
    asset: "Gold (ETC)",
    ticker: "PPFB.DE",
    opportunityScore: score,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Oro en zona neutra — sin señal de suelo de ciclo",
    indicator: "Tipo Real + Brent Crude Oil + DXY",
    indicatorValue: `${bondYield10y.toFixed(2)}% − ${inflationBreakeven.toFixed(2)}% = ${realRate.toFixed(2)}% tipo real · Brent $${brentOil?.toFixed(0) ?? "—"} · DXY ${dxy?.toFixed(1) ?? "—"}`,
    shouldAccumulate: score >= 40,
    attackMultiplier: attackMultiplierForScore(score),
  };
}

// ── WLG Bottom ───────────────────────────────────────────────────
// Invierte la lógica de detectWLGTop:
//   P/E > 19 + CAPE > 30 + RSI > 75 = techo
//   P/E < 14 + CAPE < 20 + RSI < 35 = suelo
// Misma jerarquía institucional: P/E primario, CAPE confirmatorio.
function detectWLGBottom(inputs: CycleTopInputs): CycleBottomSignal {
  const { wlgRsiWeekly, wlgPERatio, wlgCAPE, priceHistories, currentPrices, regime } = inputs;

  if (!isValidReading(wlgRsiWeekly, 0, 100) && !isValidReading(wlgPERatio) && !isValidReading(wlgCAPE)) {
    return {
      asset: "Vanguard Global Stock",
      ticker: "0P00000WLG.F",
      opportunityScore: 0,
      zone: "NEUTRAL",
      reason: "Sin datos de RSI, P/E ni CAPE — introduce wlgRsiWeekly, wlgPERatio o wlgCAPE para activar detección de suelo",
      indicator: "RSI Semanal URTH + P/E MSCI World + CAPE",
      indicatorValue: "Sin datos",
      shouldAccumulate: false,
      attackMultiplier: 1.0,
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // RSI semanal — invertido: bajo = oversold
  if (isValidReading(wlgRsiWeekly, 0, 100)) {
    if (wlgRsiWeekly < 30)        { score += 30; reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — oversold extremo (pánico vendedor)`); }
    else if (wlgRsiWeekly < 40)   { score += 18; reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — oversold`); }
    else if (wlgRsiWeekly < 50)   { score += 8;  reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — zona baja`); }
  }

  // P/E — PRIMARIO: barato = oportunidad
  const hasPE = isValidReading(wlgPERatio);
  const hasCAPE = isValidReading(wlgCAPE);

  // CALIBRACIÓN: P/E Forward<10 + RSI<30 + CAPE<20 debe alcanzar EXTREME (≥80).
  //   Históricamente: solo marzo 2009 (GFC) y marzo 2020 (COVID).
  //   Forward P/E ~3 puntos por debajo del TTM (media forward ~14 vs TTM ~17).
  if (hasPE) {
    if (wlgPERatio < 10)          { score += 45; reasons.push(`P/E Forward MSCI World ${wlgPERatio.toFixed(1)} — infravaloración histórica (solo crisis severas)`); }
    else if (wlgPERatio < 12)     { score += 30; reasons.push(`P/E Forward MSCI World ${wlgPERatio.toFixed(1)} — mercado barato (por debajo de la media histórica)`); }
    else if (wlgPERatio < 14)     { score += 15; reasons.push(`P/E Forward MSCI World ${wlgPERatio.toFixed(1)} — valoración razonable`); }

    // CAPE confirmatorio: si CAPE está más barato que lo que sugiere el P/E
    if (hasCAPE) {
      let capeDiscount = false;
      if (wlgCAPE < 20)           { capeDiscount = true; reasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — confirma infravaloración (proxy, <20: solo crisis 2009 y 2020)`); }
      else if (wlgCAPE < 25)      { capeDiscount = true; reasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — ligeramente por debajo de la media (proxy)`); }
      if (capeDiscount) score += 10;
    }
  } else if (hasCAPE) {
    // Fallback: sin P/E, CAPE actúa como primario
    if (wlgCAPE < 20)             { score += 30; reasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — infravaloración extrema [fallback: sin P/E]`); }
    else if (wlgCAPE < 25)        { score += 18; reasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — por debajo de la media [fallback: sin P/E]`); }
    else if (wlgCAPE < 28)        { score += 8;  reasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — valoración razonable [fallback: sin P/E]`); }
  }

  // ── Capa Táctica Diaria (WLG) ─────────────────────────────────
  //   Max +20 pts (+10 RSI +10 Z). WLG es equity índice global (σ~15% anual).
  //   Umbrales moderados: no queremos comprar cada -2% del MSCI World.
  //   La señal de suelo la da P/E estructural, la capa táctica añade precisión.
  const t_wlg = applyTacticalDaily(
    score, priceHistories?.["0P00000WLG.F"], regime, "WLG",
    [[25, 10], [35, 5]],
    [[-2.5, 10], [-2.0, 5]],
    currentPrices?.["0P00000WLG.F"],
  );
  score = t_wlg.score;
  reasons.push(...t_wlg.reasons);

const zone = scoreToZone(score);
  const parts: string[] = [];
  if (isValidReading(wlgRsiWeekly, 0, 100)) parts.push(`RSI-W ${wlgRsiWeekly.toFixed(0)}`);
  if (isValidReading(wlgCAPE)) parts.push(`P/E S&P 500 ${wlgCAPE.toFixed(1)}`);
  if (isValidReading(wlgPERatio)) parts.push(`P/E ${wlgPERatio.toFixed(1)}`);

  return {
    asset: "Vanguard Global Stock",
    ticker: "0P00000WLG.F",
    opportunityScore: score,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "MSCI World en zona neutra — sin señal de suelo de ciclo",
    indicator: "P/E MSCI World + CAPE + RSI Semanal",
    indicatorValue: parts.join(" · ") || "Sin datos",
    shouldAccumulate: score >= 40,
    attackMultiplier: attackMultiplierForScore(score),
  };
}

// ── EMXC Bottom ──────────────────────────────────────────────────
// Invierte la lógica de detectEMXCTop:
//   DXY > 103 + P/E > 18 + RSI > 75 = techo
//   DXY > 106 + P/E < 12 + RSI < 35 = suelo (EM crisis sale)
// El DXY extremo significa que EM están en oferta por flight-to-safety,
// no por deterioro fundamental. Es el momento clásico de comprar EM.
function detectEMXCBottom(inputs: CycleTopInputs): CycleBottomSignal {
  const { emxcRsiWeekly, emxcPERatio, dxy, priceHistories, currentPrices, regime } = inputs;

  if (!isValidReading(emxcRsiWeekly, 0, 100) && !isValidReading(emxcPERatio) && !isValidReading(dxy, 50)) {
    return {
      asset: "Emerging Markets",
      ticker: "EMXC.DE",
      opportunityScore: 0,
      zone: "NEUTRAL",
      reason: "Sin datos de RSI, P/E ni DXY — introduce emxcRsiWeekly, emxcPERatio o dxy para activar detección de suelo",
      indicator: "RSI Semanal EEM + P/E Emergentes + DXY",
      indicatorValue: "Sin datos",
      shouldAccumulate: false,
      attackMultiplier: 1.0,
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // DXY como indicador de oportunidad: dólar extremadamente fuerte = EM en oferta
  // No es que EM estén mal — es que el capital huye a USD. Cuando el DXY revierte,
  // EM suelen rebotar +20-40% en 12 meses. Esto es investigación del BIS.
  if (isValidReading(dxy, 50)) {
    if (dxy > 110) {
      score += 35;
      reasons.push(`DXY ${dxy.toFixed(1)} — dólar en niveles de crisis EM. El flight-to-safety ha castigado a emergentes más allá de sus fundamentales. Oportunidad histórica de compra (recuperación media EM tras pico DXY: +32% en 12m).`);
    } else if (dxy > 106) {
      score += 25;
      reasons.push(`DXY ${dxy.toFixed(1)} — dólar fuerte. EM en descuento por flujos, no por fundamentales.`);
    } else if (dxy > 103) {
      score += 10;
      reasons.push(`DXY ${dxy.toFixed(1)} — dólar apreciándose. EM empezando a estar atractivos.`);
    }
  }

  // P/E — barato = oportunidad
  if (isValidReading(emxcPERatio)) {
    if (emxcPERatio < 10)         { score += 30; reasons.push(`P/E ${emxcPERatio.toFixed(1)} — Emergentes en crisis (solo en pánicos sistémicos)`); }
    else if (emxcPERatio < 12)    { score += 20; reasons.push(`P/E ${emxcPERatio.toFixed(1)} — Emergentes baratos (por debajo de su media histórica ~15)`); }
    else if (emxcPERatio < 15)    { score += 10; reasons.push(`P/E ${emxcPERatio.toFixed(1)} — valoración razonable`); }
  }

  // RSI semanal — oversold
  if (isValidReading(emxcRsiWeekly, 0, 100)) {
    if (emxcRsiWeekly < 30)       { score += 25; reasons.push(`RSI semanal EEM ${emxcRsiWeekly.toFixed(0)} — oversold extremo (capitulación EM)`); }
    else if (emxcRsiWeekly < 40)  { score += 15; reasons.push(`RSI semanal EEM ${emxcRsiWeekly.toFixed(0)} — oversold`); }
    else if (emxcRsiWeekly < 50)  { score += 5;  reasons.push(`RSI semanal EEM ${emxcRsiWeekly.toFixed(0)} — zona baja`); }
  }

  // ── Capa Táctica Diaria (EMXC) ───────────────────────────────
  //   Max +24 pts (+12 RSI +12 Z). EMXC tiene σ~20% anual, más volátil que WLG
  //   pero menos que semis/uranio. Umbrales intermedios: captura oversold sin
  //   disparar con cada ruido de mercados emergentes.
  const t_emxc = applyTacticalDaily(
    score, priceHistories?.["EMXC.DE"], regime, "EMXC",
    [[20, 12], [30, 8], [40, 4]],
    [[-2.5, 12], [-2.0, 8], [-1.5, 4]],
    currentPrices?.["EMXC.DE"],
  );
  score = t_emxc.score;
  reasons.push(...t_emxc.reasons);

const zone = scoreToZone(score);
  const parts: string[] = [];
  if (isValidReading(dxy, 50)) parts.push(`DXY ${dxy.toFixed(1)}`);
  if (isValidReading(emxcRsiWeekly, 0, 100)) parts.push(`RSI-W ${emxcRsiWeekly.toFixed(0)}`);
  if (isValidReading(emxcPERatio)) parts.push(`P/E ${emxcPERatio.toFixed(1)}`);

  return {
    asset: "Emerging Markets",
    ticker: "EMXC.DE",
    opportunityScore: score,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Emergentes en zona neutra — sin señal de suelo de ciclo",
    indicator: "DXY + P/E Emergentes + RSI Semanal EEM",
    indicatorValue: parts.join(" · ") || "Sin datos",
    shouldAccumulate: score >= 40,
    attackMultiplier: attackMultiplierForScore(score),
  };
}

// ── FUNCIÓN PRINCIPAL (BOTTOMS) ──────────────────────────────────
// FIX-GOLD-CONTRADICTION (Jul-2026): mutual-exclusion con Cycle Top.
//   Si el detector de techo ya dice CAUTION/DANGER/EXTREME para un activo,
//   el detector de suelo NO puede recomendar comprarlo. La preservación
//   de capital (top) siempre manda sobre la búsqueda de oportunidad (bottom).
//   Sin este guard, el oro aparecía simultáneamente como CAUTION (vender)
//   y VALUE (comprar) porque ambos usan las mismas variables (realRate, Brent).
export function detectCycleBottoms(
  inputs: CycleTopInputs,
  topSignals?: CycleTopSignal[],
): CycleBottomOutput {
  const rawSignals: CycleBottomSignal[] = [
    detectBTCBottom(inputs),
    detectUraniumBottom(inputs),
    detectSemisBottom(inputs),
    detectGoldBottom(inputs),
    detectWLGBottom(inputs),
    detectEMXCBottom(inputs),
  ];

  // ── Mutual exclusion: si Cycle Top está activo, reducir Cycle Bottom ──
  //   Supresión GRADUAL (no binaria): el score se reduce proporcionalmente al trim del top.
  //   Top CAUTION 5% trim + Bottom OPPORTUNITY 75pts → 75*0.95=71pts (sigue OPPORTUNITY).
  //   Top DANGER 45% trim + Bottom VALUE 50pts → 50*0.55=27pts (cae a NEUTRAL).
  //   La preservación de capital manda, pero sin anular oportunidades legítimas
  //   cuando el riesgo de techo es leve.
  const signals = topSignals && topSignals.length > 0
    ? rawSignals.map(bottom => {
        const top = topSignals.find(t => t.ticker === bottom.ticker);
        if (top && top.zone !== "SAFE" && bottom.zone !== "NEUTRAL") {
          const survivalFactor = 1 - (top.trimPct / 100); // 22% trim → 0.78 survival
          const adjustedScore = Math.round(bottom.opportunityScore * survivalFactor);
          const adjustedZone = scoreToZone(adjustedScore);
          const adjustedShouldAccumulate = adjustedScore >= 40;
          const adjustedAttackMultiplier = attackMultiplierForScore(adjustedScore);
          return {
            ...bottom,
            opportunityScore: adjustedScore,
            zone: adjustedZone,
            reason: bottom.reason + ` [Cycle Top: ${top.zone} (−${top.trimPct}% trim) → score ajustado ×${survivalFactor.toFixed(2)}: ${bottom.opportunityScore}→${adjustedScore}]`,
            shouldAccumulate: adjustedShouldAccumulate,
            attackMultiplier: adjustedAttackMultiplier,
          };
        }
        return bottom;
      })
    : rawSignals;

  const maxOpportunityScore = Math.max(...signals.map(s => s.opportunityScore));
  const topOpportunity = signals.find(s => s.opportunityScore === maxOpportunityScore && s.opportunityScore >= 40) ?? null;

  return {
    signals,
    hasActiveOpportunities: signals.some(s => s.shouldAccumulate),
    maxOpportunityScore,
    topOpportunity,
  };
}