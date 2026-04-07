// ===============================================
// ARCHIVO: src/core/risk/tailRisk.ts
// OLYMPUS V5 — Kill Switch Granular de 5 Niveles
// ===============================================
// ANTES (V4.1): 3 triggers de drawdown (>10%, >15%, >25%)
// AHORA (V5):   5 niveles granulares con acciones específicas por nivel
//
// SPEC V5 — Kill Switch completo:
//   DD  5% →  reducción preventiva -15% exposición
//   DD 10% →  reducción moderada   -35% exposición
//   DD 15% →  modo defensivo       -50% exposición
//   DD 20% →  salida casi total    -65% exposición
//   DD 25% →  protección máxima    -70% exposición (igual que antes)
//
// RAZÓN del cambio:
//   El drawdown -50% histórico del backtest ocurrió porque el motor
//   no reaccionaba hasta DD>10%. Para entonces el daño ya era grande.
//   Con triggers en DD>5%, el motor frena antes de que la rueda se salga.
//
// FILOSOFÍA:
//   "Es más fácil recuperar -5% que -20%.
//    La matemática del drawdown es asimétrica:
//    -20% necesita +25% para recuperarse.
//    -50% necesita +100%."
//
// ADICIÓN V5: correlación dinámica
//   Si todos los activos se correlacionan hacia 1 (crisis sistémica),
//   la diversificación falla y el overlay se endurece adicional -10%.
// ===============================================

export interface TailRiskInput {
  drawdown: number;              // drawdown actual en decimal (ej: -0.15 = -15%)
  vix: number;                   // VIX actual
  creditSpread: number;          // credit spread HY-IG en %
  stressScore: number;           // score del GlobalStress [0-9]
  portfolioVolatility?: number;  // volatilidad realizada del portfolio
  // V5: correlación dinámica
  avgCorrelation?: number;       // correlación media entre activos [0, 1]
}

export interface TailRiskOutput {
  overlay: number;               // multiplicador final [0.25, 1.0]
  isActive: boolean;
  triggerReason: string;

  // V5: Kill switch level detail
  killSwitchLevel: 0 | 1 | 2 | 3 | 4 | 5;  // 0=off, 5=máximo
  killSwitchName: string;
  exposureReduction: number;    // % de reducción efectiva [0, 0.70]

  // Componentes separados
  drawdownOverlay: number;      // overlay solo por drawdown
  volatilityReduction: number;  // reducción adicional por alta volatilidad
  correlationPenalty: number;   // penalización adicional por correlación → 1

  // V4.1 PRO compat
  maxBtcWeightActive: boolean;
}

