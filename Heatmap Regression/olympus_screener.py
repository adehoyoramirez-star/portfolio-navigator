#!/usr/bin/env python3
"""olympus_screener.py v2.2 - Q5 vs Pine Cross-Screen"""
import os, sys, time, pickle
from datetime import datetime
import pandas as pd
import numpy as np
import yfinance as yf
from concurrent.futures import ThreadPoolExecutor, as_completed

CWD = os.path.dirname(os.path.abspath(__file__))
PRED_PATH = os.path.join(CWD, "predictions.csv")
OUTPUT_PATH = os.path.join(CWD, "oportunidades.csv")
CACHE_PATH = os.path.join(CWD, ".screener_cache.pkl")
CACHE_TTL = 3600
MAX_WORKERS = 6

ETFS = {"TLT","AGG","LQD","HYG","SPY","QQQ","IWM","DIA","EFA","EEM","EWJ","EWZ","FXI","VGK","IEUR","MDY","XLI","XLK","XLY","XLE","XLB","XLF","XLV","XLU","XLP","XLRE","XLC","DBC","USO","SLV","GLD"}

import json

TACTICAL_SYMBOLS_PATH = os.path.normpath(os.path.join(CWD, "..", "public", "tactical_universe_symbols.json"))

def load_q5():
    pred = pd.read_csv(PRED_PATH)
    tc = pred.columns[0]
    sc = pred.columns[1]
    qc = pred.columns[2]
    q5 = pred[pred[qc]==5].sort_values(sc, ascending=False)
    tickers = q5[tc].tolist()[:50]
    scores = dict(zip(q5[tc], q5[sc]))
    return tickers, scores

