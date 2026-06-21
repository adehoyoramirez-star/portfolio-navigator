// api/proxy/yahoo-finance.ts
// Vercel Serverless Function — Proxy de Yahoo Finance para producción
// Replica el middleware de vite.config.ts (que solo funciona en dev).
// Desplegado automáticamente por Vercel en /api/proxy/yahoo-finance
// y mapeado desde /_proxy/yahoo-finance vía vercel.json rewrites.

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const MACRO_TICKERS = ['%5EVIX', '%5ETNX', '%5EIRX', '%5EMOVE', 'HYG', 'LQD', '%5EGSPC', 'DX-Y.NYB', 'BZ=F'];

async function fetchOne(ticker: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = `${YAHOO_BASE}/${ticker}?range=6y&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const json: any = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;
    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const rawCloses: (number | null)[] = quote.close || [];
    const rawHighs: (number | null)[] = quote.high || [];
    const rawLows: (number | null)[] = quote.low || [];
    const rawVolumes: (number | null)[] = quote.volume || [];
    const minLen = Math.min(timestamps.length, rawCloses.length, rawHighs.length, rawLows.length);
    if (minLen < 60) return null;
    const closes = rawCloses.slice(0, minLen).map((v: any, i: number) => {
      if (v != null && isFinite(v) && v > 0) return v;
      const prev = rawCloses.slice(0, i).reverse().find((x: any) => x != null && isFinite(x) && x > 0) ?? 0;
      return prev;
    });
    const highs = rawHighs.slice(0, minLen).map((v: any, i: number) => {
      if (v != null && isFinite(v) && v > 0) return v;
      return closes[i];
    });
    const lows = rawLows.slice(0, minLen).map((v: any, i: number) => {
      if (v != null && isFinite(v) && v > 0) return v;
      return closes[i];
    });
    const currentPrice = result.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? 0;
    if (currentPrice <= 0) return null;
    const volumes = rawVolumes.slice(0, minLen).map((v: any) => (v != null && isFinite(v) && v >= 0) ? v : 0);
    while (volumes.length < minLen) volumes.push(0);
    return {
      ticker: ticker.replace(/%5E/g, '^'),
      currentPrice,
      timestamps: timestamps.slice(0, minLen),
      closes, highs, lows, volumes,
      dataPoints: minLen,
    };
  } catch { return null; }
}

function setCorsHeaders(res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Vercel Node.js serverless function handler
export default async function handler(req: any, res: any) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).end('Method not allowed');
    return;
  }

  try {
    // Read body — Vercel sometimes auto-parses, sometimes leaves as stream
    let body: any = req.body;
    if (typeof body === 'string') {
      // Vercel pre-read the body but didn't parse → parse directly
      try { body = JSON.parse(body); } catch { body = {}; }
    } else if (!body) {
      // Body not read at all → read from stream
      const rawBody = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (chunk: string) => data += chunk);
        req.on('end', () => resolve(data));
      });
      try { body = JSON.parse(rawBody || '{}'); } catch { body = {}; }
    }

    const tickers: string[] = Array.isArray(body?.tickers) ? body.tickers : [];
    const allTickers = [...new Set([...tickers, ...MACRO_TICKERS])];

    // Promise.race con timeout de 9.5s (Vercel Hobby mata a 10s, Pro a 60s)
    const results = await Promise.race([
      Promise.all(allTickers.map(t => fetchOne(t).catch(() => null))),
      new Promise<any[]>(r => setTimeout(() => r(allTickers.map(() => null)), 9500)),
    ]);

    const data: Record<string, any> = {};
    const errors: string[] = [];
    results.forEach((r, i) => {
      const name = allTickers[i].replace(/%5E/g, '^');
      if (r) data[name] = r;
      else errors.push(name);
    });

    setCorsHeaders(res);
    res.status(200).json({ data, errors });
  } catch (err: any) {
    setCorsHeaders(res);
    res.status(500).json({ data: {}, errors: [err?.message ?? 'unknown'] });
  }
}
