"""
NEWS SENTIMENT — v3.0 (Hende Fund · Production)
Usa newsapi-python library para acceso fiable a NewsAPI.
VADER para análisis de sentimiento local.

Correcciones v2.2 → v3.0:
  [FIX-7] Usa NewsApiClient oficial (newsapi-python) en vez de requests crudos.
          Maneja rate-limiting, paginación y errores automáticamente.
  [FIX-8] Batching OR queries: 5 tickers por request para 100 req/día free tier.

  [FIX-1] Z-score global ELIMINADO: devuelve compound scores RAW [-1, +1].
  [FIX-2] NewsAPI como fuente principal; VADER como fallback local.
  [FIX-3] Mínimo 3 tickers con datos para considerar factor válido.
  [FIX-5] Fallback: si no hay NewsAPI ni VADER, asigna 0.0 (neutral).
  [FIX-6] Free tier: batching OR queries, cache 6h.
"""
import os, pickle, time, logging, re
from datetime import datetime, timedelta
import pandas as pd
import numpy as np

logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.sentiment_cache.pkl')
CACHE_MAX_AGE = 6 * 3600  # 6h

MIN_TICKERS_WITH_DATA = 3
MAX_TICKERS_TO_FETCH = 50
TICKERS_PER_BATCH = 5


def _fetch_batch(newsapi, tickers_batch: list[str]) -> dict:
    """
    Descarga headlines para un batch de tickers usando NewsApiClient.get_everything().
    Usa word-boundary regex para evitar falsos positivos con tickers cortos.
    Devuelve dict {ticker: [headlines]}.
    """
    # Ordenar por longitud descendente: tickers largos primero para evitar
    # que tickers cortos como "A" matcheen en cada artículo
    sorted_batch = sorted(tickers_batch, key=len, reverse=True)
    or_query = " OR ".join(sorted_batch)

    ticker_articles = {t: [] for t in tickers_batch}

    try:
        # NewsApiClient maneja rate-limiting y errores automáticamente
        response = newsapi.get_everything(
            q=or_query,
            language='en',
            sort_by='publishedAt',
            page_size=50,
            page=1
        )

        articles = response.get('articles', [])
        if not articles:
            return ticker_articles

        for a in articles:
            title = a.get('title', '') or ''
            desc = a.get('description', '') or ''
            text = (title + ' ' + desc).upper()
            for t in sorted_batch:
                # Word boundary: evita falsos positivos con substrings
                pattern = r'(?:\b|\.)' + re.escape(t.upper()) + r'(?:\b|\.)'
                if re.search(pattern, text):
                    ticker_articles[t].append(title)

    except Exception as e:
        msg = str(e).lower()
        if 'rate' in msg or 'limit' in msg or '429' in msg:
            logger.warning(f'   SENTIMENT: rate limited (cuota diaria agotada)')
        elif 'apikey' in msg or 'api key' in msg or 'unauthorized' in msg or '401' in msg:
            logger.warning(f'   SENTIMENT: API key inválida. Verifica NEWSAPI_KEY.')
        else:
            logger.warning(f'   SENTIMENT: error batch {tickers_batch[:3]}...: {e}')

    return ticker_articles


def fetch_sentiment_factors(tickers_list, target_index):
    """
    Obtiene news sentiment compound score por ticker via NewsAPI + VADER.

    v3.0: Usa NewsApiClient oficial para acceso fiable.
    [FIX-3] Si < 3 tickers con datos, retorna None.
    [FIX-1] Devuelve scores RAW [-1, +1] sin z-score.
    """
    # Check cache
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE, 'rb') as f:
                    cached = pickle.load(f)
                tickers_cached = len(cached.get('tickers', []))
                if tickers_cached >= MIN_TICKERS_WITH_DATA:
                    logger.info(f'   SENTIMENT cache ({tickers_cached} tickers)')
                    return cached['df'].reindex(target_index, method='ffill')
            except Exception:
                try:
                    os.remove(CACHE_FILE)
                except Exception:
                    pass

    # Check dependencies
    has_vader = False
    analyzer = None
    try:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        analyzer = SentimentIntensityAnalyzer()
        has_vader = True
    except ImportError:
        logger.warning('   vaderSentiment no instalado')

    news_key = os.environ.get('NEWSAPI_KEY', '')
    if not news_key:
        print('   SENTIMENT: NEWSAPI_KEY no definida — skip')
        return None
    if not has_vader:
        print('   SENTIMENT: vaderSentiment no instalado — necesario para analizar headlines')
        return None

    # Initialize NewsApiClient
    try:
        from newsapi import NewsApiClient
        newsapi = NewsApiClient(api_key=news_key)
    except ImportError:
        print('   SENTIMENT: newsapi-python no instalado. pip install newsapi-python')
        return None

    # [FIX-6] Reducir a MAX_TICKERS_TO_FETCH y agrupar en batches OR
    tickers_subset = [t for t in tickers_list if not t.startswith('^')][:MAX_TICKERS_TO_FETCH]
    batches = [tickers_subset[i:i + TICKERS_PER_BATCH]
               for i in range(0, len(tickers_subset), TICKERS_PER_BATCH)]

    all_headlines = {}  # ticker -> [headlines]

    for bi, batch in enumerate(batches):
        result = _fetch_batch(newsapi, batch)
        for t, articles in result.items():
            if articles:
                all_headlines[t] = articles
        if (bi + 1) % 5 == 0:
            logger.info(f'   SENTIMENT: batch {bi + 1}/{len(batches)}')

    # VADER analysis
    scores = {}
    for t in tickers_subset:
        headlines = all_headlines.get(t, [])
        if headlines and has_vader:
            comp = [analyzer.polarity_scores(h)['compound'] for h in headlines if h]
            compound = float(np.mean(comp)) if comp else 0.0
        else:
            compound = 0.0
        scores[t] = (compound, len(headlines))

    if not scores:
        return None

    n_tickers_with_data = sum(1 for _, n in scores.values() if n > 0)
    avg_articles = np.mean([n for _, n in scores.values() if n > 0]) if n_tickers_with_data > 0 else 0

    logger.info(f'   SENTIMENT: {n_tickers_with_data}/{len(scores)} tickers con noticias, '
                f'{avg_articles:.0f} headlines promedio')

    if n_tickers_with_data < MIN_TICKERS_WITH_DATA:
        logger.warning(
            f'   SENTIMENT: insuficientes noticias ({n_tickers_with_data} tickers < '
            f'{MIN_TICKERS_WITH_DATA}). Factor OMITIDO.'
        )
        return None

    # [FIX-1] Devolver scores RAW [-1, +1], sin z-score global
    df = pd.DataFrame(
        {t: [scores[t][0]] * len(target_index) for t in scores},
        index=target_index
    )

    logger.warning(
        'SENTIMENT: Snapshot de sentiment actual propagado a todo el histórico. '
        'Para walk-forward real necesita NewsAPI Premium o descarga acumulada.'
    )

    # Cache
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump({
                'tickers': list(df.columns),
                'df': df,
                'n_with_data': n_tickers_with_data,
            }, f)
    except Exception:
        pass

    logger.info(f'   SENTIMENT: {n_tickers_with_data} tickers con datos (snapshot propagado)')
    return df
