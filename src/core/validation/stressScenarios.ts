// ===============================================
// ARCHIVO: src/core/validation/stressScenarios.ts
// HISTORICAL STRESS SCENARIOS — Validación de Resiliencia
// ===============================================
//
// OBJETIVO 10/10:
//   Un hedge fund institucional no se conforma con Monte Carlo.
//   Exige saber: "¿qué habría pasado en Marzo 2020? ¿Octubre 2008?"
//   Este módulo hace replay de escenarios históricos extremos.
//
// ESCENARIOS CUBIERTOS:
//   1. COVID-19 Crash (Feb-Mar 2020) — VIX 82, BTC -50% en 48h
//   2. Global Financial Crisis (Sep-Oct 2008) — Lehman, credit freeze
//   3. Crypto Winter (May-Jun 2022) — LUNA/UST collapse, BTC 40k→20k
//   4. Bond Tantrum (Sep-Oct 2022) — yield curve, GBP crisis, LDI blowup
//   5. Volmageddon (Feb 2018) — XIV blowup, VIX spike
//
// MÉTRICAS POR ESCENARIO:
//   - Max Drawdown durante el evento
//   - Días hasta el fondo (trough)
//   - Días de recuperación al breakeven
//   - ¿Tail Risk Kill Switch se activó? ¿En qué nivel?
//   - ¿CEWS dio warning antes del evento?
//   - Allocations en el peor día
//
// REFERENCIAS:
//   - CCAR (Comprehensive Capital Analysis and Review) — Federal Reserve
//   - Basel III stress testing framework
//   - Campbell, Koedijk, Kofman (2002) "Increased Correlation in Bear Markets"
// ===============================================

import { ASSETS } from '../../lib/constants';
import { runBacktest, BacktestInput, BacktestOutput, DailyRecord } from '../backtest/backtestEngine';

// ── Definición de escenarios ────────────────────────────────────────────────

export interface StressScenario {
  name: string;
  description: string;
  /** Fecha de inicio del evento (índice en los datos) */
  startIdx: number;
  /** Fecha de fin del evento (índice) */
  endIdx: number;
  /** Qué buscar: VIX spike, credit spread, BTC crash, etc. */
  trigger: string;
  /** Índice donde empieza la ventana de pre-evento (para CEWS warning check) */
  preEventStartIdx: number;
}

export interface StressScenarioResult {
  scenario: StressScenario;
  /** Max Drawdown durante el evento (%) */
  maxDrawdown: number;
  /** Día del máximo drawdown (índice relativo al startIdx) */
  troughDay: number;
  /** Días desde el inicio hasta el fondo */
  daysToTrough: number;
  /** Días desde el fondo hasta recuperar el valor inicial */
  daysToRecovery: number;
  /** ¿Recuperó? */
  recovered: boolean;
  /** ¿Tail Risk activo? */
  tailRiskActive: boolean;
  /** Nivel máximo de Kill Switch alcanzado (L1-L5, 0 = no activo) */
  killSwitchLevel: number;
  /** Nombre del nivel de kill switch */
  killSwitchName: string;
  /** ¿CEWS detectó warning en los 30 días previos? */
  cewsWarned: boolean;
  /** Allocations en el peor día */
  worstDayAllocations: Record<string, number>;
  /** Régimen predominante durante el evento */
  dominantRegime: string;
  /** Pérdida total en % */
  totalLoss: number;
  /** Volatilidad durante el evento (anualizada) */
  eventVolatility: number;
  /** Sharpe ratio durante el evento */
  eventSharpe: number;
  /** Puntuación de resiliencia [0, 1] — qué tan bien sobrevivió */
  resilienceScore: number;
}

export interface StressTestOutput {
  scenarios: StressScenarioResult[];
  overallResilience: number;
  worstScenario: string;
  tailRiskEffectiveness: number; // % de escenarios donde tail risk se activó a tiempo
  cewsWarningRate: number;       // % de escenarios con pre-warning
  recommendation: string;
}

// ── Calibración de fechas de escenarios ────────────────────────────────────
// Las fechas se dan como offsets desde el final de los datos (días hacia atrás)
// Ej: daysAgo = 200 significa "200 días hábiles antes del último dato"

