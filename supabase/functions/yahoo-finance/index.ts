// supabase/functions/yahoo/index.ts
// Función ligera — solo precios para el Screener

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

interface PriceResult {
  ticker: string;
  currentPrice: number;
  currency: string;
}

async function fetchPrice(ticker: string): Promise<PriceResult | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const json: any = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;
    const currentPrice: number = result.meta?.regularMarketPrice ?? 0;
    const currency: string = result.meta?.currency ?? 'USD';
    return { ticker: ticker.replace('%5E', '^'), currentPrice, currency };
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    let tickers: string[] = [];
    try {
      const body = await req.json() as { tickers?: string[] };
      if (body && Array.isArray(body.tickers)) {
        tickers = body.tickers.map(t => t.trim()).filter(t => t.length > 0);
      }
    } catch {
      // sin body
    }

    if (tickers.length === 0) {
      return new Response(JSON.stringify({ error: 'No tickers provided', data: {}, errors: [] }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[Yahoo] 🚀 Fetching prices for ${tickers.length} tickers`);

    let results = [] as PromiseSettledResult<PriceResult | null>[];

    try {
      results = await Promise.race([
        Promise.allSettled(tickers.map(t => fetchPrice(t))),
        new Promise<PromiseSettledResult<PriceResult | null>[]>(resolve => 
          setTimeout(() => resolve(tickers.map(() => ({ status: 'rejected' as const, reason: 'timeout' }))), 15000)
        ),
      ]);
    } catch {
      results = tickers.map(() => ({ status: 'rejected' as const, reason: 'error' }));
    }

    const data: Record<string, PriceResult> = {};
    const errors: string[] = [];

    results.forEach((result, idx) => {
      const cleanTicker = tickers[idx].replace('%5E', '^');
      if (result.status === 'fulfilled' && result.value) {
        data[cleanTicker] = result.value;
      } else {
        errors.push(cleanTicker);
      }
    });

    console.log(`[Yahoo] ✅ ${Object.keys(data).length} OK`);

    return new Response(
      JSON.stringify({ data, errors }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Yahoo] ❌', msg);
    return new Response(
      JSON.stringify({ error: msg, data: {}, errors: [] }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
