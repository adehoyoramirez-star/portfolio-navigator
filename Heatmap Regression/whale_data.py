"""
WHALE TRACKING — v1.1 (Hende Fund · Production)
Scrapea Finviz.com para propiedad institucional, insider buying, short float.
"""
import os, pickle, time, logging
from io import StringIO
import pandas as pd
import numpy as np
import requests

logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.whale_cache.pkl')
CACHE_MAX_AGE = 12 * 3600

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finviz.com/',
}

def _fetch_finviz_ticker(session, ticker):
    url = f'https://finviz.com/quote.ashx?t={ticker}'
    try:
        resp = session.get(url, headers=HEADERS, timeout=15)
        if resp.status_code != 200: return None
        tables = pd.read_html(StringIO(resp.text))
        if not tables: return None
        data = {}
        for table in tables:
            flat = table.values.flatten()
            for i in range(0, len(flat)-1, 2):
                key = str(flat[i]).strip().lower()
                val = str(flat[i+1]).strip()
                data[key] = val
        r = {'inst_own_pct': 0.0, 'insider_pct': 0.0, 'short_float_pct': 0.0}
        for k in ['inst. own', 'inst own']:
            if k in data: r['inst_own_pct'] = float(data[k].replace('%',''))
        if 'insider trans' in data: r['insider_pct'] = float(data['insider trans'].replace('%',''))
        for k in ['short float', 'short ratio']:
            if k in data: r['short_float_pct'] = float(data[k].replace('%',''))
        return r if r['inst_own_pct'] > 0 else None
    except: return None

def fetch_whale_factors(tickers_list, target_index):
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE,'rb') as f: cached = pickle.load(f)
                logger.info(f'   WHALE cache ({len(cached.get("tickers",[]))} tickers)')
                return cached['dfs']
            except: pass
    logger.info('   WHALE: scraping Finviz.com (gratuito)...')
    session = requests.Session()
    tickers_subset = [t for t in tickers_list if not t.startswith('^')][:40]
    inst_data, insider_t, short_d = {}, {}, {}
    for i, ticker in enumerate(tickers_subset):
        r = _fetch_finviz_ticker(session, ticker)
        if r:
            inst_data[ticker] = r['inst_own_pct']
            insider_t[ticker] = r['insider_pct']
            short_d[ticker] = r['short_float_pct']
        time.sleep(1.5)
        if (i+1) % 10 == 0: logger.info(f'   WHALE: {i+1}/{len(tickers_subset)}')
    logger.info(f'WHALE: {len(inst_data)} tickers')
    if len(inst_data) < 5: return None
    n = len(target_index)
    dfs = {
        'inst_ownership': pd.DataFrame({t: [inst_data.get(t,50.0)]*n for t in tickers_list}, index=target_index),
        'finviz_insider': pd.DataFrame({t: [insider_t.get(t,0.0)]*n for t in tickers_list}, index=target_index),
        'finviz_shortfloat': pd.DataFrame({t: [short_d.get(t,5.0)]*n for t in tickers_list}, index=target_index),
    }
    try:
        with open(CACHE_FILE,'wb') as f: pickle.dump({'tickers':list(inst_data.keys()), 'dfs':dfs, 'source':'finviz'}, f)
    except: pass
    return dfs
