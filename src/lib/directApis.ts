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

// ── AI Intelligence (Gemini directo) ─────────────────────────
export interface AIIntelligenceOutput {
  gemini: { regimeNarrative: string; macroValidation: string; btcCycleSummary: string; model: string; cachedAt: string; error?: string } | null;
  grok: { marketSentiment: string; topNarratives: string[]; blackSwanAlert: boolean; blackSwanReason: string | null; model: string; cachedAt: string; error?: string } | null;
  claude: { elliottAnalysis: string; rebalanceAdvice: string; contradictionAnalysis: string; model: string; cachedAt: string; error?: string } | null;
  fetchedAt: string;
  cacheHit: boolean;
}

let _aiCache: { result: AIIntelligenceOutput; hash: string; expiresAt: number } | null = null;
const AI_CACHE_TTL = 15 * 60 * 1000;

const GEMINI_KEY = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_GEMINI_API_KEY) || '';

function sf(n: number, d = 1) { return (n != null && isFinite(n) ? Number(n).toFixed(d) : 'N/D'); }

function ctxHash(ctx: any) { return `${ctx.regime}-${Math.round(ctx.vix??0)}-${Math.round(ctx.btcRsi??0)}-${ctx.fearGreed??0}`; }

function macroSummary(ctx: any) {
  return `FECHA: ${new Date().toISOString().slice(0,10)}
REGIMEN: ${ctx.regime??'N/D'} | penalty=${sf((ctx.regimePenalty??0)*100,0)}% | P(crisis)=${sf((ctx.probCrisis??0)*100,0)}%
MACRO: VIX=${sf(ctx.vix)} MOVE=${sf(ctx.move,0)} Bond10y=${sf(ctx.bond10y,2)}% Bond2y=${sf(ctx.bond2y,2)}% CreditSprd=${sf(ctx.creditSpread,2)}% M2=${sf(ctx.m2Growth)}% DXY=${sf(ctx.dxy)} Brent=${sf(ctx.brent,0)}
CRYPTO: BTC=${sf(ctx.btcPrice,0)} RSI=${sf(ctx.btcRsi,0)} DOM=${sf(ctx.btcDominance)}% MVRV=${sf(ctx.mvrv,2)} FearGreed=${ctx.fearGreed??'N/D'}/${ctx.fearGreedLabel??'N/D'}`.trim();
}

async function callGemini(prompt: string, maxTokens = 500): Promise<string> {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY no configurada');
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.25 } }),
      });
      if (res.status === 429 || res.status === 503 || res.status === 404) continue;
      if (!res.ok) throw new Error(`${model}: ${res.status}`);
      const json = await res.json();
      return (json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}').replace(/```json|```/g, '').trim();
    } catch (e) {
      if (models.indexOf(model) === models.length - 1) throw e;
    }
  }
  throw new Error('All Gemini models failed');
}

function emptyAI(): AIIntelligenceOutput {
  const ts = new Date().toISOString();
  const err = { error: 'Sin API key Gemini (VITE_GEMINI_API_KEY)', model: 'gemini', cachedAt: ts };
  return {
    gemini: { regimeNarrative: '', macroValidation: '', btcCycleSummary: '', ...err },
    claude: null,
    grok: { marketSentiment: '', topNarratives: [], blackSwanAlert: false, blackSwanReason: null, ...err },
    fetchedAt: ts, cacheHit: false,
  };
}

export async function fetchAIIntelligence(ctx: any): Promise<AIIntelligenceOutput> {
  if (!GEMINI_KEY) return emptyAI();

  const hash = ctxHash(ctx);
  const now = Date.now();
  if (_aiCache && _aiCache.expiresAt > now && _aiCache.hash === hash) {
    return { ..._aiCache.result, cacheHit: true };
  }

  const ts = new Date().toISOString();
  const summary = macroSummary(ctx);

  try {
    const macroPrompt = `Eres estratega macro senior de hedge fund. Responde SOLO en JSON sin markdown:
{"regimeNarrative":"<3 frases>","macroValidation":"<2 frases>","btcCycleSummary":"<2 frases>"}

${summary}`;
    const sentinelPrompt = `Eres analista de riesgo sistemico. Responde SOLO en JSON sin markdown:
{"marketSentiment":"<2 frases>","topNarratives":["n1","n2","n3"],"blackSwanAlert":false,"blackSwanReason":null}

${summary}`;

    const [macroRaw, sentinelRaw] = await Promise.all([
      callGemini(macroPrompt, 400),
      callGemini(sentinelPrompt, 400),
    ]);

    const macro = JSON.parse(macroRaw);
    const sentinel = JSON.parse(sentinelRaw);

    const output: AIIntelligenceOutput = {
      gemini: { ...macro, model: 'gemini-2.5-flash', cachedAt: ts },
      claude: null,
      grok: { ...sentinel, model: 'gemini-2.5-flash', cachedAt: ts },
      fetchedAt: ts, cacheHit: false,
    };

    _aiCache = { result: output, hash, expiresAt: now + AI_CACHE_TTL };
    return output;
  } catch (err: any) {
    console.warn('[AIIntelligence] Gemini error:', err?.message ?? err);
    return emptyAI();
  }
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
