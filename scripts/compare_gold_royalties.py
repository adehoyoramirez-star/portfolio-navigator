"""
compare_gold_royalties.py — Backtest rapido: cartera actual vs +GDX (gold miners / proxy royalties)

Ejecutar: python scripts/compare_gold_royalties.py
"""

import pandas as pd
import numpy as np
import yfinance as yf
import sys
from pathlib import Path

# -- Config --------------------------------------------------
RF_ANNUAL = 0.04
TRADING_DAYS = 252

ASSETS_BASELINE = ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"]
GDX_TICKER = "GDX"  # VanEck Gold Miners (proxy de royalties de oro)

# -- Cargar datos ------------------------------------------
project_root = Path(__file__).resolve().parent.parent
csv_path = project_root / "historical_data_daily.csv"

if not csv_path.exists():
    print(f"ERROR: CSV no encontrado en {csv_path}")
    sys.exit(1)

df = pd.read_csv(csv_path, index_col=0, parse_dates=True)
print(f"CSV cargado: {len(df)} dias, {df.index[0].strftime('%Y-%m-%d')} -> {df.index[-1].strftime('%Y-%m-%d')}")

# -- Descargar GDX ------------------------------------------
print(f"Descargando {GDX_TICKER} desde Yahoo Finance...")
gdx = yf.download(GDX_TICKER, start=df.index[0], end=df.index[-1], progress=False)
print(f"GDX: {len(gdx)} dias descargados")

if len(gdx) < 100:
    print(f"ERROR: Datos insuficientes para GDX ({len(gdx)} dias)")
    sys.exit(1)

# Alinear GDX al indice del CSV (forward-fill intra-dia, reindexar)
# Squeeze: yfinance puede devolver (N,1) en lugar de (N,)
if isinstance(gdx["Close"], pd.DataFrame):
    close_series = gdx["Close"].iloc[:, 0]
else:
    close_series = gdx["Close"]
gdx_prices = close_series.reindex(df.index, method="ffill")
# Rellenar NaN iniciales con forward-fill desde GDX real
gdx_prices = gdx_prices.ffill()

# -- Construir DataFrame unificado ---------------------------
prices = {}
for ticker in ASSETS_BASELINE:
    if ticker in df.columns:
        prices[ticker] = df[ticker].copy()
    else:
        print(f"WARN: {ticker} no encontrado en CSV")

prices[GDX_TICKER] = gdx_prices

# Crear DataFrame de precios alineados
price_df = pd.DataFrame(prices)

# Contar NaN por ticker
nan_counts = price_df.isna().sum()
print("\nNaN counts (inicio):")
for t in price_df.columns:
    if nan_counts[t] > 0:
        print(f"  {t}: {nan_counts[t]} NaN")

# Forward-fill para eliminar NaN (el backtest empieza despues del ultimo NaN)
price_df = price_df.ffill()

# -- Calcular retornos diarios ------------------------------
returns = price_df.pct_change().dropna()

# Recortar al overlap (todos los activos deben tener datos)
min_start = 0
for t in price_df.columns:
    first_valid = price_df[t].first_valid_index()
    if first_valid is not None:
        idx = price_df.index.get_loc(first_valid)
        min_start = max(min_start, idx)

start_idx = max(min_start, TRADING_DAYS)  # al menos 1 ano de lookback
returns = returns.iloc[start_idx:]
price_df = price_df.iloc[start_idx:]

print(f"\nOverlap tras limpieza: {len(returns)} dias ({len(returns)/TRADING_DAYS:.1f} years)")
print(f"Rango: {returns.index[0].strftime('%Y-%m-%d')} -> {returns.index[-1].strftime('%Y-%m-%d')}")

# -- Funciones de metricas ----------------------------------
def compute_metrics(daily_rets: np.ndarray) -> dict:
    """Sharpe (anualizado), MaxDD, CAGR, Vol, Sortino"""
    clean = daily_rets[np.isfinite(daily_rets)]
    if len(clean) < TRADING_DAYS:
        return {"cagr": 0, "sharpe": 0, "max_dd": 0, "vol": 0, "sortino": 0, "calmar": 0, "total_return": 0}
    
    years = len(clean) / TRADING_DAYS
    cumret = np.prod(1 + clean) - 1
    cagr = (1 + cumret) ** (1 / years) - 1 if cumret > -1 else -1
    
    # Sharpe
    excess = clean - RF_ANNUAL / TRADING_DAYS
    sharpe = np.mean(excess) / np.std(clean, ddof=1) * np.sqrt(TRADING_DAYS) if np.std(clean, ddof=1) > 0 else 0
    
    # Max Drawdown
    equity = np.cumprod(1 + clean)
    peak = np.maximum.accumulate(equity)
    dd = (equity - peak) / peak
    max_dd = np.min(dd)
    
    # Volatilidad anualizada
    vol = np.std(clean, ddof=1) * np.sqrt(TRADING_DAYS)
    
    # Sortino
    downside = clean[clean < 0]
    down_std = np.std(downside, ddof=1) * np.sqrt(TRADING_DAYS) if len(downside) > 1 else 0
    sortino = (np.mean(clean) * TRADING_DAYS - RF_ANNUAL) / down_std if down_std > 1e-10 else (999 if cagr > 0 else 0)
    
    # Calmar
    calmar = cagr / abs(max_dd) if max_dd < -1e-10 else 0
    
    return {
        "cagr": cagr,
        "sharpe": sharpe,
        "max_dd": max_dd,
        "vol": vol,
        "sortino": sortino,
        "calmar": calmar,
        "total_return": cumret,
    }


