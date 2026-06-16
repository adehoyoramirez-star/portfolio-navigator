#!/usr/bin/env python3
"""PREDICTION_CHECK_5D v1.0 — Olympus

Compara las predicciones de hace N dias de trading (default 5, igual al
HORIZON del modelo) contra los precios REALES de hoy. Responde:

  1. Las senales BUY de hace N dias: cuanto dinero hubieran dado
     (TP / SL / abiertas), con el sizing que el modelo sugirio?
  2. El IC realizado del modelo en ese periodo, coincide con el IC
     esperado del backtest (ic_monitor.csv)?
  3. Como evoluciona la calidad real del modelo dia a dia
     (prediction_accuracy_log.csv, historico append-only)?

Esto NO reentrena el modelo (Olympus v9.2 no tiene aprendizaje online).
Lo que hace es darte el FEEDBACK LOOP que permite decidir, dia a dia y con
datos reales, si las senales actuales son de fiar o si el IC se ha
degradado respecto al backtest — la misma logica del semaforo IC pero
medida con dinero real.

Requiere:
  - history/YYYY-MM-DD/predictions.csv + ibkr_orders.csv
    (generados por archive_snapshot.py cada mañana via inicio_dia.bat)
  - yfinance (pip install yfinance)

Outputs:
  - prediction_check_5d.html    Informe visual
  - prediction_accuracy_log.csv Historico append-only (1 fila por chequeo)

Uso:
  python prediction_check_5d.py
  python prediction_check_5d.py --days 5
  python prediction_check_5d.py --full     # IC sobre universo completo (mas lento)
"""
import os
import sys
import argparse
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

try:
    from scipy.stats import spearmanr
except ImportError:
    print('ERROR: falta scipy. Instala con: pip install scipy')
    sys.exit(1)

try:
    import yfinance as yf
except ImportError:
    print('ERROR: falta yfinance. Instala con: pip install yfinance')
    sys.exit(1)

BASE = os.path.dirname(os.path.abspath(__file__))
HISTORY_DIR = os.path.join(BASE, 'history')
LOG_FILE = os.path.join(BASE, 'prediction_accuracy_log.csv')
IC_MONITOR_FILE = os.path.join(BASE, 'ic_monitor.csv')
OUTPUT_HTML = os.path.join(BASE, 'prediction_check_5d.html')

parser = argparse.ArgumentParser(description='Verifica predicciones Olympus a N dias')
parser.add_argument('--days', type=int, default=5,
                     help='Dias de trading hacia atras a verificar (default 5, igual al HORIZON del modelo)')
parser.add_argument('--full', action='store_true',
                     help='Calcular IC realizado sobre el universo completo en vez de solo Q1+Q5 (mas lento)')
args = parser.parse_args()


# ─── Utilidades de fechas ────────────────────────────────────────────────────

def n_trading_days_ago(n, from_date=None):
    """Cuenta n dias hacia atras saltando sabados y domingos (aprox. festivos no)."""
    d = from_date or datetime.now().date()
    count = 0
    while count < n:
        d -= timedelta(days=1)
        if d.weekday() < 5:
            count += 1
    return d


def available_snapshots():
    if not os.path.isdir(HISTORY_DIR):
        return []
    return sorted([d for d in os.listdir(HISTORY_DIR)
                   if os.path.isdir(os.path.join(HISTORY_DIR, d))])


def find_snapshot(target_date):
    """Snapshot mas cercano (<=) a target_date. Devuelve (nombre, ruta) o (None, None)."""
    snaps = available_snapshots()
    target_str = target_date.strftime('%Y-%m-%d')
    candidates = [s for s in snaps if s <= target_str]
    if not candidates:
        return None, None
    chosen = candidates[-1]
    return chosen, os.path.join(HISTORY_DIR, chosen)


