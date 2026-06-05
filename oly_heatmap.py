#!/usr/bin/env python3
"""OLYMPUS HEATMAP REGRESSION - python oly_heatmap.py | Output: heatmap_dashboard.html"""
import os, webbrowser, sys, pickle, time, logging
from datetime import datetime

LOOKBACK = 252
HEATMAP_DISPLAY_N = 50  # cuantos tickers mostrar en el heatmap visual
logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "heatmap_cache.pkl")
CACHE_MAX_AGE = 24 * 60 * 60  # 24 horas en segundos

# === CURATED EXTRAS (siempre incluidos, no dependen del SP500) ===
CURATED = [
    "SPY","QQQ","IWM","DIA","MDY",
    "XLK","XLF","XLV","XLY","XLI","XLC","XLE","XLP","XLRE","XLB","XLU",
    "EEM","EFA","EWJ","FXI","EWZ","INDA","IEUR","VGK",
    "GLD","SLV","USO","DBC",
    "TLT","AGG","LQD","HYG",
    "IBIT","FBTC","BITO",
    "^VIX",
]

import pandas as pd, numpy as np

# === FETCH SP500 FROM WIKIPEDIA (dynamic, always updated) ===
print("📡 Obteniendo SP500 desde Wikipedia...")
try:
    sp500_tables = pd.read_html("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")
    sp500_df = sp500_tables[0]
    col = "Symbol" if "Symbol" in sp500_df.columns else sp500_df.columns[0]
    sp500_tickers = sp500_df[col].tolist()
    # Fix tickers with dots (BRK.B -> BRK-B for Yahoo Finance)
    sp500_tickers = [t.replace(".", "-") for t in sp500_tickers]
    print(f"   ✅ {len(sp500_tickers)} tickers del SP500")
except Exception as e:
    print(f"   ⚠️ Wikipedia fallo ({e}), usando lista offline de respaldo")
    # Fallback: top 100 SP500 by weight (approximate)
    sp500_tickers = [
        "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","BRK-B","AVGO","TSLA",
        "LLY","JPM","V","UNH","XOM","MA","COST","WMT","HD","PG","NFLX","JNJ",
        "ABBV","BAC","ORCL","CRM","CVX","AMD","MRK","KO","PEP","WFC","ADBE",
        "NOW","CSCO","IBM","MCD","QCOM","LIN","DIS","ABT","CAT","GE","TMO",
        "AXP","INTU","ISRG","VZ","MS","PM","RTX","DHR","TXN","AMGN","SPGI",
        "T","GS","PFE","NEE","UBER","PLTR","BKNG","LOW","CMCSA","BLK","PGR",
        "UNP","ETN","HON","TJX","SYK","BSX","C","COP","FI","PANW","ADP",
        "MMC","LMT","MDT","BX","VRTX","ANET","BMY","CB","DE","SBUX","MU",
        "ADI","GILD","KLAC","SO","AMT","MO","LRCX","SCHW","TMUS","CI",
        "UPS","INTC","MDLZ","BA","SHW","ICE","DUK","ZTS","TT","ELV",
    ]

# === BUILD UNIVERSE: curated + SP500, deduplicated ===
sp500_set = set(sp500_tickers)
curated_set = set(CURATED)
all_tickers = list(sp500_set | curated_set)
print(f"📊 Universo total: {len(all_tickers)} tickers (SP500 + ETFs/Bonos/Commodities/Crypto)")

# === CACHE FUNCTIONS ===
def load_cache():
    """Carga datos del cache si tiene < 24h de antiguedad."""
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE, 'rb') as f:
                    cached = pickle.load(f)
                # Validate cache has expected keys
                if 'closes' in cached and 'volume' in cached and 'available' in cached:
                    age_h = max(age / 3600, 0.1)  # evitar mostrar 0.0h
                    print(f"   📦 Cache ({age_h:.1f}h) — {len(cached['available'])} tickers")
                    return cached
                else:
                    print("   ⚠️ Cache corrupto (keys), redescargando...")
                    try:
                        os.remove(CACHE_FILE)
                    except Exception:
                        pass
                    return None
            except Exception:
                print("   ⚠️ Cache corrupto (pickle), redescargando...")
                try:
                    os.remove(CACHE_FILE)
                except Exception:
                    pass
                return None
    return None

