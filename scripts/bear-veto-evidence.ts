import fs from 'node:fs';
import path from 'node:path';
import { ASSETS } from '../src/lib/constants';
import { runBacktest, type BacktestInput, type BacktestOutput } from '../src/core/backtest/backtestEngine';
import { runWalkForwardTest } from '../src/core/backtest/walkForwardTest';
import {
  runPairedWalkForwardComparison,
  type PairedWalkForwardMetric,
  type PairedWalkForwardVariant,
} from '../src/core/backtest/walkForwardComparison';

const DATA_FILE = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
const LOOKBACK_DAYS = 252;
const REBALANCE_DAYS = 21;
const INITIAL_CAPITAL = 10_000;
const TRANSACTION_COST_BPS = 15;

type NumericSeries = number[];

type HistoricalData = Pick<BacktestInput, 'closesHistory' | 'macroHistory'> & {
  rows: number;
  dates: string[];
  firstDate: string;
  lastDate: string;
};

function parseHistoricalData(): HistoricalData {
  const lines = fs.readFileSync(DATA_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',');
  const series: Record<string, NumericSeries> = Object.fromEntries(
    [...ASSETS, '^VIX', '^TNX', '^IRX', 'HYG', 'LQD', '^MOVE', 'DX-Y.NYB', 'BTC_VOL']
      .map(key => [key, [] as number[]])
  );
  const dates: string[] = [];

  const valueAt = (parts: string[], key: string, fallback = 0): number => {
    const index = headers.indexOf(key);
    if (index < 0) return fallback;
    const value = Number.parseFloat(parts[index]);
    return Number.isFinite(value) ? value : fallback;
  };

  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length < headers.length) continue;
    dates.push(parts[0]);
    for (const ticker of ASSETS) series[ticker].push(valueAt(parts, ticker));
    series['^VIX'].push(valueAt(parts, '^VIX'));
    series['^TNX'].push(valueAt(parts, '^TNX'));
    series['^IRX'].push(valueAt(parts, '^IRX'));
    series.HYG.push(valueAt(parts, 'HYG'));
    series.LQD.push(valueAt(parts, 'LQD'));
    series['^MOVE'].push(valueAt(parts, '^MOVE', 95));
    series['DX-Y.NYB'].push(valueAt(parts, 'DX-Y.NYB', 103));
    series.BTC_VOL.push(valueAt(parts, 'BTC_VOL', 30));
  }

  const minLength = Math.min(...Object.values(series).map(values => values.length));
  const trim = (values: number[]): number[] => values.slice(0, minLength);
  const vix = trim(series['^VIX']);
  const tnx = trim(series['^TNX']);
  const irx = trim(series['^IRX']);
  const hyg = trim(series.HYG);
  const lqd = trim(series.LQD);
  const dxy = trim(series['DX-Y.NYB']);

  const yieldSpread = tnx.map((value, index) => value - irx[index]);
  const creditSpread = hyg.map((value, index) => {
    if (value > 0 && lqd[index] > 0) {
      const hygYield = 0.045 + (1 - value / 100) * 0.03;
      const lqdYield = 0.035 + (1 - lqd[index] / 100) * 0.02;
      return Math.max(1, Math.min(9, (hygYield - lqdYield) * 100));
    }
    return 2.5 + vix[index] / 20;
  });
  const dxyTrend = dxy.map((value, index) => {
    if (index < 20 || dxy[index - 20] <= 0) return 0;
    return ((value - dxy[index - 20]) / dxy[index - 20]) * 100;
  });

  const closesHistory: Record<string, number[]> = {};
  for (const ticker of ASSETS) closesHistory[ticker] = trim(series[ticker]);

  return {
    closesHistory,
    macroHistory: {
      vix,
      yieldSpread,
      creditSpread,
      move: trim(series['^MOVE']),
      dxyTrend,
      btcVol: trim(series.BTC_VOL),
    },
    rows: minLength,
    dates: dates.slice(0, minLength),
    firstDate: dates[0] ?? 'unknown',
    lastDate: dates[minLength - 1] ?? 'unknown',
  };
}

