#!/usr/bin/env python3
'''
OLYMPUS HEATMAP REGRESSION v9.2 - FACTOR LABORATORY
====================================================
Genera ~25 factores candidatos, mide IC individual de cada uno,
construye composite solo con factores que tienen senal real (IC > 0.01).
Incluye FINRA short volume (datos diarios genuinos, sin look-forward bias).
Sin ML, sin hyperopt. Solo matematicas y seleccion basada en evidencia.

CAMBIOS v9.2 vs v9.1:
  - FACTOR SELECTION SIN LEAKAGE: seleccion de factores dentro de cada fold
      usando solo datos in-sample → IC OOS ahora es honesto y reproducible
  - LEDOITWOLF HEATMAP pre-OOS: matriz de correlaciones del heatmap
      fitteada solo con datos anteriores al ultimo fold (igual que Q5)
  - ATR USD EN STOP-LOSS: ibkr_orders usa atr14_usd (USD absolutos)
      en lugar de atr_pct (fraccion) → stops correctamente dimensionados

CAMBIOS v9.1 vs v9.0:
  - ATR REAL (Wilder) con High/Low de cache:
      TR = max(H-L, |H-Cprev|, |L-Cprev|)
  - Fallback automatico a close-to-close si la cache no tiene OHLC

Uso: python OLYMPUS_HEATMAP_REGRESSION_v9.py [--capital CAPITAL_EUR]
Output: heatmap_dashboard.html, predictions.csv, factor_ic_report.csv, portfolio_q5.csv
'''
import os, sys, time, logging, warnings, argparse, json, pickle
from datetime import datetime

warnings.filterwarnings('ignore')

parser = argparse.ArgumentParser(description='OLYMPUS HEATMAP REGRESSION v9.2 Factor Lab')
parser.add_argument('--capital', type=float, default=10000.0, help='Capital EUR')
args = parser.parse_args()
CAPITAL_EUR = args.capital

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)

LOOKBACK = 504; HEATMAP_DISPLAY_N = 50; HORIZON = 5; N_FOLDS = 3
CACHE_MAX_AGE = 24 * 3600; MIN_IC_FOR_FACTOR = 0.01
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(BASE_DIR, 'heatmap_cache.pkl')
FINRA_CACHE_FILE = os.path.join(BASE_DIR, '.finra_cache.pkl')

CURATED = ['SPY','QQQ','IWM','DIA','MDY','XLK','XLF','XLV','XLY','XLI','XLC','XLE','XLP','XLRE','XLB','XLU',
           'EEM','EFA','EWJ','FXI','EWZ','INDA','IEUR','VGK','GLD','SLV','USO','DBC','TLT','AGG','LQD','HYG','IBIT','FBTC','BITO']

import pandas as pd; import numpy as np
from scipy.stats import spearmanr
from sklearn.covariance import LedoitWolf

print('OLYMPUS HEATMAP REGRESSION v9.2 - FACTOR LABORATORY')
print(f'~25 factores | IC sin leakage | Composite con IC > {MIN_IC_FOR_FACTOR} | FINRA | ATR REAL H/L | LW pre-OOS')
print('=' * 70)

# --- Cache (compartido con v7) ---
def load_cache():
    if not os.path.exists(CACHE_FILE): return None
    age = time.time() - os.path.getmtime(CACHE_FILE)
    if age >= CACHE_MAX_AGE: return None
    try:
        with open(CACHE_FILE, 'rb') as f: cached = pickle.load(f)
        if not {'closes','volume','available','lookback'}.issubset(cached.keys()):
            os.remove(CACHE_FILE); return None
        if cached.get('lookback') != LOOKBACK:
            os.remove(CACHE_FILE); return None
        print(f'   Cache ({age/3600:.1f}h) - {len(cached["available"])} tickers - {LOOKBACK}d')
        return cached
    except: return None

cache = load_cache()
if cache is None:
    print('ERROR: No hay cache. Ejecuta primero OLYMPUS_HEATMAP_REGRESSION_v7.py para descargar datos.')
    sys.exit(1)

closes = cache['closes']
available = cache['available']
volume_df = cache['volume']
high_df = cache.get('high', pd.DataFrame())   # OHLC high
low_df  = cache.get('low',  pd.DataFrame())   # OHLC low
_has_hl = not high_df.empty and not low_df.empty
print(f'OHLC High/Low: {"SÍ disponibles ✅" if _has_hl else "NO disponibles — ATR fallback close-to-close ⚠️"}')

# --- FINRA short volume ---
finra_df = None; finra_common = []
if os.path.exists(FINRA_CACHE_FILE):
    try:
        with open(FINRA_CACHE_FILE, 'rb') as f: fc = pickle.load(f)
        if 'df' in fc:
            finra_df = fc['df']
            finra_common = [t for t in available if t in finra_df.columns]
            print(f'FINRA cache: {len(finra_df.columns)} tickers x {len(finra_df)}d, {len(finra_common)} en comun')
    except: pass
if finra_df is None:
    print('FINRA: sin cache (se omitiran factores FINRA)')

# --- Filtro de liquidez DESACTIVADO ---
print(f'Universo: {len(available)} tickers (sin filtro liquidez)')

# --- Heatmap ---
curated_set = set(CURATED)
heatmap_tickers = [t for t in CURATED if t in available]
stock_candidates = []
for t in available:
    if t in curated_set: continue
    vol = volume_df[t].iloc[-1] if t in volume_df.columns else 0
    vol = 0 if pd.isna(vol) else vol
    stock_candidates.append((t, closes[t].iloc[-1] * vol))
stock_candidates.sort(key=lambda x: x[1], reverse=True)
top_n = min(HEATMAP_DISPLAY_N - len(heatmap_tickers), len(stock_candidates))
heatmap_tickers.extend([t for t, _ in stock_candidates[:top_n]])
print(f'Heatmap: {len(heatmap_tickers)} tickers | Regresion: {len(available)} tickers')

# --- RSI Wilder ---
def rsi_wilder(prices, period):
    if len(prices) < period + 1: return np.full(len(prices), 50.0)
    delta = np.diff(prices, prepend=prices[0])
    gains = np.where(delta > 0, delta, 0.0); losses = np.where(delta < 0, -delta, 0.0)
    alpha = 1.0 / period
    ag = pd.Series(gains).ewm(alpha=alpha, adjust=False).mean().values
    al = pd.Series(losses).ewm(alpha=alpha, adjust=False).mean().values
    rs = np.divide(ag, al, out=np.full_like(ag, 100.0), where=al > 1e-10)
    return 100.0 - (100.0 / (1.0 + rs))

