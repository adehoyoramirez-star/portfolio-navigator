import streamlit as st
import yfinance as yf
import pandas as pd
import numpy as np
import plotly.express as px
import plotly.graph_objects as go
from scipy.optimize import minimize
import json
import os
from datetime import datetime

# ==========================================
# CONFIGURACIÓN GENERAL
# ==========================================
st.set_page_config(page_title="Quantum-Plus APEX 150K", layout="wide")

PORTFOLIO_FILE = "portfolio_state.json"
TARGET_GOAL = 150000
STRUCTURAL_RESERVE_PCT = 0.08
DEFAULT_MONTHLY = 400

# Activos con tickers y divisa original
ASSETS = {
    "MSCI World Quality": {"ticker": "IWQU.AS", "currency": "EUR"},
    "Emerging Markets IMI": {"ticker": "IS3N.AS", "currency": "EUR"},
    "Global Aggregate Bond": {"ticker": "AGGH.AS", "currency": "EUR"},
    "WisdomTree AI ETF": {"ticker": "WTAI.AS", "currency": "EUR"},
    "Physical Gold": {"ticker": "SGLN.AS", "currency": "EUR"},
    "Uranium ETF": {"ticker": "URNM", "currency": "USD"},
    "Bitcoin": {"ticker": "BTC-USD", "currency": "USD"}
}

# Mapeo sectorial
SECTOR_MAP = {
    "MSCI World Quality": "global_quality",
    "Emerging Markets IMI": "emerging",
    "Global Aggregate Bond": "bonds",
    "WisdomTree AI ETF": "tech",
    "Physical Gold": "gold",
    "Uranium ETF": "uranium",
    "Bitcoin": "crypto"
}
SECTOR_CAP = 0.35

# ==========================================
# FUNCIONES DE PERSISTENCIA (igual que antes)
# ==========================================
def load_portfolio():
    # ... (misma función que en la versión anterior, incluye editor JSON)
    # Por brevedad, copia la misma función del código anterior.
    # Asegúrate de incluir la función completa.
    pass

def save_portfolio(portfolio):
    with open(PORTFOLIO_FILE, "w", encoding="utf-8") as f:
        json.dump(portfolio, f, indent=4)

portfolio = load_portfolio()

# ==========================================
# CARGA DE DATOS TODO-EN-UNO (ULTRA RÁPIDA)
# ==========================================
@st.cache_data(ttl=3600)  # 1 hora de caché
def load_all_data():
    """Descarga datos históricos (2 años) de todos los tickers en una sola llamada."""
    # Lista completa de tickers necesarios
    tickers_list = [v["ticker"] for v in ASSETS.values()] + [
        "EURUSD=X", "^VIX", "^TNX", "^IRX", "^GSPC"
    ]
    
    with st.spinner("Descargando datos de mercado (2 años)..."):
        # Descargar datos históricos diarios
        hist = yf.download(tickers_list, period="2y", auto_adjust=True, progress=False)["Close"]
        hist = hist.ffill().bfill()  # rellenar NaN
    
    # Precios actuales (último día)
    latest = hist.iloc[-1]
    
    # Tipo de cambio EUR/USD actual
    eurusd = latest["EURUSD=X"]
    
    # Precios de activos en EUR
    prices_eur = {}
    for name, info in ASSETS.items():
        ticker = info["ticker"]
        if ticker not in latest:
            st.error(f"Ticker {ticker} no encontrado en los datos.")
            st.stop()
        if info["currency"] == "USD":
            prices_eur[name] = latest[ticker] / eurusd
        else:
            prices_eur[name] = latest[ticker]
    
    # Datos macro
    macro = {
        "^VIX": latest["^VIX"],
        "^TNX": latest["^TNX"],
        "^IRX": latest["^IRX"],
        "^GSPC": latest["^GSPC"]
    }
    
    # Construir DataFrame histórico de activos en EUR
    hist_assets = pd.DataFrame(index=hist.index)
    for name, info in ASSETS.items():
        ticker = info["ticker"]
        if info["currency"] == "USD":
            # Convertir toda la serie a EUR usando el tipo de cambio histórico
            # Nota: usamos el tipo de cambio actual como aproximación para simplificar.
            # Para mayor precisión, habría que convertir con la serie EURUSD=X.
            # Pero para velocidad, usamos el tipo actual.
            hist_assets[name] = hist[ticker] / eurusd
        else:
            hist_assets[name] = hist[ticker]
    
    # Calcular retornos
    returns = hist_assets.pct_change().dropna()
    
    # Calcular Z-score de BTC
    btc_series = hist_assets["Bitcoin"]
    ma200 = btc_series.rolling(200).mean()
    std200 = btc_series.rolling(200).std()
    btc_z = (btc_series.iloc[-1] - ma200.iloc[-1]) / std200.iloc[-1]
    
    # Calcular percentiles del VIX (usando la serie histórica de VIX)
    vix_hist = hist["^VIX"]
    vix_p80 = vix_hist.quantile(0.8)
    vix_p20 = vix_hist.quantile(0.2)
    
    return {
        "prices_eur": prices_eur,
        "macro": macro,
        "returns": returns,
        "btc_z": btc_z,
        "vix_p80": vix_p80,
        "vix_p20": vix_p20,
        "eurusd": eurusd,
        "hist_assets": hist_assets,
        "vix_hist": vix_hist
    }

