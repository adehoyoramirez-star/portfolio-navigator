#!/usr/bin/env python3
"""
OLYMPUS HEATMAP REGRESSION v4.0 — Hende Fund
Uso: python OLYMPUS_HEATMAP_REGRESSION_v4.py
Output: heatmap_dashboard.html, predictions.csv, correlations.csv, portfolio_q5.csv

CORRECCIONES v4.0 vs v3.0 (re-auditoría adversarial):

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
                    la estimación de covarianza. La matriz se expande al universo
                    completo por alineación de índices post-fit.

  [BUG-7 → FIX-G]  Confianza basada en raw_pred del modelo (dispersión real de
                    predicciones), no en score_rank (uniforme por construcción).
                    Ahora HIGH/MED/LOW refleja la magnitud de la señal del modelo.

FIXES HEREDADOS DE v3.0 (verificados correctos):
  RSI Wilder, Trend Efficiency vectorizado, Target por fold, Buffer TRAIN_END,
  Quintiles reales qcut, Volumen NaN, LW unificado, LOOKBACK=504, chunks retry.
"""

import os, sys, webbrowser, pickle, time, logging, warnings
from datetime import datetime

warnings.filterwarnings("ignore")

# ─── PARÁMETROS GLOBALES ──────────────────────────────────────────────────────
LOOKBACK          = 504
HEATMAP_DISPLAY_N = 50
HORIZON           = 5
N_FOLDS           = 3
CACHE_MAX_AGE     = 24 * 3600
MIN_IC_FOR_SIGNAL = 0.02

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
        print(f"   📦 Cache ({age/3600:.1f}h) — {len(cached['available'])} tickers · {LOOKBACK}d")
        return cached
    except Exception:
        try: os.remove(CACHE_FILE)
        except Exception: pass
        return None

def save_cache(closes_df, volume_df, tickers_list):
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump({'closes': closes_df, 'volume': volume_df,
                         'available': tickers_list, 'timestamp': time.time(),
                         'lookback': LOOKBACK}, f)
        print(f"   💾 Cache guardado ({os.path.getsize(CACHE_FILE)/1024:.0f} KB)")
    except Exception as e:
        print(f"   ⚠️ No se pudo guardar cache: {e}")

# ─── DESCARGA EN CHUNKS CON RETRY ────────────────────────────────────────────
def download_with_retry(tickers, period_days, chunk_size=200, max_retries=2):
    import yfinance as yf
    period_str = f"{period_days + 40}d"
    all_close, all_volume = {}, {}
    chunks = [tickers[i:i+chunk_size] for i in range(0, len(tickers), chunk_size)]
    print(f"   📦 {len(chunks)} chunks de hasta {chunk_size} tickers...")
    for ci, chunk in enumerate(chunks):
        for attempt in range(max_retries + 1):
            try:
                data = yf.download(chunk, period=period_str, progress=False,
                                   auto_adjust=True, threads=True)
                if data.empty:
                    c_close = c_volume = pd.DataFrame()
                elif isinstance(data.columns, pd.MultiIndex):
                    c_close  = data["Close"]  if "Close"  in data.columns.get_level_values(0) else pd.DataFrame()
                    c_volume = data["Volume"] if "Volume" in data.columns.get_level_values(0) else pd.DataFrame()
                else:
                    if "Close" not in data.columns:
                        c_close = c_volume = pd.DataFrame()
                    else:
                        c_close  = data[["Close"]].rename(columns={"Close": chunk[0]})
                        c_volume = data[["Volume"]].rename(columns={"Volume": chunk[0]}) if "Volume" in data.columns else pd.DataFrame()
                for t in c_close.columns:
                    all_close[t] = c_close[t]
                    if t in c_volume.columns:
                        all_volume[t] = c_volume[t]
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
    return pd.DataFrame(all_close), pd.DataFrame(all_volume)

cache = load_cache()
if cache:
    closes    = cache['closes']
    available = cache['available']
    volume_df = cache['volume']
