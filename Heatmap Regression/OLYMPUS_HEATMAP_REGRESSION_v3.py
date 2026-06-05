#!/usr/bin/env python3
"""
OLYMPUS HEATMAP REGRESSION v3.0 — Hende Fund
Uso: python OLYMPUS_HEATMAP_REGRESSION_v3.py
Output: heatmap_dashboard.html, predictions.csv, correlations.csv, portfolio_q5.csv

CORRECCIONES v3.0 vs v2.0:
  [FIX-1]  RSI corregido: EMA Wilder (alpha=1/p) en lugar de SMA rolling
  [FIX-2]  ADX corregido: True Range y DM con EMA Wilder, no SMA
  [FIX-3]  Trend Efficiency vectorizado: eliminado loop O(n²) Python
  [FIX-4]  Forward-leak eliminado: fwd_ranked calculado SOLO sobre tickers
             con target genuinamente disponible en cada ventana temporal
  [FIX-5]  TRAIN_END con buffer adicional +5 días para evitar contaminación parcial
  [FIX-6]  Quintiles reales del universo (qcut) en lugar de bins fijos de 20 pts
  [FIX-7]  Volumen missing: NaN en lugar de fillna(0) — evita picos espurios
  [FIX-8]  Walk-Forward expandido: 3 folds (no split único 75/25)
  [FIX-9]  Módulo de Portfolio Construction Q5: pesos HRP simplificado,
             VaR portfolio diario, HHI, concentración y sizing €
  [FIX-10] Dashboard unificado: una sola matriz de correlación (LW) para
             display y exportación — eliminada ambigüedad Pearson vs LW
  [FIX-11] Lookback ampliado a 504 días (2 años) para OOS estadísticamente válido
  [FIX-12] Descarga con auto-retry y chunks para evitar timeout silencioso
"""

import os, sys, webbrowser, pickle, time, logging, warnings
from datetime import datetime
from fred_data import fetch_fred_factors
from finra_data import fetch_finra_factors
from insider_data import fetch_insider_factors
from sentiment_data import fetch_sentiment_factors

warnings.filterwarnings("ignore")

# ─── PARÁMETROS GLOBALES ──────────────────────────────────────────────────────
LOOKBACK          = 504          # [FIX-11] 2 años = OOS estadísticamente válido
HEATMAP_DISPLAY_N = 50
HORIZON           = 5            # Horizonte de predicción en días
N_FOLDS           = 3            # [FIX-8] Walk-forward: número de folds OOS
CACHE_MAX_AGE     = 24 * 3600    # Caché de 24 horas
MIN_IC_FOR_SIGNAL = 0.02         # IC mínimo para señal válida

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "heatmap_cache.pkl")

# ─── UNIVERSO ─────────────────────────────────────────────────────────────────
CURATED = [
    "SPY","QQQ","IWM","DIA","MDY",
    "XLK","XLF","XLV","XLY","XLI","XLC","XLE","XLP","XLRE","XLB","XLU",
    "EEM","EFA","EWJ","FXI","EWZ","INDA","IEUR","VGK",
    "GLD","SLV","USO","DBC",
    "TLT","AGG","LQD","HYG",
    "IBIT","FBTC","BITO",
    "^VIX",
]

SP500_FALLBACK = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","BRK-B","AVGO","TSLA",
    "LLY","JPM","V","UNH","XOM","MA","COST","WMT","HD","PG","NFLX","JNJ",
    "ABBV","BAC","ORCL","CRM","CVX","AMD","MRK","KO","PEP","WFC","ADBE",
    "NOW","CSCO","IBM","MCD","QCOM","LIN","DIS","ABT","CAT","GE","TMO",
    "AXP","INTU","ISRG","VZ","MS","PM","RTX","DHR","TXN","AMGN","SPGI",
    "T","GS","PFE","NEE","UBER","PLTR","BKNG","LOW","CMCSA","BLK","PGR",
    "UNP","ETN","HON","TJX","SYK","BSX","C","COP","PANW","ADP",
    "LMT","MDT","BX","VRTX","ANET","BMY","CB","DE","SBUX","MU",
    "ADI","GILD","KLAC","SO","AMT","MO","LRCX","SCHW","TMUS","CI",
    "UPS","INTC","MDLZ","BA","SHW","ICE","DUK","ZTS","TT","ELV",
    "REGN","MMC","AON","PLD","WELL","MCO","CTAS","ITW","ECL","FI",
    "NSC","WM","ROP","APH","GWW","HCA","CME","COF","TDG","CARR",
]

import pandas as pd
import numpy as np

# ─── SP500 DESDE WIKIPEDIA ────────────────────────────────────────────────────
print("📡 Obteniendo SP500 desde Wikipedia...")
try:
    sp500_tables = pd.read_html(
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
        storage_options={"User-Agent": "Mozilla/5.0 Olympus/3.0"})
    sp500_df  = sp500_tables[0]
    col       = "Symbol" if "Symbol" in sp500_df.columns else sp500_df.columns[0]
    sp500_tickers = [t.replace(".", "-") for t in sp500_df[col].tolist()]
    print(f"   ✅ {len(sp500_tickers)} tickers del SP500")
except Exception as e:
    print(f"   ⚠️ Wikipedia falló ({e}), usando fallback offline")
    sp500_tickers = SP500_FALLBACK

all_tickers = list(set(sp500_tickers) | set(CURATED))
print(f"📊 Universo total: {len(all_tickers)} tickers")

# ─── CACHÉ ────────────────────────────────────────────────────────────────────
def load_cache():
    if not os.path.exists(CACHE_FILE):
        return None
    age = time.time() - os.path.getmtime(CACHE_FILE)
    if age >= CACHE_MAX_AGE:
        return None
    try:
        with open(CACHE_FILE, 'rb') as f:
            cached = pickle.load(f)
        required = {'closes', 'volume', 'available', 'lookback'}
        if not required.issubset(cached.keys()):
            os.remove(CACHE_FILE)
            return None
        # Invalidar si el lookback cambió
        if cached.get('lookback') != LOOKBACK:
            print("   ⚠️ Cache con LOOKBACK diferente, redescargando...")
            os.remove(CACHE_FILE)
            return None
        print(f"   📦 Cache ({age/3600:.1f}h) — {len(cached['available'])} tickers · {LOOKBACK}d")
        return cached
    except Exception:
        try:
            os.remove(CACHE_FILE)
        except Exception:
            pass
        return None

def save_cache(closes_df, volume_df, tickers_list):
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump({
                'closes': closes_df, 'volume': volume_df,
                'available': tickers_list, 'timestamp': time.time(),
                'lookback': LOOKBACK
            }, f)
        print(f"   💾 Cache guardado ({os.path.getsize(CACHE_FILE)/1024:.0f} KB)")
    except Exception as e:
        print(f"   ⚠️ No se pudo guardar cache: {e}")