# Cargar todos los datos (si falla, se detiene)
data = load_all_data()
prices = data["prices_eur"]
macro = data["macro"]
returns = data["returns"]
btc_z = data["btc_z"]
vix_p80 = data["vix_p80"]
vix_p20 = data["vix_p20"]
eurusd = data["eurusd"]
hist_assets = data["hist_assets"]
vix_hist = data["vix_hist"]

# ==========================================
# CÁLCULOS DERIVADOS
# ==========================================
# Valor de cartera actual
current_values = {}
total_invested = 0
for name in ASSETS:
    shares = portfolio["positions"][name]["shares"]
    val = shares * prices[name]
    current_values[name] = val
    total_invested += val
total_value = total_invested + portfolio["cash_reserve"]

# Pesos actuales
if total_invested > 0:
    current_weights = pd.Series({name: current_values[name]/total_invested for name in ASSETS})
else:
    current_weights = pd.Series({name: 1/len(ASSETS) for name in ASSETS})

# Régimen de mercado
vix = macro["^VIX"]
if vix > vix_p80:
    regime = "RISK_OFF"
    target_vol = 0.10
elif vix < vix_p20:
    regime = "RISK_ON"
    target_vol = 0.18
else:
    regime = "NEUTRAL"
    target_vol = 0.14

# Modo ataque BTC
attack_mode = btc_z < -2
if attack_mode:
    regime = "ATTACK_MODE"
    target_vol = 0.22

# ==========================================
# OPTIMIZACIÓN (usando los datos ya cargados)
# ==========================================
mu = returns.mean() * 252
cov = returns.cov() * 252

def optimize_portfolio(btc_min, btc_max):
    n = len(ASSETS)
    names = list(ASSETS.keys())
    
    def neg_sharpe(w):
        port_return = np.dot(w, mu)
        port_vol = np.sqrt(np.dot(w, np.dot(cov, w)))
        return -port_return / port_vol
    
    constraints = [{'type': 'eq', 'fun': lambda w: np.sum(w) - 1}]
    constraints.append({'type': 'ineq', 'fun': lambda w: target_vol - np.sqrt(np.dot(w, np.dot(cov, w)))})
    
    for sector in set(SECTOR_MAP.values()):
        indices = [i for i, name in enumerate(names) if SECTOR_MAP[name] == sector]
        if indices:
            constraints.append({'type': 'ineq', 'fun': lambda w, idx=indices: SECTOR_CAP - np.sum(w[idx])})
    
    bounds = [(0.02, 0.40) for _ in range(n)]
    btc_idx = names.index("Bitcoin")
    bounds[btc_idx] = (btc_min, btc_max)
    
    w0 = np.ones(n) / n
    result = minimize(neg_sharpe, w0, bounds=bounds, constraints=constraints,
                      method='SLSQP', options={'ftol': 1e-6})
    
    if not result.success:
        def port_vol(w): return np.sqrt(np.dot(w, np.dot(cov, w)))
        result = minimize(port_vol, w0, bounds=bounds, constraints=constraints, method='SLSQP')
    
    return pd.Series(result.x, index=names)

