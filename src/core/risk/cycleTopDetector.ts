// ===============================================
// ARCHIVO: src/core/risk/cycleTopDetector.ts
// Detección de techo de ciclo por activo
// ===============================================
// Cada activo tiene su propio driver de ciclo:
//   BTC       → MVRV ratio (on-chain)
//   Uranio    → Spot/LT ratio (mercado físico)
//   Semis     → Book-to-Bill ratio (SEMI.org)
//   Oro       → Tipo real (bono 10y − inflación implícita)
//   IS3Q      → RSI semanal IS3Q + P/E MSCI World (manual)
//   EMXC      → RSI semanal EEM + P/E Emergentes (manual)
//   XNAS      → RSI semanal NDX + P/E NASDAQ 100 (manual)
//
// Output: un multiplicador [0, 1] por activo
//   1.0 = sin restricción (zona segura)
//   0.5 = reducir al 50% del peso objetivo
//   0.1 = reducir al 10% del peso objetivo (techo extremo)
// ===============================================

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

  // IS3Q (MSCI World Quality Factor)
  is3qRsiWeekly?: number;     // RSI semanal IS3Q.DE — TradingView, período 14, timeframe W
  is3qPERatio?: number;       // P/E del MSCI World (manual — multpl.com o Yardeni)

  // EMXC (Emerging Markets)
  emxcRsiWeekly?: number;     // RSI semanal EEM — TradingView, período 14, timeframe W
  emxcPERatio?: number;       // P/E del MSCI Emerging Markets (manual — Yardeni)

  // XNAS (NASDAQ 100)
  xnasRsiWeekly?: number;     // RSI semanal ^NDX — TradingView, período 14, timeframe W
  xnasPERatio?: number;       // P/E del NASDAQ 100 (manual — multpl.com o Yardeni)
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

  if (mvrvRatio !== undefined) {
    if (mvrvRatio > 6.0)       { topSignals += 3; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — extremo histórico`); }
    else if (mvrvRatio > 4.5)  { topSignals += 2; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — zona de burbuja`); }
    else if (mvrvRatio > 3.5)  { topSignals += 1; reasons.push(`MVRV ${mvrvRatio.toFixed(2)} — alerta de techo`); }
  }

  if (btcDominanceFalling)     { topSignals += 1; reasons.push("BTC.D cayendo desde >58% — rotación a altcoins (fin de ciclo)"); }

  if (btcRsiWeekly !== undefined && btcRsiWeekly > 80) {
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
  const indicatorValue = mvrvRatio !== undefined
    ? `MVRV ${mvrvRatio.toFixed(2)}${btcRsiWeekly ? ` · RSI-W ${btcRsiWeekly.toFixed(0)}` : ""}`
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

  if (uraniumSpotPrice === undefined || uraniumLTPrice === undefined || uraniumLTPrice === 0) {
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
  } else {
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
    reason = `Spot/LT ${ratio.toFixed(2)} — equilibrio normal entre spot y contratos a largo plazo.`;
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
  const { siaSalesYoY, soxRsiWeekly } = inputs;

  // Si no hay datos de ningún indicador, señal neutra
  if (siaSalesYoY === undefined && soxRsiWeekly === undefined) {
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
  if (siaSalesYoY !== undefined) {
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
  if (soxRsiWeekly !== undefined) {
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
  if (siaSalesYoY !== undefined) parts.push(`SIA sales +${siaSalesYoY.toFixed(1)}% YoY`);
  if (soxRsiWeekly !== undefined) parts.push(`SOX RSI-W ${soxRsiWeekly.toFixed(0)}`);
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

  if (inflationBreakeven === undefined) {
    return {
      asset: "Gold (ETC)",
      ticker: "PPFB.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de inflación implícita — introduce T5YIE (TradingView) para activar esta señal",
      indicator: "Tipo Real (bono 10y − breakeven 5y)",
      indicatorValue: "Sin datos breakeven",
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

// ── IS3Q (MSCI World Quality Factor) ──────────────────────────────
// El Quality Factor (IS3Q) agrupa empresas con alta rentabilidad sobre recursos propios
// (ROE), baja deuda y beneficios estables. Históricamente cotiza con prima P/E de 3-5
// puntos sobre el mercado general porque los inversores pagan más por calidad.
//
// Señales de techo:
//   RSI Semanal > 75 → sobrecompra. > 80 → sobrecompra extrema.
//   P/E > 28 → caro incluso para Quality. > 35 → extremo (solo visto en 2021 post-COVID).
function detectIS3QTop(inputs: CycleTopInputs): CycleTopSignal {
  const { is3qRsiWeekly, is3qPERatio } = inputs;

  if (is3qRsiWeekly === undefined && is3qPERatio === undefined) {
    return {
      asset: "MSCI World Quality",
      ticker: "IS3Q.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de RSI semanal ni P/E — introduce is3qRsiWeekly e is3qPERatio para activar esta señal",
      indicator: "RSI Semanal IS3Q + P/E MSCI World",
      indicatorValue: "Sin datos",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  let topSignals = 0;
  const reasons: string[] = [];

  // Evaluar RSI semanal
  if (is3qRsiWeekly !== undefined) {
    if (is3qRsiWeekly > 85) {
      topSignals += 2;
      reasons.push(`RSI semanal IS3Q ${is3qRsiWeekly.toFixed(0)} — sobrecompra extrema`);
    } else if (is3qRsiWeekly > 80) {
      topSignals += 1.5;
      reasons.push(`RSI semanal IS3Q ${is3qRsiWeekly.toFixed(0)} — sobrecompra severa`);
    } else if (is3qRsiWeekly > 75) {
      topSignals += 1;
      reasons.push(`RSI semanal IS3Q ${is3qRsiWeekly.toFixed(0)} — sobrecompra`);
    }
  }

  // Evaluar P/E del MSCI World
  // Rango histórico P/E MSCI World: media ~17. Quality prima: +3-5 puntos → media ~21.
  // 2021 pico: ~28. Burbuja: >30.
  if (is3qPERatio !== undefined) {
    if (is3qPERatio > 35) {
      topSignals += 2.5;
      reasons.push(`P/E ${is3qPERatio.toFixed(1)} — Quality en territorio de burbuja (histórico: >28 = caro)`);
    } else if (is3qPERatio > 30) {
      topSignals += 1.5;
      reasons.push(`P/E ${is3qPERatio.toFixed(1)} — Quality extremadamente caro (solo visto en 2021)`);
    } else if (is3qPERatio > 25) {
      topSignals += 1;
      reasons.push(`P/E ${is3qPERatio.toFixed(1)} — Quality caro por encima de su media histórica (~21)`);
    }
  }

  let multiplier: number;
  let zone: CycleTopSignal["zone"];
  let trimPct = 0;

  if (topSignals >= 3.5) {
    multiplier = 0.15; zone = "EXTREME"; trimPct = 80;
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
  if (is3qRsiWeekly !== undefined) parts.push(`RSI-W ${is3qRsiWeekly.toFixed(0)}`);
  if (is3qPERatio !== undefined) parts.push(`P/E ${is3qPERatio.toFixed(1)}`);
  const indicatorValue = parts.join(" · ") || "Sin datos";

  return {
    asset: "MSCI World Quality",
    ticker: "IS3Q.DE",
    allocationMultiplier: multiplier,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Ciclo saludable — sin señales de techo en Quality",
    indicator: "RSI Semanal IS3Q + P/E MSCI World",
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
function detectEMXCTop(inputs: CycleTopInputs): CycleTopSignal {
  const { emxcRsiWeekly, emxcPERatio } = inputs;

  if (emxcRsiWeekly === undefined && emxcPERatio === undefined) {
    return {
      asset: "Emerging Markets",
      ticker: "EMXC.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de RSI semanal ni P/E — introduce emxcRsiWeekly y emxcPERatio para activar esta señal",
      indicator: "RSI Semanal EEM + P/E Emergentes",
      indicatorValue: "Sin datos",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  let topSignals = 0;
  const reasons: string[] = [];

  // Evaluar RSI semanal (umbrales más altos porque EM es más volátil)
  if (emxcRsiWeekly !== undefined) {
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

  // Evaluar P/E del MSCI Emerging Markets
  // Rango histórico P/E EM: ~10-12 en crisis, ~15 media, ~18-20 caro, >22 solo burbuja 2010.
  if (emxcPERatio !== undefined) {
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

  if (topSignals >= 3) {
    multiplier = 0.15; zone = "EXTREME"; trimPct = 80;
  } else if (topSignals >= 2) {
    multiplier = 0.35; zone = "DANGER";  trimPct = 60;
  } else if (topSignals >= 1) {
    multiplier = 0.55; zone = "CAUTION"; trimPct = 35;
  } else if (topSignals >= 0.5) {
    multiplier = 0.75; zone = "CAUTION"; trimPct = 15;
  } else {
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
  }

  const parts: string[] = [];
  if (emxcRsiWeekly !== undefined) parts.push(`RSI-W ${emxcRsiWeekly.toFixed(0)}`);
  if (emxcPERatio !== undefined) parts.push(`P/E ${emxcPERatio.toFixed(1)}`);
  const indicatorValue = parts.join(" · ") || "Sin datos";

  return {
    asset: "Emerging Markets",
    ticker: "EMXC.DE",
    allocationMultiplier: multiplier,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "Emergentes en zona saludable — sin señales de techo",
    indicator: "RSI Semanal EEM + P/E Emergentes",
    indicatorValue,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── XNAS (NASDAQ 100) ──────────────────────────────────────────────
// NASDAQ 100 es el índice tecnológico por excelencia. Su P/E histórico
// es más alto que el del S&P 500 (~25-30 media) por el sesgo a crecimiento.
//
// Señales de techo:
//   RSI Semanal > 80 → sobrecompra. > 85 → extrema (solo en 2020 y 2024).
//   P/E > 35 → caro incluso para NASDAQ. > 45 → burbuja dot-com 2.0.
function detectXNASConPEGrowthTop(inputs: CycleTopInputs): CycleTopSignal {
  const { xnasRsiWeekly, xnasPERatio } = inputs;

  if (xnasRsiWeekly === undefined && xnasPERatio === undefined) {
    return {
      asset: "NASDAQ 100",
      ticker: "XNAS.DE",
      allocationMultiplier: 1.0,
      zone: "SAFE",
      reason: "Sin datos de RSI semanal ni P/E — introduce xnasRsiWeekly y xnasPERatio para activar esta señal",
      indicator: "RSI Semanal NDX + P/E NASDAQ 100",
      indicatorValue: "Sin datos",
      shouldTrim: false,
      trimPct: 0,
    };
  }

  let topSignals = 0;
  const reasons: string[] = [];

  // Evaluar RSI semanal del NASDAQ 100 (^NDX)
  if (xnasRsiWeekly !== undefined) {
    if (xnasRsiWeekly > 88) {
      topSignals += 2;
      reasons.push(`RSI semanal NDX ${xnasRsiWeekly.toFixed(0)} — sobrecompra extrema en NASDAQ`);
    } else if (xnasRsiWeekly > 82) {
      topSignals += 1.5;
      reasons.push(`RSI semanal NDX ${xnasRsiWeekly.toFixed(0)} — sobrecompra severa en NASDAQ`);
    } else if (xnasRsiWeekly > 75) {
      topSignals += 1;
      reasons.push(`RSI semanal NDX ${xnasRsiWeekly.toFixed(0)} — sobrecompra en NASDAQ`);
    }
  }

  // Evaluar P/E del NASDAQ 100
  // Rango histórico: ~20 en crisis, ~28-32 media, ~35 caro, ~45 burbuja dot-com, ~65 en 2021.
  // El P/E del NASDAQ en 2024-2026 está artificialmente alto por el peso de Nvidia/Tesla.
  if (xnasPERatio !== undefined) {
    if (xnasPERatio > 50) {
      topSignals += 3;
      reasons.push(`P/E ${xnasPERatio.toFixed(1)} — NASDAQ en burbuja tecnológica (solo visto en 2000 y 2021)`);
    } else if (xnasPERatio > 40) {
      topSignals += 2;
      reasons.push(`P/E ${xnasPERatio.toFixed(1)} — NASDAQ extremadamente caro (niveles pre-corrección)`);
    } else if (xnasPERatio > 30) {
      topSignals += 1;
      reasons.push(`P/E ${xnasPERatio.toFixed(1)} — NASDAQ por encima de su media histórica (~28)`);
    }
  }

  let multiplier: number;
  let zone: CycleTopSignal["zone"];
  let trimPct = 0;

  if (topSignals >= 4) {
    multiplier = 0.10; zone = "EXTREME"; trimPct = 80;
  } else if (topSignals >= 2.5) {
    multiplier = 0.30; zone = "DANGER";  trimPct = 60;
  } else if (topSignals >= 1.5) {
    multiplier = 0.50; zone = "CAUTION"; trimPct = 35;
  } else if (topSignals >= 0.5) {
    multiplier = 0.70; zone = "CAUTION"; trimPct = 15;
  } else {
    multiplier = 1.0;  zone = "SAFE";    trimPct = 0;
  }

  const parts: string[] = [];
  if (xnasRsiWeekly !== undefined) parts.push(`RSI-W ${xnasRsiWeekly.toFixed(0)}`);
  if (xnasPERatio !== undefined) parts.push(`P/E ${xnasPERatio.toFixed(1)}`);
  const indicatorValue = parts.join(" · ") || "Sin datos";

  return {
    asset: "NASDAQ 100",
    ticker: "XNAS.DE",
    allocationMultiplier: multiplier,
    zone,
    reason: reasons.length > 0 ? reasons.join(" · ") : "NASDAQ en zona saludable — sin señales de techo",
    indicator: "RSI Semanal NDX + P/E NASDAQ 100",
    indicatorValue,
    shouldTrim: trimPct > 0,
    trimPct,
  };
}

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────
export function detectCycleTops(inputs: CycleTopInputs): CycleTopOutput {
  const signals: CycleTopSignal[] = [
    detectBTCTop(inputs),
    detectUraniumTop(inputs),
    detectSemisTop(inputs),
    detectGoldTop(inputs),
    detectIS3QTop(inputs),
    detectEMXCTop(inputs),
    detectXNASConPEGrowthTop(inputs),
  ];

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