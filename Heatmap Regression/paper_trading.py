#!/usr/bin/env python3
"""
PAPER TRADING TRACKER v1.0 — Olympus Heatmap Regression

Uso: python paper_trading.py [--capital CAPITAL] [--modo real|test]

Simula la ejecucion de las senales del modelo y trackea:
  - P&L diario
  - Sharpe rolling
  - Drawdown
  - Win rate
  - SL/TP hits
"""
import os, sys, json, time
from datetime import datetime
import pandas as pd
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
SIGNAL_FILE = os.path.join(BASE, 'ibkr_orders.csv')
TRACKER_FILE = os.path.join(BASE, 'paper_tracker.csv')
REPORT_FILE = os.path.join(BASE, 'paper_report.html')

def load_signals():
    """Carga las senales BUY del CSV."""
    if not os.path.exists(SIGNAL_FILE):
        print(f'ERROR: No encuentro {SIGNAL_FILE}')
        return []
    df = pd.read_csv(SIGNAL_FILE)
    buys = df[(df['action'] == 'BUY') & (df['viable'] == True)]
    signals = []
    for _, r in buys.iterrows():
        signals.append({
            'ticker': r['ticker'],
            'entry': float(r['entry_price']),
            'sl': float(r['stop_loss']),
            'tp': float(r['take_profit']),
            'size_eur': float(r['size_eur']),
            'shares': float(r['shares']),
            'confidence': r['confidence'],
            'z_score': float(r['z_score']),
            'score': float(r['score']),
            'date': datetime.now().strftime('%Y-%m-%d'),
        })
    return signals

def load_tracker():
    """Carga historial de trades del tracker CSV."""
    if os.path.exists(TRACKER_FILE):
        return pd.read_csv(TRACKER_FILE)
    return pd.DataFrame(columns=[
        'date', 'ticker', 'entry', 'sl', 'tp', 'size_eur', 'shares',
        'confidence', 'z_score', 'exit_price', 'exit_date', 'pnl_eur',
        'pnl_pct', 'status', 'notes'
    ])

def simulate_signals(signals, tracker):
    """
    Anade nuevas senales al tracker.
    En modo paper, las senales se registran como 'OPEN' hasta que se cierran.
    """
    existing = set(tracker['ticker'].tolist() if len(tracker) > 0 else [])
    existing_dates = set()
    if len(tracker) > 0:
        existing_dates = set(zip(tracker['ticker'], tracker['date']))
    
    new_rows = []
    for s in signals:
        key = (s['ticker'], s['date'])
        if key not in existing_dates:
            new_rows.append({
                'date': s['date'],
                'ticker': s['ticker'],
                'entry': s['entry'],
                'sl': s['sl'],
                'tp': s['tp'],
                'size_eur': s['size_eur'],
                'shares': s['shares'],
                'confidence': s['confidence'],
                'z_score': s['z_score'],
                'exit_price': 0.0,
                'exit_date': '',
                'pnl_eur': 0.0,
                'pnl_pct': 0.0,
                'status': 'OPEN',
                'notes': s.get('notes', ''),
            })
    
    if new_rows:
        new_df = pd.DataFrame(new_rows)
        tracker = pd.concat([tracker, new_df], ignore_index=True)
        print(f'Registradas {len(new_rows)} nuevas senales')
    else:
        print('No hay senales nuevas')
    
    return tracker

def compute_metrics(tracker):
    """Calcula metricas de rendimiento."""
    closed = tracker[tracker['status'] == 'CLOSED']
    open_pos = tracker[tracker['status'] == 'OPEN']
    
    n_total = len(tracker)
    n_closed = len(closed)
    n_open = len(open_pos)
    
    if n_closed > 0:
        wins = len(closed[closed['pnl_eur'] > 0])
        losses = len(closed[closed['pnl_eur'] <= 0])
        win_rate = wins / n_closed * 100
        total_pnl = closed['pnl_eur'].sum()
        avg_win = closed[closed['pnl_eur'] > 0]['pnl_eur'].mean() if wins > 0 else 0
        avg_loss = closed[closed['pnl_eur'] <= 0]['pnl_eur'].mean() if losses > 0 else 0
        profit_factor = abs(avg_win * wins / (avg_loss * losses + 0.01)) if losses > 0 else float('inf')
        
        # Sharpe de los trades cerrados
        returns = closed['pnl_pct'].values
        sharpe = np.mean(returns) / (np.std(returns) + 0.001) * np.sqrt(252) if len(returns) > 1 else 0
    else:
        wins = losses = 0
        win_rate = total_pnl = avg_win = avg_loss = profit_factor = sharpe = 0
    
    max_dd = 0
    if n_closed > 1:
        cumsum = closed['pnl_eur'].cumsum().values
        peak = np.maximum.accumulate(cumsum)
        dd = (cumsum - peak) / (peak + 0.01)
        max_dd = abs(min(dd)) * 100 if len(dd) > 0 else 0
    
    return {
        'n_total': n_total,
        'n_closed': n_closed,
        'n_open': n_open,
        'wins': wins,
        'losses': losses,
        'win_rate': win_rate,
        'total_pnl': total_pnl,
        'avg_win': avg_win,
        'avg_loss': avg_loss,
        'profit_factor': profit_factor,
        'sharpe': sharpe,
        'max_dd': max_dd,
        'capital_invertido': tracker['size_eur'].sum(),
    }