# ─── DESCARGA CON CHUNKS Y RETRY [FIX-12] ────────────────────────────────────
def download_with_retry(tickers, period_days, chunk_size=200, max_retries=2):
    """Descarga en chunks para evitar timeout silencioso de Yahoo."""
    import yfinance as yf
    period_str = f"{period_days + 40}d"
    all_close  = {}
    all_volume = {}
    chunks     = [tickers[i:i+chunk_size] for i in range(0, len(tickers), chunk_size)]
    print(f"   📦 {len(chunks)} chunks de hasta {chunk_size} tickers...")
    for ci, chunk in enumerate(chunks):
        for attempt in range(max_retries + 1):
            try:
                data = yf.download(chunk, period=period_str, progress=False,
                                   auto_adjust=True, threads=True)
                if data.empty:
                    print(f"   ⚠️ Chunk {ci+1}: Yahoo devolvió datos vacíos (pueden ser tickers inválidos)")
                    c_close = pd.DataFrame()
                    c_volume = pd.DataFrame()
                elif isinstance(data.columns, pd.MultiIndex):
                    c_close  = data["Close"]  if "Close"  in data.columns.get_level_values(0) else pd.DataFrame()
                    c_volume = data["Volume"] if "Volume" in data.columns.get_level_values(0) else pd.DataFrame()
                else:
                    # Un solo ticker (o data con columnas planas)
                    if "Close" not in data.columns or "Volume" not in data.columns:
                        print(f"   ⚠️ Chunk {ci+1}: columnas inesperadas: {list(data.columns)}")
                        c_close = pd.DataFrame()
                        c_volume = pd.DataFrame()
                    else:
                        c_close  = data[["Close"]].rename(columns={"Close": chunk[0]})
                        c_volume = data[["Volume"]].rename(columns={"Volume": chunk[0]})
                for t in c_close.columns:
                    all_close[t]  = c_close[t]
                    if t in c_volume.columns:
                        all_volume[t] = c_volume[t]
                break
            except Exception as ex:
                if attempt < max_retries:
                    print(f"   ⚠️ Chunk {ci+1} intento {attempt+1} falló ({ex}), reintentando...")
                    time.sleep(2)
                else:
                    print(f"   ❌ Chunk {ci+1} descartado definitivamente: {ex}")
        sys.stdout.write(f"\r   ⬇️  {min((ci+1)*chunk_size, len(tickers))}/{len(tickers)} tickers")
        sys.stdout.flush()
    print()
    closes_raw = pd.DataFrame(all_close)
    volume_raw = pd.DataFrame(all_volume)
    return closes_raw, volume_raw

cache = load_cache()
if cache:
    closes    = cache['closes']
    available = cache['available']
    volume_df = cache['volume']
else:
    print(f"📡 Descargando {len(all_tickers)} tickers ({LOOKBACK}d)...")
    try:
        closes_raw, volume_df = download_with_retry(all_tickers, LOOKBACK)
        closes = closes_raw.tail(LOOKBACK).dropna(axis=1, thresh=int(LOOKBACK * 0.90))
        available = list(closes.columns)
        closes    = closes[available]
        print(f"   ✅ {len(available)} tickers con ≥90% de datos")
        if len(available) < 50:
            print("   ❌ Muy pocos tickers. Revisa conexión o rate-limit de Yahoo.")
            sys.exit(1)
        save_cache(closes, volume_df, available)
    except Exception as e:
        print(f"   ❌ {e}\n   🔧 pip install yfinance pandas numpy scikit-learn lightgbm")
        sys.exit(1)

# ─── SELECCIÓN PARA HEATMAP VISUAL ───────────────────────────────────────────
curated_set   = set(CURATED)
heatmap_tickers = [t for t in CURATED if t in available]
stock_candidates = []
for t in available:
    if t in curated_set:
        continue
    # [FIX-7] NaN en volumen → 0 solo para ranking de heatmap, no para factor
    vol = volume_df[t].iloc[-1] if t in volume_df.columns else np.nan
    vol = 0 if pd.isna(vol) else vol
    stock_candidates.append((t, closes[t].iloc[-1] * vol))
stock_candidates.sort(key=lambda x: x[1], reverse=True)
top_n = min(HEATMAP_DISPLAY_N - len(heatmap_tickers), len(stock_candidates))
heatmap_tickers.extend([t for t, _ in stock_candidates[:top_n]])
print(f"🔥 Heatmap: {len(heatmap_tickers)} tickers  |  📈 Regresión: {len(available)} tickers")

# ─── INDICADORES TÉCNICOS CORREGIDOS ─────────────────────────────────────────

def rsi_wilder(prices: np.ndarray, period: int) -> np.ndarray:
    """[FIX-1] RSI con EMA Wilder (alpha=1/period) — estándar de la industria."""
    delta = np.diff(prices, prepend=prices[0])
    gains = np.where(delta > 0, delta, 0.0)
    losses = np.where(delta < 0, -delta, 0.0)
    # EMA Wilder: alpha = 1/period
    alpha = 1.0 / period
    ag = pd.Series(gains).ewm(alpha=alpha, adjust=False).mean().values
    al = pd.Series(losses).ewm(alpha=alpha, adjust=False).mean().values
    rs = np.divide(ag, al, out=np.full_like(ag, 100.0), where=al > 1e-10)
    return 100.0 - (100.0 / (1.0 + rs))


def adx_wilder(prices: np.ndarray, period: int = 14) -> tuple:
    """[FIX-2] ADX con True Range y DM usando EMA Wilder — estándar Wilder 1978."""
    n     = len(prices)
    alpha = 1.0 / period

    # True Range
    high_approx = prices  # usamos close como proxy (OHLC no disponible)
    low_approx  = prices
    tr = np.zeros(n)
    tr[0] = 0.0
    for i in range(1, n):
        tr[i] = abs(high_approx[i] - low_approx[i-1])  # simplificado sin H/L

    # +DM / -DM desde cambios de precio
    dp = np.diff(prices, prepend=prices[0])
    dm_plus  = np.where(dp > 0, dp, 0.0)
    dm_minus = np.where(dp < 0, -dp, 0.0)

    # EMA Wilder para TR, +DM, -DM
    tr_ema  = pd.Series(tr).ewm(alpha=alpha, adjust=False).mean().values
    dmp_ema = pd.Series(dm_plus).ewm(alpha=alpha, adjust=False).mean().values
    dmm_ema = pd.Series(dm_minus).ewm(alpha=alpha, adjust=False).mean().values

    tr_safe = np.maximum(tr_ema, 1e-10)
    di_plus  = dmp_ema / tr_safe * 100
    di_minus = dmm_ema / tr_safe * 100
    di_sum   = di_plus + di_minus
    di_sum_safe = np.maximum(di_sum, 1e-10)
    dx  = np.abs(di_plus - di_minus) / di_sum_safe * 100
    adx = pd.Series(dx).ewm(alpha=alpha, adjust=False).mean().values
    return adx, di_plus, di_minus


def trend_efficiency_vectorized(prices: np.ndarray, period: int = 20) -> np.ndarray:
    """[FIX-3] Trend Efficiency Ratio vectorizado — eliminado loop O(n²)."""
    s = pd.Series(prices)
    net_displacement = s.diff(period).abs()
    # Suma rolling de movimientos absolutos diarios
    path_length = s.diff().abs().rolling(period).sum()
    te = (net_displacement / path_length.replace(0, np.nan) * 100).fillna(0)
    return te.values


def calc_indicators(price_series: pd.Series) -> dict | None:
    """Calcula indicadores técnicos corregidos para un ticker."""
    c = price_series.values
    n = len(c)
    if n < 65:  # mínimo para vol63 en factores
        return None

    ma20  = pd.Series(c).rolling(20).mean().values
    ma50  = pd.Series(c).rolling(50).mean().values
    ma200 = pd.Series(c).rolling(200, min_periods=50).mean().values

    r2  = rsi_wilder(c, 2)   # [FIX-1]
    r14 = rsi_wilder(c, 14)  # [FIX-1]

    # ATR simplificado (solo close disponible)
    tr     = np.concatenate([[0], np.abs(np.diff(c))])
    atr14  = pd.Series(tr).ewm(alpha=1/14, adjust=False).mean().values  # EMA Wilder
    atr_pct = np.divide(atr14, c, out=np.zeros_like(atr14), where=c > 0)

    # MACD
    e12 = pd.Series(c).ewm(span=12, adjust=False).mean().values
    e26 = pd.Series(c).ewm(span=26, adjust=False).mean().values
    ml  = e12 - e26
    ms  = pd.Series(ml).ewm(span=9, adjust=False).mean().values
    mh  = ml - ms

    # Trend Efficiency [FIX-3]
    te  = trend_efficiency_vectorized(c, 20)

    # ADX [FIX-2]
    adx, _, _ = adx_wilder(c, 14)

    ret = pd.Series(c).pct_change().fillna(0).values

    return {
        "rsi2": r2, "rsi14": r14,
        "atr_pct": atr_pct, "macd_hist": mh,
        "trend_eff": te, "adx": adx,
        "returns": ret, "close": c,
        "ma20": ma20, "ma50": ma50, "ma200": ma200
    }


