// ===============================================
// ARCHIVO: src/core/risk/cycleTopDetector.ts
// Detección de techo de ciclo por activo
// ===============================================
// Cada activo tiene su propio driver de ciclo:
//   BTC       → MVRV ratio (on-chain)
//   Uranio    → Spot/LT ratio (mercado físico)
//   Semis     → Book-to-Bill ratio (SEMI.org)
//   Oro       → Tipo real (bono 10y − inflación implícita)
//   WLG       → RSI semanal MSCI World + P/E MSCI World (manual) — sustituye a IS3Q y XNAS
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
): v is number =>
  v !== undefined && Number.isFinite(v) && v > min && v < max;

export interface CycleTopInputs {
  // BTC
  mvrvRatio?: number;          // lookintobitcoin.com — umbral techo: >3.5
  btcDominanceFalling?: boolean; // BTC.D cayendo desde >58% (calculado en dashboard)
  btcRsiWeekly?: number;       // RSI semanal BTC — TradingView, período 14, timeframe W

  // Uranio
  uraniumSpotPrice?: number;   // $/lb — uxc.com o cameco.com/invest
  uraniumLTPrice?: number;     // $/lb precio largo plazo — misma fuente

  // Semiconductores
siaSalesYoY?: number;        // Crecimiento interanual de ventas globales de semis (%) — SIA/WSTS
soxRsiWeekly?: number;       // RSI semanal del índice PHLX Semiconductor (^SOX)

  // Oro
  bondYield10y: number;        // ya disponible en dashboard
  inflationBreakeven?: number; // TradingView: T5YIE — breakeven inflación 5 años EEUU
  brentOil?: number;           // $/barril — si >$95 la guerra/inflación protege al oro → override HOLD

  // WLG (Vanguard Global Stock — MSCI World)
  wlgRsiWeekly?: number;     // RSI semanal URTH (proxy MSCI World) — TradingView, período 14, timeframe W
  wlgPERatio?: number;       // P/E del MSCI World (manual — multpl.com o Yardeni)
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
  const { mvrvRatio, btcDominanceFalling, btcRsiWeekly } = inputs;

  // Contar señales de techo activas
  let topSignals = 0;
  const reasons: string[] = [];

