#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
generar_dashboard.py — v4.1 (lee ibkr_orders.csv + ic_monitor.csv para semaforo IC)
[FIX] v4.0: Lee directamente de ibkr_orders.csv (generado por OLYMPUS_HEATMAP_REGRESSION_v7.py)
      en vez de portfolio_q5.csv. Asi los tickers del dashboard coinciden exactamente
      con las ordenes reales de trading (SxIV order).
[FIX] v4.1: Lee ic_monitor.csv para mostrar semaforo IC en el dashboard.

Algoritmo cash-adaptive:
  1) Lee todas las ordenes BUY viables de ibkr_orders.csv (ya ordenadas por SxIV)
  2) Toma top N posiciones (MAX_POS)
  3) Reasigna pesos proporcionalmente para que sumen 100%
  4) Invierte con fraccionables exactamente el peso reasignado
"""
import argparse, csv, json, os, sys, webbrowser
from datetime import datetime

B = os.path.dirname(os.path.abspath(__file__))
IBKR = os.path.join(B, "ibkr_orders.csv")
IC_MONITOR = os.path.join(B, "ic_monitor.csv")
OUT = os.path.join(B, "dashboard_diario.html")


def load_orders():
    """Carga ordenes BUY viables de ibkr_orders.csv (mismas que usaria IBKR)."""
    if not os.path.exists(IBKR):
        print("ERROR: No encuentro ibkr_orders.csv. Ejecuta primero el modelo (OLYMPUS_HEATMAP_REGRESSION_v7.py).")
        sys.exit(1)

    rows = []
    for row in csv.DictReader(open(IBKR, encoding="utf-8")):
        try:
            action = row.get("action", "").strip().upper()
            viable = row.get("viable", "False").strip()
            if action != "BUY" or viable.lower() != "true":
                continue
            rows.append({
                "t": row["ticker"],
                "s": float(row.get("score", 0)),
                "z": float(row.get("z_score", 0)),
                "w": float(row.get("weight_pct", 0)),
                "e": float(row.get("entry_price", 0)),
                "sec": row.get("sector", "Other"),
                "conf": row.get("confidence", "LOW"),
                "sl": float(row.get("stop_loss", 0)),
                "tp": float(row.get("take_profit", 0)),
            })
        except Exception:
            continue

    if not rows:
        print("ERROR: No hay ordenes BUY viables en ibkr_orders.csv")
        sys.exit(1)

    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--capital", type=float, default=None)
    p.add_argument("--open", action="store_true")
    p.add_argument("--max-positions", type=int, default=5,
                   help="Maximo de posiciones (default: 5)")
    a = p.parse_args()
    cap = a.capital
    if cap is None:
        try:
            cap = float(input("Capital disponible (EUR): ").strip().replace(",", "."))
        except Exception:
            cap = 10000
            print("Usando capital por defecto: 10.000 EUR")
    print("Capital: %.0f EUR" % cap)

    rows = load_orders()
    print("Cargadas %d ordenes BUY viables de ibkr_orders.csv" % len(rows))

    ts = os.path.getmtime(IBKR)
    fecha = datetime.fromtimestamp(ts).strftime("%d/%m/%Y %H:%M")
    j = json.dumps(rows)
    c = int(cap)
    mp = a.max_positions

    # ── Leer IC monitor para semaforo ─────────────────────────────────────────
    ic_status = {"ic_20d": 0.0, "ic_60d": 0.0, "label": "?", "color": "#666", "emoji": "⚪", "msg": "Sin datos de IC"}
    if os.path.exists(IC_MONITOR):
        try:
            import pandas as pd
            ic_df = pd.read_csv(IC_MONITOR)
            if len(ic_df) > 0:
                last = ic_df.iloc[-1]
                ic20 = float(last.get("ic_20d", 0))
                ic60 = float(last.get("ic_60d", 0))
                # [FIX-SEMAFORO] Umbrales corregidos: 0.01→0.03 (rojo), 0.02→0.05 (verde)
                # El umbral anterior (0.02) declaraba verde con IC=ruido. 
                # Estándar industria: IC≥0.05 = señal usable, IC<0.03 = ruido.
                if ic20 < 0.03:
                    ic_status = {"ic_20d": ic20, "ic_60d": ic60, "label": "PAUSA", "color": "#ff4060", "emoji": "🔴",
                                 "msg": "ALARMA: IC_20d={:.4f} < 0.03 — señal demasiado débil. NO OPERAR.".format(ic20)}
                elif ic20 < 0.05:
                    ic_status = {"ic_20d": ic20, "ic_60d": ic60, "label": "PRECAUCIÓN", "color": "#f0a500", "emoji": "🟡",
                                 "msg": "IC_20d={:.4f} — débil (0.03-0.05). Reducir posiciones al 50%.".format(ic20)}
                else:
                    ic_status = {"ic_20d": ic20, "ic_60d": ic60, "label": "OPERAR", "color": "#4ade80", "emoji": "🟢",
                                 "msg": "IC_20d={:.4f} — saludable (≥0.05). Operar con normalidad.".format(ic20)}
        except Exception as e:
            print("AVISO: No se pudo leer ic_monitor.csv: %s" % e)

    h = []
    h.append("<!DOCTYPE html><html lang=es><head><meta charset=UTF-8>")
    h.append("<title>Dashboard Diario - Olympus Capital</title><style>")
    h.append("*{margin:0;padding:0;box-sizing:border-box}")
    h.append("body{font-family:Segoe UI,sans-serif;background:#0a0a1a;color:#e0e0e0;padding:24px;max-width:1200px;margin:0 auto}")
    h.append("h1{font-size:1.5rem;color:#fff;margin-bottom:4px}")
    h.append(".sub{color:#888;font-size:0.85rem;margin-bottom:20px}")
    h.append(".grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px}")
    h.append(".card{background:#111128;border:1px solid #2a2a5a;border-radius:12px;padding:14px}")
    h.append(".card .l{font-size:0.7rem;text-transform:uppercase;color:#666;margin-bottom:4px}")
    h.append(".card .v{font-size:1.1rem;font-weight:600}")
    h.append(".green{color:#4ade80}")
    h.append(".sec-badge{display:inline-block;background:#1a2a3a;color:#60a5fa;font-size:0.65rem;padding:2px 8px;border-radius:4px;margin-left:4px;font-weight:600}")
    h.append(".capbox{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#0d1a2d;border:1px solid #1a3a5a;border-radius:12px;padding:16px;margin-bottom:20px}")
    h.append(".capbox input{background:#0d0d2b;border:1px solid #333;border-radius:8px;color:#fff;font-size:1.3rem;font-weight:600;padding:8px 14px;width:160px}")
    h.append(".capbox .tot{color:#888;font-size:0.85rem;margin-left:auto}")
    h.append("table{width:100%;border-collapse:collapse;background:#0d0d1f;border-radius:12px;border:1px solid #1a1a3a;font-size:0.8rem}")
    h.append("th{background:#1a1a3a;color:#888;font-size:0.7rem;text-transform:uppercase;padding:8px 10px;text-align:left}")
    h.append("td{padding:8px 10px;border-bottom:1px solid #1a1a2a}")
    h.append(".mo{font-family:monospace;font-weight:600}")
    h.append(".sl{color:#ef4444;font-family:monospace;font-weight:600}")
    h.append(".tp{color:#4ade80;font-family:monospace;font-weight:600}")
    h.append(".c-high{color:#4ade80;font-weight:700}.c-med{color:#fb923c;font-weight:700}.c-low{color:#666;font-weight:400}")
    h.append(".c-badge{display:inline-block;font-size:0.6rem;padding:1px 6px;border-radius:3px;margin-left:4px}")
    h.append(".c-badge-h{background:rgba(74,222,128,0.2);color:#4ade80}.c-badge-m{background:rgba(251,146,60,0.2);color:#fb923c}.c-badge-l{background:rgba(102,102,102,0.2);color:#999}")
    h.append(".alert{background:rgba(255,64,96,0.08);border:1px solid #ff4060;border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:0.8rem;color:#ff8080}")
    h.append(".summary{display:flex;gap:16px;flex-wrap:wrap;font-size:0.85rem}")
    h.append(".summary-item{padding:6px 14px;background:#0d0d1f;border-radius:8px;border:1px solid #1a1a3a}")
    h.append(".footer{font-size:0.7rem;color:#444;text-align:center;margin-top:24px;padding:16px;border-top:1px solid #1a1a2a}")
    h.append("</style></head><body>")
    h.append("<h1>Dashboard Diario - Olympus Capital</h1>")
    h.append("<p class=sub>Ordenes IBKR reales (SxIV) - %s - %d posiciones viables - Slider interactivo</p>" % (fecha, len(rows)))
    h.append("<div class=alert>Estas son las mismas ordenes de ibkr_orders.csv generadas por OLYMPUS HEATMAP REGRESSION v7. Los tickers coinciden 1:1.</div>")
    # ── IC Semaforo banner ──────────────────────────────────────────────────
    h.append('<div style="background:%s15;border:2px solid %s;border-radius:12px;padding:14px 20px;margin-bottom:16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">' % (ic_status["color"], ic_status["color"]))
    h.append('<span style="font-size:28px">%s</span>' % ic_status["emoji"])
    h.append('<div><div style="font-size:0.7rem;text-transform:uppercase;color:#888;font-family:monospace">SEMAFORO IC — CALIDAD DE SEÑAL</div>')
    h.append('<div style="display:flex;gap:16px;margin-top:2px"><span style="font-weight:700;font-size:1rem;color:%s">IC_20d=%+.4f</span>' % (ic_status["color"], ic_status["ic_20d"]))
    h.append('<span style="color:#888">IC_60d=%+.4f</span></div></div>' % ic_status["ic_60d"])
    h.append('<div style="flex:1;min-width:200px;font-size:0.85rem;color:%s">%s</div>' % (ic_status["color"], ic_status["msg"]))
    h.append('</div>')
    h.append("<div class=grid>")
    h.append("<div class=card><div class=l>Ordenes BUY viables</div><div class='v green'>%d</div></div>" % len(rows))
    h.append("<div class=card><div class=l>Capital actual</div><div class=v id=capDisplay>%d EUR</div></div>" % c)
    h.append("<div class=card><div class=l>Max posiciones</div><div class=v style=color:#fb923c>%d</div></div>" % mp)
    h.append("</div>")
    h.append("<div class=capbox>")
    h.append("<label for=cap style='font-weight:700;font-size:0.9rem'>Capital (EUR):</label>")
    h.append("<input type=range id=cap min=50 max=100000 step=10 value=%d style='flex:1;min-width:200px;max-width:500px;accent-color:#4ade80'>" % c)
    h.append("<input type=number id=capInput value=%d step=1 min=0 max=1000000 style='width:110px;background:#0d0d2b;border:1px solid #4ade80;border-radius:8px;color:#4ade80;font-size:1.2rem;font-weight:700;padding:6px 10px;text-align:right'>" % c)
    h.append("<div style='display:flex;gap:6px;flex-wrap:wrap;align-items:center'>")
    for preset in [100, 500, 1000, 5000, 10000, 50000]:
        h.append("<button onclick=\"setCap(%d)\" style='background:#1a2a3a;border:1px solid #2a3a5a;color:#60a5fa;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.75rem;font-weight:600;transition:all 0.15s' onmouseover=\"this.style.background='#2a3a5a'\" onmouseout=\"this.style.background='#1a2a3a'\">%d€</button>" % (preset, preset))
    h.append("</div>")
    h.append("</div><!-- cierra capbox -->")
    h.append("<div id=summaryBar class=summary style=margin-bottom:16px></div>")
    h.append("<div style=overflow-x:auto><table><thead><tr>"
             "<th>#</th><th>Ticker</th><th>Sector</th><th>Score</th><th>z</th><th>Peso</th>"
             "<th>Precio</th><th>SL</th><th>TP</th><th>Acc</th><th>Inv</th><th>Risk</th><th>Benef</th><th>Conf</th></tr></thead>"
             "<tbody id=tb></tbody></table></div>")
    h.append("<div class=footer>Olympus Capital - Portfolio Navigator - Fuente: ibkr_orders.csv | Slider recalcula cartera en vivo | Max %d posiciones</div>" % mp)
    h.append("<script>")
    h.append("var D=" + j + ";")
    h.append("function f(v){return Number(v).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2})+' EUR';}")
    h.append("var cr={'HIGH':0,'MED':1,'LOW':2};")
    h.append("var cl={'HIGH':'c-high','MED':'c-med','LOW':'c-low'};")
    h.append("var cb={'HIGH':'c-badge-h','MED':'c-badge-m','LOW':'c-badge-l'};")
    h.append("var MAX_POS=" + str(mp) + ";")
    h.append("function c(){")
    h.append("var cap=parseFloat(document.getElementById('cap').value)||0;")
    h.append("document.getElementById('capDisplay').textContent=cap.toLocaleString('es-ES')+' EUR';")
    h.append("document.getElementById('capInput').value=cap;")
    h.append("if(cap<=0){document.getElementById('tb').innerHTML='';document.getElementById('summaryBar').innerHTML='';return;}")
    h.append("// Use orders AS-IS from ibkr_orders.csv (already GREEDY-SHARPE ordered)")
    h.append("var S=D.slice();")
    h.append("// Limit to MAX_POS, reallocate weights proportionally")
    h.append("if(S.length>MAX_POS){")
    h.append("var topN=S.slice(0,MAX_POS);")
    h.append("var totalW=topN.reduce(function(s,d){return s+d.w;},0);")
    h.append("if(totalW>0){topN.forEach(function(d){d.w=d.w/totalW*100;});}")
    h.append("S=topN;")
    h.append("}")
    h.append("var rem=cap;var hh='';var i=0;var ti=0,tr=0,tb2=0;")
    h.append("S.forEach(function(d){")
    h.append("if(d.e<=0)return;")
    h.append("// Use the actual SL/TP from ibkr_orders.csv if available")
    h.append("var slDist=d.sl>0?(d.e-d.sl):Math.max(d.e*0.015,d.e*0.01);")
    h.append("var tpDist=d.tp>0?(d.tp-d.e):slDist*2;")
    h.append("var sl=+(d.e-slDist).toFixed(2);")
    h.append("var tp=+(d.e+tpDist).toFixed(2);")
    h.append("var ideal=cap*d.w/100;")
    h.append("var size=Math.min(ideal,rem,cap*0.30);")
    h.append("var maxRisk=cap*0.02*d.e/slDist;")
    h.append("size=Math.min(size,maxRisk);")
    h.append("if(size<0.01)return;")
    h.append("var sh=+(size/d.e).toFixed(6);")
    h.append("var inv=size;")
    h.append("var risk=size*slDist/d.e;")
    h.append("var benef=size*tpDist/d.e;")
    h.append("rem-=inv;ti+=inv;tr+=risk;tb2+=benef;i++;")
    h.append("hh+='<tr><td>'+i+'</td><td><strong>'+d.t+'</strong></td>'")
    h.append("+'<td><span class=sec-badge>'+d.sec+'</span></td>'")
    h.append("+'<td class=mo>'+d.s.toFixed(1)+'</td><td class=mo>'+d.z.toFixed(2)+'</td>'")
    h.append("+'<td class=mo>'+d.w.toFixed(1)+'%</td>'")
    h.append("+'<td class=mo>'+f(d.e)+'</td><td class=sl>'+f(sl)+'</td><td class=tp>'+f(tp)+'</td>'")
    h.append("+'<td>'+sh+'</td><td class=mo style=color:#60a5fa>'+f(inv)+'</td>'")
    h.append("+'<td class=mo style=color:#ef4444>'+f(risk)+'</td>'")
    h.append("+'<td class=mo style=color:#4ade80>'+f(benef)+'</td>'")
    h.append("+'<td><span class=\"c-badge '+cb[d.conf]+'\">'+d.conf+'</span></td></tr>';")
    h.append("});")
    h.append("document.getElementById('tb').innerHTML=hh||'<tr><td colspan=14 style=text-align:center;color:#666>Capital insuficiente para cualquier posicion</td></tr>';")
    h.append("document.getElementById('summaryBar').innerHTML=")
    h.append("'<span class=summary-item>Capital: <strong>'+f(cap)+'</strong></span>'")
    h.append("+'<span class=summary-item>Invertido: <strong style=color:#60a5fa>'+f(ti)+'</strong></span>'")
    h.append("+'<span class=summary-item>Riesgo: <strong style=color:#ef4444>'+f(tr)+'</strong></span>'")
    h.append("+'<span class=summary-item>Benef: <strong style=color:#4ade80>'+f(tb2)+'</strong></span>'")
    h.append("+'<span class=summary-item>Posiciones: <strong>'+i+'</strong></span>'")
    h.append("+'<span class=summary-item>Restante: <strong>'+(rem>0?f(rem):'0,00 EUR')+'</strong></span>';")
    h.append("}")
    h.append("document.getElementById('cap').addEventListener('input',c);")
    h.append("document.getElementById('capInput').addEventListener('input',function(){")
    h.append("var v=parseFloat(this.value)||0;")
    h.append("if(v<0)v=0;if(v>1000000)v=1000000;")
    h.append("document.getElementById('cap').value=v;c();")
    h.append("});")
    h.append("function setCap(v){document.getElementById('cap').value=v;document.getElementById('capInput').value=v;c();}")
    h.append("window.addEventListener('load',c);")
    h.append("</script></body></html>")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(h))
    print("Dashboard generado: %s" % OUT)
    print("Ordenes BUY viables: %d | Max posiciones: %d | Slider: 100-10000 EUR" % (len(rows), mp))
    print("Fuente: ibkr_orders.csv (coincide 1:1 con OLYMPUS HEATMAP REGRESSION)")
    if a.open:
        webbrowser.open("file://" + os.path.abspath(OUT))


if __name__ == "__main__":
    main()
