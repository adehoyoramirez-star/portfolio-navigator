// ===============================================
// ARCHIVO: src/core/benchmark/benchmarkRunner.ts
// SPRINT 3: Benchmark Runner — 60/40 vs Engine
// ===============================================
//
// PROPÓSITO:
//   Ejecutar un benchmark 60/40 en paralelo al motor Olympus para
//   detectar si el engine está underperformando un hold simple.
//
// ALERTA:
//   Si el motor rinde >5% peor que el benchmark en rolling 3 meses,
//   se dispara una advertencia. Esto indica que la complejidad del
//   motor está DESTRUYENDO valor vs una asignación pasiva.
//
// ALMACENAMIENTO:
//   localStorage (persistencia ligera). No toca Supabase.
//   Claves: 'olympus_benchmark_snapshots' + 'olympus_benchmark_returns'
//
// BENCHMARK 60/40 (usando los mismos assets del portfolio):
//   60% Equity:   XNAS.DE (20%) + IS3Q.DE (20%) + VVSM.DE (10%) + EMXC.DE (10%)
//   40% Defensivo: PPFB.DE (25%) + BTC-EUR (10%) + URNU.DE (5%)
//
// Cada activo tiene peso fijo. El benchmark nunca rebalancea.
// Esto mide: "¿qué tal le habría ido a un hold 60/40 sin rebalancear?"
// Frente al motor que sí rebalancea, aplica vol target y tail risk.
// ===============================================

import { ASSETS } from "../../lib/constants";

// ── Constantes del benchmark ─────────────────────────────────────────
const BENCHMARK_WEIGHTS: Record<string, number> = {
  "0P00000WLG.F": 0.35,  // núcleo developed markets (sustituye IS3Q + XNAS)
  "PPFB.DE": 0.20,
  "VVSM.DE": 0.15,
  "EMXC.DE": 0.10,
  "BTC-EUR": 0.10,
  "URNU.DE": 0.10,
};

const UNDERPERFORM_THRESHOLD = 0.05; // 5% underperformance → alerta
const ROLLING_WINDOW_DAYS = 63;     // ~3 meses de trading
const MIN_DATA_POINTS = 63;         // mínimo de snapshots para CAGR anualizado fiable

const STORAGE_KEY_SNAPSHOTS = "olympus_benchmark_snapshots";
const STORAGE_KEY_RETURNS = "olympus_benchmark_returns";
const MAX_SNAPSHOTS = 500;

// ── Interfaces ──────────────────────────────────────────────────────

export interface BenchmarkSnapshot {
  /** ISO timestamp */
  timestamp: string;
  /** Valor total del portfolio en EUR */
  portfolioValue: number;
  /** Fracción del portfolio que el engine tiene invertida [0,1] */
  totalInvested: number;
  /** Régimen actual del engine */
  regime: string;
  /** Precios de cada activo en esta snapshot */
  prices: Record<string, number>;
}

/** Retornos calculados entre dos snapshots consecutivos */
export interface BenchmarkReturnRecord {
  timestamp: string;
  /** Retorno del engine en este periodo */
  engineReturn: number;
  /** Retorno del benchmark 60/40 en este periodo */
  benchmarkReturn: number;
  /** Total investido del engine en esta snapshot */
  totalInvested: number;
  /** Régimen */
  regime: string;
}

export interface BenchmarkStatus {
  /** Retorno anualizado del engine en rolling 3m */
  engineCagr3m: number;
  /** Retorno anualizado del benchmark 60/40 en rolling 3m */
  benchmarkCagr3m: number;
  /** Diferencia: engine - benchmark (positivo = engine ganando) */
  outperformance: number;
  /** True si engine underperforma por >5% en rolling 3m */
  underperformanceAlert: boolean;
  /** Sharpe ratio del engine en rolling 3m */
  engineSharpe3m: number;
  /** Sharpe ratio del benchmark en rolling 3m */
  benchmarkSharpe3m: number;
  /** Número de snapshots disponibles */
  dataPoints: number;
  /** Fecha de la última snapshot */
  lastUpdated: string;
  /** Rendimiento acumulado del engine (desde primera snapshot) */
  engineTotalReturn: number;
  /** Rendimiento acumulado del benchmark (desde primera snapshot) */
  benchmarkTotalReturn: number;
  /** Mensaje legible para el dashboard */
  message: string;
}

