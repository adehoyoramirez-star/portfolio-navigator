// supabase/functions/tactical-scan/index.ts
// Escáner táctico en la nube — port de la lógica de señales a Deno
// @ts-ignore
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FUNCTION_BASE = SUPABASE_URL.replace('supabase.co', 'supabase.co/functions/v1');

// ── Core tickers (OLYMPUS + sectoriales clave) ────────────────
const CORE_TICKERS = [
  // Olympus (6 activos core)
  'BTC-EUR', 'VVSM.DE', 'URNU.DE', 'EMXC.DE', 'PPFB.DE', '0P00000WLG.F',
  // Mega-caps US
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'V',
  // Sectoriales US
  'XLK', 'XLE', 'XLF', 'XLV', 'XLI', 'XLU', 'XLB', 'SOXX', 'IBB', 'KRE',
  // Europeos clave
  'SAP.DE', 'SIE.DE', 'ALV.DE', 'BAYN.DE', 'IFX.DE',
  'MC.PA', 'AIR.PA', 'SAN.PA', 'TTE.PA', 'SU.PA',
  'SAN.MC', 'BBVA.MC', 'IBE.MC', 'ITX.MC',
  'SHEL.L', 'AZN.L', 'HSBA.L',
  // Emergentes
  'INDA', 'EWZ', 'EWW', 'EEM',
  // Commodities
  'GDX.DE', 'SSLN.DE', '4GLD.DE', 'USO',
  // Temáticos
  'ARKY.DE', 'SMCI', 'PLTR', 'AMD', 'COIN', 'MSTR',
  // Macro
  '^VIX',
];

// ── Helpers estadísticos ──────────────────────────────────────
function sma(arr: number[], n: number): number {
  if (!arr || arr.length === 0) return 0;
  const slice = arr.slice(-n);
  if (slice.length < n) return arr[arr.length - 1] ?? 0;
  let sum = 0;
  for (let i = 0; i < slice.length; i++) {
    const v = slice[i];
    if (typeof v === 'number' && isFinite(v)) sum += v;
  }
  return sum / n;
}

function stdev(arr: number[]): number {
  if (!arr || arr.length < 2) return 0;
  const valid = arr.filter(v => typeof v === 'number' && isFinite(v));
  if (valid.length < 2) return 0;
  const m = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - m) ** 2, 0) / (valid.length - 1);
  return Math.sqrt(variance);
}

function calcRSI(closes: number[], period: number): number {
  if (!closes || closes.length < period + 1) return 50;
  const slice = closes.slice(-(period * 3));
  if (slice.length < period + 1) return 50;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (isFinite(diff)) rets.push(diff);
  }
  if (rets.length < period) return 50;

  let avgG = 0, avgL = 0;
  for (let i = 0; i < period; i++) {
    if (rets[i] > 0) avgG += rets[i];
    else avgL += Math.abs(rets[i]);
  }
  avgG /= period;
  avgL /= period;

  for (let i = period; i < rets.length; i++) {
    const g = rets[i] > 0 ? rets[i] : 0;
    const l = rets[i] < 0 ? Math.abs(rets[i]) : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }

  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(2));
}

// ── Señales simplificadas (core) ──────────────────────────────
interface ScanSignal {
  type: string;
  score: number;
  description: string;
}

function scanAsset(ticker: string, name: string, closes: number[], price: number): ScanSignal[] {
  const signals: ScanSignal[] = [];

  if (closes.length < 50) return signals;

  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const rsi2 = calcRSI(closes, 2);
  const rsi14 = calcRSI(closes, 14);
  const sd20 = stdev(closes.slice(-20));
  const zScore20 = sd20 > 0 ? (price - ma20) / sd20 : 0;

  const high52w = Math.max(...closes.slice(-252).filter(v => isFinite(v)));
  const dd52w = high52w > 0 ? (price / high52w) - 1 : 0;

  // Vol ratio
  let volRatio = 1;
  if (closes.length >= 42) {
    const vol20 = stdev(closes.slice(-20));
    const vol40 = stdev(closes.slice(-40, -20));
    volRatio = vol40 > 0 ? vol20 / vol40 : 1;
  }

  // ATR
  let atr14 = price * 0.02;
  if (closes.length >= 15) {
    let trSum = 0;
    for (let i = 1; i < Math.min(15, closes.length); i++) {
      const tr = Math.abs(closes[closes.length - i] - closes[closes.length - i - 1]);
      trSum += tr;
    }
    atr14 = Math.max(trSum / Math.min(15, closes.length), price * 0.005);
  }

  // ── 1. BLOOD_IN_STREETS ──────────────────────────────────────
  if (rsi2 < 10 && zScore20 < -1.5 && (price > ma200 || dd52w < -0.35)) {
    const score = Math.min(100, 45 + (10 - Math.min(10, rsi2)) * 4 + (Math.abs(zScore20) - 1.5) * 5 + (volRatio > 1.5 ? 8 : 0));
    signals.push({ type: 'BLOOD_IN_STREETS', score, description: `RSI(2)=${rsi2.toFixed(1)} Z=${zScore20.toFixed(2)} Pánico extremo` });
  }

  // ── 2. MEAN_REVERSION (simplificado: RSI(2) bajo + cerca MA20) ─
  if (rsi2 < 15 && price < ma20 * 0.98) {
    const score = Math.min(100, 40 + (15 - Math.min(15, rsi2)) * 2 + (zScore20 < -1.5 ? 8 : 0));
    signals.push({ type: 'MEAN_REVERSION', score, description: `RSI(2)=${rsi2.toFixed(1)} bajo MA20 - Vuelta a media` });
  }

  // ── 3. MOMENTUM_BREAKOUT (simplificado) ──────────────────────
  if (price > ma50 && rsi14 > 60 && volRatio > 1.3) {
    const score = Math.min(100, 45 + (rsi14 - 60) * 1.2 + (volRatio > 1.5 ? 20 : 0));
    signals.push({ type: 'MOMENTUM_BREAKOUT', score, description: `RSI(14)=${rsi14.toFixed(1)} Vol×${volRatio.toFixed(1)} - Breakout` });
  }

  // ── 4. OVERSOLD_BOUNCE ──────────────────────────────────────
  if (rsi14 < 35 && (price > ma200 || price > ma50 * 0.95)) {
    const score = Math.min(100, 42 + (35 - Math.min(35, rsi14)) * 1.8 + (price > ma200 ? 18 : 6));
    signals.push({ type: 'OVERSOLD_BOUNCE', score, description: `RSI(14)=${rsi14.toFixed(1)} sobre MA${price > ma200 ? '200' : '50'} - Rebote` });
  }

  // ── 5. SECTOR_ROTATION ──────────────────────────────────────
  if (dd52w < -0.20 && rsi14 > 40 && rsi14 < 55 && (price > ma200 || price > ma50)) {
    const score = Math.min(100, 40 + Math.min(25, (Math.abs(dd52w) - 0.20) * 100) + (price > ma200 ? 20 : 5) + 15);
    signals.push({ type: 'SECTOR_ROTATION', score, description: `DD52w=${(dd52w*100).toFixed(0)}% RSI=${rsi14.toFixed(1)} recuperando` });
  }

  return signals;
}