print("🧮 Calculando indicadores Olympus (RSI Wilder + ADX Wilder)...")
all_ind = {}
for t in available:
    r = calc_indicators(closes[t])
    if r is not None:
        all_ind[t] = r
print(f"   ✅ {len(all_ind)} tickers con indicadores")

# ─── MATRIZ DE CORRELACIONES — LEDOIT-WOLF (una sola) [FIX-10] ───────────────
print("📊 Matriz de correlaciones Ledoit-Wolf...")
from sklearn.covariance import LedoitWolf

rdf_all = pd.DataFrame({t: all_ind[t]["returns"] for t in all_ind}).fillna(0)
lw      = LedoitWolf().fit(rdf_all.values)
cov_lw  = pd.DataFrame(lw.covariance_, index=rdf_all.columns, columns=rdf_all.columns)
std_lw  = np.sqrt(np.diag(cov_lw.values))
corr_lw = cov_lw.div(std_lw, axis=0).div(std_lw, axis=1).round(3)

# Para el heatmap visual usamos LW [FIX-10]
heatmap_display = [t for t in heatmap_tickers if t in all_ind]
corr_hm = corr_lw.loc[heatmap_display, heatmap_display]
print(f"🔥 Heatmap (LW): {len(heatmap_display)} tickers")

# ─── MOTOR CROSS-SECTIONAL CON WALK-FORWARD [FIX-4, FIX-5, FIX-8] ────────────
print("📈 Motor Quant Cross-Sectional — GBM + Walk-Forward + IC...")

try:
    import lightgbm as lgb
    _USE_LGB = True
    print("   ⚡ LightGBM detectado")
except ImportError:
    from sklearn.ensemble import GradientBoostingRegressor
    _USE_LGB = False
    print("   ℹ️  Usando GradientBoosting (pip install lightgbm para mayor velocidad)")

from scipy.stats import spearmanr

# ── 1. Panel de retornos ──────────────────────────────────────────────────────
tickers_panel = sorted(all_ind.keys())
ret_df = pd.DataFrame({t: all_ind[t]["returns"] for t in tickers_panel})
log_ret = np.log1p(ret_df)

# ── 2. Factores cross-seccionales ────────────────────────────────────────────
# F1: Momentum 21d
mom21 = np.expm1(log_ret.rolling(21).sum())
# F2: Reversal 5d (contrarian)
rev5 = -np.expm1(log_ret.rolling(5).sum())
# F3: Compresión de volatilidad (vol baja = señal long)
vol5  = ret_df.rolling(5).std()
vol63 = ret_df.rolling(63).std().replace(0, np.nan)
volratio = -(vol5 / vol63)
# F4: Relative strength vs SPY
spy_mom = mom21["SPY"] if "SPY" in mom21.columns else pd.Series(0.0, index=mom21.index)
rs_spy  = mom21.subtract(spy_mom, axis=0)
# F5: RSI(2) cross-sectional contrarian (bajo = oversold = long)
rsi2_df = pd.DataFrame({t: all_ind[t]["rsi2"] for t in tickers_panel})
rsi2_cs = -rsi2_df
# F6: Anomalía de volumen [FIX-7: NaN en lugar de fillna(0)]
_vanom = {}
for t in tickers_panel:
    if t in volume_df.columns:
        vs = volume_df[t].reindex(closes.index)  # [FIX-7] sin fillna(0)
        vol_ma20 = vs.rolling(20).mean()
        vol_ratio = vs / vol_ma20.replace(0, np.nan)
        _vanom[t] = vol_ratio.fillna(1.0)  # NaN → neutral=1.0, no 0
    else:
        _vanom[t] = pd.Series(1.0, index=closes.index)
volanom_df = pd.DataFrame(_vanom)
# F7: Momentum 63d (factor adicional para más señal)
mom63 = np.expm1(log_ret.rolling(63).sum())
# F8: ADX cross-sectional (fuerza de tendencia)
adx_df = pd.DataFrame({t: all_ind[t]["adx"] for t in tickers_panel})

factor_list  = [mom21, rev5, volratio, rs_spy, rsi2_cs, volanom_df, mom63, adx_df]
factor_names = ["mom21", "rev5", "volratio", "rs_spy", "rsi2_cs", "volanom", "mom63", "adx"]

# ── 9. Alternative data sources (FRED + FINRA + EDGAR + Sentiment) ────────────
print("📡 Datos alternativos (FRED + FINRA + Insiders + Sentiment)...")
alt_data_dfs = []
alt_data_names = []

# 9a. FRED macro (same for all tickers per day, handled separately - NOT through cs_rank)
# We'll collect them and add to factor_stack AFTER the cross-sectional ranking
fred_stack_arrays = []
fred_stack_names = []
try:
    fred_result = fetch_fred_factors(closes.index)
    if fred_result is not None:
        for col in fred_result.columns:
            s = fred_result[col].fillna(0)
            mn, mx = s.min(), s.max()
            norm = (s - mn) / (mx - mn) * 100 if mx > mn else pd.Series(50.0, index=s.index)
            norm = norm.clip(0, 100)
            # Broadcast to all tickers: (n_days, n_tickers)
            broad_arr = np.tile(norm.values.reshape(-1, 1), (1, len(tickers_panel)))  # (n_days, N)
            fred_stack_arrays.append(broad_arr)
            fred_stack_names.append("fred_" + col)
        print(f"   ✅ FRED: {len(fred_result.columns)} factores macro")
    else:
        print("   ⚠️ FRED: no disponible")
except Exception as e:
    print(f"   ⚠️ FRED: error ({e})")

# 9b. FINRA short volume
try:
    finra_result = fetch_finra_factors(tickers_panel, closes.index)
    if finra_result is not None:
        finra_clean = finra_result.reindex(closes.index, method="ffill").bfill().fillna(0.5)
        alt_data_dfs.append(finra_clean)
        alt_data_names.append("short_volume")
        print(f"   ✅ FINRA: {len(finra_clean.columns)} tickers")
    else:
        print("   ⚠️ FINRA: no disponible")
except Exception as e:
    print(f"   ⚠️ FINRA: error ({e})")

# 9c. SEC EDGAR insider trading
try:
    insider_result = fetch_insider_factors(tickers_panel, closes.index)
    if insider_result is not None:
        inside_clean = insider_result.reindex(closes.index, method="ffill").fillna(0)
        alt_data_dfs.append(inside_clean)
        alt_data_names.append("insider_signal")
        print(f"   ✅ INSIDER: {len(inside_clean.columns)} tickers")
    else:
        print("   ⚠️ INSIDER: no disponible")
except Exception as e:
    print(f"   ⚠️ INSIDER: error ({e})")

# 9d. News sentiment (VADER + NewsAPI)
try:
    sent_result = fetch_sentiment_factors(tickers_panel, closes.index)
    if sent_result is not None:
        sent_clean = sent_result.reindex(closes.index, method="ffill").fillna(0)
        alt_data_dfs.append(sent_clean)
        alt_data_names.append("news_sentiment")
        print(f"   ✅ SENTIMENT: {len(sent_clean.columns)} tickers")
    else:
        print("   ⚠️ SENTIMENT: no disponible")
except Exception as e:
    print(f"   ⚠️ SENTIMENT: error ({e})")

