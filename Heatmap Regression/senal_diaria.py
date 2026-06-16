#!/usr/bin/env python3
"""SENAL DIARIA v1.2 — Para operativa manual (AUDITADO)

Genera un informe HTML claro y accionable con las senales del modelo.

Cambios v1.2 (audit):
  - FIX CRITICO: barra de score JS corregida (d.sc, no d.sc*10)
  - FIX CRITICO: SL del modelo se usa directamente (eliminado piso 1.5% arbitrario)
  - FIX CRITICO: TP del modelo se usa directamente (eliminado recalculo slD*2)
  - FIX: filtro viable robusto con pd.isna()
  - FIX: tabla AVOID limitada a top-N por score (default 12)
  - NUEVO: columnas Sector, Z, RiesgoEUR en tabla BUY
  - NUEVO: sizing cap bajado a 20% por posicion (de 30%)
  - NUEVO: per-pos EUR correcto en tarjeta "Max/Pos"
  - NUEVO: validacion de argumentos CLI

Uso: python senal_diaria.py
     python senal_diaria.py --capital 5000
     python senal_diaria.py --capital 3500 --per-pos 500
     python senal_diaria.py --top-avoid 15   # cuantas filas AVOID mostrar
"""
import os, sys, json
from datetime import datetime
import pandas as pd
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
SIGNAL_FILE = os.path.join(BASE, 'ibkr_orders.csv')
OUTPUT_FILE = os.path.join(BASE, 'senal_diaria.html')

# ─── Constantes de riesgo ─────────────────────────────────────────────
MAX_POSITION_PCT   = 0.20   # max 20% del capital por posicion
RISK_PCT_PER_TRADE = 0.02   # max 2% del capital en riesgo por trade
DEFAULT_TOP_AVOID  = 12     # filas AVOID a mostrar en el informe
# ──────────────────────────────────────────────────────────────────────


def load_signals():
    if not os.path.exists(SIGNAL_FILE):
        print('ERROR: No encuentro ' + SIGNAL_FILE)
        print('Ejecuta primero: python OLYMPUS_HEATMAP_REGRESSION_v7.py --mode swing --capital 700')
        sys.exit(1)
    df = pd.read_csv(SIGNAL_FILE)
    print(f'Cargadas {len(df)} filas del CSV ({(df["action"]=="BUY").sum()} BUY, {(df["action"]=="AVOID").sum()} AVOID)')
    return df


def _is_viable(row):
    """Robusto contra bool, string 'True'/'False' y NaN."""
    v = row.get('viable') if hasattr(row, 'get') else row['viable']
    if pd.isna(v):
        return False
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() == 'true'


