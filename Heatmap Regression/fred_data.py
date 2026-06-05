"""FRED MACRO DATA"""
import os, pickle, time, logging
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import requests
logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.fred_cache.pkl')
CACHE_MAX_AGE = 12 * 3600
MACRO_SERIES = {'UNRATE':'Desempleo','CPIAUCSL':'IPC','INDPRO':'IndProd','BAA10YM':'Credit Spread','UMCSENT':'Confianza','M2SL':'M2','T10YIE':'Breakeven','FEDFUNDS':'Fed Funds'}
def _fetch(series_id, api_key, obs_start):
    url = 'https://api.stlouisfed.org/fred/series/observations?series_id='+series_id+'&api_key='+api_key+'&file_type=json&observation_start='+obs_start
    try:
        resp = requests.get(url, timeout=15); resp.raise_for_status()
        obs = resp.json().get('observations', [])
        if not obs: return None
        dates, vals = [], []
        for o in obs:
            try:
                if o['value'] == '.': continue
                dates.append(datetime.strptime(o['date'], '%Y-%m-%d'))
                vals.append(float(o['value']))
            except: pass
        if not dates: return None
        return pd.Series(vals, index=pd.DatetimeIndex(dates)).sort_index()
    except Exception as e:
        logger.warning('FRED '+series_id+': '+str(e))
        return None
def fetch_fred_factors(target_index):
    api_key = os.environ.get('FRED_API_KEY', '')
    if not api_key:
        print('   FRED: necesita API key gratuita (https://fred.stlouisfed.org)')
        return None
    cached = None
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE, 'rb') as f: cached = pickle.load(f)
            except: pass
    if cached is not None:
        logger.info('   FRED cache ('+str(len(cached['series']))+' series)')
        return cached['df'].reindex(target_index, method='ffill')
    obs_start = (datetime.now() - timedelta(days=3*365)).strftime('%Y-%m-%d')
    all_s = {}
    for sid, sname in MACRO_SERIES.items():
        s = _fetch(sid, api_key, obs_start)
        if s is not None: all_s[sid] = s; logger.info('   FRED '+sid+': '+str(len(s))+' obs')
    if not all_s: return None
    macro_df = pd.DataFrame(all_s).resample('D').ffill().dropna(how='all')
    if macro_df.empty: return None
    if 'CPIAUCSL' in macro_df.columns: macro_df['inflation'] = macro_df['CPIAUCSL'].pct_change(12) * 100
    if 'M2SL' in macro_df.columns: macro_df['money_supply'] = macro_df['M2SL'].pct_change(12) * 100
    rename = {'UNRATE':'unemployment','INDPRO':'indprod','BAA10YM':'credit_spread','UMCSENT':'consumer_sentiment','T10YIE':'breakeven_inflation','FEDFUNDS':'fed_rate'}
    cols = [c for c in rename if c in macro_df.columns]
    extra = [c for c in ['inflation','money_supply'] if c in macro_df.columns]
    factors = macro_df[cols + extra].rename(columns=rename)
    for col in factors.columns:
        mu, sig = factors[col].mean(), factors[col].std()
        factors[col] = (factors[col] - mu) / sig if sig > 1e-10 else 0.0
    aligned = factors.reindex(target_index, method='ffill')
    try:
        with open(CACHE_FILE, 'wb') as f: pickle.dump({'series': list(factors.columns), 'df': factors}, f)
    except: pass
    logger.info('   FRED: '+str(len(factors.columns))+' factores listos')
    return aligned
