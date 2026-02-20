const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const TICKERS = [
  'BTC-EUR', 'EMXC.DE', 'IS3Q.DE', 'PPFB.DE', 'URNU.DE', 'VVSM.DE', 'ZPRR.DE',
  '%5EVIX', '%5ETNX', '%5EIRX',
];

interface ChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
}

async function fetchTicker(ticker: string): Promise<ChartResult | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      console.error(`Failed to fetch ${ticker}: ${res.status}`);
      return null;
    }
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp || [];
    const closes: number[] = result.indicators?.quote?.[0]?.close || [];
    const currentPrice = result.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? 0;

    // Clean ticker name back
    const cleanTicker = ticker.replace('%5E', '^');

    return { ticker: cleanTicker, currentPrice, timestamps, closes };
  } catch (e) {
    console.error(`Error fetching ${ticker}:`, e);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const results = await Promise.allSettled(TICKERS.map(fetchTicker));

    const data: Record<string, ChartResult> = {};
    const errors: string[] = [];

    results.forEach((r, i) => {
      const cleanTicker = TICKERS[i].replace('%5E', '^');
      if (r.status === 'fulfilled' && r.value) {
        data[cleanTicker] = r.value;
      } else {
        errors.push(cleanTicker);
      }
    });

    return new Response(JSON.stringify({ data, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