def generar_html(df, capital_override=None, per_pos_override=None, top_avoid=DEFAULT_TOP_AVOID):
    now   = datetime.now()
    fecha = now.strftime('%d/%m/%Y')
    hora  = now.strftime('%H:%M')

    # ── Separar BUY/AVOID de forma robusta ──────────────────────────────
    buys   = df[(df['action'] == 'BUY') & df.apply(_is_viable, axis=1)].copy()
    avoids = df[~df.apply(_is_viable, axis=1)].copy()   # todo lo no-viable

    if len(buys) > 0 and 'score' in buys.columns:
        buys = buys.sort_values('score', ascending=False)

    # ── Capital y sizing ─────────────────────────────────────────────────
    n_buys   = len(buys)
    n_avoids = len(avoids)
    csv_capital = float(buys['size_eur'].sum()) if ('size_eur' in buys.columns and n_buys > 0) else 0.0

    if capital_override is not None:
        if capital_override <= 0:
            print('ERROR: --capital debe ser > 0')
            sys.exit(1)
        total_capital = float(capital_override)
    else:
        total_capital = csv_capital if csv_capital > 0 else 1000.0

    max_pos = max(n_buys, 1)
    if per_pos_override is not None:
        if per_pos_override <= 0:
            print('ERROR: --per-pos debe ser > 0')
            sys.exit(1)
        per_pos = int(per_pos_override)
        total_capital = per_pos * max_pos
    else:
        per_pos = int(total_capital / max_pos)

    # ── Construir JSON de senales para el JS ─────────────────────────────
    signals_json = []
    for _, r in buys.iterrows():
        ticker = r.get('ticker', '?')
        entry  = float(r.get('entry_price', 0))
        sl     = float(r.get('stop_loss',   0))
        tp     = float(r.get('take_profit', 0))
        conf   = str(r.get('confidence', 'medium')).strip().lower()
        score  = float(r.get('score',    0))
        sector = str(r.get('sector',     'N/A'))
        z      = float(r.get('z_score',  0))
        risk_e = float(r.get('risk_eur', 0))

        # R:R: usar el del CSV si existe y es valido, calcular como fallback
        rr_csv = r.get('rr_ratio', None)
        if rr_csv is not None and not pd.isna(rr_csv) and float(rr_csv) > 0:
            rr_val = round(float(rr_csv), 1)
        else:
            risk_p   = abs(entry - sl)   if sl != 0 else entry * 0.02
            reward_p = abs(tp   - entry) if tp != 0 else risk_p * 2.0
            rr_val   = round(reward_p / risk_p, 1) if risk_p > 0 else 2.0

        if conf not in ('high', 'medium', 'low'):
            conf = 'medium'

        signals_json.append({
            't':    ticker,
            'e':    round(entry, 4),
            'sl':   round(sl,    4),
            'tp':   round(tp,    4),
            'rr':   rr_val,
            'sc':   round(score, 1),
            'c':    conf,
            'sec':  sector,
            'z':    round(z, 2),
            're':   round(risk_e, 2),   # risk en EUR segun el modelo
        })

    # ── AVOID: top-N por score descendente (los mas cerca del umbral) ─────
    avoid_rows = []
    if len(avoids) > 0 and 'score' in avoids.columns:
        avoids_sorted = avoids.sort_values('score', ascending=False).head(top_avoid)
    else:
        avoids_sorted = avoids.head(top_avoid)

    for _, r in avoids_sorted.iterrows():
        avoid_rows.append({
            'ticker': r.get('ticker',       '?'),
            'entry':  float(r.get('entry_price', 0)),
            'score':  float(r.get('score',       0)),
            'sector': str(r.get('sector',      'N/A')),
            'reason': r.get('confidence',    'avoid'),
        })

    dt_str = f'{fecha} {hora}'
    avoid_table = _build_avoid_table(avoid_rows, n_avoids) if avoid_rows else ''
    return _build_page(dt_str, n_buys, n_avoids, total_capital, per_pos, max_pos,
                       signals_json, avoid_table, top_avoid)


def _build_avoid_table(avoid_rows, total_avoid):
    shown = len(avoid_rows)
    hidden = max(0, total_avoid - shown)
    note = f' (mostrando top {shown} de {total_avoid} por score)' if total_avoid > shown else f' ({shown} total)'

    html  = f'<div class="st" style="margin-top:32px">AVOID &mdash; No operar{note}</div>\n'
    html += '<table>\n<thead><tr>\n'
    html += '  <th>Ticker</th><th>Sector</th><th>Entry</th><th>Score</th>\n'
    html += '</tr></thead>\n<tbody>\n'
    for r in avoid_rows:
        html += '<tr>'
        html += f'<td class="m">{r["ticker"]}</td>'
        html += f'<td class="m">{r["sector"]}</td>'
        html += f'<td>{r["entry"]:.2f}</td>'
        html += f'<td>{r["score"]:.1f}</td>'
        html += '</tr>\n'
    html += '</tbody>\n</table>'
    if hidden > 0:
        html += f'<div style="font-size:11px;color:#5a7a96;margin-top:4px">...y {hidden} tickers mas en quintiles 1-4</div>'
    return html