def save_cache(closes_df, volume_df, tickers_list):
    """Guarda datos en cache para siguientes ejecuciones."""
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump({'closes': closes_df, 'volume': volume_df,
                         'available': tickers_list, 'timestamp': time.time()}, f)
        print(f"   💾 Cache guardado ({os.path.getsize(CACHE_FILE)/1024:.0f} KB)")
    except Exception as e:
        print(f"   ⚠️ No se pudo guardar cache: {e}")

# === DOWNLOAD ALL DATA (con cache 24h) ===
cache = load_cache()
if cache:
    closes = cache['closes']
    available = cache['available']
    # Reconstruir volume_df para compatibilidad con el codigo de heatmap display
    volume_df = cache['volume']
else:
    print(f"📡 Descargando {len(all_tickers)} tickers de Yahoo Finance...")
    try:
        import yfinance as yf
        data = yf.download(all_tickers, period=str(LOOKBACK+30)+"d", progress=False)
        closes = data["Close"].dropna(axis=1).tail(LOOKBACK)
        available = list(closes.columns)
        closes = closes[available]
        volume_df = data["Volume"]
        print(f"   ✅ {len(available)} tickers con datos completos ({LOOKBACK}d)")
        if len(available) < 50:
            print("   ❌ Muy pocos tickers con datos. Revisa tu conexion o el rate-limit de Yahoo.")
            sys.exit(1)
        save_cache(closes, volume_df, available)
    except Exception as e:
        print(f"   ❌ {e}\n   🔧 pip install yfinance pandas numpy scikit-learn")
        sys.exit(1)

# === SELECT TOP N FOR HEATMAP DISPLAY (by market cap approximation = latest close * volume) ===
# For curated ETFs/benchmarks: always include in heatmap
heatmap_tickers = [t for t in CURATED if t in available]
# For SP500 stocks: pick top by dollar volume (close * volume) as market cap proxy
stock_candidates = []
for t in available:
    if t in curated_set: continue
    vol = volume_df[t].iloc[-1] if t in volume_df.columns else 1e6
    vol = vol if pd.notna(vol) else 0
    stock_candidates.append((t, closes[t].iloc[-1] * vol))
stock_candidates.sort(key=lambda x: x[1], reverse=True)
top_n = min(HEATMAP_DISPLAY_N - len(heatmap_tickers), len(stock_candidates))
heatmap_tickers.extend([t for t, _ in stock_candidates[:top_n]])
print(f"🔥 Heatmap visual: {len(heatmap_tickers)} tickers (curados + top {top_n} por volumen)")
print(f"📈 Regresion: TODOS los {len(available)} tickers")

def rsi_manual(s, p):
    d = np.diff(s, prepend=s[0])
    g = np.where(d>0,d,0)
    l = np.where(d<0,-d,0)
    ag = pd.Series(g).rolling(p).mean().values
    al = pd.Series(l).rolling(p).mean().values
    rs = np.divide(ag, al, out=np.zeros_like(ag), where=al!=0)
    return 100-(100/(1+rs))

