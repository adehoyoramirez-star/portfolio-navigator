import yfinance as yf
import pandas as pd
from datetime import datetime

TICKERS = {
    'BTC-EUR': 'BTC-USD',
    'EMXC.DE': 'EEM',
    'IS3Q.DE': 'QUAL',
    'PPFB.DE': 'GLD',
    'URNU.DE': 'URA',
    'VVSM.DE': 'SMH',
    'XNAS.DE': 'QQQ',
    '^VIX': '^VIX',
    '^TNX': '^TNX',
    '^IRX': '^IRX',
    'HYG': 'HYG',
    'LQD': 'LQD',
}

start_date = '2015-01-01'
end_date = datetime.now().strftime('%Y-%m-%d')

print(f"Descargando datos desde {start_date} hasta {end_date}...")
data = yf.download(list(TICKERS.values()), start=start_date, end=end_date, group_by='ticker', auto_adjust=False)

closes = pd.DataFrame()
for symbol, ticker_yf in TICKERS.items():
    if ticker_yf in data.columns.levels[0]:
        if 'Adj Close' in data[ticker_yf].columns:
            closes[symbol] = data[ticker_yf]['Adj Close']
        elif 'Close' in data[ticker_yf].columns:
            closes[symbol] = data[ticker_yf]['Close']
    else:
        print(f"Advertencia: No se encontraron datos para {symbol} ({ticker_yf})")

closes = closes.dropna(how='all')
closes = closes.ffill().bfill()   # <--- LÍNEA CORREGIDA

closes.to_csv('historical_data_daily.csv')
print(f"Datos guardados en historical_data_daily.csv con {len(closes)} días.")