# Merge alt per-ticker factors into factor_list and factor_names
# FRED macro handled separately via fred_stack_arrays (added after cs_rank)
factor_list.extend(alt_data_dfs)
factor_names.extend(alt_data_names)

def cs_rank(df: pd.DataFrame) -> pd.DataFrame:
    """Rankeo cross-seccional percentil 0-100 por fila (día)."""
    return df[tickers_panel].rank(axis=1, pct=True) * 100

ranked = [cs_rank(f.ffill()) for f in factor_list]

# ── 3. Target: excess return forward HORIZON días [FIX-4, FIX-5] ─────────────
# El target se calcula limpiamente y el TRAIN_END incluye buffer extra
fwd_log    = log_ret.shift(-HORIZON).rolling(HORIZON).sum()
fwd_ret    = np.expm1(fwd_log)
spy_fwd    = fwd_ret["SPY"] if "SPY" in fwd_ret.columns else pd.Series(0.0, index=fwd_ret.index)
fwd_excess = fwd_ret.subtract(spy_fwd, axis=0)
# [FIX-4] El cs_rank del target lo hacemos dentro de cada fold para evitar
# que el ranking futuro "vea" la distribución completa del periodo test
# No pre-calculamos fwd_ranked global — se hace por fold

n_days   = len(ret_df)
n_tick   = len(tickers_panel)
n_fact   = len(factor_names)
START_DAY = 70  # historia mínima para vol63 + buffer
# [FIX-5] Buffer adicional para evitar contaminación parcial
TRAIN_END = n_days - HORIZON - 5

base_stack  = np.stack([rf[tickers_panel].values for rf in ranked], axis=2)  # (n_days, N, n_base_factors)
# Concatenate FRED macro factors (not ranked cross-sectionally)
if fred_stack_arrays:
    fred_3d = np.stack(fred_stack_arrays, axis=2)  # (n_days, N, n_fred_factors)
    factor_stack = np.concatenate([base_stack, fred_3d], axis=2)
    all_factor_names = factor_names + fred_stack_names
else:
    factor_stack = base_stack
    all_factor_names = factor_names
fwd_ret_stack = fwd_excess[tickers_panel].values  # excess return raw (sin rankear global)

# ── 4. Walk-Forward con N_FOLDS folds [FIX-8] ────────────────────────────────
# Dividimos [START_DAY, TRAIN_END] en N_FOLDS bloques de tamaño igual
# Cada fold: train = todo lo anterior, test = siguiente bloque
fold_size = (TRAIN_END - START_DAY) // (N_FOLDS + 1)
fold_starts = [START_DAY + fold_size * (k + 1) for k in range(N_FOLDS)]
fold_ends   = [START_DAY + fold_size * (k + 2) for k in range(N_FOLDS)]
fold_ends[-1] = TRAIN_END  # último fold hasta el final disponible

all_ic_scores = []
all_ic_pvals  = []
fold_models   = []
fold_ic_means = []

print(f"   📊 Walk-Forward: {N_FOLDS} folds | factor_stack={factor_stack.shape} | "
      f"horizonte={HORIZON}d | LOOKBACK={LOOKBACK}d")

for fold_i, (fold_start, fold_end) in enumerate(zip(fold_starts, fold_ends)):
    train_range = range(START_DAY, fold_start)
    test_range  = range(fold_start, fold_end)

    # Rankear el target SÓLO dentro del periodo de entrenamiento [FIX-4]
    def make_dataset(day_range):
        """Construye X, y para un rango de días.
           El target se rankea cross-secccionalmente dentro del propio rango.
        """
        fwd_slice   = fwd_ret_stack[list(day_range)]  # (n_days_range, N)
        factor_slice = factor_stack[list(day_range)]   # (n_days_range, N, F)

        # [FIX-4] Rankear el target por fila (día) dentro del slice
        ranked_fwd = np.zeros_like(fwd_slice)
        for di in range(fwd_slice.shape[0]):
            row = fwd_slice[di]
            valid_mask = ~np.isnan(row)
            if valid_mask.sum() < 10:
                ranked_fwd[di] = np.nan
                continue
            temp = np.full_like(row, np.nan)
            vals = row[valid_mask]
            ranks = (np.argsort(np.argsort(vals)) + 1) / len(vals) * 100
            temp[valid_mask] = ranks
            ranked_fwd[di] = temp

        X_rows, y_rows = [], []
        for di in range(len(list(day_range))):
            x_day = factor_slice[di]   # (N, F)
            y_day = ranked_fwd[di]     # (N,)
            mask  = ~(np.isnan(x_day).any(axis=1) | np.isnan(y_day))
            if mask.sum() < 10:
                continue
            X_rows.append(x_day[mask])
            y_rows.append(y_day[mask])

        if not X_rows:
            return np.empty((0, n_fact)), np.empty(0)
        return np.vstack(X_rows), np.concatenate(y_rows)

    X_tr, y_tr = make_dataset(train_range)
    X_te, y_te = make_dataset(test_range)

    if len(X_tr) < 500 or len(X_te) < 50:
        print(f"   ⚠️ Fold {fold_i+1}: datos insuficientes (train={len(X_tr)}, test={len(X_te)}), saltando")
        continue

    if _USE_LGB:
        model = lgb.LGBMRegressor(
            n_estimators=300, max_depth=4, learning_rate=0.03,
            subsample=0.8, colsample_bytree=0.8,
            num_leaves=31, min_child_samples=30,
            reg_alpha=0.1, reg_lambda=0.1,
            random_state=42 + fold_i, verbose=-1)
    else:
        from sklearn.ensemble import GradientBoostingRegressor
        model = GradientBoostingRegressor(
            n_estimators=200, max_depth=3, learning_rate=0.03,
            subsample=0.8, min_samples_leaf=30, random_state=42 + fold_i)

    model.fit(X_tr, y_tr)
    fold_models.append(model)

    # IC por día dentro del fold OOS
    fold_ics = []
    for day_i in test_range:
        Xd = factor_stack[day_i]
        yd_raw = fwd_ret_stack[day_i]
        valid = ~(np.isnan(Xd).any(axis=1) | np.isnan(yd_raw))
        if valid.sum() < 20:
            continue
        # Rankear target dentro de este único día
        vals = yd_raw[valid]
        yd_ranked = (np.argsort(np.argsort(vals)) + 1) / len(vals) * 100
        ic, pval = spearmanr(model.predict(Xd[valid]), yd_ranked)
        if not np.isnan(ic):
            all_ic_scores.append(ic)
            all_ic_pvals.append(pval)
            fold_ics.append(ic)

    fold_ic_mean = float(np.mean(fold_ics)) if fold_ics else 0.0
    fold_ic_means.append(fold_ic_mean)
    print(f"   📐 Fold {fold_i+1}/{N_FOLDS}: train={len(X_tr):,} | test={len(X_te):,} | "
          f"IC={fold_ic_mean:.4f} ({len(fold_ics)} días OOS)")

# Métricas globales OOS
mean_ic   = float(np.mean(all_ic_scores))  if all_ic_scores else 0.0
std_ic    = float(np.std(all_ic_scores))   if all_ic_scores else 1.0
ir        = mean_ic / std_ic               if std_ic > 0 else 0.0
hit_rate  = float(np.mean([ic > 0 for ic in all_ic_scores])) if all_ic_scores else 0.5
ic_signif = float(np.mean([p < 0.05 for p in all_ic_pvals])) if all_ic_pvals else 0.0
MODEL_NAME = "LightGBM" if _USE_LGB else "GradientBoosting"

print(f"\n   📐 IC={mean_ic:.4f} | IR={ir:.2f} | Hit rate={hit_rate:.1%} | "
      f"IC sig={ic_signif:.1%} | {len(all_ic_scores)} días OOS totales")