function restrictToBacktestDays(data: HistoricalData, targetDays: number): HistoricalData {
  const targetRows = targetDays + LOOKBACK_DAYS + 1;
  const offset = data.rows - targetRows;
  if (offset < 0) throw new Error(`Need ${targetRows} rows for ${targetDays} backtest days; found ${data.rows}`);
  const sliceSeries = (values: number[]): number[] => values.slice(offset);
  return {
    closesHistory: Object.fromEntries(
      Object.entries(data.closesHistory).map(([ticker, values]) => [ticker, sliceSeries(values)])
    ),
    macroHistory: {
      vix: sliceSeries(data.macroHistory.vix),
      yieldSpread: sliceSeries(data.macroHistory.yieldSpread),
      creditSpread: sliceSeries(data.macroHistory.creditSpread),
      move: data.macroHistory.move?.length ? sliceSeries(data.macroHistory.move) : undefined,
      dxyTrend: data.macroHistory.dxyTrend?.length ? sliceSeries(data.macroHistory.dxyTrend) : undefined,
      btcVol: data.macroHistory.btcVol?.length ? sliceSeries(data.macroHistory.btcVol) : undefined,
    },
    rows: targetRows,
    dates: data.dates.slice(offset),
    firstDate: data.dates[offset] ?? 'unknown',
    lastDate: data.lastDate,
  };
}

function baseInput(data: HistoricalData): BacktestInput {
  return {
    closesHistory: data.closesHistory,
    macroHistory: data.macroHistory,
    lookbackDays: LOOKBACK_DAYS,
    rebalanceDays: REBALANCE_DAYS,
    initialCapital: INITIAL_CAPITAL,
    transactionCostBps: TRANSACTION_COST_BPS,
  };
}

function run(
  data: HistoricalData,
  override: BacktestInput['absoluteTrendGateOverride'],
  diagnostics = false,
  institutionalCandidate = false,
): BacktestOutput {
  return runBacktest({
    ...baseInput(data),
    absoluteTrendGateOverride: override,
    collectAbsoluteTrendGateDiagnostics: diagnostics,
    institutionalBreadthCandidate: institutionalCandidate ? { enabled: true } : undefined,
  });
}

function turnover(output: BacktestOutput): number {
  let value = 0;
  let previous: Record<string, number> | null = null;
  for (const record of output.dailyRecords) {
    if (previous) {
      value += ASSETS.reduce(
        (sum, ticker) => sum + Math.abs((record.allocations[ticker] ?? 0) - (previous?.[ticker] ?? 0)),
        0,
      );
    }
    previous = record.allocations;
  }
  return value;
}

function metricsRow(name: string, output: BacktestOutput): string {
  const m = output.metrics;
  return [
    name,
    m.cagr,
    m.sharpe,
    m.maxDrawdown,
    m.calmar,
    turnover(output),
    output.totalTransactionCosts,
    output.rebalanceCount,
    m.finalValue,
  ].join(',');
}

function runAblation(data: HistoricalData): void {
  const withGate = run(data, undefined, true);
  const withoutGate = run(data, { enabled: false });
  const d = withGate.absoluteTrendGateDiagnostics;
  const rows = [
    'variant,CAGR,Sharpe,MaxDrawdown,Calmar,turnover_sum,transaction_cost_eur,rebalance_count,final_value',
    metricsRow('gate_active', withGate),
    metricsRow('gate_disabled', withoutGate),
  ];

  console.log('BEAR-VETO ABLATION');
  console.log(`data_rows=${data.rows} | dates=${data.firstDate}..${data.lastDate} | backtest_days=${withGate.dailyRecords.length}`);
  console.log(rows.join('\n'));
  console.log(`gate_evaluated_rebalances=${d.evaluatedRebalances}`);
  console.log(`gate_active_rebalances=${d.activeRebalances}`);
  console.log(`majority_bearish_rebalances=${d.majorityBearishRebalances}`);
  console.log(`most_bearish_rebalances=${d.mostBearishRebalances}`);
  console.log(`breadth_boundary_up_3to4_or_more=${d.breadthBoundaryUpCrossings}`);
  console.log(`breadth_boundary_down_4or_more_to3_or_less=${d.breadthBoundaryDownCrossings}`);
  console.log(`immediate_cost_with_gate_eur=${d.immediateCostWithGate.toFixed(4)}`);
  console.log(`immediate_cost_without_gate_eur=${d.immediateCostWithoutGate.toFixed(4)}`);
  console.log(`immediate_incremental_cost_eur=${d.immediateIncrementalCost.toFixed(4)}`);
  console.log(`total_cost_difference_active_minus_disabled_eur=${(withGate.totalTransactionCosts - withoutGate.totalTransactionCosts).toFixed(4)}`);
}

