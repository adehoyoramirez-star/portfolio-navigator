"""
FINRA SHORT VOLUME — v3.0 (Hende Fund · Production)

v3.0 CHANGE: Migrated from FINRA OAuth API (401 Unauthorized) to FREE CDN flat files.
  Source: https://cdn.finra.org/equity/regsho/daily/CNMSshvol[YYYYMMDD].txt
  Format: pipe-delimited (Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market)
  Auth:   None required — public FINRA data files

  [FIX-1] BROADCAST DE UN SOLO DÍA A TODO EL HISTÓRICO ELIMINADO (CRÍTICO):
          Si la API devuelve < 21 días únicos, el factor se descarta (None).
          Es mejor no tener el factor que tenerlo con forward-looking bias severo.

  [FIX-2] FILLNA(0.5) solo aplica a tickers sin dato en un día específico,
          ya no se propaga a todo el histórico (corregido junto con FIX-1).

  [FIX-3] SCOPE CORREGIDO: CNMS (Consolidated NMS) como fuente primaria.
          Ya no usa OTC como fallback (los CDN tienen Consolidated completo).
"""
import os, pickle, time, logging
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import requests
from io import StringIO
from concurrent.futures import ThreadPoolExecutor, as_completed

logger = logging.getLogger(__name__)
CACHE_FILE    = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.finra_cache.pkl')
CACHE_MAX_AGE = 12 * 3600   # 12 horas — FINRA publica diario

# [FIX-3] CNMS (Consolidated NMS) desde CDN gratuito — sin auth
FINRA_CDN_TEMPLATE = "https://cdn.finra.org/equity/regsho/daily/CNMSshvol{date_str}.txt"

# [FIX-1] Mínimo de días únicos para considerar el factor válido
MIN_UNIQUE_DAYS = 21   # 1 mes de datos para tener varianza temporal mínima

# Número máximo de días a descargar para construir el histórico
# Con ~30 días ya se cumple MIN_UNIQUE_DAYS, pero pedimos 60 para tener margen
MAX_DAYS_TO_FETCH = 60

_HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept':          'text/plain, */*',
}


def _get_business_days(n_days: int, ref_date=None):
    """
    Genera lista de los últimos N días hábiles (lunes a viernes).
    """
    if ref_date is None:
        ref_date = datetime.now()
    # Necesitamos más días calendario para cubrir N días hábiles
    calendar_days_needed = int(n_days * 1.4) + 5
    biz_days = []
    d = ref_date
    while len(biz_days) < n_days:
        if d.weekday() < 5:  # Mon-Fri
            biz_days.append(d)
        d -= timedelta(days=1)
    return biz_days


def _fetch_single_day(date_str: str) -> pd.DataFrame | None:
    """
    Descarga el archivo CNMS para un día específico.
    Devuelve DataFrame con Date, Symbol, ratio (ShortVolume/TotalVolume).
    """
    url = FINRA_CDN_TEMPLATE.format(date_str=date_str)
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=15)
        if resp.status_code != 200:
            return None

        rows = []
        # Pipe-delimited, skip header
        for line in resp.text.strip().split('\n'):
            line = line.strip()
            if not line or line.startswith('Date|'):
                continue
            parts = line.split('|')
            if len(parts) < 5:
                continue
            try:
                symbol = parts[1].strip().upper().replace('.', '-')
                short_vol = float(parts[2]) if parts[2] else 0.0
                total_vol = float(parts[4]) if parts[4] else 0.0
                rows.append({
                    'date': date_str,
                    'ticker': symbol,
                    'short_vol': short_vol,
                    'total_vol': total_vol,
                })
            except (ValueError, IndexError):
                continue

        if not rows:
            return None

        df = pd.DataFrame(rows)
        # Aggregate by ticker (sum across Market entries)
        grouped = df.groupby(['date', 'ticker']).agg({
            'short_vol': 'sum',
            'total_vol': 'sum'
        }).reset_index()
        grouped['ratio'] = grouped['short_vol'] / grouped['total_vol'].replace(0, np.nan)
        grouped['ratio'] = grouped['ratio'].clip(0, 1)
        return grouped[['date', 'ticker', 'ratio']]

    except Exception as e:
        logger.warning(f'   FINRA CDN: {date_str} error: {e}')
        return None


def _build_historical_data(target_index, max_days=MAX_DAYS_TO_FETCH) -> pd.DataFrame | None:
    """
    Descarga múltiples días de datos FINRA y construye un DataFrame histórico.
    """
    ref_date = target_index[-1] if isinstance(target_index, pd.DatetimeIndex) else datetime.now()
    # Convert ref_date to datetime if it's a Timestamp
    if hasattr(ref_date, 'to_pydatetime'):
        ref_date = ref_date.to_pydatetime()
    elif hasattr(ref_date, 'date'):
        ref_date = datetime.combine(ref_date, datetime.min.time())
    if isinstance(ref_date, datetime):
        ref_dt = ref_date
    else:
        ref_dt = datetime.now()

    biz_days = _get_business_days(max_days, ref_date=ref_dt)

    all_data = []
    downloaded = 0
    total = len(biz_days)

    # Descargar en paralelo (hilos) para velocidad
    with ThreadPoolExecutor(max_workers=10) as executor:
        future_map = {}
        for bd in biz_days:
            date_str = bd.strftime('%Y%m%d')
            future = executor.submit(_fetch_single_day, date_str)
            future_map[future] = date_str

        for future in as_completed(future_map):
            date_str = future_map[future]
            try:
                day_data = future.result()
                if day_data is not None and not day_data.empty:
                    all_data.append(day_data)
                    downloaded += 1
            except Exception:
                pass

    if not all_data:
        logger.warning('   FINRA: no se pudo descargar ningún día de datos')
        return None

    combined = pd.concat(all_data, ignore_index=True)
    combined['date'] = pd.to_datetime(combined['date'], errors='coerce')

    logger.info(f'   FINRA CDN: {downloaded}/{total} días descargados, {len(combined)} filas')
    return combined


def _build_pivot_and_validate(data, tickers_list, target_index):
    """
    Construye pivot table y valida que haya suficientes días únicos.
    Returns None si datos insuficientes (< MIN_UNIQUE_DAYS).
    """
    pivot = data.pivot_table(
        index='date', columns='ticker', values='ratio', aggfunc='mean'
    )
    pivot = pivot.replace([np.inf, -np.inf], np.nan).dropna(how='all', axis=1)

    n_unique_days = len(pivot)
    if n_unique_days < MIN_UNIQUE_DAYS:
        logger.warning(f'FINRA: solo {n_unique_days} días únicos (mínimo {MIN_UNIQUE_DAYS}) — factor descartado')
        return None

    # Reindexar al target_index con ffill
    pivot = pivot.reindex(target_index, method='ffill')

    # Rellenar tickers sin dato con 0.5 (proxy neutral, solo en días específicos)
    pivot = pivot.fillna(0.5)

    return pivot


def fetch_finra_factors(tickers_list, target_index):
    """
    Obtiene short volume ratio (short_vol / total_vol) para cada ticker
    desde los archivos CDN gratuitos de FINRA.

    v3.0: Usa https://cdn.finra.org/equity/regsho/daily/CNMSshvol[YYYYMMDD].txt
          Sin autenticación necesaria.

    [FIX-1] Si hay < MIN_UNIQUE_DAYS días de datos, devuelve None.
    """
    # Check cache
    cached = None
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE, 'rb') as f:
                    cached = pickle.load(f)
            except Exception:
                pass

    if cached is not None:
        logger.info(f'   FINRA cache ({len(cached.get("tickers",[]))} tickers, {cached.get("n_days",0)} días)')
        common = [t for t in tickers_list if t in cached['df'].columns]
        if common:
            return cached['df'][common].reindex(target_index, method='ffill')

    # Descargar datos históricos desde CDN
    logger.info('   FINRA: descargando desde CDN gratuito...')
    data = _build_historical_data(target_index)

    if data is None or data.empty:
        logger.warning('   FINRA: sin datos descargados')
        return None

    # [FIX-1] Validar días únicos antes de construir
    pivot = _build_pivot_and_validate(data, tickers_list, target_index)
    if pivot is None:
        return None

    # Cache
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump({
                'tickers': list(pivot.columns),
                'df':      pivot,
                'n_days':  len(data['date'].unique()),
                'source':  'FINRA CDN v3.0',
            }, f)
    except Exception:
        pass

    # Solo devolver columnas que existen en pivot (evita KeyError)
    common = [t for t in tickers_list if t in pivot.columns]
    logger.info(f'   FINRA (CDN): {len(common)}/{len(tickers_list)} tickers, {len(data["date"].unique())} días únicos')
    return pivot[common]