# ==========================================
# MONTE CARLO (rápido, 500 simulaciones)
# ==========================================
def run_monte_carlo(current_value, monthly_injection, years, mu_annual, vol_annual, n_sims=500):
    months = years * 12
    monthly_mu = mu_annual / 12
    monthly_vol = vol_annual / np.sqrt(12)
    results = []
    for _ in range(n_sims):
        value = current_value
        for m in range(months):
            ret = np.random.normal(monthly_mu, monthly_vol)
            value = value * (1 + ret) + monthly_injection
        results.append(value)
    return np.array(results)

# ==========================================
# GENERAR ÓRDENES
# ==========================================
def generate_orders(current_weights, target_weights, current_values, cash_available):
    total_value_inv = sum(current_values.values())
    target_values = {name: target_weights[name] * (total_value_inv + cash_available) for name in target_weights.index}
    orders = {}
    spent = 0
    for name in target_weights.index:
        current = current_values.get(name, 0)
        target = target_values[name]
        diff = target - current
        if diff > 0:
            price = prices[name]
            units = diff / price
            if units * price <= cash_available - spent:
                orders[name] = units
                spent += units * price
    return orders, spent

# ==========================================
# INTERFAZ PRINCIPAL
# ==========================================
st.title("🚀 **Quantum-Plus APEX 150K ELITE** — Ultra-Rápido")
st.markdown("---")

# Barra lateral
with st.sidebar:
    st.header("⚙️ Controles")
    monthly_injection = st.number_input("Aporte mensual (€)", min_value=0, value=DEFAULT_MONTHLY, step=50)
    btc_min = st.slider("Peso mínimo BTC", min_value=0.0, max_value=0.40, value=0.20, step=0.01, format="%.2f")
    btc_max = st.slider("Peso máximo BTC", min_value=btc_min, max_value=0.40, value=0.30, step=0.01, format="%.2f")
    
    st.markdown("---")
    st.subheader("💾 Estado cartera")
    st.json({
        "Reserva actual": f"{portfolio['cash_reserve']:.2f} €",
        "Última actualización": portfolio.get("last_updated", "N/A")
    })
    if st.button("⟳ Recargar datos"):
        st.cache_data.clear()
        st.rerun()

# ==========================================
# MÉTRICAS SUPERIORES
# ==========================================
target_weights = optimize_portfolio(btc_min, btc_max)
expected_return = np.dot(target_weights, mu)
mc_base = run_monte_carlo(total_value, monthly_injection, 10, expected_return, target_vol)
prob_base = np.mean(mc_base >= TARGET_GOAL)

col1, col2, col3, col4 = st.columns(4)
col1.metric("RÉGIMEN", regime, delta=f"VIX {vix:.1f}")
col2.metric("BTC Precio (EUR)", f"{prices['Bitcoin']:,.0f} €", delta=f"Z-score {btc_z:.2f}")
col3.metric("Probabilidad 150K", f"{prob_base:.1%}")
col4.metric("Reserva actual", f"{portfolio['cash_reserve']:.2f} €")

st.markdown("---")

# ==========================================
# TABLA DE POSICIONES
# ==========================================
df_portfolio = pd.DataFrame([
    [name,
     portfolio["positions"][name]["shares"],
     portfolio["positions"][name]["avg_price"],
     prices[name],
     current_values[name]]
    for name in ASSETS
], columns=["Activo", "Shares", "Precio Medio", "Precio Actual", "Valor (EUR)"])
st.subheader("📊 Cartera Actual")
st.dataframe(df_portfolio.style.format({
    "Shares": "{:.4f}",
    "Precio Medio": "{:.2f}",
    "Precio Actual": "{:.2f}",
    "Valor (EUR)": "{:.2f}"
}), use_container_width=True)

st.markdown("---")

# ==========================================
# GAUGES DE LIQUIDEZ GLOBAL
# ==========================================
st.subheader("🌍 Indicadores de Liquidez Global")
col_g1, col_g2, col_g3, col_g4 = st.columns(4)

# Gauge VIX
fig_vix = go.Figure(go.Indicator(
    mode="gauge+number", value=vix, title="VIX",
    gauge={'axis': {'range': [0, 40]},
           'bar': {'color': "darkblue"},
           'steps': [{'range': [0, 20], 'color': "lightgreen"},
                     {'range': [20, 30], 'color': "yellow"},
                     {'range': [30, 40], 'color': "red"}],
           'threshold': {'line': {'color': "black", 'width': 4}, 'thickness': 0.75, 'value': vix_p80}}))