// ── Construir oportunidad ─────────────────────────────────────
function buildOpportunity(ticker: string, name: string, price: number, signals: ScanSignal[], closes: number[]): any {
  if (signals.length === 0) return null;
  
  const best = Math.max(...signals.map(s => s.score));
  const totalScore = Math.min(100, best + Math.min(20, (signals.length - 1) * 8));
  if (totalScore < 70) return null;

  const topSignal = signals.sort((a, b) => b.score - a.score)[0];
  const atr = price * 0.02;
  const stopLoss = price - atr * 1.5;
  const tp1 = price + (price - stopLoss) * 1.5;
  const tp2 = price + (price - stopLoss) * 2.5;
  const rr = (tp1 - price) / (price - stopLoss);

  // Tipo
  const typeMap: Record<string, string> = {
    BLOOD_IN_STREETS: '🩸 Blood Streets',
    MEAN_REVERSION: '↩️ Mean Revert',
    MOMENTUM_BREAKOUT: '🚀 Breakout',
    OVERSOLD_BOUNCE: '📈 Rebote',
    SECTOR_ROTATION: '🔄 Rotación',
  };

  // Precio ≈ EUR (simplificado: sin FX para scan rápido)
  return {
    ticker,
    name,
    type: topSignal.type,
    typeLabel: typeMap[topSignal.type] ?? topSignal.type,
    score: totalScore,
    price: parseFloat(price.toFixed(2)),
    entryPrice: parseFloat(price.toFixed(2)),
    stopLoss: parseFloat(stopLoss.toFixed(2)),
    takeProfit1: parseFloat(tp1.toFixed(2)),
    takeProfit2: parseFloat(tp2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    signals: signals.map(s => `${s.type} (${s.score.toFixed(0)})`).join(', '),
    atr_pct: `${(atr / price * 100).toFixed(1)}%`,
    reasoning: `${signals.length} señal(es): ${signals.map(s => s.description).join(' | ')}`,
    detectedAt: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ════════════════════════════════════════════════════════════
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    // 1. Fetch tickers from yahoo-finance (reutiliza la Edge Function existente)
    const yahooRes = await fetch(`${FUNCTION_BASE}/yahoo-finance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ tickers: CORE_TICKERS }),
    });

    if (!yahooRes.ok) {
      return new Response(JSON.stringify({
        ok: false, error: 'yahoo_finance_failed', opportunities: [], scannedAt: new Date().toISOString(),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const yahooData = await yahooRes.json();
    const chartData: Record<string, any> = yahooData.data ?? {};

    // 2. Compute signals for each asset
    const opportunities: any[] = [];
    const errors: string[] = [];

    for (const ticker of CORE_TICKERS) {
      const cleanTicker = ticker.replace('^', '');
      const chart = chartData[cleanTicker] ?? chartData[ticker];
      if (!chart || !chart.closes || chart.closes.length < 50) {
        if (ticker !== '^VIX') errors.push(ticker);
        continue;
      }

      const closes = chart.closes;
      const price = chart.currentPrice ?? closes[closes.length - 1] ?? 0;
      if (price <= 0) continue;

      const name = `[${cleanTicker}]`;
      const tickerSignals = scanAsset(cleanTicker, name, closes, price);
      const opp = buildOpportunity(cleanTicker, name, price, tickerSignals, closes);
      if (opp) {
        opportunities.push(opp);
      }
    }

    // 3. Sort by score descending
    opportunities.sort((a, b) => b.score - a.score);

    // 4. VIX info
    const vixChart = chartData['^VIX'];
    const vix = vixChart?.currentPrice ?? 20;

    return new Response(JSON.stringify({
      ok: true,
      scannedAt: new Date().toISOString(),
      tickersScanned: CORE_TICKERS.length,
      opportunitiesFound: opportunities.length,
      topOpportunities: opportunities.slice(0, 5),
      allOpportunities: opportunities,
      errors: errors.slice(0, 10),
      vix,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TacticalScan] ❌', msg);
    return new Response(JSON.stringify({
      ok: false, error: msg, opportunities: [],
      scannedAt: new Date().toISOString(),
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