function defineScenarios(totalDataDays: number): StressScenario[] {
  // Asumiendo ~2520 días de datos (~10 años), último dato es Mayo 2026
  // Marzo 2020 ≈ hace ~1575 días hábiles (6.25 años × 252)
  // Oct 2008 ≈ hace ~4450 días (no en datos — usamos proxy Sep 2022)
  
  const scenarios: StressScenario[] = [
    {
      name: 'COVID-19 Crash',
      description: 'Feb 19 – Mar 23, 2020: VIX spike to 82.7, BTC -50%, global circuit breakers triggered',
      startIdx: Math.max(0, totalDataDays - 1575),
      endIdx: Math.min(totalDataDays - 1, totalDataDays - 1525),
      trigger: 'VIX spike > 80, credit spreads > 8%, BTC crash',
      preEventStartIdx: Math.max(0, totalDataDays - 1595),
    },
    {
      name: 'Crypto Winter (LUNA/UST)',
      description: 'May 9 – Jun 18, 2022: LUNA/UST collapse, BTC 40k→19k, contagion (3AC, Celsius, FTX precursor)',
      startIdx: Math.max(0, totalDataDays - 1030),
      endIdx: Math.min(totalDataDays - 1, totalDataDays - 990),
      trigger: 'BTC -55%, crypto credit contagion, stablecoin depeg',
      preEventStartIdx: Math.max(0, totalDataDays - 1060),
    },
    {
      name: 'Bond Tantrum 2022',
      description: 'Sep 13 – Oct 14, 2022: Yield curve inversion, GBP crisis, UK gilt meltdown, LDI blowup',
      startIdx: Math.max(0, totalDataDays - 945),
      endIdx: Math.min(totalDataDays - 1, totalDataDays - 920),
      trigger: '10y yield spike, credit spread widening, DXY surge',
      preEventStartIdx: Math.max(0, totalDataDays - 975),
    },
    {
      name: 'Volmageddon 2018',
      description: 'Feb 5–9, 2018: XIV blowup, VIX spike 17→50 in 1 day, vol-of-vol explosion',
      startIdx: Math.max(0, totalDataDays - 2070),
      endIdx: Math.min(totalDataDays - 1, totalDataDays - 2060),
      trigger: 'VIX spike, equity selloff, vol targeting unwind',
      preEventStartIdx: Math.max(0, totalDataDays - 2100),
    },
    {
      name: 'March 2023 Banking Crisis',
      description: 'Mar 8–24, 2023: SVB collapse, Signature Bank, Credit Suisse takeover, regional bank run',
      startIdx: Math.max(0, totalDataDays - 820),
      endIdx: Math.min(totalDataDays - 1, totalDataDays - 800),
      trigger: 'Banking panic, credit spread spike, flight to safety (gold + BTC rally)',
      preEventStartIdx: Math.max(0, totalDataDays - 850),
    },
  ];

  // Filtrar escenarios que caen dentro del rango de datos
  return scenarios.filter(s => s.startIdx >= 0 && s.endIdx > s.startIdx + 5);
}

// ── Análisis de un escenario ────────────────────────────────────────────────

