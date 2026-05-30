// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FUNCTION_BASE = SUPABASE_URL.replace('supabase.co', 'supabase.co/functions/v1');

async function callFunction(name: string, body?: unknown): Promise<any> {
  try {
    const res = await fetch(`${FUNCTION_BASE}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function loadState(): Promise<any> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pilot_state?select=*&limit=1`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0] ?? null;
  } catch { return null; }
}

async function saveState(state: any): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/pilot_state`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: 1, ...state }),
    });
  } catch {}
}

function detectRegime(vix: number, creditSpread: number, fearGreed: number): string {
  if (vix > 35 || creditSpread > 6) return 'CRISIS';
  if (vix > 28 || creditSpread > 4.5 || fearGreed < 20) return 'CONTRACTION';
  return 'EXPANSION';
}

// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const [yahooRaw, cryptoRaw, tacticalScan] = await Promise.all([
    callFunction('yahoo-finance'),
    callFunction('crypto-signals'),
    callFunction('tactical-scan'),
  ]);

  if (!yahooRaw) {
    return new Response(JSON.stringify({ ok: false, error: 'yahoo_failed' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const vix          = yahooRaw.data?.['^VIX']?.currentPrice ?? 20;
  const btcCloses    = yahooRaw.data?.['BTC-EUR']?.closes ?? [];
  const creditSpread = yahooRaw.creditSpread?.spread ?? 3.0;
  const fearGreed    = cryptoRaw?.fearGreedValue ?? 50;
  const fearGreedLabel = cryptoRaw?.fearGreedLabel ?? 'Neutral';
  const btcDominance = cryptoRaw?.btcDominance ?? 54;
  const m2Growth     = yahooRaw.m2?.growthYoY ?? 4.3;

  let btcRsi = 50;
  const btcLast = btcCloses.slice(-30);
  if (btcLast.length >= 15) {
    let gains = 0, losses = 0;
    for (let i = 1; i < btcLast.length; i++) {
      const d = btcLast[i] - btcLast[i-1];
      if (d > 0) gains += d; else losses += Math.abs(d);
    }
    const avgG = gains / (btcLast.length - 1);
    const avgL = losses / (btcLast.length - 1);
    btcRsi = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
  }

  const currentRegime = detectRegime(vix, creditSpread, fearGreed);
  const prev = await loadState();
  const alerts: string[] = [];

  if (prev) {
    if (prev.regime !== currentRegime) {
      alerts.push('regime_change');
      await callFunction('telegram-alerts', {
        type: 'regime_change',
        previousRegime: prev.regime, newRegime: currentRegime,
        regimePenalty: currentRegime === 'CRISIS' ? 0.55 : currentRegime === 'CONTRACTION' ? 0.75 : 1.0,
        confidence: 'MEDIUM',
        dominantSignal: `VIX ${vix.toFixed(1)} · Spread ${creditSpread.toFixed(2)}%`,
        vix, fearGreed, fearGreedLabel,
      });
    }
    if (prev.vix < 30 && vix >= 30) {
      alerts.push('vix_spike');
      await callFunction('telegram-alerts', {
        type: 'cews_alert', cewsLevel: 'WATCH', cewsScore: 0.65,
        cewsDetails: `VIX cruzó 30 — subió de ${prev.vix.toFixed(1)} a ${vix.toFixed(1)}`,
        fearGreed, fearGreedLabel,
      });
    }
    if (vix > 40 && prev.vix <= 40) {
      alerts.push('black_swan');
      await callFunction('telegram-alerts', {
        type: 'black_swan',
        blackSwanReason: `VIX > 40 (${vix.toFixed(1)}) — volatilidad extrema sistémica`,
        currentRegime, vix, fearGreed, fearGreedLabel,
      });
    }
    if (fearGreed < 15 && prev.fearGreed >= 15 && currentRegime !== 'CRISIS') {
      alerts.push('dca_signal');
      await callFunction('telegram-alerts', {
        type: 'dca_signal', dcaScore: 0.85, dcaRecommendedAmount: 400,
        dcaReason: `Fear & Greed en ${fearGreed} — miedo extremo histórico`,
        fearGreed, fearGreedLabel,
      });
    }
    if (btcRsi < 25 && prev.btc_rsi >= 25) {
      alerts.push('btc_oversold');
      await callFunction('telegram-alerts', {
        type: 'dca_signal', dcaScore: 0.90, dcaRecommendedAmount: 400,
        dcaReason: `BTC RSI en ${btcRsi.toFixed(0)} — sobreventa extrema`,
        fearGreed, fearGreedLabel,
      });
    }
    if (prev.credit_spread < 5 && creditSpread >= 5) {
      alerts.push('credit_stress');
      await callFunction('telegram-alerts', {
        type: 'cews_alert', cewsLevel: 'WARNING', cewsScore: 0.80,
        cewsDetails: `Credit spread cruzó 5% — ${creditSpread.toFixed(2)}%`,
      });
    }
  }

  // ── TACTICAL SCAN → Alertas Telegram ────────────────────────────
  const tacticalOpportunities = tacticalScan?.topOpportunities ?? [];
  if (tacticalOpportunities.length > 0) {
    for (const opp of tacticalOpportunities.slice(0, 3)) {
      // Rate limit: solo las mejores 3, y solo si no se ha alertado antes
      const prevOpps = prev?.last_tactical_tickers ?? [];
      if (!prevOpps.includes(opp.ticker)) {
        alerts.push(`tactical_${opp.ticker}`);
        await callFunction('telegram-alerts', {
          type: 'tactical_opportunity',
          tacticalTicker: opp.ticker,
          tacticalName: opp.name,
          tacticalType: opp.type,  // raw enum type para emoji mapping en telegram
          tacticalScore: opp.score,
          tacticalEntry: opp.entryPrice,
          tacticalStop: opp.stopLoss,
          tacticalTP1: opp.takeProfit1,
          tacticalTP2: opp.takeProfit2,
          tacticalRR: opp.riskReward,
          tacticalSignals: opp.signals,
          tacticalATR: opp.atr_pct,
          tacticalReasoning: opp.reasoning,
          tacticalScanMode: 'auto',
        });
      }
    }
  }

  const lastTacticalTickers = tacticalOpportunities.slice(0, 10).map(o => o.ticker);

  const newState = {
    regime: currentRegime, vix, btc_rsi: btcRsi,
    credit_spread: creditSpread, fear_greed: fearGreed,
    btc_dominance: btcDominance,
    last_tactical_tickers: lastTacticalTickers,
    updated_at: new Date().toISOString(),
  };
  await saveState(newState);

  return new Response(JSON.stringify({
    ok: true, timestamp: new Date().toISOString(),
    currentState: newState, previousRegime: prev?.regime ?? 'none',
    alertsFired: alerts,
    tacticalOpportunities: tacticalOpportunities.length,
    dataQuality: { yahoo: 'OK', crypto: cryptoRaw ? 'OK' : 'failed', tactical: tacticalScan ? 'OK' : 'failed', m2Growth },
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});