def load_tactical_symbols():
    """Carga símbolos del universo táctico para que el screener los revise."""
    if not os.path.exists(TACTICAL_SYMBOLS_PATH):
        print("   ⚠️ tactical_universe_symbols.json no encontrado")
        return [], {}
    try:
        with open(TACTICAL_SYMBOLS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        symbols = data.get("yahooSymbols", [])
        # Score por defecto 50.0 para tickers tácticos sin score ML
        scores = {s: 50.0 for s in symbols}
        print(f"   ✅ {len(symbols)} símbolos del universo táctico cargados")
        return symbols, scores
    except Exception as e:
        print(f"   ⚠️ Error cargando universo táctico: {e}")
        return [], {}

def dl_with_retry(ticker, max_retries=3):
    for attempt in range(max_retries):
        try:
            # 1y para tener datos para MA200 y 52w high (SECTOR_ROT)
            d = yf.download(ticker, period="1y", progress=False, auto_adjust=True)
            if d is not None and len(d) >= 50:
                return d
        except:
            pass
        if attempt < max_retries - 1:
            time.sleep(2 * (attempt + 1))
    return None

def get_cache():
    if os.path.exists(CACHE_PATH):
        try:
            age = time.time() - os.path.getmtime(CACHE_PATH)
            if age < CACHE_TTL:
                with open(CACHE_PATH, "rb") as f:
                    return pickle.load(f)
        except:
            pass
    return None

def save_cache(df):
    try:
        with open(CACHE_PATH, "wb") as f:
            pickle.dump(df, f)
    except:
        pass

def check(ticker, score, df):
    # Force Series for MultiIndex yfinance returns
    if isinstance(df.columns, pd.MultiIndex):
        close = df["Close"].iloc[:, 0].astype(float)
        high = df["High"].iloc[:, 0].astype(float)
        low = df["Low"].iloc[:, 0].astype(float)
    else:
        close = df["Close"].astype(float)
        high = df["High"].astype(float)
        low = df["Low"].astype(float)
    
    n = len(close)
    c = float(close.iloc[-1])
    
    # --- MEDIAS MÓVILES ---
    ma20 = float(close.rolling(20).mean().iloc[-1]) if n >= 20 else c
    ma50 = float(close.rolling(50).mean().iloc[-1]) if n >= 50 else c
    if n >= 200:
        ma200 = float(close.rolling(200).mean().iloc[-1])
        aboveMA200 = c > ma200
    else:
        ma200 = c
        aboveMA200 = True  # Si no hay datos, no filtramos
    aboveMA50 = c > ma50 if n >= 50 else True
    
    # --- BOLLINGER BANDS (20,2) ---
    bb_mid = float(close.rolling(20).mean().iloc[-1]) if n >= 20 else c
    bb_std = float(close.rolling(20).std().iloc[-1]) if n >= 20 else c * 0.05
    bb_upper = bb_mid + 2.0 * bb_std
    bb_lower = bb_mid - 2.0 * bb_std
    
    # --- Z-SCORE (20 días) ---
    std20 = float(close.rolling(20).std().iloc[-1]) if n >= 20 else 1.0
    zScore20 = (c - ma20) / std20 if std20 > 0 else 0.0
    
    # --- RSI2 (Wilder) ---
    delta = close.diff()
    g2 = delta.where(delta>0,0.0).rolling(2).mean()
    l2 = (-delta.where(delta<0,0.0)).rolling(2).mean()
    lr2 = float(g2.iloc[-1]) / float(l2.iloc[-1]) if float(l2.iloc[-1]) > 0 else 0.0
    r2 = 50.0
    if lr2 > 0 and lr2 not in [np.inf, -np.inf]:
        r2 = 100.0 - (100.0 / (1.0 + lr2))
    
    # --- RSI14 (Wilder) ---
    g14 = delta.where(delta>0,0.0).rolling(14).mean()
    l14 = (-delta.where(delta<0,0.0)).rolling(14).mean()
    lr14 = float(g14.iloc[-1]) / float(l14.iloc[-1]) if float(l14.iloc[-1]) > 0 else 0.0
    r14 = 50.0
    if lr14 > 0 and lr14 not in [np.inf, -np.inf]:
        r14 = 100.0 - (100.0 / (1.0 + lr14))
    
    # --- TREND EFFICIENCY (20d) ---
    # net change / path length
    if n >= 21:
        net_change = abs(float(close.iloc[-1]) - float(close.iloc[-21]))
        path_len = sum(abs(float(close.iloc[-i]) - float(close.iloc[-(i+1)])) for i in range(1, 21))
        trend_eff = (net_change / path_len * 100) if path_len > 0 else 0.0
    else:
        trend_eff = 0.0
    
    # --- VOLUMEN ---
    if isinstance(df.columns, pd.MultiIndex):
        vol_series = df["Volume"].iloc[:, 0].astype(float) if "Volume" in df.columns.get_level_values(0) else None
    else:
        vol_series = df["Volume"].astype(float) if "Volume" in df.columns else None
    volRatio = 1.0
    if vol_series is not None and len(vol_series) >= 20:
        vol_avg = float(vol_series.rolling(20).mean().iloc[-1])
        vol_curr = float(vol_series.iloc[-1])
        if vol_avg > 0:
            volRatio = vol_curr / vol_avg
    
    # --- DRAWDOWN 52w ---
    if n >= 252:
        h52w = float(close.rolling(252).max().iloc[-1])
    else:
        h52w = float(close.max())
    drawdown52w = (c / h52w - 1) if h52w > 0 else 0.0
    inExtremeCrash = drawdown52w < -0.35
    
    # --- Z-SCORE 50 (real) ---
    if n >= 50:
        ma50_std = float(close.rolling(50).std().iloc[-1])
        zScore50 = (c - ma50) / ma50_std if ma50_std > 0 else 0.0
    else:
        zScore50 = 0.0
    
    # --- 5 SEÑALES (lógica Pine Script v10.4) ---
    # 1. BLOOD: rsi2<10 + zScore20<-1.5 + (aboveMA200 or extremeCrash)
    blood = r2 < 10.0 and zScore20 < -1.5 and (aboveMA200 or inExtremeCrash)
    blood_score = 45.0 + (10.0 - min(10.0, r2)) * 4.0 + max(0.0, abs(zScore20) - 1.5) * 5.0 + (8.0 if volRatio > 1.5 else 0.0) + (-15.0 if not aboveMA200 else 0.0) if blood else 0.0
    blood_score = min(100.0, max(0.0, blood_score)) if blood else 0.0
    
    # 2. MR (Mean Reversion): rsi2<15 + close < bbLower * 1.02
    mr = r2 < 15.0 and c < bb_lower * 1.02
    mr_score = 40.0 + (15.0 - min(15.0, r2)) * 2.0 + (12.0 if c < bb_lower else 4.0) + (8.0 if zScore20 < -1.5 else 0.0) if mr else 0.0
    mr_score = min(100.0, max(0.0, mr_score)) if mr else 0.0
    
    # 3. MOMENTUM: trend_eff>30 + close>bbUpper*0.995 + aboveMA50
    mom = trend_eff > 30.0 and c > bb_upper * 0.995 and aboveMA50
    mom_score = 45.0 + min(20.0, (trend_eff - 30.0) * 1.2) + (20.0 if volRatio > 1.5 else 0.0) + (15.0 if c > bb_upper else 5.0) if mom else 0.0
    mom_score = min(100.0, max(0.0, mom_score)) if mom else 0.0
    
    # 4. OVERSOLD (OB): rsi14<35 + (aboveMA200 or close>ma50*0.95)
    ob = r14 < 35.0 and (aboveMA200 or c > ma50 * 0.95)
    ob_score = 42.0 + (35.0 - min(35.0, r14)) * 1.8 + (18.0 if aboveMA200 else 6.0) + (8.0 if zScore50 < -1.0 else 0.0) if ob else 0.0
    ob_score = min(100.0, max(0.0, ob_score)) if ob else 0.0
    
    # 5. SECTOR_ROT: drawdown>-40% + <-20% + rsi14>40<55 + (aboveMA200 or aboveMA50)
    sec = drawdown52w > -0.40 and drawdown52w < -0.20 and r14 > 40.0 and r14 < 55.0 and (aboveMA200 or aboveMA50)
    sec_score = 40.0 + min(25.0, (abs(drawdown52w) - 0.20) * 100.0) + (20.0 if aboveMA200 else 5.0) + (15.0 if volRatio > 1.2 else 0.0) if sec else 0.0
    sec_score = min(100.0, max(0.0, sec_score)) if sec else 0.0
    
    # --- PESOS (igual que Pine: blood=1.0, mom=0.8, mr=0.7, ob=0.5, sec=0.4) ---
    w_blood, w_mom, w_mr, w_ob, w_sec = 1.0, 0.8, 0.7, 0.5, 0.4
    weighted_sum = 0.0
    total_weight = 0.0
    n_active = 0
    
    if blood:
        weighted_sum += blood_score * w_blood
        total_weight += w_blood
        n_active += 1
    if mr:
        weighted_sum += mr_score * w_mr
        total_weight += w_mr
        n_active += 1
    if mom:
        weighted_sum += mom_score * w_mom
        total_weight += w_mom
        n_active += 1
    if ob:
        weighted_sum += ob_score * w_ob
        total_weight += w_ob
        n_active += 1
    if sec:
        weighted_sum += sec_score * w_sec
        total_weight += w_sec
        n_active += 1
    
    # Señal principal = la de mayor score*peso
    best_sig = "NONE"
    best_val = 0.0
    if blood and blood_score * w_blood > best_val:
        best_val = blood_score * w_blood
        best_sig = "BLOOD"
    if mr and mr_score * w_mr > best_val:
        best_val = mr_score * w_mr
        best_sig = "MR"
    if mom and mom_score * w_mom > best_val:
        best_val = mom_score * w_mom
        best_sig = "MOMENTUM"
    if ob and ob_score * w_ob > best_val:
        best_val = ob_score * w_ob
        best_sig = "OB"
    if sec and sec_score * w_sec > best_val:
        best_val = sec_score * w_sec
        best_sig = "SECTOR_ROT"
    
    # Opportunity (versión simplificada del Pine)
    confluence_bonus = 10.0 if n_active >= 3 else 5.0 if n_active == 2 else 0.0
    opp_raw = (weighted_sum / total_weight) if total_weight > 0 else 0.0
    opp = min(100.0, round(opp_raw + confluence_bonus))
    
    # Régimen simplificado
    regime = "UP" if c > ma50 else "DOWN"
    
    # R:R compuesto (60% TP1 + 40% TP2, como Pine)
    risk = max(c * 0.01, c * 0.02)  # 1% de precio o ~2 ATR
    rr = ((risk * 2.0) / risk) * 0.6 + ((risk * 3.2) / risk) * 0.4  # = 2.48
    
    # Filtros simplificados: pasa si tiene señal + RR mínimo
    passes = n_active > 0 and rr >= 1.5
    
    # Entry timing (basado en RSI2, como Pine)
    if 60.0 <= r2 <= 75.0:
        entry = "CONFIRMED"
    elif r2 > 85.0:
        entry = "EXTREME"
    elif r2 > 75.0:
        entry = "HOT"
    else:
        entry = "EARLY"
    
    # Hybrid score (Python + Pine combinado, como el Hybrid del Pine)
    hybrid = round(min(100.0, float(score) * 0.4 + opp * 0.6), 1)
    
    return {
        "ticker":ticker, "py_score":round(float(score),1),
        "pine_opp":round(opp,1), "hybrid":hybrid,
        "signal":best_sig, "n_signals":n_active,
        "regime":regime, "rr":round(rr,2),
        "passes":passes, "rsi2":round(r2,1), "rsi14":round(r14,1),
        "entry":entry, "price":round(c,2),
        "blood":"YES" if blood else "", "mom":"YES" if mom else "",
        "mr":"YES" if mr else "", "ob":"YES" if ob else "",
        "sec":"YES" if sec else ""
    }

def generate_html(df, con, dt_str):
    """Genera oportunidades.html con los datos embebidos en OPORTUNIDADES"""
    html_path = os.path.join(CWD, "oportunidades.html")
    
    # Construir array JS con hasta 15 tickers (señal activa primero)
    df_sorted = df.sort_values(["passes", "hybrid"], ascending=[False, False])
    items = []
    for _, r in df_sorted.head(15).iterrows():
        sig = r["signal"] if r["signal"] else "NONE"
        entry = r["entry"] if r["entry"] else "EARLY"
        price = r.get("price", 0) if not pd.isna(r.get("price", 0)) else 0
        items.append(f'    {{ticker:"{r["ticker"]}", xetra:"{r["ticker"]}.DE", score:{r["py_score"]}, signal:"{sig}", price:{price}, entry:"{entry}"}}')
    
    js_array = "[\n" + ",\n".join(items) + "\n  ]"
    
    html = f'''<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>OLYMPUS XTB EDITION — Capital editable + Pesos</title>
<style>
:root{{--bg:#080c12;--surface:#0d1420;--card:#111927;--border:#1e2d40;--text:#c8d8e8;--muted:#5a7a96;--accent:#00c2ff;--gold:#f0a500;--green:#00e07a;--red:#ff4060;--mono:Consolas,monospace;--sans:'Segoe UI',sans-serif}}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:var(--bg);color:var(--text);font-family:var(--sans);padding:24px;max-width:1200px;margin:0 auto}}
h1{{font-family:var(--mono);font-size:26px;color:#fff;border-bottom:2px solid var(--accent);padding-bottom:8px;margin-bottom:4px}}
h1 span{{color:var(--accent)}}
.sub{{color:var(--muted);font-size:12px;margin-bottom:20px}}
.section-title{{font-family:var(--mono);font-size:13px;color:var(--accent);letter-spacing:2px;text-transform:uppercase;margin:24px 0 10px;border-left:3px solid var(--accent);padding-left:10px}}
.card{{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:14px}}
table{{width:100%;border-collapse:collapse;font-size:11px}}
th{{font-family:var(--mono);font-size:9px;color:var(--muted);padding:4px 5px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}}
td{{padding:4px 5px;border-bottom:1px solid rgba(30,45,64,0.4)}}
tr:last-child td{{border-bottom:none}}
.g{{color:var(--green)}}.r{{color:var(--red)}}.y{{color:var(--gold)}}
.num{{font-family:var(--mono);font-size:10px;text-align:right}}
.xetra{{font-size:9px;color:var(--muted);font-family:var(--mono)}}
.footer{{text-align:center;margin-top:24px;color:var(--muted);font-size:10px;font-family:var(--mono)}}
.sig{{display:inline-block;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700}}
.sig-blood{{background:#dc262644;color:#ef4444}}
.sig-mom{{background:#22c55e44;color:#4ade80}}
.sig-mr{{background:#ea580c44;color:#fb923c}}
.sig-ob{{background:#06b6d444;color:#22d3ee}}
.sig-sec{{background:#3b82f644;color:#60a5fa}}
.sig-none{{background:#5a7a9633;color:#5a7a96}}
.pill{{display:inline-block;padding:1px 8px;border-radius:8px;font-size:9px;font-weight:700}}
.pill-g{{background:rgba(0,224,122,0.2);color:var(--green)}}
.pill-r{{background:rgba(255,64,96,0.15);color:var(--red)}}
.pill-y{{background:rgba(240,165,0,0.2);color:var(--gold)}}
.alert{{background:rgba(0,194,255,0.06);border:1px solid var(--accent);border-radius:6px;padding:8px 12px;font-size:11px;margin-bottom:14px}}
.summary{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}}
.summary-item{{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:10px 14px;flex:1;min-width:100px}}
.summary-item .val{{font-size:20px;font-weight:700;font-family:var(--mono)}}
.summary-item .lbl{{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}}
.capital-box{{background:var(--card);border:2px solid var(--accent);border-radius:10px;padding:14px 20px;margin-bottom:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}}
.capital-box label{{font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}}
.capital-box input{{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-family:var(--mono);font-size:18px;color:#fff;width:130px;text-align:center;font-weight:700}}
.capital-box input:focus{{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgba(0,194,255,0.2)}}
.capital-box .presets{{display:flex;gap:4px}}
.capital-box .preset-btn{{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:4px 10px;font-size:11px;font-family:var(--mono);color:var(--muted);cursor:pointer;transition:all 0.15s}}
.capital-box .preset-btn:hover{{background:rgba(0,194,255,0.1);border-color:var(--accent);color:var(--accent)}}
.capital-stats{{display:flex;gap:20px;margin-left:auto;font-size:11px;font-family:var(--mono);color:var(--muted)}}
.capital-stats span{{white-space:nowrap}}
.capital-stats .used{{color:var(--green)}}.capital-stats .cash{{color:var(--gold)}}
@media(max-width:768px){{table{{font-size:9px}}td,th{{padding:2px 3px}}.capital-box{{flex-direction:column;align-items:stretch}}.capital-stats{{margin-left:0}}}}
</style>
</head>
<body>

<h1>OLYMPUS <span>XTB EDITION</span></h1>
<div class="sub">5 señales Pine sincronizadas · N_FOLDS=5 · EUR en Xetra · Capital editable</div>

<div class="alert">
<strong>✅ Capital editable.</strong> Introduce tu capital real y los pesos se calculan automáticos.
Solo los tickers con <strong>señal activa</strong> reciben asignación. Los WATCH se excluyen del reparto.
</div>

<div class="summary">
  <div class="summary-item"><div class="val" style="color:#22d3ee">{len(con)}</div><div class="lbl">Señales activas hoy</div></div>
  <div class="summary-item"><div class="val y">{len(con[con["signal"]=="BLOOD"])}</div><div class="lbl">BLOODs</div></div>
  <div class="summary-item"><div class="val" style="color:#4ade80">{len(con[con["signal"]=="MOMENTUM"])}</div><div class="lbl">MOMENTUM</div></div>
  <div class="summary-item"><div class="val" style="color:#22d3ee">{len(con[con["signal"].isin(["OB","MR","SECTOR_ROT"])])}</div><div class="lbl">OB / MR / SR</div></div>
</div>

<!-- CAPITAL EDITABLE -->
<div class="capital-box">
  <label>💰 Capital</label>
  <input type="number" id="capitalInput" value="1000" min="100" step="50" oninput="recalcularCartera()">
  <div class="presets">
    <button class="preset-btn" onclick="setCapital(500)">€500</button>
    <button class="preset-btn" onclick="setCapital(1000)">€1K</button>
    <button class="preset-btn" onclick="setCapital(2000)">€2K</button>
    <button class="preset-btn" onclick="setCapital(5000)">€5K</button>
    <button class="preset-btn" onclick="setCapital(10000)">€10K</button>
  </div>
  <div class="capital-stats">
    <span>Invertido: <span id="statUsed" class="used">€0</span></span>
    <span>Cash: <span id="statCash" class="cash">€0</span></span>
    <span>%% riesgo 2%%: <span id="statRisk" style="color:var(--red)">€0</span></span>
  </div>
</div>

<!-- CARTERA POR SEÑAL -->
<div class="section-title">▒ Cartera — Señales Activas</div>
<div class="card" id="carteraContainer">
  <div id="noSignalsMsg" style="text-align:center;padding:30px;color:var(--muted);font-size:13px">
    <div style="font-size:40px;margin-bottom:10px">📭</div>
    <strong>0 señales activas hoy ({dt_str}).</strong><br>
    <span style="font-size:11px">Vuelve a ejecutar el screener mañana. Mientras, 100%% en IBCZ.</span>
  </div>
  <table id="carteraTable" style="display:none">
    <thead>
      <tr><th>Ticker</th><th>Xetra</th><th>Señal</th><th>Score</th><th>Peso</th><th>Precio</th><th>Unid.</th><th>Inversión</th><th>Stop -5%%</th><th>Entry</th></tr>
    </thead>
    <tbody id="carteraBody"></tbody>
    <tfoot id="carteraFoot" style="display:none">
      <tr style="background:rgba(0,194,255,0.05)">
        <td colspan="5" style="text-align:right;font-weight:700">TOTAL</td>
        <td></td><td id="totalUnits" class="num" style="font-weight:700">0</td>
        <td id="totalInv" class="num" style="font-weight:700;color:var(--accent)">€0</td>
        <td colspan="2"><span id="totalCash" style="font-size:10px;color:var(--gold)">Cash: €0</span></td>
      </tr>
    </tfoot>
  </table>
</div>

<!-- RANKING Q5 COMPLETO -->
<div class="section-title">▒ Ranking Q5 ({len(df)} tickers)</div>
<div class="card">
<table>
<thead>
<tr><th>#</th><th>Ticker</th><th>Score</th><th>Señal</th><th>B</th><th>M</th><th>MR</th><th>OB</th><th>SR</th><th>Opp</th><th>Hybrid</th><th>RSI2</th><th>Entry</th></tr>
</thead>
<tbody>
'''

    for i, (_, r) in enumerate(df_sorted.iterrows(), 1):
        sig = r["signal"] if r["signal"] else "-"
        sig_class = f"sig-{sig.lower()}" if sig in ("BLOOD","MOMENTUM","MR","OB","SECTOR_ROT") else "sig-none"
        sig_display = f'<span class="sig {sig_class}">{sig}</span>' if sig in ("BLOOD","MOMENTUM","MR","OB","SECTOR_ROT") else f'<span class="sig sig-none">-</span>'
        b = '✓' if r.get("blood") == "YES" else ''
        m = '✓' if r.get("mom") == "YES" else ''
        mr = '✓' if r.get("mr") == "YES" else ''
        ob = '✓' if r.get("ob") == "YES" else ''
        sr = '✓' if r.get("sec") == "YES" else ''
        hl = ' style="background:rgba(6,182,212,0.06)"' if r["passes"] else ''
        entry_pill = f'<span class="pill pill-g">{r["entry"]}</span>' if r["passes"] else f'<span class="pill pill-y">{"WATCH" if r["signal"] in ("-", "NONE", "") else "FILTERED"}</span>'
        html += f'''<tr{hl}>
  <td>{i}</td><td><strong>{r["ticker"]}</strong></td>
  <td class="num{" g" if r["py_score"] >= 90 else ""}">{r["py_score"]}</td>
  <td>{sig_display}</td>
  <td class="num" style="color:#ef4444">{b}</td>
  <td class="num" style="color:#4ade80">{m}</td>
  <td class="num" style="color:#fb923c">{mr}</td>
  <td class="num" style="color:#22d3ee">{ob}</td>
  <td class="num" style="color:#60a5fa">{sr}</td>
  <td class="num">{r["pine_opp"]}</td>
  <td class="num" style="color:var(--accent)">{r["hybrid"]}</td>
  <td class="num">{r["rsi2"]}</td>
  <td>{entry_pill}</td>
</tr>'''
    
    html += '''</tbody>
</table>
</div>

<div class="section-title">▒ Alternativas ETF</div>
<div class="card" style="font-size:12px">
<p style="margin-bottom:8px;color:var(--muted)">Si no hay señales activas o quieres diversificar el cash sobrante:</p>
<table>
<thead><tr><th>ETF</th><th>ISIN</th><th>Precio aprox</th><th>Qué hace</th></tr></thead>
<tbody>
<tr><td><strong>IBCZ</strong></td><td class="xetra">IE000O5FBC47</td><td class="num">~€12</td><td>Multifactor Q5 — sigue los 100 mejores del modelo cuantitativo</td></tr>
<tr><td><strong>SXRV</strong></td><td class="xetra">IE00BZ0PKW92</td><td class="num">~€220</td><td>Nasdaq-100 (tecnología USA) — alta volatilidad, alto crecimiento</td></tr>
<tr><td><strong>SXR8</strong></td><td class="xetra">IE00B5BMR087</td><td class="num">~€680</td><td>S&P500 — el mercado americano completo, baja comisión 0.07%</td></tr>
<tr><td><strong>IQQ6</strong></td><td class="xetra">IE00B3WJKG14</td><td class="num">~€175</td><td>S&P500 Equal Weight — menos concentrado en las 7 grandes</td></tr>
</tbody>
</table>
</div>

<div class="section-title">▒ Cambios aplicados</div>
<div class="card" style="font-size:11px">
<div><strong>🔧 Capital editable + pesos automáticos</strong> — Introduce tu capital real y la tabla recalcula al instante.</div>
<ul style="margin:4px 0 0 18px;color:var(--muted);font-size:10px">
<li>✓ Solo tickers con señal activa reciben asignación</li>
<li>✓ Peso = score del ticker / suma de scores de todas las señales activas</li>
<li>✓ Unidades redondeadas hacia abajo (no puedes comprar fracciones)</li>
<li>✓ Botones preset: €500 / €1K / €2K / €5K / €10K</li>
<li>✓ Muestra invertido, cash restante y riesgo máximo (2%)</li>
</ul>
</div>

<div class="footer">
OLYMPUS XTB EDITION v3.0 — Capital editable · Pesos automáticos<br>
<span style="color:#3a5a76">Edita tu capital arriba → la cartera se recalcula sola.</span>
</div>

<script>
// DATOS GENERADOS AUTOMATICAMENTE por olympus_screener.py
const OPORTUNIDADES = ''' + js_array + ''';

const DT_STR = "''' + dt_str + '''";

function setCapital(val) {
  document.getElementById("capitalInput").value = val;
  recalcularCartera();
}

function recalcularCartera() {
  const raw = document.getElementById("capitalInput").value;
  const capital = Math.max(parseFloat(raw) || 1000, 0);
  const activas = OPORTUNIDADES.filter(o => o.signal !== "NONE" && o.entry !== "WATCH");

  const noMsg = document.getElementById("noSignalsMsg");
  const tbl = document.getElementById("carteraTable");
  const body = document.getElementById("carteraBody");
  const foot = document.getElementById("carteraFoot");

  if (activas.length === 0) {
    noMsg.style.display = "block";
    tbl.style.display = "none";
    foot.style.display = "none";
    document.getElementById("statUsed").textContent = "€0";
    document.getElementById("statCash").textContent = "€" + capital.toFixed(0);
    document.getElementById("statRisk").textContent = "€" + (capital * 0.02).toFixed(0);
    return;
  }

  noMsg.style.display = "none";
  tbl.style.display = "";
  foot.style.display = "";

  const totalScore = activas.reduce((s, o) => s + o.score, 0);
  let html = "";
  let totalInv = 0;
  let totalUnid = 0;

  activas.forEach(o => {
    const peso = totalScore > 0 ? (o.score / totalScore) : (1 / activas.length);
    const inversionIdeal = capital * peso;
    const p = Math.max(o.price || 1, 0.01);
    const unidades = Math.floor(inversionIdeal / p);
    const inversionReal = unidades * p;
    totalInv += inversionReal;
    totalUnid += unidades;

    const stopLoss = Math.round(p * 0.95);
    const perdidaMax = (inversionReal * 0.05).toFixed(0);

    let sigClass = "sig-none", sigLabel = "-";
    if (o.signal === "BLOOD") { sigClass = "sig-blood"; sigLabel = "BLOOD"; }
    else if (o.signal === "MOMENTUM") { sigClass = "sig-mom"; sigLabel = "MOM"; }
    else if (o.signal === "MR") { sigClass = "sig-mr"; sigLabel = "MR"; }
    else if (o.signal === "OB") { sigClass = "sig-ob"; sigLabel = "OB"; }
    else if (o.signal === "SECTOR_ROT") { sigClass = "sig-sec"; sigLabel = "SEC"; }

    const entryPill = o.entry === "EARLY" || o.entry === "CONFIRMED" ? "pill-g" : "pill-y";

    html += `<tr>
      <td><strong>${o.ticker}</strong></td>
      <td class="xetra">${o.xetra || o.ticker + ".DE"}</td>
      <td><span class="sig ${sigClass}">${sigLabel}</span></td>
      <td class="num g">${o.score.toFixed(1)}</td>
      <td class="num" style="color:var(--accent)">${(peso * 100).toFixed(1)}%</td>
      <td class="num">€${p.toFixed(0)}</td>
      <td class="num" style="font-weight:700;color:var(--accent)">${unidades}</td>
      <td class="num">€${inversionReal.toFixed(0)}</td>
      <td class="num" style="color:var(--muted)">€${stopLoss} <span style="color:var(--red);font-size:8px">(-€${perdidaMax})</span></td>
      <td><span class="pill ${entryPill}">${o.entry || "EARLY"}</span></td>
    </tr>`;
  });

  body.innerHTML = html;
  const cash = Math.max(capital - totalInv, 0);
  document.getElementById("totalUnits").textContent = totalUnid;
  document.getElementById("totalInv").textContent = "€" + totalInv.toFixed(0);
  document.getElementById("totalCash").textContent = `Cash: €${cash.toFixed(0)} | IBCZ: ~${Math.floor(cash / 12)} unid.`;
  document.getElementById("statUsed").textContent = "€" + totalInv.toFixed(0);
  document.getElementById("statCash").textContent = "€" + cash.toFixed(0);
  document.getElementById("statRisk").textContent = "€" + (capital * 0.02).toFixed(0);
}

document.addEventListener("DOMContentLoaded", recalcularCartera);
</script>
</body>
</html>'''
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Saved: {html_path} (with {len(df)} tickers)")


def main():
    print("=" * 70)
    print("Olympus Screener v2.2 - Q5 vs Pine Technical Cross-Screen")
    print("=" * 70)
    cached = get_cache()
    if cached is not None:
        print("Using cached data (1h TTL)")
        df = cached
    else:
        q5_tickers, q5_scores = load_q5()
        tactical_syms, tactical_scores = load_tactical_symbols()
        
        # Merge Q5 + táctico, sin duplicar tickers ya en Q5
        q5_set = set(q5_tickers)
        extra_syms = [s for s in tactical_syms if s not in q5_set and s not in ETFS and s != "^VIX"]
        
        all_scores = {**q5_scores, **tactical_scores}
        check_list = [t for t in q5_tickers[:50] if t.upper() not in ETFS and t != "^VIX"] + extra_syms
        n_check = len(check_list)
        print(f"Checking {len(q5_tickers)} Q5 + {len(extra_syms)} tácticos = {n_check} total...")
        results = []
        def dl_task(t):
            d = dl_with_retry(t)
            if d is None: return None
            return check(t, all_scores.get(t, 50.0), d)
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            fs = {ex.submit(dl_task, t): t for t in check_list}
            done = 0
            for f in as_completed(fs):
                r = f.result()
                if r: results.append(r)
                done += 1
                if done % 5 == 0 or done == n_check:
                    print(f"  Progress: {done}/{n_check}", end="\r")
        if not results:
            print("\nAll downloads failed. yfinance rate limit. Try again later.")
            return
        df = pd.DataFrame(results).sort_values("hybrid", ascending=False).reset_index(drop=True)
        save_cache(df)
        print(f"\nDownloaded {len(df)} tickers (cached)")
    con = df[df["passes"] == True]
    par = df[(df["passes"] == False) & (df["n_signals"] >= 1)]
    nosig = df[df["n_signals"] == 0]
    print(f"\nResults: {len(con)} TOTAL confluence | {len(par)} PARTIAL | {len(nosig)} no signal")
    print()
    print("--- TOP 10 HYBRID OPPORTUNITIES ---")
    print(f"{'Ticker':6s} {'PySc':>5s} {'Pine':>5s} {'Hybrid':>6s} {'Signal':>8s} {'n':>2s} {'R:R':>5s} {'Rsi2':>5s} {'Entry':>10s}")
    print("-" * 57)
    for _, r in df.head(10).iterrows():
        m = "* " if r["passes"] else "  "
        print(f"{m}{r['ticker']:5s} {r['py_score']:5.1f} {r['pine_opp']:5.1f} {r['hybrid']:6.1f} {r['signal']:>8s} {r['n_signals']:2d} {r['rr']:4.1f}  {r['rsi2']:4.1f} {r['entry']:>10s}")
    if len(con) > 0:
        print(f"\nTOTAL CONFLUENCE ({len(con)} tickers - OK to enter):")
        for _, r in con.iterrows():
            print(f"  {r['ticker']:6s} hybrid={r['hybrid']:.1f} {r['signal']:>8s} rsi2={r['rsi2']:.1f} {r['entry']}")
    if len(par) > 0:
        print(f"\nPARTIAL SIGNAL ({len(par)} tickers - Q5 but filters block):")
        for _, r in par.head(10).iterrows():
            print(f"  {r['ticker']:6s} hybrid={r['hybrid']:.1f} {r['signal']:>8s} rsi2={r['rsi2']:.1f} rr={r['rr']:.1f}")
    if len(nosig) > 0:
        print(f"\nNo signal: {len(nosig)} (Q5 fundamental only)")
    cols = ["ticker","py_score","pine_opp","hybrid","signal","n_signals","regime","passes","rr","rsi2","rsi14","entry","blood","mom","mr","ob","sec"]
    df[cols].to_csv(OUTPUT_PATH, index=False)
    print(f"\nSaved: {OUTPUT_PATH}")
    # Generar HTML con datos embebidos
    dt_str = datetime.now().strftime("%d-%b %H:%M")
    generate_html(df, con, dt_str)

    # ─── EXPORTAR Q5 SCORES A public/ para que el TypeScript pueda leerlos ───
    try:
        public_dir = os.path.normpath(os.path.join(CWD, "..", "public"))
        os.makedirs(public_dir, exist_ok=True)
        q5_path = os.path.join(public_dir, "q5_scores.json")

        # Construir diccionario con todos los tickers y sus scores ML
        all_scores = {}
        for _, r in df.iterrows():
            all_scores[r["ticker"]] = {
                "score": float(r["py_score"]),
                "quintile": 5,  # Todos en df son Q5 (vienen de predictions.csv filtrado)
                "hybrid": float(r["hybrid"]),
                "signal": str(r.get("signal", "NONE")),
                "passes": bool(r["passes"])
            }

        q5_export = {
            "generatedAt": datetime.now().isoformat(),
            "mode": "swing",
            "modelMetrics": {
                "ic": 0.0,    # No disponibles desde screener, se rellenan desde v5
                "ir": 0.0,
                "hitRate": 0.0
            },
            "q5Tickers": [t for t, _ in sorted(all_scores.items(), key=lambda x: x[1]["score"], reverse=True)],
            "allScores": all_scores
        }

        with open(q5_path, "w", encoding="utf-8") as f:
            json.dump(q5_export, f, indent=2, ensure_ascii=False)
        print(f"   ✅ Q5 scores exportados: {q5_path} ({len(all_scores)} tickers)")
    except Exception as e:
        print(f"   ⚠️ No se pudo exportar q5_scores.json: {e}")

    print(f"\nSummary: {len(con)} confluence | {len(par)} partial | {len(nosig)} no signal")

if __name__ == "__main__":
    main()
