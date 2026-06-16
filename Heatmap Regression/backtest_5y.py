#!/usr/bin/env python3
"""backtest_5y.py — Descarga 5 años de datos OHLC para backtest.
Genera backtest_5y_cache.pkl con closes, highs, lows + SPY garantizado.
"""
import pickle, time, sys
import yfinance as yf
import pandas as pd

PERIOD = "5y"
OUTPUT = "backtest_5y_cache.pkl"

# Universo: SP500 desde Wikipedia + curados
CURATED = [
    "SPY","QQQ","IWM","DIA","MDY",
    "XLK","XLF","XLV","XLY","XLI","XLC","XLE","XLP","XLRE","XLB","XLU",
    "EEM","EFA","EWJ","FXI","EWZ","INDA","IEUR","VGK",
    "GLD","SLV","USO","DBC",
    "TLT","AGG","LQD","HYG",
    "IBIT","FBTC","BITO",
]

print("Obteniendo SP500 desde Wikipedia...")
try:
    tables = pd.read_html(
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
        storage_options={"User-Agent": "Mozilla/5.0 Olympus/5.0"})
    sp500 = tables[0]
    col = "Symbol" if "Symbol" in sp500.columns else sp500.columns[0]
    sp500_tickers = [t.replace(".", "-") for t in sp500[col].tolist()]
    print(f"   OK {len(sp500_tickers)} tickers SP500")
except Exception as e:
    print(f"   ⚠️ Wikipedia falló: {e}")
    sp500_tickers = []

all_tickers = list(dict.fromkeys(CURATED + sp500_tickers))  # Preserva orden, SPY primero
# Asegurar SPY está primero
if "SPY" in all_tickers:
    all_tickers.remove("SPY")
all_tickers.insert(0, "SPY")
print(f"Descargando {len(all_tickers)} tickers ({PERIOD})...")

# Descargar en chunks
chunk_size = 200
all_close, all_high, all_low = {}, {}, {}
chunks = [all_tickers[i:i+chunk_size] for i in range(0, len(all_tickers), chunk_size)]
print(f"   {len(chunks)} chunks de hasta {chunk_size} tickers...")

for ci, chunk in enumerate(chunks):
    for attempt in range(3):
        try:
            data = yf.download(chunk, period=PERIOD, progress=False, auto_adjust=True)
            if data.empty:
                break
            if isinstance(data.columns, pd.MultiIndex):
                c = data["Close"] if "Close" in data.columns.get_level_values(0) else pd.DataFrame()
                h = data["High"] if "High" in data.columns.get_level_values(0) else pd.DataFrame()
                l = data["Low"] if "Low" in data.columns.get_level_values(0) else pd.DataFrame()
            else:
                c = data[["Close"]].rename(columns={"Close": chunk[0]}) if "Close" in data.columns else pd.DataFrame()
                h = data[["High"]].rename(columns={"High": chunk[0]}) if "High" in data.columns else pd.DataFrame()
                l = data[["Low"]].rename(columns={"Low": chunk[0]}) if "Low" in data.columns else pd.DataFrame()
            for t in c.columns:
                all_close[t] = c[t]
                if t in h.columns:
                    all_high[t] = h[t]
                if t in l.columns:
                    all_low[t] = l[t]
            break
        except Exception as ex:
            if attempt < 2:
                print(f"   ⚠️ Chunk {ci+1} retry {attempt+1}: {ex}")
                time.sleep(3)
            else:
                print(f"   ❌ Chunk {ci+1} failed: {ex}")
    pct = min(100, (ci+1)*chunk_size/len(all_tickers)*100)
    sys.stdout.write(f"\r   {pct:.0f}%")
    sys.stdout.flush()
print()

closes = pd.DataFrame(all_close)
highs = pd.DataFrame(all_high)
lows = pd.DataFrame(all_low)

# Filtrar tickers con suficientes datos
min_days = 750  # ~3 años mínimo para backtest de 5 años
valid = [t for t in closes.columns if closes[t].notna().sum() >= min_days]
closes = closes[valid]
highs = highs[valid] if not highs.empty else pd.DataFrame(index=closes.index)
lows = lows[valid] if not lows.empty else pd.DataFrame(index=closes.index)

print(f"OK {len(valid)} tickers validos (>={min_days} dias)")
print(f"Rango: {closes.index[0].strftime('%d/%m/%Y')} -> {closes.index[-1].strftime('%d/%m/%Y')} ({len(closes)} dias)")
print(f"   SPY presente: {'SPY' in closes.columns}")

with open(OUTPUT, "wb") as f:
    pickle.dump({"closes": closes, "highs": highs, "lows": lows}, f)
print(f"Cache guardado: {OUTPUT} ({__import__('os').path.getsize(OUTPUT)/1024/1024:.1f} MB)")
print("Listo. Ejecuta: python _run_backtest.py")