def correlation_matrix(daily_rets_df: pd.DataFrame) -> np.ndarray:
    """Matriz de correlacion"""
    return daily_rets_df.corr().values


def avg_pairwise_corr(corr: np.ndarray) -> float:
    """Correlacion media entre pares (excluye diagonal)"""
    n = corr.shape[0]
    if n <= 1:
        return 0
    upper = corr[np.triu_indices(n, k=1)]
    return float(np.mean(upper))


# -- Backtest Equal-Weight ----------------------------------
def run_equal_weight_backtest(return_df: pd.DataFrame, tickers: list[str]) -> dict:
    """Equal-weight sin rebalanceo (true buy-and-hold)."""
    rets = return_df[tickers].copy()
    
    # Equal-weight: cada activo empieza con 1/n
    n = len(tickers)
    
    # Retorno diario del portfolio = media ponderada de retornos individuales
    portfolio_rets = rets.mean(axis=1).values
    
    metrics = compute_metrics(portfolio_rets)
    corr = correlation_matrix(rets)
    metrics["avg_corr"] = avg_pairwise_corr(corr)
    metrics["n_assets"] = n
    
    return metrics


# -- EJECUTAR COMPARACIÓN ------------------------------------
print("\n" + "=" * 60)
print("  COMPARATIVA: Cartera actual vs +GDX (Gold Miners)")
print("  Equal-Weight — Buy & Hold")
print("=" * 60)

baseline = run_equal_weight_backtest(returns, ASSETS_BASELINE)
with_gdx = run_equal_weight_backtest(returns, ASSETS_BASELINE + [GDX_TICKER])

# -- Mostrar resultados -------------------------------------
print(f"\n{'Metrica':<25} | {'BASELINE (6 activos)':<22} | {'+GDX (7 activos)':<22} | Delta")
print("-" * 85)

rows = [
    ("CAGR", "cagr", "{:.2%}", False),
    ("Sharpe Ratio", "sharpe", "{:.2f}", False),
    ("Sortino Ratio", "sortino", "{:.2f}", False),
    ("Max Drawdown", "max_dd", "{:.2%}", True),
    ("Volatilidad (anual.)", "vol", "{:.2%}", False),
    ("Calmar Ratio", "calmar", "{:.2f}", False),
    ("Total Return", "total_return", "{:.2%}", False),
    ("Correlacion media", "avg_corr", "{:.3f}", False),
]

for label, key, fmt, lower_is_better in rows:
    b = baseline[key]
    g = with_gdx[key]
    delta = g - b
    
    # Direccion del delta
    if lower_is_better:
        arrow = "+" if delta < -0.001 else ("-" if delta > 0.001 else "~")
    else:
        arrow = "+" if delta > 0.001 else ("-" if delta < -0.001 else "~")
    
    b_str = fmt.format(b)
    g_str = fmt.format(g)
    
    if key == "cagr":
        d_str = f"{delta:+.2%}"
    elif key in ("max_dd", "vol", "total_return"):
        d_str = f"{delta:+.2%}"
    elif key == "avg_corr":
        d_str = f"{delta:+.3f}"
    else:
        d_str = f"{delta:+.2f}"
    
    print(f"{label:<25} | {b_str:<22} | {g_str:<22} | {arrow} {d_str}")

# -- Correlacion de GDX con cada activo ---------------------
print(f"\n{'-' * 60}")
print(f"  Correlacion de {GDX_TICKER} con cada activo existente:")
print(f"{'-' * 60}")

corr_matrix = returns[ASSETS_BASELINE + [GDX_TICKER]].corr()
gdx_corrs = corr_matrix[GDX_TICKER].drop(GDX_TICKER).sort_values(ascending=False)

for ticker, corr_val in gdx_corrs.items():
    bar = "#" * int(abs(corr_val) * 20)
    sign = "+" if corr_val >= 0 else ""
    print(f"  {ticker:<20} {sign}{corr_val:.3f}  {bar}")

# -- GDX vs PPFB (oro fisico) -----------------------------
gdx_ppfb_corr = gdx_corrs.get("PPFB.DE", 0)
print(f"\n  -> Correlacion GDX-PPFB (oro fisico): {gdx_ppfb_corr:.3f}")
print(f"  -> Diversificacion real anadida: {'BAJA' if gdx_ppfb_corr > 0.5 else 'MEDIA' if gdx_ppfb_corr > 0.3 else 'ALTA'}")

# -- Rolling 1Y correlation GDX vs S&P proxy (WLG) ---------
if "0P00000WLG.F" in returns.columns:
    rolling_corr = returns[GDX_TICKER].rolling(TRADING_DAYS).corr(returns["0P00000WLG.F"])
    avg_rolling = rolling_corr.dropna().mean()
    print(f"  -> Correlacion media 1Y GDX-WLG (equity): {avg_rolling:.3f}")
    
    # Comportamiento en drawdowns de WLG
    wlg_dd = returns["0P00000WLG.F"].copy()
    drawdown_periods = wlg_dd[wlg_dd < -0.02]  # dias con retorno < -2%
    if len(drawdown_periods) > 0:
        gdx_in_crisis = returns.loc[drawdown_periods.index, GDX_TICKER].mean()
        wlg_in_crisis = drawdown_periods.mean()
        print(f"  -> En dias de WLG < -2%: GDX media = {gdx_in_crisis:.2%}, WLG media = {wlg_in_crisis:.2%}")
        print(f"  -> Safe-haven test: {'FALLA' if gdx_in_crisis < -0.01 else 'NEUTRAL' if gdx_in_crisis < 0 else 'PASA'}")

print()