def load_snapshot(path):
    preds_path = os.path.join(path, 'predictions.csv')
    orders_path = os.path.join(path, 'ibkr_orders.csv')
    preds = pd.read_csv(preds_path) if os.path.exists(preds_path) else pd.DataFrame()
    orders = pd.read_csv(orders_path) if os.path.exists(orders_path) else pd.DataFrame()
    return preds, orders


# ─── Descarga de precios ──────────────────────────────────────────────────────

def fetch_history(tickers, start_date, end_date):
    """Devuelve {ticker: DataFrame[Open,High,Low,Close,Volume]} desde start_date
    hasta end_date (inclusive). Tickers sin datos se omiten."""
    tickers = sorted(set(t for t in tickers if isinstance(t, str) and t))
    if not tickers:
        return {}
    try:
        raw = yf.download(tickers, start=start_date.isoformat(),
                           end=(end_date + timedelta(days=1)).isoformat(),
                           progress=False, group_by='ticker',
                           auto_adjust=False, threads=True)
    except Exception as e:
        print(f'  AVISO: fallo descarga yfinance: {e}')
        return {}

    out = {}
    if raw is None or raw.empty:
        return out

    if len(tickers) == 1:
        t = tickers[0]
        sub = raw.dropna(how='all')
        if not sub.empty:
            out[t] = sub
        return out

    for t in tickers:
        try:
            sub = raw[t].dropna(how='all')
            if not sub.empty:
                out[t] = sub
        except (KeyError, Exception):
            continue
    return out


# ─── Evaluacion de posiciones BUY ─────────────────────────────────────────────

def evaluate_buy(row, hist):
    """Simula el resultado de una orden BUY usando High/Low diario para
    detectar si se toco SL o TP. Si ambos se tocan el mismo dia, se asume
    SL primero (peor caso, conservador)."""
    entry = float(row.get('entry_price', 0) or 0)
    sl = float(row.get('stop_loss', 0) or 0)
    tp = float(row.get('take_profit', 0) or 0)
    shares = float(row.get('shares', 0) or 0)

    if entry <= 0 or hist is None or hist.empty:
        return None

    exit_price = None
    exit_reason = None
    exit_date = None

    for idx, day in hist.iterrows():
        try:
            lo = float(day['Low'])
            hi = float(day['High'])
        except (KeyError, TypeError, ValueError):
            continue
        if np.isnan(lo) or np.isnan(hi):
            continue
        hit_sl = sl > 0 and lo <= sl
        hit_tp = tp > 0 and hi >= tp
        if hit_sl:
            exit_price, exit_reason, exit_date = sl, 'SL', idx
            break
        if hit_tp:
            exit_price, exit_reason, exit_date = tp, 'TP', idx
            break

    if exit_price is None:
        last_close = float(hist['Close'].dropna().iloc[-1])
        exit_price, exit_reason = last_close, 'ABIERTA'
        exit_date = hist.index[-1]

    ret_pct = (exit_price - entry) / entry
    pnl_eur = shares * (exit_price - entry)

    return {
        'exit_price': round(exit_price, 4),
        'exit_reason': exit_reason,
        'exit_date': str(getattr(exit_date, 'date', lambda: exit_date)()),
        'ret_pct': ret_pct,
        'pnl_eur': pnl_eur,
        'n_days_data': len(hist),
    }


# ─── IC realizado ──────────────────────────────────────────────────────────

