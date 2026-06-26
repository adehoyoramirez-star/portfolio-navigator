// supabase-deno/telegram-alerts/index.ts
// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

// ── CORS ────────────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Variables de entorno ─────────────────────────────────────────────────
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

// ── Helpers ─────────────────────────────────────────────────────────────
const pct = (n?: number, d = 1): string =>
  n != null && isFinite(n) ? `${(n * 100).toFixed(d)}%` : "N/D";

const eur = (n?: number): string =>
  n != null && isFinite(n)
    ? new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 0,
      }).format(n)
    : "N/D";

const regimeEmoji: Record<string, string> = {
  BULL_EUPHORIA: "🚀",
  BULL_TREND: "📈",
  RECOVERY: "🌱",
  NEUTRAL: "➡️",
  CAUTION: "⚠️",
  RISK_OFF: "🛡️",
  BEAR_TREND: "📉",
  CRISIS: "🔴",
};

// ── Tipado de body de mensajes ───────────────────────────────────────────
interface TelegramBody {
  type: "regime_change" | "tail_risk" | "black_swan" | "vix_spike" | "daily_summary" | "tactical_opportunity";
  currentRegime?: string;
  previousRegime?: string;
  regimePenalty?: number;
  confidence?: number;
  dominantSignal?: string;
  portfolioValue?: number;
  portfolioDrawdown?: number;
  vix?: number;
  tailRiskReason?: string;
  blackSwanReason?: string;
  volMultiplier?: number;
  muEffective?: number;
  allocations?: { name: string; pct: number }[];
  btcPrice?: number;
  btcDominance?: number;
  fearGreed?: number;
  fearGreedLabel?: string;
  aiNarrative?: string;
  // Tactical opportunity fields
  tacticalTicker?: string;
  tacticalName?: string;
  tacticalType?: string;
  tacticalScore?: number;
  tacticalEntry?: number;
  tacticalStop?: number;
  tacticalTP1?: number;
  tacticalTP2?: number;
  tacticalRR?: number;
  tacticalSignals?: string;
  tacticalATR?: string;
  tacticalReasoning?: string;
  tacticalScanMode?: string;
}

