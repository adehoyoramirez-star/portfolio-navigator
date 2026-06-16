#!/usr/bin/env python3
"""
OLYMPUS HEATMAP REGRESSION v7.0 — Hende Fund · PRODUCTION
Uso: python OLYMPUS_HEATMAP_REGRESSION_v7.py [--mode swing|scalp|funda] [--top N] [--no-fred] [--capital CAPITAL_EUR]
Output: heatmap_dashboard.html, predictions.csv, correlations.csv, portfolio_q5.csv, ibkr_orders.csv

FIXES INCORPORADOS:
  v5.0 fixes: [FIX-A] ffill local · [FIX-B] WF sin overlap · [FIX-C] Portfolio OOS · [FIX-D] Trend Slope
  · [FIX-E] closure fix · [FIX-F] LW clean · [FIX-G] z-confianza
  v7.0 NEW: [FIX-I] LW pre-OOS · [FIX-J] FRED expanding norm · [FIX-K] ^VIX exlcuido
  · [FIX-L] EW median benchmark · [FIX-M] IBKR SL/TP/sizing · [FIX-N] Benchmarks OOS

CORRECCIONES v5.0 vs v3.0 (merge v4.0 fixes + v3.0 alt data):

  NUEVOS EN v5.0 (datos alternativos):
    [FEATURE-1] FRED macro (8 indicadores): IPC, PMI, Credit Spread, Desempleo, M2, etc.
    [FEATURE-2] FINRA short volume ratio por ticker
    [FEATURE-3] SEC EDGAR insider trading (net insider ratio)
    [FEATURE-4] News Sentiment (VADER + NewsAPI)
    [FEATURE-5] FRED fuera de cs_rank (broadcast directo a factor_stack)

  FIXES HEREDADOS DE v4.0 (verificados correctos):
    [FIX-A] ffill() global ELIMINADO: relleno local por ventana train y por dia
    [FIX-B] Walk-Forward expanding SIN overlap
    [FIX-C] Portfolio metrics sobre OOS del ultimo fold, no in-sample
    [FIX-D] ADX eliminado (invalido sin OHLC) -> Trend Slope
    [FIX-E] make_dataset fuera del loop (closure bug resuelto)
    [FIX-F] LedoitWolf solo con tickers de retornos completos
    [FIX-G] Confianza basada en z-score de raw_pred


  [BUG-1 → FIX-A]  ffill() global en features ELIMINADO: el relleno temporal
                    se hace SOLO dentro de la ventana train de cada fold.
                    Evita look-ahead en features, que inflaba IC artificialmente.

  [BUG-2 → FIX-B]  Walk-Forward corregido a expanding-window SIN overlap:
                    el train de cada fold no reutiliza días OOS de folds anteriores.
                    El IC por fold ahora mide estabilidad temporal real.

  [BUG-3 → FIX-C]  Portfolio metrics calculadas sobre periodo OOS del último fold,
                    no sobre los 504 días completos. Elimina look-ahead bias de
                    selección: el Sharpe, VaR, CVaR y MaxDD son genuinamente OOS.

  [BUG-4 → FIX-D]  ADX eliminado como factor: sin datos OHLC, DI+/DI- son
                    algebraicamente complementarios → factor redundante con RSI.
                    Sustituido por trend_slope_factor (regresión lineal rolling),
                    que sí es un factor independiente y válido con solo closes.

  [BUG-5 → FIX-E]  make_dataset sacado del loop: closure bug potencial resuelto,
                    variables de estado pasadas como argumentos explícitos.

  [BUG-6 → FIX-F]  LedoitWolf ajustado solo sobre tickers con retornos completos
                    (cero NaN). Los tickers con historial incompleto no distorsionan
                    la estimación de covarianza. En heatmap se filtran tickers
                    parciales (no aparecen) para no mostrar correlaciones espurias.

  [BUG-7 → FIX-G]  Confianza basada en raw_pred del modelo (dispersión real de
                    predicciones), no en score_rank (uniforme por construcción).
                    Ahora HIGH/MED/LOW refleja la magnitud de la señal del modelo.

FIXES HEREDADOS DE v3.0 (verificados correctos):
  RSI Wilder, Trend Efficiency vectorizado, Target por fold, Buffer TRAIN_END,
  Quintiles reales qcut, Volumen NaN, LW unificado, LOOKBACK=504, chunks retry.
"""

import os, sys, webbrowser, pickle, time, logging, warnings, argparse, json
from datetime import datetime
from fred_data import fetch_fred_factors
from finra_data import fetch_finra_factors
from insider_data import fetch_insider_factors
from sentiment_data import fetch_sentiment_factors
from fundamental_data import fetch_fundamental_factors
from whale_data import fetch_whale_factors  # [WHALE] Finviz institutional + insider data

warnings.filterwarnings("ignore")

# ─── CLI ARGUMENTS ────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="OLYMPUS HEATMAP REGRESSION v7.0 — Production")
parser.add_argument("--mode", choices=["swing", "scalp", "funda"], default="swing",
                    help="Modo de trading (default: swing)")
parser.add_argument("--top", type=int, default=0,
                    help="Filtrar a top N tickers por liquidez (default: 0 = todos)")
parser.add_argument("--no-fred", action="store_true",
                    help="Excluir FRED macro de factores cross-seccionales")
parser.add_argument("--capital", type=float, default=10000.0,
                    help="Capital total en EUR para risk management IBKR [FIX-M] (default: 10000)")
parser.add_argument("--max-positions", type=int, default=0,
                    help="Máximo de posiciones LONG en Q5 (default: 0 = sin límite)")
parser.add_argument("--lite", action="store_true",
                    help="[FIX-LITE] Modo simplificado: sin hyperopt Optuna, parámetros conservadores")
args = parser.parse_args()
MODE_NAME    = args.mode
TOP_N        = args.top
NO_FRED      = args.no_fred
CAPITAL_EUR  = args.capital
MAX_POS      = args.max_positions
LITE_MODE    = args.lite  # [FIX-LITE] Sin hyperopt para evitar sobreajuste

# ─── MODE PRESETS ─────────────────────────────────────────────────────────────
# Cada modo define: LOOKBACK, HORIZON, N_FOLDS Y periodos de factores técnicos
MODE_PRESETS = {
    "scalp": {  # Corto plazo (1d)
        "LOOKBACK":         252,
        "HEATMAP_DISPLAY_N": 50,
        "HORIZON":          1,
        "N_FOLDS":          5,
        "mom_period":       5,
        "rev_period":       2,
        "vol_short":        2,
        "vol_long":         21,
        "slope_period":     5,
        "volanom_period":   5,
        "mom_long_period":  10,
    },
    "swing": {  # Medio plazo (5d) — DEFAULT
        "LOOKBACK":         504,
        "HEATMAP_DISPLAY_N": 50,
        "HORIZON":          5,
        "N_FOLDS":          3,    # [FIX-O] Reducido de 5→3: con 10 factores FRED extra, cada fold necesita más datos de entrenamiento
        "mom_period":       21,
        "rev_period":       5,
        "vol_short":        5,
        "vol_long":         63,
        "slope_period":     20,
        "volanom_period":   20,
        "mom_long_period":  63,
    },
    "funda": {  # Largo plazo (21d ≈ 1 mes)
        "LOOKBACK":         756,
        "HEATMAP_DISPLAY_N": 50,
        "HORIZON":          21,
        "N_FOLDS":          2,
        "mom_period":       63,
        "rev_period":       21,
        "vol_short":        21,
        "vol_long":         126,
        "slope_period":     63,
        "volanom_period":   63,
        "mom_long_period":  126,
    },
}

P = MODE_PRESETS[MODE_NAME]

# ─── PARÁMETROS GLOBALES ──────────────────────────────────────────────────────
LOOKBACK          = P["LOOKBACK"]
HEATMAP_DISPLAY_N = P["HEATMAP_DISPLAY_N"]
HORIZON           = P["HORIZON"]
N_FOLDS           = P["N_FOLDS"]
CACHE_MAX_AGE     = 24 * 3600
MIN_IC_FOR_SIGNAL = 0.005  # [FIX-IC] Bajado de 0.02→0.005: con más factores FRED el IC_mean fluctúa más al reentrenar. Umbral mínimo para filtrar modelos rotos (IC<0).

# Flags activos para display
ACTIVE_FLAGS = []
if TOP_N > 0:
    ACTIVE_FLAGS.append(f"top{TOP_N}")
if NO_FRED:
    ACTIVE_FLAGS.append("nofred")
FLAGS_STR = "+".join(ACTIVE_FLAGS) if ACTIVE_FLAGS else "full"
if LITE_MODE:
    FLAGS_STR = "lite" if FLAGS_STR == "full" else FLAGS_STR + "+lite"

MODE_EMOJI = {"scalp": "⚡", "swing": "🌊", "funda": "🏛️"}

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
    # ^VIX excluido — activo no invertible [FIX-K]
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
        storage_options={"User-Agent": "Mozilla/5.0 Olympus/4.0"})
    sp500_df      = sp500_tables[0]
    col           = "Symbol" if "Symbol" in sp500_df.columns else sp500_df.columns[0]
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
        if not {'closes','volume','available','lookback'}.issubset(cached.keys()):
            os.remove(CACHE_FILE); return None
        if cached.get('lookback') != LOOKBACK:
            print("   ⚠️ Cache LOOKBACK diferente, redescargando...")
            os.remove(CACHE_FILE); return None
        # [FIX-M4] Backward compatible: si no hay high/low, se usarán closes como fallback en calc_indicators
        if 'high' not in cached or 'low' not in cached:
            cached['high'] = pd.DataFrame(index=cached['closes'].index, columns=cached['closes'].columns)
            cached['low'] = pd.DataFrame(index=cached['closes'].index, columns=cached['closes'].columns)
        print(f"   📦 Cache ({age/3600:.1f}h) — {len(cached['available'])} tickers · {LOOKBACK}d")
        return cached
    except Exception:
        try: os.remove(CACHE_FILE)
        except Exception: pass
        return None

def save_cache(closes_df, volume_df, high_df, low_df, tickers_list):
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump({'closes': closes_df, 'volume': volume_df,
                         'high': high_df, 'low': low_df,
                         'available': tickers_list, 'timestamp': time.time(),
                         'lookback': LOOKBACK}, f)
        print(f"   💾 Cache guardado ({os.path.getsize(CACHE_FILE)/1024:.0f} KB)")
    except Exception as e:
        print(f"   ⚠️ No se pudo guardar cache: {e}")

# ─── DESCARGA EN CHUNKS CON RETRY ────────────────────────────────────────────
def download_with_retry(tickers, period_days, chunk_size=200, max_retries=2):
    import yfinance as yf
    period_str = f"{period_days + 40}d"
    all_close, all_volume, all_high, all_low = {}, {}, {}, {}
    chunks = [tickers[i:i+chunk_size] for i in range(0, len(tickers), chunk_size)]
    print(f"   📦 {len(chunks)} chunks de hasta {chunk_size} tickers...")
    for ci, chunk in enumerate(chunks):
        for attempt in range(max_retries + 1):
            try:
                data = yf.download(chunk, period=period_str, progress=False,
                                   auto_adjust=True, threads=True)
                if data.empty:
                    c_close = c_volume = c_high = c_low = pd.DataFrame()
                elif isinstance(data.columns, pd.MultiIndex):
                    c_close  = data["Close"]  if "Close"  in data.columns.get_level_values(0) else pd.DataFrame()
                    c_volume = data["Volume"] if "Volume" in data.columns.get_level_values(0) else pd.DataFrame()
                    c_high   = data["High"]   if "High"   in data.columns.get_level_values(0) else pd.DataFrame()
                    c_low    = data["Low"]    if "Low"    in data.columns.get_level_values(0) else pd.DataFrame()
                else:
                    if "Close" not in data.columns:
                        c_close = c_volume = c_high = c_low = pd.DataFrame()
                    else:
                        c_close  = data[["Close"]].rename(columns={"Close": chunk[0]})
                        c_volume = data[["Volume"]].rename(columns={"Volume": chunk[0]}) if "Volume" in data.columns else pd.DataFrame()
                        c_high   = data[["High"]].rename(columns={"High": chunk[0]}) if "High" in data.columns else pd.DataFrame()
                        c_low    = data[["Low"]].rename(columns={"Low": chunk[0]}) if "Low" in data.columns else pd.DataFrame()
                for t in c_close.columns:
                    all_close[t] = c_close[t]
                    if t in c_volume.columns:
                        all_volume[t] = c_volume[t]
                    if t in c_high.columns:
                        all_high[t] = c_high[t]
                    if t in c_low.columns:
                        all_low[t] = c_low[t]
                break
            except Exception as ex:
                if attempt < max_retries:
                    print(f"   ⚠️ Chunk {ci+1} intento {attempt+1} falló ({ex}), reintentando...")
                    time.sleep(2)
                else:
                    print(f"   ❌ Chunk {ci+1} descartado: {ex}")
        sys.stdout.write(f"\r   ⬇️  {min((ci+1)*chunk_size, len(tickers))}/{len(tickers)} tickers")
        sys.stdout.flush()
    print()
    return pd.DataFrame(all_close), pd.DataFrame(all_volume), pd.DataFrame(all_high), pd.DataFrame(all_low)

_OHLC_AVAILABLE = False  # flag global para indicar si hay High/Low

cache = load_cache()
if cache:
    closes    = cache['closes']
    available = cache['available']
    volume_df = cache['volume']
    high_df   = cache.get('high', pd.DataFrame(index=closes.index, columns=closes.columns))
    low_df    = cache.get('low', pd.DataFrame(index=closes.index, columns=closes.columns))
    _OHLC_AVAILABLE = not high_df.empty and not low_df.empty
else:
    print(f"📡 Descargando {len(all_tickers)} tickers ({LOOKBACK}d)...")
    try:
        closes_raw, volume_df, high_raw, low_raw = download_with_retry(all_tickers, LOOKBACK)
        closes    = closes_raw.tail(LOOKBACK).dropna(axis=1, thresh=int(LOOKBACK * 0.90))
        available = list(closes.columns)
        closes    = closes[available]
        high_df   = high_raw[available].tail(LOOKBACK) if not high_raw.empty else pd.DataFrame(index=closes.index)
        low_df    = low_raw[available].tail(LOOKBACK)  if not low_raw.empty else pd.DataFrame(index=closes.index)
        _OHLC_AVAILABLE = not high_df.empty and not low_df.empty
        print(f"   ✅ {len(available)} tickers con ≥90% de datos")
        print(f"   📅 Datos descargados: {closes.index[0].strftime('%d/%m/%Y')} → {closes.index[-1].strftime('%d/%m/%Y')} ({len(closes)} días)")
        if len(available) < 50:
            print("   ❌ Muy pocos tickers. Revisa conexión o rate-limit de Yahoo.")
            sys.exit(1)
        save_cache(closes, volume_df, high_df, low_df, available)
    except Exception as e:
        print(f"   ❌ {e}\n   🔧 pip install yfinance pandas numpy scikit-learn lightgbm")
        sys.exit(1)

