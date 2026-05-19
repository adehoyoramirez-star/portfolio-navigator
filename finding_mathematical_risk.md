---
name: Mathematical Model Risk and Hidden Assumptions
description: The system relies on complex mathematical models with unstated assumptions that may fail under market stress
type: risk
---
The Olympus V3 engine employs sophisticated mathematical techniques including Kelly criterion, Black-Litterman, Hierarchical Risk Parity (HRP), and various covariance matrix estimators. However, these models contain hidden assumptions and potential failure modes that are not adequately addressed.

**Key Concerns:**

1. Kelly Criterion Misapplication: The Kelly formula assumes known probabilities and payoffs, which in financial markets are estimated with significant error. Small errors in expected return estimates are magnified in the Kelly calculation (f* = μ/σ²). The system uses historical returns to estimate μ, which is notoriously noisy.

2. Covariance Estimation Instability: The Ledoit-Wolf shrinkage estimator (used in covarianceMatrix function) assumes that the true covariance matrix has a specific structure. During market crises, correlation structures break down, and the shrinkage target may be completely inappropriate.

3. Regime Detection Reliability: The system depends on regime detection to adjust parameters. However, regime changes are often only clear in hindsight, leading to whipsaw behavior where the system constantly adapts to noise rather than true regime changes.

4. Factor Model Assumptions: The factor investing approach assumes that factors like momentum, value, quality, and low volatility will continue to provide premiums. However, these factors can experience prolonged periods of underperformance.

5. Non-linear Interactions: The system applies multiple sequential adjustments (Kelly → correlation penalty → core score → blend → tactical constraints → volatility target → tail risk). The interaction of these adjustments is complex and non-linear, making it difficult to predict behavior under stress.

6. Parameter Sensitivity: The system contains numerous parameters (e.g., Kelly cap 0.20, volatility target 0.20, various thresholds in regime detection) that significantly affect outputs. Small changes in these parameters can lead to dramatically different allocations.

**Failure Scenarios:**
- During market crashes when correlations approach 1.0, the diversification benefits assumed by HRP and risk parity vanish
- When factor premia disappear or reverse, the factor-based expected returns become misleading
- In low volatility regimes, the Kelly criterion may suggest dangerously high leverage
- When volatility estimates are wrong (common during regime shifts), the volatility targeting mechanism fails

**Probability:** MEDIUM-HIGH - Mathematical models in finance frequently fail when assumptions break
**Impact:** HIGH - Could lead to significant overexposure or incorrect risk assessment
**Detection:** Stress testing with historical crisis periods; parameter sensitivity analysis; out-of-sample validation
**Mitigation:**
- Reduce model complexity and increase robustness checks
- Implement ensemble methods that combine multiple approaches
- Add explicit model uncertainty quantification
- Use more conservative parameter settings
- Implement clear break-glass procedures for model deactivation