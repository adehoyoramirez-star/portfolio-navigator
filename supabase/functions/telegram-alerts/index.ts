// app/supabase/functions/telegram-alerts/index.ts
// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const CHAT_ID   = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';

// ─── helpers ───────────────────────────────────────────────────────────────

const pct = (n?: number, d = 1) =>
  n != null && isFinite(n) ? `${(n * 100).toFixed(d)}%` : 'N/D';

const eur = (n?: number) =>
  n != null && isFinite(n)
    ? new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
    : 'N/D';

const regimeEmoji: Record<string, string> = {
  BULL_EUPHORIA:  '🚀', BULL_TREND: '📈', RECOVERY: '🌱',
  NEUTRAL:        '➡️', CAUTION:   '⚠️', RISK_OFF: '🛡️',
  BEAR_TREND:     '📉', CRISIS:    '🔴',
};

async function sendTelegram(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error('TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados en Supabase Secrets');
  }
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${err}`);
  }
}

// ─── message builders ──────────────────────────────────────────────────────

function buildRegimeChange(body: any): string {
  const emoji = regimeEmoji[body.currentRegime] ?? '📊';
  return [
    `${emoji} <b>CAMBIO DE RÉGIMEN — HENDE FUND</b>`,
    ``,
    `<b>Anterior:</b> ${body.previousRegime ?? 'N/D'}`,
    `<b>Nuevo:</b> ${body.currentRegime}`,
    `<b>Penalización:</b> ${pct(body.regimePenalty)}`,
    `<b>Confianza motor:</b> ${pct(body.confidence)}`,
    `<b>Señal dominante:</b> ${body.dominantSignal ?? 'N/D'}`,
    ``,
    `📊 <b>Portfolio</b>`,
    `Valor: ${eur(body.portfolioValue)}`,
    `Drawdown: ${pct(body.portfolioDrawdown)}`,
    `VIX: ${body.vix?.toFixed(1) ?? 'N/D'}`,
    ``,
    `⏰ ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`,
  ].join('\n');
}

function buildTailRisk(body: any): string {
  return [
    `🛡️ <b>TAIL RISK ACTIVADO — HENDE FUND</b>`,
    ``,
    `<b>Motivo:</b> ${body.tailRiskReason ?? 'N/D'}`,
    `<b>Régimen:</b> ${body.currentRegime}`,
    `<b>Multiplicador vol:</b> ${body.volMultiplier?.toFixed(2) ?? 'N/D'}×`,
    `<b>VIX:</b> ${body.vix?.toFixed(1) ?? 'N/D'}`,
    ``,
    `⏰ ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`,
  ].join('\n');
}

function buildBlackSwan(body: any): string {
  return [
    `🦢 <b>⚠️ ALERTA CISNE NEGRO — HENDE FUND</b>`,
    ``,
    `<b>Análisis IA:</b> ${body.blackSwanReason ?? 'N/D'}`,
    `<b>Régimen:</b> ${body.currentRegime}`,
    `<b>VIX:</b> ${body.vix?.toFixed(1) ?? 'N/D'}`,
    ``,
    `⚡ Revisar coberturas y liquidez inmediatamente.`,
    `⏰ ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`,
  ].join('\n');
}

function buildVixSpike(body: any): string {
  const level = (body.vix ?? 0) >= 40 ? '🔴 PÁNICO' : '🟠 ESTRÉS';
  return [
    `📊 <b>VIX SPIKE ${level} — HENDE FUND</b>`,
    ``,
    `<b>VIX:</b> ${body.vix?.toFixed(1) ?? 'N/D'}`,
    `<b>Régimen:</b> ${body.currentRegime}`,
    `<b>Portfolio:</b> ${eur(body.portfolioValue)}`,
    ``,
    `⏰ ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`,
  ].join('\n');
}

function buildDailySummary(body: any): string {
  const emoji = regimeEmoji[body.currentRegime] ?? '📊';
  const allocs = Array.isArray(body.allocations)
    ? body.allocations
        .sort((a: any, b: any) => b.pct - a.pct)
        .slice(0, 5)
        .map((a: any) => `  • ${a.name}: ${pct(a.pct / 100, 0)}`)
        .join('\n')
    : 'N/D';

  return [
    `${emoji} <b>RESUMEN DIARIO — HENDE FUND</b>`,
    `${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Madrid' })}`,
    ``,
    `📊 <b>Portfolio</b>`,
    `Valor: ${eur(body.portfolioValue)}`,
    `Drawdown: ${pct(body.portfolioDrawdown)}`,
    ``,
    `🧠 <b>Régimen Olympus</b>`,
    `${body.currentRegime} | Penalización: ${pct(body.regimePenalty)}`,
    `Confianza: ${pct(body.confidence)}`,
    `Retorno esperado (μ): ${pct(body.muEffective)}`,
    ``,
    `₿ <b>Crypto</b>`,
    `BTC: ${eur(body.btcPrice)} | Dominancia: ${body.btcDominance?.toFixed(1) ?? 'N/D'}%`,
    `Fear & Greed: ${body.fearGreed ?? 'N/D'} — ${body.fearGreedLabel ?? ''}`,
    ``,
    `📌 <b>Top asignaciones</b>`,
    allocs,
    ``,
    body.geminiNarrative
      ? `🤖 <b>Gemini:</b> ${body.geminiNarrative.slice(0, 300)}`
      : '',
    ``,
    `⏰ ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`,
  ].filter(Boolean).join('\n');
}

// ─── main handler ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const type: string = body.type ?? '';

  let message: string;
  try {
    switch (type) {
      case 'regime_change':  message = buildRegimeChange(body);  break;
      case 'tail_risk':      message = buildTailRisk(body);      break;
      case 'black_swan':     message = buildBlackSwan(body);     break;
      case 'vix_spike':      message = buildVixSpike(body);      break;
      case 'daily_summary':  message = buildDailySummary(body);  break;
      default:
        return new Response(
          JSON.stringify({ error: `Tipo desconocido: ${type}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    await sendTelegram(message);

    return new Response(
      JSON.stringify({ ok: true, type, sentAt: new Date().toISOString() }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('telegram-alerts error:', err);
    return new Response(
      JSON.stringify({ ok: false, error: err?.message ?? String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});