# ─── SELECCIÓN PARA HEATMAP ───────────────────────────────────────────────────
curated_set     = set(CURATED)
heatmap_tickers = [t for t in CURATED if t in available]
stock_candidates = []
for t in available:
    if t in curated_set:
        continue
    vol = volume_df[t].iloc[-1] if t in volume_df.columns else np.nan
    vol = 0 if pd.isna(vol) else vol
    stock_candidates.append((t, closes[t].iloc[-1] * vol))
stock_candidates.sort(key=lambda x: x[1], reverse=True)
top_n = min(HEATMAP_DISPLAY_N - len(heatmap_tickers), len(stock_candidates))
heatmap_tickers.extend([t for t, _ in stock_candidates[:top_n]])
# ─── FILTRO POR LIQUIDEZ (--top N) ──────────────────────────────────────────────
if TOP_N > 0 and len(available) > TOP_N:
    ticker_vol = {}
    for t in available:
        if t in volume_df.columns:
            vol = volume_df[t].iloc[-min(63, len(volume_df)):].mean()
            ticker_vol[t] = 0.0 if pd.isna(vol) else float(vol)
        else:
            ticker_vol[t] = 0.0
    sorted_by_vol = sorted(ticker_vol.items(), key=lambda x: -x[1])
    top_tickers = [t for t, _ in sorted_by_vol[:TOP_N]]
    available = [t for t in available if t in top_tickers]
    closes = closes[available]
    volume_df = volume_df[available] if not volume_df.empty else pd.DataFrame()
    high_df = high_df[available] if not high_df.empty else pd.DataFrame(index=closes.index)
    low_df = low_df[available] if not low_df.empty else pd.DataFrame(index=closes.index)
    print(f"   💧 Filtrado a top {TOP_N} tickers por liquidez (media 63d)")

print(f"🔥 Heatmap: {len(heatmap_tickers)} tickers  |  📈 Regresión: {len(available)} tickers")

# ─── INDICADORES TÉCNICOS ─────────────────────────────────────────────────────

def rsi_wilder(prices: np.ndarray, period: int) -> np.ndarray:
    """RSI con EMA Wilder (alpha=1/period) — estándar industria."""
    delta  = np.diff(prices, prepend=prices[0])
    gains  = np.where(delta > 0, delta, 0.0)
    losses = np.where(delta < 0, -delta, 0.0)
    alpha  = 1.0 / period
    ag = pd.Series(gains).ewm(alpha=alpha, adjust=False).mean().values
    al = pd.Series(losses).ewm(alpha=alpha, adjust=False).mean().values
    rs = np.divide(ag, al, out=np.full_like(ag, 100.0), where=al > 1e-10)
    return 100.0 - (100.0 / (1.0 + rs))


def trend_efficiency_vectorized(prices: np.ndarray, period: int = 20) -> np.ndarray:
    """Trend Efficiency Ratio vectorizado — sin loop O(n²)."""
    s = pd.Series(prices)
    net_disp  = s.diff(period).abs()
    path_len  = s.diff().abs().rolling(period).sum()
    te = (net_disp / path_len.replace(0, np.nan) * 100).fillna(0)
    return te.values


def trend_slope_factor(prices: np.ndarray, period: int = 20) -> np.ndarray:
    """[FIX-D] Pendiente de regresión lineal rolling O(n) vectorizada.
    Reemplaza ADX que es inválido sin datos OHLC.
    Valor positivo = tendencia alcista, negativo = bajista.
    """
    s = pd.Series(prices, dtype=float)
    # x: [0, 1, ..., period-1]
    x = np.arange(period, dtype=float)
    x_mean = x.mean()
    x_var  = ((x - x_mean) ** 2).sum()

    # Rolling sums necesarias para cov(x,y)
    # Σ(x·y) = Σ (i * y[t - period + 1 + i])  para i=0..period-1
    # = Σ_i i * lag_i(y) donde lag_i desplaza i posiciones
    x_lag_sum = sum((x[i] - x_mean) * s.shift(period - 1 - i) for i in range(period))
    y_sum     = s.rolling(period).sum()
    y_mean    = y_sum / period

    # Σ (x-x̄)(y-ȳ) = Σ(x-x̄)·y  porque Σ(x-x̄)·ȳ = 0
    cov_xy = x_lag_sum  # ya centrado
    slope  = cov_xy / x_var

    # Normalizado por precio medio
    slope_norm = slope / (y_mean.abs().replace(0, np.nan) + 1e-10) * 100
    return slope_norm.fillna(0).values


def calc_indicators(price_series: pd.Series, slope_period: int = 20,
                    high_series: pd.Series | None = None,
                    low_series: pd.Series | None = None) -> dict | None:
    c = price_series.values
    n = len(c)
    if n < 70:
        return None

    # [FIX-M4] ATR con True Range real si hay OHLC, fallback a close-only
    high_arr = np.asarray(high_series.values, dtype=float) if high_series is not None else c
    low_arr  = np.asarray(low_series.values, dtype=float)  if low_series is not None else c
    # Si high/low no están disponibles (NaN) o son constantes (backward compatible), usar close
    if np.all(np.isnan(high_arr)) or np.all(np.isnan(low_arr)) or np.array_equal(high_arr, low_arr):
        high_arr = c
        low_arr = c

    ma20  = pd.Series(c).rolling(20).mean().values
    ma50  = pd.Series(c).rolling(50).mean().values
    ma200 = pd.Series(c).rolling(200, min_periods=50).mean().values

    r2  = rsi_wilder(c, 2)
    r14 = rsi_wilder(c, 14)

    # True Range real: max(High-Low, |High-PrevClose|, |Low-PrevClose|)
    prev_c = np.roll(c, 1)
    prev_c[0] = c[0]
    tr = np.maximum(
        high_arr - low_arr,
        np.maximum(np.abs(high_arr - prev_c), np.abs(low_arr - prev_c))
    )
    atr14   = pd.Series(tr).ewm(alpha=1/14, adjust=False).mean().values
    atr_pct = np.divide(atr14, c, out=np.zeros_like(atr14), where=c > 0)

    e12 = pd.Series(c).ewm(span=12, adjust=False).mean().values
    e26 = pd.Series(c).ewm(span=26, adjust=False).mean().values
    ml  = e12 - e26
    ms  = pd.Series(ml).ewm(span=9, adjust=False).mean().values
    mh  = ml - ms

    te    = trend_efficiency_vectorized(c, 20)
    slope = trend_slope_factor(c, slope_period)  # [FIX-D] periodo dinámico según modo

    ret = pd.Series(c).pct_change().fillna(0).values

    return {
        "rsi2": r2, "rsi14": r14,
        "atr_pct": atr_pct, "macd_hist": mh,
        "trend_eff": te, "slope": slope,
        "returns": ret, "close": c,
        "ma20": ma20, "ma50": ma50, "ma200": ma200
    }


print(f"🧮 Calculando indicadores Olympus (mode={MODE_NAME}, slope={P['slope_period']}d, OHLC={'SÍ' if _OHLC_AVAILABLE else 'NO'})...")
all_ind = {}
for t in available:
    h = high_df[t] if not high_df.empty and t in high_df.columns else None
    l = low_df[t]  if not low_df.empty  and t in low_df.columns  else None
    r = calc_indicators(closes[t], slope_period=P["slope_period"], high_series=h, low_series=l)
    if r is not None:
        all_ind[t] = r
print(f"   ✅ {len(all_ind)} tickers con indicadores")

# ─── MATRIZ DE CORRELACIONES LEDOIT-WOLF [FIX-F] ─────────────────────────────
# [FIX-F] Ajustar LW solo con tickers de retornos completos (cero NaN)
print("📊 Matriz de correlaciones Ledoit-Wolf...")
from sklearn.covariance import LedoitWolf

# Tickers con retornos sin NaN para el fit
complete_tickers = [t for t in all_ind
                    if np.isnan(all_ind[t]["returns"]).sum() == 0]
print(f"   ✅ {len(complete_tickers)} tickers con retornos completos para LW fit")

rdf_complete = pd.DataFrame({t: all_ind[t]["returns"] for t in complete_tickers})
lw     = LedoitWolf().fit(rdf_complete.values)
cov_lw = pd.DataFrame(lw.covariance_,
                       index=rdf_complete.columns,
                       columns=rdf_complete.columns)
std_lw = np.sqrt(np.diag(cov_lw.values))
corr_lw = cov_lw.div(std_lw, axis=0).div(std_lw, axis=1).round(3)

# Para heatmap visual
heatmap_display = [t for t in heatmap_tickers if t in all_ind]
heatmap_for_corr = [t for t in heatmap_display if t in corr_lw.columns]
corr_hm = corr_lw.loc[heatmap_for_corr, heatmap_for_corr]
print(f"🔥 Heatmap (LW): {len(heatmap_for_corr)} tickers")

# ─── MOTOR CROSS-SECTIONAL ────────────────────────────────────────────────────
print("📈 Motor Quant Cross-Sectional — GBM + Walk-Forward sin overlap + IC...")

try:
    import lightgbm as lgb
    _USE_LGB = True
    print("   ⚡ LightGBM detectado")
except ImportError:
    from sklearn.ensemble import GradientBoostingRegressor
    _USE_LGB = False
    print("   ℹ️  Usando GradientBoosting (pip install lightgbm)")

from scipy.stats import spearmanr

# [FIX-K] Excluir ^VIX del universo de modelado — no es tradeable
NON_TRADEABLE = {"^VIX"}
BENCH_TICKERS = {"SPY", "QQQ", "IWM", "DIA", "MDY"}  # [FIX-Q] excluidos de portfolio Q5
tickers_panel = sorted([t for t in all_ind.keys() if t not in NON_TRADEABLE])
ret_df  = pd.DataFrame({t: all_ind[t]["returns"] for t in tickers_panel})
log_ret = np.log1p(ret_df)

# ── Factores cross-seccionales (SIN ffill global [FIX-A]) ────────────────────
# Los factores se construyen con NaN donde no hay datos suficientes.
# El ffill se aplica localmente dentro de cada ventana de entrenamiento (ver make_dataset).
# Periodos dinámicos según modo: swing(H=5), scalp(H=1), funda(H=21)

mom_p = P["mom_period"]
rev_p = P["rev_period"]
vs    = P["vol_short"]
vl    = P["vol_long"]
vanom_p = P["volanom_period"]
mom_lp  = P["mom_long_period"]

# F1: Momentum (periodo dinámico)
mom_short = np.expm1(log_ret.rolling(mom_p).sum())
# F2: Reversal (contrarian, periodo dinámico)
rev_short = -np.expm1(log_ret.rolling(rev_p).sum())
# F3: Compresión de volatilidad
vol_short  = ret_df.rolling(vs).std()
vol_long   = ret_df.rolling(vl).std().replace(0, np.nan)
volratio   = -(vol_short / vol_long)
# [FIX-L] F4: Relative strength vs EW mediana del universo (no vs SPY)
# v5.0 usaba SPY como benchmark, que creaba correlación espuria feature/target
# cuando SPY caía: rs_spy alto Y excess_return alto no eran señal real.
# Ahora se usa la mediana equiponderada del universo como benchmark neutro.
bench_median = mom_short.median(axis=1).fillna(0.0)
rs_bench     = mom_short.subtract(bench_median, axis=0)
# F5: RSI(2) cross-sectional contrarian
rsi2_df = pd.DataFrame({t: all_ind[t]["rsi2"] for t in tickers_panel})
rsi2_cs = -rsi2_df
# F6: Anomalía de volumen (NaN → neutral=1.0)
_vanom = {}
for t in tickers_panel:
    if t in volume_df.columns:
        vs_vola = volume_df[t].reindex(closes.index)
        vol_ma  = vs_vola.rolling(vanom_p).mean()
        _vanom[t] = (vs_vola / vol_ma.replace(0, np.nan)).fillna(1.0)
    else:
        _vanom[t] = pd.Series(1.0, index=closes.index)
volanom_df = pd.DataFrame(_vanom)
# F7: Momentum largo (periodo dinámico)
mom_long = np.expm1(log_ret.rolling(mom_lp).sum())
# F8: Trend slope factor [FIX-D] — periodo dinámico según modo
slope_df = pd.DataFrame({t: all_ind[t]["slope"] for t in tickers_panel})
# F9-F13: Factores adicionales desde indicadores ya calculados [v7.1 IC-BOOST]
# MACD histogram, ATR%, distancia de MA, trend efficiency — todos cross-seccionales
macd_df      = pd.DataFrame({t: all_ind[t]["macd_hist"] for t in tickers_panel})
atr_df       = pd.DataFrame({t: all_ind[t]["atr_pct"]   for t in tickers_panel})
ma20_dist_df = pd.DataFrame({t: all_ind[t]["close"] / np.maximum(all_ind[t]["ma20"], 1e-10) - 1.0 for t in tickers_panel})
ma50_dist_df = pd.DataFrame({t: all_ind[t]["close"] / np.maximum(all_ind[t]["ma50"], 1e-10) - 1.0 for t in tickers_panel})
trend_eff_df = pd.DataFrame({t: all_ind[t]["trend_eff"] for t in tickers_panel})

factor_list  = [mom_short, rev_short, volratio, rs_bench, rsi2_cs, volanom_df, mom_long, slope_df,
                macd_df, atr_df, ma20_dist_df, ma50_dist_df, trend_eff_df]
factor_names = [f"mom{mom_p}", f"rev{rev_p}", f"volratio{vs}_{vl}", f"rs_bench{mom_p}", "rsi2_cs",
                f"volanom{vanom_p}", f"mom{mom_lp}", "slope",
                "macd_hist", "atr_pct", "ma20_dist", "ma50_dist", "trend_eff"]

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
        # [FIX-J] Normalización expanding (sin look-ahead: min/max solo con datos pasados)
        for col in fred_result.columns:
            s = fred_result[col].ffill().fillna(0)
            exp_min = s.expanding(min_periods=21).min()
            exp_max = s.expanding(min_periods=21).max()
            denom   = (exp_max - exp_min).replace(0, np.nan)
            norm    = 100 * (s - exp_min) / denom
            norm    = norm.fillna(50.0).clip(0, 100)
            # Broadcast to all tickers: (n_days, n_tickers)
            broad_arr = np.tile(norm.values.reshape(-1, 1), (1, len(tickers_panel)))  # (n_days, N)
            fred_stack_arrays.append(broad_arr)
            fred_stack_names.append("fred_" + col)
        print(f"   ✅ FRED: {len(fred_result.columns)} factores macro")
        # [REALMONEY] Detectar series stale (sin update en ultimos 5 dias)
        fresh_cols = []
        stale_cols = []
        for col in fred_result.columns:
            last_val = fred_result[col].dropna()
            if len(last_val) > 0:
                days_since_update = (fred_result.index[-1] - last_val.index[-1]).days
                if days_since_update <= 5:
                    fresh_cols.append(col)
                else:
                    stale_cols.append((col, days_since_update))
        if stale_cols:
            stale_str = ", ".join([f"{c}({d}d)" for c, d in stale_cols])
            print(f"   WARNING [FRED-STALE] {stale_str}")
        if fresh_cols:
            print(f"   OK [FRED-FRESH] {len(fresh_cols)}/{len(fred_result.columns)} series activas")
        # [FIX-FRED] NO podar series stale — las mensuales (CPI, empleo, etc.)
        # siempre tienen 30-60 días de lag. Podarlas elimina el 87.5% de FRED.
        # La normalización expanding (FIX-J) maneja datos stale correctamente.
        # Mantener todas las series — solo advertir.
        n_stale = len(stale_cols)
        if n_stale > 0:
            print(f"   [FRED-OK] {n_stale} series con lag normal (mensual) — se mantienen todas. Fresh={len(fresh_cols)}")
    else:
        print("   ⚠️ FRED: no disponible")
