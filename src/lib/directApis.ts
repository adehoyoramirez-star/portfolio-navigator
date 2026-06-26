// ============================================================
// src/lib/directApis.ts — APIs directas sin Supabase
// Reemplaza las Edge Functions:
//   crypto-signals    -> fetchCryptoSignals()
//   ai-intelligence   -> fetchAIIntelligence()
//   telegram-alerts   -> sendTelegramAlert()
// ============================================================

// ── Crypto Signals (Alternative.me + CoinGecko) ──────────────
export interface CryptoSignalsOutput {
  fearGreedValue: number;
  fearGreedLabel: string;
  fearGreedSource: string;
  btcDominance: number;
  btcDominanceSrc: string;
  btcPriceUSD: number;
  btcPriceEUR: number;
  eurUsd: number;
  errors: string[];
}

async function fetchFearGreed(): Promise<{ value: number; label: string } | null> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1&format=json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const entry = json?.data?.[0];
    if (!entry) return null;
    return { value: parseInt(entry.value, 10), label: entry.value_classification };
  } catch { return null; }
}

async function fetchCoinGeckoGlobal(): Promise<{ btcDominance: number; btcPriceUSD: number; btcPriceEUR: number; eurUsd: number } | null> {
  try {
    const [globalRes, priceRes] = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/global', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }),
    ]);
    if (!globalRes.ok || !priceRes.ok) return null;
    const [gJson, pJson] = await Promise.all([globalRes.json(), priceRes.json()]);
    const btcDominance = gJson?.data?.market_cap_percentage?.btc ?? 0;
    const btcPriceUSD = pJson?.bitcoin?.usd ?? 0;
    const btcPriceEUR = pJson?.bitcoin?.eur ?? 0;
    const eurUsd = btcPriceUSD > 0 && btcPriceEUR > 0 ? parseFloat((btcPriceUSD / btcPriceEUR).toFixed(4)) : 1.08;
    return { btcDominance, btcPriceUSD, btcPriceEUR, eurUsd };
  } catch { return null; }
}

export async function fetchCryptoSignals(): Promise<CryptoSignalsOutput> {
  const errors: string[] = [];
  const [fg, cg] = await Promise.all([
    fetchFearGreed().catch(() => null),
    fetchCoinGeckoGlobal().catch(() => null),
  ]);

  const fearGreedValue = fg?.value ?? 50;
  const fearGreedLabel = fg?.label ?? 'Neutral';
  const fearGreedSource = fg ? 'Alternative.me' : 'manual';
  if (!fg) errors.push('Alternative.me');

  const btcDominance = cg?.btcDominance ?? 54.0;
  const btcDominanceSrc = cg ? 'CoinGecko' : 'manual';
  const btcPriceUSD = cg?.btcPriceUSD ?? 0;
  const btcPriceEUR = cg?.btcPriceEUR ?? (btcPriceUSD / 1.08);
  const eurUsd = cg?.eurUsd ?? 1.08;
  if (!cg) errors.push('CoinGecko');

  return { fearGreedValue, fearGreedLabel, fearGreedSource, btcDominance, btcDominanceSrc, btcPriceUSD, btcPriceEUR, eurUsd, errors };
}

// ── AI Intelligence (motor local — sin dependencia de APIs externas) ────
// NOTA: Gemini eliminado (Jun 2026). El motor AI usa Mistral Cloud
// (mistralAI.ts) como fuente principal. Este módulo proporciona
// el fallback local cuando Mistral no está configurado.
export interface AIIntelligenceOutput {
  // Campo unificado: antes separado en gemini/claude/grok,
  // ahora un solo objeto con toda la inteligencia combinada
  ai: {
    regimeNarrative: string;
    macroValidation: string;
    btcCycleSummary: string;
    marketSentiment: string;
    topNarratives: string[];
    blackSwanAlert: boolean;
    blackSwanReason: string | null;
    elliottAnalysis?: string;
    rebalanceAdvice?: string;
    contradictionAnalysis?: string;
    model: string;
    cachedAt: string;
    error?: string;
  } | null;
  fetchedAt: string;
  cacheHit: boolean;
}