// ── Telegram ─────────────────────────────────────────────────────────────
async function sendTelegram(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados en Supabase Secrets"
    );
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${err}`);
  }
}

// ── Builders ─────────────────────────────────────────────────────────────
function buildRegimeChange(body: TelegramBody): string {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const emoji = regimeEmoji[body.currentRegime ?? ''] ?? '📊';
  const prev = body.previousRegime ?? 'N/D';
  const curr = body.currentRegime ?? 'N/D';
  const pen = pct(body.regimePenalty, 0);
  const vixTxt = body.vix?.toFixed(1) ?? 'N/D';
  const val = body.portfolioValue ? eur(body.portfolioValue) : '';
  const dd = body.portfolioDrawdown != null ? pct(body.portfolioDrawdown) : '';
  return [
    `${emoji} <b>RÉGIMEN: ${prev} → ${curr}</b>`,
    `Pen ${pen} · VIX ${vixTxt} · ${body.dominantSignal ?? ''}`,
    val ? `${val} · DD ${dd}` : '',
    `⏰ ${now}`,
  ].filter(Boolean).join('\n');
}

function buildTailRisk(body: TelegramBody): string {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const volMult = body.volMultiplier != null ? `${body.volMultiplier.toFixed(2)}×` : '';
  const vixTxt = body.vix?.toFixed(1) ?? 'N/D';
  return [
    `🛡️ <b>TAIL RISK</b> · ${body.tailRiskReason ?? 'N/D'}`,
    `${body.currentRegime ?? 'N/D'}${volMult ? ' · VolTarget ' + volMult : ''} · VIX ${vixTxt}`,
    `⏰ ${now}`,
  ].filter(Boolean).join('\n');
}

function buildBlackSwan(body: TelegramBody): string {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return [
    `🦢 <b>CISNE NEGRO</b> · VIX ${body.vix?.toFixed(1) ?? 'N/D'}`,
    `${body.blackSwanReason ?? ''}`,
    `<b>${body.currentRegime ?? 'N/D'}</b> · Revisar coberturas`,
    `⏰ ${now}`,
  ].filter(Boolean).join('\n');
}

function buildVixSpike(body: TelegramBody): string {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const level = (body.vix ?? 0) >= 40 ? '🔴 PÁNICO' : '🟠 ESTRÉS';
  const vixTxt = body.vix?.toFixed(1) ?? 'N/D';
  return [
    `📊 <b>VIX ${vixTxt} ${level}</b>`,
    `${body.currentRegime ?? 'N/D'}${body.portfolioValue ? ' · ' + eur(body.portfolioValue) : ''}`,
    `⏰ ${now}`,
  ].filter(Boolean).join('\n');
}

function buildTacticalOpportunity(body: TelegramBody): string {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const score = body.tacticalScore ?? 0;
  const rr = body.tacticalRR != null ? `R:R ${body.tacticalRR.toFixed(1)}:1` : '';
  const entry = body.tacticalEntry != null ? `Ent ${eur(body.tacticalEntry)}` : '';
  const stop = body.tacticalStop != null ? `Stop ${eur(body.tacticalStop)}` : '';
  const tp1 = body.tacticalTP1 != null ? `TP1 ${eur(body.tacticalTP1)}` : '';
  const tp2 = body.tacticalTP2 != null ? `TP2 ${eur(body.tacticalTP2)}` : '';
  return [
    `🎯 <b>${body.tacticalTicker ?? ''}</b> · ${body.tacticalType ?? ''} · Score ${score.toFixed(0)} · ${rr}`,
    [entry, stop, tp1, tp2].filter(Boolean).join(' · '),
    body.tacticalSignals ? `🧩 ${body.tacticalSignals}` : '',
    body.tacticalReasoning?.slice(0, 200) ?? '',
    `⏰ ${now}`,
  ].filter(Boolean).join('\n');
}

function buildDailySummary(body: TelegramBody): string {
  const emoji = regimeEmoji[body.currentRegime ?? ''] ?? '📊';
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const regimeTxt = body.currentRegime ?? 'N/D';
  const vixTxt = body.vix?.toFixed(1) ?? 'N/D';
  const val = eur(body.portfolioValue);
  const dd = pct(body.portfolioDrawdown);
  const allocs = Array.isArray(body.allocations)
    ? body.allocations
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 5)
        .map((a) => `${a.name.split(' ')[0]} ${(a.pct * 100).toFixed(0)}%`)
        .join(' · ')
    : '';
  const btcPrice = body.btcPrice ? `BTC ${eur(body.btcPrice)}` : '';
  const btcDom = body.btcDominance != null ? `DOM ${body.btcDominance.toFixed(1)}%` : '';
  const fg = body.fearGreed != null ? `F&G ${body.fearGreed}/${body.fearGreedLabel ?? ''}` : '';
  const mu = body.muEffective != null ? `μ ${(body.muEffective * 100).toFixed(1)}%` : '';
  return [
    `🏦 <b>HENDE · ${now}</b>`,
    `${emoji} <b>${regimeTxt}</b> | VIX ${vixTxt}${mu ? ' | ' + mu : ''}`,
    [btcPrice, btcDom, fg].filter(Boolean).join(' · '),
    allocs ? `📍 ${allocs}` : '',
    `${val} · DD ${dd}`,
    body.aiNarrative?.slice(0, 150) ?? '',
  ].filter(Boolean).join('\n');
}

// ── Main handler ─────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let body: TelegramBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const type = body.type ?? "";

  let message: string;
  try {
    switch (type) {
      case "regime_change":
        message = buildRegimeChange(body);
        break;
      case "tail_risk":
        message = buildTailRisk(body);
        break;
      case "black_swan":
        message = buildBlackSwan(body);
        break;
      case "vix_spike":
        message = buildVixSpike(body);
        break;
      case "tactical_opportunity":
        message = buildTacticalOpportunity(body);
        break;
      case "daily_summary":
        message = buildDailySummary(body);
        break;
      default:
        return new Response(JSON.stringify({ error: `Tipo desconocido: ${type}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    await sendTelegram(message);

    return new Response(
      JSON.stringify({ ok: true, type, sentAt: new Date().toISOString() }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    console.error("telegram-alerts error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error)?.message ?? String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});