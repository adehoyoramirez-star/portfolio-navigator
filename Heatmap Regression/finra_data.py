"""FINRA SHORT VOLUME — via official API"""
import os, pickle, time, logging
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import requests
from io import StringIO

logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.finra_cache.pkl')
CACHE_MAX_AGE = 12 * 3600  # 12 hours — FINRA publishes daily

FINRA_API_URL = "https://api.finra.org/data/group/OTCMarket/name/regshoDaily"

def _fetch_from_api():
    """Fetch short volume data from FINRA API.
    Returns DataFrame with columns: tradeReportDate, ticker, shortParQuantity, totalParQuantity
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/csv, application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://api.finra.org/',
        'Origin': 'https://api.finra.org',
    }
    try:
        resp = requests.get(FINRA_API_URL, headers=headers, timeout=30)
        if resp.status_code != 200:
            logger.warning(f'FINRA API: HTTP {resp.status_code}')
            return None

        df = pd.read_csv(StringIO(resp.text))

        # Map column names
        col_ticker = 'securitiesInformationProcessorSymbolIdentifier'
        col_short = 'shortParQuantity'
        col_total = 'totalParQuantity'
        col_date = 'tradeReportDate'

        required = [col_ticker, col_short, col_total, col_date]
        if not all(c in df.columns for c in required):
            logger.warning(f'FINRA API: columnas inesperadas: {list(df.columns)}')
            return None

        # Clean and aggregate
        df['ticker'] = df[col_ticker].astype(str).str.strip().str.upper().str.replace('.', '-', regex=False)
        df['date'] = pd.to_datetime(df[col_date], errors='coerce')
        df['short_vol'] = pd.to_numeric(df[col_short], errors='coerce').fillna(0)
        df['total_vol'] = pd.to_numeric(df[col_total], errors='coerce').fillna(0)

        # Aggregate by date + ticker (sum across reporting facilities)
        grouped = df.groupby(['date', 'ticker']).agg({
            'short_vol': 'sum',
            'total_vol': 'sum'
        }).reset_index()

        # Compute ratio
        grouped['ratio'] = grouped['short_vol'] / grouped['total_vol'].replace(0, np.nan)
        grouped['ratio'] = grouped['ratio'].clip(0, 1)  # ratio must be between 0 and 1

        return grouped[['date', 'ticker', 'ratio']]

    except Exception as e:
        logger.warning(f'FINRA API error: {e}')
        return None


def fetch_finra_factors(tickers_list, target_index):
    """Fetch FINRA short volume ratio per ticker.

    Returns DataFrame indexed by target_index with ticker columns containing
    short_volume_ratio (short_vol / total_vol), or None if unavailable.
    """
    # Check cache
    cached = None
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE, 'rb') as f:
                    cached = pickle.load(f)
            except:
                pass

    if cached is not None:
        logger.info(f'   FINRA cache ({len(cached.get("tickers",[]))} tickers)')
        common = [t for t in tickers_list if t in cached['df'].columns]
        if common:
            return cached['df'][common].reindex(target_index, method='ffill')

    # Fetch from API
    logger.info('   FINRA: descargando short volume via API...')
    data = _fetch_from_api()
    if data is None or data.empty:
        logger.warning('FINRA: sin datos de API')
        return None

    # Get most recent date
    latest_date = data['date'].max()
    latest = data[data['date'] == latest_date]
    logger.info(f'   FINRA: {len(latest)} tickers, fecha={latest_date.date()}')

    # Build pivot: one row per date, columns = tickers
    pivot = data.pivot_table(
        index='date', columns='ticker', values='ratio', aggfunc='mean'
    )
    pivot = pivot.replace([np.inf, -np.inf], np.nan).dropna(how='all', axis=1)

    # If only 1 row, duplicate it to cover target_index
    if len(pivot) == 1:
        # Broadcast single day's data across all dates in target_index
        single_row = pivot.iloc[0]
        pivot = pd.DataFrame(
            np.tile(single_row.values, (len(target_index), 1)),
            index=target_index,
            columns=single_row.index
        )
    else:
        pivot = pivot.reindex(target_index, method='ffill')

    # Fill any missing values with 0.5 (neutral ratio)
    pivot = pivot.fillna(0.5)

    # Cache
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump({'tickers': list(pivot.columns), 'df': pivot}, f)
    except:
        pass

    n = len([t for t in tickers_list if t in pivot.columns])
    logger.info(f'   FINRA: {n} tickers con short volume ratio')
    return pivot