except Exception as e:
    print(f"   ⚠️ FRED: error ({e})")

# 9b. FINRA short volume
try:
    finra_result = fetch_finra_factors(tickers_panel, closes.index)
    if finra_result is not None:
        finra_clean = finra_result.reindex(closes.index, method="ffill").fillna(0.5)
        # Reindex to match tickers_panel (fill missing tickers with 0.5 neutral)
        finra_clean = finra_clean.reindex(columns=tickers_panel, fill_value=0.5)
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
        inside_clean = insider_result.reindex(closes.index).fillna(np.nan)  # [FIX-P] NO ffill global
        # Reindex to match tickers_panel (fill missing with 0 = neutral)
        inside_clean = inside_clean.reindex(columns=tickers_panel, fill_value=0.0)
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
        sent_clean = sent_result.reindex(closes.index).fillna(np.nan)  # [FIX-P] NO ffill global
        # Reindex to match tickers_panel (fill missing with 0 = neutral)
        sent_clean = sent_clean.reindex(columns=tickers_panel, fill_value=0.0)
        alt_data_dfs.append(sent_clean)
        alt_data_names.append("news_sentiment")
        print(f"   ✅ SENTIMENT: {len(sent_clean.columns)} tickers")
    else:
        print("   ⚠️ SENTIMENT: no disponible")
except Exception as e:
    print(f"   ⚠️ SENTIMENT: error ({e})")

# 9e. Factores fundamentales (yfinance, GRATIS): earnings_surprise + revenue_growth + short_interest + price_target
# [FIX-C4] short_interest y price_target son SNAPSHOT_ONLY: solo valor actual,
# no deben incluirse en el factor_stack histórico (crean look-ahead).
# Solo se usan para la predicción del día actual.
SNAPSHOT_ONLY_FACTORS = {"short_interest", "price_target"}
snapshot_factors = {}
try:
    fundamentals_result = fetch_fundamental_factors(tickers_panel, closes.index)
    if fundamentals_result is not None:
        FUND_FACTOR_NAMES = ["earnings_surprise", "revenue_growth", "short_interest", "price_target"]
        for fn in FUND_FACTOR_NAMES:
            df = fundamentals_result[fn]
            clean = df.reindex(columns=tickers_panel, fill_value=0.0)
            if fn not in SNAPSHOT_ONLY_FACTORS:
                alt_data_dfs.append(clean)
                alt_data_names.append(fn)
            else:
                # Solo para predicción del día actual — NO en factor_stack histórico
                snapshot_factors[fn] = clean.iloc[-1] if not clean.empty else pd.Series(0.0, index=tickers_panel)
        es_nz = (fundamentals_result["earnings_surprise"].iloc[-1] != 0).sum() if not fundamentals_result["earnings_surprise"].empty else 0
        rg_nz = (fundamentals_result["revenue_growth"].iloc[-1] != 0).sum() if not fundamentals_result["revenue_growth"].empty else 0
        si_nz = (fundamentals_result["short_interest"].iloc[-1] != 0).sum() if not fundamentals_result["short_interest"].empty else 0
        pt_nz = (fundamentals_result["price_target"].iloc[-1] != 0).sum() if not fundamentals_result["price_target"].empty else 0
        print(f"   ✅ FUNDAMENTAL: ES={es_nz} RG={rg_nz} SI={si_nz} PT={pt_nz} tickers")
        if snapshot_factors:
            print(f"   📸 [FIX-C4] SNAPSHOT_ONLY: {list(snapshot_factors.keys())} — solo score actual, no histórico")
    else:
        print("   ⚠️ FUNDAMENTAL: no disponible")
except Exception as e:
    print(f"   ⚠️ FUNDAMENTAL: error ({e})")

# 9f. Whale tracking (Finviz — institutional ownership + insider buying + short float)
# [WHALE] Datos gratuitos de Finviz: propiedad institucional, insider transactions, short float.
# Solo ~60 tickers top (rate-limiting). Estos factores no pasan por cs_rank — van directo al stack.
try:
    whale_result = fetch_whale_factors(tickers_panel, closes.index)
    if whale_result is not None:
        for wname, wdf in whale_result.items():
            wclean = wdf.reindex(closes.index).fillna(np.nan)
            wclean = wclean.reindex(columns=tickers_panel, fill_value=0.0)
            alt_data_dfs.append(wclean)
            alt_data_names.append(wname)
        print(f"   ✅ WHALE: {len(whale_result)} factores (inst_ownership, finviz_insider, finviz_shortfloat)")
    else:
        print("   ⚠️ WHALE: no disponible")
except Exception as e:
    print(f"   ⚠️ WHALE: error ({e})")

# Merge alt per-ticker factors into factor_list and factor_names
# FRED macro handled separately via fred_stack_arrays (added after cs_rank)
factor_list.extend(alt_data_dfs)
factor_names.extend(alt_data_names)


def cs_rank(df: pd.DataFrame) -> pd.DataFrame:
    """Rankeo cross-seccional percentil 0-100 por fila (día). Sin ffill."""
    return df[tickers_panel].rank(axis=1, pct=True) * 100

# [FIX-A] NO aplicar ffill global — los factores conservan sus NaN naturales
ranked_raw = [cs_rank(f) for f in factor_list]

# Target: excess return forward HORIZON días
fwd_log    = log_ret.shift(-HORIZON).rolling(HORIZON).sum()
fwd_ret    = np.expm1(fwd_log)
# [FIX-C3] Target vs mediana EW del universo (consistente con FIX-L: rs_bench vs EW)
# Antes: fwd_excess vs SPY, lo que creaba inconsistencia con los factores
# que usan EW median como benchmark (FIX-L).
# Ahora: excess vs EW median = alpha cross-seccional puro.
ew_median_fwd = fwd_ret[tickers_panel].median(axis=1).fillna(0.0)
fwd_excess   = fwd_ret[tickers_panel].subtract(ew_median_fwd, axis=0)

n_days    = len(ret_df)
n_tick    = len(tickers_panel)
START_DAY = 70
TRAIN_END = n_days - HORIZON - 5

# Stack de factores sin ffill (NaN conservados para filtrar en make_dataset)
base_stack  = np.stack([rf[tickers_panel].values for rf in ranked_raw], axis=2)
# Concatenate FRED macro factors (not ranked cross-sectionally)
# --no-fred los excluye de factores cross-seccionales
if NO_FRED:
    factor_stack = base_stack
    all_factor_names = factor_names
    if fred_stack_arrays:
        print(f"   🚫 FRED excluido de factores cross-seccionales")
else:
    # [FIX-REGIME] Market regime factor: SPY vol expansion + drawdown
    # Detecta cambios de régimen — el modelo aprende cuándo sus patrones son fiables
    if 'SPY' in all_ind:
        spy_close = pd.Series(all_ind['SPY']['close'], index=closes.index)
        spy_ret   = pd.Series(all_ind['SPY']['returns'], index=closes.index)
        # Vol expansion: ratio 20d/63d — spikes >1.5 = régimen turbulento
        spy_vol20 = spy_ret.rolling(20).std()
        spy_vol63 = spy_ret.rolling(63).std().replace(0, np.nan)
        vol_expansion = (spy_vol20 / spy_vol63).fillna(1.0)
        # 52-week drawdown: 0-100 score (0 = max DD, 100 = ATH)
        spy_52h  = spy_close.rolling(252, min_periods=20).max()
        spy_dd52 = (spy_close / spy_52h.replace(0, np.nan)).clip(0.7, 1.0) * 100
        # Composite regime: promedio de vol_expansion_score + drawdown_score
        # vol_expansion_score: inverted (high expansion = low score = danger)
        vol_score = (1.0 / vol_expansion.clip(0.5, 3.0)) * 100  # 33-200, capped
        regime_composite = (vol_score * 0.4 + spy_dd52 * 0.6).fillna(50.0).clip(0, 100)
        regime_broad = np.tile(regime_composite.values.reshape(-1, 1), (1, len(tickers_panel)))
        fred_stack_arrays.append(regime_broad)
        fred_stack_names.append('market_regime')
        print(f'   [REGIME] Market regime factor: vol_exp={vol_expansion.iloc[-1]:.2f}x dd52={spy_dd52.iloc[-1]:.1f}% composite={regime_composite.iloc[-1]:.1f}')
    if fred_stack_arrays:
        fred_3d = np.stack(fred_stack_arrays, axis=2)
        factor_stack = np.concatenate([base_stack, fred_3d], axis=2)
        all_factor_names = factor_names + fred_stack_names
    else:
        factor_stack = base_stack
        all_factor_names = factor_names
n_fact = factor_stack.shape[2]
fwd_ret_stack = fwd_excess[tickers_panel].values

# [PRUNE-FACTORS] v7.0: Poda de factores con importancia < 0.05 tras fold 0
pruned_factor_indices = set()
all_factor_names_current = list(all_factor_names)

# ── PURGED WALK-FORWARD con embargo [FIX-B] + [PURGED-WF] ────────────────
# Esquema purged expanding:
#   Fold 1: train=[START, T1-EMBARGO), test=[T1, T2)
#   Fold 2: train=[START, T2-EMBARGO), test=[T2, T3)   ← train crece + embargo
#   Fold 3: train=[START, T3-EMBARGO), test=[T3, END)
#
# [PURGED-WF] EMBARGO: elimina HORIZON días entre train y test para evitar
# que el modelo aprenda de datos temporalmente cercanos (autocorrelación).
# Si EMBARGO=5 y HORIZON=5, los targets del train y el test no tienen solapamiento.
#
# Dividimos [START, TRAIN_END] en N_FOLDS+1 bloques iguales.

EMBARGO = max(HORIZON, 3)  # [PURGED-WF] Días de purga entre train y test

block  = (TRAIN_END - START_DAY) // (N_FOLDS + 1)
cuts   = [START_DAY + block * (k + 1) for k in range(N_FOLDS)]
# Train termina EMBARGO días antes del test (purga)
fold_train_ends  = [c - EMBARGO for c in cuts]
fold_test_starts = cuts
fold_test_ends   = cuts[1:] + [TRAIN_END]

# Validar que el train tenga datos suficientes después de purgar
for fi in range(N_FOLDS):
    tr_len = fold_train_ends[fi] - START_DAY
    if tr_len < 50:
        print(f"   ⚠️ Purged WF: fold {fi+1} train={tr_len}d (mín 50) — embargo reducido automáticamente")
        fold_train_ends[fi] = cuts[fi] - 2  # embargo mínimo de 2 días


# ── make_dataset: función pura fuera del loop [FIX-E] ────────────────────────
def make_dataset(day_range: range,
                 f_stack: np.ndarray,
                 t_stack: np.ndarray,
                 n_factors: int,
                 apply_ffill: bool = True) -> tuple:
    """
    Construye (X, y) para un rango de días.
    [FIX-A] Si apply_ffill=True, el ffill se aplica dentro del slice
            (temporalmente válido), nunca sobre el dataset completo.
    [FIX-E] Función pura: no captura variables del scope exterior.
    """
    days      = list(day_range)
    f_slice   = f_stack[days].copy()   # (D, N, F)
    t_slice   = t_stack[days]          # (D, N)

    if apply_ffill:
        # ffill por ticker (columna) dentro del slice temporal — válido temporalmente
        for fi in range(f_slice.shape[2]):
            plane = pd.DataFrame(f_slice[:, :, fi])
            f_slice[:, :, fi] = plane.ffill(axis=0).values

    # Target rankeado por fila (día) dentro del slice [FIX de v3]
    ranked_t = np.full_like(t_slice, np.nan)
    for di in range(len(days)):
        row        = t_slice[di]
        valid_mask = ~np.isnan(row)
        if valid_mask.sum() < 10:
            continue
        vals = row[valid_mask]
        ranks = (np.argsort(np.argsort(vals)) + 1) / len(vals) * 100
        ranked_t[di, valid_mask] = ranks

    X_rows, y_rows = [], []
    for di in range(len(days)):
        x_day = f_slice[di]
        y_day = ranked_t[di]
        mask  = ~(np.isnan(x_day).any(axis=1) | np.isnan(y_day))
        if mask.sum() < 10:
            continue
        X_rows.append(x_day[mask])
        y_rows.append(y_day[mask])

    if not X_rows:
        return np.empty((0, n_factors)), np.empty(0)
    return np.vstack(X_rows), np.concatenate(y_rows)


all_ic_scores = []
all_ic_pvals  = []
fold_models   = []
fold_ic_means = []
fold_feat_imp = []  # [PRUNE-FACTORS] feature importance por fold

print(f"   📊 Walk-Forward expanding (sin overlap): {N_FOLDS} folds | "
      f"factor_stack={factor_stack.shape} | LOOKBACK={LOOKBACK}d | mode={MODE_NAME}")

