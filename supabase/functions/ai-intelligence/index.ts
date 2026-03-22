// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const GEMINI_MODELS = ['gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

let cache = null;
const CACHE_TTL = 15 * 60 * 1000;

const sf = (n, d = 1) => (n != null && isFinite(n) ? Number(n).toFixed(d) : 'N/D');

function ctxHash(ctx) {
  return `${ctx.regime}-${Math.round(ctx.vix??0)}-${Math.round(ctx.btcRsi??0)}-${ctx.fearGreed??0}`;
}

function macroSummary(ctx) {
  return `FECHA: ${new Date().toISOString().slice(0,10)}
REGIMEN: ${ctx.regime??'N/D'} | penalty=${sf((ctx.regimePenalty??0)*100,0)}% | P(crisis)=${sf((ctx.probCrisis??0)*100,0)}%
MACRO: VIX=${sf(ctx.vix)} MOVE=${sf(ctx.move,0)} Bond10y=${sf(ctx.bond10y,2)}% Bond2y=${sf(ctx.bond2y,2)}% CreditSprd=${sf(ctx.creditSpread,2)}% M2=${sf(ctx.m2Growth)}% DXY=${sf(ctx.dxy)} Brent=$${sf(ctx.brent,0)}
CRYPTO: BTC=${sf(ctx.btcPrice,0)} RSI=${sf(ctx.btcRsi,0)} DOM=${sf(ctx.btcDominance)}% MVRV=${sf(ctx.mvrv,2)} FearGreed=${ctx.fearGreed??'N/D'}/${ctx.fearGreedLabel??'N/D'}
PORTFOLIO: EUR${sf(ctx.totalValue??0,0)} vol=${sf((ctx.portfolioVol??0)*100)}% dd=${sf((ctx.drawdown??0)*100)}% mu=${sf((ctx.muEffective??0)*100)}%
${Array.isArray(ctx.contradictions)&&ctx.contradictions.length>0?'CONTRADICCIONES: '+ctx.contradictions.join(' | '):''}`.trim();
}

async function callGemini(prompt, maxTokens=500) {
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
      if (res.status===429||res.status===503) continue;
      if (!res.ok) throw new Error(`${model}: ${res.status}`);
      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      return text.replace(/```json|```/g,'').trim();
    } catch(e) {
      if (GEMINI_MODELS.indexOf(model)===GEMINI_MODELS.length-1) throw e;
    }
  }
  throw new Error('All Gemini models failed');
}

async function runMacro(ctx) {
  const raw = await callGemini(`Eres estratega macro senior de hedge fund. Responde SOLO en JSON sin markdown:
{"regimeNarrative":"<3 frases sobre el regimen macro actual>","macroValidation":"<2 frases sobre coherencia de senales>","btcCycleSummary":"<2 frases sobre ciclo BTC>"}

${macroSummary(ctx)}`, 400);
  return JSON.parse(raw);
}

async function runElliott(ctx) {
  const raw = await callGemini(`Eres analista tecnico de ciclos crypto. Responde SOLO en JSON sin markdown:
{"elliottAnalysis":"<3 frases sobre Elliott y proyeccion>","rebalanceAdvice":"<2 frases de rebalanceo concreto>","contradictionAnalysis":"<2 frases sobre senales contradictorias>"}

${macroSummary(ctx)}`, 400);
  return JSON.parse(raw);
}

async function runSentinel(ctx) {
  const bsAlert = (ctx.vix??0)>35&&(ctx.creditSpread??0)>6 || (ctx.mvrv??0)>7;
  const raw = await callGemini(`Eres analista de riesgo sistemico. Responde SOLO en JSON sin markdown:
{"marketSentiment":"<2 frases del sentimiento actual>","topNarratives":["narrativa1","narrativa2","narrativa3"],"blackSwanAlert":${bsAlert},"blackSwanReason":${bsAlert?'"<describe riesgo>"':'null'}}

${macroSummary(ctx)}`, 400);
  return JSON.parse(raw);
}

Deno.serve(async (req) => {
  if (req.method==='OPTIONS') return new Response(null,{headers:corsHeaders});

  let ctx;
  try { ctx = await req.json(); }
  catch { return new Response(JSON.stringify({error:'Invalid JSON'}),{status:400,headers:{...corsHeaders,'Content-Type':'application/json'}}); }

  const hash = ctxHash(ctx);
  const now = Date.now();
  if (cache && cache.expiresAt>now && cache.hash===hash) {
    return new Response(JSON.stringify({...cache.result,cacheHit:true}),{headers:{...corsHeaders,'Content-Type':'application/json'}});
  }

  if (!GEMINI_KEY) {
    return new Response(JSON.stringify({
      gemini:{error:'GEMINI_API_KEY no configurada en Supabase Secrets'},
      claude:null, grok:null,
      fetchedAt:new Date().toISOString(), cacheHit:false,
    }),{headers:{...corsHeaders,'Content-Type':'application/json'}});
  }

  const [r1,r2,r3] = await Promise.allSettled([runMacro(ctx),runElliott(ctx),runSentinel(ctx)]);
  const ts = new Date().toISOString();

  const gemini = r1.status==='fulfilled'
    ? {...r1.value, model:'gemini-2.0-flash', cachedAt:ts}
    : {error:String(r1.reason).slice(0,200), model:'gemini', cachedAt:ts};

  const claude = r2.status==='fulfilled'
    ? {...r2.value, model:'gemini-2.0-flash (Elliott)', cachedAt:ts}
    : {error:String(r2.reason).slice(0,200), model:'gemini', cachedAt:ts};

  const grok = r3.status==='fulfilled'
    ? {...r3.value, model:'gemini-2.0-flash (Sentinel)', cachedAt:ts}
    : {marketSentiment:'', topNarratives:[], blackSwanAlert:false, blackSwanReason:null, error:String(r3.reason).slice(0,200), model:'gemini', cachedAt:ts};

  const output = {gemini, claude, grok, fetchedAt:ts, cacheHit:false};
  cache = {result:output, hash, expiresAt:now+CACHE_TTL};

  return new Response(JSON.stringify(output),{headers:{...corsHeaders,'Content-Type':'application/json'}});
});