def generar_reporte(tracker, metrics):
    """Genera HTML con el estado del paper trading."""
    dt = datetime.now().strftime('%d/%m/%Y %H:%M')
    
    html = f'''<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><title>Paper Trading - Olympus</title>
<style>
:root{{--bg:#080c12;--surface:#0d1420;--card:#111927;--border:#1e2d40;
  --text:#c8d8e8;--muted:#5a7a96;--accent:#00c2ff;--green:#00e07a;--red:#ff4060}}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:var(--bg);color:var(--text);font-family:'Segoe UI',sans-serif;padding:32px}}
h1{{font-size:24px;color:#fff;margin-bottom:8px}}
.sub{{color:var(--muted);font-size:13px;margin-bottom:24px}}
.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}}
.card{{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:20px}}
.card-title{{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:2px;margin-bottom:8px}}
.val{{font-size:28px;font-weight:700;font-family:Consolas,monospace}}
.green{{color:var(--green)}}.red{{color:var(--red)}}
table{{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}}
th{{text-align:left;padding:8px;border-bottom:1px solid var(--border);font-size:10px;color:var(--muted);font-family:Consolas,monospace}}
td{{padding:8px;border-bottom:1px solid var(--border)}}
.badge{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}}
.badge-good{{background:rgba(0,224,122,0.2);color:var(--green)}}
.badge-warn{{background:rgba(240,165,0,0.2);color:#f0a500}}
.badge-open{{background:rgba(0,194,255,0.15);color:var(--accent)}}
.badge-low{{background:rgba(255,64,96,0.15);color:var(--red)}}
</style></head><body>
<h1>📊 Paper Trading Tracker</h1>
<div class="sub">Olympus Heatmap Regression · {dt} · {metrics["n_total"]} senales totales</div>

<div class="grid">
  <div class="card">
    <div class="card-title">P&L Total</div>
    <div class="val {"green" if metrics["total_pnl"] >= 0 else "red"}">{metrics["total_pnl"]:+.2f}€</div>
  </div>
  <div class="card">
    <div class="card-title">Win Rate</div>
    <div class="val {"green" if metrics["win_rate"] >= 50 else "red"}">{metrics["win_rate"]:.1f}%</div>
    <div style="font-size:11px;color:var(--muted)">{metrics["wins"]}W / {metrics["losses"]}L</div>
  </div>
  <div class="card">
    <div class="card-title">Sharpe</div>
    <div class="val {"green" if metrics["sharpe"] >= 1 else "red"}">{metrics["sharpe"]:.2f}</div>
  </div>
  <div class="card">
    <div class="card-title">Max Drawdown</div>
    <div class="val red">{metrics["max_dd"]:.1f}%</div>
  </div>
  <div class="card">
    <div class="card-title">Profit Factor</div>
    <div class="val green">{metrics["profit_factor"]:.2f}</div>
  </div>
  <div class="card">
    <div class="card-title">Trades Cerrados</div>
    <div class="val" style="color:var(--accent)">{metrics["n_closed"]}</div>
  </div>
  <div class="card">
    <div class="card-title">Abiertos</div>
    <div class="val" style="color:var(--gold)">{metrics["n_open"]}</div>
  </div>
  <div class="card">
    <div class="card-title">Capital Invertido</div>
    <div class="val" style="color:#fff">{metrics["capital_invertido"]:.0f}€</div>
  </div>
</div>'''
   