# Feature importance: promedio sobre todos los folds
if fold_models:
    feat_imp_arr = np.mean([m.feature_importances_ for m in fold_models], axis=0)
    # factor_names already includes alt factors
    feat_imp = dict(zip(all_imp_names, feat_imp_arr))
else:
    feat_imp = {k: 0.0 for k in factor_names}
print("   🔍 " + " | ".join(f"{k}={v:.2f}" for k, v in sorted(feat_imp.items(), key=lambda x: -x[1])))

# ── 5. Scores hoy usando el modelo más reciente (último fold) ─────────────────
final_model = fold_models[-1] if fold_models else None
last_X      = factor_stack[-1]   # (n_tickers, n_facts)
n_skipped   = 0
raw_scores  = {}

if final_model is not None:
    preds = []
    valid_tickers = []
    for i, t in enumerate(tickers_panel):
        row = last_X[i]
        if np.isnan(row).any():
            n_skipped += 1
            continue
        preds.append(final_model.predict(row.reshape(1, -1))[0])
        valid_tickers.append(t)

    if preds:
        preds_arr = np.array(preds)
        # [FIX-6] Quintiles reales del universo — NO bins fijos de 20 puntos
        # Normalizar scores a 0-100 via ranking dentro del universo actual
        score_ranks = (np.argsort(np.argsort(preds_arr)) + 1) / len(preds_arr) * 100
        quintile_cuts = pd.qcut(score_ranks, 5, labels=[1, 2, 3, 4, 5])

        for j, t in enumerate(valid_tickers):
            sc  = float(np.clip(score_ranks[j], 0, 100))
            q   = int(quintile_cuts[j])

            # Confianza: calidad del modelo + extremidad del score
            if mean_ic < MIN_IC_FOR_SIGNAL:
                conf = "LOW"
            else:
                extremeness = abs(sc - 50)
                conf = "HIGH" if extremeness > 30 else "MED" if extremeness > 15 else "LOW"

            raw_scores[t] = {
                "score": round(sc, 1), "quintile": q,
                "ic": round(mean_ic, 4), "ir": round(ir, 2),
                "hit_rate": round(hit_rate, 3), "confidence": conf,
                "raw_pred": round(float(preds_arr[j]), 4)
            }

results = raw_scores
if n_skipped > 0:
    logger.warning(f"⚠️ {n_skipped} tickers saltados por NaN en features")

n_q5 = sum(1 for r in results.values() if r["quintile"] == 5)
n_q1 = sum(1 for r in results.values() if r["quintile"] == 1)
print(f"   ✅ {len(results)} scores | Q5 LONG: {n_q5} | Q1 SHORT/EVITAR: {n_q1}")

# ─── MÓDULO DE PORTFOLIO CONSTRUCTION Q5 [FIX-9] ─────────────────────────────
print("📦 Portfolio Construction Q5 (HRP simplificado)...")

q5_tickers = [t for t, r in results.items() if r["quintile"] == 5 and t in all_ind]

portfolio_metrics = {}
portfolio_weights = {}
portfolio_hhi     = 0.0

if len(q5_tickers) >= 2:
    # Retornos de Q5
    q5_ret = pd.DataFrame({t: all_ind[t]["returns"] for t in q5_tickers}).fillna(0)

    # Covarianza LW para Q5
    lw_q5      = LedoitWolf().fit(q5_ret.values)
    cov_q5     = pd.DataFrame(lw_q5.covariance_, index=q5_tickers, columns=q5_tickers)
    vol_q5     = np.sqrt(np.diag(cov_q5.values))
    inv_vol    = 1.0 / np.maximum(vol_q5, 1e-8)

    # HRP simplificado: pesos inverso-vol normalizados
    raw_w   = inv_vol / inv_vol.sum()
    # Cap máximo por ticker: 25%
    w_capped = np.minimum(raw_w, 0.25)
    w_final  = w_capped / w_capped.sum()

    portfolio_weights = {t: round(float(w), 4) for t, w in zip(q5_tickers, w_final)}

    # Métricas del portfolio Q5
    port_ret = q5_ret.values @ w_final
    port_vol_daily = float(np.sqrt(w_final @ cov_q5.values @ w_final))
    port_vol_ann   = port_vol_daily * np.sqrt(252)
    port_ret_ann   = float(np.mean(port_ret)) * 252
    port_sharpe    = port_ret_ann / port_vol_ann if port_vol_ann > 0 else 0.0
    port_var95     = float(np.percentile(port_ret, 5)) * 100
    port_var99     = float(np.percentile(port_ret, 1)) * 100
    port_cvar95    = float(np.mean(port_ret[port_ret <= np.percentile(port_ret, 5)])) * 100

    # Max Drawdown Q5
    cumret = np.cumprod(1 + port_ret)
    running_max = np.maximum.accumulate(cumret)
    drawdowns   = (cumret - running_max) / running_max
    max_dd      = float(np.min(drawdowns)) * 100

    # HHI concentración
    portfolio_hhi = float(np.sum(w_final ** 2))

    portfolio_metrics = {
        "vol_ann": round(port_vol_ann * 100, 2),
        "ret_ann": round(port_ret_ann * 100, 2),
        "sharpe": round(port_sharpe, 2),
        "var95": round(port_var95, 2),
        "var99": round(port_var99, 2),
        "cvar95": round(port_cvar95, 2),
        "max_dd": round(max_dd, 2),
        "hhi": round(portfolio_hhi, 4),
        "n_assets": len(q5_tickers)
    }
    print(f"   ✅ Q5 Portfolio: {len(q5_tickers)} activos | "
          f"Sharpe={port_sharpe:.2f} | VaR95={port_var95:.2f}% | MaxDD={max_dd:.1f}%")
else:
    print(f"   ⚠️ Solo {len(q5_tickers)} tickers Q5 — Portfolio construction omitida (mínimo 2)")

# ─── SEMÁFORO SPY ─────────────────────────────────────────────────────────────
sema = {}
if "SPY" in all_ind:
    ind  = all_ind["SPY"]
    h52  = pd.Series(ind["close"]).rolling(252, min_periods=20).max().values
    dd52 = (ind["close"][-1] / h52[-1] - 1) * 100 if h52[-1] > 0 else 0.0
    sema = {
        "rsi2":         round(float(ind["rsi2"][-1]),       1),
        "rsi14":        round(float(ind["rsi14"][-1]),      1),
        "macd_hist":    round(float(ind["macd_hist"][-1]),  4),
        "atr_pct":      round(float(ind["atr_pct"][-1]) * 100, 2),
        "trend_eff":    round(float(ind["trend_eff"][-1]),  1),
        "adx":          round(float(ind["adx"][-1]),        1),
        "return_today": round(float(ind["returns"][-1]) * 100, 2),
        "close":        round(float(ind["close"][-1]),      2),
        "ma50":         round(float(ind["ma50"][-1]),       2) if not np.isnan(ind["ma50"][-1]) else 0,
        "ma200":        round(float(ind["ma200"][-1]),      2) if not np.isnan(ind["ma200"][-1]) else 0,
        "dd52":         round(dd52,                         1),
        "var95":        round(float(np.percentile(ind["returns"][1:], 5)) * 100, 2),
        "var99":        round(float(np.percentile(ind["returns"][1:], 1)) * 100, 2),
    }

# ─── GENERACIÓN DE DASHBOARD HTML ────────────────────────────────────────────
def semaforo_color(v, lo, md, hi, rev=False):
    if rev:
        return "#00e07a" if v <= lo else "#f0a500" if v <= md else "#ff4060"
    return "#00e07a" if v >= hi else "#f0a500" if v >= md else "#ff4060"