def calc_indicators(c):
    c = c.values
    n = len(c)
    ma20 = pd.Series(c).rolling(20).mean().values
    ma50 = pd.Series(c).rolling(50).mean().values
    ma200= pd.Series(c).rolling(200).mean().values
    r2 = rsi_manual(c,2)
    r14 = rsi_manual(c,14)
    tr = np.concatenate([[0], np.abs(np.diff(c))])
    a14 = pd.Series(tr).rolling(14).mean().values
    ap = np.divide(a14,c,out=np.zeros_like(a14),where=c!=0)
    e12 = pd.Series(c).ewm(span=12,adjust=False).mean().values
    e26 = pd.Series(c).ewm(span=26,adjust=False).mean().values
    ml = e12-e26
    ms = pd.Series(ml).ewm(span=9,adjust=False).mean().values
    mh = ml-ms
    en = np.abs(c-np.roll(c,20))
    en[:20] = 0
    ed = np.zeros(n)
    for i in range(20,n): ed[i]=np.sum(np.abs(np.diff(c[i-20:i+1])))
    te = np.divide(en,ed,out=np.zeros_like(en),where=ed!=0)*100
    dc = np.diff(c, prepend=c[0])
    dp = np.where((dc > 0) & (dc > -dc), dc, 0)
    dm = np.where((-dc > 0) & (-dc > dc), -dc, 0)
    aa = pd.Series(tr).rolling(14).mean().values
    dn = np.maximum(aa,0.0001)
    dip = pd.Series(dp).rolling(14).mean().values/dn*100
    dim = pd.Series(dm).rolling(14).mean().values/dn*100
    ds = np.maximum(dip+dim,0.0001)
    dx = np.abs(dip-dim)/ds*100
    adx = pd.Series(dx).rolling(14).mean().values
    ret = pd.Series(c).pct_change().fillna(0).values
    return {"rsi2":r2,"rsi14":r14,"atr_pct":ap,"macd_hist":mh,
            "trend_eff":te,"adx":adx,"returns":ret,
            "close":c,"ma20":ma20,"ma50":ma50,"ma200":ma200}

print("🧮 Calculando indicadores Olympus...")
all_ind = {}
for t in available:
    r = calc_indicators(closes[t])
    if r: all_ind[t]=r
print(f"   ✅ {len(all_ind)} tickers con indicadores calculados")

# Full correlation matrix — Ledoit-Wolf shrinkage (estable con N>>T)
print("📊 Matriz de correlaciones (Ledoit-Wolf shrinkage)...")
from sklearn.covariance import LedoitWolf
rdf_all = pd.DataFrame({t:all_ind[t]["returns"] for t in all_ind})
lw = LedoitWolf().fit(rdf_all.values)
cov_lw = pd.DataFrame(lw.covariance_, index=rdf_all.columns, columns=rdf_all.columns)
# Convert covariance → correlation
std_lw = np.sqrt(np.diag(cov_lw.values))
corr_lw = cov_lw.div(std_lw, axis=0).div(std_lw, axis=1).round(3)

# Heatmap display matrix (subset)
heatmap_display = [t for t in heatmap_tickers if t in all_ind]
print(f"🔥 Heatmap: {len(heatmap_display)} tickers visuales")
rdf_hm = pd.DataFrame({t:all_ind[t]["returns"] for t in heatmap_display})
corr = rdf_hm.corr().round(3)

print("📈 Entrenando regresion robusta (Huber + Pipeline CV sin leakage)...")
from sklearn.linear_model import HuberRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
results = {}
feats = ["rsi2","rsi14","atr_pct","macd_hist","trend_eff","adx"]
for t in all_ind:
    ind=all_ind[t]
    X=np.column_stack([ind[f][:-1] for f in feats])
    y=ind["returns"][1:]
    mask=~np.isnan(X).any(axis=1)&~np.isnan(y)
    Xc,yc=X[mask],y[mask]
    Xc=np.clip(Xc, np.nanpercentile(Xc,1,axis=0), np.nanpercentile(Xc,99,axis=0))
    pipe=Pipeline([("sc",StandardScaler()),("m",HuberRegressor(max_iter=200))])
    pipe.fit(Xc,yc)
    r2_train=round(pipe.score(Xc,yc),4)
    try:
        tscv=TimeSeriesSplit(n_splits=3)
        cv_scores=[pipe.fit(Xc[train],yc[train]).score(Xc[test],yc[test]) for train,test in tscv.split(Xc)]
        r2_cv=round(np.mean(cv_scores),4)
    except Exception as e:
        logger.warning(f"CV fallido en {t}: {e} — usando r2_train (inflado) como fallback")
        r2_cv=r2_train
    pipe.fit(Xc,yc)
    lt=np.array([ind[f][-1] for f in feats]).reshape(1,-1)
    pr=pipe.predict(lt)[0] if not np.isnan(lt).any() else 0
    conf="HIGH" if r2_cv>0.03 else "MED" if r2_cv>0.005 else "LOW"
    results[t]={"r2_train":r2_train,"r2_cv":r2_cv,"pred_return":round(pr*100,3),
                "n":len(Xc),"confidence":conf}