// ── Helpers de persistencia ─────────────────────────────────────────

function loadSnapshots(): BenchmarkSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SNAPSHOTS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    console.warn('[Benchmark] Error loading from localStorage');
    return [];
  }
}

function saveSnapshots(snapshots: BenchmarkSnapshot[]): void {
  try {
    const trimmed = snapshots.slice(-MAX_SNAPSHOTS);
    localStorage.setItem(STORAGE_KEY_SNAPSHOTS, JSON.stringify(trimmed));
  } catch {
    console.warn('[Benchmark] localStorage lleno — no se pudieron guardar snapshots');
  }
}

function loadReturnRecords(): BenchmarkReturnRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_RETURNS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    console.warn('[Benchmark] Error loading return records from localStorage');
    return [];
  }
}

function saveReturnRecords(records: BenchmarkReturnRecord[]): void {
  try {
    const trimmed = records.slice(-MAX_SNAPSHOTS);
    localStorage.setItem(STORAGE_KEY_RETURNS, JSON.stringify(trimmed));
  } catch {
    console.warn('[Benchmark] localStorage lleno — no se pudieron guardar retornos');
  }
}

// ── Funciones principales ───────────────────────────────────────────

/**
 * Registra una snapshot del engine y calcula el retorno del benchmark
 * 60/40 desde la última snapshot. Guarda ambos en localStorage.
 *
 * Debe llamarse cada vez que el engine produce un resultado nuevo.
 * La primera llamada solo guarda la snapshot inicial (sin retorno).
 *
 * @param input - Datos de la ejecución actual del engine
 * @returns El BenchmarkReturnRecord calculado, o null si es la primera snapshot
 */
export function recordBenchmarkSnapshot(input: {
  portfolioValue: number;
  totalInvested: number;
  regime: string;
  prices: Record<string, number>;
}): BenchmarkReturnRecord | null {
  const { portfolioValue, totalInvested, regime, prices } = input;

  const snapshot: BenchmarkSnapshot = {
    timestamp: new Date().toISOString(),
    portfolioValue,
    totalInvested,
    regime,
    prices,
  };

  const snapshots = loadSnapshots();

  // Si no hay snapshot anterior, solo guardar esta y salir
  if (snapshots.length === 0) {
    saveSnapshots([snapshot]);
    return null;
  }

  const prev = snapshots[snapshots.length - 1];

  // ── Calcular retorno del engine ──────────────────────────────
  // Usamos el cambio en portfolioValue
  const engineReturn = prev.portfolioValue > 0
    ? (portfolioValue - prev.portfolioValue) / prev.portfolioValue
    : 0;

  // ── Calcular retorno del benchmark 60/40 ─────────────────────
  // Precio relativo de cada activo desde la última snapshot.
  // [FIX-BENCH-SANITY] Sanity checks para evitar explosiones:
  //   - Cap ±50% por activo (ningún activo se mueve >50% entre snapshots de ~60s)
  //   - Cap ±20% retorno total del benchmark
  //   Sin esto, un precio corrupto (ej: 0.01 en vez de 100) causaba CAGR 1080%.
  const MAX_ASSET_RETURN = 0.50;
  const MAX_BENCH_RETURN = 0.20;
  let benchmarkReturn = 0;
  for (const ticker of ASSETS) {
    const oldPrice = prev.prices[ticker] ?? 0;
    const newPrice = prices[ticker] ?? 0;
    const weight = BENCHMARK_WEIGHTS[ticker] ?? 0;

    if (oldPrice > 0 && weight > 0) {
      const assetReturn = (newPrice - oldPrice) / oldPrice;
      // Cap individual: ningún activo sube/baja >50% en un intervalo de snapshot
      const cappedAssetReturn = Math.max(-MAX_ASSET_RETURN, Math.min(MAX_ASSET_RETURN, assetReturn));
      benchmarkReturn += weight * cappedAssetReturn;
    }
  }
  // Cap total: el benchmark completo no puede moverse >20% en un snapshot
  benchmarkReturn = Math.max(-MAX_BENCH_RETURN, Math.min(MAX_BENCH_RETURN, benchmarkReturn));

  // Guardar solo si los retornos son finitos
  const cleanEngineReturn = isFinite(engineReturn) ? engineReturn : 0;
  const cleanBenchmarkReturn = isFinite(benchmarkReturn) ? benchmarkReturn : 0;

  const record: BenchmarkReturnRecord = {
    timestamp: snapshot.timestamp,
    engineReturn: cleanEngineReturn,
    benchmarkReturn: cleanBenchmarkReturn,
    totalInvested,
    regime,
  };

  // Guardar snapshot + retorno
  const updatedSnapshots = [...snapshots, snapshot];
  const returnRecords = [...loadReturnRecords(), record];

  saveSnapshots(updatedSnapshots);
  saveReturnRecords(returnRecords);

  return record;
}

