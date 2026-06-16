"""
INSIDER TRADING — v4.0 (Hende Fund · Production)
Usa yfinance Ticker.insider_transactions para datos de insider trading.
Gratuito, sin API key. Más fiable que OpenInsider scraping (bloqueado).

v3.1 → v4.0:
  [FIX-OI] OpenInsider.com bloquea scrapers activamente (Cloudflare anti-bot).
           Migrado a yfinance insider_transactions que es 100% fiable.
  [FIX-OI2] yfinance proporciona datos estructurados: Shares, Value, Transaction type,
            Insider name, Position, Start Date, Ownership.

Output: net_insider_ratio por ticker (-1.0 = solo ventas, +1.0 = solo compras)
"""

import os, pickle, time, logging
import pandas as pd
import numpy as np
import yfinance as yf

logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.insider_cache.pkl')
CACHE_MAX_AGE = 6 * 3600  # 6h

def _classify_transaction(text: str) -> str:
    """Classify a transaction as 'buy', 'sell', or 'neutral' using the Text field."""
    t = str(text).strip().lower()
    if not t or t == 'nan':
        return 'neutral'
    # Sales
    if 'sale' in t and 'purchase' not in t:
        return 'sell'
    # Purchases / acquisitions
    if any(kw in t for kw in ('purchase', 'buy', 'acquisition', 'exercise', 'award', 'grant')):
        return 'buy'
    # Gifts
    if 'gift' in t:
        return 'neutral'
    return 'neutral'


def _fetch_insider_for_ticker(ticker: str) -> dict | None:
    """
    Fetch insider transactions for a single ticker using yfinance.
    Returns dict with buy_value, sell_value, or None if no data.
    """
    try:
        stock = yf.Ticker(ticker)
        df = stock.insider_transactions

        if df is None or (hasattr(df, 'empty') and df.empty):
            return None

        # Handle both DataFrame and dict returns from yfinance
        if isinstance(df, dict):
            df = pd.DataFrame(df)

        if df.empty:
            return None

        # Check required columns
        if 'Text' not in df.columns:
            return None

        buy_value = 0.0
        sell_value = 0.0

        for _, row in df.iterrows():
            # Classify using the Text field (yfinance Transaction column is empty)
            classification = _classify_transaction(row.get('Text', ''))
            # Try to get value, fall back to shares if no value column
            val = 0.0
            if 'Value' in df.columns:
                try:
                    val = float(row['Value']) if pd.notna(row['Value']) else 0.0
                except (ValueError, TypeError):
                    val = 0.0
            if val <= 0 and 'Shares' in df.columns:
                try:
                    val = float(row['Shares']) if pd.notna(row['Shares']) else 0.0
                except (ValueError, TypeError):
                    val = 0.0

            if classification == 'buy':
                buy_value += abs(val)
            elif classification == 'sell':
                sell_value += abs(val)

        total = buy_value + sell_value
        if total <= 0:
            return None

        ratio = (buy_value - sell_value) / total
        return {'ticker': ticker, 'ratio': float(np.clip(ratio, -1.0, 1.0)),
                'buy_value': buy_value, 'sell_value': sell_value,
                'n_transactions': len(df)}

    except Exception as e:
        logger.debug(f'   INSIDER: yfinance error for {ticker}: {e}')
        return None


def fetch_insider_factors(tickers_list, target_index):
    """
    Obtiene net insider ratio por ticker via yfinance insider_transactions.

    v4.0: Usa yfinance (gratuito, fiable) en vez de OpenInsider (bloqueado).
    Interfaz: fetch_insider_factors(tickers_list, target_index) -> DataFrame | None
    """
    # Check cache
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE, 'rb') as f:
                    cached = pickle.load(f)
                source = cached.get('source', 'unknown')
                # [FIX-CACHE] Invalidar cache viejo del OpenInsider scraper
                if source != 'yfinance_insider_transactions':
                    logger.info('   INSIDER: cache obsoleto (OpenInsider), regenerando...')
                    os.remove(CACHE_FILE)
                else:
                    n_cached = len(cached.get('tickers', []))
                    logger.info(f'   INSIDER cache ({n_cached} tickers via {source})')
                    return cached['df'].reindex(target_index)
            except Exception:
                try:
                    os.remove(CACHE_FILE)
                except Exception:
                    pass

    logger.info('   INSIDER: fetching yfinance insider_transactions...')

    # Filter to stock tickers only (no ETFs, indexes)
    tickers_subset = [t for t in tickers_list
                      if not t.startswith('^') and not t.startswith('XL') and not t.startswith('EEM')
                      and t not in {'SPY', 'QQQ', 'IWM', 'DIA', 'MDY', 'GLD', 'SLV', 'USO', 'DBC',
                                    'TLT', 'AGG', 'LQD', 'HYG', 'IBIT', 'FBTC', 'BITO'}]

    # Limit to avoid rate limiting (yfinance is generous but let's be safe)
    tickers_to_fetch = tickers_subset[:100]

    ratios = {}
    successful = 0
    for i, t in enumerate(tickers_to_fetch):
        result = _fetch_insider_for_ticker(t)
        if result is not None:
            ratios[t] = result['ratio']
            successful += 1
        # Progress every 20 tickers
        if (i + 1) % 20 == 0:
            logger.info(f'   INSIDER: {i+1}/{len(tickers_to_fetch)} tickers, {successful} con datos')
        # [FIX-RATE] Small delay to avoid Yahoo rate-limiting
        time.sleep(0.15)

    if not ratios:
        logger.warning('INSIDER: sin tickers con datos de insider. Factor OMITIDO.')
        return None

    nonzero = sum(1 for v in ratios.values() if abs(v) > 0.01)
    total = len(ratios)
    signal_pct = nonzero / max(total, 1) * 100
    logger.info(f'INSIDER: {total} tickers, {nonzero} con senal != 0 ({signal_pct:.1f}%)')

    if signal_pct < 3.0:
        logger.warning('INSIDER: MENOS DEL 3% DE TICKERS CON SENAL. Factor OMITIDO.')
        try:
            os.remove(CACHE_FILE)
        except Exception:
            pass
        return None

    # Build DataFrame: broadcast snapshot to all dates in target_index
    df = pd.DataFrame(
        {t: [ratios.get(t, 0.0)] * len(target_index) for t in tickers_list},
        index=target_index
    )

    # Cache
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump({
                'tickers': list(df.columns),
                'df': df,
                'source': 'yfinance_insider_transactions',
                'n_with_data': len(ratios),
            }, f)
    except Exception:
        pass

    logger.info(f'   INSIDER: {len(ratios)} tickers con datos (yfinance, snapshot propagado)')
    return df