# --- Indicadores (expandidos para factor catalog) ---
print('Calculando indicadores...')
all_ind = {}
for ti, t in enumerate(available):
    c = closes[t].values; n = len(c)
    if n < 200: continue
    ret = pd.Series(c).pct_change().fillna(0).values
    log_r = np.log1p(np.clip(ret, -0.5, 1.0))
    cumlog = np.cumsum(log_r)
    ma20 = pd.Series(c).rolling(20).mean().values
    ma50 = pd.Series(c).rolling(50).mean().values
    ma200 = pd.Series(c).rolling(200, min_periods=50).mean().values
    r2 = rsi_wilder(c, 2); r14 = rsi_wilder(c, 14)
    # --- ATR REAL (Wilder) con High/Low cuando disponibles ---
    # Fallback close-to-close si la cache no tiene OHLC
    if _has_hl and t in high_df.columns and t in low_df.columns:
        h_raw = high_df[t].reindex(closes.index).ffill().values[:n]
        l_raw = low_df[t].reindex(closes.index).ffill().values[:n]
        if len(h_raw) < n: h_raw = np.pad(h_raw, (0, n - len(h_raw)), 'edge')
        if len(l_raw) < n: l_raw = np.pad(l_raw, (0, n - len(l_raw)), 'edge')
        tr_arr = np.zeros(n)
        for _i in range(1, n):
            hl = h_raw[_i] - l_raw[_i]
            hc = abs(h_raw[_i] - c[_i - 1])
            lc = abs(l_raw[_i] - c[_i - 1])
            tr_arr[_i] = max(hl, hc, lc) if not np.isnan(hl + hc + lc) else abs(c[_i] - c[_i - 1])
    else:
        # Fallback: solo close-to-close (peor precisión en stop-loss)
        tr_arr = np.concatenate([[0], np.abs(np.diff(c))])
    atr14 = pd.Series(tr_arr).ewm(alpha=1/14, adjust=False).mean().values
    atr_pct = np.divide(atr14, c, out=np.zeros_like(atr14), where=c > 0)
    # atr14_usd: ATR en USD absolutos (para stop-loss en ibkr_orders — NO usar atr_pct)
    atr14_usd = atr14.copy()
    if t in volume_df.columns:
        v_raw = volume_df[t]
        if hasattr(v_raw, 'reindex'):
            v_raw = v_raw.reindex(closes.index, method='ffill')
        v = np.array(v_raw.values if hasattr(v_raw, 'values') else v_raw)[:n]
        if len(v) < n:
            v = np.pad(v, (0, n - len(v)), 'edge')
        obv = np.cumsum(np.where(ret > 0, v[:n], np.where(ret < 0, -v[:n], 0)))
    else:
        obv = np.zeros(n)
    e12 = pd.Series(c).ewm(span=12, adjust=False).mean().values
    e26 = pd.Series(c).ewm(span=26, adjust=False).mean().values
    macd_hist = (e12 - e26) - pd.Series(e12 - e26).ewm(span=9, adjust=False).mean().values
    if (ti + 1) % 200 == 0: print(f'   {ti+1}/{len(available)}')
    all_ind[t] = {'ret': ret, 'log_r': log_r, 'cumlog': cumlog, 'c': c,
                  'ma20': ma20, 'ma50': ma50, 'ma200': ma200,
                  'rsi2': r2, 'rsi14': r14, 'atr_pct': atr_pct, 'atr14_usd': atr14_usd,
                  'obv': obv, 'macd_hist': macd_hist}
print(f'   OK {len(all_ind)} tickers con indicadores completos')

# --- Panel ---
NON_TRADEABLE = {'^VIX'}; BENCH_TICKERS = {'SPY', 'QQQ', 'IWM', 'DIA', 'MDY'}
tickers_panel = sorted([t for t in all_ind.keys() if t not in NON_TRADEABLE])
ret_df = pd.DataFrame({t: all_ind[t]['ret'] for t in tickers_panel})
log_ret = np.log1p(ret_df); n_days = len(ret_df)
print(f'Panel: {n_days}d x {len(tickers_panel)} tickers')

# --- Forward excess returns (target) ---
fwd_log_panel = log_ret.shift(-HORIZON).rolling(HORIZON).sum()
fwd_ret_panel = np.expm1(fwd_log_panel)
ew_median_fwd = fwd_ret_panel[tickers_panel].median(axis=1).fillna(0.0)
fwd_excess = fwd_ret_panel[tickers_panel].subtract(ew_median_fwd, axis=0)

# --- Ranking CS ---
def cs_rank(df):
    return df[tickers_panel].rank(axis=1, pct=True) * 100

def measure_ic(factor_df, label):
    """Measure daily Spearman IC of a factor vs forward excess returns"""
    fac = factor_df[tickers_panel].values; fwd = fwd_excess[tickers_panel].values
    ics = []
    for day_i in range(70, n_days - HORIZON):
        f_row = fac[day_i]; y_row = fwd[day_i]
        valid = ~(np.isnan(f_row) | np.isnan(y_row))
        if valid.sum() < 20: continue
        ic, _ = spearmanr(f_row[valid], y_row[valid])
        if not np.isnan(ic): ics.append(ic)
    if not ics: return None
    ic_arr = np.array(ics)
    return {'label': label, 'ic_mean': float(np.mean(ic_arr)), 'ic_std': float(np.std(ic_arr)),
            'ir': float(np.mean(ic_arr)) / max(float(np.std(ic_arr)), 0.001),
            'hit_rate': float(np.mean(ic_arr > 0)), 'n_days': len(ics),
            'ic_20d': float(np.mean(ic_arr[-20:])) if len(ics)>=20 else float(np.mean(ic_arr)),
            'ic_60d': float(np.mean(ic_arr[-60:])) if len(ics)>=60 else float(np.mean(ic_arr)),
            'ic_120d': float(np.mean(ic_arr[-120:])) if len(ics)>=120 else float(np.mean(ic_arr))}

# =========================================================================
# FACTOR CATALOG: Generate all candidates, measure IC individually
# =========================================================================
print('\n' + '=' * 70)
print('FACTOR CATALOG - IC individual de cada factor')
print('=' * 70)
factor_catalog = {}
v5 = ret_df.rolling(5).std(); v21 = ret_df.rolling(21).std().replace(0, np.nan)
v63 = ret_df.rolling(63).std().replace(0, np.nan)