/**
 * Calcula el estado actual del benchmark: retornos rolling 3m,
 * outperformance, y alerta de underperformance.
 */
export function getBenchmarkStatus(): BenchmarkStatus {
  const returnRecords = loadReturnRecords();

  const dataPoints = returnRecords.length;

  const empty = (message: string): BenchmarkStatus => ({
    engineCagr3m: 0,
    benchmarkCagr3m: 0,
    outperformance: 0,
    underperformanceAlert: false,
    engineSharpe3m: 0,
    benchmarkSharpe3m: 0,
    dataPoints,
    lastUpdated: returnRecords.length > 0
      ? returnRecords[returnRecords.length - 1].timestamp
      : new Date().toISOString(),
    engineTotalReturn: 0,
    benchmarkTotalReturn: 0,
    message,
  });

  if (returnRecords.length < 2) {
    return empty("Recolectando datos del benchmark... mínimo 2 snapshots necesarias.");
  }

  // ── Rolling window: últimos ~3 meses de retornos ─────────────
  const now = Date.now();
  const cutoff = now - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const rollingReturns = returnRecords.filter(
    r => new Date(r.timestamp).getTime() >= cutoff
  );

  const windowSize = rollingReturns.length;

  const engineReturns = rollingReturns.map(r => r.engineReturn);
  const benchmarkReturns = rollingReturns.map(r => r.benchmarkReturn);

// ── Retornos acumulados (desde el inicio) ────────────────────
  const engineTotalReturn = returnRecords.reduce(
    (acc, r) => acc * (1 + r.engineReturn), 1
  ) - 1;

  const benchmarkTotalReturn = returnRecords.reduce(
    (acc, r) => acc * (1 + r.benchmarkReturn), 1
  ) - 1;

  // FIX-BENCH-GUARD: con pocas snapshots, la anualización explota
  // Mínimo 63 snapshots (~1 trimestre) para CAGR anualizado fiable
  if (windowSize < MIN_DATA_POINTS) {
    const simpleEngine = isFinite(engineTotalReturn) ? engineTotalReturn : 0;
    const simpleBenchmark = isFinite(benchmarkTotalReturn) ? benchmarkTotalReturn : 0;
    return {
      engineCagr3m: simpleEngine,
      benchmarkCagr3m: simpleBenchmark,
      outperformance: simpleEngine - simpleBenchmark,
      underperformanceAlert: false,
      engineSharpe3m: 0,
      benchmarkSharpe3m: 0,
      dataPoints,
      lastUpdated: returnRecords[returnRecords.length - 1].timestamp,
      engineTotalReturn: simpleEngine,
      benchmarkTotalReturn: simpleBenchmark,
      message: `Recolectando datos del benchmark... ${windowSize}/${MIN_DATA_POINTS} snapshots. Retorno acumulado: engine ${(simpleEngine * 100).toFixed(2)}% · benchmark ${(simpleBenchmark * 100).toFixed(2)}%.`,
    };
  }

  // ── Tiempo real transcurrido en el rolling window ────────────
  // NO usar windowSize / 252: eso asume cada snapshot = 1 día, pero
  // las snapshots se registran a frecuencia variable (no diario).
  const firstTs = new Date(rollingReturns[0].timestamp).getTime();
  const lastTs = new Date(rollingReturns[rollingReturns.length - 1].timestamp).getTime();
  const actualYears = Math.max((lastTs - firstTs) / (365.25 * 24 * 60 * 60 * 1000), 1 / 365.25);

  // ── CAGR rolling 3m ──────────────────────────────────────────
  const engineCumRet = engineReturns.reduce((acc, r) => acc * (1 + r), 1);
  const benchmarkCumRet = benchmarkReturns.reduce((acc, r) => acc * (1 + r), 1);

  // FIX-BENCH-01: El floor anterior (windowSize / 504) trataba cada snapshot como
  // 0.5 días de trading. Pero las snapshots se graban cada ~60s (live monitor).
  //   → 500 snapshots en 1 semana → effectiveYears = 500/504 = 0.99 años
  //   → CAGR = benchCumRet^(1/0.99) → anualiza 1 semana como 1 año → explosión.
  // CORRECCIÓN: Usar wall-clock time real con un floor mínimo de 30 días
  // (MIN_BENCHMARK_YEARS). Sin floor falso basado en número de snapshots.
  // Si el periodo real es < 30 días, no se calcula CAGR (datos insuficientes).
  const MIN_BENCHMARK_YEARS = 30 / 365.25; // ~1 mes mínimo para CAGR fiable
  const effectiveYears = Math.max(actualYears, MIN_BENCHMARK_YEARS);

  // Si tenemos < 30 días de datos reales, no anualizamos — mostramos retorno simple
  const hasEnoughData = actualYears >= MIN_BENCHMARK_YEARS;

  const engineCagr3m = hasEnoughData
    ? (engineCumRet > 0 ? Math.pow(engineCumRet, 1 / effectiveYears) - 1 : -1)
    : engineCumRet - 1; // retorno simple (no anualizado) si < 30 días
  const benchmarkCagr3m = hasEnoughData
    ? (benchmarkCumRet > 0 ? Math.pow(benchmarkCumRet, 1 / effectiveYears) - 1 : -1)
    : benchmarkCumRet - 1;

  const cleanEngineCagr = isFinite(engineCagr3m) ? engineCagr3m : 0;
  const cleanBenchmarkCagr = isFinite(benchmarkCagr3m) ? benchmarkCagr3m : 0;

  const outperformance = cleanEngineCagr - cleanBenchmarkCagr;
  const underperformanceAlert = outperformance < -UNDERPERFORM_THRESHOLD;

  // ── Sharpe ratio rolling (risk-free = 4% anual) ──────────────
  // Usar effectiveYears (misma corrección que CAGR) para evitar
  // Sharpe absurdos cuando hay pocas snapshots
  const periodsPerYear = windowSize / effectiveYears;
  const rfPerPeriod = 0.04 / periodsPerYear;
  const engineExcess = engineReturns.map(r => r - rfPerPeriod);
  const benchmarkExcess = benchmarkReturns.map(r => r - rfPerPeriod);

  const engineMean = engineExcess.reduce((a, b) => a + b, 0) / windowSize;
  const benchmarkMean = benchmarkExcess.reduce((a, b) => a + b, 0) / windowSize;

  const engineVar = windowSize > 1
    ? engineExcess.reduce((s, v) => s + (v - engineMean) ** 2, 0) / (windowSize - 1)
    : 0;
  const benchmarkVar = windowSize > 1
    ? benchmarkExcess.reduce((s, v) => s + (v - benchmarkMean) ** 2, 0) / (windowSize - 1)
    : 0;

  const engineVol = Math.sqrt(engineVar) * Math.sqrt(periodsPerYear);
  const benchmarkVol = Math.sqrt(benchmarkVar) * Math.sqrt(periodsPerYear);

  const engineSharpe3m = engineVol > 0
    ? (engineMean * periodsPerYear) / engineVol
    : 0;
  const benchmarkSharpe3m = benchmarkVol > 0
    ? (benchmarkMean * periodsPerYear) / benchmarkVol
    : 0;

  // ── Mensaje legible ──────────────────────────────────────────
  const periodLabel = hasEnoughData ? "anualizado en rolling 3m" : `retorno simple (${Math.round(actualYears * 365)} días de datos)`;
  let message: string;
  if (underperformanceAlert) {
    message = `🔴 ALERTA: Motor underperformando benchmark 60/40 por ${Math.abs(outperformance * 100).toFixed(2)}% ${periodLabel}. Revisar configuraciones.`;
  } else if (outperformance > 0.02) {
    message = `🟢 Motor superando benchmark 60/40 por ${(outperformance * 100).toFixed(2)}% ${periodLabel}.`;
  } else if (outperformance > -0.02) {
    message = `🟡 Motor en línea con benchmark 60/40 (diferencia: ${(outperformance * 100).toFixed(2)}%).`;
  } else {
    message = `🟠 Motor ligeramente por debajo del benchmark (${(outperformance * 100).toFixed(2)}%). Monitorear próximos días.`;
  }

  return {
    engineCagr3m: cleanEngineCagr,
    benchmarkCagr3m: cleanBenchmarkCagr,
    outperformance,
    underperformanceAlert,
    engineSharpe3m: isFinite(engineSharpe3m) ? engineSharpe3m : 0,
    benchmarkSharpe3m: isFinite(benchmarkSharpe3m) ? benchmarkSharpe3m : 0,
    dataPoints,
    lastUpdated: returnRecords[returnRecords.length - 1].timestamp,
    engineTotalReturn: isFinite(engineTotalReturn) ? engineTotalReturn : 0,
    benchmarkTotalReturn: isFinite(benchmarkTotalReturn) ? benchmarkTotalReturn : 0,
    message,
  };
}

/**
 * Devuelve el historial completo de retornos para gráficos en el dashboard.
 * Últimos N registros (por defecto 252 = 1 año de trading).
 */
export function getBenchmarkHistory(limit: number = 252): BenchmarkReturnRecord[] {
  const records = loadReturnRecords();
  return records.slice(-limit);
}

/**
 * Limpia todo el historial del benchmark (snapshots + retornos).
 */
export function clearBenchmarkHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_SNAPSHOTS);
    localStorage.removeItem(STORAGE_KEY_RETURNS);
  } catch {
    console.warn('[Benchmark] Error limpiando historial del benchmark');
  }
}

/**
 * Obtiene el peso del benchmark para un ticker específico [0,1].
 * Útil para mostrar la composición del benchmark en el dashboard.
 */
export function getBenchmarkWeight(ticker: string): number {
  return BENCHMARK_WEIGHTS[ticker] ?? 0;
}

/**
 * Devuelve la composición completa del benchmark para mostrar en UI.
 */
export function getBenchmarkComposition(): { ticker: string; weight: number }[] {
  return ASSETS.map(ticker => ({
    ticker,
    weight: BENCHMARK_WEIGHTS[ticker] ?? 0,
  })).filter(x => x.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}