def _build_page(dt_str, n_buys, n_avoids, total_capital, per_pos,
                max_pos, signals_json, avoid_table, top_avoid):
    sigs_json_str      = json.dumps(signals_json)
    max_pos_pct_js     = MAX_POSITION_PCT
    risk_pct_trade_js  = RISK_PCT_PER_TRADE

    return f'''<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Senal Diaria \u2014 Olympus</title>
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
.ix{{background:rgba(0,194,255,0.06);border:1px solid rgba(0,194,255,0.2);border-radius:8px;padding:16px;margin-bottom:20px}}
.ix h3{{color:#00c2ff;font-size:13px;margin-bottom:8px}}
.ix ol{{padding-left:20px;font-size:13px;color:#c8d8e8;line-height:1.8}}
.ix code{{background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:3px;font-family:Consolas,monospace;font-size:11px}}
.slider-box{{background:#111927;border:1px solid #1e2d40;border-radius:8px;padding:16px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}}
.slider-box label{{font-size:12px;color:#5a7a96}}
.slider-box input[type=range]{{flex:1;min-width:150px;height:6px;-webkit-appearance:none;background:#1e2d40;border-radius:3px;outline:none}}
.slider-box input[type=range]::-webkit-slider-thumb{{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#00c2ff;cursor:pointer}}
.slider-box input[type=number]{{width:100px;background:#0d1420;border:1px solid #1e2d40;border-radius:6px;color:#fff;padding:6px 10px;font-family:Consolas,monospace}}
.summary{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;font-size:12px}}
.summary span{{padding:4px 12px;background:#0d1420;border:1px solid #1e2d40;border-radius:6px}}
table{{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px}}
th{{text-align:left;padding:10px 8px;border-bottom:2px solid #1e2d40;font-size:10px;color:#5a7a96;text-transform:uppercase;letter-spacing:1px}}
td{{padding:10px 8px;border-bottom:1px solid #1e2d40}}
tr:hover{{background:rgba(0,194,255,0.04)}}
.b-strong{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(0,224,122,0.3);color:#00e07a;border:1px solid #00e07a}}
.b-buy{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(0,224,122,0.2);color:#00e07a}}
.b-low{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(255,200,0,0.15);color:#ffc800}}
.sb{{height:4px;border-radius:2px;background:#1e2d40;margin-top:4px}}
.sf{{height:4px;border-radius:2px;background:#00c2ff}}
.m{{color:#5a7a96;font-size:11px}}
.c-g{{color:#00e07a}}
.c-r{{color:#ff4060}}
.foot{{margin-top:32px;padding:16px;background:#111927;border:1px solid #1e2d40;border-radius:8px;font-size:12px;color:#5a7a96}}
.foot strong{{color:#ff4060}}
.cmd{{margin-top:8px;padding:12px;background:#111927;border:1px solid #1e2d40;border-radius:8px;font-size:12px;color:#5a7a96}}
.cmd code{{background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:3px;font-family:Consolas,monospace}}
.cmd b{{color:#00c2ff}}
.warn-zero{{color:#ff4060;font-weight:700;font-size:12px;padding:8px 12px;background:rgba(255,64,96,0.1);border:1px solid #ff4060;border-radius:6px;margin-bottom:12px;display:none}}
@media(max-width:600px){{.sg{{grid-template-columns:repeat(2,1fr)}}.slider-box{{flex-direction:column}}}}
</style>
</head>
<body>

<h1>Senal Diaria \u2014 Olympus</h1>
<div class="sub" id="subtitle">{dt_str} &middot; {n_buys} BUY &middot; {n_avoids} AVOID &middot; Capital: <span id="capDisplay">{total_capital:.0f}</span> EUR</div>

<div class="sg">
  <div class="cd"><div class="cl">BUY Hoy</div><div class="cv" style="color:#00e07a">{n_buys}</div></div>
  <div class="cd"><div class="cl">Capital Total</div><div class="cv" id="capCard" style="color:#fff">{total_capital:.0f} EUR</div></div>
  <div class="cd"><div class="cl">Max / Pos</div><div class="cv" id="posCard" style="color:#00c2ff">{per_pos} EUR</div></div>
  <div class="cd"><div class="cl">AVOID</div><div class="cv" style="color:#ff4060">{n_avoids}</div></div>
</div>

<div id="warnZero" class="warn-zero">&#9888; Capital insuficiente para al menos una posicion con riesgo controlado</div>

<div class="slider-box">
  <label>Capital:</label>
  <input type="range" id="capSlider" min="100" max="100000" step="100" value="{total_capital:.0f}">
  <input type="number" id="capInput" value="{total_capital:.0f}" step="100" min="100" max="100000">
  <span style="font-size:11px;color:#5a7a96">Posiciones activas: <strong id="posCount" style="color:#00c2ff">{max_pos}</strong></span>
</div>

<div class="summary" id="summaryLine">
  <span>Invertido: <strong id="invSum" style="color:#60a5fa">EUR 0</strong></span>
  <span>Riesgo total: <strong id="riskSum" style="color:#ef4444">EUR 0</strong></span>
  <span>Beneficio est.: <strong id="benefSum" style="color:#4ade80">EUR 0</strong></span>
  <span>Libre: <strong id="remSum" style="color:#5a7a96">EUR 0</strong></span>
</div>

<div class="ix">
<h3>Como operar</h3>
<ol>
  <li>Ajusta el <b>slider de capital</b> a tu capital real disponible hoy</li>
  <li>La tabla BUY muestra sizing ajustado por riesgo (max {int(RISK_PCT_PER_TRADE*100)}% capital en riesgo / trade, max {int(MAX_POSITION_PCT*100)}% capital / posicion)</li>
  <li>Para cada ticker: entra en <b>ENTRY</b>, pon stop en <b>SL</b>, take en <b>TP</b> — sin desviarse</li>
  <li>Columna <b>Z</b>: momento de entrada (>1.5 fuerte, >2 muy fuerte)</li>
  <li>Al cerrar: <code>python cierre_trade.py --ticker TICKER --exit PRECIO --notas "razon"</code></li>
</ol>
</div>

<div class="st">BUY \u2014 Senales de compra</div>
<table id="buyTable">
<thead><tr>
  <th>#</th><th>Ticker</th><th>Sector</th><th>Entry</th><th>SL</th><th>TP</th><th>R:R</th>
  <th>Size</th><th>Riesgo</th><th>Z</th><th>Score</th><th>Conf.</th>
</tr></thead>
<tbody id="buyTbody"></tbody>
</table>
{avoid_table}

<div class="foot">
<strong>REGLAS DE SEGURIDAD</strong><br>
&bull; Drawdown maximo: 20% &mdash; si pierdes mas, PARA todo<br>
&bull; Perdida diaria maxima: 5% &mdash; si hoy pierdes &gt;5%, no operes mas hoy<br>
&bull; Siempre pon SL y TP antes de confirmar la orden &mdash; sin excepciones<br>
&bull; Si el mercado abre con gap respecto al ENTRY, re-evalua antes de entrar<br>
&bull; Sizing mostrado es maximo &mdash; puedes reducir, nunca superar<br>
</div>

<div class="cmd">
<b style="color:#00c2ff">Comandos utiles</b><br>
<code>python paper_trading.py</code> &mdash; Actualizar tracker<br>
<code>python cierre_trade.py --ticker TICKER --exit PRECIO --notas "razon"</code> &mdash; Cerrar trade<br>
<code>python senal_diaria.py --capital CAPITAL</code> &mdash; Regenerar con capital distinto<br>
<code>python OLYMPUS_HEATMAP_REGRESSION_v7.py --mode swing --capital CAPITAL</code> &mdash; Regenerar senales
</div>

<script>
// ── Constantes de riesgo (deben coincidir con Python) ──────────────────
var MAX_POS_PCT   = {max_pos_pct_js};   // max 20% capital por posicion
var RISK_PCT      = {risk_pct_trade_js};  // max 2% capital en riesgo por trade

var SIGS      = {sigs_json_str};
var capSlider = document.getElementById("capSlider");
var capInput  = document.getElementById("capInput");
var tbody     = document.getElementById("buyTbody");

function recalc() {{
  var cap = parseFloat(capSlider.value) || 0;
  capInput.value = cap;
  document.getElementById("capDisplay").textContent  = cap.toFixed(0);
  document.getElementById("capCard").textContent     = cap.toFixed(0) + " EUR";

  if (cap <= 0 || SIGS.length === 0) {{
    tbody.innerHTML = "<tr><td colspan=12 style='text-align:center;color:#5a7a96'>Sin senales</td></tr>";
    document.getElementById("posCard").textContent = "0 EUR";
    return;
  }}

  // Minimo por posicion: suficiente para que el riesgo no sea despreciable
  // (necesitamos al menos 1 EUR en riesgo => posMin = 1 / (SL%))
  // Usamos 50 EUR como floor practico
  var minPP = 50;
  var dynPos = Math.max(1, Math.min(SIGS.length, Math.floor(cap / minPP)));
  var active = SIGS.slice(0, dynPos);

  var rem = cap, totalInv = 0, totalRisk = 0, totalBenef = 0;
  var rows = [];

  for (var i = 0; i < active.length; i++) {{
    var d = active[i];

    // ── SL y TP: usar DIRECTAMENTE los valores del modelo ──────────────
    // BUG CORREGIDO: version anterior usaba Math.max(d.e * 0.015, ...) que
    // sobreescribia el SL del modelo con un piso arbitrario del 1.5%,
    // corrompiendo el sizing cuando el SL es mas ajustado que ese umbral.
    var slD = Math.abs(d.e - d.sl);
    if (slD <= 0) slD = d.e * 0.02;  // fallback solo si SL==ENTRY (datos malos)

    // BUG CORREGIDO: version anterior usaba slD * 2.0, ignorando el TP
    // del modelo por completo. Ahora se usa el TP real.
    var tpD = Math.abs(d.tp - d.e);
    if (tpD <= 0) tpD = slD * d.rr;  // fallback usando R:R del modelo

    // ── Sizing: risk-based con caps ────────────────────────────────────
    // Posicion max por peso igual
    var equalW = cap / dynPos;
    // Posicion max por riesgo: si SL se toca, perdemos <= RISK_PCT * cap
    var riskW  = (cap * RISK_PCT) / (slD / d.e);
    // Aplicar caps: peso igual, riesgo, 20% maximo, y lo que queda libre
    var size = Math.min(equalW, riskW, cap * MAX_POS_PCT, rem);

    if (size < 1) continue;  // posicion minima 1 EUR
    rem       -= size;
    totalInv  += size;
    var tradeRisk   = size * (slD / d.e);
    var tradeBenef  = size * (tpD / d.e);
    totalRisk  += tradeRisk;
    totalBenef += tradeBenef;

    var badge, badgeTxt;
    if      (d.c === "high")   {{ badge = "b-strong"; badgeTxt = "HIGH"; }}
    else if (d.c === "medium") {{ badge = "b-buy";    badgeTxt = "MED";  }}
    else                       {{ badge = "b-low";    badgeTxt = "LOW";  }}

    // BUG CORREGIDO: version anterior usaba d.sc * 10 para el ancho de la
    // barra. Como d.sc esta en escala 0-100, eso daba siempre 100%.
    var pct    = Math.min(100, Math.max(0, d.sc));  // ya es 0-100
    var rrCol  = d.rr >= 1.5 ? "#00e07a" : d.rr >= 1.0 ? "#ffc800" : "#ff4060";
    var zCol   = d.z  >= 2.0 ? "#00e07a" : d.z  >= 1.0 ? "#c8d8e8" : "#5a7a96";

    rows.push(
      "<tr>" +
      "<td class='m'>" + (i+1) + "</td>" +
      "<td><b>" + d.t + "</b></td>" +
      "<td class='m'>" + d.sec + "</td>" +
      "<td><b>" + d.e.toFixed(2) + "</b></td>" +
      "<td class='c-r'>" + d.sl.toFixed(2) + "</td>" +
      "<td class='c-g'>" + d.tp.toFixed(2) + "</td>" +
      "<td style='color:" + rrCol + "'><b>" + d.rr.toFixed(1) + "</b></td>" +
      "<td><b>" + size.toFixed(0) + " EUR</b></td>" +
      "<td class='c-r'>" + tradeRisk.toFixed(1) + " EUR</td>" +
      "<td style='color:" + zCol + "'>" + d.z.toFixed(2) + "</td>" +
      "<td>" + d.sc.toFixed(1) +
        "<div class='sb'><div class='sf' style='width:" + pct + "%'></div></div></td>" +
      "<td><span class='" + badge + "'>" + badgeTxt + "</span></td>" +
      "</tr>"
    );
  }}

  tbody.innerHTML = rows.length > 0
    ? rows.join("")
    : "<tr><td colspan=12 style='text-align:center;color:#5a7a96'>Capital insuficiente para minimo de 1 EUR</td></tr>";

  var perPosEur = active.length > 0 ? (totalInv / active.length) : 0;
  document.getElementById("posCard").textContent  = perPosEur.toFixed(0) + " EUR";
  document.getElementById("posCount").textContent = active.length;
  document.getElementById("invSum").textContent   = "EUR " + totalInv.toFixed(0);
  document.getElementById("riskSum").textContent  = "EUR " + totalRisk.toFixed(1);
  document.getElementById("benefSum").textContent = "EUR " + totalBenef.toFixed(1);
  document.getElementById("remSum").textContent   = "EUR " + Math.max(0, rem).toFixed(0);

  var warn = document.getElementById("warnZero");
  warn.style.display = (rows.length < active.length) ? "block" : "none";
}}

capSlider.addEventListener("input", recalc);
capInput.addEventListener("input", function() {{
  var v = parseFloat(this.value) || 100;
  v = Math.max(100, Math.min(100000, v));
  capSlider.value = v;
  recalc();
}});
window.addEventListener("load", recalc);
</script>
</body></html>'''


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Generar informe diario de senales')
    parser.add_argument('--capital',   type=float, default=None,
                        help='Override capital total EUR (ej: 5000)')
    parser.add_argument('--per-pos',   type=float, default=None,
                        help='Override EUR por posicion (ej: 500). Multiplica x N posiciones para calcular capital')
    parser.add_argument('--top-avoid', type=int,   default=DEFAULT_TOP_AVOID,
                        help=f'Numero de filas AVOID a mostrar en el informe (default {DEFAULT_TOP_AVOID})')
    args = parser.parse_args()

    df   = load_signals()
    html = generar_html(df,
                        capital_override=args.capital,
                        per_pos_override=args.per_pos,
                        top_avoid=args.top_avoid)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'Informe generado: {OUTPUT_FILE}')
    print('Abrelo en tu navegador para ver las senales')


if __name__ == '__main__':
    main()