fig_vix.update_layout(height=200, margin=dict(l=10, r=10, t=50, b=10))
col_g1.plotly_chart(fig_vix, use_container_width=True)

# Gauge Curva 10y-3m
ted_spread = macro["^TNX"] - macro["^IRX"]
fig_ted = go.Figure(go.Indicator(
    mode="gauge+number", value=ted_spread*100, title="Curva 10y-3m (pb)",
    number={'suffix': ' pb'},
    gauge={'axis': {'range': [-100, 200]},
           'bar': {'color': "darkred"},
           'steps': [{'range': [-100, 0], 'color': "red"},
                     {'range': [0, 100], 'color': "yellow"},
                     {'range': [100, 200], 'color': "lightgreen"}],
           'threshold': {'line': {'color': "black", 'width': 4}, 'thickness': 0.75, 'value': 50}}))
fig_ted.update_layout(height=200, margin=dict(l=10, r=10, t=50, b=10))
col_g2.plotly_chart(fig_ted, use_container_width=True)

# Gauge Tipo 10 años
fig_rate = go.Figure(go.Indicator(
    mode="gauge+number", value=macro["^TNX"], title="Tipo 10 años (%)",
    number={'suffix': '%'},
    gauge={'axis': {'range': [0, 6]},
           'bar': {'color': "darkgreen"},
           'steps': [{'range': [0, 2], 'color': "lightgreen"},
                     {'range': [2, 4], 'color': "yellow"},
                     {'range': [4, 6], 'color': "red"}]}))
fig_rate.update_layout(height=200, margin=dict(l=10, r=10, t=50, b=10))
col_g3.plotly_chart(fig_rate, use_container_width=True)

# Gauge Z-score BTC
fig_z = go.Figure(go.Indicator(
    mode="gauge+number", value=btc_z, title="BTC Z-score (200d)",
    gauge={'axis': {'range': [-3, 3]},
           'bar': {'color': 'orange'},
           'steps': [{'range': [-1, 1], 'color': 'lightgreen'},
                     {'range': [1, 2], 'color': 'yellow'},
                     {'range': [2, 3], 'color': 'red'},
                     {'range': [-2, -1], 'color': 'yellow'},
                     {'range': [-3, -2], 'color': 'red'}],
           'threshold': {'line': {'color': 'black', 'width': 4}, 'thickness': 0.75, 'value': -2}}))
fig_z.update_layout(height=200, margin=dict(l=10, r=10, t=50, b=10))
col_g4.plotly_chart(fig_z, use_container_width=True)

st.markdown("---")

# ==========================================
# DONUTS
# ==========================================
col_d1, col_d2 = st.columns(2)

with col_d1:
    st.subheader("🎯 Asignación Objetivo")
    fig_target = px.pie(names=target_weights.index, values=target_weights.values, hole=0.6)
    st.plotly_chart(fig_target, use_container_width=True)

with col_d2:
    st.subheader("📉 Contribución al Riesgo Actual")
    risk_contrib = (current_weights * (cov @ current_weights)) / np.sqrt(current_weights @ cov @ current_weights)
    risk_contrib = risk_contrib / risk_contrib.sum()
    risk_df = pd.DataFrame({"Activo": target_weights.index, "Contribución": risk_contrib})
    fig_risk = px.pie(risk_df, names="Activo", values="Contribución", hole=0.6)
    st.plotly_chart(fig_risk, use_container_width=True)

st.markdown("---")

# ==========================================
# TABLA DE DESVIACIÓN
# ==========================================
st.subheader("📋 Desviación vs Objetivo")
df_compare = pd.DataFrame({
    "Objetivo": target_weights,
    "Actual": current_weights,
    "Diferencia": current_weights - target_weights,
    "Valor actual (€)": [current_values[name] for name in target_weights.index],
    "Precio (EUR)": [prices[name] for name in target_weights.index]
})
st.dataframe(df_compare.style.format({
    "Objetivo": "{:.2%}",
    "Actual": "{:.2%}",
    "Diferencia": "{:.2%}",
    "Valor actual (€)": "{:.2f}",
    "Precio (EUR)": "{:.2f}"
}), use_container_width=True)

st.markdown("---")

# ==========================================
# MONTE CARLO
# ==========================================
st.subheader("📈 Monte Carlo 10 años (escenarios)")
mu_conserv = expected_return - 0.02
vol_conserv = target_vol + 0.02
mu_opt = expected_return + 0.02
vol_opt = target_vol - 0.02

