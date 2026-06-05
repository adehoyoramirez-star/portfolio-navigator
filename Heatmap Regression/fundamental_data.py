#!/usr/bin/env python3
"""
fundamental_data.py — Olympus v5.1
Factores fundamentales cross-seccionales desde yfinance (GRATIS).

Factores:
  - earnings_surprise:  % sorpresa BPA trimestral (histórico, carry-forward)
  - revenue_growth:     % crecimiento interanual ingresos (histórico, carry-forward)
  - short_interest_pct: % del float en corto (snapshot actual, constante histórica)
  - price_target_up:    targetMeanPrice / currentPrice (snapshot actual, constante histórica)

Cache: .fundamental_cache.pkl (24h)
"""

import os, time, pickle, logging
import pandas as pd
import numpy as np
import yfinance as yf

logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".fundamental_cache.pkl")
CACHE_MAX_AGE = 24 * 3600

# ETFs sin datos fundamentales (no tienen earnings, revenue, short interest)
KNOWN_ETFS = {"SPY","QQQ","IWM","DIA","MDY","XLK","XLF","XLV","XLY","XLI","XLC",
              "XLE","XLP","XLRE","XLB","XLU","EEM","EFA","EWJ","FXI","EWZ",
              "INDA","IEUR","VGK","GLD","SLV","USO","DBC","TLT","AGG",
              "LQD","HYG","IBIT","FBTC","BITO","^VIX"}


def load_cache():
    if not os.path.exists(CACHE_FILE):
        return None
    age = time.time() - os.path.getmtime(CACHE_FILE)
    if age >= CACHE_MAX_AGE:
        return None
    try:
        with open(CACHE_FILE, "rb") as f:
            cached = pickle.load(f)
        required = {"earnings_surprise","revenue_growth","short_interest","price_target","tickers"}
        if not required.issubset(cached.keys()):
            os.remove(CACHE_FILE)
            return None
        return cached
    except Exception:
        try:
            os.remove(CACHE_FILE)
        except Exception:
            pass
        return None


def save_cache(es_df, rg_df, si_df, pt_df, tickers):
    try:
        with open(CACHE_FILE, "wb") as f:
            pickle.dump({
                "earnings_surprise": es_df,
                "revenue_growth": rg_df,
                "short_interest": si_df,
                "price_target": pt_df,
                "tickers": list(si_df.columns),
                "timestamp": time.time(),
            }, f)
        print(f"   fundamental cache: {os.path.getsize(CACHE_FILE)/1024:.0f} KB")
    except Exception as e:
        print(f"   no se pudo guardar cache fundamental: {e}")