function runWalkForwardEvidence(data: HistoricalData): void {
  const candidate = runWalkForwardTest({
    ...baseInput(data),
    absoluteTrendGateOverride: { disableMajority: true },
    institutionalBreadthCandidate: { enabled: true },
  }, {
    nWindows: 5,
    trainRatio: 0.70,
    lookbackDays: LOOKBACK_DAYS,
    rebalanceDays: REBALANCE_DAYS,
    initialCapital: INITIAL_CAPITAL,
    transactionCostBps: TRANSACTION_COST_BPS,
  });

  console.log('INSTITUTIONAL BREADTH WALK-FORWARD SHADOW CANDIDATE');
  console.log(`data_rows=${data.rows} | dates=${data.firstDate}..${data.lastDate} | windows=${candidate.windows.length}`);
  console.log(`oos_sharpe_avg=${candidate.sharpeOosAvg}`);
  console.log(`oos_cagr_avg=${candidate.cagrOosAvg}`);
  console.log(`oos_equal_weight_sharpe_avg=${candidate.equalWeightSharpeOosAvg}`);
  console.log(`max_dd_degradation_avg=${candidate.avgMaxDdDegradation}`);
  console.log(`consistency=${candidate.overallConsistency}`);
  console.log(`robustness_grade=${candidate.robustnessGrade}`);
  console.log(`overfitting_risk=${candidate.overfittingRisk}`);
  console.log(`beats_equal_weight=${candidate.beatsEqualWeight}`);
  console.log(`promotion_status=PENDING_OOS_RISK_APPROVAL`);
  for (const window of candidate.windows) {
    console.log([
      `window_${window.window.windowIndex + 1}`,
      `is_sharpe=${window.inSample.metrics.sharpe.toFixed(4)}`,
      `oos_sharpe=${window.outOfSample.metrics.sharpe.toFixed(4)}`,
      `is_cagr=${window.inSample.metrics.cagr.toFixed(4)}`,
      `oos_cagr=${window.outOfSample.metrics.cagr.toFixed(4)}`,
      `oos_max_dd=${window.outOfSample.metrics.maxDrawdown.toFixed(4)}`,
    ].join(' | '));
  }
}

