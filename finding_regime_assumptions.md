---
name: Regime Persistence and Market Behavior Assumptions
description: The system assumes market regimes persist and that historical patterns will continue, which may fail during regime shifts
---
The Olympic V3 system makes strong assumptions about market regime persistence and the stability of statistical relationships. These assumptions represent significant sources of model risk that could lead to poor performance during regime transitions.

**Core Assumptions:**

1. Regime Persistence: The system assumes that once a market regime is identified (expansion, contraction, crisis), it will persist for a meaningful period. However, regime changes can be sudden and frequent, leading to whipsaw behavior where the system constantly chases regime changes.

2. Stability of Statistical Relationships: The system assumes that correlations, volatilities, and factor relationships remain stable within regimes. During market stress, these relationships often break down in unpredictable ways (e.g., correlations approaching 1.0 for all assets).

3. Mean Reversion in Indicators: Many technical indicators used (RSI, moving averages, etc.) assume mean reversion. During strong trends, these indicators can remain at extreme levels for extended periods, leading to false signals.

4. Factor Persistence: The factor investing approach assumes that factors like momentum and value will continue to provide premiums. However, factor premia can disappear for extended periods, especially during regime shifts.

5. Linear Factor Model: The system assumes returns can be adequately explained by linear factor models. During crises, nonlinear effects and tail risks dominate.

**Specific Vulnerabilities:**

1. Regime Detection Lag: The regime detection system uses economic indicators (VIX, yield spreads, etc.) that may lag actual market movements. By the time the regime is identified, the market may have already moved on.

2. Pro-cyclical Bias: The system's regime classification may inadvertently create pro-cyclical bias - becoming more aggressive during bull markets and more defensive during bear markets, potentially amplifying market moves.

3. Inadequate Regime Classification: The three-regime model (expansion, contraction, crisis) may be too simplistic to capture complex market dynamics. There are many intermediate states and mixed conditions that don't fit neatly into these categories.

4. Threshold Arbitrariness: The thresholds used for regime classification (e.g., VIX > 30 for crisis) are somewhat arbitrary and may not correspond to actual regime changes in all market conditions.

5. Lack of Regime Uncertainty: The system treats regime classification as certain, when in reality there is often significant uncertainty about the current regime, especially during transitions.

**Failure Scenarios:**

1. False Regime Signals: During periods of high volatility but continuing uptrend (like 2020 recovery), the system may incorrectly classify the market as crisis and reduce exposure at the worst possible time.

2. Regime Whipsaw: During sideways or choppy markets, the system may flip-flop between regimes, leading to excessive trading and poor performance.

3. Missed Regime Changes: The system may fail to detect actual regime changes until well after they occur, leading to inappropriate risk exposure.

4. Inappropriate Factor Tilts: During regime shifts, factor premia may behave unexpectedly (e.g., momentum crashing during market reversals), but the system continues to rely on historical factor relationships.

**Evidence of Potential Issues:**
- The system's reliance on the VIX for regime detection is problematic as VIX can spike for reasons unrelated to equity market direction
- The use of yield spreads has similar issues - they can move due to monetary policy changes rather than equity market stress
- The system does not appear to account for the fact that different asset classes may be in different regimes simultaneously

**Probability:** HIGH - Regime misclassification is common in practice
**Impact:** MEDIUM-HIGH - Could lead to significant underperformance or inappropriate risk taking
**Detection:** 
- Analyze regime classification accuracy using hidden Markov models or other regime detection techniques
- Test performance during known regime change periods
- Evaluate regime classification stability and uncertainty
**Mitigation:**
- Add regime uncertainty quantification and make decisions more robust to regime misclassification
- Use more sophisticated regime detection methods (e.g., machine learning approaches with uncertainty)
- Consider alternative approaches that don't rely on explicit regime classification
- Increase diversification to reduce dependence on correct regime identification