def fetch_fundamental_factors(tickers, target_index):
    """
    Obtiene 4 factores fundamentales desde yfinance.
    Returns dict: {factor_name: DataFrame(n_days, n_tickers)}
    """
    print(f"   Factores fundamentales (yfinance): {len(tickers)} tickers...")

    stock_tickers = [t for t in tickers if t not in KNOWN_ETFS]
    etf_count = len(tickers) - len(stock_tickers)
    if etf_count:
        print(f"   ETFs sin fundamentales: {etf_count}")

    cache = load_cache()
    if cache is not None:
        cached_tickers = cache.get("tickers", [])
        missing = [t for t in stock_tickers if t not in cached_tickers]
        if not missing and len(cached_tickers) >= len(stock_tickers) * 0.9:
            result = {}
            for name in ["earnings_surprise","revenue_growth","short_interest","price_target"]:
                df = cache[name].reindex(target_index, method="ffill").fillna(0.0)
                for t in tickers:
                    if t not in df.columns:
                        df[t] = 0.0
                result[name] = df[tickers]
            es_nz = (result["earnings_surprise"].iloc[-1] != 0).sum()
            rg_nz = (result["revenue_growth"].iloc[-1] != 0).sum()
            si_nz = (result["short_interest"].iloc[-1] != 0).sum()
            pt_nz = (result["price_target"].iloc[-1] != 0).sum()
            print(f"   Cache: ES={es_nz} RG={rg_nz} SI={si_nz} PT={pt_nz} tickers")
            return result
        print(f"   Cache parcial: {len(missing)} tickers nuevos")

    # Recolectar datos
    earnings_data = {}
    revenue_data = {}
    short_int_data = {}
    price_target_data = {}

    batch_size = 30
    start_time = time.time()

    for i, t in enumerate(stock_tickers):
        if (i + 1) % batch_size == 0:
            elapsed = time.time() - start_time
            rate = (i + 1) / elapsed if elapsed > 0 else 0
            print(f"   Fundamentales: {i+1}/{len(stock_tickers)} ({rate:.1f}/s)")
        time.sleep(0.05)

        try:
            yft = yf.Ticker(t)

            # 1. Earnings surprise (historical)
            try:
                eh = yft.get_earnings_history()
                if eh is not None and not eh.empty and "surprisePercent" in eh.columns:
                    sp = eh["surprisePercent"].dropna()
                    if not sp.empty and isinstance(sp.index, pd.DatetimeIndex):
                        sp = sp[sp.index <= pd.Timestamp.now()]
                        if not sp.empty:
                            earnings_data[t] = sp.astype(float)
            except Exception:
                pass

            # 2. Revenue growth YoY (historical)
            try:
                qf = yft.quarterly_financials
                if qf is not None and not qf.empty and "Total Revenue" in qf.index:
                    rev = qf.loc["Total Revenue"].dropna()
                    if len(rev) >= 4:
                        rev_pct = rev.pct_change(periods=4) * 100.0
                        rev_pct = rev_pct.dropna()
                        if not rev_pct.empty:
                            revenue_data[t] = rev_pct.astype(float)
            except Exception:
                pass

            # 3+4. Fetch info UNA sola vez y usar para short_interest y price_target
            info = None
            try:
                info = yft.info
            except Exception:
                pass

            if info:
                # 3. Short interest % of float (snapshot, fill backward)
                if info.get("shortPercentOfFloat") is not None:
                    si_val = float(info["shortPercentOfFloat"]) * 100
                    short_int_data[t] = pd.Series(si_val, index=target_index)

                # 4. Price target upside (snapshot, fill backward)
                tm = info.get("targetMeanPrice")
                cp = info.get("currentPrice") or info.get("previousClose")
                if tm and cp and cp > 0:
                    pt_val = float((tm / cp) - 1.0) * 100
                    price_target_data[t] = pd.Series(pt_val, index=target_index)

        except Exception:
            pass

    elapsed = time.time() - start_time
    print(f"   Fundamentales: ES={len(earnings_data)} RG={len(revenue_data)} SI={len(short_int_data)} PT={len(price_target_data)} ({elapsed:.0f}s)")

    # Construir DataFrames y hacer carry-forward
    es_df = pd.DataFrame(earnings_data).reindex(target_index, method="ffill").fillna(0.0)
    rg_df = pd.DataFrame(revenue_data).reindex(target_index, method="ffill").fillna(0.0)
    si_df = pd.DataFrame(short_int_data).reindex(target_index, fill_value=0.0)
    pt_df = pd.DataFrame(price_target_data).reindex(target_index, fill_value=0.0)

    for df in [es_df, rg_df, si_df, pt_df]:
        for t in tickers:
            if t not in df.columns:
                df[t] = 0.0

    result = {
        "earnings_surprise": es_df[tickers],
        "revenue_growth": rg_df[tickers],
        "short_interest": si_df[tickers],
        "price_target": pt_df[tickers],
    }

    save_cache(result["earnings_surprise"], result["revenue_growth"],
               result["short_interest"], result["price_target"], tickers)

    es_nz = (result["earnings_surprise"].iloc[-1] != 0).sum()
    rg_nz = (result["revenue_growth"].iloc[-1] != 0).sum()
    si_nz = (result["short_interest"].iloc[-1] != 0).sum()
    pt_nz = (result["price_target"].iloc[-1] != 0).sum()
    print(f"   ES={es_nz} RG={rg_nz} SI={si_nz} PT={pt_nz} tickers con datos")

    return result
