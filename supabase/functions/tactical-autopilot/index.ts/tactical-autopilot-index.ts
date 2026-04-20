// supabase/functions/tactical-autopilot/index.ts
// Cron autónomo del motor táctico — corre cada día a las 08:00 UTC
// Escanea mercado, detecta oportunidades, envía alertas a Telegram
// SIN necesidad de que el navegador esté abierto
//
// Configurar en Supabase > Edge Functions > Schedule:
//   Cron: "0 8 * * 1-5"  (lunes-viernes a las 8:00 UTC)
//
// Variables de entorno necesarias (Supabase Secrets):
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

// @ts-ignore
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
// @ts-ignore
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Tickers a escanear cada día ───────────────────────────────
const DAILY_SCAN = [
  'BTC-EUR', 'IS3Q.DE', 'VVSM.DE', 'URNU.DE', 'EMXC.DE', 'PPFB.DE', 'XNAS.DE',
  'QQQ', 'SPY', 'GLD', 'SLV', 'URA', 'SMH', 'EEM', 'TLT', 'IWM',
  'XLF', 'XLE', 'XLK', 'XLV', 'GDX', 'LIT', 'COPX', 'ARKK',
];

// ── Fetch Yahoo Finance ───────────────────────────────────────
async function fetchYahoo(ticker: string): Promise<{ closes: number[]; price: number } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;
    const closes = (result.indicators?.quote?.[0]?.close ?? []).filter((c: any) => c != null) as number[];
    const price  = result.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? 0;
    return { closes, price };
  } catch { return null; }
}

// ── RSI simplificado ─────────────────────────────────────────
function calcRSI2(closes: number[]): number {
  if (closes.length < 5) return 50;
  const rets = closes.slice(-5).map((c, i, a) => i === 0 ? 0 : c - a[i - 1]).slice(1);
  let g = 0, l = 0;
  rets.forEach(r => { if (r > 0) g += r; else l += Math.abs(r); });
  g /= rets.length; l /= rets.length;
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function calcZ(closes: number[]): number {
  const sl = closes.slice(-20);
  const m  = sl.reduce((a, b) => a + b, 0) / sl.length;
  const sd = Math.sqrt(sl.reduce((s, v) => s + (v - m) ** 2, 0) / (sl.length - 1));
  return sd > 0 ? (closes[closes.length - 1] - m) / sd : 0;
}

function calcBBLower(closes: number[]): number {
  const sl = closes.slice(-20);
  const m  = sl.reduce((a, b) => a + b, 0) / sl.length;
  const sd = Math.sqrt(sl.reduce((s, v) => s + (v - m) ** 2, 0) / (sl.length - 1));
  return m - 2 * sd;
}

function calcMA200(closes: number[]): number {
  const sl = closes.slice(-200);
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}

// ── Detectar señales (versión lite para Edge Function) ────────
interface LiteOpportunity {
  ticker:      string;
  price:       number;
  signal:      string;
  score:       number;
  entry:       number;
  stopLoss:    number;
  takeProfit1: number;
  reasoning:   string;
}

function detectOpportunity(ticker: string, closes: number[], price: number): LiteOpportunity | null {
  if (closes.length < 30) return null;

  const rsi2   = calcRSI2(closes);
  const z      = calcZ(closes);
  const bbLow  = calcBBLower(closes);
  const ma200  = calcMA200(closes);
  const aboveMA200 = price > ma200;

  let signal   = '';
  let score    = 0;
  let reasoning = '';

  // Blood in streets: RSI(2) + Z-Score
  if (rsi2 < 5 && z < -2.5 && aboveMA200) {
    signal    = '🩸 BLOOD IN STREETS';
    score     = Math.min(100, 50 + (5 - rsi2) * 6 + Math.abs(z) * 4);
    reasoning = `RSI(2)=${rsi2.toFixed(1)} extremo + Z=${z.toFixed(2)} — Pánico máximo. Activo sobre MA200: base estructural intacta. Alta probabilidad de rebote en 3-5 días.`;
  }
  // Mean Reversion: RSI(2) + Bollinger
  else if (rsi2 < 10 && price < bbLow) {
    signal    = '↩ MEAN REVERSION';
    score     = Math.min(100, 45 + (10 - rsi2) * 3 + 15);
    reasoning = `RSI(2)=${rsi2.toFixed(1)} + precio bajo Bollinger inferior (€${bbLow.toFixed(2)}) — Desviación extrema de la media. Vuelta estadísticamente probable.`;
  }

  if (!signal || score < 45) return null;

  // Stop y TP calculados con ATR simple
  const atr    = Math.abs(closes[closes.length - 1] - closes[closes.length - 2]) * 1.5;
  const sl     = price - atr * 2;
  const tp1    = price + (price - sl) * 1.5;

  return { ticker, price, signal, score, entry: price, stopLoss: sl, takeProfit1: tp1, reasoning };
}

// ── Enviar mensaje Telegram ───────────────────────────────────
async function sendTelegram(token: string, chatId: string, message: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    chatId,
      text:       message,
      parse_mode: 'Markdown',
    }),
  });
}