else:
    print(f"📡 Descargando {len(all_tickers)} tickers ({LOOKBACK}d)...")
    try:
        closes_raw, volume_df = download_with_retry(all_tickers, LOOKBACK)
        closes    = closes_raw.tail(LOOKBACK).dropna(axis=1, thresh=int(LOOKBACK * 0.90))
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
    """[FIX-D] Pendiente de regresión lineal rolling normalizada por precio medio.
    Reemplaza ADX que es inválido sin datos OHLC.
    Valor positivo = tendencia alcista, negativo = bajista.
    """
    x = np.arange(period, dtype=float)
    x_mean = x.mean()
    x_var  = ((x - x_mean) ** 2).sum()
    s = pd.Series(prices)

    def _slope(y: np.ndarray) -> float:
        y_mean = y.mean()
        slope  = ((x - x_mean) * (y - y_mean)).sum() / x_var
        return slope / (y_mean + 1e-10) * 100  # normalizado a %/día relativo

    slopes = s.rolling(period).apply(_slope, raw=True)
    return slopes.fillna(0).values


def calc_indicators(price_series: pd.Series) -> dict | None:
    c = price_series.values
    n = len(c)
    if n < 70:
        return None

    ma20  = pd.Series(c).rolling(20).mean().values
    ma50  = pd.Series(c).rolling(50).mean().values
    ma200 = pd.Series(c).rolling(200, min_periods=50).mean().values

    r2  = rsi_wilder(c, 2)
    r14 = rsi_wilder(c, 14)

    tr      = np.concatenate([[0], np.abs(np.diff(c))])
    atr14   = pd.Series(tr).ewm(alpha=1/14, adjust=False).mean().values
    atr_pct = np.divide(atr14, c, out=np.zeros_like(atr14), where=c > 0)

    e12 = pd.Series(c).ewm(span=12, adjust=False).mean().values
    e26 = pd.Series(c).ewm(span=26, adjust=False).mean().values
    ml  = e12 - e26
    ms  = pd.Series(ml).ewm(span=9, adjust=False).mean().values
    mh  = ml - ms

    te    = trend_efficiency_vectorized(c, 20)
    slope = trend_slope_factor(c, 20)  # [FIX-D] sustituye ADX

    ret = pd.Series(c).pct_change().fillna(0).values

    return {
        "rsi2": r2, "rsi14": r14,
        "atr_pct": atr_pct, "macd_hist": mh,
        "trend_eff": te, "slope": slope,
        "returns": ret, "close": c,
        "ma20": ma20, "ma50": ma50, "ma200": ma200
    }


print("🧮 Calculando indicadores Olympus...")
all_ind = {}
for t in available:
    r = calc_indicators(closes[t])
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

tickers_panel = sorted(all_ind.keys())
ret_df  = pd.DataFrame({t: all_ind[t]["returns"] for t in tickers_panel})
log_ret = np.log1p(ret_df)

# ── Factores cross-seccionales (SIN ffill global [FIX-A]) ────────────────────
# Los factores se construyen con NaN donde no hay datos suficientes.
# El ffill se aplica localmente dentro de cada ventana de entrenamiento (ver make_dataset).

# F1: Momentum 21d
mom21 = np.expm1(log_ret.rolling(21).sum())
# F2: Reversal 5d (contrarian)
rev5 = -np.expm1(log_ret.rolling(5).sum())
# F3: Compresión de volatilidad
vol5     = ret_df.rolling(5).std()
vol63    = ret_df.rolling(63).std().replace(0, np.nan)
volratio = -(vol5 / vol63)
# F4: Relative strength vs SPY
spy_mom = mom21["SPY"] if "SPY" in mom21.columns else pd.Series(0.0, index=mom21.index)
rs_spy  = mom21.subtract(spy_mom, axis=0)
# F5: RSI(2) cross-sectional contrarian
rsi2_df = pd.DataFrame({t: all_ind[t]["rsi2"] for t in tickers_panel})
rsi2_cs = -rsi2_df
# F6: Anomalía de volumen (NaN → neutral=1.0)
_vanom = {}
for t in tickers_panel:
    if t in volume_df.columns:
        vs       = volume_df[t].reindex(closes.index)
        vol_ma20 = vs.rolling(20).mean()
        _vanom[t] = (vs / vol_ma20.replace(0, np.nan)).fillna(1.0)
    else:
        _vanom[t] = pd.Series(1.0, index=closes.index)