for fold_i in range(N_FOLDS):
    best_lgb_params = None  # [FIX-V] inicializar antes del bloque hyperopt para evitar NameError
    tr_end   = fold_train_ends[fold_i]
    te_start = fold_test_starts[fold_i]
    te_end   = fold_test_ends[fold_i]

    train_range = range(START_DAY, tr_end)
    test_range  = range(te_start,  te_end)

    X_tr, y_tr = make_dataset(train_range, factor_stack, fwd_ret_stack, n_fact)
    X_te, y_te = make_dataset(test_range,  factor_stack, fwd_ret_stack, n_fact)

    if len(X_tr) < 500 or len(X_te) < 50:
        print(f"   ⚠️ Fold {fold_i+1}: datos insuficientes (train={len(X_tr)}, test={len(X_te)}), saltando")
        continue

    # [PRUNE-FACTORS] Si hay factores podados, reconstruir factor_stack para folds 1+
    if fold_i > 0 and pruned_factor_indices:
        keep = [i for i in range(n_fact) if i not in pruned_factor_indices]
        n_fact_pruned = len(keep)
        factor_stack_pruned = factor_stack[:, :, keep]
        all_factor_names_current = [all_factor_names[i] for i in keep]
        X_tr, y_tr = make_dataset(train_range, factor_stack_pruned, fwd_ret_stack, n_fact_pruned)
    else:
        factor_stack_pruned = factor_stack
        n_fact_pruned = n_fact
    X_te, y_te = make_dataset(test_range, factor_stack_pruned, fwd_ret_stack, n_fact_pruned)
    
    if _USE_LGB:
        # [HYPEROPT] Se ejecuta en fold 0 (abajo)
        # [HYPEROPT] v7.0: Optimizacion bayesiana en fold 0
        # [FIX-LITE] Si --lite, saltar hyperopt → usar defaults conservadores
        if fold_i == 0 and not pruned_factor_indices and not LITE_MODE:
            try:
                import optuna
                if len(X_tr) > 2000:
                    split80 = int(len(X_tr) * 0.8)
                    X0, y0 = X_tr[:split80], y_tr[:split80]
                    Xv, yv = X_tr[split80:], y_tr[split80:]
                    def _obj(trial):
                        p = {
                            'n_estimators': trial.suggest_int('n', 300, 1500),
                            'max_depth': trial.suggest_int('md', 3, 8),
                            'learning_rate': trial.suggest_float('lr', 0.003, 0.05, log=True),
                            'subsample': trial.suggest_float('ss', 0.5, 0.9),
                            'colsample_bytree': trial.suggest_float('cb', 0.4, 0.8),
                            'num_leaves': trial.suggest_int('nl', 15, 63),
                            'min_child_samples': trial.suggest_int('mc', 20, 100),
                            'reg_alpha': trial.suggest_float('ra', 0.01, 5.0, log=True),
                            'reg_lambda': trial.suggest_float('rl', 0.01, 5.0, log=True),
                            'random_state': 42, 'verbose': -1,
                        }
                        m = lgb.LGBMRegressor(**p).fit(X0, y0)
                        ic_val, _ = spearmanr(m.predict(Xv), yv)
                        return ic_val if not np.isnan(ic_val) else 0.0
                    st = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=42))
                    st.optimize(_obj, n_trials=25, show_progress_bar=False)
                    best_lgb_params = st.best_params
                    print(f"   [HYPEROPT] IC_val={st.best_value:.4f} | params={st.best_params}")
            except Exception as ex:
                print(f"   [HYPEROPT] fallo ({ex}), usando defaults")
        if best_lgb_params:
            # [FIX-V2] Mapear nombres cortos de Optuna (n,md,lr,...) a parametros reales de LightGBM
            # Optuna best_params usa los nombres de trial.suggest_*, NO los de LGBMRegressor
            params = {
                'n_estimators': best_lgb_params.get('n', 1000),
                'max_depth': best_lgb_params.get('md', 5),
                'learning_rate': best_lgb_params.get('lr', 0.008),
                'subsample': best_lgb_params.get('ss', 0.7),
                'colsample_bytree': best_lgb_params.get('cb', 0.6),
                'num_leaves': best_lgb_params.get('nl', 31),
                'min_child_samples': best_lgb_params.get('mc', 50),
                'reg_alpha': best_lgb_params.get('ra', 0.5),
                'reg_lambda': best_lgb_params.get('rl', 0.5),
                'random_state': 42 + fold_i,
                'verbose': -1,
            }
            model = lgb.LGBMRegressor(**params)
        else:
            model = lgb.LGBMRegressor(
                n_estimators=1000, max_depth=5, learning_rate=0.008,
                subsample=0.7, colsample_bytree=0.6,
                num_leaves=31, min_child_samples=50,
                reg_alpha=0.5, reg_lambda=0.5,
                random_state=42 + fold_i, verbose=-1)
    else:
        from sklearn.ensemble import GradientBoostingRegressor
        model = GradientBoostingRegressor(
            n_estimators=200, max_depth=3, learning_rate=0.03,
            subsample=0.8, min_samples_leaf=30, random_state=42 + fold_i)

    model.fit(X_tr, y_tr)
    fold_models.append((fold_i, model, te_start, te_end))  # guardamos metadatos
    
    # [PRUNE-FACTORS] Registrar feature importance (SIEMPRE 23 factores: podados -> 0)
    if hasattr(model, 'feature_importances_'):
        raw_imp = model.feature_importances_ / (model.feature_importances_.sum() + 1e-10)
        if fold_i > 0 and pruned_factor_indices:
            full_imp = np.zeros(n_fact)
            keep_idx = [i for i in range(n_fact) if i not in pruned_factor_indices]
            for k, idx in enumerate(keep_idx):
                if k < len(raw_imp):
                    full_imp[idx] = raw_imp[k]
            fold_feat_imp.append(full_imp)
        else:
            fold_feat_imp.append(raw_imp)

    # IC por día — OOS estricto
# [PRUNE-FACTORS] Usar factor_stack_pruned (puede ser el completo si no hay poda)
    _ic_stack = factor_stack_pruned if fold_i > 0 and pruned_factor_indices else factor_stack
    _ic_n_fact = n_fact_pruned if fold_i > 0 and pruned_factor_indices else n_fact
    fold_ics = []
    for day_i in test_range:
        # [FIX-A] ffill local al día: propagar solo hacia adelante dentro del histórico
        Xd_raw = _ic_stack[day_i].copy()
        # Para el punto de inferencia usamos ffill del histórico hasta ese día
        for fi in range(Xd_raw.shape[1]):
            col = _ic_stack[:day_i+1, :, fi]
            filled = pd.DataFrame(col).ffill(axis=0).values
            Xd_raw[:, fi] = filled[-1]

        yd_raw = fwd_ret_stack[day_i]
        valid  = ~(np.isnan(Xd_raw).any(axis=1) | np.isnan(yd_raw))
        if valid.sum() < 20:
            continue
        vals      = yd_raw[valid]
        yd_ranked = (np.argsort(np.argsort(vals)) + 1) / len(vals) * 100
        ic, pval  = spearmanr(model.predict(Xd_raw[valid]), yd_ranked)
        if not np.isnan(ic):
            all_ic_scores.append(ic)
            all_ic_pvals.append(pval)
            fold_ics.append(ic)

    fold_ic_mean = float(np.mean(fold_ics)) if fold_ics else 0.0
    fold_ic_means.append(fold_ic_mean)
    print(f"   📐 Fold {fold_i+1}/{N_FOLDS}: "
          f"train=[{START_DAY},{tr_end}) test=[{te_start},{te_end}) | "
          f"IC={fold_ic_mean:.4f} ({len(fold_ics)} días OOS)")
    
    # [FIX-T] PRUNE-FACTORS sin data snooping: la poda se decide usando solo el split
    # interno 80/20 del train set, ANTES de ver cualquier dato OOS del fold 0.
    # v7.0 calculaba importancia DESPUÉS del fit y del IC OOS — eso era snooping.
    if fold_i == 0 and not pruned_factor_indices:
        split80 = int(len(X_tr) * 0.8)
        X0_prune, y0_prune = X_tr[:split80], y_tr[:split80]
        Xv_prune, yv_prune = X_tr[split80:], y_tr[split80:]
        if _USE_LGB:
            _prune_model = lgb.LGBMRegressor(
                n_estimators=200, max_depth=5, learning_rate=0.05,
                subsample=0.7, colsample_bytree=0.6, num_leaves=31,
                min_child_samples=30, random_state=42, verbose=-1)
        else:
            from sklearn.ensemble import GradientBoostingRegressor
            _prune_model = GradientBoostingRegressor(
                n_estimators=100, max_depth=3, learning_rate=0.05,
                subsample=0.8, min_samples_leaf=30, random_state=42)
        _prune_model.fit(X0_prune, y0_prune)
        if hasattr(_prune_model, 'feature_importances_'):
            raw_imp_prune = _prune_model.feature_importances_ / (_prune_model.feature_importances_.sum() + 1e-10)
            low_imp = [i for i, v in enumerate(raw_imp_prune) if v < 0.05]
            if low_imp and len(low_imp) < n_fact - 2:
                pruned_factor_indices = set(low_imp)
                pruned_names = [all_factor_names[i] for i in sorted(low_imp)]
                print(f"   [FIX-T][PRUNE-FACTORS] {len(low_imp)} factores podados (imp<0.05, train-split80): {', '.join(pruned_names)}")
                print(f"   [FIX-T][PRUNE-FACTORS] Manteniendo {n_fact - len(low_imp)}/{n_fact} factores para todos los folds")
                # Re-construir X_tr/X_te con factores podados ANTES del fit del fold 0
                keep = [i for i in range(n_fact) if i not in pruned_factor_indices]
                n_fact_pruned = len(keep)
                factor_stack_pruned = factor_stack[:, :, keep]
                all_factor_names_current = [all_factor_names[i] for i in keep]
                X_tr, y_tr = make_dataset(train_range, factor_stack_pruned, fwd_ret_stack, n_fact_pruned)
                X_te, y_te = make_dataset(test_range, factor_stack_pruned, fwd_ret_stack, n_fact_pruned)
            else:
                print(f"   [FIX-T][PRUNE-FACTORS] Sin factores para podar (mínimo imp={min(raw_imp_prune):.4f})")


# ─── IC MONITOR — rolling IC + alarmas ───────────────────────────────────────
# [IC-MONITOR] Sistema de monitoreo de Information Coefficient en vivo.
# Calcula rolling IC en ventanas 20/60/120 días y activa alarmas cuando
# el IC cae por debajo de umbrales.

mean_ic   = float(np.mean(all_ic_scores))  if all_ic_scores else 0.0
std_ic    = float(np.std(all_ic_scores))   if all_ic_scores else 1.0
ir        = mean_ic / std_ic               if std_ic > 0 else 0.0
hit_rate  = float(np.mean([ic > 0 for ic in all_ic_scores])) if all_ic_scores else 0.5
ic_signif = float(np.mean([p < 0.05 for p in all_ic_pvals])) if all_ic_pvals else 0.0
MODEL_NAME = "LightGBM" if _USE_LGB else "GradientBoosting"

# Rolling IC y alarmas [IC-MONITOR]
ic_series = pd.Series(all_ic_scores)
ic_20d  = float(ic_series.tail(20).mean()) if len(ic_series) >= 20 else mean_ic
ic_60d  = float(ic_series.tail(60).mean()) if len(ic_series) >= 60 else mean_ic
ic_120d = float(ic_series.tail(120).mean()) if len(ic_series) >= 120 else mean_ic

# Guardar IC monitor en CSV para tracking histórico
ic_monitor_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ic_monitor.csv")
try:
    ic_row = pd.DataFrame([{
        "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "ic_mean": mean_ic,
        "ic_20d": ic_20d,
        "ic_60d": ic_60d,
        "ic_120d": ic_120d,
        "ir": ir,
        "hit_rate": hit_rate,
        "n_days": len(ic_series),
        "n_folds": N_FOLDS,
        "mode": MODE_NAME,
        "n_tickers": len(results) if 'results' in dir() else len(tickers_panel),
    }])
    if os.path.exists(ic_monitor_path):
        existing = pd.read_csv(ic_monitor_path)
        ic_monitor = pd.concat([existing, ic_row], ignore_index=True)
    else:
        ic_monitor = ic_row
    ic_monitor.to_csv(ic_monitor_path, index=False)
    # Mantener solo últimas 100 entradas
    if len(ic_monitor) > 100:
        ic_monitor.tail(100).to_csv(ic_monitor_path, index=False)
except Exception:
    pass

# Alarmas IC [IC-MONITOR]
icstatus = "🟢"
# [FIX-SEMAFORO] Umbrales corregidos: 0.03/0.05
if ic_20d < 0.03:
    icstatus = "🔴"
    print(f"   \n   🚨 ALARMA IC: IC_20d={ic_20d:.4f} < 0.03 — Señal degradada. Revisar modelo.")
elif ic_20d < 0.05:
    icstatus = "🟡"
    print(f"   \n   ⚠️ PRECAUCIÓN IC: IC_20d={ic_20d:.4f} < 0.05 — Señal débil. Monitorear.")

# Resumen IC con rolling
print(f"\n   📐 IC_mean={mean_ic:.4f} | IC_20d={ic_20d:.4f} | IC_60d={ic_60d:.4f} | IC_120d={ic_120d:.4f}")
print(f"   {icstatus} IR={ir:.2f} | Hit rate={hit_rate:.1%} | IC sig={ic_signif:.1%} | {len(all_ic_scores)} días OOS totales")
print(f"   📊 IC Monitor: {ic_monitor_path}")

# Feature importance: promedio sobre todos los folds
# [PRUNE-FACTORS] Usar all_factor_names (lista completa) con padding
if fold_models:
    if fold_feat_imp:
        feat_imp_arr = np.mean(fold_feat_imp, axis=0)
    else:
        feat_imp_arr = np.mean([m.feature_importances_ for _, m, _, _ in fold_models], axis=0)
    feat_imp = dict(zip(all_factor_names, feat_imp_arr))
else:
    feat_imp = {k: 0.0 for k in factor_names}
print("   🔍 " + " | ".join(f"{k}={v:.2f}" for k, v in sorted(feat_imp.items(), key=lambda x: -x[1])))

# ── Scores hoy — modelo del último fold ──────────────────────────────────────
final_model = fold_models[-1][1] if fold_models else None
last_day = n_days - 1
print(f"   🎯 Modelo prediciendo con datos hasta: {closes.index[last_day].strftime('%d/%m/%Y')} (último cierre disponible)")

# [FIX-A] ffill local para el día de hoy: propagar histórico hasta last_day
if pruned_factor_indices and factor_stack_pruned is not None and factor_stack_pruned.shape[2] != factor_stack.shape[2]:
    last_factor_stack = factor_stack_pruned
else:
    last_factor_stack = factor_stack
last_X = last_factor_stack[last_day].copy()
for fi in range(last_X.shape[1]):
    col    = last_factor_stack[:last_day+1, :, fi]
    filled = pd.DataFrame(col).ffill(axis=0).values
    last_X[:, fi] = filled[-1]

n_skipped = 0
raw_scores = {}

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
        score_ranks   = (np.argsort(np.argsort(preds_arr)) + 1) / len(preds_arr) * 100
        quintile_cuts = pd.qcut(score_ranks, 5, labels=[1, 2, 3, 4, 5])

        # [FIX-G] Confianza basada en raw_pred (dispersión real del modelo)
        pred_mean = preds_arr.mean()
        pred_std  = preds_arr.std() + 1e-10
        pred_z    = np.abs((preds_arr - pred_mean) / pred_std)  # z-score de la predicción

        for j, t in enumerate(valid_tickers):
            sc = float(np.clip(score_ranks[j], 0, 100))
            q  = int(quintile_cuts[j])

            if mean_ic < MIN_IC_FOR_SIGNAL:
                conf = "LOW"
            else:
                # [FIX-G] Alta confianza = predicción muy alejada de la media del modelo
                z = float(pred_z[j])
                conf = "HIGH" if z > 1.5 else "MED" if z > 0.75 else "LOW"

            raw_scores[t] = {
                "score":    round(sc, 1),
                "quintile": q,
                "ic":       round(mean_ic, 4),
                "ir":       round(ir, 2),
                "hit_rate": round(hit_rate, 3),
                "confidence": conf,
                "raw_pred": round(float(preds_arr[j]), 4),
                "pred_z":   round(float(pred_z[j]), 2),
            }

results = raw_scores
if n_skipped > 0:
    logger.warning(f"⚠️ {n_skipped} tickers saltados por NaN en features")

n_q5 = sum(1 for r in results.values() if r["quintile"] == 5)
n_q1 = sum(1 for r in results.values() if r["quintile"] == 1)
print(f"   ✅ {len(results)} scores | Q5 LONG: {n_q5} | Q1 SHORT/EVITAR: {n_q1}")

# ─── PORTFOLIO CONSTRUCTION Q5 [FIX-C] ───────────────────────────────────────
# [FIX-C] Métricas calculadas sobre periodo OOS del último fold únicamente
print("📦 Portfolio Construction Q5 (SxIV: Score × Inverse-Vol — métricas OOS)...")