  if (isValidReading(mvrvRatio)) {
    if (mvrvRatio > 6.0)       { topSignals += 3; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — extremo histórico`); }
    else if (mvrvRatio > 4.5)  { topSignals += 2; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — zona de burbuja`); }
    else if (mvrvRatio > 3.5)  { topSignals += 1; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — alerta de techo`); }
  }

  if (btcDominanceFalling)     { topSignals += 1; reasons.push("BTC.D cayendo desde >58% — rotación a altcoins (fin de ciclo)"); }

  if (isValidReading(btcRsiWeekly, 0, 100) && btcRsiWeekly > 80) {
    topSignals += 2; reasons.push(`RSI semanal ${btcRsiWeekly.toFixed(0)} — sobrecompra extrema en timeframe semanal`);
  }

  // Calcular multiplicador y zona
  let multiplier: number;
  let zone: CycleTopSignal["zone"];
  let trimPct = 0;

  if (topSignals >= 5) {
    multiplier = 0.10; zone = "EXTREME"; trimPct = 80;  // vender 80% de la posición
  } else if (topSignals >= 3) {
    multiplier = 0.30; zone = "DANGER";  trimPct = 60;  // vender 60%
  } else if (topSignals >= 2) {
    multiplier = 0.50; zone = "CAUTION"; trimPct = 40;  // vender 40%
  } else if (topSignals >= 1) {
    multiplier = 0.70; zone = "CAUTION"; trimPct = 20;  // vender 20%
  } else {
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
  }

  // MVRV como indicador primario para mostrar
  const indicatorValue = isValidReading(mvrvRatio)
    ? `MVRV ${mvrvRatio.toFixed(2)}${isValidReading(btcRsiWeekly) ? ` · RSI-W ${btcRsiWeekly.toFixed(0)}` : ""}`
    : "Sin datos MVRV";

  return {
    asset: "Bitcoin",
    ticker: "BTC-EUR",
    allocationMultiplier: multiplier,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Zona segura — sin señales de techo de ciclo",
    indicator: "MVRV + BTC.D + RSI Semanal",
    indicatorValue,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── URANIO ───────────────────────────────────────────────────────
function detectUraniumTop(inputs: CycleTopInputs): CycleTopSignal {
  const { uraniumSpotPrice, uraniumLTPrice } = inputs;

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

  let multiplier: number;
  let zone: CycleTopSignal["zone"];
  let trimPct = 0;
  let reason: string;

  if (ratio > 1.50) {
    multiplier = 0.15; zone = "EXTREME"; trimPct = 75;
    reason = `Spot/LT ${ratio.toFixed(2)} — utilities comprando en pánico (como 2007). Techo de ciclo inminente.`;
  } else if (ratio > 1.30) {
    multiplier = 0.35; zone = "DANGER";  trimPct = 55;
    reason = `Spot/LT ${ratio.toFixed(2)} — fuerte backwardation. Demanda spot muy por encima de contratos LT.`;
  } else if (ratio > 1.20) {
    multiplier = 0.55; zone = "CAUTION"; trimPct = 35;
    reason = `Spot/LT ${ratio.toFixed(2)} — alerta de ciclo. Spot superando LT en >20%.`;
  } else if (ratio > 1.10) {
    multiplier = 0.75; zone = "CAUTION"; trimPct = 15;
    reason = `Spot/LT ${ratio.toFixed(2)} — ligera tensión. Spot empieza a superar al LT.`;
  } else if (ratio < 0.70) {
    // FIX-URANIUM-VALUE: descuento profundo — utilities pagan +43% más por contratos LP.
    // Señal de acumulación agresiva. Raro: solo ha ocurrido en 2016 y brevemente en 2020.
    multiplier = 1.0; zone = "SAFE"; trimPct = 0;
    reason = `Spot/LT ${ratio.toFixed(2)} — descuento profundo. Spot muy por debajo del LT: utilities pagan fuerte prima por suministro futuro. Señal de acumulación agresiva.`;
  } else if (ratio < 0.85) {
    // FIX-URANIUM-VALUE: spot barato vs contratos LP.
    // El mercado de futuros anticipa mayor demanda → ventana de acumulación.
    multiplier = 1.0; zone = "SAFE"; trimPct = 0;
    reason = `Spot/LT ${ratio.toFixed(2)} — spot barato vs contratos a largo plazo. Contango saludable: el mercado anticipa tightening futuro. Ventana de acumulación.`;
  } else {
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
    reason = `Spot/LT ${ratio.toFixed(2)} — equilibrio normal entre spot y contratos a largo plazo.`;
  }

  // FIX-AUDIT-URANIO-CLAMP (Jul-2026): el clamp [0,1] ahora se aplica
  //   centralizadamente en detectCycleTops() para TODOS los detectores.
  //   Ver contrato del output al inicio del archivo.

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
  const { siaSalesYoY, soxRsiWeekly } = inputs;

  // Si no hay datos de ningún indicador, señal neutra
  if (!isValidReading(siaSalesYoY, -100) && !isValidReading(soxRsiWeekly, 0, 100)) {
    return {
      asset: "Semiconductors",
      ticker: "VVSM.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de ventas SIA ni RSI del SOX — introduce ambos para activar esta señal",
      indicator: "SIA Sales YoY + SOX RSI Semanal",
      indicatorValue: "Sin datos",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  // Contar señales de techo activas (0, 1 o 2)
  let topSignals = 0;
  const reasons: string[] = [];

  // Evaluar SIA Sales YoY%
  if (isValidReading(siaSalesYoY, -100)) {
    if (siaSalesYoY > 40) {
      topSignals += 2;
      reasons.push(`Ventas SIA +${siaSalesYoY.toFixed(1)}% YoY — euforia insostenible`);
    } else if (siaSalesYoY > 30) {
      topSignals += 1;
      reasons.push(`Ventas SIA +${siaSalesYoY.toFixed(1)}% YoY — ciclo muy caliente`);
    } else if (siaSalesYoY > 25) {
      topSignals += 0.5; // Señal débil
      reasons.push(`Ventas SIA +${siaSalesYoY.toFixed(1)}% YoY — crecimiento elevado, vigilar`);
    }
  }

  // Evaluar RSI semanal del SOX
  if (isValidReading(soxRsiWeekly, 0, 100)) {
    if (soxRsiWeekly > 85) {
      topSignals += 2;
      reasons.push(`RSI semanal SOX ${soxRsiWeekly.toFixed(0)} — sobrecompra extrema`);
    } else if (soxRsiWeekly > 80) {
      topSignals += 1;
      reasons.push(`RSI semanal SOX ${soxRsiWeekly.toFixed(0)} — sobrecompra`);
    }
  }

  // Asignar multiplicador y zona según puntuación acumulada
  let multiplier: number;
  let zone: CycleTopSignal["zone"];
  let trimPct = 0;

  // Umbrales ajustados: con dos señales ya estamos en DANGER
  if (topSignals >= 3) {
    multiplier = 0.15; zone = "EXTREME"; trimPct = 80;
  } else if (topSignals >= 2) {
    multiplier = 0.35; zone = "DANGER";  trimPct = 60;
  } else if (topSignals >= 1) {
    multiplier = 0.55; zone = "CAUTION"; trimPct = 35;
  } else if (topSignals >= 0.5) {
    multiplier = 0.75; zone = "CAUTION"; trimPct = 15; // señal débil
  } else {
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
  }

  // Construir valor del indicador para mostrar
  const parts: string[] = [];
  if (isValidReading(siaSalesYoY, -100)) parts.push(`SIA sales +${siaSalesYoY.toFixed(1)}% YoY`);
  if (isValidReading(soxRsiWeekly, 0, 100)) parts.push(`SOX RSI-W ${soxRsiWeekly.toFixed(0)}`);
  const indicatorValue = parts.join(" · ") || "Sin datos";

  return {
    asset: "Semiconductors",
    ticker: "VVSM.DE",
    allocationMultiplier: multiplier,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Ciclo saludable, sin señales de techo",
    indicator: "SIA Sales YoY + SOX RSI Semanal",
    indicatorValue,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── ORO ──────────────────────────────────────────────────────────
function detectGoldTop(inputs: CycleTopInputs): CycleTopSignal {
  const { bondYield10y, inflationBreakeven, brentOil } = inputs;

  if (!isValidReading(inflationBreakeven, -10, 50) || !isValidReading(bondYield10y, -5, 50)) {
    return {
      asset: "Gold (ETC)",
      ticker: "PPFB.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de inflación implícita o bono 10y — introduce T5YIE y US10Y (TradingView) para activar esta señal",
      indicator: "Tipo Real (bono 10y − breakeven 5y)",
      indicatorValue: "Sin datos tipo real",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  // Tipo real = rendimiento nominal 10y − inflación implícita 5y
  // El oro sufre cuando el tipo real sube (coste de oportunidad vs bonos)
  // Historial: tipo real >2% = muy malo para el oro
  //            tipo real >1% = presión moderada
  //            tipo real 0-1% = neutral
  //            tipo real <0% = positivo para oro (dinero barato, cobre el coste de oportunidad)
  const realRate = bondYield10y - inflationBreakeven;

  let multiplier: number;
  let zone: CycleTopSignal["zone"];
  let trimPct = 0;
  let reason: string;

  if (realRate > 2.5) {
    multiplier = 0.20; zone = "DANGER";  trimPct = 65;
    reason = `Tipo real ${realRate.toFixed(2)}% — bonos pagan mucho más que el oro. Flujos saliendo del oro hacia renta fija.`;
  } else if (realRate > 1.5) {
    multiplier = 0.45; zone = "CAUTION"; trimPct = 40;
    reason = `Tipo real ${realRate.toFixed(2)}% — coste de oportunidad elevado. Presión importante sobre el oro.`;
  } else if (realRate > 0.5) {
    multiplier = 0.70; zone = "CAUTION"; trimPct = 20;
    reason = `Tipo real ${realRate.toFixed(2)}% — presión moderada sobre el oro. Vigilar tendencia.`;
  } else if (realRate > -0.5) {
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
    reason = `Tipo real ${realRate.toFixed(2)}% — zona neutral. Sin presión significativa sobre el oro.`;
  } else {
    // Tipo real negativo = entorno muy favorable para el oro → no recortar
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
    reason = `Tipo real ${realRate.toFixed(2)}% — tipos reales negativos. Entorno favorable para el oro.`;
  }

  // ── BRENT CRUDE OVERRIDE ──────────────────────────────────────────────────
  // Petróleo alto → inflación real sube → tipo real efectivo cae → oro protege
  // En shock/crisis energética la señal de venta de oro se cancela o reduce
  // porque el Brent es el termómetro más rápido de inflación geopolítica real
  if (brentOil !== undefined && brentOil >= 95 && trimPct > 0) {
    const brentLabel = brentOil >= 115 ? "CRISIS ENERGÉTICA" : "SHOCK GEOPOLÍTICO";
    reason = `Brent $${brentOil.toFixed(0)} — ${brentLabel}. Señal de venta suspendida: petróleo alto genera inflación real que protege al oro. Tipo real nominal: ${realRate.toFixed(2)}%.`;
    multiplier = Math.max(multiplier, 0.85);
    trimPct    = 0;
    zone       = "SAFE";
  } else if (brentOil !== undefined && brentOil >= 75 && trimPct > 0) {
    // Tensión elevada — suavizar señal de venta 20pp pero no eliminarla
    reason = `Tipo real ${realRate.toFixed(2)}% — presión sobre el oro, pero Brent $${brentOil.toFixed(0)} (tensión geopolítica) reduce el riesgo. Vigilar.`;
    trimPct = Math.max(0, trimPct - 20);
    if (trimPct === 0) { multiplier = 1.0; zone = "SAFE"; }
  }

  return {
    asset: "Gold (ETC)",
    ticker: "PPFB.DE",
    allocationMultiplier: multiplier,
    zone,
    reason,
    indicator: "Tipo Real + Brent Crude Oil",
    indicatorValue: `${bondYield10y.toFixed(2)}% − ${inflationBreakeven.toFixed(2)}% = ${realRate.toFixed(2)}% tipo real · Brent $${brentOil?.toFixed(0) ?? "—"}`,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── WLG (Vanguard Global Stock — MSCI World) ─────────────────────
// El MSCI World es el índice de developed markets más amplio.
// Señales de techo:
//   RSI Semanal > 75 → sobrecompra. > 80 → sobrecompra extrema.
//   P/E MSCI World → indicador PRIMARIO (dato real del fondo, URTH vía TradingView).
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
//   Con datos actuales (P/E 19.4 + CAPE 41.7):
//   ANTES: max(CAPE_score=2.5, P/E_score=0) = 2.5 → DANGER, trim 60%
//   AHORA: P/E_score=1.0 + CAPE_confirm=0.5 = 1.5 → CAUTION, trim 35%
function detectWLGTop(inputs: CycleTopInputs): CycleTopSignal {
  const { wlgRsiWeekly, wlgPERatio, wlgCAPE } = inputs;

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

  // RSI Semanal (mismo peso que antes)
  if (isValidReading(wlgRsiWeekly, 0, 100)) {
    if (wlgRsiWeekly > 85) {
      topSignals += 2;
      reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — sobrecompra extrema`);
    } else if (wlgRsiWeekly > 80) {
      topSignals += 1.5;
      reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — sobrecompra severa`);
    } else if (wlgRsiWeekly > 75) {
      topSignals += 1;
      reasons.push(`RSI semanal MSCI World ${wlgRsiWeekly.toFixed(0)} — sobrecompra`);
    }
  }

  // FIX-INSTITUTIONAL (Jul-2026): P/E PRIMARIO, CAPE CONFIRMATORIO.
  //   Principio: dato real del activo > proxy de otro índice.
  //   El P/E 19.4 de URTH (MSCI World) es el valuation driver. El CAPE 41.7
  //   del S&P 500 confirma si está más alarmado que el P/E (+0.5 extra).
  //   Sin P/E disponible, CAPE actúa como fallback primario.
  let valuationScore = 0;
  const valuationReasons: string[] = [];
  const hasPE = isValidReading(wlgPERatio);
  const hasCAPE = isValidReading(wlgCAPE);

  if (hasPE) {
    // ── PRIMARIO: P/E del MSCI World (dato real del fondo URTH) ──
    // Umbrales recalibrados para MSCI World (media histórica ~15-17, rango 10-30).
    if (wlgPERatio > 30) {
      valuationScore = 2.5;
      valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — valoración extrema (solo 2000 y 2021)`);
    } else if (wlgPERatio > 25) {
      valuationScore = 2.0;
      valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — mercado muy caro`);
    } else if (wlgPERatio > 22) {
      valuationScore = 1.5;
      valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — mercado caro`);
    } else if (wlgPERatio > 19) {
      valuationScore = 1.0;
      valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — por encima de la media (~17)`);
    } else if (wlgPERatio > 17) {
      valuationScore = 0.5;
      valuationReasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — ligeramente por encima de la media`);
    }

    // ── CONFIRMATORIO: CAPE del S&P 500 (+0.5 si está más alarmado que el P/E) ──
    if (hasCAPE) {
      let capeImpliedScore = 0;
      if (wlgCAPE > 44) capeImpliedScore = 3;
      else if (wlgCAPE > 38) capeImpliedScore = 2.5;
      else if (wlgCAPE > 33) capeImpliedScore = 2;
      else if (wlgCAPE > 30) capeImpliedScore = 1.5;
      else if (wlgCAPE > 27) capeImpliedScore = 0.75;

      if (capeImpliedScore > valuationScore) {
        valuationScore += 0.5;
        valuationReasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — confirma sobrevaloración (proxy, no dato del fondo)`);
      }
    }
  } else if (hasCAPE) {
    // ── FALLBACK: sin P/E, CAPE actúa como primario ──
    if (wlgCAPE > 44) {
      valuationScore = 3;
      valuationReasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — nivel de burbuja dot-com (récord: 44.2 en 1999) [fallback: sin P/E]`);
    } else if (wlgCAPE > 38) {
      valuationScore = 2.5;
      valuationReasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — sobrevaloración extrema (>38: solo 1999 y 2021) [fallback: sin P/E]`);
    } else if (wlgCAPE > 33) {
      valuationScore = 2;
      valuationReasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — mercado significativamente caro [fallback: sin P/E]`);
    } else if (wlgCAPE > 30) {
      valuationScore = 1.5;
      valuationReasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — mercado caro [fallback: sin P/E]`);
    } else if (wlgCAPE > 27) {
      valuationScore = 0.75;
      valuationReasons.push(`CAPE S&P 500 ${wlgCAPE.toFixed(1)} — ligeramente por encima de la media [fallback: sin P/E]`);
    }
  }

  topSignals += valuationScore;
  reasons.push(...valuationReasons);

  let multiplier: number;
  let zone: CycleTopSignal["zone"];
  let trimPct = 0;

  // Umbrales ajustados: con CAPE + P/E + RSI simultáneos, topSignals puede llegar a 7+
  if (topSignals >= 5) {
    multiplier = 0.10; zone = "EXTREME"; trimPct = 85;
  } else if (topSignals >= 3.5) {
    multiplier = 0.20; zone = "EXTREME"; trimPct = 75;
  } else if (topSignals >= 2.5) {
    multiplier = 0.35; zone = "DANGER";  trimPct = 60;
  } else if (topSignals >= 1.5) {
    multiplier = 0.55; zone = "CAUTION"; trimPct = 35;
  } else if (topSignals >= 0.5) {
    multiplier = 0.75; zone = "CAUTION"; trimPct = 15;
  } else {
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
  }

  const parts: string[] = [];
  if (isValidReading(wlgRsiWeekly, 0, 100)) parts.push(`RSI-W ${wlgRsiWeekly.toFixed(0)}`);
  if (isValidReading(wlgCAPE)) parts.push(`CAPE ${wlgCAPE.toFixed(1)}`);
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

  if (!isValidReading(emxcRsiWeekly, 0, 100) && !isValidReading(emxcPERatio) && !isValidReading(dxy, 50)) {
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

  // Evaluar RSI semanal (umbrales más altos porque EM es más volátil)
  if (isValidReading(emxcRsiWeekly, 0, 100)) {
    if (emxcRsiWeekly > 85) {
      topSignals += 2;
      reasons.push(`RSI semanal EEM ${emxcRsiWeekly.toFixed(0)} — sobrecompra extrema en emergentes`);
    } else if (emxcRsiWeekly > 80) {
      topSignals += 1;
      reasons.push(`RSI semanal EEM ${emxcRsiWeekly.toFixed(0)} — sobrecompra en emergentes`);
    } else if (emxcRsiWeekly > 75) {
      topSignals += 0.5;
      reasons.push(`RSI semanal EEM ${emxcRsiWeekly.toFixed(0)} — zona de vigilancia`);
    }
  }

  // Evaluar P/E del MSCI Emerging Markets (SECUNDARIO)
  // Rango histórico P/E EM: ~10-12 en crisis, ~15 media, ~18-20 caro, >22 solo burbuja 2010.
  if (isValidReading(emxcPERatio)) {
    if (emxcPERatio > 25) {
      topSignals += 2;
      reasons.push(`P/E ${emxcPERatio.toFixed(1)} — Emergentes en burbuja (histórico: >20 = caro)`);
    } else if (emxcPERatio > 20) {
      topSignals += 1.5;
      reasons.push(`P/E ${emxcPERatio.toFixed(1)} — Emergentes caros (media histórica ~15)`);
    } else if (emxcPERatio > 18) {
      topSignals += 1;
      reasons.push(`P/E ${emxcPERatio.toFixed(1)} — Emergentes por encima de su media`);
    }
  }

  let multiplier: number;
  let zone: CycleTopSignal["zone"];
  let trimPct = 0;

  // Umbrales ajustados al alza: con DXY + RSI + P/E, topSignals puede alcanzar 7+
  if (topSignals >= 5) {
    multiplier = 0.10; zone = "EXTREME"; trimPct = 85;
  } else if (topSignals >= 3.5) {
    multiplier = 0.20; zone = "EXTREME"; trimPct = 75;
  } else if (topSignals >= 2.5) {
    multiplier = 0.35; zone = "DANGER";  trimPct = 60;
  } else if (topSignals >= 1.5) {
    multiplier = 0.55; zone = "CAUTION"; trimPct = 35;
  } else if (topSignals >= 0.5) {
    multiplier = 0.75; zone = "CAUTION"; trimPct = 15;
  } else {
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
  }

  const parts: string[] = [];
  if (isValidReading(dxy, 50)) parts.push(`DXY ${dxy.toFixed(1)}`);
  if (isValidReading(emxcRsiWeekly, 0, 100)) parts.push(`RSI-W ${emxcRsiWeekly.toFixed(0)}`);
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

// ── BTC Bottom ───────────────────────────────────────────────────
// Invierte la lógica de detectBTCTop:
//   MVRV > 3.5 = techo  →  MVRV < 1.5 = suelo
//   RSI-W > 80 = techo  →  RSI-W < 30 = suelo
function detectBTCBottom(inputs: CycleTopInputs): CycleBottomSignal {
  const { mvrvRatio, btcRsiWeekly } = inputs;

  let score = 0;
  const reasons: string[] = [];

  // MVRV — invertido: bajo = infravalorado
  // CALIBRACIÓN: MVRV<1.5 + RSI<30 debe alcanzar EXTREME (≥80).
  //   Históricamente: solo marzo 2020 (COVID) y nov 2022 (FTX).
  if (isValidReading(mvrvRatio)) {
    if (mvrvRatio < 1.5)        { score += 45; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — infravaloración extrema (suelo de ciclo)`); }
    else if (mvrvRatio < 2.0)   { score += 30; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — zona de acumulación`); }
    else if (mvrvRatio < 2.5)   { score += 18; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — ligeramente infravalorado`); }
  }

  // RSI semanal — invertido: bajo = oversold
  if (isValidReading(btcRsiWeekly, 0, 100)) {
    if (btcRsiWeekly < 30)        { score += 35; reasons.push(`RSI semanal ${btcRsiWeekly.toFixed(0)} — oversold extremo`); }
    else if (btcRsiWeekly < 40)   { score += 20; reasons.push(`RSI semanal ${btcRsiWeekly.toFixed(0)} — oversold`); }
    else if (btcRsiWeekly < 45)   { score += 10; reasons.push(`RSI semanal ${btcRsiWeekly.toFixed(0)} — zona baja`); }
  }

  const zone = scoreToZone(score);
  const indicatorValue = isValidReading(mvrvRatio)
    ? `MVRV ${mvrvRatio.toFixed(2)}${isValidReading(btcRsiWeekly, 0, 100) ? ` · RSI-W ${btcRsiWeekly.toFixed(0)}` : ""}`
    : `RSI-W ${btcRsiWeekly?.toFixed(0) ?? "—"}`;

  return {
    asset: "Bitcoin",
    ticker: "BTC-EUR",
    opportunityScore: score,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "BTC en zona neutra — sin señal de suelo de ciclo",
    indicator: "MVRV + RSI Semanal (invertido)",
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
  const { uraniumSpotPrice, uraniumLTPrice } = inputs;

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
  const { siaSalesYoY, soxRsiWeekly } = inputs;

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
  const { bondYield10y, inflationBreakeven, brentOil } = inputs;

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

  const zone = scoreToZone(score);

  return {
    asset: "Gold (ETC)",
    ticker: "PPFB.DE",
    opportunityScore: score,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Oro en zona neutra — sin señal de suelo de ciclo",
    indicator: "Tipo Real + Brent Crude Oil",
    indicatorValue: `${bondYield10y.toFixed(2)}% − ${inflationBreakeven.toFixed(2)}% = ${realRate.toFixed(2)}% tipo real · Brent $${brentOil?.toFixed(0) ?? "—"}`,
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
  const { wlgRsiWeekly, wlgPERatio, wlgCAPE } = inputs;

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

  // CALIBRACIÓN: P/E<13 + RSI<30 + CAPE<20 debe alcanzar EXTREME (≥80).
  //   Históricamente: solo marzo 2009 (GFC) y marzo 2020 (COVID).
  if (hasPE) {
    if (wlgPERatio < 13)          { score += 45; reasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — infravaloración histórica (solo crisis severas)`); }
    else if (wlgPERatio < 15)     { score += 30; reasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — mercado barato (por debajo de la media histórica)`); }
    else if (wlgPERatio < 17)     { score += 15; reasons.push(`P/E MSCI World ${wlgPERatio.toFixed(1)} — valoración razonable`); }

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

  const zone = scoreToZone(score);
  const parts: string[] = [];
  if (isValidReading(wlgRsiWeekly, 0, 100)) parts.push(`RSI-W ${wlgRsiWeekly.toFixed(0)}`);
  if (isValidReading(wlgCAPE)) parts.push(`CAPE ${wlgCAPE.toFixed(1)}`);
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
  const { emxcRsiWeekly, emxcPERatio, dxy } = inputs;

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
export function detectCycleBottoms(inputs: CycleTopInputs): CycleBottomOutput {
  const signals: CycleBottomSignal[] = [
    detectBTCBottom(inputs),
    detectUraniumBottom(inputs),
    detectSemisBottom(inputs),
    detectGoldBottom(inputs),
    detectWLGBottom(inputs),
    detectEMXCBottom(inputs),
  ];

  const maxOpportunityScore = Math.max(...signals.map(s => s.opportunityScore));
  const topOpportunity = signals.find(s => s.opportunityScore === maxOpportunityScore && s.opportunityScore >= 40) ?? null;

  return {
    signals,
    hasActiveOpportunities: signals.some(s => s.shouldAccumulate),
    maxOpportunityScore,
    topOpportunity,
  };
}