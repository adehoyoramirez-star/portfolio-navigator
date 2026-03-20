// ===============================================
// ARCHIVO: src/core/macro/regimeDuration.ts
// Regime Duration Weighting — madurez del régimen
// ===============================================
// Un régimen que empezó ayer ≠ un régimen que lleva 8 meses.
//
// La teoría: los regímenes económicos tienen duración media histórica.
//   EXPANSION:   media ~18 meses, máx ~120 meses (ciclo alcista)
//   CONTRACTION: media ~10 meses
//   CRISIS:      media ~4 meses (son intensos pero cortos)
//
// Implicaciones para el portfolio:
//   - CRISIS joven (1-2 meses):  máxima cautela, no tocar nada
//   - CRISIS madura (4-6 meses): preparar modo ataque, el fondo se acerca
//   - CRISIS vieja (>6 meses):   reducir penalización, acumular
//
//   - EXPANSION joven:  puede durar años, no ser tímido
//   - EXPANSION madura: vigilar señales de agotamiento (CEWS)
//   - EXPANSION vieja:  reducir riesgo gradualmente
//
// Integración: ajusta regimePenalty del masterRegime según duración
// ===============================================

export type RegimeLabel = "EXPANSION" | "CONTRACTION" | "CRISIS";

export interface RegimeDurationInput {
  currentRegime: RegimeLabel;
  regimeStartDate: string;    // ISO date de cuándo empezó el régimen actual
  currentDate?: string;       // ISO date del día actual (default: ahora)
}

export interface RegimeDurationOutput {
  regime: RegimeLabel;
  weeksInRegime: number;
  monthsInRegime: number;
  maturityPhase: "YOUNG" | "MATURE" | "OLD";
  durationAdjustment: number; // multiplicador sobre regimePenalty [-0.15, +0.10]
  signal: string;             // texto explicativo
  attackReadiness: number;    // [0,1] — qué tan cerca estamos del punto de ataque
}

// Duración media histórica en meses por régimen
const REGIME_MEAN_MONTHS: Record<RegimeLabel, number> = {
  EXPANSION:   18,
  CONTRACTION: 10,
  CRISIS:       4,
};

// Fases de madurez: joven / maduro / viejo
// (como % de la duración media)
const PHASE_THRESHOLDS = {
  YOUNG:  0.40,  // 0% – 40% de la duración media
  MATURE: 0.80,  // 40% – 80%
  // OLD: > 80%
};

export function computeRegimeDuration(input: RegimeDurationInput): RegimeDurationOutput {
  const now = new Date(input.currentDate ?? Date.now());
  const start = new Date(input.regimeStartDate);
  const msElapsed = now.getTime() - start.getTime();
  const daysElapsed = Math.max(0, msElapsed / (1000 * 60 * 60 * 24));
  const weeksInRegime = daysElapsed / 7;
  const monthsInRegime = daysElapsed / 30.44;

  const meanMonths = REGIME_MEAN_MONTHS[input.currentRegime];
  const maturityRatio = monthsInRegime / meanMonths;

  // Fase de madurez
  let maturityPhase: "YOUNG" | "MATURE" | "OLD";
  if (maturityRatio < PHASE_THRESHOLDS.YOUNG) {
    maturityPhase = "YOUNG";
  } else if (maturityRatio < PHASE_THRESHOLDS.MATURE) {
    maturityPhase = "MATURE";
  } else {
    maturityPhase = "OLD";
  }

  // Ajuste sobre regimePenalty y attackReadiness según régimen + fase
  let durationAdjustment: number;
  let attackReadiness: number;
  let signal: string;

  switch (input.currentRegime) {
    case "CRISIS":
      if (maturityPhase === "YOUNG") {
        // Crisis reciente: máxima cautela adicional
        durationAdjustment = -0.10;
        attackReadiness = 0.0;
        signal = `Crisis joven (${monthsInRegime.toFixed(1)}m). No actuar. Esperar al menos ${(meanMonths * PHASE_THRESHOLDS.MATURE).toFixed(0)} meses.`;
      } else if (maturityPhase === "MATURE") {
        // Crisis en desarrollo: empezar a vigilar
        durationAdjustment = -0.05;
        attackReadiness = 0.3;
        signal = `Crisis madura (${monthsInRegime.toFixed(1)}m / media ${meanMonths}m). Vigilar señales de fondo. Preparar liquidez.`;
      } else {
        // Crisis vieja: probable fondo cercano, reducir penalización
        durationAdjustment = +0.08;
        attackReadiness = 0.7;
        signal = `Crisis prolongada (${monthsInRegime.toFixed(1)}m >> media ${meanMonths}m). Estadísticamente cerca del fondo. Preparar ataque.`;
      }
      break;

    case "CONTRACTION":
      if (maturityPhase === "YOUNG") {
        durationAdjustment = -0.05;
        attackReadiness = 0.1;
        signal = `Contracción joven (${monthsInRegime.toFixed(1)}m). Puede empeorar. Reducir exposición gradualmente.`;
      } else if (maturityPhase === "MATURE") {
        durationAdjustment = 0.0;
        attackReadiness = 0.4;
        signal = `Contracción madura (${monthsInRegime.toFixed(1)}m / media ${meanMonths}m). Mantener plan defensivo.`;
      } else {
        durationAdjustment = +0.05;
        attackReadiness = 0.6;
        signal = `Contracción prolongada (${monthsInRegime.toFixed(1)}m). Históricamente próxima a girar. Vigilar señales de recuperación.`;
      }
      break;

    case "EXPANSION":
    default:
      if (maturityPhase === "YOUNG") {
        durationAdjustment = +0.05;
        attackReadiness = 1.0;
        signal = `Expansión joven (${monthsInRegime.toFixed(1)}m). Ciclo alcista en inicio. Máxima exposición justificada.`;
      } else if (maturityPhase === "MATURE") {
        durationAdjustment = 0.0;
        attackReadiness = 0.8;
        signal = `Expansión madura (${monthsInRegime.toFixed(1)}m / media ${meanMonths}m). Mantener posiciones, vigilar señales de agotamiento.`;
      } else {
        durationAdjustment = -0.05;
        attackReadiness = 0.5;
        signal = `Expansión prolongada (${monthsInRegime.toFixed(1)}m >> media ${meanMonths}m). Ciclo envejecido. Activar CEWS, reducir riesgo incremental.`;
      }
      break;
  }

  return {
    regime: input.currentRegime,
    weeksInRegime,
    monthsInRegime,
    maturityPhase,
    durationAdjustment,
    signal,
    attackReadiness,
  };
}

// ── GESTIÓN DE HISTORIAL DE RÉGIMEN ─────────────────────────────────────────
// Detecta cuándo cambió el régimen basándose en el historial de RegimeHistory
export function detectRegimeStartDate(
  regimeHistory: { timestamp: string; regime: string }[],
  currentRegime: string,
): string {
  if (regimeHistory.length === 0) {
    // Sin historial: asumir que el régimen lleva 1 mes
    return new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  }

  // Buscar hacia atrás hasta el primer cambio de régimen
  const reversed = [...regimeHistory].reverse();
  for (let i = 0; i < reversed.length; i++) {
    if (reversed[i].regime !== currentRegime) {
      // El cambio ocurrió entre reversed[i] y reversed[i-1]
      return reversed[i - 1]?.timestamp ?? reversed[0].timestamp;
    }
  }

  // Todo el historial es el mismo régimen
  return regimeHistory[0].timestamp;
}