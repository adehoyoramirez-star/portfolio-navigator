# Olympus Engine — Calibration Documentation
## Institutional Parameter Justification · June 2026

## 1. JAMES-STEIN SHRINKAGE (phi = 0.65)
**Where**: src/lib/marketData.ts
**Value**: SHRINKAGE_FACTOR = 0.65
**Justification**: With 6 assets and typical annual returns of 8-15%, optimal shrinkage falls in [0.55, 0.70]. 0.65 is the robust midpoint between overfitting recent history (0.3) and ignoring it (0.9). Sensitivity: +/-0.10 impacts CAGR < 15%.

## 2. LEDOIT-WOLF SHRINKAGE (auto-calibrated)
**Where**: src/lib/marketData.ts (covarianceMatrix)
**Value**: Dynamic rho = sum(Var(s_ij)) / ||S - F||^2_F
**Justification**: Ledoit & Wolf (2004) constant correlation target is the asymptotically optimal shrinkage target. Reduces MSE by ~30-40% vs raw sample covariance.

## 3. HALF-KELLY (f = 0.5)
**Where**: src/core/config/engineConfig.ts
**Value**: HALF_FRACTION = 0.5, CAP = 0.20
**Justification**: Full Kelly is fragile to estimation error. Half-Kelly reduces ruin risk ~75% while sacrificing ~25% of expected growth (Thorp 1997). Cap at 20% per asset aligns with tactical maxSingleAsset of 30%.

## 4. VOLATILITY TARGET (25%)
**Where**: src/core/config/engineConfig.ts
**Value**: DEFAULT_TARGET_VOL = 0.25
**Justification**: With BTC at 15-25% weight, natural portfolio vol is 20-25%. Target of 25% lets engine operate at full capacity in EXPANSION. In CONTRACTION regimeFactor=0.60 -> effective target 15%. In CRISIS penalty 0.40 -> 6%.

## 5. TAIL RISK KILL SWITCH
**Where**: src/core/config/engineConfig.ts
| Level | DD Threshold | Overlay | Reduction |
|-------|:-----------:|:-------:|:---------:|
| L1    | -8%         | 0.80    | 20%       |
| L2    | -15%        | 0.50    | 50%       |
| L3    | -20%        | 0.30    | 70%       |
| L4    | -25%        | 0.15    | 85%       |
| L5    | -32%        | 0.05    | 95%       |
**Justification**: Recalibrated after audit showed MaxDD of -39% with previous kill switch. L2-L5 significantly more aggressive.

## 6. FACTOR WEIGHTS
**Where**: src/core/config/engineConfig.ts
| Factor   | Weight | Justification |
|----------|:------:|---------------|
| Momentum | 0.45   | Captures trends in all regimes |
| Value    | 0.25   | Fundamental anchor |
| Quality  | 0.15   | Defense in stress |
| LowVol   | 0.15   | Protection in high vol |
Dynamic by regime: EXPANSION (M:0.55, Q:0.10), CONTRACTION (Q:0.30, M:0.30), CRISIS (Q:0.35, L:0.30).

## 7. BTC ON-CHAIN GATE (MVRV)
**Where**: src/core/engine/regimeTacticalAllocation.ts
| MVRV      | Scale | Interpretation |
|:---------:|:-----:|----------------|
| < 2.0     | 1.00  | Undervalued    |
| 2.0 - 3.0 | 0.80  | Fair value     |
| 3.0 - 4.0 | 0.50  | Overvalued     |
| > 4.0     | 0.20  | Bubble         |
**Justification**: MVRV > 3.5 precedes 30-50% corrections with >70% frequency (CoinMetrics 2011-2025).

## 8. VVSM MOMENTUM GATE (returns12m)
| returns12m | Scale | Interpretation |
|:---------:|:-----:|----------------|
| < 20%     | 1.00  | Normal         |
| 20-40%    | 0.80  | Hot            |
| 40-60%    | 0.50  | Very hot       |
| > 60%     | 0.25  | Semi bubble    |
**Justification**: Semiconductors have boom/bust cycles. 60%+ 12m returns are unsustainable.

## 9. REGIME THRESHOLDS
- VIX: CONTRACTION > 25 (P66), CRISIS > 35 (P95)
- Credit spread: CRISIS > 3.5% (~2 sigma above mean)
- Yield spread: inversion (< 0) triggers warning