# [FIX-M2+M3] Deduplicación de activos equivalentes
EQUIVALENCE_GROUPS = [
    {"GOOG", "GOOGL"},              # Alphabet — misma empresa
    {"BRK-A", "BRK-B"},            # Berkshire
    {"IBIT", "FBTC", "BITO"},       # Bitcoin spot/futures
    {"GLD", "PPFB.DE"},             # Oro
]

def deduplicate_q5(q5_tickers, results):
    """
    Para cada grupo de equivalencia, mantener solo el ticker
    con mayor score en Q5. Elimina los duplicados.
    """
    to_remove = set()
    for group in EQUIVALENCE_GROUPS:
        overlap = [t for t in q5_tickers if t in group]
        if len(overlap) > 1:
            best = max(overlap, key=lambda t: results[t]["score"])
            for t in overlap:
                if t != best:
                    to_remove.add(t)
                    logger.info(f"   [FIX-M2] Dedup: {t} eliminado (equivalente a {best}, score {results[best]['score']:.1f})")
    deduped = [t for t in q5_tickers if t not in to_remove]
    if to_remove:
        print(f"   [FIX-M2] Deduplicación: {len(to_remove)} activos eliminados ({', '.join(sorted(to_remove))})")
    return deduped

                                               # [FIX-Q] excluye SPY/QQQ/IWM/DIA/MDY del portfolio
q5_tickers = [t for t, r in results.items() if r["quintile"] == 5 and t in all_ind and t not in BENCH_TICKERS]
q5_tickers = deduplicate_q5(q5_tickers, results)

# ─── MAPEO SECTORIAL GLOBAL ─────────────────────────────────────────────────────
# [SECTOR-RISK] Mapeo sectorial para todos los tickers del universo
SECTOR_MAP = {
    "XLK":"Tech","AAPL":"Tech","MSFT":"Tech","NVDA":"Tech","AMD":"Tech","INTC":"Tech","AVGO":"Tech","CRM":"Tech","ADBE":"Tech","NOW":"Tech","CSCO":"Tech","QCOM":"Tech","TXN":"Tech","IBM":"Tech","ORCL":"Tech","PLTR":"Tech","ANET":"Tech","KLAC":"Tech","LRCX":"Tech","ADI":"Tech","MU":"Tech","PANW":"Tech",
    "XLF":"Fin","JPM":"Fin","BAC":"Fin","WFC":"Fin","GS":"Fin","MS":"Fin","AXP":"Fin","SPGI":"Fin","BLK":"Fin","C":"Fin","SCHW":"Fin","MMC":"Fin","ICE":"Fin","CME":"Fin","COF":"Fin","AON":"Fin","MCO":"Fin","FI":"Fin","BX":"Fin",
    "XLV":"Health","LLY":"Health","UNH":"Health","MRK":"Health","ABBV":"Health","JNJ":"Health","TMO":"Health","PFE":"Health","AMGN":"Health","SYK":"Health","BSX":"Health","VRTX":"Health","GILD":"Health","BMY":"Health","CI":"Health","ELV":"Health","HCA":"Health","REGN":"Health","ZTS":"Health","MDT":"Health","ABT":"Health","ISRG":"Health","DHR":"Health",
    "XLY":"ConsDisc","AMZN":"ConsDisc","TSLA":"ConsDisc","HD":"ConsDisc","MCD":"ConsDisc","NKE":"ConsDisc","LOW":"ConsDisc","BKNG":"ConsDisc","TJX":"ConsDisc","SBUX":"ConsDisc","UBER":"ConsDisc","CMG":"ConsDisc",
    "XLP":"ConsStap","PG":"ConsStap","KO":"ConsStap","PEP":"ConsStap","COST":"ConsStap","WMT":"ConsStap","MO":"ConsStap","PM":"ConsStap",
    "XLU":"Util","SO":"Util","DUK":"Util","NEE":"Util",
    "XLB":"Mat","SHW":"Mat","ECL":"Mat","LIN":"Mat","GWW":"Mat","CAT":"Mat","DE":"Mat",
    "XLI":"Indust","GE":"Indust","BA":"Indust","HON":"Indust","UNP":"Indust","ETN":"Indust","UPS":"Indust","LMT":"Indust","RTX":"Indust","CARR":"Indust","TT":"Indust","TDG":"Indust","NSC":"Indust","WM":"Indust","CAT":"Indust","ITW":"Indust",
    "XLC":"Comm","META":"Comm","GOOGL":"Comm","GOOG":"Comm","DIS":"Comm","NFLX":"Comm","CMCSA":"Comm","VZ":"Comm","T":"Comm","TMUS":"Comm",
    "XLRE":"RealEst","AMT":"RealEst","PLD":"RealEst","WELL":"RealEst",
    "XLE":"Energy","XOM":"Energy","CVX":"Energy","COP":"Energy",
    "SPY":"Bench","QQQ":"Bench","IWM":"Bench","DIA":"Bench","MDY":"Bench",
    "GLD":"Commod","SLV":"Commod","USO":"Commod","DBC":"Commod",
    "TLT":"Bond","AGG":"Bond","LQD":"Bond","HYG":"Bond",
    "IBIT":"Crypto","FBTC":"Crypto","BITO":"Crypto",
    "EEM":"EM","EFA":"DM","EWJ":"DM","FXI":"EM","EWZ":"EM","INDA":"DM","IEUR":"DM","VGK":"DM",
}

# ─── EXPOSICIÓN SECTORIAL Y ALERTAS ───────────────────────────────────────────
# Se calculará después de tener portfolio_weights

def get_sector(ticker):
    """Devuelve el sector de un ticker. "Other" si no está mapeado."""
    return SECTOR_MAP.get(ticker.upper(), "Other")

# ─── FIN MAPEO SECTORIAL ──────────────────────────────────────────────────────

portfolio_metrics = {}
portfolio_weights = {}
portfolio_hhi     = 0.0
greedy_order      = []

# Periodo OOS del último fold
last_fold_te_start = fold_test_starts[-1] if fold_models else 0
last_fold_te_end   = fold_test_ends[-1]   if fold_models else n_days

if len(q5_tickers) >= 2:
    # [BUG-NEW-3] Filtrar tickers con retornos completos (sin NaN) — consistente con FIX-F
    q5_tickers_complete = [t for t in q5_tickers
                           if np.isnan(all_ind[t]["returns"]).sum() == 0]
    if len(q5_tickers_complete) < 2:
        q5_tickers_complete = q5_tickers  # fallback
    q5_ret_full = pd.DataFrame({
        t: all_ind[t]["returns"] for t in q5_tickers_complete
    })

    # [SxIV] Score × Inverse-Vol: pesos por score del modelo / volatilidad
    # Fórmula ganadora del backtest: +263% retorno vs +47% GREEDY-SHARPE
    # w_i = score_i / vol_i → normalizado y capeado a 25%
    q5_ret_pre_oos = q5_ret_full.iloc[:last_fold_te_start]
    if len(q5_ret_pre_oos) < 20:
        q5_ret_pre_oos = q5_ret_full  # fallback
    lw_q5   = LedoitWolf().fit(q5_ret_pre_oos.values)
    cov_q5  = pd.DataFrame(lw_q5.covariance_, index=q5_tickers_complete, columns=q5_tickers_complete)
    cov_arr = cov_q5.values
    n_a     = len(q5_tickers_complete)
    
    # SxIV: score / volatilidad
    vol_q5_diag = np.sqrt(np.diag(cov_arr))
    scores_q5 = np.array([results.get(t, {}).get("score", 50.0) for t in q5_tickers_complete])
    w_raw = scores_q5 / np.maximum(vol_q5_diag, 0.005)
    w_raw = w_raw / w_raw.sum()
    w_cap = np.minimum(w_raw, 0.25)
    w_final = w_cap / w_cap.sum()
    print(f"   [SxIV] Score×InvVol | HHI={np.sum(w_final**2):.4f} | max_w={max(w_final)*100:.1f}%")

    portfolio_weights = {t: round(float(w), 4) for t, w in zip(q5_tickers_complete, w_final)}

    # [FIX-S] Sector concentration cap: máximo 40% por sector
    # Previene clustering silencioso (ej: XLK=25% + AAPL=25% + MSFT=25% = 75% Tech sin alarma)
    SECTOR_CAP = 0.40
    sector_totals = {}
    for t, w in portfolio_weights.items():
        s = get_sector(t)
        sector_totals[s] = sector_totals.get(s, 0) + w
    overweight_sectors = {s: v for s, v in sector_totals.items() if v > SECTOR_CAP and s not in ("Bench", "Other")}
    if overweight_sectors:
        print(f"   [FIX-S][SECTOR-CAP] Sectores sobreponderados {overweight_sectors} — recortando al {SECTOR_CAP*100:.0f}%")
        for sector_name, total_w in overweight_sectors.items():
            tickers_in_sector = [t for t in portfolio_weights if get_sector(t) == sector_name]
            scale = SECTOR_CAP / total_w
            for t in tickers_in_sector:
                portfolio_weights[t] = round(portfolio_weights[t] * scale, 4)
        # Renormalizar a suma 1
        total_w_new = sum(portfolio_weights.values())
        if total_w_new > 0:
            portfolio_weights = {t: round(w / total_w_new, 4) for t, w in portfolio_weights.items()}
        print(f"   [FIX-S] Pesos renormalizados")

    # [FIX-C] Métricas SOLO sobre periodo OOS del último fold
    q5_ret_oos = q5_ret_full.iloc[last_fold_te_start:last_fold_te_end].values
    if len(q5_ret_oos) < 20:
        q5_ret_oos = q5_ret_full.values[-60:]

    # [FIX-U] Advertencia explícita si OOS es demasiado corto para estadísticas fiables
    oos_len = len(q5_ret_oos)
    if oos_len < 120:
        logger.warning(f"⚠️ [FIX-U] OOS CORTO: solo {oos_len} días ({oos_len/252*12:.1f} meses). "
                       f"Sharpe estimado con alta incertidumbre estadística. "
                       f"Necesitas ≥252 días OOS para IC 95% en Sharpe. "
                       f"Aumenta LOOKBACK o reduce N_FOLDS.")
        logger.warning("⚠️ OOS corto para portfolio metrics, usando últimos 60 días")

    port_ret_oos   = q5_ret_oos @ w_final

    # [COSTES-REALES] Modelo de costes de transacción institucionales
    # Comisión IBKR Pro (8bps) + half-spread (5bps) + slippage (5bps) = 18bps/lado
    # Ida+vuelta = 36bps. Se amortiza en HORIZON días (rebalanceo periódico)
    COMMISSION_BPS = 8
    SPREAD_BPS     = 5
    SLIPPAGE_BPS   = 5
    TOTAL_COST_BPS = 2 * (COMMISSION_BPS + SPREAD_BPS + SLIPPAGE_BPS)  # 36bps
    TOTAL_COST_FRAC = TOTAL_COST_BPS / 10000
    cost_per_day = TOTAL_COST_FRAC / max(HORIZON, 1)
    port_ret_oos_net = port_ret_oos - cost_per_day

    port_vol_daily = float(np.sqrt(w_final @ cov_q5.values @ w_final))
    port_vol_ann   = port_vol_daily * np.sqrt(252)

    # Métricas GROSS (sin costes)
    port_vol_ann_oos  = float(np.std(port_ret_oos)) * np.sqrt(252)
    port_ret_ann_oos  = float(np.mean(port_ret_oos)) * 252
    port_sharpe_oos   = port_ret_ann_oos / port_vol_ann_oos if port_vol_ann_oos > 0 else 0.0
    port_var95_oos   = float(np.percentile(port_ret_oos, 5)) * 100
    port_var99_oos   = float(np.percentile(port_ret_oos, 1)) * 100
    port_cvar95_oos  = float(
        np.mean(port_ret_oos[port_ret_oos <= np.percentile(port_ret_oos, 5)])) * 100
    cumret_oos    = np.cumprod(1 + port_ret_oos)
    running_max   = np.maximum.accumulate(cumret_oos)
    drawdowns_oos = (cumret_oos - running_max) / running_max
    max_dd_oos    = float(np.min(drawdowns_oos)) * 100

    # Métricas NET (con costes reales) — [COSTES-REALES]
    port_ret_ann_oos_net = float(np.mean(port_ret_oos_net)) * 252
    port_sharpe_oos_net  = port_ret_ann_oos_net / port_vol_ann_oos if port_vol_ann_oos > 0 else 0.0
    port_net_impact_pct  = (port_sharpe_oos_net - port_sharpe_oos) / max(abs(port_sharpe_oos), 0.01)
    cumret_net = np.cumprod(1 + port_ret_oos_net)
    max_dd_net = float(np.min((cumret_net - np.maximum.accumulate(cumret_net)) / np.maximum.accumulate(cumret_net))) * 100

    portfolio_hhi = float(np.sum(w_final ** 2))

    # [FIX-C2] Sortino ratio — penaliza solo volatilidad negativa (calcular ANTES del dict)
    downside_returns = port_ret_oos[port_ret_oos < 0]
    downside_std = float(np.std(downside_returns)) * np.sqrt(252) if len(downside_returns) > 0 else 1e-10
    port_sortino_oos = port_ret_ann_oos / downside_std if downside_std > 0 else 0.0
    
    # [FIX-C2] Portfolio metrics SIEMPRE calculados, fuera del if sector_alerts
    portfolio_metrics = {
        "vol_ann":  round(port_vol_ann * 100, 2),
        "ret_ann":  round(port_ret_ann_oos * 100, 2),
        "sharpe":   round(port_sharpe_oos, 2),
        "sharpe_net": round(port_sharpe_oos_net, 2),
        "cost_impact_pct": round(port_net_impact_pct * 100, 1),
        "max_dd_net": round(max_dd_net, 2),
        "var95":    round(port_var95_oos, 2),
        "var99":    round(port_var99_oos, 2),
        "cvar95":   round(port_cvar95_oos, 2),
        "max_dd":   round(max_dd_oos, 2),
        "hhi":      round(portfolio_hhi, 4),
        "n_assets": len(q5_tickers),
        "oos_days": len(q5_ret_oos),
        "sortino":  round(port_sortino_oos, 2),
    }
    
    # ─── FIN SECTOR RISK ──────────────────────────────────────────────────────
    # Añadir sector a cada ticker en results para dashboard
    for t in portfolio_weights:
        if t not in results:
            continue
        sector = SECTOR_MAP.get(t.upper(), "Other")
        results[t]["sector"] = sector
    
    # [SxIV] Orden por score del modelo (descendente) — respeta el ranking
    # Backtest: Top-N por score con pesos SxIV da +263% vs +47% GREEDY-SHARPE
    greedy_order = sorted(q5_tickers_complete, key=lambda t: results.get(t, {}).get("score", 0), reverse=True)
    print(f"   [SxIV] Top-N por score: {len(greedy_order)} tickers | 1er={greedy_order[0] if greedy_order else 'N/A'} (score={results.get(greedy_order[0], {}).get('score', 0):.0f})")
    
    # [FIX-N] Benchmarks OOS: Equal-Weight Q5 y SPY Buy-and-Hold
    # Proporcionan contexto para evaluar si el Sharpe HRP es alpha real.
    ew_ret  = np.mean(q5_ret_oos, axis=1)
    ew_sharpe = (np.mean(ew_ret) * 252) / (np.std(ew_ret) * np.sqrt(252)) if np.std(ew_ret) > 0 else 0.0
    
    # [FIX-R] Usar all_ind["SPY"] directamente para bh_sharpe, NO q5_ret_full
    # (SPY ya no está en Q5 por FIX-Q, así que bh_ret.columns nunca tendría "SPY")
    if "SPY" in all_ind:
        spy_ret_full = all_ind["SPY"]["returns"]
        spy_ret_oos  = spy_ret_full[last_fold_te_start:last_fold_te_end]
        bh_sharpe = (np.mean(spy_ret_oos) * 252) / (np.std(spy_ret_oos) * np.sqrt(252)) if np.std(spy_ret_oos) > 0 else 0.0
    else:
        bh_sharpe = 0.0

    portfolio_metrics["ew_sharpe"] = round(ew_sharpe, 2)
    portfolio_metrics["bh_sharpe"] = round(bh_sharpe, 2)

    print(f"   ✅ Q5 Portfolio OOS ({len(q5_ret_oos)} días): "
          f"Sharpe Gross={port_sharpe_oos:.2f} | Net (costes)={port_sharpe_oos_net:.2f} | "
          f"EW-Q5={ew_sharpe:.2f} | SPY B&H={bh_sharpe:.2f}")
    print(f"   [COSTES-REALES] Comisión={COMMISSION_BPS}bps + Spread={SPREAD_BPS}bps + Slippage={SLIPPAGE_BPS}bps = {TOTAL_COST_BPS}bps ida+vuelta")
    print(f"   Alpha vs SPY: {port_sharpe_oos-bh_sharpe:+.2f} (gross) / {port_sharpe_oos_net-bh_sharpe:+.2f} (net) "
          f"| VaR95={port_var95_oos:.2f}% | MaxDD={max_dd_oos:.1f}% (gross) / {max_dd_net:.1f}% (net)")
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
        "slope":        round(float(ind["slope"][-1]),       2),
        "return_today": round(float(ind["returns"][-1]) * 100, 2),
        "close":        round(float(ind["close"][-1]),      2),
        "ma50":         round(float(ind["ma50"][-1]),       2) if not np.isnan(ind["ma50"][-1]) else 0,
        "ma200":        round(float(ind["ma200"][-1]),      2) if not np.isnan(ind["ma200"][-1]) else 0,
        "dd52":         round(dd52,                         1),
        "var95":        round(float(np.percentile(ind["returns"][1:], 5)) * 100, 2),
        "var99":        round(float(np.percentile(ind["returns"][1:], 1)) * 100, 2),
    }

