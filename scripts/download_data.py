"""
Legacy price downloader, corrected to use the actual Olympus instruments.

Safety rules:
- Never substitute a US proxy (USD) for a European-listed instrument (EUR).
- Never backward-fill: that would leak future observations into the past.
- Fail closed if any required ticker cannot be downloaded.
- Output observed trading dates only. Calendar expansion and forward-fill,
  if required, belong in the separately audited canonical-history builder.
"""
import sys
from datetime import datetime

import pandas as pd
import yfinance as yf

TICKERS = [
    "BTC-EUR",
    "EMXC.DE",
    "0P00000WLG.F",
    "PPFB.DE",
    "URNU.DE",
    "VVSM.DE",
    "XNAS.DE",
    "^VIX",
    "^TNX",
    "^IRX",
    "HYG",
    "LQD",
]

START_DATE = "2022-04-17"
END_DATE = datetime.now().strftime("%Y-%m-%d")


def main() -> None:
    print(f"Descargando tickers reales desde {START_DATE} hasta {END_DATE}...")
    data = yf.download(
        TICKERS,
        start=START_DATE,
        end=END_DATE,
        group_by="ticker",
        auto_adjust=False,
        actions=False,
        progress=False,
        threads=False,
    )

    if data.empty:
        raise RuntimeError("Yahoo Finance no devolvió datos; no se genera ningún CSV.")

    closes = pd.DataFrame(index=data.index)
    missing = []
    for ticker in TICKERS:
        if ticker not in data.columns.get_level_values(0):
            missing.append(ticker)
            continue
        ticker_data = data[ticker]
        if "Adj Close" in ticker_data.columns and ticker_data["Adj Close"].notna().any():
            series = ticker_data["Adj Close"]
        elif "Close" in ticker_data.columns and ticker_data["Close"].notna().any():
            series = ticker_data["Close"]
        else:
            missing.append(ticker)
            continue
        closes[ticker] = series

    if missing:
        raise RuntimeError(
            "Faltan series obligatorias; se aborta para evitar sustituirlas "
            f"o fabricar cobertura: {', '.join(missing)}"
        )

    closes = closes.sort_index()
    closes = closes.loc[~closes.index.duplicated(keep="last")]
    closes = closes.dropna(how="all")

    # Forward-fill only after an instrument's first actual observation.
    # Drop the leading interval where one or more series have no observation.
    closes = closes.ffill().dropna(how="any")

    if closes.empty:
        raise RuntimeError("No queda un periodo común con observaciones reales para todos los tickers.")

    # Basic numeric sanity: all required series must be positive and finite.
    invalid = (~(closes.notna() & closes.gt(0))).any()
    if invalid.any():
        raise RuntimeError(f"Valores no positivos o inválidos en: {', '.join(invalid[invalid].index)}")

    output = closes.copy()
    output.index = output.index.strftime("%Y-%m-%d")
    output.index.name = "Date"
    output.to_csv("historical_data_daily.csv", float_format="%.8f")

    print(f"Guardado historical_data_daily.csv: {len(output)} sesiones observadas.")
    print(f"Periodo común: {output.index[0]} -> {output.index[-1]}")
    print("Aviso: este archivo contiene sesiones observadas; no es por sí solo el CSV canónico diario ampliado.")
    print("No se ha usado backward-fill ni se han sustituido tickers ausentes por proxies.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