let _aiCache: { result: AIIntelligenceOutput; hash: string; expiresAt: number } | null = null;
const AI_CACHE_TTL = 15 * 60 * 1000;

function sf(n: number, d = 1) { return (n != null && isFinite(n) ? Number(n).toFixed(d) : 'N/D'); }

function ctxHash(ctx: any) { return `${ctx.regime}-${Math.round(ctx.vix??0)}-${Math.round(ctx.btcRsi??0)}-${ctx.fearGreed??0}`; }

function macroSummary(ctx: any) {
  return `FECHA: ${new Date().toISOString().slice(0,10)}
REGIMEN: ${ctx.regime??'N/D'} | penalty=${sf((ctx.regimePenalty??0)*100,0)}% | P(crisis)=${sf((ctx.probCrisis??0)*100,0)}%
MACRO: VIX=${sf(ctx.vix)} MOVE=${sf(ctx.move,0)} Bond10y=${sf(ctx.bond10y,2)}% Bond2y=${sf(ctx.bond2y,2)}% CreditSprd=${sf(ctx.creditSpread,2)}% M2=${sf(ctx.m2Growth)}% DXY=${sf(ctx.dxy)} Brent=${sf(ctx.brent,0)}
CRYPTO: BTC=${sf(ctx.btcPrice,0)} RSI=${sf(ctx.btcRsi,0)} DOM=${sf(ctx.btcDominance)}% MVRV=${sf(ctx.mvrv,2)} FearGreed=${ctx.fearGreed??'N/D'}/${ctx.fearGreedLabel??'N/D'}`.trim();
}

function emptyAI(): AIIntelligenceOutput {
  const ts = new Date().toISOString();
  return {
    ai: { regimeNarrative: '', macroValidation: '', btcCycleSummary: '', marketSentiment: '', topNarratives: [], blackSwanAlert: false, blackSwanReason: null, model: 'offline', cachedAt: ts, error: 'Motor AI sin API configurada — usando reglas deterministicas' },
    fetchedAt: ts, cacheHit: false,
  };
}

/**
 * Fallback deterministico: calcula narrativas basicas desde datos de mercado.
 * Sin dependencia de APIs externas. El dashboard usa Mistral (mistralAI.ts)
 * como fuente primaria; esta funcion es el fallback cuando no hay API key.
 */
export async function fetchAIIntelligence(ctx: any): Promise<AIIntelligenceOutput> {
  const ts = new Date().toISOString();

  // Reglas deterministicas basicas desde los datos de mercado
  const regimeNarrative = ctx.regime === 'CRISIS'
    ? `Regimen CRISIS detectado. VIX=${sf(ctx.vix)}. Exposicion reducida.`
    : ctx.regime === 'CONTRACTION'
      ? `Regimen CONTRACTION. VIX=${sf(ctx.vix)}. Precaución activa.`
      : `Regimen EXPANSION. VIX=${sf(ctx.vix)}. Condiciones favorables.`;

  const macroValidation = ctx.vix > 30
    ? `VIX elevado (${sf(ctx.vix)}): volatilidad por encima de umbral de cautela.`
    : `VIX en rango normal (${sf(ctx.vix)}). Sin señales de estrés.`;

  const btcCycleSummary = ctx.fearGreed
    ? `Fear & Greed: ${ctx.fearGreed}/100 (${ctx.fearGreedLabel ?? 'N/D'}). RSI: ${sf(ctx.btcRsi, 0)}.`
    : 'Sin datos on-chain de BTC.';

  const marketSentiment = ctx.fearGreed && ctx.fearGreed < 30
    ? 'Miedo extremo — posible zona de acumulacion.'
    : ctx.fearGreed && ctx.fearGreed > 70
      ? 'Codicia extrema — precaucion con nuevas entradas.'
      : 'Sentimiento neutral.';

  const topNarratives: string[] = [];
  if (ctx.vix > 30) topNarratives.push('Volatilidad elevada');
  if (ctx.m2Growth < 0) topNarratives.push('Contraccion monetaria');
  if (ctx.btcDominance > 60) topNarratives.push('Dominancia BTC alta');
  if (topNarratives.length === 0) topNarratives.push('Sin narrativas dominantes');

  const output: AIIntelligenceOutput = {
    ai: { regimeNarrative, macroValidation, btcCycleSummary, marketSentiment, topNarratives, blackSwanAlert: false, blackSwanReason: null, model: 'rules-engine', cachedAt: ts },
    fetchedAt: ts, cacheHit: false,
  };

  _aiCache = { result: output, hash: ctxHash(ctx), expiresAt: Date.now() + AI_CACHE_TTL };
  return output;
}