print("🎨 Generando dashboard HTML...")
dt  = datetime.now().strftime("%d/%m/%Y %H:%M")
tk  = list(corr_hm.columns)

html = f"""<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>OLYMPUS HEATMAP REGRESSION v3.0</title><style>
:root{{
  --bg:#080c12;--surface:#0d1420;--card:#111927;--border:#1e2d40;
  --text:#c8d8e8;--muted:#5a7a96;--accent:#00c2ff;--gold:#f0a500;
  --green:#00e07a;--red:#ff4060;--mono:Consolas,monospace;--sans:'Segoe UI',sans-serif;
}}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:var(--bg);color:var(--text);font-family:var(--sans);padding:32px}}
.header{{text-align:center;margin-bottom:40px}}
.header h1{{font-family:var(--mono);font-size:28px;color:#fff}}
.header h1 span{{color:var(--accent)}}
.sub{{color:var(--muted);font-size:13px;margin-top:4px}}
.version-badge{{display:inline-block;background:rgba(0,194,255,0.15);color:var(--accent);
  font-family:var(--mono);font-size:10px;padding:2px 8px;border-radius:4px;margin-left:8px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:1400px;margin:0 auto}}
.card{{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:20px 24px}}
.card.full{{grid-column:1/-1}}
.card-title{{font-family:var(--mono);font-size:11px;color:var(--accent);
  letter-spacing:3px;text-transform:uppercase;margin-bottom:16px}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th{{font-family:var(--mono);font-size:10px;color:var(--muted);
  padding:6px 8px;border-bottom:1px solid var(--border);text-align:left}}
td{{padding:6px 8px;border-bottom:1px solid var(--border)}}
tr:last-child td{{border-bottom:none}}
.ht td,.ht th{{padding:4px 5px;text-align:center;min-width:44px;font-size:10px}}
.pill{{display:inline-block;padding:3px 12px;border-radius:12px;
  font-family:var(--mono);font-size:11px;font-weight:700;margin:2px 4px}}
.bar{{width:100%;height:6px;background:var(--surface);border-radius:3px;margin-top:4px}}
.bar-f{{height:100%;border-radius:3px}}
.g{{color:var(--green)}}.r{{color:var(--red)}}.y{{color:var(--gold)}}
.footer{{text-align:center;margin-top:32px;color:var(--muted);font-size:11px;font-family:var(--mono)}}
.badge{{display:inline-block;padding:2px 10px;border-radius:4px;font-size:10px;font-weight:700}}
.badge-good{{background:rgba(0,224,122,0.2);color:var(--green)}}
.badge-warn{{background:rgba(240,165,0,0.2);color:var(--gold)}}
.badge-low{{background:rgba(255,64,96,0.15);color:var(--red)}}
.fix-tag{{font-size:9px;background:rgba(0,194,255,0.1);color:var(--accent);
  padding:1px 5px;border-radius:3px;margin-left:4px;font-family:var(--mono)}}
</style></head><body>
<div class="header">
  <h1>OLYMPUS <span>HEATMAP REGRESSION</span><span class="version-badge">v3.0</span></h1>
  <div class="sub">// {len(available)} activos · {LOOKBACK}d histórico · {dt} · Walk-Forward {N_FOLDS} folds</div>
  <div class="sub" style="margin-top:6px;color:#3a5a76;font-size:11px">
    ✔ RSI Wilder · ✔ ADX Wilder · ✔ Target sin leak · ✔ Quintiles reales · ✔ Portfolio Q5 HRP
  </div>
</div>
<div class="grid">
"""

# ── Heatmap de correlaciones (LW) ─────────────────────────────────────────────
html += f"""<div class="card full"><div class="card-title">
  🔥 Matriz de Correlaciones Ledoit-Wolf — {len(heatmap_display)} activos
  <span class="fix-tag">FIX-10: LW unificado</span>
</div>
<div style="overflow-x:auto;max-width:100%;"><table class="ht">
"""
rows = '<tr><th></th>' + ''.join(f'<th>{t}</th>' for t in tk) + '</tr>'
for t1 in tk:
    rows += f'<tr><th><strong>{t1}</strong></th>'
    for t2 in tk:
        v  = float(corr_hm.loc[t1, t2]) if (t1 in corr_hm.index and t2 in corr_hm.columns) else 0.0
        if v >= 0:
            rr, gg, bb = 220, int(60 + (1 - v) * 160), int(60 + (1 - v) * 160)
        else:
            rr, gg, bb = int(60 + (1 + v) * 160), int(60 + (1 + v) * 160), 220
        bg = f"rgb({rr},{gg},{bb})"
        tc = "#fff" if abs(v) > 0.5 else "#111"
        rows += f'<td style="background:{bg};color:{tc};text-align:center;font-weight:700;">{v:.2f}</td>'
    rows += '</tr>'
html += rows
html += f"""</table></div>
<div style="margin-top:12px;display:flex;gap:16px;font-size:11px;color:var(--muted);align-items:center">
<span>🔵 -1.0</span>
<div style="width:200px;height:10px;border-radius:5px;background:linear-gradient(to right,#4488ff,#ccc,#ff4444)"></div>
<span>🔴 +1.0</span>
<span style="margin-left:16px">Shrinkage: Ledoit-Wolf | Sin bias Pearson</span>
</div></div>
"""

# ── Motor cross-sectional scores ──────────────────────────────────────────────
html += f"""<div class="card full"><div class="card-title">
  📈 Motor Cross-Sectional ({MODEL_NAME}) — {len(results)} tickers · Score 0-100 · Horizonte {HORIZON}d
  · IC={mean_ic:.4f} · IR={ir:.2f}
  <span class="fix-tag">FIX-4: sin leak</span><span class="fix-tag">FIX-6: quintiles reales</span>
</div>
<div style="max-height:500px;overflow-y:auto;">
<table><tr><th>Ticker</th><th>Score (Rank %)</th><th>Quintil</th><th>Señal</th><th>Confianza</th></tr>
"""
for t in sorted(results.keys()):
    r    = results[t]
    sc   = r["score"]
    q    = r["quintile"]
    qc   = {"1":"#ff4060","2":"#ff8080","3":"#f0a500","4":"#7de77d","5":"#00e07a"}.get(str(q), "#fff")
    sig  = {"1":"🔴 SHORT","2":"📉 EVITAR","3":"⚪ NEUTRAL","4":"📈 WATCH","5":"🟢 LONG"}.get(str(q), "—")
    badge = "badge-good" if r["confidence"] == "HIGH" else "badge-warn" if r["confidence"] == "MED" else "badge-low"
    html += (f'<tr><td><strong>{t}</strong></td>'
             f'<td><div style="display:flex;align-items:center;gap:8px">'
             f'<span style="color:{qc};font-weight:700;font-family:var(--mono);min-width:40px">{sc:.1f}</span>'
             f'<div style="width:70px;height:5px;background:var(--surface);border-radius:2px">'
             f'<div style="width:{int(sc)}%;height:100%;background:{qc};border-radius:2px"></div></div></div></td>'
             f'<td style="color:{qc};font-weight:700;font-family:var(--mono)">Q{q}</td>'
             f'<td>{sig}</td>'
             f'<td><span class="badge {badge}">{r["confidence"]}</span></td></tr>\n')
html += f"""</table></div>
<div style="margin-top:12px;font-size:11px;color:var(--muted)">
  {MODEL_NAME} cross-sectional | Score = percentil vs universo (Q5=top 20%) |
  Target: excess return {HORIZON}d vs SPY | Walk-Forward {N_FOLDS} folds
</div></div>
"""

