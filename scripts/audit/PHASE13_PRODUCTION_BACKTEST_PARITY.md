# Phase 13 — Production / Backtest Parity Audit

**Status:** OPEN — findings documented; no engine allocation logic changed in this phase.  
**Branch:** `audit/phase10-cost-parity`  
**Purpose:** prevent the walk-forward report from being treated as validation of signals that are not represented in its historical inputs.

## Executive conclusion

The current walk-forward runner is reproducible at the code-execution level, but it does **not** yet validate the complete live Olympus input stack. The WFO must be described as a *partial-input diagnostic*, not a full production-parity backtest. Do not use its CAGR/Sharpe to approve the engine or tune thresholds.

## Findings

### P13-01 — Critical for interpreting results: historical macro input coverage is incomplete

**Evidence**
- `src/core/backtest/run-walkforward.ts` constructs `macroHistory` with only `vix`, `yieldSpread`, observed `creditSpread`, `move`, `dxyTrend`, and `btcVol`.
- The runner itself warns that historical Brent/WTI, central-bank liquidity growth and M2 series are not loaded.
- `src/core/backtest/backtestEngine.ts` supports optional `m2Growth`, `wtiOil`, `erpValue`, and `avgCorrelation`; missing series are not equivalent to historical observations.
- The engine call uses `macro.m2Growth ?? 2`, so a fixed value can mask the absence of a historical M2 series.

**Impact**
- Results cannot validate oil, central-bank liquidity, historical M2 variation, ERP-trigger behaviour, or average-correlation panic behaviour.
- A fixed fallback is not a historical signal and must not be described as data-driven performance.

**Required remediation**
1. Source and timestamp each macro series with provenance and coverage metadata.
2. Align every series to the same decision-time calendar; no forward-looking interpolation.
3. If a series is unavailable, mark the feature as unavailable and report that limitation explicitly.
4. Add tests that fail when a full-parity run is requested but required macro histories are absent.

### P13-02 — Critical for interpreting results: on-chain and cycle-top signals are not supplied to WFO

**Evidence**
- `run-walkforward.ts` passes no historical `btcOnChain` data to the backtest.
- The call from `backtestEngine.ts` to `runOlympusEngine` does not supply historical `btcOnChain` or `cycleTopSignals`.
- The live engine input contract in `src/core/engine/olympusV3.ts` includes `btcOnChain` fields and cycle-related input surfaces.

**Impact**
- WFO results cannot validate the effect, timing, or downside protection of those signals.
- Any apparent performance is conditional on the omitted/default behaviour, not the complete live engine.

**Required remediation**
- Add point-in-time historical series and a deterministic replay interface before claiming parity.
- Test the absence of future leakage for each on-chain value and signal timestamp.
- Until then, label the affected layers as **not tested by WFO**.

### P13-03 — Covariance model is not explicit across all entry points

**Evidence**
- `runBacktest` defaults to Ledoit-Wolf when `useDynamicCovariance` is omitted.
- The WFO explicitly sets `useDynamicCovariance: true` (DCC-GARCH).
- `BacktestPanel.tsx` also passes a dynamic-covariance setting in its main backtest paths.
- The production/core documentation contains a separate claim that Ledoit-Wolf is the canonical Core covariance choice.

**Impact**
- Different UI, WFO, and Core configurations may not be comparable unless the intended model is specified per experiment.
- A test passing does not establish that the chosen covariance estimator is the institutionally approved one.

**Required remediation**
1. Define a single source-of-truth covariance policy for production, Core, and research experiments.
2. Make the selected estimator explicit in every report and configuration.
3. Run paired, preregistered DCC-vs-Ledoit-Wolf comparisons on identical data, costs, windows, and rebalance schedule.
4. Do not select the estimator based solely on the highest historical Sharpe.

### P13-04 — Backtest settings differ by entry point

**Evidence**
- `BacktestPanel.tsx` defaults to a 21-day rebalance interval.
- The walk-forward audit uses 63 days and a 252-day lookback.
- The WFO uses three windows and a 60/40 IS/OOS split because observed OAS coverage leaves approximately 1,044 daily rows and the minimum OOS window is 126 days.

**Impact**
- Dashboard backtest results are not directly comparable to WFO results without matching rebalance interval, lookback, data coverage, and costs.
- The 60/40 split is a constraint-driven methodological choice, not evidence that 60/40 is statistically optimal.

**Required remediation**
- Every report must print and persist data range, input coverage, covariance model, costs, lookback, rebalance interval, split ratio, and window boundaries.

### P13-05 — DXY ablation has shown no downstream performance effect in the tested configuration

**Evidence**
- The recent paired WFO reports identical ON/OFF OOS Sharpe, CAGR, and MaxDD across all three windows when only `dxyTrend` is neutralized.

**Impact**
- This does not prove DXY is universally useless, but the current test has not demonstrated incremental portfolio utility from the DXY input.

**Required remediation**
- Trace whether the DXY signal reaches the allocation decision, and test score, regime, target weights, turnover, and costs—not only headline performance.
- Do not lower thresholds or alter the model merely to force a non-zero ablation result.

## Current WFO result: permitted interpretation

- The runner completes and produces three OOS windows.
- The observed credit-spread series is aligned with a maximum four-calendar-day carry-forward rule.
- The split is 60% IS / 40% OOS, with a 252-day lookback and 63-day rebalance interval.
- The dataset ends on 2026-08-17; the available shared sample is limited by observed OAS coverage.
- Three windows are insufficient to establish robust statistical significance.
- Macro, on-chain, and cycle-top omissions mean this is **not a full validation of the live motor**.

## Exit criteria before declaring production/backtest parity

- [ ] Required live inputs inventoried and mapped to historical sources.
- [ ] Point-in-time alignment and missing-data policy tested for each input.
- [ ] Production and backtest covariance estimator explicitly reconciled.
- [ ] Same rebalance schedule and cost model used in paired comparisons.
- [ ] Signal-level and target-weight parity tests added.
- [ ] Tests cover missing/stale data, forward-fill boundaries, and decision-time lag.
- [ ] WFO includes enough distinct OOS periods and regimes to support the intended claims.
- [ ] Audit findings reviewed; no claim of “institutional/definitive” validation while critical items remain open.
