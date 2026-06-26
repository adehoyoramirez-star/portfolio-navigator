// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// === API KEYS (Gemini eliminado Jun 2026 — usar Claude + Grok) ===
const CLAUDE_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

const GROK_KEY = Deno.env.get('XAI_API_KEY') ?? '';
const GROK_URL = 'https://api.x.ai/v1/chat/completions';

let cache: any = null;
const CACHE_TTL = 15 * 60 * 1000;

const sf = (n: number, d = 1) => (n != null && isFinite(n) ? Number(n).toFixed(d) : 'N/D');

function ctxHash(ctx: any) {
  return `${ctx.regime}-${Math.round(ctx.vix??0)}-${Math.round(ctx.btcRsi??0)}-${ctx.fearGreed??0}`;
}

function macroSummary(ctx: any) {
  return `FECHA: ${new Date().toISOString().slice(0,10)}
REGIMEN: ${ctx.regime??'N/D'} | penalty=${sf((ctx.regimePenalty??0)*100,0)}% | P(crisis)=${sf((ctx.probCrisis??0)*100,0)}%
MACRO: VIX=${sf(ctx.vix)} MOVE=${sf(ctx.move,0)} Bond10y=${sf(ctx.bond10y,2)}% Bond2y=${sf(ctx.bond2y,2)}% CreditSprd=${sf(ctx.creditSpread,2)}% M2=${sf(ctx.m2Growth)}% DXY=${sf(ctx.dxy)} Brent=$${sf(ctx.brent,0)}
CRYPTO: BTC=${sf(ctx.btcPrice,0)} RSI=${sf(ctx.btcRsi,0)} DOM=${sf(ctx.btcDominance)}% MVRV=${sf(ctx.mvrv,2)} FearGreed=${ctx.fearGreed??'N/D'}/${ctx.fearGreedLabel??'N/D'}
PORTFOLIO: EUR${sf(ctx.totalValue??0,0)} vol=${sf((ctx.portfolioVol??0)*100)}% dd=${sf((ctx.drawdown??0)*100)}% mu=${sf((ctx.muEffective??0)*100)}%
${Array.isArray(ctx.contradictions)&&ctx.contradictions.length>0?'CONTRADICCIONES: '+ctx.contradictions.join(' | '):''}`.trim();
}

async function callClaude(prompt: string, maxTokens=500) {
  if (!CLAUDE_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude: ${res.status}`);
  const json = await res.json();
  return json.content?.[0]?.text?.replace(/```json|```/g,'').trim() ?? '{}';
}

async function callGrok(prompt: string, maxTokens=500) {
  if (!GROK_KEY) throw new Error('XAI_API_KEY no configurada');
  const res = await fetch(GROK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROK_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-2-latest',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Grok: ${res.status}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.replace(/```json|```/g,'').trim() ?? '{}';
}

async function runMacro(ctx: any) {
  const prompt = `Eres estratega macro senior de hedge fund. Responde SOLO en JSON sin markdown:
{"regimeNarrative":"<3 frases sobre el regimen macro actual>","macroValidation":"<2 frases sobre coherencia de senales>","btcCycleSummary":"<2 frases sobre ciclo BTC>"}

${macroSummary(ctx)}`;

  // Claude es el motor principal de analisis macro
  try {
    const raw = await callClaude(prompt, 400);
    return JSON.parse(raw);
  } catch {
    // Sin Claude ni Gemini: devolver analisis deterministico
    return {
      regimeNarrative: `Regimen: ${ctx.regime??'N/D'}. VIX: ${sf(ctx.vix)}.`,
      macroValidation: `Datos macro limitados. VIX=${sf(ctx.vix)}, CreditSpread=${sf(ctx.creditSpread,2)}%.`,
      btcCycleSummary: `BTC RSI=${sf(ctx.btcRsi,0)}. FearGreed=${ctx.fearGreed??'N/D'}.`,
    };
  }
}

async function runElliott(ctx: any) {
  const prompt = `Eres analista tecnico de ciclos crypto. Responde SOLO en JSON sin markdown:
{"elliottAnalysis":"<3 frases sobre Elliott y proyeccion>","rebalanceAdvice":"<2 frases de rebalanceo concreto>","contradictionAnalysis":"<2 frases sobre senales contradictorias>"}

${macroSummary(ctx)}`;

  // Claude para analisis tecnico
  try {
    const raw = await callClaude(prompt, 400);
    return JSON.parse(raw);
  } catch {
    return {
      elliottAnalysis: 'Analisis Elliott no disponible sin API key.',
      rebalanceAdvice: 'Seguir asignaciones del motor Olympus V3.',
      contradictionAnalysis: 'Sin datos suficientes para analisis de contradicciones.',
    };
  }
}

async function runSentinel(ctx: any) {
  const bsAlert = (ctx.vix??0)>35&&(ctx.creditSpread??0)>6 || (ctx.mvrv??0)>7;
  const prompt = `Eres analista de riesgo sistemico. Responde SOLO en JSON sin markdown:
{"marketSentiment":"<2 frases del sentimiento actual>","topNarratives":["narrativa1","narrativa2","narrativa3"],"blackSwanAlert":${bsAlert},"blackSwanReason":${bsAlert?'"<describe riesgo>"':'null'}}

${macroSummary(ctx)}`;

  // Grok para riesgo sistemico, con fallback deterministico
  try {
    const raw = await callGrok(prompt, 400);
    return JSON.parse(raw);
  } catch {
    return {
      marketSentiment: ctx.fearGreed && ctx.fearGreed < 30 ? 'Miedo extremo' : ctx.fearGreed && ctx.fearGreed > 70 ? 'Codicia' : 'Neutral',
      topNarratives: ctx.vix > 30 ? ['Volatilidad elevada'] : ['Sin narrativas dominantes'],
      blackSwanAlert: bsAlert,
      blackSwanReason: bsAlert ? 'VIX elevado + credit spread' : null,
    };
  }
}

// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method==='OPTIONS') return new Response(null,{headers:corsHeaders});

  let ctx: any;
  try { ctx = await req.json(); }
  catch { return new Response(JSON.stringify({error:'Invalid JSON'}),{status:400,headers:{...corsHeaders,'Content-Type':'application/json'}}); }

  const hash = ctxHash(ctx);
  const now = Date.now();
  if (cache && cache.expiresAt>now && cache.hash===hash) {
    return new Response(JSON.stringify({...cache.result,cacheHit:true}),{headers:{...corsHeaders,'Content-Type':'application/json'}});
  }

  const ts = new Date().toISOString();

  // Verificar si al menos una API key esta configurada
  const hasAnyKey = !!(CLAUDE_KEY || GROK_KEY);

  if (!hasAnyKey) {
    return new Response(JSON.stringify({
      ai:{error:'Ninguna API key configurada (CLAUDE/GROK) — usando reglas deterministicas'},
      fetchedAt:ts, cacheHit:false,
    }),{headers:{...corsHeaders,'Content-Type':'application/json'}});
  }

  const [r1,r2,r3] = await Promise.allSettled([runMacro(ctx),runElliott(ctx),runSentinel(ctx)]);

  const ai = r1.status==='fulfilled'
    ? {...r1.value, model:'claude-sonnet-4-20250514', cachedAt:ts}
    : {error:String(r1.reason).slice(0,200), model:'claude', cachedAt:ts};

  const output = {ai, fetchedAt:ts, cacheHit:false};
  cache = {result:output, hash, expiresAt:now+CACHE_TTL};

  return new Response(JSON.stringify(output),{headers:{...corsHeaders,'Content-Type':'application/json'}});
});