# ── Métricas del modelo ────────────────────────────────────────────────────────
_ic_c  = "#00e07a" if mean_ic > 0.04 else "#f0a500" if mean_ic > 0.02 else "#ff4060"
_ir_c  = "#00e07a" if ir > 0.5       else "#f0a500" if ir > 0.2       else "#ff4060"
_hr_c  = "#00e07a" if hit_rate > 0.55 else "#f0a500" if hit_rate > 0.50 else "#ff4060"
_sig_c = "#00e07a" if ic_signif > 0.10 else "#f0a500" if ic_signif > 0.05 else "#ff4060"

html += f"""<div class="card full"><div class="card-title">
  📐 Métricas del Modelo — {MODEL_NAME} · {len(all_ic_scores)} días OOS · {N_FOLDS} folds Walk-Forward
  <span class="fix-tag">FIX-8: WF real</span>
</div>
<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-bottom:20px">
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">IC MEDIO</div>
    <div style="font-size:26px;font-weight:700;color:{_ic_c};font-family:var(--mono)">{mean_ic:.4f}</div>
    <div style="font-size:10px;color:var(--muted)">{"✅ señal útil" if mean_ic>0.02 else "⚠️ señal débil"}</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">IR (IC Sharpe)</div>
    <div style="font-size:26px;font-weight:700;color:{_ir_c};font-family:var(--mono)">{ir:.2f}</div>
    <div style="font-size:10px;color:var(--muted)">{"✅ >0.5 objetivo HF" if ir>0.5 else "⚠️ bajo objetivo"}</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">HIT RATE</div>
    <div style="font-size:26px;font-weight:700;color:{_hr_c};font-family:var(--mono)">{hit_rate:.1%}</div>
    <div style="font-size:10px;color:var(--muted)">días IC positivo</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">IC SIGNIF.</div>
    <div style="font-size:26px;font-weight:700;color:{_sig_c};font-family:var(--mono)">{ic_signif:.1%}</div>
    <div style="font-size:10px;color:var(--muted)">p-valor &lt; 0.05</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">UNIVERSO</div>
    <div style="font-size:26px;font-weight:700;color:var(--accent);font-family:var(--mono)">{len(results)}</div>
    <div style="font-size:10px;color:var(--muted)">{n_q5} LONG · {n_q1} SHORT</div>
  </div>
</div>
"""

# IC por fold
if fold_ic_means:
    html += '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">📊 IC por fold Walk-Forward:</div>'
    html += '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">'
    for fi, fic in enumerate(fold_ic_means):
        fc = "#00e07a" if fic > 0.03 else "#f0a500" if fic > 0.01 else "#ff4060"
        html += f'<div style="text-align:center;padding:8px 16px;background:var(--surface);border-radius:6px">'
        html += f'<div style="font-size:10px;color:var(--muted)">Fold {fi+1}</div>'
        html += f'<div style="font-size:18px;font-weight:700;color:{fc};font-family:var(--mono)">{fic:.4f}</div>'
        html += f'</div>'
    html += '</div>'

html += '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">🔍 Factor importance (promedio folds):</div>'
html += '<div style="display:flex;gap:8px;flex-wrap:wrap">'
for fn, fv in sorted(feat_imp.items(), key=lambda x: -x[1]):
    fi_c = "#00e07a" if fv > 0.20 else "#f0a500" if fv > 0.10 else "var(--muted)"
    html += f'<div class="pill" style="background:rgba(0,194,255,0.1);color:{fi_c}">{fn}: {fv:.2f}</div>'
html += '</div></div>'

# ── Portfolio Q5 HRP [FIX-9] ──────────────────────────────────────────────────
html += f"""<div class="card"><div class="card-title">
  📦 Portfolio Q5 — HRP Inverso-Vol
  <span class="fix-tag">FIX-9: nuevo</span>
</div>
"""
if portfolio_metrics:
    pm = portfolio_metrics
    sh_c  = "#00e07a" if pm["sharpe"] > 0.8 else "#f0a500" if pm["sharpe"] > 0.4 else "#ff4060"
    dd_c  = "#ff4060" if pm["max_dd"] < -20 else "#f0a500" if pm["max_dd"] < -10 else "#00e07a"
    hhi_c = "#ff4060" if pm["hhi"] > 0.25 else "#f0a500" if pm["hhi"] > 0.15 else "#00e07a"
    html += f"""
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">SHARPE (hist.)</div>
        <div style="font-size:22px;font-weight:700;color:{sh_c};font-family:var(--mono)">{pm["sharpe"]:.2f}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">VaR 95% diario</div>
        <div style="font-size:22px;font-weight:700;color:#ff4060;font-family:var(--mono)">{pm["var95"]:.2f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">CVaR 95%</div>
        <div style="font-size:22px;font-weight:700;color:#ff4060;font-family:var(--mono)">{pm["cvar95"]:.2f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">Max Drawdown</div>
        <div style="font-size:22px;font-weight:700;color:{dd_c};font-family:var(--mono)">{pm["max_dd"]:.1f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">Vol Anual</div>
        <div style="font-size:22px;font-weight:700;color:var(--gold);font-family:var(--mono)">{pm["vol_ann"]:.1f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">HHI Concentración</div>
        <div style="font-size:22px;font-weight:700;color:{hhi_c};font-family:var(--mono)">{pm["hhi"]:.3f}</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Pesos HRP (inverso-vol, cap 25%):</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
    """
    for t, w in sorted(portfolio_weights.items(), key=lambda x: -x[1]):
        wc = "#00e07a" if w > 0.15 else "#f0a500" if w > 0.08 else "var(--muted)"
        html += f'<div class="pill" style="background:rgba(0,224,122,0.1);color:{wc}">{t}: {w*100:.1f}%</div>'
    html += '</div>'
    if pm["hhi"] > 0.25:
        html += '<div style="margin-top:10px;font-size:11px;color:#ff4060">⚠️ Concentración alta (HHI > 0.25) — considera ampliar universo Q5</div>'
else:
    html += '<div style="color:var(--muted);font-size:13px">Insuficientes activos Q5 para portfolio construction.</div>'
html += '</div>'

# ── Semáforo SPY ──────────────────────────────────────────────────────────────
html += """<div class="card"><div class="card-title">🚦 Semáforo SPY — Indicadores corregidos
  <span class="fix-tag">FIX-1 FIX-2</span>
</div>
"""
if sema:
    inds = [
        ("RSI(2) Wilder",   sema["rsi2"],       15,  60,  85),
        ("RSI(14) Wilder",  sema["rsi14"],       35,  50,  70),
        ("MACD Hist",       sema["macd_hist"],  -0.1, 0,  0.3),
        ("ATR % (Wilder)",  sema["atr_pct"],     0.5, 2,   4),
        ("Trend Eff (vec)", sema["trend_eff"],   20,  40,  60),
        ("ADX Wilder",      sema["adx"],         15,  25,  35),
    ]
    for nm, vl, lo, md, hi in inds:
        co  = semaforo_color(vl, lo, md, hi, rev=(nm.startswith("ATR")))
        pct = min(100, max(0, (vl - lo) / (hi - lo) * 100)) if hi != lo else 50
        html += (f'<div style="margin-bottom:10px">'
                 f'<div style="display:flex;justify-content:space-between;font-size:12px">'
                 f'<span>{nm}</span><span style="color:{co};font-weight:700">{vl}</span></div>'
                 f'<div class="bar"><div class="bar-f" style="width:{pct}%;background:{co};"></div></div></div>')
    sc  = "r" if sema["dd52"] < -10 else "y" if sema["dd52"] < -5 else "g"
    rc2 = "g" if sema["return_today"] > 0 else "r"
    html += (f'<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);font-size:12px">'
             f'<div>📌 SPY = <strong>${sema["close"]}</strong> | MA50: ${sema["ma50"]} | MA200: ${sema["ma200"]}</div>'
             f'<div>📉 Drawdown 52w: <strong class="{sc}">{sema["dd52"]:+.1f}%</strong></div>'
             f'<div>⚠️ VaR 95%: <strong class="r">{sema["var95"]:+.2f}%</strong> | '
             f'VaR 99%: <strong class="r">{sema["var99"]:+.2f}%</strong></div>'
             f'<div>📊 Retorno hoy: <strong class="{rc2}">{sema["return_today"]:+.2f}%</strong></div></div>')