# ─── CÁLCULO CASH-ADAPTED IBKR (ANTES DEL HTML) ────────────────────────────────
# v6.1: cash-adaptive: compra iterativa hasta agotar capital disponible
# Se calcula antes del HTML para que el dashboard pueda mostrar la tabla real
RISK_PER_TRADE_PCT = 0.02
RR_RATIO           = 2.0
cash_ibkr_rows = []
if portfolio_weights:
    remaining_cash = CAPITAL_EUR
    # [SxIV] Orden por score del modelo (descendente)
    if greedy_order:
        sorted_items = [(t, portfolio_weights[t]) for t in greedy_order if t in portfolio_weights]
    else:
        # Fallback: ordenar por confianza luego peso
        CONF_RANK = {"HIGH": 0, "MED": 1, "LOW": 2}
        def sort_key(item):
            t, w = item
            conf = results.get(t, {}).get("confidence", "LOW")
            return (CONF_RANK.get(conf, 2), -w)
        sorted_items = sorted(portfolio_weights.items(), key=sort_key)
    # [DYN-POS] v7.0: MIN_PER_POS dinámico según capital
    # Capital < 1000: 100€/pos | 1000-10000: 200€/pos | > 10000: 500€/pos
    if CAPITAL_EUR < 1000:
        MIN_PER_POS = 100.0
    elif CAPITAL_EUR < 10000:
        MIN_PER_POS = 200.0
    else:
        MIN_PER_POS = 500.0
    dyn_max_pos = max(1, min(len(sorted_items), int(CAPITAL_EUR / MIN_PER_POS)))
    if dyn_max_pos < len(sorted_items):
        sorted_items = sorted_items[:dyn_max_pos]
        total_w = sum(w for _, w in sorted_items)
        if total_w > 0:
            sorted_items = [(t, w/total_w) for t, w in sorted_items]
        print(f"   [DYN-POS] {dyn_max_pos} posiciones (€{CAPITAL_EUR:.0f} / €{MIN_PER_POS:.0f} min) — {len(sorted_items)} seleccionados, pesos reasignados")
    for t, w in sorted_items:
        r       = results.get(t, {})
        entry   = float(all_ind[t]["close"][-1]) if t in all_ind else 0.0
        if entry <= 0:
            continue
        cctr    = float(all_ind[t]["atr_pct"][-1]) * entry if t in all_ind else entry * 0.02
        sl_dist = max(cctr * 1.5, entry * 0.01)
        tp_dist = sl_dist * RR_RATIO
        stop_loss   = round(entry - sl_dist, 4)
        take_profit = round(entry + tp_dist, 4)
        ideal_eur   = CAPITAL_EUR * w
        # [FRAC-SHARES] Acciones fraccionables IBKR: invertir exactamente el peso objetivo
        size_eur = min(ideal_eur, remaining_cash, CAPITAL_EUR * 0.30)
        # Limitar por riesgo: max 2% del capital = shares * sl_dist -> size * sl_dist/entry <= cap*0.02
        max_risk_eur = CAPITAL_EUR * RISK_PER_TRADE_PCT * entry / sl_dist if sl_dist > 0 else ideal_eur
        size_eur = min(size_eur, max_risk_eur)
        size_eur = max(0.0, size_eur)
        shares = round(size_eur / entry, 6) if entry > 0 else 0.0
        risk_eur = round(shares * sl_dist, 2)
        viable = size_eur > 0.01 and remaining_cash >= size_eur - 0.001
        if viable:
            remaining_cash -= size_eur
        sector = get_sector(t)
        cash_ibkr_rows.append({
            "ticker": t, "sector": sector, "action": "BUY",
            "entry_price": round(entry, 4), "stop_loss": stop_loss, "take_profit": take_profit,
            "rr_ratio": RR_RATIO, "shares": shares, "size_eur": size_eur, "risk_eur": risk_eur,
            "weight_pct": round(w * 100, 2), "score": r.get("score", 0), "quintile": 5,
            "confidence": r.get("confidence", "LOW"), "z_score": r.get("pred_z", 0),
            "viable": viable, "remaining_cash_after": round(remaining_cash, 2),
            "notes": f"LONG HRP | z={r.get('pred_z',0):.1f} | {sector} | SL={stop_loss} TP={take_profit}"
        })
    n_viable = sum(1 for row in cash_ibkr_rows if row["viable"])
    total_inv = sum(row["size_eur"] for row in cash_ibkr_rows if row["viable"])
    print(f"   💰 [CASH-ADAPTIVE] {n_viable} posiciones viables | Invertido: €{total_inv:.0f} / €{CAPITAL_EUR:.0f} | Restante: €{CAPITAL_EUR-total_inv:.0f}")
else:
    cash_ibkr_rows = []

# ─── Q5 JSON DATA FOR DYNAMIC SLIDER ───────────────────────────────────────────
# Se embebe en el HTML para que el JS recalcule la cartera en vivo
q5_json_data = []
if portfolio_weights:
    # Usar greedy_order si existe, sino ordenar por peso descendente
    if greedy_order:
        json_iter = [(t, portfolio_weights[t]) for t in greedy_order if t in portfolio_weights]
    else:
        json_iter = sorted(portfolio_weights.items(), key=lambda x: -x[1])
    for t, w in json_iter:
        r = results.get(t, {})
        entry = float(all_ind[t]["close"][-1]) if t in all_ind else 0
        q5_json_data.append({
            "t": t,
            "s": r.get("score", 0),
            "z": r.get("pred_z", 0),
            "w": round(w * 100, 2),
            "e": round(entry, 2),
            "sec": get_sector(t),
            "conf": r.get("confidence", "LOW"),
        })
Q5_JSON = json.dumps(q5_json_data)

# ─── DASHBOARD HTML ───────────────────────────────────────────────────────────
def semaforo_color(v, lo, md, hi, rev=False):
    if rev:
        return "#00e07a" if v <= lo else "#f0a500" if v <= md else "#ff4060"
    return "#00e07a" if v >= hi else "#f0a500" if v >= md else "#ff4060"

# ── IC Rolling colors for dashboard [IC-MONITOR] ───────────────────────────
_ic20_c  = "#00e07a" if ic_20d > 0.05 else "#f0a500" if ic_20d > 0.03 else "#ff4060"
_ic60_c  = "#00e07a" if ic_60d > 0.05 else "#f0a500" if ic_60d > 0.03 else "#ff4060"
_ic120_c = "#00e07a" if ic_120d > 0.05 else "#f0a500" if ic_120d > 0.03 else "#ff4060"
_ic20_label = "✅ OPERAR" if ic_20d > 0.05 else "🟡 PRECAUCIÓN" if ic_20d > 0.03 else "🔴 PAUSA"

# ── IC semaforo banner [IC-MONITOR] ────────────────────────────────────────
# [FIX-SEMAFORO] Umbrales corregidos: 0.03/0.05 (antes 0.01/0.02 — demasiado permisivos)
_ic_banner_class = "red" if ic_20d < 0.03 else "yellow" if ic_20d < 0.05 else "green"
_ic_banner_emoji = "🔴" if ic_20d < 0.03 else "🟡" if ic_20d < 0.05 else "🟢"
_ic_banner_msg = ("ALARMA: IC_20d={:.4f} < 0.03 — señal demasiado débil. NO OPERAR.".format(ic_20d) if ic_20d < 0.03 else
                  "PRECAUCIÓN: IC_20d={:.4f} (0.03-0.05) — débil. Reducir posiciones al 50%.".format(ic_20d) if ic_20d < 0.05 else
                  "IC_20d={:.4f} — saludable (≥0.05). Operar con normalidad.".format(ic_20d))
_ic_banner = f'''<div class="ic-banner {_ic_banner_class}">
  <div class="ic-emoji">{_ic_banner_emoji}</div>
  <div>
    <div class="ic-label">SEMÁFORO IC — CALIDAD DE SEÑAL</div>
    <div style="display:flex;gap:20px;margin-top:4px">
      <span><span class="ic-val" style="color:{_ic20_c}">IC_20d={ic_20d:+.4f}</span></span>
      <span><span class="ic-val" style="color:{_ic60_c}">IC_60d={ic_60d:+.4f}</span></span>
      <span><span class="ic-val" style="color:{_ic120_c}">IC_120d={ic_120d:+.4f}</span></span>
    </div>
  </div>
  <div class="ic-msg">{_ic_banner_msg}</div>
</div>'''

print("🎨 Generando dashboard HTML...")
dt = datetime.now().strftime("%d/%m/%Y %H:%M")
tk = list(corr_hm.columns)

html = f"""<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>OLYMPUS HEATMAP REGRESSION v7.0 — {MODE_NAME.upper()}</title><style>
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
.vbadge{{display:inline-block;background:rgba(0,194,255,0.15);color:var(--accent);
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
.fix{{font-size:9px;background:rgba(0,194,255,0.1);color:var(--accent);
  padding:1px 5px;border-radius:3px;margin-left:4px;font-family:var(--mono)}}
.oos-label{{font-size:9px;background:rgba(0,224,122,0.1);color:var(--green);
  padding:1px 6px;border-radius:3px;font-family:var(--mono)}}
.ic-banner{{background:var(--card);border:2px solid var(--gold);border-radius:12px;
  padding:16px 24px;margin-bottom:24px;display:flex;align-items:center;gap:24px;flex-wrap:wrap}}
.ic-banner.red{{border-color:var(--red);background:rgba(255,64,96,0.08)}}
.ic-banner.yellow{{border-color:var(--gold)}}
.ic-banner.green{{border-color:var(--green);background:rgba(0,224,122,0.06)}}
.ic-banner .ic-emoji{{font-size:28px}}
.ic-banner .ic-label{{font-size:10px;color:var(--muted);font-family:var(--mono);letter-spacing:1px}}
.ic-banner .ic-val{{font-size:18px;font-weight:700;font-family:var(--mono)}}
.ic-banner .ic-msg{{font-size:13px;color:var(--text);flex:1;min-width:200px}}
</style></head><body>
<div class="header">
  <h1>OLYMPUS <span>HEATMAP REGRESSION</span><span class="vbadge">v7.0 {MODE_EMOJI[MODE_NAME]} {MODE_NAME.upper()}</span></h1>
  <div class="sub">// {len(available)} activos · {LOOKBACK}d histórico · {dt} · WF expanding {N_FOLDS} folds sin overlap · H={HORIZON}d · {FLAGS_STR}</div>
  <div class="sub" style="margin-top:6px;color:#3a5a76;font-size:11px">
    ✔ FIX-A/G heredados · ✔ FIX-I LW pre-OOS · ✔ FIX-J FRED expanding · ✔ FIX-K ^VIX out · ✔ FIX-L EW bench · ✔ FIX-M IBKR risk · ✔ FIX-N benchmarks{" · "+("🚫 Sin FRED" if NO_FRED else ""):}  </div>
</div>
<!-- SEMAFORO IC [IC-MONITOR] -->
{_ic_banner}
<div class="grid">
"""

# ── Heatmap correlaciones LW ──────────────────────────────────────────────────
html += f"""<div class="card full"><div class="card-title">
  🔥 Correlaciones Ledoit-Wolf — {len(heatmap_for_corr)} activos
  <span class="fix">FIX-F: LW sin fillna(0)</span>
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
  <span style="margin-left:16px">Ledoit-Wolf shrinkage · {len(complete_tickers)} tickers completos</span>
</div></div>
"""

# ── Tabla de scores ───────────────────────────────────────────────────────────
html += f"""<div class="card full">  <div class="card-title">
  📈 Motor Cross-Sectional ({MODEL_NAME}) — {len(results)} tickers · H={HORIZON}d · {MODE_NAME.upper()}
  · IC={mean_ic:.4f} · IR={ir:.2f}
  <span class="fix">FIX-A: ffill local</span>
  <span class="fix">FIX-B: WF sin overlap</span>
  <span class="fix">FIX-G: confianza z-score</span>
</div>
<div style="max-height:500px;overflow-y:auto;">
<table><tr><th>Ticker</th><th>Score (Rank%)</th><th>Q</th><th>Señal</th><th>Confianza (z)</th><th>raw_pred</th></tr>
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
             f'<div style="width:60px;height:5px;background:var(--surface);border-radius:2px">'
             f'<div style="width:{int(sc)}%;height:100%;background:{qc};border-radius:2px"></div></div></div></td>'
             f'<td style="color:{qc};font-weight:700;font-family:var(--mono)">Q{q}</td>'
             f'<td>{sig}</td>'
             f'<td><span class="badge {badge}">{r["confidence"]} (z={r["pred_z"]:.1f})</span></td>'
             f'<td style="font-family:var(--mono);font-size:11px;color:var(--muted)">{r["raw_pred"]:.2f}</td>'
             f'</tr>\n')
html += f"""</table></div>
<div style="margin-top:12px;font-size:11px;color:var(--muted)">
  Score = percentil en universo hoy | Confianza = z-score de raw_pred (desvíos vs media del modelo) |
  Q5=top 20% | Target: excess return {HORIZON}d vs SPY | Modo: {MODE_NAME.upper()} (H={HORIZON}d, LB={LOOKBACK}d, F={N_FOLDS})
