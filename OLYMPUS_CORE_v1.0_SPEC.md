# OLYMPUS CORE v1.0 — SPECIFICATION (FROZEN)

**Estado:** CONGELADA bajo change-control (§18). Cualquier modificación → v1.1 con validación IS+OOS+WFA.
**Evidencia:** Phases 9–12 del forensic audit. Entregables en `~/olympus_phase12_deliverables/`.
**Implementación:** `OLYMPUS_CORE` en `src/core/config/engineConfig.ts` (switch `enabled`, default `false`), rutas `coreMode` en `src/core/engine/olympusV3.ts`, pass-through en `src/core/backtest/backtestEngine.ts`.

---

## 1. Universe

6 activos, vía `ASSETS` en `src/lib/constants.ts` (fuente única):

| Ticker | Activo | Sector |
|---|---|---|
| BTC-EUR | Bitcoin | crypto |
| EMXC.DE | iShares MSCI Emerging Markets | emerging |
| PPF B.DE | iShares Physical Gold | gold |
| URNU.DE | Uranium ETF | uranium |
| VVSM.DE | iShares MSCI World Small Cap | equity/small |
| 0P00000WLG.F | Vanguard Global Stock Index | equity/global |

No añadir activos sin nueva versión (v1.1).

## 2. Data sources

- **Precios:** Yahoo Finance vía Edge Function `supabase/functions/yahoo-finance/` → CSV histórico `historical_data_daily_augmented.csv` para backtest.
- **Covarianza:** Ledoit-Wolf shrinkage (`src/core/data/volatility.ts`) sobre ventana de 63 días en rebalanceo.
- **Macro:** VIX, yield spread, credit spread (BAMLH0A0HYM2), MOVE, DXY trend, BTC vol (pipeline existente).

## 3. Data validation (v1.0.1)

- Prohibido fallback silencioso (`OLYMPUS_CORE.dataPolicy`).
- Todo dato faltante → `MISSING` / `ERROR` / `EXPLICIT FALLBACK` logueado y visible en `meta`.
- Guards existentes conservados: sanitización NaN/Inf de `AssetInput`, `hasRealCovMatrix` con validación dimensional.

## 4. Covariance

- **Ledoit-Wolf (2004)** con shrinkage oracle δ ∈ [0.10, 0.35].
- Ventana: 63 días en cada rebalanceo; anualización √252.
- **DCC-GARCH EXCLUIDO del Core** (evidencia: direccionalmente inconsistente: +3.2pp OOS, −2.8pp 2022, −5.6pp 2026; bootstrap CI incluye 0; 807 LOC de model risk). Reconsiderable solo con test de paridad live/backtest (v1.1+).

## 5. Allocation

- **HRP puro**: `blend = { BL: 0.0, HRP: 1.0, MIN_VAR: 0.0 }`.
- Bit-idéntico al fingerprint validado en Phase 12 (`CORE_notrend`: OOS final €19,917.057…).
- Black-Litterman: fuera del Core (Sharpe −0.112 vs HRP-only; BTC P95 22%).
- MinVar: fuera (ablación: +0.013 Sharpe al eliminarlo; fallback ya 0.00).

## 6. Trend logic

- **Trend Gate: OVERLAY OPCIONAL, no Core.** Clasificación de evidencia: EPISODIC (protege en 1 de 9 episodios; único beneficio material = episodio 2025).
- Señal: >50% de activos con `returns3m < 0` (misma señal del gate legacy — sin thresholds nuevos).
- Mecanismo validado (test E_both, Phase 12 / `TREND_GATE_FINAL_TEST.csv`):
  - **STAGED EXIT:** primera activación tras periodo limpio → cap 60%.
  - **CONFIRMED RE-ENTRY:** exposición plena solo tras 2 rebalanceos limpios consecutivos.
- Estado serializado en `CoreTrendGateState { lastGateCallIndex, reentryCount, engaged }`.

## 7. BTC total budget

- **BTC caps por régimen: ELIMINADOS del Core** (ablación bit-idéntica — nunca binding; `STRONG_BUY` inalcanzable en backtest).
- Métrica first-class: `computeBtcTotalRisk()` en `compositeMetrics.ts`:
  `BTC_TOTAL = satelliteWeight + (1 − satelliteWeight) × BTC_motor`
  Reporta mean / P95 / P99 / max diarios. El satélite NO es diversificación: es decisión de riesgo BTC.
- Referencia descriptiva (satélite 90/10): BTC_TOTAL mean 18.2%, P95 21.7%, P99/max 23.0%.

## 8. Satellite

- **EXTERNO al motor** (declaración formal del contrato). Decisión explícita de budget.
- El backtest canónico corre el sleeve motor sin satélite; el composite (satélite incluido) se reporta por separado.

## 9. Rebalance

