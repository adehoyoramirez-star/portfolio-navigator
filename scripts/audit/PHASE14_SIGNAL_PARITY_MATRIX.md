# Phase 14 — Signal-by-signal production/backtest input parity

**Status:** OPEN — forensic mapping complete; no allocation logic changed.  
**Branch:** `audit/phase10-cost-parity`  
**Purpose:** establish which production inputs are represented in the current historical backtest before adding parity assertions or interpreting WFO performance.

## Executive conclusion

The live dashboard and the WFO/backtest do **not** currently send equivalent input payloads to `runOlympusEngine`. This is more specific than a generic “macro coverage is partial” limitation: several live signal families are absent from the backtest call entirely, while others are replaced by defaults. A full parity claim would be false.

Evidence inspected:
- Live call: `src/dashboard/InstitutionalDashboard.tsx`, `runOlympusEngine({...})` around lines 1263–1314.
- Backtest call: `src/core/backtest/backtestEngine.ts`, `computeAllocationsWithRegime()` around lines 560–610.
- WFO history construction: `src/core/backtest/run-walkforward.ts`, `macroHistory` around lines 190–230.
- Engine input contract: `src/core/engine/olympusV3.ts`, `OlympusEngineInput`.

## Input parity matrix

| Input / signal family | Live dashboard | Current WFO/backtest | Audit status |
|---|---|---|---|
| Asset returns / factor inputs | Current market-derived `AssetInput[]` | Historical return-derived `AssetInput[]` | **Partial** — source and timestamp alignment differ by design; must compare at matched decision dates |
| Correlation / covariance | DCC covariance for main path; LW matrix separately supplied for Core shadow | WFO sets `useDynamicCovariance: true`; generic `runBacktest` defaults to static covariance | **Configuration-dependent** — explicitly record estimator per run |
| VIX, yield spread, credit spread | Live market inputs | Historical arrays; credit spread aligned to observed FRED OAS coverage | **Partial** — observed history exists, but data freshness and exact decision-time alignment need tests |
| MOVE | Live `moveIndex` | Historical MOVE series is passed | **Partial** — present in WFO; backtest has a synthetic fallback if omitted by another caller |
| DXY trend | Live market-data trend, fallback 0 | WFO computes a 20-calendar-row percentage change; generic fallback is 0 | **Not equivalent** — same name does not establish same lookback, units, or calculation |
| BTC realized volatility | Live `btcVol` | Historical `BTC_VOL` array | **Partial** — confirm same annualization and timestamp semantics |
| M2 growth | Live `m2Growth` | WFO does not pass a series; engine path falls back to constant `2` | **Absent in WFO** — a constant is not historical evidence |
| WTI / oil | Live `wtiOil` | WFO does not pass historical oil; backtest may pass undefined | **Absent in WFO** |
| Central-bank liquidity growth | Live `macro.cbLiquidityGrowth` and separate `liquidityGrowth` | Neither is populated from a historical series in the WFO path | **Absent in WFO** |
| ERP | Live `erpValue` | Optional `macroHistory.erpValue` is supported, but not passed by WFO | **Absent in WFO** |
| Average correlation / panic input | Live `dynamicCovResult?.avgCorrelation` | Optional historical `avgCorrelation` is supported, but not passed by WFO | **Absent in WFO** |
| BTC on-chain: MVRV, MVRV Z-score, Puell, weekly RSI | Live `btcOnChain` object | Not supplied by WFO or the `runOlympusEngine` backtest call | **Absent in WFO** |
| Cycle-top signals | Live `cycleTopSignals` derived from cycle detector | Not supplied by WFO or the `runOlympusEngine` backtest call | **Absent in WFO** |
| SOX weekly RSI / inflation breakeven | Live optional inputs | Not supplied by WFO/backtest call | **Absent in WFO** |
| Per-asset cycle valuation inputs (uranium spot/LT, SIA sales, WLG/EMXC RSI and P/E, CAPE, DXY spot) | Live input surfaces exist in `OlympusEngineInput`; inspect upstream feed freshness individually | Not passed by the current WFO call | **Absent in WFO** |
| Regime history / CEWS history | Live persisted histories | Backtest constructs synthetic sequential timestamps and rolling history | **Partial** — deterministic replay is required; current histories are not a byte-identical replay of live state |
| Cash / total portfolio value | Live cash and NAV supplied | Historical backtest passes no equivalent live cash/NAV state in the engine call | **Not equivalent** — features that depend on account state need explicit classification |

## High-priority findings

### P14-01 — Live signals are omitted from the historical engine invocation

The dashboard passes `liquidityGrowth`, `btcOnChain`, `cycleTopSignals`, SOX RSI and inflation breakeven. The current backtest call does not. Therefore, a successful WFO run does not test the full production engine; it tests the subset and default behavior reached by that historical invocation.

### P14-02 — Silent constants can look like historical coverage

The backtest call substitutes `m2Growth ?? 2`, `move ?? (vix * 4.5 + 20)`, `dxyTrend ?? 0`, and `btcVol ?? 0.5`. These fallbacks may be acceptable for backward compatibility, but they must be tagged as fallback observations, not treated as observed historical inputs. WFO currently has observed MOVE, DXY and BTC-vol arrays, but not observed M2/oil/CB liquidity/ERP/average-correlation.

### P14-03 — DXY ablation needs a downstream causal trace

The current WFO's identical ON/OFF portfolio metrics do not, by themselves, prove the DXY path is inert. The audit must compare, on the same dates: input value → global stress score → regime label/penalty → raw engine allocations → final target weights → turnover and cost. If weights are identical, document the first layer at which the input stops affecting output.

## Implementation update — coverage contract added

Implemented on the audit branch:

- `src/core/backtest/inputCoverage.ts` defines the required signal-family contract and a machine-readable manifest.
- `src/test/inputCoverage.test.ts` covers partial mode, missing-family rejection, complete coverage, and the rule that fallbacks do not count as observed history.
- `src/core/backtest/run-walkforward.ts` prints the manifest and labels the current WFO `partial-input`.
- Set `OLYMPUS_BACKTEST_MODE=full-parity` to request strict mode. The runner will stop before publishing WFO metrics while any required family is not observed historically.

The current dataset is intentionally partial: missing families include M2, oil, central-bank liquidity, ERP, average correlation, BTC on-chain, cycle-top, SOX RSI, inflation breakeven and asset valuation. M2 is separately tagged as a fallback, never as observed history.

## Next implementation step

Do not alter investment thresholds or add synthetic historical values to make the engine appear complete.

1. Confirm CI passes on the exact latest commit.
2. Expand the manifest with per-series units, point-in-time timestamp convention, freshness threshold, carry-forward rule and missing/fallback counts.
3. Only after point-in-time historical feeds exist, add paired signal/target-weight tests for each signal family.
4. Re-run WFO with the same windows/costs; do not merge until findings are reviewed.

## Acceptance criteria

- [ ] Every live engine input is classified as historical, account-state, static configuration, or unavailable.
- [ ] No missing historical series is silently converted into an observed series.
- [ ] Each series documents units, source, as-of timestamp, freshness limit and carry-forward rule.
- [ ] Full-parity mode fails closed on missing required signal families.
- [ ] Partial-input WFO output is visibly labelled and cannot be mistaken for production validation.
- [ ] Signal-level paired tests cover scores, regime/penalty, target weights, turnover and costs.
- [ ] No parameter optimization is performed against the same OOS windows used for evaluation.