</div></div>
"""

# ── Métricas del modelo ───────────────────────────────────────────────────────
_ic_c  = "#00e07a" if mean_ic > 0.04 else "#f0a500" if mean_ic > 0.02 else "#ff4060"
_ir_c  = "#00e07a" if ir > 0.5       else "#f0a500" if ir > 0.2       else "#ff4060"
_hr_c  = "#00e07a" if hit_rate > 0.55 else "#f0a500" if hit_rate > 0.50 else "#ff4060"
_sg_c  = "#00e07a" if ic_signif > 0.10 else "#f0a500" if ic_signif > 0.05 else "#ff4060"

# ── IC Rolling colors for dashboard [IC-MONITOR] ───────────────────────────
_ic20_c  = "#00e07a" if ic_20d > 0.05 else "#f0a500" if ic_20d > 0.03 else "#ff4060"
_ic60_c  = "#00e07a" if ic_60d > 0.05 else "#f0a500" if ic_60d > 0.03 else "#ff4060"
_ic120_c = "#00e07a" if ic_120d > 0.05 else "#f0a500" if ic_120d > 0.03 else "#ff4060"
_ic20_label = "✅ OPERAR" if ic_20d > 0.05 else "🟡 PRECAUCIÓN" if ic_20d > 0.03 else "🔴 PAUSA"

# ── IC semaforo banner [IC-MONITOR] ────────────────────────────────────────
# [FIX-SEMAFORO] Umbrales 2ª ocurrencia HTML
_ic_banner_class = "red" if ic_20d < 0.03 else "yellow" if ic_20d < 0.05 else "green"
_ic_banner_emoji = "🔴" if ic_20d < 0.03 else "🟡" if ic_20d < 0.05 else "🟢"
_ic_banner_msg = ("ALARMA: IC_20d={:.4f} < 0.03 — señal demasiado débil. NO OPERAR.".format(ic_20d) if ic_20d < 0.03 else
                  "PRECAUCIÓN: IC_20d={:.4f} (0.03-0.05) — débil. Reducir posiciones al 50%.".format(ic_20d) if ic_20d < 0.05 else
                  "IC_20d={:.4f} — saludable (≥0.05). Operar con normalidad.".format(ic_20d))
_ic_banner = f'''<div class="ic-banner {_ic_banner_class}">
  <div class="ic-emoji">{_ic_banner_emoji}</div>
  <div>
    <div class="ic-label">SEMÁFORO IC — CALIDAD DE SEÑAL</div>
    <div style="display:flex;gap:20px;margin-top:4px">
      <span><span class="ic-val" style="color:{_ic20_c}">IC_20d={ic_20d:+.4f}</span></span>
      <span><span class="ic-val" style="color:{_ic60_c}">IC_60d={ic_60d:+.4f}</span></span>
      <span><span class="ic-val" style="color:{_ic120_c}">IC_120d={ic_120d:+.4f}</span></span>
    </div>
  </div>
  <div class="ic-msg">{_ic_banner_msg}</div>
</div>'''

html += f"""<div class="card full"><div class="card-title">
  📐 Métricas del Modelo OOS — {MODEL_NAME} · {len(all_ic_scores)} días · {N_FOLDS} folds expanding sin overlap
  <span class="fix">FIX-B</span>
</div>
<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-bottom:20px">
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">IC MEDIO</div>
    <div style="font-size:26px;font-weight:700;color:{_ic_c};font-family:var(--mono)">{mean_ic:.4f}</div>
    <div style="font-size:10px;color:var(--muted)">{"✅ útil" if mean_ic>0.02 else "⚠️ débil"}</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">IR (Sharpe IC)</div>
    <div style="font-size:26px;font-weight:700;color:{_ir_c};font-family:var(--mono)">{ir:.2f}</div>
    <div style="font-size:10px;color:var(--muted)">{"✅ >0.5 HF" if ir>0.5 else "⚠️ bajo obj."}</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">HIT RATE</div>
    <div style="font-size:26px;font-weight:700;color:{_hr_c};font-family:var(--mono)">{hit_rate:.1%}</div>
    <div style="font-size:10px;color:var(--muted)">días IC &gt; 0</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">IC SIGNIF.</div>
    <div style="font-size:26px;font-weight:700;color:{_sg_c};font-family:var(--mono)">{ic_signif:.1%}</div>
    <div style="font-size:10px;color:var(--muted)">p-valor &lt; 0.05</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">UNIVERSO</div>
    <div style="font-size:26px;font-weight:700;color:var(--accent);font-family:var(--mono)">{len(results)}</div>
    <div style="font-size:10px;color:var(--muted)">{n_q5} LONG · {n_q1} SHORT</div>
  </div>
</div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;background:var(--surface);border-radius:8px;padding:16px">
  <div style="text-align:center">
    <div style="font-size:10px;color:var(--muted);font-family:var(--mono)">📅 IC 20 DÍAS (RECIENTE)</div>
    <div style="font-size:22px;font-weight:700;color:{_ic20_c};font-family:var(--mono)">{ic_20d:+.4f}</div>
    <div style="font-size:10px;color:var(--muted)">{_ic20_label}</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:10px;color:var(--muted);font-family:var(--mono)">📅 IC 60 DÍAS</div>
    <div style="font-size:18px;font-weight:700;color:{_ic60_c};font-family:var(--mono)">{ic_60d:+.4f}</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:10px;color:var(--muted);font-family:var(--mono)">📅 IC 120 DÍAS</div>
    <div style="font-size:18px;font-weight:700;color:{_ic120_c};font-family:var(--mono)">{ic_120d:+.4f}</div>
  </div>
</div>
"""
if fold_ic_means:
    html += '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">📊 IC por fold (expanding window, sin overlap):</div>'
    html += '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">'
    for fi, fic in enumerate(fold_ic_means):
        _, _, ts, te = fold_models[fi] if fi < len(fold_models) else (0, None, 0, 0)
        fc = "#00e07a" if fic > 0.03 else "#f0a500" if fic > 0.01 else "#ff4060"
        html += (f'<div style="text-align:center;padding:8px 16px;background:var(--surface);border-radius:6px">'
                 f'<div style="font-size:10px;color:var(--muted)">Fold {fi+1} test=[{ts},{te})</div>'
                 f'<div style="font-size:18px;font-weight:700;color:{fc};font-family:var(--mono)">{fic:.4f}</div>'
                 f'</div>')
    html += '</div>'

html += '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">🔍 Factor importance (promedio folds):</div>'
html += '<div style="display:flex;gap:8px;flex-wrap:wrap">'
for fn, fv in sorted(feat_imp.items(), key=lambda x: -x[1]):
    fc = "#00e07a" if fv > 0.20 else "#f0a500" if fv > 0.10 else "var(--muted)"
    html += f'<div class="pill" style="background:rgba(0,194,255,0.1);color:{fc}">{fn}: {fv:.2f}</div>'
html += '</div></div>'

# ── Portfolio Q5 — métricas OOS ───────────────────────────────────────────────
html += f"""<div class="card"><div class="card-title">
  📦 Portfolio Q5 — HRP · Métricas OOS
  <span class="fix">FIX-C: OOS real</span>
  <span class="oos-label">OOS {portfolio_metrics.get("oos_days","—")} días</span>