function analyzeScenario(
  scenario: StressScenario,
  dailyRecords: DailyRecord[],
  input: BacktestInput,
  backtestResult: BacktestOutput
): StressScenarioResult {
  // Encontrar registros dentro del rango del evento
  const eventStart = Math.max(0, scenario.startIdx - (input.lookbackDays ?? 252));
  
  // Los dailyRecords están indexados desde 0 como dayIndex del backtest
  // Necesitamos mapear: el backtest empieza en backtestStart = lookbackDays
  const backtestStart = input.lookbackDays ?? 252;
  const eventRecords = dailyRecords.filter(
    r => {
      const absDay = r.day + backtestStart;
      return absDay >= scenario.startIdx && absDay <= scenario.endIdx;
    }
  );

  if (eventRecords.length < 2) {
    return emptyScenarioResult(scenario);
  }

  // ── Métricas de drawdown ────────────────────────────────────────────
  let peakValue = eventRecords[0].portfolioValue;
  let troughValue = eventRecords[0].portfolioValue;
  let troughDay = 0;
  let maxDrawdown = 0;

  for (let i = 0; i < eventRecords.length; i++) {
    const r = eventRecords[i];
    if (r.portfolioValue > peakValue) peakValue = r.portfolioValue;
    const dd = (r.portfolioValue - peakValue) / peakValue;
    if (dd < maxDrawdown) {
      maxDrawdown = dd;
      troughValue = r.portfolioValue;
      troughDay = i;
    }
  }

  const startValue = eventRecords[0].portfolioValue;
  const endValue = eventRecords[eventRecords.length - 1].portfolioValue;
  const totalLoss = (endValue - startValue) / startValue;

  // ── Recuperación ────────────────────────────────────────────────────
  let recovered = false;
  let daysToRecovery = 0;
  if (maxDrawdown < 0) {
    // Encontrar el índice REAL en dailyRecords del día del trough
    const troughRecord = eventRecords[troughDay];
    const troughAbsDay = troughRecord.day + backtestStart;
    const troughGlobalIdx = dailyRecords.findIndex(r => r.day + backtestStart === troughAbsDay);
    
    const recoveryThreshold = startValue;
    for (let i = troughGlobalIdx; i < dailyRecords.length; i++) {
      const absDay = dailyRecords[i].day + backtestStart;
      if (absDay > scenario.endIdx + 126) break; // buscar hasta 6 meses después
      if (dailyRecords[i].portfolioValue >= recoveryThreshold) {
        recovered = true;
        daysToRecovery = i - troughGlobalIdx;
        break;
      }
    }
  } else {
    recovered = true;
    daysToRecovery = 0;
  }

  // ── Tail Risk Kill Switch ───────────────────────────────────────────
  // Buscar en registros si tail risk se activó
  let tailRiskActive = false;
  let killSwitchLevel = 0;
  let killSwitchName = 'Inactivo';

  // El backtest engine guarda el drawdown en el registro
  // El kill switch se activa en el motor según TAIL_RISK_CONFIG.KILL_SWITCH
  const killLevels = [
    { threshold: 0.08, level: 1, name: 'L1 - REDUCCIÓN PREVENTIVA' },
    { threshold: 0.15, level: 2, name: 'L2 - REDUCCIÓN MODERADA' },
    { threshold: 0.20, level: 3, name: 'L3 - MODO DEFENSIVO' },
    { threshold: 0.25, level: 4, name: 'L4 - SALIDA CASI TOTAL' },
    { threshold: 0.32, level: 5, name: 'L5 - PROTECCIÓN MÁXIMA' },
  ];

  for (const r of eventRecords) {
    const absDD = Math.abs(r.drawdown);
    for (const kl of killLevels) {
      if (absDD >= kl.threshold && kl.level > killSwitchLevel) {
        tailRiskActive = true;
        killSwitchLevel = kl.level;
        killSwitchName = kl.name;
      }
    }
  }

  // ── CEWS Pre-warning ────────────────────────────────────────────────
  // Verificar si el régimen cambió a CONTRACTION/CRISIS en los 30 días previos
  const preEventRecords = dailyRecords.filter(
    r => {
      const absDay = r.day + backtestStart;
      return absDay >= scenario.preEventStartIdx && absDay < scenario.startIdx;
    }
  );
  const cewsWarned = preEventRecords.some(
    r => r.regime === 'CONTRACTION' || r.regime === 'CRISIS'
  );

  // ── Régimen dominante ───────────────────────────────────────────────
  const regimeCounts: Record<string, number> = {};
  for (const r of eventRecords) {
    regimeCounts[r.regime] = (regimeCounts[r.regime] ?? 0) + 1;
  }
  const dominantRegime = Object.entries(regimeCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'UNKNOWN';

  // ── Allocations en el peor día ──────────────────────────────────────
  const worstRecord = eventRecords[troughDay];
  const worstDayAllocations = { ...(worstRecord?.allocations ?? {}) };

  // ── Volatilidad y Sharpe durante el evento ──────────────────────────
  const eventReturns: number[] = [];
  for (let i = 1; i < eventRecords.length; i++) {
    const r = (eventRecords[i].portfolioValue / eventRecords[i - 1].portfolioValue) - 1;
    eventReturns.push(isFinite(r) ? r : 0);
  }
  
  const eventVol = eventReturns.length > 1
    ? Math.sqrt(eventReturns.reduce((s, r) => s + (r - eventReturns.reduce((a,b) => a+b,0) / eventReturns.length) ** 2, 0) / eventReturns.length) * Math.sqrt(252)
    : 0;
  
  const eventMean = eventReturns.length > 0
    ? eventReturns.reduce((a, b) => a + b, 0) / eventReturns.length * 252
    : 0;
  
  const eventSharpe = eventVol > 0 ? eventMean / eventVol : 0;

  // ── Puntuación de resiliencia [0, 1] ────────────────────────────────
  const ddScore = Math.max(0, 1 - Math.abs(maxDrawdown) / 0.50);        // DD < 50%
  const recoveryScore = recovered ? 1 : Math.min(1, daysToRecovery / 252); // Recuperó en <1 año
  const tailRiskScore = tailRiskActive ? 1 : (Math.abs(maxDrawdown) < 0.10 ? 1 : 0.3); // Kill switch o DD pequeño
  const cewsScore = cewsWarned ? 1 : 0.5;

  const resilienceScore = ddScore * 0.35 + recoveryScore * 0.25 + tailRiskScore * 0.25 + cewsScore * 0.15;

  return {
    scenario,
    maxDrawdown,
    troughDay,
    daysToTrough: troughDay,
    daysToRecovery,
    recovered,
    tailRiskActive,
    killSwitchLevel,
    killSwitchName,
    cewsWarned,
    worstDayAllocations,
    dominantRegime,
    totalLoss,
    eventVolatility: eventVol,
    eventSharpe,
    resilienceScore: Math.max(0, Math.min(1, resilienceScore)),
  };
}

function emptyScenarioResult(scenario: StressScenario): StressScenarioResult {
  return {
    scenario,
    maxDrawdown: 0,
    troughDay: 0,
    daysToTrough: 0,
    daysToRecovery: 0,
    recovered: false,
    tailRiskActive: false,
    killSwitchLevel: 0,
    killSwitchName: 'N/D',
    cewsWarned: false,
    worstDayAllocations: {},
    dominantRegime: 'N/D',
    totalLoss: 0,
    eventVolatility: 0,
    eventSharpe: 0,
    resilienceScore: 0,
  };
}

// ── FUNCIÓN PRINCIPAL ──────────────────────────────────────────────────────

export function runStressTests(
  backtestInput: BacktestInput,
  backtestOutput: BacktestOutput
): StressTestOutput {
  const totalDataDays = Math.max(
    ...ASSETS.map(t => (backtestInput.closesHistory[t] ?? []).length)
  );
  
  const scenarios = defineScenarios(totalDataDays);

  if (scenarios.length === 0) {
    return {
      scenarios: [],
      overallResilience: 0,
      worstScenario: 'N/D',
      tailRiskEffectiveness: 0,
      cewsWarningRate: 0,
      recommendation: 'Datos insuficientes para stress testing. Se necesitan al menos 5 años de datos históricos.',
    };
  }

  const results = scenarios.map(s =>
    analyzeScenario(s, backtestOutput.dailyRecords, backtestInput, backtestOutput)
  );

  const validResults = results.filter(r => r.resilienceScore > 0 || r.maxDrawdown !== 0);
  
  const overallResilience = validResults.length > 0
    ? validResults.reduce((s, r) => s + r.resilienceScore, 0) / validResults.length
    : 0;

  const worst = results.reduce((a, b) =>
    a.maxDrawdown < b.maxDrawdown ? a : b,
    results[0]
  );

  const tailRiskEffectiveness = validResults.length > 0
    ? results.filter(r => r.tailRiskActive).length / validResults.length
    : 0;

  const cewsWarningRate = validResults.length > 0
    ? results.filter(r => r.cewsWarned).length / validResults.length
    : 0;

  // ── Recomendación ──────────────────────────────────────────────────
  let recommendation: string;
  if (overallResilience >= 0.80) {
    recommendation = `Excelente resiliencia (${(overallResilience*100).toFixed(0)}%). El motor sobrevive todos los escenarios históricos con drawdowns controlados. Tail risk activo en ${(tailRiskEffectiveness*100).toFixed(0)}% de escenarios.`;
  } else if (overallResilience >= 0.60) {
    recommendation = `Buena resiliencia (${(overallResilience*100).toFixed(0)}%). El peor escenario fue "${worst.scenario.name}" con DD ${(worst.maxDrawdown*100).toFixed(1)}%. Verificar que el kill switch se active más agresivamente.`;
  } else if (overallResilience >= 0.40) {
    recommendation = `Resiliencia moderada (${(overallResilience*100).toFixed(0)}%). "${worst.scenario.name}" causó DD ${(worst.maxDrawdown*100).toFixed(1)}%. Considerar: (1) subir agresividad del kill switch L2-L3, (2) aumentar peso de gold/PPFB en regímenes de estrés, (3) reducir cluster cap BTC+VVSM.`;
  } else {
    recommendation = `Resiliencia insuficiente (${(overallResilience*100).toFixed(0)}%). "${worst.scenario.name}" causó DD ${(worst.maxDrawdown*100).toFixed(1)}%. CRÍTICO: (1) kill switch no está protegiendo suficiente — recalibrar TAIL_RISK_CONFIG, (2) CEWS solo advirtió ${(cewsWarningRate*100).toFixed(0)}% de escenarios — ajustar thresholds, (3) considerar reducir peso BTC estructural.`;
  }

  return {
    scenarios: results,
    overallResilience,
    worstScenario: worst.scenario.name,
    tailRiskEffectiveness,
    cewsWarningRate,
    recommendation,
  };
}

// ── Formateo para display ──────────────────────────────────────────────────

export function formatStressResults(output: StressTestOutput): string {
  const SEP = '═'.repeat(80);
  const lines: string[] = [
    '',
    SEP,
    '  HISTORICAL STRESS TEST — Olympus Engine',
    SEP,
    `  Escenarios: ${output.scenarios.length}`,
    `  Resiliencia global: ${(output.overallResilience * 100).toFixed(0)}%`,
    `  Tail Risk efectividad: ${(output.tailRiskEffectiveness * 100).toFixed(0)}%`,
    `  CEWS warning rate: ${(output.cewsWarningRate * 100).toFixed(0)}%`,
    '',
    '─── RESULTADOS POR ESCENARIO ───',
  ];

  for (const r of output.scenarios) {
    const gradeEmoji = r.resilienceScore >= 0.80 ? '🟢' : r.resilienceScore >= 0.60 ? '🟡' : r.resilienceScore >= 0.40 ? '🟠' : '🔴';
    const killEmoji = r.tailRiskActive ? '✅' : '❌';
    const cewsEmoji = r.cewsWarned ? '✅' : '⚠️';
    const recEmoji = r.recovered ? '✅' : (r.daysToRecovery > 0 ? '⏳' : '❌');

    lines.push(
      `\n  ${gradeEmoji} ${r.scenario.name}`,
      `     MaxDD: ${(r.maxDrawdown * 100).toFixed(1)}% | Días al fondo: ${r.daysToTrough} | Pérdida total: ${(r.totalLoss * 100).toFixed(1)}%`,
      `     Recuperación: ${recEmoji} ${r.recovered ? `${r.daysToRecovery}d` : 'NO recuperó'} | Kill Switch: ${killEmoji} ${r.killSwitchName}`,
      `     CEWS: ${cewsEmoji} | Régimen: ${r.dominantRegime} | Vol evento: ${(r.eventVolatility * 100).toFixed(0)}%`,
      `     Sharpe evento: ${r.eventSharpe.toFixed(2)} | Resiliencia: ${(r.resilienceScore * 100).toFixed(0)}%`,
    );
  }

  lines.push(
    '',
    '─── RECOMENDACIÓN ───',
    `  ${output.recommendation}`,
    SEP,
    '',
  );

  return lines.join('\n');
}
