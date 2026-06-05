"""NEWS SENTIMENT - VADER + NewsAPI"""
import os, pickle, time, logging
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
logger = logging.getLogger(__name__)
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.sentiment_cache.pkl')
CACHE_MAX_AGE = 4 * 3600
def fetch_sentiment_factors(tickers_list, target_index):
    cached = None
    if os.path.exists(CACHE_FILE):
        age = time.time() - os.path.getmtime(CACHE_FILE)
        if age < CACHE_MAX_AGE:
            try:
                with open(CACHE_FILE, 'rb') as f: cached = pickle.load(f)
            except: pass
    if cached is not None:
        logger.info('   SENTIMENT cache ('+str(len(cached.get('tickers',[])))+' tickers)')
        return cached['df'].reindex(target_index, method='ffill')
    has_vader = False
    try:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        analyzer = SentimentIntensityAnalyzer()
        has_vader = True
    except ImportError:
        logger.warning('vaderSentiment no instalado')
    news_key = os.environ.get('NEWSAPI_KEY', '')
    has_news = bool(news_key)
    if not has_news: print('   SENTIMENT: NEWSAPI_KEY no definida, usando VADER basico')
    if not has_vader and not has_news: logger.warning('SENTIMENT: no disponible'); return None
    import requests
    tickers_subset = [t for t in tickers_list if not t.startswith('^')][:100]
    scores = {}
    for i, ticker in enumerate(tickers_subset):
        compound = 0.0
        headlines = []
        if has_news:
            try:
                url = 'https://newsapi.org/v2/everything?q='+ticker+'&language=en&sortBy=publishedAt&pageSize=5&apiKey='+news_key
                resp = requests.get(url, timeout=10)
                if resp.status_code == 200:
                    articles = resp.json().get('articles', [])
                    headlines = [a.get('title','') for a in articles if a.get('title')]
            except: pass
        if has_vader:
            if headlines:
                comp = [analyzer.polarity_scores(h)['compound'] for h in headlines if h]
                compound = float(np.mean(comp)) if comp else 0.0
            else:
                compound = analyzer.polarity_scores(ticker)['compound'] * 0.3
        scores[ticker] = compound
        if (i+1) % 25 == 0: logger.info('   SENTIMENT: '+str(i+1)+'/'+str(len(tickers_subset)))
    if not scores: return None
    vals = np.array(list(scores.values()))
    mu, sig = np.nanmean(vals), np.nanstd(vals)
    df = pd.DataFrame({t:[(scores[t]-mu)/sig if sig>1e-10 else 0.0]*len(target_index) for t in scores}, index=target_index)
    try:
        with open(CACHE_FILE, 'wb') as f: pickle.dump({'tickers': list(df.columns), 'df': df}, f)
    except: pass
    logger.info('   SENTIMENT: '+str(len(scores))+' tickers')
    return df
