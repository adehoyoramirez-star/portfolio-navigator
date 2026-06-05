"""SEC EDGAR INSIDER TRADING - Form 4 filings via official API"""
import os, pickle, time, logging, json
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import requests
logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.insider_cache.pkl')
CACHE_MAX_AGE = 6 * 3600

def _get_cik_map():
    """Download CIK-to-ticker mapping from SEC."""
    try:
        url = 'https://www.sec.gov/files/company_tickers.json'
        resp = requests.get(url, timeout=30,
            headers={'User-Agent': 'Olympus/5.0 (research@olympus.com)'})
        if resp.status_code != 200: return {}
        data = resp.json()
        cik_map = {}
        for item in data.values():
            ticker = item.get('ticker', '').upper().replace('.', '-')
            cik = str(item.get('cik_str', '')).zfill(10)
            if ticker and cik:
                cik_map[ticker] = cik
        return cik_map
    except Exception as e:
        logger.warning(f'CIK map download failed: {e}')
        return {}

def _get_insider_ratio(cik, headers):
    """Get net insider ratio for a CIK from SEC official API."""
    try:
        url = f'https://data.sec.gov/submissions/CIK{cik}.json'
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code != 200: return None
        data = resp.json()
        filings = data.get('filings', {}).get('recent', {})
        forms = filings.get('form', [])
        if not forms: return None
        buynet = 0
        count = 0
        for i, form in enumerate(forms):
            if form == '4':
                count += 1
                # Parse transaction type from primaryDocument or description
                desc = str(filings.get('primaryDocument', [''] * len(forms))[i] if i < len(filings.get('primaryDocument', [])) else '')
                if not desc and i < len(filings.get('primaryDocDescription', [])):
                    desc = str(filings.get('primaryDocDescription', [])[i])
                desc_lower = desc.lower()
                if 'sale' in desc_lower:
                    buynet -= 1
                else:
                    buynet += 1  # default to purchase
                if count >= 20:  # limit per ticker
                    break
        return buynet / max(count, 1) if count > 0 else None
    except Exception as e:
        logger.debug(f'CIK {cik}: {e}')
        return None

def fetch_insider_factors(tickers_list, target_index):
    cached = None
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE, 'rb') as f: cached = pickle.load(f)
            except: pass
    if cached is not None:
        logger.info('   INSIDER cache ('+str(len(cached.get('tickers',[])))+' tickers)')
        return cached['df'].reindex(target_index, method='ffill')
    headers = {'User-Agent': 'Olympus/5.0 (research@olympus.com)'}
    logger.info('   INSIDER: descargando CIK mapping...')
    cik_map = _get_cik_map()
    if not cik_map:
        logger.warning('INSIDER: no CIK map disponible')
        return None
    # Filter to tickers we can map
    tickers_subset = [t for t in tickers_list if not t.startswith('^') and t in cik_map][:100]
    if not tickers_subset:
        logger.warning('INSIDER: no tickers mapeables')
        return None
    logger.info(f'   INSIDER: {len(tickers_subset)} tickers con CIK')
    all_signals = {}
    for i, ticker in enumerate(tickers_subset):
        ratio = _get_insider_ratio(cik_map[ticker], headers)
        if ratio is not None:
            all_signals[ticker] = ratio
        time.sleep(0.11)  # ~9 req/s — stay under 10 req/s limit
        if (i+1) % 50 == 0:
            logger.info(f'   INSIDER: {i+1}/{len(tickers_subset)} ({len(all_signals)} OK)')
    if not all_signals:
        logger.warning('INSIDER: sin datos')
        return None
    vals = np.array(list(all_signals.values()))
    mu, sig = np.nanmean(vals), np.nanstd(vals)
    df = pd.DataFrame({t:[(all_signals[t]-mu)/sig if sig>1e-10 else 0.0]*len(target_index) for t in all_signals}, index=target_index)
    try:
        with open(CACHE_FILE, 'wb') as f: pickle.dump({'tickers': list(df.columns), 'df': df}, f)
    except: pass
    logger.info(f'   INSIDER: {len(all_signals)} tickers')
    return df