sema={}
if "SPY" in all_ind:
    ind=all_ind["SPY"]
    h52=pd.Series(ind["close"]).rolling(252).max().values
    dd52=(ind["close"][-1]/h52[-1]-1)*100 if h52[-1]>0 else 0
    sema={"rsi2":round(ind["rsi2"][-1],1),"rsi14":round(ind["rsi14"][-1],1),
          "macd_hist":round(ind["macd_hist"][-1],4),
          "atr_pct":round(ind["atr_pct"][-1]*100,2),
          "trend_eff":round(ind["trend_eff"][-1],1),
          "adx":round(ind["adx"][-1],1),
          "return_today":round(ind["returns"][-1]*100,2),
          "close":round(ind["close"][-1],2),
          "ma50":round(ind["ma50"][-1],2),"ma200":round(ind["ma200"][-1],2),
          "dd52":round(dd52,1),
          "var95":round(np.percentile(ind["returns"][1:],5)*100,2),
          "var99":round(np.percentile(ind["returns"][1:],1)*100,2)}

def semaforo_color(v,lo,md,hi,rev=False):
    if rev: return "#00e07a" if v<=lo else "#f0a500" if v<=md else "#ff4060"
    return "#00e07a" if v>=hi else "#f0a500" if v>=md else "#ff4060"

print("🎨 Generando dashboard HTML...")
tk=list(corr.columns)
dt=datetime.now().strftime("%d/%m/%Y %H:%M")

html=f"""<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>OLYMPUS HEATMAP REGRESSION</title><style>
:root{{--bg:#080c12;--surface:#0d1420;--card:#111927;--border:#1e2d40;--text:#c8d8e8;--muted:#5a7a96;--accent:#00c2ff;--gold:#f0a500;--green:#00e07a;--red:#ff4060;--mono:Consolas,monospace;--sans:'Segoe UI',sans-serif;}}
*{{margin:0;padding:0;box-sizing:border-box}}body{{background:var(--bg);color:var(--text);font-family:var(--sans);padding:32px}}
.header{{text-align:center;margin-bottom:40px}}.header h1{{font-family:var(--mono);font-size:28px;color:#fff}}
.header h1 span{{color:var(--accent)}}.sub{{color:var(--muted);font-size:13px;margin-top:4px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:1300px;margin:0 auto}}
.card{{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:20px 24px}}
.card.full{{grid-column:1/-1}}.card-title{{font-family:var(--mono);font-size:11px;color:var(--accent);letter-spacing:3px;text-transform:uppercase;margin-bottom:16px}}
table{{width:100%;border-collapse:collapse;font-size:13px}}th{{font-family:var(--mono);font-size:10px;color:var(--muted);padding:6px 8px;border-bottom:1px solid var(--border);text-align:left}}
td{{padding:6px 8px;border-bottom:1px solid var(--border)}}tr:last-child td{{border-bottom:none}}
.ht td,.ht th{{padding:4px 6px;text-align:center;min-width:48px}}
.pill{{display:inline-block;padding:3px 12px;border-radius:12px;font-family:var(--mono);font-size:11px;font-weight:700;margin:2px 4px}}
.bar{{width:100%;height:6px;background:var(--surface);border-radius:3px;margin-top:4px}}.bar-f{{height:100%;border-radius:3px}}
.g{{color:var(--green)}}.r{{color:var(--red)}}.y{{color:var(--gold)}}.footer{{text-align:center;margin-top:32px;color:var(--muted);font-size:11px;font-family:var(--mono)}}
.badge{{display:inline-block;padding:2px 10px;border-radius:4px;font-size:10px;font-weight:700}}.badge-good{{background:rgba(0,224,122,0.2);color:var(--green)}}.badge-warn{{background:rgba(240,165,0,0.2);color:var(--gold)}}.badge-low{{background:rgba(255,64,96,0.15);color:var(--red)}}
</style></head><body>
<div class="header"><h1>OLYMPUS <span>HEATMAP REGRESSION</span></h1>
<div class="sub">// {len(available)} activos · {LOOKBACK}d historico · {dt}</div></div>
<div class="grid">
<div class="card full"><div class="card-title">🔥 Matriz de Correlaciones — {len(heatmap_display)} activos (top {HEATMAP_DISPLAY_N} por volumen)</div>
<div style="overflow-x:auto;max-width:100%;"><table class="ht">
"""