// ── KILL SWITCH GRANULAR V5 ───────────────────────────────────────────────
function computeKillSwitch(drawdown: number): {
  level: 0 | 1 | 2 | 3 | 4 | 5;
  name: string;
  overlay: number;
  exposureReduction: number;
} {
  const dd = Math.abs(drawdown);  // trabajar con positivos

  if (dd >= 0.25) {
    return {
      level: 5,
      name: 'PROTECCIÓN MÁXIMA',
      overlay: 0.30,        // -70% exposición
      exposureReduction: 0.70,
    };
  }
  if (dd >= 0.20) {
    return {
      level: 4,
      name: 'SALIDA CASI TOTAL',
      overlay: 0.35,        // -65% exposición
      exposureReduction: 0.65,
    };
  }
  if (dd >= 0.15) {
    return {
      level: 3,
      name: 'MODO DEFENSIVO',
      overlay: 0.50,        // -50% exposición
      exposureReduction: 0.50,
    };
  }
  if (dd >= 0.10) {
    return {
      level: 2,
      name: 'REDUCCIÓN MODERADA',
      overlay: 0.65,        // -35% exposición
      exposureReduction: 0.35,
    };
  }
  if (dd >= 0.05) {
    return {
      level: 1,
      name: 'REDUCCIÓN PREVENTIVA',
      overlay: 0.85,        // -15% exposición
      exposureReduction: 0.15,
    };
  }

  return {
    level: 0,
    name: 'SIN TRIGGER',
    overlay: 1.0,
    exposureReduction: 0,
  };
}

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────────────
export function computeTailRiskOverlay(input: TailRiskInput): TailRiskOutput {
  const { drawdown, vix, creditSpread, stressScore } = input;
  const portfolioVol = input.portfolioVolatility ?? 0;
  const avgCorr = input.avgCorrelation ?? 0;

  // ── 1. DRAWDOWN KILL SWITCH (5 niveles) ────────────────────────────────
  const killSwitch = computeKillSwitch(drawdown);

  // ── 2. VOLATILITY REDUCTION (V4.1 PRO compat) ─────────────────────────
  let volatilityReduction = 0;
  if (portfolioVol > 0.35) {
    volatilityReduction = 0.45;   // -45% si vol extrema > 35%
  } else if (portfolioVol > 0.30) {
    volatilityReduction = 0.35;   // -35% si vol > 30%
  } else if (portfolioVol > 0.25) {
    volatilityReduction = 0.20;   // -20% si vol > 25%
  }

  // ── 3. CRISIS SISTÉMICA (VIX + Credit Spread simultáneos) ─────────────
  let systemicCrisisOverlay = 1.0;
  let systemicReason = '';
  if (vix > 40 && creditSpread > 5) {
    systemicCrisisOverlay = 0.35;   // pánico + estrés de crédito extremo
    systemicReason = `VIX ${vix.toFixed(0)} + Spread ${creditSpread.toFixed(1)}% — mercado disfuncional`;
  } else if (vix > 35 && creditSpread > 3.5) {
    systemicCrisisOverlay = 0.45;
    systemicReason = `VIX ${vix.toFixed(0)} + Spread ${creditSpread.toFixed(1)}% — stress sistémico`;
  } else if (vix > 30 && stressScore >= 7) {
    systemicCrisisOverlay = 0.60;
    systemicReason = `VIX ${vix.toFixed(0)} + Stress ${stressScore}/9 — presión elevada`;
  }

  // ── 4. PENALIZACIÓN POR CORRELACIÓN → 1 (V5 nuevo) ────────────────────
  // Cuando todos los activos se correlacionan en crisis, la diversificación falla
  // La protección del HRP ya no funciona → overlay adicional
  let correlationPenalty = 0;
  if (avgCorr > 0.85) {
    correlationPenalty = 0.20;   // correlación casi perfecta: diversificación inútil
  } else if (avgCorr > 0.70) {
    correlationPenalty = 0.10;   // correlación alta: diversificación reducida
  }

  // ── 5. OVERLAY FINAL: el más restrictivo gana ──────────────────────────
  // Primero: tomar el más restrictivo entre drawdown y crisis sistémica
  const baseOverlay = Math.min(killSwitch.overlay, systemicCrisisOverlay);

  // Luego aplicar reducciones adicionales (multiplicativas)
  const afterVol = baseOverlay * (1 - volatilityReduction);
  const afterCorr = afterVol * (1 - correlationPenalty);

  // Floor: nunca reducir a menos del 25% (necesitamos posiciones mínimas)
  const finalOverlay = Math.max(0.25, afterCorr);

  // ── TRIGGER REASON ─────────────────────────────────────────────────────
  const reasons: string[] = [];
  if (killSwitch.level > 0) {
    const ddPct = (Math.abs(drawdown) * 100).toFixed(1);
    reasons.push(`DD -${ddPct}% → Kill Switch L${killSwitch.level} (${killSwitch.name})`);
  }
  if (systemicReason) reasons.push(systemicReason);
  if (volatilityReduction > 0) {
    reasons.push(`Vol ${(portfolioVol * 100).toFixed(1)}% → -${(volatilityReduction * 100).toFixed(0)}%`);
  }
  if (correlationPenalty > 0) {
    reasons.push(`Correlación ${(avgCorr * 100).toFixed(0)}% → -${(correlationPenalty * 100).toFixed(0)}%`);
  }

  const isActive = finalOverlay < 0.99;

  return {
    overlay: finalOverlay,
    isActive,
    triggerReason: reasons.join(' | ') || '',
    killSwitchLevel: killSwitch.level,
    killSwitchName: killSwitch.name,
    exposureReduction: 1 - finalOverlay,
    drawdownOverlay: killSwitch.overlay,
    volatilityReduction,
    correlationPenalty,
    maxBtcWeightActive: false,  // V4.1 PRO compat — se calcula en olympusV3.ts
  };
}