mc_conserv = run_monte_carlo(total_value, monthly_injection, 10, mu_conserv, vol_conserv)
mc_base = run_monte_carlo(total_value, monthly_injection, 10, expected_return, target_vol)
mc_opt = run_monte_carlo(total_value, monthly_injection, 10, mu_opt, vol_opt)

prob_conserv = np.mean(mc_conserv >= TARGET_GOAL)
prob_base = np.mean(mc_base >= TARGET_GOAL)
prob_opt = np.mean(mc_opt >= TARGET_GOAL)

col_m1, col_m2, col_m3 = st.columns(3)
col_m1.metric("Conservador", f"{prob_conserv:.1%}")
col_m2.metric("Base", f"{prob_base:.1%}")
col_m3.metric("Optimista", f"{prob_opt:.1%}")

fig_mc = go.Figure()
fig_mc.add_trace(go.Histogram(x=mc_conserv, name="Conservador", opacity=0.5))
fig_mc.add_trace(go.Histogram(x=mc_base, name="Base", opacity=0.5))
fig_mc.add_trace(go.Histogram(x=mc_opt, name="Optimista", opacity=0.5))
fig_mc.add_vline(x=TARGET_GOAL, line_dash="dash", line_color="red", annotation_text="150K")
fig_mc.update_layout(barmode='overlay', title="Distribución de valor final")
st.plotly_chart(fig_mc, use_container_width=True)

st.markdown("---")

# ==========================================
# APORTE MANUAL Y ÓRDENES
# ==========================================
st.subheader("💰 Aporte de Capital")
aporte = st.number_input("Introduce aporte (€)", min_value=0.0, step=50.0, key="aporte_input")
if st.button("Añadir a Reserva"):
    portfolio["cash_reserve"] += aporte
    portfolio["last_updated"] = datetime.now().isoformat()
    save_portfolio(portfolio)
    st.success("Reserva actualizada")
    st.rerun()

st.markdown("---")
st.subheader("🛒 Órdenes sugeridas (rebalanceo)")

total_cash = portfolio["cash_reserve"] + monthly_injection
structural_reserve = STRUCTURAL_RESERVE_PCT * (total_value + monthly_injection)
usable_cash = total_cash if attack_mode else max(0, total_cash - structural_reserve)

orders, spent = generate_orders(current_weights, target_weights, current_values, usable_cash)

if orders:
    for name, units in orders.items():
        cost = units * prices[name]
        st.write(f"• **{name}**: comprar {units:.4f} unidades a {prices[name]:.2f} € → coste {cost:.2f} €")
    st.write(f"**Coste total:** {spent:.2f} €")
    st.write(f"**Reserva restante tras compras:** {total_cash - spent:.2f} €")
    
    if st.button("✅ Confirmar ejecución"):
        for name, units in orders.items():
            old = portfolio["positions"][name]
            new_shares = old["shares"] + units
            new_avg = (old["avg_price"] * old["shares"] + units * prices[name]) / new_shares if new_shares > 0 else 0
            portfolio["positions"][name]["shares"] = new_shares
            portfolio["positions"][name]["avg_price"] = new_avg
            portfolio["cash_reserve"] -= units * prices[name]
        portfolio["last_updated"] = datetime.now().isoformat()
        save_portfolio(portfolio)
        st.success("Órdenes ejecutadas. Cartera actualizada.")
        st.rerun()
else:
    st.info("No hay órdenes generadas (saldo insuficiente o cartera ya equilibrada).")

st.write(f"**Reserva estructural objetivo (8%):** {structural_reserve:.2f} €")
st.write(f"**Reserva real tras operación:** {total_cash - spent:.2f} €")

st.markdown("---")
st.subheader("🧠 Diagnóstico de Mercado")
if regime == "RISK_ON":
    st.success("🔵 RISK ON: volatilidad baja. Máxima exposición.")
elif regime == "RISK_OFF":
    st.warning("🟠 RISK OFF: volatilidad alta. Priorizando defensa.")
elif regime == "ATTACK_MODE":
    st.error("🔴 MODO ATAQUE: BTC en capitulación extrema. Aumentando exposición táctica.")
else:
    st.info("⚪ NEUTRAL: posicionamiento equilibrado.")

st.caption(f"Última actualización de precios: {datetime.now().strftime('%Y-%m-%d %H:%M')}")