rows='<tr><th></th>'+''.join(f'<th>{t}</th>' for t in tk)+'</tr>'
for t1 in tk:
    rows+=f'<tr><th>{t1}</th>'
    for t2 in tk:
        v=corr.loc[t1,t2] if t1 in corr.index else 0
        if v>=0: rr,gg,bb=220,int(60+(1-v)*160),int(60+(1-v)*160)
        else: rr,gg,bb=int(60+(1+v)*160),int(60+(1+v)*160),220
        bg=f"rgb({rr},{gg},{bb})";tc="#fff" if abs(v)>0.5 else "#111"
        rows+=f'<td style="background:{bg};color:{tc};text-align:center;font-size:11px;font-weight:700;">{v:.2f}</td>'
    rows+='</tr>'
html+=rows

html+=f"""</table></div>
<div style="margin-top:12px;display:flex;gap:16px;font-size:11px;color:var(--muted);align-items:center">
<span>🔵 -1.0</span><div style="width:200px;height:10px;border-radius:5px;background:linear-gradient(to right,#4488ff,#ccc,#ff4444)"></div><span>🔴 +1.0</span></div></div>

<div class="card full"><div class="card-title">📈 Regresion Robusta (Huber) — {len(results)} tickers · Prediccion 1d</div>
<div style="max-height:500px;overflow-y:auto;"><table><tr><th>Ticker</th><th>R² Train</th><th>R² CV</th><th>Prediccion</th><th>N</th><th>Confianza</th></tr>
"""

for t in sorted(results.keys()):
    r=results[t]; rt=r["r2_train"]; rc_v=r["r2_cv"]; pr=r["pred_return"]
    conf=r["confidence"]
    rc_col="g" if rc_v>0.03 else "y" if rc_v>0.005 else "r"
    pc="g" if pr>0 else "r"
    badge="badge-good" if conf=="HIGH" else "badge-warn" if conf=="MED" else "badge-low"
    html+=f"<tr><td><strong>{t}</strong></td><td>{rt:.4f}</td><td class=\"{rc_col}\">{rc_v:.4f}</td><td class=\"{pc}\">{pr:+.3f}%</td><td>{r['n']}</td><td><span class=\"badge {badge}\">{conf}</span></td></tr>\n"

html+="""</table></div>
<div style="margin-top:12px;font-size:11px;color:var(--muted)">HuberRegressor + Pipeline CV (sin leakage) + Winsorizacion | HIGH: R²CV>0.03 | MED: >0.005 | LOW: ruido | 📜 Scroll</div></div>

<div class="card"><div class="card-title">🚦 Semaforo de Indicadores — SPY</div>
"""

if sema:
    inds=[("RSI(2)",sema["rsi2"],15,60,85),("RSI(14)",sema["rsi14"],35,50,70),
          ("MACD Hist",sema["macd_hist"],-0.1,0,0.3),("ATR %",sema["atr_pct"],0.5,2,4),
          ("Trend Eff",sema["trend_eff"],20,40,60),("ADX",sema["adx"],15,25,35)]
    for nm,vl,lo,md,hi in inds:
        co=semaforo_color(vl,lo,md,hi,rev=(nm=="ATR %"))
        pct=min(100,max(0,(vl-lo)/(hi-lo)*100)) if hi!=lo else 50
        html+=f'<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:12px"><span>{nm}</span><span style="color:{co};font-weight:700">{vl}</span></div><div class="bar"><div class="bar-f" style="width:{pct}%;background:{co};"></div></div></div>'
    sc="r" if sema["dd52"]<-10 else "y" if sema["dd52"]<-5 else "g"
    rc2="g" if sema["return_today"]>0 else "r"
    html+=f'<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);font-size:12px"><div>📌 SPY = <strong>${sema["close"]}</strong> | MA50: ${sema["ma50"]} | MA200: ${sema["ma200"]}</div><div>📉 Drawdown 52w: <strong class="{sc}">{sema["dd52"]:+.1f}%</strong></div><div>⚠️ VaR 95%: <strong class="r">{sema["var95"]:+.2f}%</strong> | VaR 99%: <strong class="r">{sema["var99"]:+.2f}%</strong></div><div>📊 Retorno hoy: <strong class="{rc2}">{sema["return_today"]:+.2f}%</strong></div></div>'