html += '</div>'

# ── Top predicciones ──────────────────────────────────────────────────────────
sp_sorted = sorted(results.items(), key=lambda x: x[1]["score"], reverse=True)
html += """<div class="card"><div class="card-title">🎯 Top Predicciones</div>"""
html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">🟢 Q5 — LONG (top 20% universo):</div>'
for t, r in [(t, r) for t, r in sp_sorted if r["quintile"] == 5][:8]:
    w_pct = portfolio_weights.get(t, 0.0) * 100
    w_str = f" | peso HRP: {w_pct:.1f}%" if w_pct > 0 else ""
    html += f'<div class="pill" style="background:rgba(0,224,122,0.15);color:#00e07a">{t}: {r["score"]:.1f}{w_str}</div>'
html += '<div style="font-size:12px;color:var(--muted);margin:16px 0 8px">🔴 Q1 — SHORT/EVITAR:</div>'
for t, r in [(t, r) for t, r in reversed(sp_sorted) if r["quintile"] == 1][:5]:
    html += f'<div class="pill" style="background:rgba(255,64,96,0.15);color:#ff4060">{t}: {r["score"]:.1f}</div>'
html += '</div>'

# ── Correlaciones fuertes vs SPY ──────────────────────────────────────────────
html += """<div class="card full"><div class="card-title">📈 Correlaciones vs SPY — Ledoit-Wolf</div>"""
if "SPY" in corr_lw.columns:
    spy_c = corr_lw["SPY"].drop("SPY", errors="ignore").sort_values(ascending=False)
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap">'
    for t in spy_c.head(15).index:
        cv = spy_c[t]
        cc = "#ff4060" if cv > 0.8 else "#f0a500" if cv > 0.6 else "var(--muted)"
        html += f'<div class="pill" style="background:rgba(255,64,96,0.08);color:{cc}">{t}: {cv:.2f}</div>'
    html += '</div>'
html += '</div>'

html += f"""</div>
<div class="footer">
  Olympus Heatmap Regression v3.0 · Hende Fund · {dt} · {len(available)} tickers · {LOOKBACK}d · {MODEL_NAME}<br>
  <code style="color:#fff">python OLYMPUS_HEATMAP_REGRESSION_v3.py</code>
  <span style="color:var(--accent)">para actualizar</span> ·
  Fixes: RSI/ADX Wilder · Target sin leak · WF {N_FOLDS} folds · Quintiles reales · Portfolio HRP · LW unificado
</div>
</body></html>"""

# ─── OUTPUTS ──────────────────────────────────────────────────────────────────
base_dir = os.path.dirname(os.path.abspath(__file__))

out_html = os.path.join(base_dir, "heatmap_dashboard.html")
with open(out_html, "w", encoding="utf-8") as f:
    f.write(html)
logger.info(f"Dashboard: {out_html}")

# predictions.csv
df_pred = pd.DataFrame(results).T
if not df_pred.empty:
    df_pred = df_pred.sort_values("score", ascending=False)
    csv_pred = os.path.join(base_dir, "predictions.csv")
    df_pred.to_csv(csv_pred)
    logger.info(f"Scores: {csv_pred}")

# correlations.csv — Ledoit-Wolf
csv_corr = os.path.join(base_dir, "correlations.csv")
corr_lw.to_csv(csv_corr)
logger.info(f"Correlaciones LW: {csv_corr}")

# portfolio_q5.csv — pesos HRP
if portfolio_weights:
    df_port = pd.DataFrame([
        {"ticker": t, "weight_pct": round(w * 100, 2), **results.get(t, {})}
        for t, w in sorted(portfolio_weights.items(), key=lambda x: -x[1])
    ])
    csv_port = os.path.join(base_dir, "portfolio_q5.csv")
    df_port.to_csv(csv_port, index=False)
    logger.info(f"Portfolio Q5: {csv_port}")

try:
    webbrowser.open(f"file://{os.path.abspath(out_html)}")
    print("🚀 Abriendo dashboard en el navegador...")
except Exception:
    print(f"📂 Abre: {out_html}")

print("\n" + "=" * 65)
print("📊 RESUMEN OLYMPUS HEATMAP REGRESSION v3.0 — Hende Fund")
print("=" * 65)
print(f"📡 Activos: {len(available)} | 🔥 Heatmap: {len(heatmap_display)} | 📅 Días: {LOOKBACK}")
print(f"🤖 Modelo: {MODEL_NAME} · Walk-Forward {N_FOLDS} folds · Horizonte {HORIZON}d")
print(f"📐 IC={mean_ic:.4f} | IR={ir:.2f} | Hit rate={hit_rate:.1%} | IC sig={ic_signif:.1%}")
print(f"   IC por fold: {' | '.join([f'F{i+1}={v:.4f}' for i, v in enumerate(fold_ic_means)])}")
if portfolio_metrics:
    pm = portfolio_metrics
    print(f"\n📦 Portfolio Q5 ({pm['n_assets']} activos):")
    print(f"   Sharpe={pm['sharpe']:.2f} | Vol={pm['vol_ann']:.1f}% | MaxDD={pm['max_dd']:.1f}%")
    print(f"   VaR95={pm['var95']:.2f}% | CVaR95={pm['cvar95']:.2f}% | HHI={pm['hhi']:.3f}")
    print(f"\n🟢 Q5 LONG — pesos HRP:")
    for t, w in sorted(portfolio_weights.items(), key=lambda x: -x[1])[:8]:
        print(f"   {t:8s}  {w*100:.1f}%  (score={results[t]['score']:.1f})")
print(f"\n🔴 Q1 SHORT/EVITAR:")
for t, r in [(t, r) for t, r in reversed(sp_sorted) if r["quintile"] == 1][:5]:
    print(f"   {t:8s}  score={r['score']:.1f}")
print(f"\n📈 Correlaciones más fuertes vs SPY (Ledoit-Wolf):")
if "SPY" in corr_lw.columns:
    spy_c = corr_lw["SPY"].drop("SPY", errors="ignore").sort_values(ascending=False)
    for t in spy_c.head(5).index:
        print(f"   {t:8s} <-> SPY = {spy_c[t]:.2f}")
print(f"\n📁 Dashboard: {os.path.abspath(out_html)}")
print(f"\n✅ CORRECCIONES APLICADAS EN v3.0:")
print("   [FIX-1]  RSI con EMA Wilder (alpha=1/p) — estándar industria")
print("   [FIX-2]  ADX con EMA Wilder — elimina sobresuavizado")
print("   [FIX-3]  Trend Efficiency vectorizado — sin loop O(n²)")
print("   [FIX-4]  Target rankeado por fold — sin forward-looking leak")
print("   [FIX-5]  TRAIN_END con buffer +5 días extra")
print("   [FIX-6]  Quintiles reales del universo (qcut) — no bins fijos")
print("   [FIX-7]  Volumen missing → NaN, no 0 — sin picos espurios")
print("   [FIX-8]  Walk-Forward real: 3 folds expandibles")
print("   [FIX-9]  Portfolio Q5: HRP inv-vol, Sharpe, VaR, CVaR, MaxDD, HHI")
print("   [FIX-10] Correlación LW unificada — dashboard y CSV consistentes")
print("   [FIX-11] LOOKBACK=504d (2 años) — OOS estadísticamente robusto")
print("   [FIX-12] Descarga en chunks con retry — sin timeout silencioso")