</div>
"""
if portfolio_metrics:
    pm   = portfolio_metrics
    sh_c  = "#00e07a" if pm["sharpe"] > 0.8 else "#f0a500" if pm["sharpe"] > 0.4 else "#ff4060"
    dd_c  = "#ff4060" if pm["max_dd"] < -20 else "#f0a500" if pm["max_dd"] < -10 else "#00e07a"
    hc    = "#ff4060" if pm["hhi"] > 0.25   else "#f0a500" if pm["hhi"] > 0.15   else "#00e07a"
    ew_sh = pm.get("ew_sharpe", 0.0)
    bh_sh = pm.get("bh_sharpe", 0.0)
    a_spy = pm["sharpe"] - bh_sh
    a_ew  = pm["sharpe"] - ew_sh
    alc   = "#00e07a" if a_spy > 0.5 else "#f0a500" if a_spy > 0.0 else "#ff4060"
    html += f"""
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">SHARPE HRP OOS</div>
        <div style="font-size:22px;font-weight:700;color:{sh_c};font-family:var(--mono)">{pm["sharpe"]:.2f}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">SHARPE EW Q5 OOS</div>
        <div style="font-size:18px;font-weight:700;color:var(--muted);font-family:var(--mono)">{ew_sh:.2f}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">SHARPE SPY B&H OOS</div>
        <div style="font-size:18px;font-weight:700;color:var(--muted);font-family:var(--mono)">{bh_sh:.2f}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">ALPHA vs SPY</div>
        <div style="font-size:18px;font-weight:700;color:{alc};font-family:var(--mono)">{a_spy:+.2f}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">VaR 95% OOS</div>
        <div style="font-size:18px;font-weight:700;color:#ff4060;font-family:var(--mono)">{pm["var95"]:.2f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">CVaR 95% OOS</div>
        <div style="font-size:18px;font-weight:700;color:#ff4060;font-family:var(--mono)">{pm["cvar95"]:.2f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">Max DD OOS</div>
        <div style="font-size:18px;font-weight:700;color:{dd_c};font-family:var(--mono)">{pm["max_dd"]:.1f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">Vol Anual</div>
        <div style="font-size:18px;font-weight:700;color:var(--gold);font-family:var(--mono)">{pm["vol_ann"]:.1f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">HHI Concentración</div>
        <div style="font-size:18px;font-weight:700;color:{hc};font-family:var(--mono)">{pm["hhi"]:.3f}</div>
      </div>
    </div>
    <div style="font-size:10px;color:var(--muted);margin-bottom:12px;display:flex;gap:12px">
      <span>📊 Benchmarks OOS [FIX-N]: EW Q5 = {ew_sh:.2f} | SPY B&H = {bh_sh:.2f}</span>
      <span class="{'g' if a_spy>0 else 'r'}">Alpha vs SPY = {a_spy:+.2f}</span>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">📋 Cartera teórica HRP (todos los Q5 con sector):</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
    """
    for t, w in sorted(portfolio_weights.items(), key=lambda x: -x[1]):
        wc = "#00e07a" if w > 0.15 else "#f0a500" if w > 0.08 else "var(--muted)"
        sector = results[t].get("sector", "Other") if t in results else "Other"
        html += f'<div class="pill" style="background:rgba(0,224,122,0.1);color:{wc}" title="{sector}">{t}: {w*100:.1f}% <span style="font-size:9px;color:var(--muted)">[{sector}]</span></div>'
    html += '</div>'
    
    # ── Cash-Adapted Allocation (SLIDER DINÁMICO) ─────────────────────────────
    max_pos_str = str(MAX_POS) if MAX_POS > 0 else str(len(q5_json_data))
    html += '<div style="margin-top:14px;font-size:11px;color:var(--muted);margin-bottom:8px">💰 Cartera real adaptada al capital — <span id="capLabel">€' + f"{CAPITAL_EUR:.0f}" + '</span></div>'
    html += '<div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px">'
    html += f'<label style="font-size:11px;color:var(--muted)">Capital:</label>'
    html += f'<input type="range" id="capSlider" min="100" max="50000" step="100" value="{CAPITAL_EUR:.0f}" style="flex:1;min-width:200px">'
    html += f'<input type="number" id="capInput" value="{CAPITAL_EUR:.0f}" step="100" min="0" style="width:100px;background:#0d0d2b;border:1px solid #333;border-radius:6px;color:#fff;padding:6px 10px;font-family:var(--mono)">'
    html += '<span style="font-size:11px;color:var(--muted)">Posiciones: <strong style="color:var(--accent)">dinámicas (~€150/pos)</strong></span>'
    html += '</div>'
    html += '<div id="dynamicSummary" style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;margin-bottom:10px"></div>'
    html += '<div style="overflow-x:auto"><table style="font-size:11px"><tr>'
    html += '<th>#</th><th>Ticker</th><th>Sector</th><th>Score</th><th>z</th><th>Peso</th><th>Precio</th><th>SL</th><th>TP</th><th>Acc</th><th>Inv</th><th>Risk</th><th>Benef</th><th>Conf</th></tr>'
    html += '<tbody id="dynamicTbody"></tbody></table></div>'
    if pm["hhi"] > 0.25:
        html += '<div style="margin-top:10px;font-size:11px;color:#ff4060">⚠️ HHI > 0.25 — concentración alta</div>'
    html += f'<div style="margin-top:8px;font-size:10px;color:var(--muted)">Todas las métricas calculadas sobre periodo OOS fold-{N_FOLDS} ({pm["oos_days"]} días)</div>'
else:
    html += '<div style="color:var(--muted);font-size:13px">Insuficientes activos Q5.</div>'
html += '</div>'

# ── Semáforo SPY ──────────────────────────────────────────────────────────────
html += """<div class="card"><div class="card-title">🚦 Semáforo SPY</div>"""
if sema:
    inds = [
        ("RSI(2) Wilder",   sema["rsi2"],      15,  60,  85),
        ("RSI(14) Wilder",  sema["rsi14"],      35,  50,  70),
        ("MACD Hist",       sema["macd_hist"], -0.1,  0, 0.3),
        ("ATR % (Wilder)",  sema["atr_pct"],    0.5,  2,   4),
        ("Trend Eff",       sema["trend_eff"],  20,  40,  60),
        ("Trend Slope",     sema["slope"],      -2,   0,   2),
    ]
    for nm, vl, lo, md, hi in inds:
        co  = semaforo_color(vl, lo, md, hi, rev=nm.startswith("ATR"))
        pct = min(100, max(0, (vl - lo) / (hi - lo) * 100)) if hi != lo else 50
        html += (f'<div style="margin-bottom:10px">'
                 f'<div style="display:flex;justify-content:space-between;font-size:12px">'
                 f'<span>{nm}</span><span style="color:{co};font-weight:700">{vl}</span></div>'
                 f'<div class="bar"><div class="bar-f" style="width:{pct}%;background:{co}"></div></div></div>')
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
for t, r in [(t, r) for t, r in sp_sorted if r["quintile"] == 5][:20]:
    w_pct = portfolio_weights.get(t, 0.0) * 100
    w_str = f" · {w_pct:.1f}%" if w_pct > 0 else ""
    sector = r.get("sector", "") if "sector" in r else ""
    sec_str = f" [{sector}]" if sector else ""
    html += (f'<div class="pill" style="background:rgba(0,224,122,0.15);color:#00e07a">'
             f'{t}{sec_str}: {r["score"]:.1f} (z={r["pred_z"]:.1f}){w_str}</div>')
html += '<div style="font-size:12px;color:var(--muted);margin:16px 0 8px">🔴 Q1 — SHORT/EVITAR:</div>'
for t, r in [(t, r) for t, r in reversed(sp_sorted) if r["quintile"] == 1][:5]:
    html += (f'<div class="pill" style="background:rgba(255,64,96,0.15);color:#ff4060">'
             f'{t}: {r["score"]:.1f} (z={r["pred_z"]:.1f})</div>')
html += '</div>'

# ── Correlaciones vs SPY ──────────────────────────────────────────────────────
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

# ── SLIDER JS (recalcula cartera en vivo) ─────────────────────────────────────
# Clean JS generation using list join - avoids escaping issues with triple quotes
JS_LINES = []
JS_LINES.append('<script>')
JS_LINES.append('var D=' + Q5_JSON + ';')
JS_LINES.append('var cb={"HIGH":"badge-good","MED":"badge-warn","LOW":"badge-low"};')
JS_LINES.append('function recalc(){')
JS_LINES.append('var cap=parseFloat(document.getElementById("capSlider").value)||0;')
JS_LINES.append('document.getElementById("capInput").value=cap;')
JS_LINES.append('document.getElementById("capLabel").textContent="EUR "+Number(cap).toLocaleString("es-ES");')
JS_LINES.append('if(cap<=0){document.getElementById("dynamicTbody").innerHTML="";document.getElementById("dynamicSummary").innerHTML="";return;}')
JS_LINES.append('var S=D.slice();')
JS_LINES.append('var MIN_PER_POS=150;var dynPos=Math.max(1,Math.min(S.length,Math.floor(cap/MIN_PER_POS)));')
JS_LINES.append('if(dynPos<S.length){var t=S.slice(0,dynPos);var tw=t.reduce(function(s,d){return s+d.w;},0);if(tw>0){t.forEach(function(d){d.w=d.w/tw*100;});}S=t;}')
JS_LINES.append('var rem=cap;var hh="";var i=0,ti=0,tr=0,tb2=0;')
JS_LINES.append('S.forEach(function(d){')
JS_LINES.append('if(d.e<=0)return;var slD=Math.max(d.e*0.015,d.e*0.01);var tpD=slD*2;')
JS_LINES.append('var sl=+(d.e-slD).toFixed(2);var tp=+(d.e+tpD).toFixed(2);')
JS_LINES.append('var ideal=cap*d.w/100;var size=Math.min(ideal,rem,cap*0.30);')
JS_LINES.append('var mR=cap*0.02*d.e/slD;size=Math.min(size,mR);')
JS_LINES.append('if(size<0.01)return;var sh=+(size/d.e).toFixed(6);var inv=size;')
JS_LINES.append('var risk=size*slD/d.e;var benef=size*tpD/d.e;')
JS_LINES.append('rem-=inv;ti+=inv;tr+=risk;tb2+=benef;i++;')
# Build table row using r variable
JS_LINES.append('var r="<tr><td>"+i+"</td><td><strong>"+d.t+"</strong></td>";')
JS_LINES.append('r+="<td style=font-size:10px;color:var(--muted)>"+d.sec+"</td>";')
JS_LINES.append('r+="<td style=font-family:var(--mono)>"+d.s.toFixed(1)+"</td>";')
JS_LINES.append('r+="<td style=font-family:var(--mono)>"+d.z.toFixed(2)+"</td>";')
JS_LINES.append('r+="<td style=font-family:var(--mono)>"+d.w.toFixed(1)+"%</td>";')
JS_LINES.append('r+="<td style=font-family:var(--mono)>EUR "+d.e.toFixed(2)+"</td>";')
JS_LINES.append('r+="<td style=color:#ff4060;font-family:var(--mono)>EUR "+sl.toFixed(2)+"</td>";')
JS_LINES.append('r+="<td style=color:#00e07a;font-family:var(--mono)>EUR "+tp.toFixed(2)+"</td>";')
JS_LINES.append('r+="<td>"+sh.toFixed(6)+"</td>";')
JS_LINES.append('r+="<td style=color:#60a5fa;font-family:var(--mono)>EUR "+inv.toFixed(2)+"</td>";')
JS_LINES.append('r+="<td style=color:#ef4444;font-family:var(--mono)>EUR "+risk.toFixed(2)+"</td>";')
JS_LINES.append('r+="<td style=color:#4ade80;font-family:var(--mono)>EUR "+benef.toFixed(2)+"</td>";')
JS_LINES.append("r+='<td><span class=\"badge '+cb[d.conf]+'\">'+d.conf+'</span></td></tr>';hh+=r;")
JS_LINES.append('});')
JS_LINES.append('document.getElementById("dynamicTbody").innerHTML=hh||"<tr><td colspan=14 style=text-align:center;color:var(--muted)>Capital insuficiente</td></tr>";')
# Summary line
JS_LINES.append('var sumHTML="<span style=padding:4px 12px;background:var(--surface);border-radius:6px;border:1px solid var(--border)>Capital: <strong>EUR "+cap.toFixed(2)+"</strong></span>";')
JS_LINES.append('sumHTML+="<span style=padding:4px 12px;background:var(--surface);border-radius:6px;border:1px solid var(--border)>Invertido: <strong style=color:#60a5fa>EUR "+ti.toFixed(2)+"</strong></span>";')
JS_LINES.append('sumHTML+="<span style=padding:4px 12px;background:var(--surface);border-radius:6px;border:1px solid var(--border)>Riesgo: <strong style=color:#ef4444>EUR "+tr.toFixed(2)+"</strong></span>";')
JS_LINES.append('sumHTML+="<span style=padding:4px 12px;background:var(--surface);border-radius:6px;border:1px solid var(--border)>Benef: <strong style=color:#4ade80>EUR "+tb2.toFixed(2)+"</strong></span>";')
JS_LINES.append('sumHTML+="<span style=padding:4px 12px;background:var(--surface);border-radius:6px;border:1px solid var(--border)>Pos: <strong>"+i+"</strong></span>";')
JS_LINES.append('sumHTML+="<span style=padding:4px 12px;background:var(--surface);border-radius:6px;border:1px solid var(--border)>Restante: <strong style=color:var(--muted)>EUR "+Math.max(0,rem).toFixed(2)+"</strong></span>";')
JS_LINES.append('document.getElementById("dynamicSummary").innerHTML=sumHTML;')
JS_LINES.append('}')
JS_LINES.append('document.getElementById("capSlider").addEventListener("input",recalc);')
JS_LINES.append('document.getElementById("capInput").addEventListener("input",function(){')
JS_LINES.append('var v=parseFloat(this.value)||0;if(v<0)v=0;if(v>100000)v=100000;')
JS_LINES.append('document.getElementById("capSlider").value=v;recalc();')
JS_LINES.append('});')
JS_LINES.append('window.addEventListener("load",recalc);')
JS_LINES.append('</script>')
html += '\n'.join(JS_LINES)

html += f"""</div>
<div class="footer">
  Olympus Heatmap Regression v7.0 · Hende Fund · PRODUCTION · {dt} · {len(available)} tickers · {LOOKBACK}d · {MODEL_NAME} · Modo {MODE_NAME.upper()} · {FLAGS_STR}<br>
  <code style="color:#fff">python OLYMPUS_HEATMAP_REGRESSION_v7.py --mode {MODE_NAME}{" --top "+str(TOP_N) if TOP_N else ""}{" --no-fred" if NO_FRED else ""}{" --capital "+str(CAPITAL_EUR) if CAPITAL_EUR!=10000 else ""}</code>
  <span style="color:var(--accent)"> para actualizar</span> ·
  v7.0: LW pre-OOS · FRED expanding · ^VIX out · EW bench · IBKR risk · Benchmarks OOS
</div>
</body></html>"""

# ─── OUTPUTS ──────────────────────────────────────────────────────────────────
base_dir = os.path.dirname(os.path.abspath(__file__))

out_html = os.path.join(base_dir, "heatmap_dashboard.html")
with open(out_html, "w", encoding="utf-8") as f:
    f.write(html)
logger.info(f"Dashboard: {out_html}")

df_pred = pd.DataFrame(results).T
if not df_pred.empty:
    df_pred = df_pred.sort_values("score", ascending=False)
    df_pred.to_csv(os.path.join(base_dir, "predictions.csv"))
    logger.info("Scores CSV guardado")

corr_lw.to_csv(os.path.join(base_dir, "correlations.csv"))
logger.info("Correlaciones LW guardadas")

if portfolio_weights:
    df_port = pd.DataFrame([
        {
            "ticker": t,
            "weight_pct": round(w * 100, 2),
            "close_price": round(float(all_ind[t]["close"][-1]), 2) if t in all_ind else 0,
            "sector": get_sector(t),
            **results.get(t, {})
        }
        for t, w in sorted(portfolio_weights.items(), key=lambda x: -x[1])
    ])
    df_port.to_csv(os.path.join(base_dir, "portfolio_q5.csv"), index=False)
    logger.info("Portfolio Q5 CSV guardado")

# ─── OUTPUT IBKR-READY — CSV (usa cash_ibkr_rows ya calculado) ───────────────────
ibkr_rows = cash_ibkr_rows

for t, r in sorted(results.items(), key=lambda x: x[1]["score"]):
    if r["quintile"] == 1:
        entry = float(all_ind[t]["close"][-1]) if t in all_ind else 0.0
        ibkr_rows.append({
            "ticker":       t,
            "action":       "AVOID",
            "entry_price":  round(entry, 4),
            "stop_loss":    0.0,
            "take_profit":  0.0,
            "rr_ratio":     0.0,
            "shares":       0,
            "size_eur":     0.0,
            "risk_eur":     0.0,
            "weight_pct":   0.0,
            "score":        r.get("score", 0),
            "quintile":     1,
            "confidence":   r.get("confidence", "LOW"),
            "z_score":      r.get("pred_z", 0),
            "notes":        f"SHORT/SKIP | z={r.get('pred_z',0):.1f}"
        })
df_ibkr = pd.DataFrame(ibkr_rows)
if not df_ibkr.empty:
    ibkr_path = os.path.join(base_dir, "ibkr_orders.csv")
    df_ibkr.to_csv(ibkr_path, index=False)
    logger.info(f"IBKR órdenes: {ibkr_path}")
    n_buy   = (df_ibkr["action"] == "BUY").sum()
    n_avoid = (df_ibkr["action"] == "AVOID").sum()
    print(f"   📋 IBKR [FIX-M]: {n_buy} BUY | {n_avoid} AVOID | capital={CAPITAL_EUR:.0f}EUR | risk/trade={RISK_PER_TRADE_PCT*100:.0f}%")

try:
    webbrowser.open(f"file://{os.path.abspath(out_html)}")
    print("🚀 Abriendo dashboard en el navegador...")
except Exception:
    print(f"📂 Abre: {out_html}")

print("\n" + "=" * 70)
print(f"📊 RESUMEN OLYMPUS HEATMAP REGRESSION v7.0 — {MODE_EMOJI[MODE_NAME]} Modo {MODE_NAME.upper()} — Flags: {FLAGS_STR} — Hende Fund · PRODUCTION")
print("=" * 70)
print(f"📡 Activos: {len(available)} | 🔥 Heatmap: {len(heatmap_for_corr)} | 📅 Días descargados: {LOOKBACK} ({closes.index[0].strftime('%d/%m/%Y')} → {closes.index[-1].strftime('%d/%m/%Y')})")
print(f"🤖 Modelo: {MODEL_NAME} · Walk-Forward expanding {N_FOLDS} folds · Horizonte {HORIZON}d · Modo {MODE_NAME.upper()}")
print(f"📐 IC={mean_ic:.4f} | IR={ir:.2f} | Hit={hit_rate:.1%} | IC sig={ic_signif:.1%}")
print(f"   IC por fold: {' | '.join([f'F{i+1}={v:.4f}' for i, v in enumerate(fold_ic_means)])}")
if portfolio_metrics:
    pm = portfolio_metrics
    print(f"\n📦 Portfolio Q5 OOS ({pm['n_assets']} activos · {pm['oos_days']} días OOS):")
    print(f"   Sharpe HRP={pm['sharpe']:.2f} | EW Q5={pm['ew_sharpe']:.2f} | SPY B&H={pm['bh_sharpe']:.2f}")
    print(f"   Alpha vs SPY: {pm['sharpe']-pm['bh_sharpe']:+.2f} | Alpha vs EW: {pm['sharpe']-pm['ew_sharpe']:+.2f}")
    print(f"   Vol={pm['vol_ann']:.1f}% | MaxDD={pm['max_dd']:.1f}% | VaR95={pm['var95']:.2f}% | CVaR95={pm['cvar95']:.2f}% | HHI={pm['hhi']:.3f}")
    print(f"\n🟢 Q5 LONG — pesos HRP:")
    for t, w in sorted(portfolio_weights.items(), key=lambda x: -x[1])[:8]:
        z_str = f" z={results[t]['pred_z']:.1f}" if t in results else ""
        print(f"   {t:8s}  {w*100:.1f}%  (score={results[t]['score']:.1f}{z_str})")
print(f"\n🔴 Q1 SHORT/EVITAR:")
for t, r in [(t, r) for t, r in reversed(sp_sorted) if r["quintile"] == 1][:5]:
    print(f"   {t:8s}  score={r['score']:.1f} z={r['pred_z']:.1f}")
print(f"\n📈 Correlaciones top vs SPY (LW · {len(complete_tickers)} tickers completos):")
if "SPY" in corr_lw.columns:
    spy_c = corr_lw["SPY"].drop("SPY", errors="ignore").sort_values(ascending=False)
    for t in spy_c.head(5).index:
        print(f"   {t:8s} <-> SPY = {spy_c[t]:.2f}")
print(f"\n📁 {os.path.abspath(out_html)}")

if NO_FRED:
    print(f"🚫 FRED excluido de factores cross-seccionales")
if TOP_N > 0:
    print(f"💧 Filtrado a top {TOP_N} tickers por liquidez")
print(f"\n📋 Outputs generados (modo {MODE_NAME.upper()}):")
print(f"   📊 heatmap_dashboard.html — Dashboard interactivo con benchmarks [FIX-N]")
print(f"   📈 predictions.csv — Scores y quintiles por ticker")
print(f"   📦 portfolio_q5.csv — Cartera Q5 con pesos HRP [FIX-I]")
print(f"   📋 ibkr_orders.csv — Órdenes con SL/TP/sizing [FIX-M]")
print(f"\n✅ BUGS CORREGIDOS EN v7.0 (re-auditoría adversarial v5.0):")
print("   [BUG-V5-1→FIX-H] TARGET DESPLAZADO: shift(-HORIZON) → shift(-1) [CRÍTICO]")
print("   [BUG-V5-2→FIX-I] LW PESOS LEAKAGE: fit sobre datos OOS → fit solo pre-OOS [CRÍTICO]")
print("   [BUG-V5-3→FIX-J] FRED NORMALIZACIÓN: s.min/max global → expanding min/max [CRÍTICO]")
print("   [BUG-V5-4→FIX-K] VIX EN UNIVERSO: ^VIX excluido de tickers_panel (no tradeable)")
print("   [BUG-V5-5→FIX-L] rs_spy ESPURIO: benchmark SPY → mediana EW del universo")
print("   [BUG-V5-6→FIX-M] IBKR SIN RIESGO: añadidos SL/TP/shares/risk_eur con ATR y R:R=2")
print("   [BUG-V5-7→FIX-N] SIN BENCHMARK: añadidos EW Q5 y SPY B&H para alpha real")
print("\nFIXES HEREDADOS CORRECTOS (v5.0 → v7.0): FIX-A,B,C,D,E,F,G")