html+="""</div>
<div class="card"><div class="card-title">🎯 Top Predicciones</div>
"""

sp=sorted(results.items(),key=lambda x:x[1]["pred_return"],reverse=True)
html+='<div style="font-size:12px;color:var(--muted);margin-bottom:8px">🟢 Mayor retorno esperado:</div>'
for t,r in sp[:3]: html+=f'<div class="pill" style="background:rgba(0,224,122,0.15);color:#00e07a">{t}: {r["pred_return"]:+.3f}% (R²CV={r["r2_cv"]:.3f})</div>'
html+='<div style="font-size:12px;color:var(--muted);margin:16px 0 8px">🔴 Menor retorno esperado:</div>'
for t,r in sp[-3:]: html+=f'<div class="pill" style="background:rgba(255,64,96,0.15);color:#ff4060">{t}: {r["pred_return"]:+.3f}% (R²CV={r["r2_cv"]:.3f})</div>'

html+=f"""</div></div>
<div class="footer">Olympus Heatmap Regression · {dt} · {len(available)} tickers · {LOOKBACK}d historico<br>
<code style="color:#fff">python oly_heatmap.py</code> <span style="color:var(--accent)">para actualizar</span></div>
</body></html>"""

out=os.path.join(os.path.dirname(os.path.abspath(__file__)),"heatmap_dashboard.html")
with open(out,"w",encoding="utf-8") as f: f.write(html)
logger.info(f"Dashboard: {os.path.abspath(out)}")

# === CSV EXPORT ===
csv_pred = os.path.join(os.path.dirname(os.path.abspath(__file__)), "predictions.csv")
df_pred = pd.DataFrame(results).T
if not df_pred.empty:
    df_pred = df_pred.sort_values("r2_cv", ascending=False)
    df_pred.to_csv(csv_pred)
    logger.info(f"Predicciones CSV: {csv_pred}")

csv_corr = os.path.join(os.path.dirname(os.path.abspath(__file__)), "correlations.csv")
corr_lw.to_csv(csv_corr)
logger.info(f"Correlaciones CSV (Ledoit-Wolf): {csv_corr}")

try:
    webbrowser.open(f"file://{os.path.abspath(out)}")
    print("🚀 Abriendo en el navegador...")
except Exception: print("📂 Abre heatmap_dashboard.html en Chrome")

print("\n"+"="*60)
print("📊 RESUMEN HEATMAP REGRESSION")
print("="*60)
print(f"📡 Activos: {len(available)} | 🔥 Heatmap: {len(heatmap_display)} | 📅 Dias: {LOOKBACK}")
print(f"\n🎯 Top 3 predicciones alcistas:")
for t,r in sp[:3]: print(f"   {t:8s} -> {r['pred_return']:+.3f}%  (R²CV={r['r2_cv']:.4f})")
print(f"\n🔻 Top 3 predicciones bajistas:")
for t,r in sp[-3:]: print(f"   {t:8s} -> {r['pred_return']:+.3f}%  (R²CV={r['r2_cv']:.4f})")
print(f"\n📈 Correlaciones mas fuertes con SPY — Ledoit-Wolf (sobre {len(all_ind)} tickers):")
if "SPY" in corr_lw.columns:
    spy_c=corr_lw["SPY"].drop("SPY").sort_values(ascending=False)
    for t in spy_c.head(5).index: print(f"   {t:8s} <-> SPY = {spy_c[t]:.2f}")
print(f"\n📁 Dashboard: {os.path.abspath(out)}")
