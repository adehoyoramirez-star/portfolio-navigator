// ===============================================
// Walk-forward comparison — legacy vs no-breadth vs institutional candidate
// ===============================================
// Las tres variantes se ejecutan sobre las mismas ventanas OOS. Las diferencias
// se calculan por ventana antes de agregar, evitando comparar muestras distintas.
// El bootstrap re-muestrea ventanas completas, no días independientes; con pocas
// ventanas sus intervalos son descriptivos y no sustituyen una validación larga.

import {
  DEFAULT_WF_CONFIG,
  runWalkForwardTest,
  type WFTestConfig,
  type WFTestResult,
} from './walkForwardTest';
import type { BacktestInput, BacktestOutput } from './backtestEngine';

export type PairedWalkForwardMetric =
  | 'cagr'
  | 'sharpe'
  | 'maxDrawdown'
  | 'calmar'
  | 'turnover'
  | 'transactionCosts';

export type PairedWalkForwardVariant = 'legacy' | 'noBreadth' | 'institutionalCandidate';

export interface BootstrapConfidenceInterval {
  estimate: number;
  lower: number;
  upper: number;
  confidenceLevel: number;
  bootstrapSamples: number;
  sampleSize: number;
}

export interface VariantMetricSummary {
  metric: PairedWalkForwardMetric;
  confidenceInterval: BootstrapConfidenceInterval;
  observations: number[];
}

export interface PairedMetricComparison {
  metric: PairedWalkForwardMetric;
  candidate: PairedWalkForwardVariant;
  benchmark: PairedWalkForwardVariant;
  /** candidate minus benchmark, calculated independently for every OOS window */
  pairedDifferences: number[];
  confidenceInterval: BootstrapConfidenceInterval;
}

export interface PairedVariantComparison {
  candidate: PairedWalkForwardVariant;
  benchmark: PairedWalkForwardVariant;
  metrics: Record<PairedWalkForwardMetric, PairedMetricComparison>;
}

export interface PairedWalkForwardResult {
  config: WFTestConfig;
  bootstrapSamples: number;
  bootstrapSeed: number;
  confidenceLevel: number;
  variants: Record<PairedWalkForwardVariant, WFTestResult>;
  variantSummaries: Record<PairedWalkForwardVariant, Record<PairedWalkForwardMetric, VariantMetricSummary>>;
  comparisons: {
    institutionalVsLegacy: PairedVariantComparison;
    institutionalVsNoBreadth: PairedVariantComparison;
  };
}

const METRICS: PairedWalkForwardMetric[] = [
  'cagr',
  'sharpe',
  'maxDrawdown',
  'calmar',
  'turnover',
  'transactionCosts',
];

export interface BootstrapOptions {
  samples?: number;
  seed?: number;
  confidenceLevel?: number;
}

function assertFiniteSeries(values: number[], label: string): void {
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) {
    throw new Error(`Cannot bootstrap ${label}: expected a non-empty finite series`);
  }
}

function percentile(sortedValues: number[], probability: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Percentile bootstrap CI for the mean of a finite, already paired series.
 * Exported for deterministic unit testing and independent audit tooling.
 */
export function bootstrapMeanConfidenceInterval(
  values: number[],
  options: BootstrapOptions = {},
): BootstrapConfidenceInterval {
  assertFiniteSeries(values, 'mean');
  const samples = Math.max(1, Math.floor(options.samples ?? 10_000));
  const seed = options.seed ?? 20_260_831;
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  if (confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new Error(`confidenceLevel must be between 0 and 1; received ${confidenceLevel}`);
  }

  const random = createSeededRandom(seed);
  const sampleMeans: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let sum = 0;
    for (let draw = 0; draw < values.length; draw++) {
      sum += values[Math.floor(random() * values.length)];
    }
    sampleMeans.push(sum / values.length);
  }
  sampleMeans.sort((a, b) => a - b);

  const alpha = (1 - confidenceLevel) / 2;
  return {
    estimate: values.reduce((sum, value) => sum + value, 0) / values.length,
    lower: percentile(sampleMeans, alpha),
    upper: percentile(sampleMeans, 1 - alpha),
    confidenceLevel,
    bootstrapSamples: samples,
    sampleSize: values.length,
  };
}

/** Returns candidate minus benchmark while preserving the OOS window pairing. */
export function computePairedDifferences(candidate: number[], benchmark: number[]): number[] {
  if (candidate.length !== benchmark.length) {
    throw new Error(`Cannot pair series with lengths ${candidate.length} and ${benchmark.length}`);
  }
  assertFiniteSeries(candidate, 'candidate paired series');
  assertFiniteSeries(benchmark, 'benchmark paired series');
  return candidate.map((value, index) => value - benchmark[index]);
}

function turnover(output: BacktestOutput): number {
  let total = 0;
  let previous: Record<string, number> | null = null;
  for (const record of output.dailyRecords) {
    if (previous !== null) {
      const tickers = new Set([...Object.keys(previous), ...Object.keys(record.allocations)]);
      for (const ticker of tickers) {
        total += Math.abs((record.allocations[ticker] ?? 0) - (previous[ticker] ?? 0));
      }
    }
    previous = record.allocations;
  }
  return total;
}