function runPairedWalkForwardEvidence(data: HistoricalData, nWindows = 5): void {
  const result = runPairedWalkForwardComparison(baseInput(data), {
    nWindows,
    trainRatio: 0.70,
    lookbackDays: LOOKBACK_DAYS,
    rebalanceDays: REBALANCE_DAYS,
    initialCapital: INITIAL_CAPITAL,
    transactionCostBps: TRANSACTION_COST_BPS,
  }, {
    samples: 10_000,
    seed: 20_260_831,
    confidenceLevel: 0.95,
  });

  const variantNames: PairedWalkForwardVariant[] = ['legacy', 'noBreadth', 'institutionalCandidate'];
  const metricNames: PairedWalkForwardMetric[] = ['cagr', 'sharpe', 'maxDrawdown', 'calmar', 'turnover', 'transactionCosts'];
  const format = (value: number): string => value.toFixed(8);
  const variantLabel: Record<PairedWalkForwardVariant, string> = {
    legacy: 'legacy',
    noBreadth: 'no_breadth',
    institutionalCandidate: 'institutional_candidate',
  };
  const comparisonLabel = (candidate: PairedWalkForwardVariant, benchmark: PairedWalkForwardVariant): string =>
    `${variantLabel[candidate]}_minus_${variantLabel[benchmark]}`;

  console.log('PAIRED WALK-FORWARD COMPARISON');
  console.log(`data_rows=${data.rows} | dates=${data.firstDate}..${data.lastDate} | windows=${result.variants.legacy.windows.length}`);
  console.log(`bootstrap_samples=${result.bootstrapSamples} | bootstrap_seed=${result.bootstrapSeed} | confidence=${result.confidenceLevel}`);
  console.log('CI interpretation: percentile bootstrap over paired OOS windows; not iid daily confidence intervals');
  console.log('VARIANT_ACTIVATIONS');
  console.log('variant,shadow_evaluated_rebalances,shadow_active_rebalances,shadow_applied_rebalances,shadow_average_multiplier,shadow_minimum_multiplier,risk_breadth_p50,risk_breadth_p75,risk_breadth_p90,risk_breadth_p95,risk_breadth_maximum');
  for (const variant of variantNames) {
    const diagnostics = result.variants[variant].windows.reduce(
      (total, window) => ({
        evaluated: total.evaluated + window.outOfSample.institutionalBreadthDiagnostics.evaluatedRebalances,
        active: total.active + window.outOfSample.institutionalBreadthDiagnostics.activeRebalances,
        applied: total.applied + window.outOfSample.institutionalBreadthDiagnostics.appliedRebalances,
        multiplierSum: total.multiplierSum + window.outOfSample.institutionalBreadthDiagnostics.averageMultiplier * window.outOfSample.institutionalBreadthDiagnostics.evaluatedRebalances,
        minimum: Math.min(total.minimum, window.outOfSample.institutionalBreadthDiagnostics.minimumMultiplier),
        breadthValues: [...total.breadthValues, ...window.outOfSample.institutionalBreadthDiagnostics.riskBreadthObservations],
      }),
      { evaluated: 0, active: 0, applied: 0, multiplierSum: 0, minimum: 1, breadthValues: [] as number[] },
    );
    const sortedBreadth = [...diagnostics.breadthValues].sort((a, b) => a - b);
    const breadthQuantile = (probability: number): number => {
      if (sortedBreadth.length === 0) return 0;
      const position = (sortedBreadth.length - 1) * probability;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      if (lower === upper) return sortedBreadth[lower];
      const weight = position - lower;
      return sortedBreadth[lower] + (sortedBreadth[upper] - sortedBreadth[lower]) * weight;
    };
    console.log([
      variantLabel[variant],
      diagnostics.evaluated,
      diagnostics.active,
      diagnostics.applied,
      format(diagnostics.evaluated > 0 ? diagnostics.multiplierSum / diagnostics.evaluated : 1),
      format(diagnostics.minimum),
      format(breadthQuantile(0.50)),
      format(breadthQuantile(0.75)),
      format(breadthQuantile(0.90)),
      format(breadthQuantile(0.95)),
      format(breadthQuantile(1)),
    ].join(','));
  }

  console.log('VARIANT_SUMMARY');
  console.log('variant,metric,mean,ci_lower,ci_upper,sample_size');
  for (const variant of variantNames) {
    for (const metric of metricNames) {
      const summary = result.variantSummaries[variant][metric];
      const ci = summary.confidenceInterval;
      console.log([
        variantLabel[variant], metric, format(ci.estimate), format(ci.lower), format(ci.upper), ci.sampleSize,
      ].join(','));
    }
  }

  console.log('PAIRED_COMPARISON');
  console.log('comparison,metric,mean_difference,ci_lower,ci_upper,sample_size,differences_by_window');
  const comparisons = [result.comparisons.institutionalVsLegacy, result.comparisons.institutionalVsNoBreadth];
  for (const comparison of comparisons) {
    for (const metric of metricNames) {
      const summary = comparison.metrics[metric];
      const ci = summary.confidenceInterval;
      console.log([
        comparisonLabel(comparison.candidate, comparison.benchmark),
        metric,
        format(ci.estimate),
        format(ci.lower),
        format(ci.upper),
        ci.sampleSize,
        summary.pairedDifferences.map(format).join(';'),
      ].join(','));
    }
  }

  const candidateDiagnostics = result.variants.institutionalCandidate.windows.reduce(
    (total, window) => ({
      active: total.active + window.outOfSample.institutionalBreadthDiagnostics.activeRebalances,
      applied: total.applied + window.outOfSample.institutionalBreadthDiagnostics.appliedRebalances,
    }),
    { active: 0, applied: 0 },
  );
  console.log('PROMOTION_STATUS');
  console.log(`status=${candidateDiagnostics.applied > 0 ? 'PENDING_OOS_RISK_APPROVAL' : 'PENDING_CANDIDATE_EXERCISE'}`);
  console.log(`candidate_active_rebalances=${candidateDiagnostics.active}`);
  console.log(`candidate_applied_rebalances=${candidateDiagnostics.applied}`);
  console.log('reason=the candidate needs exercised adverse OOS observations and risk approval before promotion');

  console.log('PAIRED_WINDOW_OBSERVATIONS');
  console.log('window,legacy_sharpe,no_breadth_sharpe,institutional_sharpe,legacy_cagr,no_breadth_cagr,institutional_cagr,legacy_max_dd,no_breadth_max_dd,institutional_max_dd');
  const legacyWindows = result.variants.legacy.windows;
  const noBreadthWindows = result.variants.noBreadth.windows;
  const institutionalWindows = result.variants.institutionalCandidate.windows;
  for (let index = 0; index < legacyWindows.length; index++) {
    const legacy = legacyWindows[index].outOfSample.metrics;
    const noBreadth = noBreadthWindows[index].outOfSample.metrics;
    const institutional = institutionalWindows[index].outOfSample.metrics;
    console.log([
      index + 1,
      format(legacy.sharpe), format(noBreadth.sharpe), format(institutional.sharpe),
      format(legacy.cagr), format(noBreadth.cagr), format(institutional.cagr),
      format(legacy.maxDrawdown), format(noBreadth.maxDrawdown), format(institutional.maxDrawdown),
    ].join(','));
  }
}

