// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
// =====================================================================
// ai-intelligence — 100% GRATUITO con Gemini Flash
// 3 roles paralelos: Macro Strategist · Elliott Analyst · Market Sentinel
// GEMINI_API_KEY gratis en aistudio.google.com/apikey
// Límite free tier: 1,500 peticiones/día — suficiente para uso diario
// =====================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const GEMINI_MODELS = ['gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

let cache = null;
const CACHE_TTL = 15 * 60 * 1000;

function ctxHash(ctx) {
  return `${ctx.regime}-${Math.round(ctx.vix)}-${Math.round(ctx.btcRsi)}-${ctx.fearGreed}-${Math.round(ctx.creditSpread * 10)}`;
}

function macroSummary(ctx) {
  return `FECHA: ${new Date().toISOString().slice(0, 10)}
RÉGIMEN: ${ctx.regime} | penalty=${(ctx.regimePenalty*100).toFixed(0)}% | conf=${ctx.confidence} | P(crisis)=${(ctx.probCrisis*100).toFixed(0)}%
MACRO: VIX=${ctx.vix.toFixed(1)} MOVE=${ctx.move.toFixed(0)} Bond10y=${ctx.bond10y.toFixed(2)}% Bond2y=${ctx.bond2y.toFixed(2)}% CreditSprd=${ctx.creditSpread.toFixed(2)}% M2=${ctx.m2Growth.toFixed(1)}% DXY=${ctx.dxy.toFixed(1)} Brent=$${ctx.brent.toFixed(0)} BE5y=${ctx.breakeven?.toFixed(2)??"N/D"}%
CRYPTO: BTC=$${ctx.btcPrice.toLocaleString()} RSI14d=${ctx.btcRsi.toFixed(0)} RSIweek=${ctx.btcRsiWeekly.toFixed(0)} DOM=${ctx.btcDominance.toFixed(1)}% MVRV=${ctx.mvrv.toFixed(2)} Puell=${ctx.puell?.toFixed(2)??"N/D"} HashRibbon=${ctx.hashRibbon??"N/D"}
TÉCNICO: Pi111=${ctx.piCycleMa111?.toFixed(0)??"N/D"} Pi350x2=${ctx.piCycleMa350x2?.toFixed(0)??"N/D"} sep=${ctx.piCycleSeparation?.toFixed(1)??"N/D"}% Elliott=${ctx.elliottWave??"N/D"}
PORTFOLIO: EUR${ctx.totalValue.toFixed(0)} vol=${(ctx.portfolioVol*100).toFixed(1)}% dd=${(ctx.drawdown*100).toFixed(1)}% mu=${(ctx.muEffective*100).toFixed(1)}%
ALLOCATIONS: ${ctx.allocations.map(a=>`${a.name}=${(a.pct*100).toFixed(1)}%`).join(' ')}
FEAR_GREED: ${ctx.fearGreed}/${ctx.fearGreedLabel}
${ctx.contradictions?.length>0?"CONTRADICCIONES: "+ctx.contradictions.join(" | "):""}`.trim();
}

