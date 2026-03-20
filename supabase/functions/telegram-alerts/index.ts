// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

/**
 * SUPABASE EDGE FUNCTION: telegram-alerts
 * =====================================================================
 * Sistema de alertas institucionales vía Telegram Bot API.
 *
 * TIPOS DE ALERTA SOPORTADOS:
 *   black_swan      — Alerta crítica de cisne negro (Grok detection)
 *   regime_change   — Cambio de régimen macro (EXPANSION/CONTRACTION/CRISIS)
 *   cews_alert      — Crisis Early Warning System activado
 *   rebalance       — Sugerencia de rebalanceo automático
 *   cycle_top       — Señal de techo de ciclo BTC detectada
 *   dca_signal      — Señal DCA de oportunidad de compra
 *   custom          — Mensaje libre desde el dashboard
 *
 * ENV REQUIRED:
 *   TELEGRAM_BOT_TOKEN   — Token del bot (BotFather)
 *   TELEGRAM_CHAT_ID     — ID del chat / grupo institucional
 *
 * RATE LIMIT: 1 alerta por tipo cada 30 min (anti-spam)
 * =====================================================================
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const BOT_TOKEN  = Deno.env.get('TELEGRAM_BOT_TOKEN')  ?? '';
const CHAT_ID    = Deno.env.get('TELEGRAM_CHAT_ID')    ?? '';
const TOPIC_ID   = Deno.env.get('TELEGRAM_TOPIC_ID')   ?? ''; // para grupos con topics

// ── Rate limiting en memoria (reset en cada cold start del Edge) ───────────────
const lastSentAt: Record<string, number> = {};
const COOLDOWN_MS: Record<string, number> = {
  black_swan:    0,          // sin cooldown — siempre enviar
  regime_change: 5 * 60_000, // 5 min
  cews_alert:    10 * 60_000, // 10 min
  rebalance:     30 * 60_000, // 30 min
  cycle_top:     60 * 60_000, // 1 hora
  dca_signal:    30 * 60_000, // 30 min
  custom:        60_000,      // 1 min
};

function isRateLimited(type: string): boolean {
  const now = Date.now();
  const last = lastSentAt[type] ?? 0;
  const cooldown = COOLDOWN_MS[type] ?? 5 * 60_000;
  return now - last < cooldown;
}

function markSent(type: string): void {
  lastSentAt[type] = Date.now();
}

// ── Formateo de mensajes por tipo ─────────────────────────────────────────────
interface AlertPayload {
  type: string;
  // black_swan
  blackSwanReason?: string;
  currentRegime?: string;
  vix?: number;
  // regime_change
  previousRegime?: string;
  newRegime?: string;
  regimePenalty?: number;
  confidence?: string;
  dominantSignal?: string;
  // cews_alert
  cewsLevel?: string;
  cewsScore?: number;
  cewsDetails?: string;
  // rebalance
  suggestions?: Array<{ ticker: string; action: string; delta: number; reason: string }>;
  totalValue?: number;
  // cycle_top
  cycleSignals?: string[];
  btcPrice?: number;
  mvrv?: number;
  piCycleSeparation?: number;
  // dca_signal
  dcaScore?: number;
  dcaRecommendedAmount?: number;
  dcaReason?: string;
  // shared context
  portfolioVol?: number;
  drawdown?: number;
  fearGreed?: number;
  fearGreedLabel?: string;
  geminiNarrative?: string;
  // custom
  message?: string;
}

function fmt(n: number | undefined, decimals = 1): string {
  if (n === undefined || n === null) return 'N/D';
  return n.toFixed(decimals);
}

function regimeEmoji(regime: string | undefined): string {
  if (!regime) return '📊';
  if (regime.includes('CRISIS') || regime.includes('CRASH')) return '🔴';
  if (regime.includes('CONTRACTION') || regime.includes('RISK_OFF')) return '🟠';
  if (regime.includes('EXPANSION') || regime.includes('ATTACK')) return '🟢';
  return '🟡';
}

function buildMessage(payload: AlertPayload): string {
  const ts = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const header = `🏦 *Olympus Capital · Institutional Desk*\n_${ts} CET_\n`;

  switch (payload.type) {
    case 'black_swan':
      return `${header}\n` +
        `⚫️ *ALERTA CISNE NEGRO — NIVEL MÁXIMO*\n\n` +
        `⚠️ *Razón:* ${payload.blackSwanReason ?? 'Sin detalles'}\n\n` +
        `📊 *Régimen:* ${regimeEmoji(payload.currentRegime)} ${payload.currentRegime ?? 'N/D'}\n` +
        `📉 *VIX:* ${fmt(payload.vix)}\n` +
        `😱 *Fear & Greed:* ${payload.fearGreed ?? 'N/D'} (${payload.fearGreedLabel ?? ''})\n\n` +
        `🚨 *ACCIÓN INMEDIATA REQUERIDA*\n` +
        `Revisar coberturas y exposición. Activar protocolo RISK\\_OFF.`;

    case 'regime_change':
      return `${header}\n` +
        `${regimeEmoji(payload.newRegime)} *CAMBIO DE RÉGIMEN MACRO*\n\n` +
        `📈 *Anterior:* ${payload.previousRegime ?? 'N/D'}\n` +
        `📊 *Nuevo:* *${payload.newRegime ?? 'N/D'}*\n` +
        `⚖️ *Penalización:* ${payload.regimePenalty !== undefined ? (payload.regimePenalty * 100).toFixed(0) + '%' : 'N/D'}\n` +
        `🎯 *Señal dominante:* ${payload.dominantSignal ?? 'N/D'}\n` +
        `🔬 *Confianza:* ${payload.confidence ?? 'N/D'}\n\n` +
        (payload.geminiNarrative ? `🤖 *Gemini:* ${payload.geminiNarrative.slice(0, 300)}...\n` : '') +
        `_Motor OlympusV3 — ajustando allocations._`;

    case 'cews_alert':
      const levelEmoji = payload.cewsLevel === 'CRISIS' ? '🔴' :
                         payload.cewsLevel === 'WATCH'  ? '🟠' :
                         payload.cewsLevel === 'WARN'   ? '🟡' : '🟢';
      return `${header}\n` +
        `${levelEmoji} *CEWS — Crisis Early Warning System*\n\n` +
        `📊 *Nivel:* *${payload.cewsLevel ?? 'N/D'}*\n` +
        `📈 *Score CEWS:* ${fmt(payload.cewsScore, 3)}\n\n` +
        (payload.cewsDetails ? `📝 *Detalle:* ${payload.cewsDetails}\n\n` : '') +
        `_Sistema de alerta temprana activado. Monitorear de cerca._`;

    case 'rebalance':
      const sugs = payload.suggestions ?? [];
      const sugLines = sugs.slice(0, 5).map(s =>
        `  • *${s.ticker}*: ${s.action} ${(Math.abs(s.delta) * 100).toFixed(1)}pp — ${s.reason}`
      ).join('\n');
      return `${header}\n` +
        `⚖️ *REBALANCEO SUGERIDO*\n\n` +
        `💼 *AUM:* €${payload.totalValue?.toFixed(0) ?? 'N/D'}\n` +
        `📉 *Vol cartera:* ${fmt((payload.portfolioVol ?? 0) * 100)}%\n` +
        `📊 *Drawdown:* ${fmt((payload.drawdown ?? 0) * 100)}%\n\n` +
        `📋 *Movimientos:*\n${sugLines}\n\n` +
        `_Ejecutar previa validación del gestor._`;

    case 'cycle_top':
      const signals = payload.cycleSignals ?? [];
      return `${header}\n` +
        `⛰️ *SEÑAL DE TECHO DE CICLO BTC*\n\n` +
        `₿ *BTC:* $${payload.btcPrice?.toLocaleString() ?? 'N/D'}\n` +
        `📊 *MVRV:* ${fmt(payload.mvrv, 2)}\n` +
        `🔵 *Pi Cycle sep:* ${fmt(payload.piCycleSeparation, 1)}%\n\n` +
        `🚩 *Señales activas:*\n${signals.map(s => `  • ${s}`).join('\n')}\n\n` +
        `_Reducir exposición BTC según protocolo ciclo._`;

    case 'dca_signal':
      return `${header}\n` +
        `💰 *SEÑAL DCA — OPORTUNIDAD DE COMPRA*\n\n` +
        `📊 *Score DCA:* ${fmt(payload.dcaScore, 2)}/1.00\n` +
        `💶 *Importe sugerido:* €${payload.dcaRecommendedAmount?.toFixed(0) ?? 'N/D'}\n` +
        `📝 *Razón:* ${payload.dcaReason ?? 'Score DCA elevado'}\n` +
        `😱 *Fear & Greed:* ${payload.fearGreed ?? 'N/D'} (${payload.fearGreedLabel ?? ''})\n\n` +
        `_Ejecutar DCA según plan de inyección mensual._`;

    case 'custom':
      return `${header}\n${payload.message ?? 'Sin mensaje'}`;

    default:
      return `${header}\n_Alerta tipo desconocido: ${payload.type}_`;
  }
}

// ── Enviar mensaje vía Telegram Bot API ───────────────────────────────────────
async function sendTelegram(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!BOT_TOKEN || !CHAT_ID) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set' };
  }

  const body: Record<string, unknown> = {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };

  // Si hay topic ID (supergrupos con temas), añadirlo
  if (TOPIC_ID) {
    body.message_thread_id = parseInt(TOPIC_ID, 10);
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error('Telegram error:', json.description);
      return { ok: false, error: json.description };
    }
    return { ok: true };
  } catch (e) {
    console.error('Telegram fetch error:', e);
    return { ok: false, error: String(e) };
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  let payload: AlertPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!payload.type) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing type' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Rate limit check (excepto black_swan — siempre pasa)
  if (payload.type !== 'black_swan' && isRateLimited(payload.type)) {
    return new Response(
      JSON.stringify({ ok: false, rateLimited: true, reason: `Cooldown activo para tipo '${payload.type}'` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const message = buildMessage(payload);
  const result  = await sendTelegram(message);

  if (result.ok) markSent(payload.type);

  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