// ── Telegram Alerts ──────────────────────────────────────────
const TG_BOT_TOKEN = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_TELEGRAM_BOT_TOKEN) || '';
const TG_CHAT_ID = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_TELEGRAM_CHAT_ID) || '';

export async function sendTelegramAlert(body: any): Promise<{ ok: boolean; error?: string }> {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.warn('[Telegram] Token o Chat ID no configurados');
    return { ok: false, error: 'Token o Chat ID no configurados' };
  }

  try {
    const message = buildTelegramMessage(body);
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: `Telegram API ${res.status}: ${err.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function buildTelegramMessage(body: any): string {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  switch (body.type) {
    case 'regime_change':
      return `📊 <b>CAMBIO DE REGIMEN</b>\n\n<b>Anterior:</b> ${body.previousRegime ?? 'N/D'}\n<b>Nuevo:</b> ${body.currentRegime ?? 'N/D'}\n<b>Penalizacion:</b> ${((body.regimePenalty ?? 1) * 100).toFixed(0)}%\n<b>VIX:</b> ${body.vix?.toFixed(1) ?? 'N/D'}\n\n⏰ ${now}`;
    case 'black_swan':
      return `🦢 <b>⚠️ CISNE NEGRO</b>\n\n${body.blackSwanReason ?? 'N/D'}\n<b>Regimen:</b> ${body.currentRegime ?? 'N/D'}\n<b>VIX:</b> ${body.vix?.toFixed(1) ?? 'N/D'}\n\n⏰ ${now}`;
    case 'tail_risk':
      return `🛡️ <b>TAIL RISK</b>\n\n<b>Motivo:</b> ${body.tailRiskReason ?? 'N/D'}\n<b>Vol:</b> ${body.volMultiplier?.toFixed(2) ?? 'N/D'}x\n\n⏰ ${now}`;
    case 'vix_spike':
      return `📊 <b>VIX SPIKE</b>\n\n<b>VIX:</b> ${body.vix?.toFixed(1) ?? 'N/D'}\n<b>Regimen:</b> ${body.currentRegime ?? 'N/D'}\n\n⏰ ${now}`;
    case 'daily_summary':
      return `📊 <b>RESUMEN DIARIO</b>\n${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Madrid' })}\n\n<b>Regimen:</b> ${body.currentRegime ?? 'N/D'}\n<b>Valor:</b> ${body.portfolioValue ? new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(body.portfolioValue) : 'N/D'}\n<b>Drawdown:</b> ${((body.portfolioDrawdown ?? 0) * 100).toFixed(1)}%\n\n⏰ ${now}`;
    case 'tactical_opportunity':
      return `🎯 <b>OPORTUNIDAD TACTICA</b> — ${body.tacticalTicker ?? ''}\n\n<b>${body.tacticalName ?? ''}</b> | ${body.tacticalType ?? ''} | Score ${(body.tacticalScore ?? 0).toFixed(0)}\n<b>R:R:</b> ${(body.tacticalRR ?? 0).toFixed(2)}:1\n\n⏰ ${now}`;
    default:
      return `📱 ${JSON.stringify(body)}`;
  }
}