## 9b. CREDIT SPREAD EN GLOBAL STRESS — CONTINUO (FIX-CLIFF-CREDIT-01, Oct-2026)
**Where**: src/core/macro/globalStress.ts → `creditStressContribution()` (anclas en `CREDIT_STRESS_CONFIG`)
**Antes**: escalones enteros `>3% → +1`, `>5% → +2` — cliff en 3.00% y 5.00%.
**Evento corregido**: credit 2.98%→3.08% (10 pb) volteaba CONTRACTION→CRISIS con resto-de-inputs=5
(VIX 26 + MOVE 145 + dxyTrend 3%), saltando penalty 0.925→0.550 en UNA observación y
generando una orden material (~225 URNU). El rebalancer era correcto; el cliff vivía aquí.
**Ahora**: piecewise lineal 2.0%→6.0% mapea 0→2 pts (tramos 1/3 y 1 pts/pp). Continua,
monótona, sin cliffs; anclas semánticas preservadas (2%=0, 5%=1, 6%=2).
**Elección A/B/C**: piecewise lineal > sigmoid/smoothstep (la sigmoid difumina exactamente
la zona de acción ≥3%); escalón descartado (causa del bug). Documentado en el código.
**Pinned por**: src/test/creditCliffRegime.test.ts (12 tests: caso exacto vía getMasterRegime
real, batería ±5..100 pb, continuidad/monotonicidad, crisis genuina 5-6% intacta).
**Hysteresis**: NO duplicada — la corrección ataca solo el cliff; las capas existentes
(downgrade hold 6h, Regime Lock, bypass manual) quedan intactas.

## 9c. ORDER GUARD DEL REBALANCER (FIX-CLIFF-CREDIT-01 · Fase 4/5, Oct-2026)
**Where**: src/core/portfolio/rebalancer.ts + `ORDER_GUARD_CONFIG` (engineConfig)
**Regla**: BUY ≤ min(déficit, 25% NAV, €2.500) · SELLs sin cap · déficit no ejecutado →
`suggestion.pendingDeficit` (el gap NO se elimina; compras repetidas lo cierran).
**Alcance**: general a TODOS los activos, cero excepciones URNU. Capa de seguridad de
EJECUCIÓN, no un segundo motor de sizing (target-driven intacto).
**Justificación del 25%/€2.500**: ninguna ejecución institucional coloca >25% del NAV de un
activo volátil en una sesión; €2.500 ≈ tamaño máximo razonable por orden a este patrimonio.
**Pinned por**: src/test/orderGuard.test.ts (8 tests: cap por peso y valor, gap pendiente,
sells sin cap, invariante de cash, generalidad sobre BTC/VVSM/EMXC/WLG/Gold/URNU).

## 10. ERP TRIGGER
**Where**: src/core/config/engineConfig.ts
**Value**: TRIGGER_THRESHOLD = 0.025 (2.5% ERP)
**Justification**: ERP < 2.5% precedes 15-25% corrections with 64% frequency (Damodaran 2024).

## 11. BREADTH RISK POLICY (31-AUG-2026)
**Production mode**: `PROVISIONAL_LEGACY`.

The legacy majority breadth cap remains a defensive fail-safe, not an alpha signal. It is applied only to total exposure; the same `returns3m` breadth signal must not also suppress regime tilts. The production cap is not promoted or recalibrated from the current 1326-day ablation because it reduced CAGR and Sharpe while improving MaxDD only modestly.

**Institutional candidate**: `INSTITUTIONAL_CANDIDATE` in shadow mode.

The candidate uses risk-weighted adverse breadth, a continuous multiplier, and activation/deactivation hysteresis. Risk weights use covariance-aware marginal contribution when available, otherwise `weight × volatility`. The candidate never changes allocations until it passes out-of-sample validation.

**Priority protocol**:
1. Tail Risk / Kill Switch (capital protection override)
2. Volatility target
3. Production breadth fail-safe
4. ERP equity cap
5. Alpha boost
6. DCA execution decision

A divergence between `EXPANSION` and defensive breadth is expected to be visible and logged; it is not silently treated as a regime change.

**Promotion gate**: before activating the candidate, run a pre-registered walk-forward comparison against the legacy and no-breadth baselines. The report must include CAGR, Sharpe, MaxDD, Calmar, turnover, transaction costs, time under water, activation persistence, and confidence intervals. IS may select parameters; OOS may only evaluate them. No parameter may be selected from the aggregate OOS result.