function runBreadthDistributionEvidence(data: HistoricalData): void {
  const output = run(data, undefined, false, true);
  const diagnostics = output.institutionalBreadthDiagnostics;
  console.log('INSTITUTIONAL BREADTH DISTRIBUTION');
  console.log(`data_rows=${data.rows} | dates=${data.firstDate}..${data.lastDate}`);
  console.log('evaluated_rebalances=' + diagnostics.evaluatedRebalances);
  console.log('active_rebalances=' + diagnostics.activeRebalances);
  console.log('applied_rebalances=' + diagnostics.appliedRebalances);
  console.log('average_multiplier=' + diagnostics.averageMultiplier);
  console.log('minimum_multiplier=' + diagnostics.minimumMultiplier);
  console.log('risk_breadth_p50=' + diagnostics.riskBreadthP50);
  console.log('risk_breadth_p75=' + diagnostics.riskBreadthP75);
  console.log('risk_breadth_p90=' + diagnostics.riskBreadthP90);
  console.log('risk_breadth_p95=' + diagnostics.riskBreadthP95);
  console.log('risk_breadth_maximum=' + diagnostics.riskBreadthMaximum);
  console.log('risk_breadth_activation_threshold=0.5');
  console.log('risk_breadth_observations=' + diagnostics.riskBreadthObservations.map(value => value.toFixed(8)).join(';'));
  console.log('promotion_status=' + (diagnostics.activeRebalances > 0 ? 'PENDING_OOS_RISK_APPROVAL' : 'PENDING_CANDIDATE_EXERCISE'));
}

function runSensitivity(data: HistoricalData): void {
  const caps = [0.50, 0.55, 0.60, 0.65, 0.70];
  const thresholds = [0.45, 0.50, 0.55, 0.60];
  const rows = ['threshold,cap,CAGR,Sharpe,MaxDrawdown,Calmar,turnover_sum,transaction_cost_eur,final_value'];
  for (const threshold of thresholds) {
    for (const cap of caps) {
      const output = run(data, { majorityThreshold: threshold, majorityCap: cap });
      const m = output.metrics;
      rows.push([
        threshold,
        cap,
        m.cagr,
        m.sharpe,
        m.maxDrawdown,
        m.calmar,
        turnover(output),
        output.totalTransactionCosts,
        m.finalValue,
      ].join(','));
    }
  }
  console.log('BEAR-VETO SENSITIVITY');
  console.log(`data_rows=${data.rows} | dates=${data.firstDate}..${data.lastDate} | backtest_days=${run(data, { enabled: false }).dailyRecords.length}`);
  console.log(rows.join('\n'));
}

function main(): void {
  if (!fs.existsSync(DATA_FILE)) throw new Error(`Missing data file: ${DATA_FILE}`);
  const mode = process.argv[2] ?? 'ablation';
  const fullData = parseHistoricalData();
  const data = mode.endsWith('1326') ? restrictToBacktestDays(fullData, 1326) : fullData;
  const originalDebug = console.debug;
  const originalWarn = console.warn;
  console.debug = () => undefined;
  console.warn = () => undefined;
  try {
    if (mode === 'sensitivity' || mode === 'sensitivity1326') runSensitivity(data);
    else if (mode === 'wfo1326') runWalkForwardEvidence(data);
    else if (mode === 'paired1326') runPairedWalkForwardEvidence(data);
    else if (mode === 'paired1326wide') runPairedWalkForwardEvidence(data, 8);
    else if (mode === 'pairedwide') runPairedWalkForwardEvidence(data, 8);
    else if (mode === 'breadth1326') runBreadthDistributionEvidence(data);
    else runAblation(data);
  } finally {
    console.debug = originalDebug;
    console.warn = originalWarn;
  }
}

main();