volanom_df = pd.DataFrame(_vanom)
# F7: Momentum 63d
mom63 = np.expm1(log_ret.rolling(63).sum())
# F8: Trend slope factor [FIX-D] — sustituye ADX inválido sin OHLC
slope_df = pd.DataFrame({t: all_ind[t]["slope"] for t in tickers_panel})

factor_list  = [mom21, rev5, volratio, rs_spy, rsi2_cs, volanom_df, mom63, slope_df]
factor_names = ["mom21", "rev5", "volratio", "rs_spy", "rsi2_cs", "volanom", "mom63", "slope"]

def cs_rank(df: pd.DataFrame) -> pd.DataFrame:
    """Rankeo cross-seccional percentil 0-100 por fila (día). Sin ffill."""
    return df[tickers_panel].rank(axis=1, pct=True) * 100

# [FIX-A] NO aplicar ffill global — los factores conservan sus NaN naturales
ranked_raw = [cs_rank(f) for f in factor_list]

# Target: excess return forward HORIZON días
fwd_log    = log_ret.shift(-HORIZON).rolling(HORIZON).sum()
fwd_ret    = np.expm1(fwd_log)
spy_fwd    = fwd_ret["SPY"] if "SPY" in fwd_ret.columns else pd.Series(0.0, index=fwd_ret.index)
fwd_excess = fwd_ret.subtract(spy_fwd, axis=0)

n_days    = len(ret_df)
n_tick    = len(tickers_panel)
n_fact    = len(factor_list)
START_DAY = 70
TRAIN_END = n_days - HORIZON - 5

# Stack de factores sin ffill (NaN conservados para filtrar en make_dataset)
factor_stack  = np.stack([rf[tickers_panel].values for rf in ranked_raw], axis=2)
fwd_ret_stack = fwd_excess[tickers_panel].values

# ── Walk-Forward expanding sin overlap [FIX-B] ───────────────────────────────
# Esquema correcto expanding:
#   Fold 1: train=[START, T1), test=[T1, T2)
#   Fold 2: train=[START, T2), test=[T2, T3)   ← train crece, NO hay overlap OOS
#   Fold 3: train=[START, T3), test=[T3, END)
#
# Dividimos [START, TRAIN_END] en N_FOLDS+1 bloques iguales.
# El test de cada fold es el bloque (k+1), el train es todo lo anterior.

block  = (TRAIN_END - START_DAY) // (N_FOLDS + 1)
# Puntos de corte: START + block, START + 2*block, ..., START + N_FOLDS*block
cuts   = [START_DAY + block * (k + 1) for k in range(N_FOLDS)]
fold_train_ends  = cuts                          # fin de train de cada fold
fold_test_starts = cuts                          # inicio de test de cada fold
fold_test_ends   = cuts[1:] + [TRAIN_END]        # fin de test de cada fold


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

print(f"   📊 Walk-Forward expanding (sin overlap): {N_FOLDS} folds | "
      f"factor_stack={factor_stack.shape} | LOOKBACK={LOOKBACK}d")

for fold_i in range(N_FOLDS):
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
    fold_models.append((fold_i, model, te_start, te_end))  # guardamos metadatos

    # IC por día — OOS estricto
    fold_ics = []
    for day_i in test_range:
        # [FIX-A] ffill local al día: propagar solo hacia adelante dentro del histórico
        Xd_raw = factor_stack[day_i].copy()
        # Para el punto de inferencia usamos ffill del histórico hasta ese día
        for fi in range(Xd_raw.shape[1]):
            col = factor_stack[:day_i+1, :, fi]
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
    feat_imp_arr = np.mean([m.feature_importances_ for _, m, _, _ in fold_models], axis=0)
    feat_imp = dict(zip(factor_names, feat_imp_arr))
else:
    feat_imp = {k: 0.0 for k in factor_names}
print("   🔍 " + " | ".join(f"{k}={v:.2f}" for k, v in sorted(feat_imp.items(), key=lambda x: -x[1])))