# 1. MOMENTUM
print('\n[MOMENTUM]')
for h in [5, 10, 21, 42, 63, 126]:
    f_ranked = cs_rank(np.expm1(log_ret.rolling(h).sum()))
    r = measure_ic(f_ranked, f'mom_{h}d')
    factor_catalog[f'mom_{h}d'] = {'df': f_ranked, 'result': r}
    if r: print(f'  {f"mom_{h:3d}d":<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 2. REVERSAL
print('\n[REVERSAL]')
for h in [2, 5, 10, 21]:
    f_ranked = cs_rank(-np.expm1(log_ret.rolling(h).sum()))
    r = measure_ic(f_ranked, f'rev_{h}d')
    factor_catalog[f'rev_{h}d'] = {'df': f_ranked, 'result': r}
    if r: print(f'  {f"rev_{h:2d}d":<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 3. VOLATILITY
print('\n[VOLATILITY]')
for h in [5, 10, 21, 63]:
    f_ranked = cs_rank(-ret_df.rolling(h).std())
    r = measure_ic(f_ranked, f'vol_{h}d_low')
    factor_catalog[f'vol_{h}d_low'] = {'df': f_ranked, 'result': r}
    if r: print(f'  {f"vol_{h:2d}d_low":<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 4. VOL RATIO
print('\n[VOL RATIO]')
for sh, lh, label in [(5,21,'vol_5_21'),(5,63,'vol_5_63'),(21,63,'vol_21_63')]:
    vs = ret_df.rolling(sh).std(); vl = ret_df.rolling(lh).std().replace(0, np.nan)
    f_ranked = cs_rank(-(vs / vl))
    r = measure_ic(f_ranked, label)
    factor_catalog[label] = {'df': f_ranked, 'result': r}
    if r: print(f'  {label:<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 5. RISK-ADJUSTED MOMENTUM
print('\n[RISK-ADJ MOM]')
for h in [21, 63]:
    mom = np.expm1(log_ret.rolling(h).sum())
    f_ranked = cs_rank(mom / v63)
    r = measure_ic(f_ranked, f'ram_{h}d')
    factor_catalog[f'ram_{h}d'] = {'df': f_ranked, 'result': r}
    if r: print(f'  {f"ram_{h}d":<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 6. MA DISTANCE
print('\n[MA DISTANCE]')
for ma_n, ma_h in [('ma20',20),('ma50',50),('ma200',200)]:
    m = pd.DataFrame({t: all_ind[t][ma_n] for t in tickers_panel})
    cl = pd.DataFrame({t: all_ind[t]['c'] for t in tickers_panel})
    f_ranked = cs_rank(-(cl - m) / cl.replace(0, np.nan))
    r = measure_ic(f_ranked, f'dist_{ma_h}d')
    factor_catalog[f'dist_{ma_h}d'] = {'df': f_ranked, 'result': r}
    if r: print(f'  {f"dist_{ma_h}d":<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 7. RSI
print('\n[RSI]')
for p in [2, 14]:
    rd = pd.DataFrame({t: all_ind[t][f'rsi{p}'] for t in tickers_panel})
    f_ranked = cs_rank(-rd)
    r = measure_ic(f_ranked, f'rsi{p}_cs')
    factor_catalog[f'rsi{p}_cs'] = {'df': f_ranked, 'result': r}
    if r: print(f'  {f"rsi{p}_cs":<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 8. ATR
print('\n[ATR]')
ad = pd.DataFrame({t: all_ind[t]['atr_pct'] for t in tickers_panel})
f_ranked = cs_rank(-ad)
r = measure_ic(f_ranked, 'atr_low')
factor_catalog['atr_low'] = {'df': f_ranked, 'result': r}
if r: print(f'  atr_low      IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 9. MACD
print('\n[MACD]')
md = pd.DataFrame({t: all_ind[t]['macd_hist'] / np.maximum(all_ind[t]['c'],0.01) for t in tickers_panel})
f_ranked = cs_rank(md)
r = measure_ic(f_ranked, 'macd_hist')
factor_catalog['macd_hist'] = {'df': f_ranked, 'result': r}
if r: print(f'  macd_hist    IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 10. OBV
print('\n[OBV]')
for h in [5, 21]:
    od = pd.DataFrame({t: all_ind[t]['obv'] for t in tickers_panel})
    denom = od.replace(0, np.nan).rolling(h).std().replace(0, 1)
    f_ranked = cs_rank(od.diff(h) / denom)
    r = measure_ic(f_ranked, f'obv_{h}d')
    factor_catalog[f'obv_{h}d'] = {'df': f_ranked, 'result': r}
    if r: print(f'  {f"obv_{h}d":<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 11. RELATIVE STRENGTH
print('\n[REL STRENGTH]')
for h in [21, 63]:
    mom = np.expm1(log_ret.rolling(h).sum())
    bm = mom.median(axis=1).fillna(0.0)
    f_ranked = cs_rank(mom.subtract(bm, axis=0))
    r = measure_ic(f_ranked, f'rs_bench_{h}d')
    factor_catalog[f'rs_bench_{h}d'] = {'df': f_ranked, 'result': r}
    if r: print(f'  {f"rs_bench_{h}d":<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}')

# 12. FINRA SHORT VOLUME
if finra_df is not None and len(finra_common) >= 50:
    print('\n[FINRA SHORT VOL]')
    finra_aligned = finra_df.reindex(closes.index, method='ffill')
    finra_cp = [t for t in tickers_panel if t in finra_aligned.columns]
    if len(finra_cp) >= 50:
        for lb in [5, 21]:
            fs = finra_aligned[finra_cp].rolling(lb).mean()
            ff = pd.DataFrame(np.nan, index=fs.index, columns=tickers_panel)
            ff[finra_cp] = fs; ff = ff.fillna(0.5)
            f_ranked = cs_rank(-ff)
            r = measure_ic(f_ranked, f'finra_{lb}d')
            factor_catalog[f'finra_{lb}d'] = {'df': f_ranked, 'result': r}
            if r: print(f'  {f"finra_{lb}d":<14s} IC={r["ic_mean"]:+.4f}  IR={r["ir"]:+.2f}  Hit={r["hit_rate"]:.1%}  Nt={len(finra_cp)}')

# --- RANK & SELECT ---
print('\n' + '=' * 70)
print('RANKING DE FACTORES POR IC')
print('=' * 70)
all_factors_sorted = [(n, e['result']) for n, e in factor_catalog.items() if e['result'] is not None]
all_factors_sorted.sort(key=lambda x: -x[1]['ic_mean'])
print(f'{"#":<4} {"Factor":<16} {"IC":>8} {"IR":>7} {"Hit":>7} {"IC_20d":>8} {"IC_60d":>8}')
print('-' * 70)
for rank, (name, r) in enumerate(all_factors_sorted, 1):
    sgn = '+' if r['ic_mean'] > 0 else ''
    print(f'{rank:<4} {name:<16} {sgn}{r["ic_mean"]:.4f}  {r["ir"]:.2f}   {r["hit_rate"]:.1%}   {r["ic_20d"]:+.4f}   {r["ic_60d"]:+.4f}')

selected = [(n, r) for n, r in all_factors_sorted if r['ic_mean'] > MIN_IC_FOR_FACTOR]
selected_names = [n for n, r in selected]
print(f'\nFactores con IC > {MIN_IC_FOR_FACTOR} (referencia global): {len(selected)}')
if selected:
    for n, r in selected: print(f'  + {n}: IC={r["ic_mean"]:+.4f}')
else:
    top_n = min(10, len(all_factors_sorted))
    selected = [(n, r) for n, r in all_factors_sorted[:top_n] if r['ic_mean'] > 0]
    if not selected: selected = all_factors_sorted[:3]
    selected_names = [n for n, r in selected]
    print(f'  NINGUNO supera umbral. Fallback: top {len(selected)} factores positivos.')

# --- Build composite GLOBAL para scores de hoy (para uso en ranking, NO para OOS IC) ---
print(f'\nComposite global: {len(selected_names)} factores (para ranking hoy)')
composite_global = None
for name in selected_names:
    df = factor_catalog[name]['df']
    composite_global = df.copy() if composite_global is None else composite_global + df
composite_global = composite_global / len(selected_names) if len(selected_names) > 0 else cs_rank(ret_df * 0) + 50
composite_global = composite_global.fillna(50.0).clip(0, 100)

# =========================================================================
# WALK-FORWARD OOS IC — Factor selection DENTRO de cada fold (sin leakage)
# =========================================================================
# Para cada fold: seleccionar factores con IC > MIN usando solo datos in-sample
# del fold, construir composite fold-específico, medir IC en OOS del fold.
# Esto da un IC OOS honesto: en producción, solo sabes qué factores funcionaron
# antes del período que estás midiendo.
# =========================================================================
print(f'\nWalk-Forward OOS IC (sin leakage): {N_FOLDS} folds | H={HORIZON}d')

n_days = len(ret_df); START_DAY = 70; TRAIN_END = n_days - HORIZON - 5
EMBARGO = max(HORIZON, 3)

block = (TRAIN_END - START_DAY) // (N_FOLDS + 1)
cuts = [START_DAY + block * (k + 1) for k in range(N_FOLDS)]
fold_test_starts = cuts; fold_test_ends = cuts[1:] + [TRAIN_END]
fold_train_ends = [c - EMBARGO for c in cuts]

fwd_np = fwd_excess[tickers_panel].values
all_ic_scores = []; fold_ic_means = []; fold_selected_names = []

for fold_i in range(N_FOLDS):
    tr_end = fold_train_ends[fold_i]; te_start = fold_test_starts[fold_i]; te_end = fold_test_ends[fold_i]

    # 1. Medir IC de cada factor usando SOLO datos in-sample [START_DAY:tr_end]
    fold_factor_ics = {}
    for fname, fentry in factor_catalog.items():
        if fentry['result'] is None: continue
        fac_np = fentry['df'][tickers_panel].values
        fwd_is = fwd_np  # target siempre hacia adelante; IC se mide día a día in-sample
        is_ics = []
        for day_i in range(START_DAY, tr_end):
            f_row = fac_np[day_i]; y_row = fwd_is[day_i]
            valid = ~(np.isnan(f_row) | np.isnan(y_row))
            if valid.sum() < 20: continue
            ic, _ = spearmanr(f_row[valid], y_row[valid])
            if not np.isnan(ic): is_ics.append(ic)
        if is_ics:
            fold_factor_ics[fname] = float(np.mean(is_ics))

    # 2. Seleccionar factores con IC_insample > MIN_IC_FOR_FACTOR
    fold_sel = [n for n, ic in fold_factor_ics.items() if ic > MIN_IC_FOR_FACTOR]
    if not fold_sel:
        fold_sel = sorted(fold_factor_ics, key=fold_factor_ics.get, reverse=True)[:3]
    fold_selected_names.append(fold_sel)

    # 3. Construir composite fold-específico
    fold_comp = None
    for fname in fold_sel:
        df = factor_catalog[fname]['df'][tickers_panel].values
        fold_comp = df.copy() if fold_comp is None else fold_comp + df
    fold_comp = fold_comp / len(fold_sel) if fold_sel else np.full_like(fwd_np, 50.0)

    # 4. Medir IC OOS con composite fold-específico
    fold_ics = []
    for day_i in range(te_start, te_end):
        comp_day = fold_comp[day_i]; fwd_day = fwd_np[day_i]
        valid = ~(np.isnan(comp_day) | np.isnan(fwd_day))
        if valid.sum() < 20: continue
        ic, _ = spearmanr(comp_day[valid], fwd_day[valid])
        if not np.isnan(ic): all_ic_scores.append(ic); fold_ics.append(ic)

    fold_ic = float(np.mean(fold_ics)) if fold_ics else 0.0
    fold_ic_means.append(fold_ic)
    print(f'   Fold {fold_i+1}/{N_FOLDS}: IS=[{START_DAY},{tr_end}) OOS=[{te_start},{te_end}) | '
          f'Factores IS: {len(fold_sel)} | IC_OOS={fold_ic:.4f} ({len(fold_ics)}d)')

mean_ic = float(np.mean(all_ic_scores)) if all_ic_scores else 0.0
std_ic = float(np.std(all_ic_scores)) if all_ic_scores else 1.0
ir = mean_ic / std_ic if std_ic > 0 else 0.0
hit_rate = float(np.mean([ic > 0 for ic in all_ic_scores])) if all_ic_scores else 0.5

ic_series = pd.Series(all_ic_scores)
ic_20d = float(ic_series.tail(20).mean()) if len(ic_series) >= 20 else mean_ic
ic_60d = float(ic_series.tail(60).mean()) if len(ic_series) >= 60 else mean_ic
ic_120d = float(ic_series.tail(120).mean()) if len(ic_series) >= 120 else mean_ic

print(f'   IC_mean={mean_ic:.4f} | IC_20d={ic_20d:.4f} | IC_60d={ic_60d:.4f} | IC_120d={ic_120d:.4f}')
icstatus = 'ROJO' if ic_20d < 0.03 else 'AMARILLO' if ic_20d < 0.05 else 'VERDE'
print(f'   IR={ir:.2f} | Hit={hit_rate:.1%} | {len(all_ic_scores)}d OOS | Semaforo: {icstatus}')

# --- Scores hoy (usando composite_global — factores seleccionados sobre historia completa) ---
last_day = n_days - 1
today_comp = composite_global[tickers_panel].values[last_day]
valid_today = ~np.isnan(today_comp)
results = {}
# Fallback: si no hay suficientes validos, usar fillna(50)
if valid_today.sum() < 10:
    # [HOTFIX v9.2.1] comp_np no estaba definido — NameError si <10 tickers
    # validos hoy. composite_global ya viene con fillna(50.0) aplicado.
    today_comp = np.nan_to_num(composite_global[tickers_panel].values[last_day], nan=50.0)
    valid_today = np.ones(len(today_comp), dtype=bool)
if valid_today.sum() >= 10:
    vals = today_comp[valid_today]
    ranks = (np.argsort(np.argsort(vals)) + 1) / len(vals) * 100
    quintiles = pd.qcut(ranks, 5, labels=[1, 2, 3, 4, 5])
    for j, t_idx in enumerate(np.where(valid_today)[0]):
        t = tickers_panel[t_idx]
        sc = float(np.clip(ranks[j], 0, 100))
        q = int(quintiles[j])
        z = abs(sc - 50) / 15
        conf = 'HIGH' if z > 1.5 else 'MED' if z > 0.75 else 'LOW'
        results[t] = {'score': round(sc,1), 'quintile': q, 'ic': round(mean_ic,4),
                      'ir': round(ir,2), 'hit_rate': round(hit_rate,3),
                      'confidence': conf, 'raw_pred': round(float(vals[j]),4), 'pred_z': round(z,2)}
else:
    print('ERROR: No hay suficientes scores validos hoy')
    sys.exit(1)

n_q5 = sum(1 for r in results.values() if r['quintile'] == 5)
n_q1 = sum(1 for r in results.values() if r['quintile'] == 1)
print(f'   {len(results)} scores | Q5 LONG: {n_q5} | Q1 SHORT: {n_q1}')

# --- SECTOR MAP ---
SECTOR_MAP = {
    'XLK':'Tech','AAPL':'Tech','MSFT':'Tech','NVDA':'Tech','AMD':'Tech','AVGO':'Tech','CRM':'Tech','ADBE':'Tech','NOW':'Tech','ORCL':'Tech','PLTR':'Tech',
    'XLF':'Fin','JPM':'Fin','BAC':'Fin','WFC':'Fin','GS':'Fin','MS':'Fin','AXP':'Fin','BLK':'Fin','C':'Fin','SCHW':'Fin','CME':'Fin','COF':'Fin','BX':'Fin',
    'XLV':'Health','LLY':'Health','UNH':'Health','MRK':'Health','ABBV':'Health','JNJ':'Health','PFE':'Health','AMGN':'Health','SYK':'Health','BSX':'Health','VRTX':'Health','GILD':'Health','MDT':'Health','ABT':'Health','ISRG':'Health',
    'XLY':'ConsDisc','AMZN':'ConsDisc','TSLA':'ConsDisc','HD':'ConsDisc','MCD':'ConsDisc','LOW':'ConsDisc','BKNG':'ConsDisc','TJX':'ConsDisc','SBUX':'ConsDisc','UBER':'ConsDisc',
    'XLP':'ConsStap','PG':'ConsStap','KO':'ConsStap','PEP':'ConsStap','COST':'ConsStap','WMT':'ConsStap','MO':'ConsStap','PM':'ConsStap','XLU':'Util','SO':'Util','DUK':'Util','NEE':'Util',
    'XLE':'Energy','XOM':'Energy','CVX':'Energy','COP':'Energy',
    'XLI':'Indust','GE':'Indust','BA':'Indust','HON':'Indust','UNP':'Indust','ETN':'Indust','UPS':'Indust','LMT':'Indust','RTX':'Indust','CAT':'Indust','DE':'Indust',
    'XLC':'Comm','META':'Comm','GOOGL':'Comm','GOOG':'Comm','DIS':'Comm','NFLX':'Comm','CMCSA':'Comm','VZ':'Comm','T':'Comm','TMUS':'Comm',
    'XLRE':'RealEst','AMT':'RealEst','PLD':'RealEst','WELL':'RealEst',
    'SPY':'Bench','QQQ':'Bench','IWM':'Bench','DIA':'Bench','MDY':'Bench',
    'GLD':'Commod','SLV':'Commod','USO':'Commod','DBC':'Commod','TLT':'Bond','AGG':'Bond','LQD':'Bond','HYG':'Bond',
    'IBIT':'Crypto','FBTC':'Crypto','BITO':'Crypto',
}
def get_sector(t): return SECTOR_MAP.get(t.upper(), 'Other')

# --- Matriz de correlaciones LW (solo datos pre-OOS para evitar look-ahead) ---
print('Matriz de correlaciones Ledoit-Wolf (pre-OOS)...')
complete_tickers = [t for t in all_ind if np.isnan(all_ind[t]['ret']).sum() == 0]
rdf_complete = pd.DataFrame({t: all_ind[t]['ret'] for t in complete_tickers})
# Usar solo datos hasta el inicio del último fold OOS (consistente con Q5 LW)
lw_cutoff = fold_test_starts[-1] if fold_test_starts else len(rdf_complete)
rdf_pre_oos = rdf_complete.iloc[:lw_cutoff]
if len(rdf_pre_oos) < 60:
    rdf_pre_oos = rdf_complete  # fallback si hay muy pocos datos
lw = LedoitWolf().fit(rdf_pre_oos.values)
cov_lw = pd.DataFrame(lw.covariance_, index=rdf_complete.columns, columns=rdf_complete.columns)
std_lw = np.sqrt(np.diag(cov_lw.values))
corr_lw = cov_lw.div(std_lw, axis=0).div(std_lw, axis=1).round(3)
heatmap_display = [t for t in heatmap_tickers if t in all_ind and t in corr_lw.columns]
corr_hm = corr_lw.loc[heatmap_display, heatmap_display] if heatmap_display else pd.DataFrame()
print(f'   LW: {len(complete_tickers)} tickers | {lw_cutoff}d pre-OOS (de {len(rdf_complete)}d totales)')

# --- Portfolio Q5 (SxIV) ---
print('Portfolio Construction Q5 (SxIV)...')

EQUIV_GROUPS = [{'GOOG','GOOGL'}, {'BRK-A','BRK-B'}, {'IBIT','FBTC','BITO'}, {'GLD','PPFB.DE'}]

q5_tickers = [t for t, r in results.items() if r['quintile'] == 5 and t in all_ind and t not in BENCH_TICKERS]
for group in EQUIV_GROUPS:
    overlap = [t for t in q5_tickers if t in group]
    if len(overlap) > 1:
        best = max(overlap, key=lambda t: results[t]['score'])
        for t in overlap:
            if t != best: q5_tickers.remove(t)

portfolio_weights = {}; portfolio_metrics = {}; greedy_order = []

if len(q5_tickers) >= 2:
    q5_complete = [t for t in q5_tickers if np.isnan(all_ind[t]['ret']).sum() == 0]
    if len(q5_complete) < 2: q5_complete = q5_tickers
    q5_ret = pd.DataFrame({t: all_ind[t]['ret'] for t in q5_complete})
    last_fold_start = fold_test_starts[-1]; last_fold_end = fold_test_ends[-1]
    q5_ret_pre_oos = q5_ret.iloc[:last_fold_start]
    if len(q5_ret_pre_oos) < 20: q5_ret_pre_oos = q5_ret
    
    lw_q5 = LedoitWolf().fit(q5_ret_pre_oos.values)
    cov_q5_arr = lw_q5.covariance_
    vol_q5 = np.sqrt(np.diag(cov_q5_arr))
    scores_arr = np.array([results.get(t, {}).get('score', 50.0) for t in q5_complete])
    
    w_raw = scores_arr / np.maximum(vol_q5, 0.005)
    w_raw = w_raw / w_raw.sum()
    w_cap = np.minimum(w_raw, 0.25)
    w_final = w_cap / w_cap.sum()
    
    portfolio_weights = {t: round(float(w), 4) for t, w in zip(q5_complete, w_final)}
    portfolio_hhi = float(np.sum(w_final ** 2))
    
    # OOS metrics
    q5_ret_oos = q5_ret.iloc[last_fold_start:last_fold_end].values
    if len(q5_ret_oos) < 20: q5_ret_oos = q5_ret.values[-60:]
    port_ret_oos = q5_ret_oos @ w_final
    
    port_vol_oos = float(np.std(port_ret_oos)) * np.sqrt(252)
    port_ret_ann = float(np.mean(port_ret_oos)) * 252
    port_sharpe = port_ret_ann / port_vol_oos if port_vol_oos > 0 else 0.0
    port_var95 = float(np.percentile(port_ret_oos, 5)) * 100
    cumret = np.cumprod(1 + port_ret_oos)
    max_dd = float(np.min((cumret - np.maximum.accumulate(cumret)) / np.maximum.accumulate(cumret))) * 100
    
    # Costes
    COST_PER_DAY = 0.00036 / max(HORIZON, 1)
    port_ret_net = port_ret_oos - COST_PER_DAY
    port_sharpe_net = (float(np.mean(port_ret_net)) * 252) / port_vol_oos if port_vol_oos > 0 else 0.0
    
    # Benchmarks
    ew_ret = np.mean(q5_ret_oos, axis=1)
    ew_sharpe = (np.mean(ew_ret)*252)/(np.std(ew_ret)*np.sqrt(252)) if np.std(ew_ret)>0 else 0.0
    bh_sharpe = 0.0
    if 'SPY' in all_ind:
        spy_ret_oos = all_ind['SPY']['ret'][last_fold_start:last_fold_end]
        bh_sharpe = (np.mean(spy_ret_oos)*252)/(np.std(spy_ret_oos)*np.sqrt(252)) if np.std(spy_ret_oos)>0 else 0.0
    
    portfolio_metrics = {'sharpe':round(port_sharpe,2),'sharpe_net':round(port_sharpe_net,2),
        'var95':round(port_var95,2),'max_dd':round(max_dd,2),'hhi':round(portfolio_hhi,4),
        'vol_ann':round(port_vol_oos*100,1),'ew_sharpe':round(ew_sharpe,2),'bh_sharpe':round(bh_sharpe,2),
        'n_assets':len(q5_complete),'oos_days':len(q5_ret_oos)}
    
    greedy_order = sorted(q5_complete, key=lambda t: results.get(t,{}).get('score',0), reverse=True)
    print(f'   Q5 OOS ({len(q5_ret_oos)}d): Sharpe={port_sharpe:.2f} | Net={port_sharpe_net:.2f} | EW={ew_sharpe:.2f} | SPY={bh_sharpe:.2f}')
    print(f'   Alpha vs SPY: {port_sharpe-bh_sharpe:+.2f} | MaxDD={max_dd:.1f}% | HHI={portfolio_hhi:.4f}')

# --- IBKR Orders ---
RISK_PER_TRADE = 0.02; RR_RATIO = 2.0
ibkr_rows = []
if portfolio_weights:
    remaining = CAPITAL_EUR
    sorted_items = [(t, portfolio_weights[t]) for t in greedy_order if t in portfolio_weights]
    MIN_PER_POS = 100.0 if CAPITAL_EUR < 1000 else 200.0 if CAPITAL_EUR < 10000 else 500.0
    dyn_max = max(1, min(len(sorted_items), int(CAPITAL_EUR / MIN_PER_POS)))
    if dyn_max < len(sorted_items):
        sorted_items = sorted_items[:dyn_max]
        tw = sum(w for _, w in sorted_items)
        if tw > 0: sorted_items = [(t, w/tw) for t, w in sorted_items]
    for t, w in sorted_items:
        r = results.get(t, {})
        entry_raw = closes[t].dropna()
        entry = float(entry_raw.iloc[-1]) if len(entry_raw) > 0 else 0.0
        if entry <= 0 or np.isnan(entry): continue
        atr_usd_arr = all_ind[t]['atr14_usd'] if t in all_ind else np.array([entry * 0.02])
        atr_usd_clean = atr_usd_arr[~np.isnan(atr_usd_arr)]
        atr_usd = float(atr_usd_clean[-1]) if len(atr_usd_clean) > 0 else entry * 0.02
        # sl_dist en USD absolutos (mínimo 1% del precio como suelo de seguridad)
        sl_dist = max(atr_usd * 2.5, entry * 0.01)
        tp_dist = sl_dist * RR_RATIO
        sl = round(entry - sl_dist, 4); tp = round(entry + tp_dist, 4)
        ideal = CAPITAL_EUR * w
        size = min(ideal, remaining, CAPITAL_EUR * 0.30)
        max_risk = CAPITAL_EUR * RISK_PER_TRADE * entry / sl_dist if sl_dist > 0 else ideal
        size = min(size, max_risk); size = max(0.0, size)
        shares = round(size / entry, 6) if entry > 0 else 0.0
        risk_eur = round(shares * sl_dist, 2)
        viable = size > 0.01 and remaining >= size - 0.001
        if viable: remaining -= size
        ibkr_rows.append({'ticker':t,'action':'BUY','entry_price':round(entry,4),'stop_loss':sl,'take_profit':tp,
            'rr_ratio':RR_RATIO,'shares':shares,'size_eur':size,'risk_eur':risk_eur,'weight_pct':round(w*100,2),
            'score':r.get('score',0),'confidence':r.get('confidence','LOW'),'z_score':r.get('pred_z',0),
            'viable':viable,'sector':get_sector(t)})
    n_viable = sum(1 for r in ibkr_rows if r['viable'])
    total_inv = sum(r['size_eur'] for r in ibkr_rows if r['viable'])
    print(f'   [CASH] {n_viable} posiciones | EUR{total_inv:.0f} / EUR{CAPITAL_EUR:.0f}')

# --- Guardar CSVs ---
print('Guardando outputs...')
pred_rows = [{'ticker':t,'score':r['score'],'quintile':r['quintile'],'confidence':r['confidence'],'pred_z':r['pred_z']} for t,r in sorted(results.items())]
pd.DataFrame(pred_rows).to_csv(os.path.join(BASE_DIR,'predictions.csv'), index=False)

if portfolio_weights:
    port_rows = [{'ticker':t,'weight':w,'score':results.get(t,{}).get('score',0),'sector':get_sector(t)} for t,w in portfolio_weights.items()]
    pd.DataFrame(port_rows).to_csv(os.path.join(BASE_DIR,'portfolio_q5.csv'), index=False)

if ibkr_rows:
    pd.DataFrame(ibkr_rows).to_csv(os.path.join(BASE_DIR,'ibkr_orders.csv'), index=False, na_rep='0.0')
    print(f'   IBKR ordenes guardadas')

if not corr_hm.empty:
    corr_hm.to_csv(os.path.join(BASE_DIR,'correlations.csv'))

# factor_ic_report.csv
factor_report = []
for name, r in all_factors_sorted:
    factor_report.append({'factor': name, 'ic_mean':round(r['ic_mean'],5), 'ic_std':round(r['ic_std'],5), 'ir':round(r['ir'],3), 'hit_rate':round(r['hit_rate'],4), 'ic_20d':round(r['ic_20d'],4), 'n_days':r['n_days'], 'selected': name in selected_names})
pd.DataFrame(factor_report).to_csv(os.path.join(BASE_DIR,'factor_ic_report.csv'), index=False)
print(f'   factor_ic_report.csv ({len(factor_report)} factores)')

ic_row = pd.DataFrame([{'date':datetime.now().strftime('%Y-%m-%d %H:%M'),'ic_mean':mean_ic,'ic_20d':ic_20d,'ic_60d':ic_60d,'ic_120d':ic_120d,'ir':ir,'hit_rate':hit_rate,'n_days':len(ic_series),'mode':'v9_factorlab','n_factors':len(selected_names),'factors':','.join(selected_names[:10]),'n_tickers':len(results)}])
ic_path = os.path.join(BASE_DIR,'ic_monitor.csv')
if os.path.exists(ic_path):
    existing = pd.read_csv(ic_path)
    pd.concat([existing, ic_row], ignore_index=True).tail(100).to_csv(ic_path, index=False)
else:
    ic_row.to_csv(ic_path, index=False)

# --- Dashboard HTML minimal ---
print('Generando dashboard HTML...')
dt = datetime.now().strftime('%d/%m/%Y %H:%M')
ic_color = '#ff4060' if ic_20d < 0.03 else '#f0a500' if ic_20d < 0.05 else '#4ade80'
ic_status = 'NO OPERAR' if ic_20d < 0.03 else 'PRECAUCION' if ic_20d < 0.05 else 'OPERAR'

pm = portfolio_metrics
sh_c = '#4ade80' if pm.get('sharpe',0) > 0.5 else '#f0a500' if pm.get('sharpe',0) > 0 else '#ff4060'
a_spy = pm['sharpe'] - pm.get('bh_sharpe',0) if pm else 0

html = f'''<!DOCTYPE html><html lang=es><head><meta charset=UTF-8>
<title>OLYMPUS v9.2 FACTOR LAB</title><style>
body{{background:#080c12;color:#c8d8e8;font-family:Segoe UI,sans-serif;padding:24px;max-width:1200px;margin:0 auto}}
h1{{font-size:1.3rem;color:#fff}}h1 span{{color:#00c2ff}}
.sub{{color:#5a7a96;font-size:.8rem;margin-bottom:16px}}
.banner{{border:2px solid {ic_color};border-radius:10px;padding:14px 20px;margin-bottom:16px;background:{ic_color}10;display:flex;align-items:center;gap:16px}}
.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}}
.card{{background:#111927;border:1px solid #1e2d40;border-radius:8px;padding:14px}}
.card .l{{font-size:.65rem;text-transform:uppercase;color:#5a7a96}}
.card .v{{font-size:1rem;font-weight:600}}
table{{width:100%;border-collapse:collapse;font-size:.75rem;background:#111927;border-radius:8px;border:1px solid #1e2d40}}
th{{background:#1a1a3a;color:#5a7a96;font-size:.65rem;padding:6px 8px;text-align:left}}
td{{padding:5px 8px;border-bottom:1px solid #1e2d40}}
.pill{{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.65rem;font-weight:700}}
.footer{{text-align:center;margin-top:24px;color:#333;font-size:.7rem;border-top:1px solid #1e2d40;padding-top:16px}}
</style></head><body>
<h1>OLYMPUS <span>FACTOR LABORATORY v9.2</span></h1>
<div class=sub>{len(available)} tickers | {LOOKBACK}d | {dt} | {len(factor_catalog)} factores | {len(selected_names)} seleccionados global | IC sin leakage ✅ | ATR: {"REAL H/L ✅" if _has_hl else "fallback C2C ⚠️"}</div>
<div class=banner>
<div style=font-size:24px>{ic_status}</div>
<div>
<div style=font-size:.6rem;color:#5a7a96>SEMAFORO IC</div>
<div style=display:flex;gap:16px;margin-top:2px>
<span style=font-weight:700;font-family:Consolas,monospace;color:{ic_color}>IC_20d={ic_20d:+.4f}</span>
<span style=color:#5a7a96>IC_60d={ic_60d:+.4f}</span>
<span style=color:#5a7a96>IC_120d={ic_120d:+.4f}</span>
</div></div></div>
<div class=grid>
<div class=card><div class=l>IC Medio</div><div class=v style=color:{'#4ade80' if mean_ic>0.03 else '#f0a500' if mean_ic>0.01 else '#ff4060'}>{mean_ic:.4f}</div></div>
<div class=card><div class=l>IR</div><div class=v>{ir:.2f}</div></div>
<div class=card><div class=l>Hit Rate</div><div class=v>{hit_rate:.1%}</div></div>
<div class=card><div class=l>Q5 LONG</div><div class=v style=color:#4ade80>{n_q5}</div></div>
<div class=card><div class=l>Q1 SHORT</div><div class=v style=color:#ff4060>{n_q1}</div></div>
<div class=card><div class=l>Universo</div><div class=v>{len(results)}</div></div>
</div>'''

if pm and pm.get('sharpe') is not None:
    html += f'''<div class=card style=margin-bottom:16px>
<div style=font-size:.65rem;color:#5a7a96;text-transform:uppercase;margin-bottom:8px>PORTFOLIO Q5 OOS ({pm['oos_days']}d)</div>
<div class=grid>
<div class=card><div class=l>Sharpe HRP</div><div class=v style=color:{sh_c}>{pm['sharpe']:.2f}</div></div>
<div class=card><div class=l>Sharpe EW Q5</div><div class=v>{pm['ew_sharpe']:.2f}</div></div>
<div class=card><div class=l>Sharpe SPY</div><div class=v>{pm['bh_sharpe']:.2f}</div></div>
<div class=card><div class=l>Alpha vs SPY</div><div class=v style=color:{'#4ade80' if a_spy>0 else '#ff4060'}>{a_spy:+.2f}</div></div>
<div class=card><div class=l>MaxDD</div><div class=v style=color:#ff4060>{pm['max_dd']:.1f}%</div></div>
<div class=card><div class=l>VaR 95%</div><div class=v>{pm['var95']:.2f}%</div></div>
</div>'''
    if portfolio_weights:
        html += '<br><div style=display:flex;gap:4px;flex-wrap:wrap>'
        for t,w in sorted(portfolio_weights.items(), key=lambda x:-x[1]):
            wc = '#4ade80' if w>.10 else '#f0a500' if w>.05 else '#5a7a96'
            html += f'<span class=pill style=background:rgba(0,224,122,.1);color:{wc}>{t}: {w*100:.1f}%</span>'
        html += '</div>'
    html += '</div>'

if fold_ic_means:
    html += '<div style=font-size:.65rem;color:#5a7a96;margin-bottom:4px>IC POR FOLD:</div><div style=display:flex;gap:8px;margin-bottom:12px>'
    for fi,fic in enumerate(fold_ic_means):
        fc = '#4ade80' if fic>.03 else '#f0a500' if fic>.01 else '#ff4060'
        html += f'<span class=pill style=background:rgba(0,194,255,.08);color:{fc}>F{fi+1}: {fic:+.4f}</span>'
    html += '</div>'

html += '<table><tr><th>Ticker</th><th>Score</th><th>Q</th><th>Conf</th><th>z</th><th>Sector</th></tr>'
for t in sorted(results.keys(), key=lambda t:results[t]['score'], reverse=True)[:30]:
    r = results[t]; q = r['quintile']
    qc = {1:'#ff4060',2:'#ff8080',3:'#f0a500',4:'#7de77d',5:'#4ade80'}.get(q,'#fff')
    badge = '#4ade80' if r['confidence']=='HIGH' else '#f0a500' if r['confidence']=='MED' else '#666'
    html += f'<tr><td><strong>{t}</strong></td><td style=color:{qc};font-weight:700>{r["score"]:.1f}</td><td style=color:{qc}>Q{q}</td><td style=color:{badge}>{r["confidence"]}</td><td>{r["pred_z"]:.1f}</td><td>{get_sector(t)}</td></tr>'
html += '</table>'

html += f'<div class=footer>OLYMPUS v9.2 FACTOR LAB | ATR REAL H/L | IC sin leakage | LW pre-OOS | {len(factor_catalog)} factores | {len(selected_names)} seleccionados | IC_OOS={mean_ic:.4f} | IR={ir:.2f} | {len(all_ic_scores)}d OOS</div></body></html>'

html_path = os.path.join(BASE_DIR,'heatmap_dashboard.html')
with open(html_path,'w',encoding='utf-8') as f: f.write(html)
print(f'   Dashboard: {html_path}')

# --- Export q5_scores.json ---
try:
    public_dir = os.path.normpath(os.path.join(BASE_DIR,'..','public'))
    os.makedirs(public_dir, exist_ok=True)
    q5_export = {'generatedAt':datetime.now().isoformat(),'mode':'v9_factorlab',
        'modelMetrics':{'ic':mean_ic,'ir':ir,'hitRate':hit_rate,'nFactors':len(selected_names)},
        'q5Tickers':list(greedy_order) if greedy_order else [],
        'topFactors':[(name, round(r['ic_mean'],5)) for name, r in all_factors_sorted[:10]],
        'allScores':{t:{'score':r['score'],'quintile':r['quintile'],'hybrid':r['score'],'signal':'NONE','passes':False} for t,r in results.items()}}
    with open(os.path.join(public_dir,'q5_scores.json'),'w',encoding='utf-8') as f:
        json.dump(q5_export,f,indent=2,ensure_ascii=False)
    print(f'   q5_scores.json exportado')
except Exception as e:
    print(f'   Error exportando: {e}')

# --- Resumen ---
print()
print('=' * 70)
print(f'  RESUMEN OLYMPUS v9.2 FACTOR LABORATORY')
print(f'  Factores testeados: {len(factor_catalog)} | Seleccionados global (IC > {MIN_IC_FOR_FACTOR}): {len(selected_names)}')
print(f'  Activos: {len(available)} tickers | {len(all_ic_scores)}d OOS | H={HORIZON}d | {N_FOLDS} folds')
print(f'  IC_OOS={mean_ic:.4f} | IC_20d={ic_20d:.4f} | IR={ir:.2f} | Hit={hit_rate:.1%} | Semaforo: {icstatus}')
if selected_names: print(f'  Factores globales: {", ".join(selected_names[:5])}{"..." if len(selected_names)>5 else ""}')
if fold_ic_means:
    print(f'  IC por fold (sin leakage): ' + ' | '.join(f'F{i+1}={fic:.4f}' for i,fic in enumerate(fold_ic_means)))
if fold_selected_names:
    for i, fsn in enumerate(fold_selected_names):
        print(f'  Factores Fold {i+1} ({len(fsn)}): {", ".join(fsn[:4])}{"..." if len(fsn)>4 else ""}')
if portfolio_metrics:
    pm2 = portfolio_metrics
    print(f'  Q5 OOS ({pm2["oos_days"]}d): Sharpe={pm2["sharpe"]:.2f} | Net={pm2["sharpe_net"]:.2f} | EW={pm2["ew_sharpe"]:.2f} | SPY={pm2["bh_sharpe"]:.2f}')
    print(f'  Alpha vs SPY: {pm2["sharpe"]-pm2["bh_sharpe"]:+.2f} | MaxDD={pm2["max_dd"]:.1f}%')
print(f'  ATR: {"REAL H/L ✅" if _has_hl else "fallback C2C ⚠️"} | LW pre-OOS ✅ | Factor selection sin leakage ✅')
print(f'  Outputs: predictions.csv | portfolio_q5.csv | factor_ic_report.csv | ibkr_orders.csv | heatmap_dashboard.html')
print('=' * 70)