- Cada **21 días** (calendario canónico V10-CANONICAL).
- Las nuevas allocations entran en vigor el día **siguiente** del rebalanceo (FIX-BT-1, anti look-ahead).

## 10. Execution

- **D+1**: señal con cierre de t, ejecución con cierre de t+1.
- Costes de transacción aplicados en el momento del rebalanceo.
- Capital inicial canónico: **€10,000**.

## 11. Transaction costs

- Por activo (`ASSET_COST_PARAMS`): half-spread × 2 × turnover × valor de cartera + **€1 fijo** por activo operado.
- Benchmark continúa con 15 bps planos (comparabilidad histórica).

## 12. Risk metrics obligatorias

CAGR, Sharpe, Sortino, Calmar, MaxDD, Average DD, Ulcer, CVaR95, Profit Factor, Upside/Downside Capture, Turnover, Costes, BTC mean/P95/max, BTC variance share, duración de drawdown, recovery time. Rolling 12m: CAGR y Sharpe.

## 13. Kill conditions

Condiciones bajo las cuales el Core se considera roto y requiere intervención:
1. Desviación del fingerprint canónico (hash de determinismo) en igualdad de datos/config.
2. Fingerprint OOS (2023–2025) fuera del rango de validación {CAGR 25.8% ± 2pp, Sharpe 1.72 ± 0.15, MaxDD −16.7% ± 2pp}.
3. Turnover medio > 15/año sin cambio de universo.
4. Falta de dato crítico sin fallback explícito (data policy violada).

## 14. Failure modes registrados

| Modo | Mecanismo | Mitigación |
|---|---|---|
| V-recovery | Gate corta recuperación | Re-entry confirmado (2 rebalanceos) |
| Late activation | Gate llega tras >60% del daño | Aceptado (documentado); no hay señal previa validada |
| BTC concentration | 48–74% de la varianza según blend | Métrica BTC_TOTAL first-class |
| Defensive stacking | KS/VT/gate co-firing | Stack fuera del Core |
| Baseline drift | Sesiones no reproducibles | Change-control §18 + fingerprint |

## 15. Monitoring

- `engineVersion` en cada output (`v5.4.0-core1`).
- `meta.coreMode`, `meta.coreTrendGateActive/Multiplier/Reason` en cada decisión.
- `BacktestOutput.coreMode / coreTrendGateEnabled / coreTrendGateFinalState`.
- Diagnostics existentes del gate legacy intactos para auditoría comparativa.

## 16. Reproducibility

- Baseline canónico: V10-CANONICAL (Ledoit-Wolf, 21d, lookback 252, costes por activo, €10k, D+1).
- Fingerprint bit-exact: final_value €18,397.60378284537 (FULL engine), €19,917.057257268985 (CORE, OOS).
- Bootstrap pareado: bloque 21d, 5000 remuestreos, seed 20260928. NOTA: el dominio de índices debe igualar la longitud de la serie de retornos (n−1); el bug de NaN ya documentado no debe reintroducirse.
- Phase 8: archivada IRRECUPERABLE / NO REPRODUCIBLE.

## 17. Versioning

- `ENGINE_VERSION` = `v5.4.0-core1` · `ENGINE_CONFIG_VERSION` = `3.9.0` · `OLYMPUS_CORE.version` = `1.0.0`.
- La ruta CORE es **opt-in** (`coreMode: true` por llamada o `OLYMPUS_CORE.enabled`); la ruta por defecto es bit-idéntica a v5.3.

## 18. Change-control policy

1. Ningún parámetro cambia porque "el backtest reciente empeoró".
2. Toda modificación → nueva versión (v1.1, v1.2…) con: validación IS + OOS + WFA, costes, robustez (bootstrap), contrato live/backtest y tests automatizados.
3. Se conserva siempre una versión benchmark congelada y reproducible.
4. Excepciones requieren justificación escrita en `decision_log`.

---

## Apéndice: decisiones por componente (evidencia Phase 12 / COMPONENT_FINAL_DECISION.csv)

| Componente | Decisión |
|---|---|
| HRP | KEEP CORE |
| Ledoit-Wolf | KEEP CORE |
| DCC-GARCH | REMOVE (revisable con paridad live) |
| Black-Litterman | REMOVE del Core (opcional) |
| Trend Gate (E_both) | OPTIONAL OVERLAY |
| Kill Switch | REMOVE |
| Vol Target | REMOVE |
| Régimen macro | OFF / UNVERIFIED |
| BTC caps | REMOVE |
| BTC total budget | KEEP CORE (métrica) |
| Satellite | EXTERNO (budget) |
| Cycle Top / Alpha Boost | LIVE-ONLY / UNVERIFIED |
| Kelly branch, MinVar, overlay discrecional, engineOverrides | REMOVE |
| DCA | SEPARATE del motor |