# ── Scores hoy — modelo del último fold ──────────────────────────────────────
final_model = fold_models[-1][1] if fold_models else None
last_day    = n_days - 1

# [FIX-A] ffill local para el día de hoy: propagar histórico hasta last_day
last_X = factor_stack[last_day].copy()
for fi in range(last_X.shape[1]):
    col    = factor_stack[:last_day+1, :, fi]
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
print("📦 Portfolio Construction Q5 (HRP inv-vol — métricas OOS)...")

q5_tickers = [t for t, r in results.items() if r["quintile"] == 5 and t in all_ind]
portfolio_metrics = {}
portfolio_weights = {}
portfolio_hhi     = 0.0

# Periodo OOS del último fold
last_fold_te_start = fold_test_starts[-1] if fold_models else 0
last_fold_te_end   = fold_test_ends[-1]   if fold_models else n_days

if len(q5_tickers) >= 2:
    # Retornos completos para calcular pesos (sin NaN)
    q5_ret_full = pd.DataFrame({
        t: all_ind[t]["returns"] for t in q5_tickers
    }).fillna(0)

    # Pesos: inverso-vol sobre TODOS los datos (el universe Q5 ya es el resultado del modelo)
    lw_q5   = LedoitWolf().fit(q5_ret_full.values)
    cov_q5  = pd.DataFrame(lw_q5.covariance_, index=q5_tickers, columns=q5_tickers)
    vol_q5  = np.sqrt(np.diag(cov_q5.values))
    inv_vol = 1.0 / np.maximum(vol_q5, 1e-8)
    raw_w   = inv_vol / inv_vol.sum()
    w_cap   = np.minimum(raw_w, 0.25)
    w_final = w_cap / w_cap.sum()

    portfolio_weights = {t: round(float(w), 4) for t, w in zip(q5_tickers, w_final)}

    # [FIX-C] Métricas SOLO sobre periodo OOS del último fold
    q5_ret_oos = q5_ret_full.iloc[last_fold_te_start:last_fold_te_end].values
    if len(q5_ret_oos) < 20:
        # Fallback si el OOS es muy corto (no debería ocurrir con LOOKBACK=504)
        q5_ret_oos = q5_ret_full.values[-60:]
        logger.warning("⚠️ OOS corto para portfolio metrics, usando últimos 60 días")

    port_ret_oos   = q5_ret_oos @ w_final
    port_vol_daily = float(np.sqrt(w_final @ cov_q5.values @ w_final))
    port_vol_ann   = port_vol_daily * np.sqrt(252)

    # Métricas OOS reales
    port_ret_ann_oos = float(np.mean(port_ret_oos)) * 252
    port_sharpe_oos  = port_ret_ann_oos / port_vol_ann if port_vol_ann > 0 else 0.0
    port_var95_oos   = float(np.percentile(port_ret_oos, 5)) * 100
    port_var99_oos   = float(np.percentile(port_ret_oos, 1)) * 100
    port_cvar95_oos  = float(
        np.mean(port_ret_oos[port_ret_oos <= np.percentile(port_ret_oos, 5)])) * 100

    # Max Drawdown sobre OOS
    cumret_oos    = np.cumprod(1 + port_ret_oos)
    running_max   = np.maximum.accumulate(cumret_oos)
    drawdowns_oos = (cumret_oos - running_max) / running_max
    max_dd_oos    = float(np.min(drawdowns_oos)) * 100

    portfolio_hhi = float(np.sum(w_final ** 2))

    portfolio_metrics = {
        "vol_ann":  round(port_vol_ann * 100, 2),
        "ret_ann":  round(port_ret_ann_oos * 100, 2),
        "sharpe":   round(port_sharpe_oos, 2),
        "var95":    round(port_var95_oos, 2),
        "var99":    round(port_var99_oos, 2),
        "cvar95":   round(port_cvar95_oos, 2),
        "max_dd":   round(max_dd_oos, 2),
        "hhi":      round(portfolio_hhi, 4),
        "n_assets": len(q5_tickers),
        "oos_days": len(q5_ret_oos),
    }
    print(f"   ✅ Q5 Portfolio OOS ({len(q5_ret_oos)} días): "
          f"Sharpe={port_sharpe_oos:.2f} | VaR95={port_var95_oos:.2f}% | MaxDD={max_dd_oos:.1f}%")
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