def compute_realized_ic(preds, snap_date, today, full=False):
    """Spearman entre score predicho (snapshot) y retorno excedente real
    (close_hoy / close_snapshot - 1, menos la mediana del subconjunto).
    Por defecto usa solo Q1+Q5 (mas rapido); --full usa todo el universo."""
    if preds.empty:
        return None

    if full:
        subset = preds.copy()
    else:
        subset = preds[preds['quintile'].isin([1, 5])].copy()

    if len(subset) < 20:
        return None

    tickers = subset['ticker'].tolist()
    hist = fetch_history(tickers, snap_date, today)

    rows = []
    for _, r in subset.iterrows():
        t = r['ticker']
        h = hist.get(t)
        if h is None or h.empty or len(h) < 2:
            continue
        close = h['Close'].dropna()
        if len(close) < 2:
            continue
        c0 = float(close.iloc[0])
        c1 = float(close.iloc[-1])
        if c0 <= 0:
            continue
        ret = c1 / c0 - 1.0
        rows.append({'ticker': t, 'score': r['score'], 'quintile': r['quintile'], 'ret': ret})

    if len(rows) < 20:
        return None

    df = pd.DataFrame(rows)
    median_ret = df['ret'].median()
    df['excess'] = df['ret'] - median_ret

    ic, pval = spearmanr(df['score'], df['excess'])
    if np.isnan(ic):
        return None

    q5 = df[df['quintile'] == 5]
    q1 = df[df['quintile'] == 1]

    return {
        'ic': float(ic),
        'pval': float(pval),
        'n': len(df),
        'q5_mean_excess': float(q5['excess'].mean()) if len(q5) else None,
        'q1_mean_excess': float(q1['excess'].mean()) if len(q1) else None,
        'q5_n': len(q5),
        'q1_n': len(q1),
        'spread': (float(q5['excess'].mean()) - float(q1['excess'].mean()))
                  if len(q5) and len(q1) else None,
    }


def lookup_predicted_ic(snap_name):
    """Busca en ic_monitor.csv la fila correspondiente a la fecha del snapshot."""
    if not os.path.exists(IC_MONITOR_FILE):
        return None
    try:
        ic_df = pd.read_csv(IC_MONITOR_FILE)
    except Exception:
        return None
    if 'date' not in ic_df.columns:
        return None
    matches = ic_df[ic_df['date'].astype(str).str.startswith(snap_name)]
    if matches.empty:
        return None
    row = matches.iloc[-1]
    return {
        'ic_mean': float(row.get('ic_mean', np.nan)),
        'ic_20d': float(row.get('ic_20d', np.nan)),
        'ir': float(row.get('ir', np.nan)),
        'hit_rate': float(row.get('hit_rate', np.nan)),
    }


# ─── Log historico ──────────────────────────────────────────────────────────

def append_log(row):
    df_row = pd.DataFrame([row])
    if os.path.exists(LOG_FILE):
        existing = pd.read_csv(LOG_FILE)
        combined = pd.concat([existing, df_row], ignore_index=True)
        # Evitar duplicados si se ejecuta dos veces el mismo dia para el mismo snapshot
        combined = combined.drop_duplicates(subset=['check_date', 'snapshot_date'], keep='last')
        combined.to_csv(LOG_FILE, index=False)
    else:
        df_row.to_csv(LOG_FILE, index=False)


# ─── HTML ──────────────────────────────────────────────────────────────────

def _fmt_eur(x):
    sign = '+' if x >= 0 else ''
    return f'{sign}{x:.2f} EUR'


def _fmt_pct(x):
    sign = '+' if x >= 0 else ''
    return f'{sign}{x*100:.2f}%'