async function callGemini(prompt, maxTokens = 500) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY no configurada');
  for (const model of GEMINI_MODELS) {
    try {
      const url = `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.25 },
        }),
      });
      if (res.status === 429 || res.status === 503) continue;
      if (!res.ok) throw new Error(`${model}: ${res.status}`);
      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      return text.replace(/```json|```/g, '').trim();
    } catch (e) {
      if (GEMINI_MODELS.indexOf(model) === GEMINI_MODELS.length - 1) throw e;
    }
  }
  throw new Error('All Gemini models failed');
}

async function runMacroStrategist(ctx) {
  const now = new Date().toISOString();
  if (!GEMINI_KEY) return { regimeNarrative:'Configura GEMINI_API_KEY en Supabase Secrets (gratis: aistudio.google.com/apikey)', macroValidation:'', btcCycleSummary:'', model:'gemini-flash', cachedAt:now, error:'no_api_key' };
  const prompt = `Eres un Macro Strategist senior de hedge fund institucional europeo.
Responde SOLO este JSON sin markdown:
{"regimeNarrative":"<3 frases sobre régimen macro actual>","macroValidation":"<2 frases sobre coherencia de señales>","btcCycleSummary":"<2 frases sobre ciclo BTC usando MVRV/FearGreed/PiCycle/HashRibbon>"}

${macroSummary(ctx)}`;
  try {
    const p = JSON.parse(await callGemini(prompt, 500));
    return { regimeNarrative:p.regimeNarrative??'', macroValidation:p.macroValidation??'', btcCycleSummary:p.btcCycleSummary??'', model:'gemini-flash (macro)', cachedAt:now };
  } catch(e) {
    return { regimeNarrative:'', macroValidation:'', btcCycleSummary:'', model:'gemini-flash', cachedAt:now, error:String(e).slice(0,150) };
  }
}

async function runElliottAnalyst(ctx) {
  const now = new Date().toISOString();
  if (!GEMINI_KEY) return { elliottAnalysis:'Configura GEMINI_API_KEY (gratis: aistudio.google.com)', rebalanceAdvice:'', contradictionAnalysis:'', model:'gemini-flash', cachedAt:now, error:'no_api_key' };
  const prompt = `Eres un analista cuantitativo especializado en Elliott y portfolio quant.
Responde SOLO este JSON sin markdown:
{"elliottAnalysis":"<análisis onda Elliott ${ctx.elliottWave??'no determinada'} y proyección 2-4 semanas>","rebalanceAdvice":"<recomendación concreta de rebalanceo — qué reducir/aumentar en BPS>","contradictionAnalysis":"<análisis contradicciones macro o 'Sin contradicciones materiales'>"}

${macroSummary(ctx)}`;
  try {
    const p = JSON.parse(await callGemini(prompt, 500));
    return { elliottAnalysis:p.elliottAnalysis??'', rebalanceAdvice:p.rebalanceAdvice??'', contradictionAnalysis:p.contradictionAnalysis??'', model:'gemini-flash (quant)', cachedAt:now };
  } catch(e) {
    return { elliottAnalysis:'', rebalanceAdvice:'', contradictionAnalysis:'', model:'gemini-flash', cachedAt:now, error:String(e).slice(0,150) };
  }
}

async function runMarketSentinel(ctx) {
  const now = new Date().toISOString();
  const autoBS = (ctx.vix>35 && ctx.creditSpread>6)||(ctx.move>150)||(ctx.mvrv>7)||(ctx.contradictions?.length>=3 && ctx.probCrisis>0.65);
  if (!GEMINI_KEY) return { marketSentiment:'Configura GEMINI_API_KEY (gratis: aistudio.google.com)', topNarratives:[], blackSwanAlert:autoBS, blackSwanReason:autoBS?`Auto: VIX=${ctx.vix.toFixed(1)} MVRV=${ctx.mvrv.toFixed(2)}`:null, model:'gemini-flash', cachedAt:now, error:'no_api_key' };
  const prompt = `Eres un Market Sentinel institucional — detector de sentimiento y riesgo de cola.
Responde SOLO este JSON sin markdown:
{"marketSentiment":"<2-3 frases sobre sentimiento real y narrativa que mueve precios>","topNarratives":["<narrativa 1>","<narrativa 2>","<narrativa 3>"],"blackSwanAlert":${autoBS},"blackSwanReason":${autoBS?'"<riesgo cola específico>"':'null'}}

Estado actual: VIX=${ctx.vix.toFixed(1)}, CreditSprd=${ctx.creditSpread.toFixed(2)}%, MOVE=${ctx.move.toFixed(0)}, MVRV=${ctx.mvrv.toFixed(2)}, P(crisis)=${(ctx.probCrisis*100).toFixed(0)}%
${macroSummary(ctx)}`;
  try {
    const p = JSON.parse(await callGemini(prompt, 400));
    return { marketSentiment:p.marketSentiment??'', topNarratives:Array.isArray(p.topNarratives)?p.topNarratives.slice(0,3):[], blackSwanAlert:p.blackSwanAlert===true||autoBS, blackSwanReason:p.blackSwanAlert?(p.blackSwanReason??null):null, model:'gemini-flash (sentinel)', cachedAt:now };
  } catch(e) {
    return { marketSentiment:'', topNarratives:[], blackSwanAlert:autoBS, blackSwanReason:autoBS?`Auto-alerta: VIX=${ctx.vix.toFixed(1)}, MVRV=${ctx.mvrv.toFixed(2)}`:null, model:'gemini-flash', cachedAt:now, error:String(e).slice(0,150) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  let ctx;
  try { ctx = await req.json(); } catch { return new Response(JSON.stringify({error:'Invalid JSON'}),{status:400,headers:{...corsHeaders,'Content-Type':'application/json'}}); }

  const hash = ctxHash(ctx);
  const now = Date.now();
  if (cache && cache.expiresAt > now && cache.hash === hash) {
    return new Response(JSON.stringify({...cache.result, cacheHit:true}), { headers:{...corsHeaders,'Content-Type':'application/json'} });
  }

  const [gemini, claude, grok] = await Promise.all([runMacroStrategist(ctx), runElliottAnalyst(ctx), runMarketSentinel(ctx)]);
  const output = { gemini, claude, grok, fetchedAt:new Date().toISOString(), cacheHit:false };
  cache = { result:output, hash, expiresAt:now+CACHE_TTL };

  return new Response(JSON.stringify(output), { headers:{...corsHeaders,'Content-Type':'application/json'} });
});