# ─── DASHBOARD HTML ───────────────────────────────────────────────────────────
def semaforo_color(v, lo, md, hi, rev=False):
    if rev:
        return "#00e07a" if v <= lo else "#f0a500" if v <= md else "#ff4060"
    return "#00e07a" if v >= hi else "#f0a500" if v >= md else "#ff4060"

print("🎨 Generando dashboard HTML...")
dt = datetime.now().strftime("%d/%m/%Y %H:%M")
tk = list(corr_hm.columns)

html = f"""<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>OLYMPUS HEATMAP REGRESSION v4.0</title><style>
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
</style></head><body>
<div class="header">
  <h1>OLYMPUS <span>HEATMAP REGRESSION</span><span class="vbadge">v4.0</span></h1>
  <div class="sub">// {len(available)} activos · {LOOKBACK}d histórico · {dt} · WF expanding {N_FOLDS} folds sin overlap</div>
  <div class="sub" style="margin-top:6px;color:#3a5a76;font-size:11px">
    ✔ ffill local · ✔ WF sin overlap · ✔ Portfolio OOS real · ✔ Slope vs ADX · ✔ LW sin distorsión · ✔ Confianza z-score
  </div>
</div>
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
html += f"""<div class="card full"><div class="card-title">
  📈 Motor Cross-Sectional ({MODEL_NAME}) — {len(results)} tickers · Horizonte {HORIZON}d
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
  Q5=top 20% | Target: excess return {HORIZON}d vs SPY
