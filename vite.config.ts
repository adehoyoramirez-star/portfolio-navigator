import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// ── Yahoo Finance Proxy Middleware ───────────────────────────
// Reemplaza las Edge Functions yahoo-finance y yahoo-finance-tactical.
// Recibe POST { tickers: [...] }, fetchea cada uno de Yahoo, devuelve
// { data: Record<string, ChartResult>, errors: string[] }
function yahooFinancePlugin() {
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
      return {
        ticker: ticker.replace(/%5E/g, '^'),
        currentPrice,
        timestamps: timestamps.slice(0, minLen),
        closes, highs, lows,
        dataPoints: minLen,
      };
    } catch { return null; }
  }

  return {
    name: 'yahoo-finance-proxy',
    configureServer(server: any) {
      server.middlewares.use('/_proxy/yahoo-finance', async (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.writeHead(405); res.end('Method not allowed');
          return;
        }
        try {
          let body = '';
          req.on('data', (chunk: string) => body += chunk);
          await new Promise<void>(resolve => req.on('end', () => resolve()));

          let tickers: string[] = [];
          try { const parsed = JSON.parse(body); tickers = parsed.tickers || []; } catch {}

          const allTickers = [...new Set([...tickers, ...MACRO_TICKERS])];

          const results = await Promise.race([
            Promise.all(allTickers.map(t => fetchOne(t).catch(() => null))),
            new Promise<any[]>(r => setTimeout(() => r(allTickers.map(() => null)), 18000)),
          ]);

          const data: Record<string, any> = {};
          const errors: string[] = [];
          results.forEach((r, i) => {
            const name = allTickers[i].replace(/%5E/g, '^');
            if (r) data[name] = r;
            else errors.push(name);
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data, errors }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: {}, errors: [err?.message ?? 'unknown'] }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), yahooFinancePlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});