**Decision log**: every live engine decision records the legacy gate, institutional shadow result, full exposure chain, policy mode, priority protocol, and regime/breadth divergence.

**Paired validation command**: `npm run evidence:paired` executes legacy, no-breadth, and institutional-candidate variants over the same five OOS windows. It reports per-variant bootstrap percentile CIs and paired candidate-minus-benchmark differences with a fixed seed (`20260831`, 10,000 resamples, 95% CI). The resampling unit is the complete OOS window, not an iid daily observation.

**Current evidence run (31-Aug-2026)**: the 1326-day continuous diagnostic evaluated 64 rebalance observations, activated the candidate 15 times and applied a reduction 7 times; `riskBreadth` was P50 20.9%, P75 58.6%, P90 82.0%, maximum 92.1%. The expanded eight-window WFO evaluated 29 OOS rebalance observations, activated 10 times and applied a reduction once. Candidate versus no-breadth was effectively neutral/slightly negative (CAGR difference −0.02 pp; Sharpe difference −0.0013) because most OOS windows did not require a reduction. This is exercise evidence, not promotion evidence; promotion remains blocked until a longer, pre-registered OOS comparison provides meaningful power.

## WALK-FORWARD VALIDATION
Grid: trainRatio [0.60-0.80] x nWindows [3-10] = 20 configs. Avg consistency 87.6%, OOS Sharpe 0.72, Grade B. System is robust to +/-20% parameter variation.

---
## 12. DCA / ATTACK / LIQUIDEZ — COHERENCIA INSTITUCIONAL (FIX-PHASE13-INSTITUTIONAL, Oct-2026)
**Origen**: auditoría forense 01-oct-2026 (informe PHASE13_FORENSIC en deliverables).
El dashboard mostraba CONTRACTION ×0.682 + ATTACK_ENTRY desplegando 39% de la liquidez
total con 3 señales débiles y persistentes.

**1. Escalera de ataque (FIX-PROBE-OFFBYONE)** — smartDCA.ts, graduación:
| Señales | Tramo | Olympus | War chest |
|---|---|---|---|
| 0-2 | DCA normal | 30% (15% con cycle-top activo) | 0% |
| 3 | ATTACK_PROBE | 25% × scale | **0% (antes bug: ENTRY 50/33)** |
| 4 | ATTACK_ENTRY | 50% × scale | 33% × scale (solo full attack) |
| 5 | ATTACK_STRONG | 75% × scale | 66% × scale (solo full attack) |
| ≥6 | ATTACK_MAX | 100% × scale | 100% × scale (solo full attack) |

**2. regimeAttackScale** = clamp(0.60, regimePenalty + 0.15, 1.00). El tramo selecciona
convicción; el régimen modula volumen. FLOOR 0.60 = defensa-en-profundidad (la banda
operativa real es penalty > 0.45 por BLOCK_CRISIS, preexistente).

**3. War chest (liquidez defensiva)**: SOLO se despliega en full attack
(macroConfluence ≥ 2 = MIN_MACRO_FOR_FULL_ATTACK). Ataques BTC-only no la tocan.

**4. Banda BTC_TOTAL** (techo 0.337, Rounds 8-9): BTC-only attack con banda excedida →
WAIT (cash acumula). Full attack → BTC skip, cash redistribuido al resto.

**5. Mutex rebalance∩DCA**: pendingRebalanceTickers (BUYs ya emitidos por el rebalancer
en el ciclo) reciben actualCost=0 en el DCA — sin doble despliegue del mismo gap.

**6. "Régimen Mejorando"** mide TRANSICIÓN (previousRegime dado por el dashboard desde
regimeHistory): CRISIS→CONTRACTION o CONTRACTION→EXPANSION. Persistencia de régimen
ya no infla la confluencia. Sin previousRegime → fallback legacy (compat).

**7. totalLiquidityFraction**: % de TODA la liquidez (broker + defensiva). El buyFraction
histórico era % del broker solo — el usuario leía "50%" siendo 39% del total.

**Pinned por**: src/test/smartDCA_phase13.test.ts (14 tests).
**Efecto en el caso 01-oct-2026**: 3 señales → €4.801 (39%) pasa a €899 (7,3%);
war chest intacta; señal UI honesta ("despliega N% de la liquidez total").

---
*Olympus Engine v5.4.3 · 01-Oct-2026 · FIX-CLIFF-CREDIT-01 + FIX-PHASE13-INSTITUTIONAL · Breadth candidate pending OOS approval*