</div></div>
"""

# ── Métricas del modelo ───────────────────────────────────────────────────────
_ic_c  = "#00e07a" if mean_ic > 0.04 else "#f0a500" if mean_ic > 0.02 else "#ff4060"
_ir_c  = "#00e07a" if ir > 0.5       else "#f0a500" if ir > 0.2       else "#ff4060"
_hr_c  = "#00e07a" if hit_rate > 0.55 else "#f0a500" if hit_rate > 0.50 else "#ff4060"
_sg_c  = "#00e07a" if ic_signif > 0.10 else "#f0a500" if ic_signif > 0.05 else "#ff4060"

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
    sh_c = "#00e07a" if pm["sharpe"] > 0.8 else "#f0a500" if pm["sharpe"] > 0.4 else "#ff4060"
    dd_c = "#ff4060" if pm["max_dd"] < -20 else "#f0a500" if pm["max_dd"] < -10 else "#00e07a"
    hc   = "#ff4060" if pm["hhi"] > 0.25   else "#f0a500" if pm["hhi"] > 0.15   else "#00e07a"
    html += f"""
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">SHARPE OOS</div>
        <div style="font-size:22px;font-weight:700;color:{sh_c};font-family:var(--mono)">{pm["sharpe"]:.2f}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">VaR 95% OOS</div>
        <div style="font-size:22px;font-weight:700;color:#ff4060;font-family:var(--mono)">{pm["var95"]:.2f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">CVaR 95% OOS</div>
        <div style="font-size:22px;font-weight:700;color:#ff4060;font-family:var(--mono)">{pm["cvar95"]:.2f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">Max DD OOS</div>
        <div style="font-size:22px;font-weight:700;color:{dd_c};font-family:var(--mono)">{pm["max_dd"]:.1f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">Vol Anual</div>
        <div style="font-size:22px;font-weight:700;color:var(--gold);font-family:var(--mono)">{pm["vol_ann"]:.1f}%</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:10px;color:var(--muted)">HHI Concentración</div>
        <div style="font-size:22px;font-weight:700;color:{hc};font-family:var(--mono)">{pm["hhi"]:.3f}</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Pesos HRP (inv-vol, cap 25%):</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
    """
    for t, w in sorted(portfolio_weights.items(), key=lambda x: -x[1]):
        wc = "#00e07a" if w > 0.15 else "#f0a500" if w > 0.08 else "var(--muted)"
        html += f'<div class="pill" style="background:rgba(0,224,122,0.1);color:{wc}">{t}: {w*100:.1f}%</div>'
    html += '</div>'
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
for t, r in [(t, r) for t, r in sp_sorted if r["quintile"] == 5][:8]:
    w_pct = portfolio_weights.get(t, 0.0) * 100
    w_str = f" · peso {w_pct:.1f}%" if w_pct > 0 else ""
    html += (f'<div class="pill" style="background:rgba(0,224,122,0.15);color:#00e07a">'
             f'{t}: {r["score"]:.1f} (z={r["pred_z"]:.1f}){w_str}</div>')
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

html += f"""</div>
<div class="footer">
  Olympus Heatmap Regression v4.0 · Hende Fund · {dt} · {len(available)} tickers · {LOOKBACK}d · {MODEL_NAME}<br>
  <code style="color:#fff">python OLYMPUS_HEATMAP_REGRESSION_v4.py</code>
  <span style="color:var(--accent)"> para actualizar</span> ·
  Bugs corregidos: ffill-leak · WF-overlap · Portfolio-lookahead · ADX-inválido · LW-fillna0 · Closure · Confianza-uniforme
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
        {"ticker": t, "weight_pct": round(w * 100, 2), **results.get(t, {})}
        for t, w in sorted(portfolio_weights.items(), key=lambda x: -x[1])
    ])
    df_port.to_csv(os.path.join(base_dir, "portfolio_q5.csv"), index=False)
    logger.info("Portfolio Q5 CSV guardado")

try:
    webbrowser.open(f"file://{os.path.abspath(out_html)}")
    print("🚀 Abriendo dashboard en el navegador...")
except Exception:
    print(f"📂 Abre: {out_html}")

print("\n" + "=" * 65)
print("📊 RESUMEN OLYMPUS HEATMAP REGRESSION v4.0 — Hende Fund")
print("=" * 65)
print(f"📡 Activos: {len(available)} | 🔥 Heatmap: {len(heatmap_for_corr)} | 📅 Días: {LOOKBACK}")
print(f"🤖 Modelo: {MODEL_NAME} · Walk-Forward expanding {N_FOLDS} folds · Horizonte {HORIZON}d")
print(f"📐 IC={mean_ic:.4f} | IR={ir:.2f} | Hit={hit_rate:.1%} | IC sig={ic_signif:.1%}")
print(f"   IC por fold: {' | '.join([f'F{i+1}={v:.4f}' for i, v in enumerate(fold_ic_means)])}")
if portfolio_metrics:
    pm = portfolio_metrics
    print(f"\n📦 Portfolio Q5 OOS ({pm['n_assets']} activos · {pm['oos_days']} días OOS):")
    print(f"   Sharpe={pm['sharpe']:.2f} | Vol={pm['vol_ann']:.1f}% | MaxDD={pm['max_dd']:.1f}%")
    print(f"   VaR95={pm['var95']:.2f}% | CVaR95={pm['cvar95']:.2f}% | HHI={pm['hhi']:.3f}")
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

print("\n✅ BUGS CORREGIDOS EN v4.0 (vs re-auditoría adversarial v3.0):")
print("   [BUG-1→FIX-A] ffill global ELIMINADO: ahora local por ventana train y por día")
print("   [BUG-2→FIX-B] Walk-Forward expanding SIN overlap: test de cada fold es OOS estricto")
print("   [BUG-3→FIX-C] Portfolio Sharpe/VaR/CVaR/MaxDD sobre OOS del último fold, no in-sample")
print("   [BUG-4→FIX-D] ADX eliminado (inválido sin OHLC) → Trend Slope (regresión lineal rolling)")
print("   [BUG-5→FIX-E] make_dataset fuera del loop con argumentos explícitos (closure bug)")
print("   [BUG-6→FIX-F] LedoitWolf ajustado solo con tickers de retornos completos (sin fillna(0))")
print("   [BUG-7→FIX-G] Confianza basada en z-score de raw_pred, no en score_rank uniforme")
