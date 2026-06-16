"""
FRED MACRO DATA — v2.0 (Hende Fund · Production)

Correcciones vs v1.0:
  [FIX-1] Normalización z-score GLOBAL eliminada (look-ahead bias).
          Los factores se devuelven en escala natural. La normalización
          expanding sin look-ahead se aplica en el modelo (OLYMPUS v6 FIX-J).

  [FIX-2] Documentación explícita de frecuencia por serie (mensual/diaria)
          para que el consumidor pueda tratar adecuadamente los datos.

  [FIX-3] lookback_days como parámetro (default 4 años) en vez de hardcoded 3 años.

  [FIX-4] Cache incluye obs_start; si cambia (por LOOKBACK distinto) se regenera.
"""
import os, pickle, time, logging
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import requests

logger = logging.getLogger(__name__)
CACHE_FILE    = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.fred_cache.pkl')
CACHE_MAX_AGE = 12 * 3600  # 12 horas — FRED no actualiza más frecuentemente

# Series con frecuencia documentada [FIX-2]
# El lag de publicación real puede ser de 1-30 días dependiendo de la serie.
MACRO_SERIES = {
    'UNRATE':   ('unemployment',          'monthly'),    # Publicación: ~1ª semana del mes
    'CPIAUCSL': ('cpi_raw',               'monthly'),    # Publicación: ~15 del mes
    'INDPRO':   ('indprod',               'monthly'),    # Publicación: ~15 del mes
    'BAA10YM':  ('credit_spread',         'daily'),      # Disponible diario
    'UMCSENT':  ('consumer_sentiment',    'monthly'),    # Publicación: ~2ª semana del mes
    'M2SL':     ('m2_raw',                'monthly'),    # Publicación: ~4ª semana
    'T10YIE':   ('breakeven_inflation',   'daily'),      # Disponible diario
    'FEDFUNDS': ('fed_rate',              'monthly'),    # Efectivo — se actualiza mensual tras reunión FOMC
}


def _fetch(series_id: str, api_key: str, obs_start: str):
    """Descarga una serie FRED. Devuelve pd.Series o None."""
    url = (
        'https://api.stlouisfed.org/fred/series/observations'
        '?series_id=' + series_id
        + '&api_key=' + api_key
        + '&file_type=json'
        + '&observation_start=' + obs_start
    )
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        obs = resp.json().get('observations', [])
        if not obs:
            return None
        dates, vals = [], []
        for o in obs:
            try:
                if o['value'] == '.':
                    continue
                dates.append(datetime.strptime(o['date'], '%Y-%m-%d'))
                vals.append(float(o['value']))
            except Exception:
                pass
        if not dates:
            return None
        return pd.Series(vals, index=pd.DatetimeIndex(dates)).sort_index()
    except Exception as e:
        logger.warning('FRED ' + series_id + ': ' + str(e))
        return None


def fetch_fred_factors(target_index, lookback_days: int = 4 * 365):
    """
    Devuelve DataFrame con factores macro FRED alineados a target_index.

    [FIX-1] Los factores se devuelven en escala natural (sin z-score).
            El modelo aplica expanding min/max normalization sin look-ahead (FIX-J).

    [FIX-3] lookback_days controla cuánta historia descargar (default 4 años).

    [FIX-4] Cache incluye obs_start para invalidación automática.
    """
    api_key = os.environ.get('FRED_API_KEY', '')
    if not api_key:
        print('   FRED: necesita FRED_API_KEY (https://fred.stlouisfed.org/docs/api/api_key.html)')
        return None

    obs_start = (datetime.now() - timedelta(days=lookback_days)).strftime('%Y-%m-%d')

    # [FIX-4] Validar cache: antigüedad Y obs_start
    cached = None
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE, 'rb') as f:
                    cached = pickle.load(f)
                if cached.get('obs_start') != obs_start:
                    logger.info('   FRED: cache obs_start difiere, regenerando...')
                    cached = None
            except Exception:
                cached = None

    if cached is not None:
        logger.info(f'   FRED cache ({len(cached["series"])} series, desde {cached["obs_start"]})')
        return cached['df'].reindex(target_index, method='ffill')

    # Descargar todas las series
    all_s: dict[str, pd.Series] = {}
    for sid, (name, freq) in MACRO_SERIES.items():
        s = _fetch(sid, api_key, obs_start)
        if s is not None:
            all_s[sid] = s
            logger.info(f'   FRED {sid} ({freq}): {len(s)} obs')

    if not all_s:
        return None

    macro_df = pd.DataFrame(all_s).resample('D').ffill().dropna(how='all')
    if macro_df.empty:
        return None

    # Derivar tasas de cambio (12 meses ≈ 252 días laborables)
    if 'CPIAUCSL' in macro_df.columns:
        macro_df['inflation_yoy'] = macro_df['CPIAUCSL'].pct_change(252) * 100
    if 'M2SL' in macro_df.columns:
        macro_df['money_supply_yoy'] = macro_df['M2SL'].pct_change(252) * 100

    # Renombrar columnas
    rename = {sid: name for sid, (name, _) in MACRO_SERIES.items()}
    cols_base  = [c for c in rename if c in macro_df.columns]
    cols_extra = [c for c in ['inflation_yoy', 'money_supply_yoy'] if c in macro_df.columns]

    factors = macro_df[cols_base + cols_extra].rename(columns=rename)

    # [FIX-1] NO normalizar aquí — escala natural
    # La normalización expanding sin look-ahead se aplica en v6.0 (FIX-J)

    aligned = factors.reindex(target_index, method='ffill')

    # Guardar cache con obs_start [FIX-4]
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump({
                'series':    list(factors.columns),
                'df':        factors,
                'obs_start': obs_start,
            }, f)
    except Exception as e:
        logger.warning(f'   FRED: no se pudo guardar cache: {e}')

    logger.info(f'   FRED: {len(factors.columns)} factores en escala natural (sin z-score)')
    return aligned