function metricValue(output: BacktestOutput, metric: PairedWalkForwardMetric): number {
  if (metric === 'turnover') return turnover(output);
  if (metric === 'transactionCosts') return output.totalTransactionCosts;
  return output.metrics[metric];
}

function observations(
  result: WFTestResult,
  metric: PairedWalkForwardMetric,
): number[] {
  return result.windows.map(window => metricValue(window.outOfSample, metric));
}

function summarizeVariant(
  result: WFTestResult,
  options: BootstrapOptions,
): Record<PairedWalkForwardMetric, VariantMetricSummary> {
  return Object.fromEntries(METRICS.map(metric => {
    const values = observations(result, metric);
    return [metric, {
      metric,
      observations: values,
      confidenceInterval: bootstrapMeanConfidenceInterval(values, {
        ...options,
        // Distinct deterministic stream per metric; the resampled windows remain paired.
        seed: (options.seed ?? 20_260_831) + METRICS.indexOf(metric) * 101,
      }),
    }];
  })) as Record<PairedWalkForwardMetric, VariantMetricSummary>;
}

function compareVariants(
  candidate: PairedWalkForwardVariant,
  benchmark: PairedWalkForwardVariant,
  variants: Record<PairedWalkForwardVariant, WFTestResult>,
  options: BootstrapOptions,
): PairedVariantComparison {
  const candidateResult = variants[candidate];
  const benchmarkResult = variants[benchmark];
  if (candidateResult.windows.length !== benchmarkResult.windows.length) {
    throw new Error(`Cannot pair ${candidate} and ${benchmark}: different window counts`);
  }
  const metrics = Object.fromEntries(METRICS.map((metric, metricIndex) => {
    const candidateValues = observations(candidateResult, metric);
    const benchmarkValues = observations(benchmarkResult, metric);
    const pairedDifferences = computePairedDifferences(candidateValues, benchmarkValues);
    return [metric, {
      metric,
      candidate,
      benchmark,
      pairedDifferences,
      confidenceInterval: bootstrapMeanConfidenceInterval(pairedDifferences, {
        ...options,
        seed: (options.seed ?? 20_260_831) + 1_000 + metricIndex * 101,
      }),
    }];
  })) as Record<PairedWalkForwardMetric, PairedMetricComparison>;
  return { candidate, benchmark, metrics };
}

/**
 * Runs all variants through the same walk-forward splitter and pairs their OOS
 * observations by window. The production legacy behavior remains untouched;
 * overrides are confined to the two counterfactual variants.
 */
export function runPairedWalkForwardComparison(
  input: BacktestInput,
  config: Partial<WFTestConfig> = {},
  options: BootstrapOptions = {},
): PairedWalkForwardResult {
  const variants: Record<PairedWalkForwardVariant, WFTestResult> = {
    legacy: runWalkForwardTest(input, config),
    noBreadth: runWalkForwardTest({
      ...input,
      absoluteTrendGateOverride: {
        ...input.absoluteTrendGateOverride,
        disableMajority: true,
      },
      institutionalBreadthCandidate: undefined,
    }, config),
    institutionalCandidate: runWalkForwardTest({
      ...input,
      // Preserve BTC and correlation gates while replacing only the legacy
      // breadth branch with the institutional candidate.
      absoluteTrendGateOverride: {
        ...input.absoluteTrendGateOverride,
        disableMajority: true,
      },
      institutionalBreadthCandidate: {
        enabled: true,
        ...(input.institutionalBreadthCandidate ?? {}),
      },
    }, config),
  };

  const windowCounts = Object.values(variants).map(result => result.windows.length);
  if (new Set(windowCounts).size !== 1 || windowCounts[0] === 0) {
    throw new Error(`Paired walk-forward requires identical non-empty windows; received ${windowCounts.join(', ')}`);
  }

  const bootstrapOptions: BootstrapOptions = {
    samples: Math.max(1, Math.floor(options.samples ?? 10_000)),
    seed: options.seed ?? 20_260_831,
    confidenceLevel: options.confidenceLevel ?? 0.95,
  };

  return {
    config: { ...DEFAULT_WF_CONFIG, ...config },
    bootstrapSamples: bootstrapOptions.samples!,
    bootstrapSeed: bootstrapOptions.seed!,
    confidenceLevel: bootstrapOptions.confidenceLevel!,
    variants,
    variantSummaries: {
      legacy: summarizeVariant(variants.legacy, bootstrapOptions),
      noBreadth: summarizeVariant(variants.noBreadth, bootstrapOptions),
      institutionalCandidate: summarizeVariant(variants.institutionalCandidate, bootstrapOptions),
    },
    comparisons: {
      institutionalVsLegacy: compareVariants('institutionalCandidate', 'legacy', variants, bootstrapOptions),
      institutionalVsNoBreadth: compareVariants('institutionalCandidate', 'noBreadth', variants, bootstrapOptions),
    },
  };
}