def build_html(snap_name, target_date, today, trading_days_elapsed,
               buy_results, ic_realized, ic_predicted, history_log):
    n = len(buy_results)
    n_tp = sum(1 for r in buy_results if r['exit_reason'] == 'TP')
    n_sl = sum(1 for r in buy_results if r['exit_reason'] == 'SL')
    n_open = sum(1 for r in buy_results if r['exit_reason'] == 'ABIERTA')
    n_wins = sum(1 for r in buy_results if r['pnl_eur'] > 0)
    hit_rate = n_wins / n if n > 0 else 0.0
    total_pnl = sum(r['pnl_eur'] for r in buy_results)
    total_invested = sum(r['size_eur'] for r in buy_results)
    roi = total_pnl / total_invested if total_invested > 0 else 0.0

    pnl_color = '#00e07a' if total_pnl >= 0 else '#ff4060'

    rows_html = ''
    for r in sorted(buy_results, key=lambda x: x['pnl_eur'], reverse=True):
        badge_map = {'TP': ('b-tp', 'TP'), 'SL': ('b-sl', 'SL'), 'ABIERTA': ('b-open', 'ABIERTA')}
        badge_cls, badge_txt = badge_map.get(r['exit_reason'], ('b-open', r['exit_reason']))
        ret_col = '#00e07a' if r['ret_pct'] >= 0 else '#ff4060'
        rows_html += (
            '<tr>'
            f'<td><b>{r["ticker"]}</b></td>'
            f'<td class="m">{r.get("sector","N/A")}</td>'
            f'<td>{r["entry"]:.2f}</td>'
            f'<td>{r["exit_price"]:.2f}</td>'
            f'<td><span class="{badge_cls}">{badge_txt}</span></td>'
            f'<td style="color:{ret_col}">{_fmt_pct(r["ret_pct"])}</td>'
            f'<td>{r["size_eur"]:.0f} EUR</td>'
            f'<td style="color:{ret_col}"><b>{_fmt_eur(r["pnl_eur"])}</b></td>'
            f'<td class="m">score {r.get("score",0):.1f} / z {r.get("z_score",0):.2f}</td>'
            '</tr>\n'
        )

    if not rows_html:
        rows_html = '<tr><td colspan=9 style="text-align:center;color:#5a7a96">Sin senales BUY en el snapshot</td></tr>'

    # IC block
    if ic_realized:
        ic_val = ic_realized['ic']
        ic_color = '#00e07a' if ic_val > 0.03 else '#ffc800' if ic_val > 0 else '#ff4060'
        spread = ic_realized.get('spread')
        spread_txt = _fmt_pct(spread) if spread is not None else 'N/A'
        spread_color = '#00e07a' if (spread or 0) > 0 else '#ff4060'
        ic_n = ic_realized['n']
    else:
        ic_val, ic_color, spread_txt, spread_color, ic_n = None, '#5a7a96', 'N/A', '#5a7a96', 0

    if ic_predicted:
        pred_ic_txt = f"{ic_predicted['ic_mean']:+.4f}"
    else:
        pred_ic_txt = 'N/A'

    # Historic log table (last 10 rows)
    hist_rows_html = ''
    if history_log is not None and not history_log.empty:
        for _, r in history_log.tail(10).iloc[::-1].iterrows():
            pnl_c = '#00e07a' if r['pnl_total_eur'] >= 0 else '#ff4060'
            ic_r = r.get('ic_realized', np.nan)
            ic_c = '#00e07a' if (not np.isnan(ic_r) and ic_r > 0) else '#ff4060' if not np.isnan(ic_r) else '#5a7a96'
            ic_txt = f"{ic_r:+.4f}" if not np.isnan(ic_r) else 'N/A'
            hr = r.get('hit_rate', np.nan)
            hr_txt = f"{hr*100:.0f}%" if not np.isnan(hr) else 'N/A'
            hist_rows_html += (
                '<tr>'
                f'<td class="m">{r["check_date"]}</td>'
                f'<td class="m">{r["snapshot_date"]}</td>'
                f'<td>{int(r["n_buy_positions"])}</td>'
                f'<td>{hr_txt}</td>'
                f'<td style="color:{pnl_c}"><b>{_fmt_eur(r["pnl_total_eur"])}</b></td>'
                f'<td style="color:{ic_c}">{ic_txt}</td>'
                '</tr>\n'
            )
    if not hist_rows_html:
        hist_rows_html = '<tr><td colspan=6 style="text-align:center;color:#5a7a96">Primer chequeo &mdash; sin historico todavia</td></tr>'

    return f'''<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Prediction Check 5D \u2014 Olympus</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#080c12;color:#c8d8e8;font-family:-apple-system,'Segoe UI',sans-serif;padding:24px;max-width:1200px;margin:0 auto}}
h1{{font-size:22px;color:#fff;margin-bottom:4px}}
.sub{{color:#5a7a96;font-size:13px;margin-bottom:24px}}
.sg{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}}
.cd{{background:#111927;border:1px solid #1e2d40;border-radius:8px;padding:16px}}
.cl{{font-size:10px;color:#5a7a96;text-transform:uppercase;letter-spacing:2px;margin-bottom:4px}}
.cv{{font-size:24px;font-weight:700}}
.st{{font-size:14px;font-weight:700;color:#fff;margin:24px 0 12px}}
table{{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px}}
th{{text-align:left;padding:10px 8px;border-bottom:2px solid #1e2d40;font-size:10px;color:#5a7a96;text-transform:uppercase;letter-spacing:1px}}
td{{padding:10px 8px;border-bottom:1px solid #1e2d40}}
tr:hover{{background:rgba(0,194,255,0.04)}}
.m{{color:#5a7a96;font-size:11px}}
.b-tp{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(0,224,122,0.2);color:#00e07a;border:1px solid #00e07a}}
.b-sl{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(255,64,96,0.15);color:#ff4060;border:1px solid #ff4060}}
.b-open{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(0,194,255,0.1);color:#00c2ff}}
.note{{background:rgba(0,194,255,0.06);border:1px solid rgba(0,194,255,0.2);border-radius:8px;padding:16px;margin-bottom:20px;font-size:13px;line-height:1.7}}
.note b{{color:#00c2ff}}
.foot{{margin-top:32px;padding:16px;background:#111927;border:1px solid #1e2d40;border-radius:8px;font-size:12px;color:#5a7a96}}
</style>
</head>
<body>

<h1>Prediction Check 5D \u2014 Olympus</h1>
<div class="sub">Snapshot evaluado: {snap_name} ({trading_days_elapsed} dias de trading) &middot; Verificado: {today.strftime('%d/%m/%Y')}</div>

<div class="sg">
  <div class="cd"><div class="cl">Posiciones BUY</div><div class="cv" style="color:#fff">{n}</div></div>
  <div class="cd"><div class="cl">Hit Rate</div><div class="cv" style="color:{'#00e07a' if hit_rate>=0.5 else '#ff4060'}">{hit_rate*100:.0f}%</div></div>
  <div class="cd"><div class="cl">P&amp;L Hipotetico</div><div class="cv" style="color:{pnl_color}">{_fmt_eur(total_pnl)}</div></div>
  <div class="cd"><div class="cl">ROI sobre invertido</div><div class="cv" style="color:{pnl_color}">{_fmt_pct(roi)}</div></div>
</div>

<div class="sg">
  <div class="cd"><div class="cl">TP alcanzado</div><div class="cv" style="color:#00e07a">{n_tp}</div></div>
  <div class="cd"><div class="cl">SL alcanzado</div><div class="cv" style="color:#ff4060">{n_sl}</div></div>
  <div class="cd"><div class="cl">Abiertas</div><div class="cv" style="color:#00c2ff">{n_open}</div></div>
  <div class="cd"><div class="cl">Capital invertido</div><div class="cv" style="color:#fff">{total_invested:.0f} EUR</div></div>
</div>

<div class="note">
<b>IC realizado (Q1+Q5{', universo completo' if args.full else ''})</b>: {f'{ic_val:+.4f}' if ic_val is not None else 'N/A'}
&mdash; sobre {ic_n} tickers, periodo de {trading_days_elapsed} dias.<br>
<b>IC predicho (backtest, ic_monitor.csv)</b>: {pred_ic_txt}<br>
<b>Spread Q5 &minus; Q1 (retorno excedente real)</b>: <span style="color:{spread_color}">{spread_txt}</span><br><br>
Si el IC realizado es claramente menor que el predicho durante varios dias seguidos,
el modelo se esta degradando respecto al backtest &mdash; reduce tamano o pausa hasta
que vuelva a alinearse. Este informe no reentrena el modelo; es el feedback
que te dice CUANDO revisarlo.
</div>

<div class="st">Resultado de las senales BUY de {snap_name}</div>
<table>
<thead><tr>
  <th>Ticker</th><th>Sector</th><th>Entry</th><th>Salida</th><th>Resultado</th>
  <th>Retorno</th><th>Size</th><th>P&amp;L</th><th>Conviccion</th>
</tr></thead>
<tbody>
{rows_html}</tbody>
</table>

<div class="st">Historico de verificaciones (ultimas 10)</div>
<table>
<thead><tr>
  <th>Fecha check</th><th>Snapshot</th><th>Posiciones</th><th>Hit rate</th><th>P&amp;L total</th><th>IC realizado</th>
</tr></thead>
<tbody>
{hist_rows_html}</tbody>
</table>

<div class="foot">
<b>Metodologia</b><br>
&bull; SL/TP se evaluan con High/Low diario desde el dia siguiente al snapshot. Si ambos se tocan el mismo dia, se asume SL primero (peor caso).<br>
&bull; Posiciones sin TP/SL alcanzado se marcan ABIERTA y se valoran al precio de cierre actual (mark-to-market).<br>
&bull; El P&amp;L es HIPOTETICO: asume que TODAS las ordenes se ejecutaron exactamente al precio y tamano sugeridos. No incluye comisiones, slippage real ni gaps de apertura.<br>
&bull; El IC realizado compara el score del modelo (en el snapshot) contra el retorno excedente real (vs mediana del subconjunto) {trading_days_elapsed} dias despues.<br>
&bull; Genera mas snapshots ejecutando inicio_dia.bat cada dia de mercado &mdash; con &lt;5 dias de historico este informe no puede evaluar nada todavia.
</div>

</body></html>'''


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    today = datetime.now().date()
    target = n_trading_days_ago(args.days, today)

    snaps = available_snapshots()
    if not snaps:
        print(f'No hay snapshots en {HISTORY_DIR}/')
        print('Ejecuta inicio_dia.bat durante varios dias para acumular historico,')
        print(f'luego vuelve a ejecutar esto (necesitas al menos {args.days} dias de trading).')
        sys.exit(1)

    snap_name, snap_path = find_snapshot(target)
    if snap_path is None:
        print(f'No hay snapshot anterior o igual a {target} (hace {args.days}d trading).')
        print(f'Snapshots disponibles: {", ".join(snaps)}')
        print('Necesitas mas historico antes de poder verificar.')
        sys.exit(1)

    snap_date = datetime.strptime(snap_name, '%Y-%m-%d').date()
    # Dias de trading reales transcurridos (cuenta dias laborables entre snap_date y today)
    trading_days_elapsed = 0
    d = snap_date
    while d < today:
        d += timedelta(days=1)
        if d.weekday() < 5:
            trading_days_elapsed += 1

    print(f'Snapshot usado: {snap_name} (objetivo {target}, {trading_days_elapsed} dias de trading transcurridos)')

    preds, orders = load_snapshot(snap_path)
    if preds.empty:
        print(f'ERROR: predictions.csv vacio o no encontrado en history/{snap_name}/')
        sys.exit(1)

    print(f'  {len(preds)} predicciones | {len(orders)} ordenes en el snapshot')

    # 1. Evaluar posiciones BUY -------------------------------------------------
    buy_results = []
    if not orders.empty and 'action' in orders.columns:
        buy_orders = orders[orders['action'] == 'BUY'].copy()
        if not buy_orders.empty:
            tickers = buy_orders['ticker'].tolist()
            print(f'Descargando precios para {len(tickers)} posiciones BUY...')
            hist = fetch_history(tickers, snap_date + timedelta(days=1), today)
            for _, row in buy_orders.iterrows():
                t = row['ticker']
                h = hist.get(t)
                res = evaluate_buy(row, h)
                if res is None:
                    print(f'  [sin datos] {t}')
                    continue
                res['ticker'] = t
                res['entry'] = float(row.get('entry_price', 0) or 0)
                res['sl'] = float(row.get('stop_loss', 0) or 0)
                res['tp'] = float(row.get('take_profit', 0) or 0)
                res['size_eur'] = float(row.get('size_eur', 0) or 0)
                res['score'] = float(row.get('score', 0) or 0)
                res['z_score'] = float(row.get('z_score', 0) or 0)
                res['sector'] = row.get('sector', 'N/A')
                buy_results.append(res)
                print(f'  {t}: {res["exit_reason"]} | ret={res["ret_pct"]*100:+.2f}% | '
                      f'P&L={res["pnl_eur"]:+.2f} EUR')

    # 2. IC realizado -------------------------------------------------------------
    print(f'Calculando IC realizado ({"universo completo" if args.full else "Q1+Q5"})...')
    ic_realized = compute_realized_ic(preds, snap_date, today, full=args.full)
    if ic_realized:
        print(f'  IC realizado = {ic_realized["ic"]:+.4f} (n={ic_realized["n"]}, '
              f'spread Q5-Q1 = {ic_realized["spread"]*100:+.2f}%)'
              if ic_realized['spread'] is not None else
              f'  IC realizado = {ic_realized["ic"]:+.4f} (n={ic_realized["n"]})')
    else:
        print('  IC realizado: insuficientes datos')

    ic_predicted = lookup_predicted_ic(snap_name)
    if ic_predicted:
        print(f'  IC predicho (backtest) = {ic_predicted["ic_mean"]:+.4f}')

    # 3. Log historico --------------------------------------------------------------
    n = len(buy_results)
    n_wins = sum(1 for r in buy_results if r['pnl_eur'] > 0)
    total_pnl = sum(r['pnl_eur'] for r in buy_results)
    total_invested = sum(r['size_eur'] for r in buy_results)

    log_row = {
        'check_date': today.strftime('%Y-%m-%d'),
        'snapshot_date': snap_name,
        'trading_days_elapsed': trading_days_elapsed,
        'n_buy_positions': n,
        'n_wins': n_wins,
        'hit_rate': (n_wins / n) if n > 0 else np.nan,
        'pnl_total_eur': total_pnl,
        'total_invested_eur': total_invested,
        'roi_pct': (total_pnl / total_invested) if total_invested > 0 else np.nan,
        'ic_realized': ic_realized['ic'] if ic_realized else np.nan,
        'ic_predicted': ic_predicted['ic_mean'] if ic_predicted else np.nan,
        'spread_q5_q1': ic_realized['spread'] if (ic_realized and ic_realized['spread'] is not None) else np.nan,
    }
    append_log(log_row)
    print(f'Log actualizado: {LOG_FILE}')

    history_log = pd.read_csv(LOG_FILE) if os.path.exists(LOG_FILE) else None

    # 4. HTML ----------------------------------------------------------------------
    html = build_html(snap_name, target, today, trading_days_elapsed,
                       buy_results, ic_realized, ic_predicted, history_log)
    with open(OUTPUT_HTML, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'Informe generado: {OUTPUT_HTML}')

    # 5. Resumen consola -------------------------------------------------------------
    print()
    print('=' * 60)
    print(f'  RESUMEN — snapshot {snap_name} ({trading_days_elapsed}d trading)')
    print(f'  Posiciones BUY: {n} | Hit rate: {(n_wins/n*100) if n>0 else 0:.0f}%')
    print(f'  P&L hipotetico: {total_pnl:+.2f} EUR sobre {total_invested:.0f} EUR invertidos')
    if ic_realized:
        print(f'  IC realizado: {ic_realized["ic"]:+.4f}'
              + (f' (predicho: {ic_predicted["ic_mean"]:+.4f})' if ic_predicted else ''))
    print('=' * 60)


if __name__ == '__main__':
    main()