// ── Guardar oportunidades en Supabase DB ──────────────────────
async function saveToSupabase(supabase: any, opportunities: LiteOpportunity[]): Promise<void> {
  if (opportunities.length === 0) return;
  const rows = opportunities.map(o => ({
    ticker:       o.ticker,
    signal:       o.signal,
    score:        o.score,
    entry_price:  o.entry,
    stop_loss:    o.stopLoss,
    take_profit1: o.takeProfit1,
    reasoning:    o.reasoning,
    detected_at:  new Date().toISOString(),
    status:       'OPEN',
  }));
  await supabase.from('tactical_opportunities').insert(rows).catch(console.error);
}

// ── Handler principal ─────────────────────────────────────────
// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    // @ts-ignore
    Deno.env.get('SUPABASE_URL') ?? '',
    // @ts-ignore
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
  // @ts-ignore
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
  // @ts-ignore
  const chatId   = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';

  const opportunities: LiteOpportunity[] = [];
  const errors: string[] = [];

  // Escanear en batches de 4
  const BATCH = 4;
  for (let i = 0; i < DAILY_SCAN.length; i += BATCH) {
    const batch = DAILY_SCAN.slice(i, i + BATCH);
    await Promise.all(batch.map(async ticker => {
      const data = await fetchYahoo(ticker);
      if (!data || data.closes.length < 30) {
        errors.push(ticker);
        return;
      }
      const opp = detectOpportunity(ticker, data.closes, data.price);
      if (opp) opportunities.push(opp);
    }));
    await new Promise(r => setTimeout(r, 200));
  }

  // Guardar en base de datos
  await saveToSupabase(supabase, opportunities);

  // Construir y enviar mensaje Telegram
  const now    = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  let message  = `*⚡ OLYMPUS MOTOR TÁCTICO — ${now}*\n`;
  message     += `Activos escaneados: ${DAILY_SCAN.length} · Errores: ${errors.length}\n\n`;

  if (opportunities.length === 0) {
    message += '✅ Sin oportunidades de alta calidad hoy. El mercado no presenta señales extremas.';
  } else {
    message += `🎯 *${opportunities.length} OPORTUNIDADES DETECTADAS:*\n\n`;
    opportunities
      .sort((a, b) => b.score - a.score)
      .slice(0, 5) // Top 5 para no saturar Telegram
      .forEach(o => {
        message += `*${o.signal} — ${o.ticker}*\n`;
        message += `Score: ${o.score}/100 | Precio: €${o.price.toFixed(2)}\n`;
        message += `Entrada: €${o.entry.toFixed(2)} | SL: €${o.stopLoss.toFixed(2)} | TP1: €${o.takeProfit1.toFixed(2)}\n`;
        message += `R:R: 1.5:1\n`;
        message += `📊 _${o.reasoning}_\n\n`;
      });
    message += `\n⚠️ _Estas son señales automáticas. Verifica siempre antes de ejecutar._`;
  }

  if (botToken && chatId) {
    await sendTelegram(botToken, chatId, message);
  }

  return new Response(
    JSON.stringify({ opportunitiesFound: opportunities.length, errors, timestamp: new Date().toISOString() }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
