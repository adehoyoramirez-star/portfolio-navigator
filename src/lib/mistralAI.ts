// ===============================================
// ARCHIVO: src/lib/mistralAI.ts
// MOTOR DE IA CON MISTRAL CLOUD
// ===============================================
// Reemplaza Ollama local por Mistral Cloud API
// Modelos disponibles:
//   - mistral-large-latest: Máxima capacidad (razonamiento complejo)
//   - mistral-medium-latest: Equilibrio calidad/precio
//   - open-mistral-7b: Rápido y económico
// ===============================================

export interface MistralIntelligence {
  regimeNarrative: string;
  macroValidation: string;
  btcCycleSummary: string;
  elliottAnalysis: string;
  rebalanceAdvice: string;
  contradictionAnalysis: string;
  marketSentiment: string;
  topNarratives: string[];
  blackSwanAlert: boolean;
  blackSwanReason: string | null;
  model: string;
  cachedAt: string;
  error?: string;
  /** Indica que el resultado proviene de caché, no de una llamada API fresca */
  cacheHit?: boolean;
}

export interface MistralConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_CONFIG: MistralConfig = {
  apiKey: '', // Se debe configurar en .env.local como VITE_MISTRAL_API_KEY
  model: 'mistral-medium-latest',
  temperature: 0.2,
  maxTokens: 500,
};

// Caché en memoria (15 minutos TTL)
const cacheRef: { hash: string; result: MistralIntelligence; expiresAt: number } = {
  hash: '',
  result: {} as MistralIntelligence,
  expiresAt: 0,
};
const CACHE_TTL = 15 * 60 * 1000;

/**
 * Llama a la API de Mistral Cloud
 */
async function callMistralAPI(
  systemPrompt: string,
  userContent: string,
  config: MistralConfig
): Promise<string> {
  const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

  const response = await fetch(MISTRAL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'mistral-medium-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: config.temperature || 0.2,
      max_tokens: config.maxTokens || 500,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Mistral API ${response.status}: ${errorText}`);
  }

  const json = await response.json();
  return json.choices?.[0]?.message?.content ?? '';
}

/**
 * Parsea respuesta JSON de Mistral (puede incluir markdown)
 */
function parseMistralResponse(text: string): Record<string, any> {
  // Extraer JSON del texto — Mistral puede añadir texto antes/después
  const match = text.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : text;

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Intentar limpiar markdown fences
    const cleaned = text.replace(/```json[\s\S]*?```|```[\s\S]*?```/g, '').trim();
    const match2 = cleaned.match(/\{[\s\S]*\}/);
    if (match2) {
      try {
        return JSON.parse(match2[0]);
      } catch {
        throw new Error(`JSON parse error: ${cleaned.slice(0, 100)}`);
      }
    }
    throw new Error(`JSON parse error: ${text.slice(0, 100)}`);
  }
}

/**
 * Genera contexto para los prompts de IA
 */
function buildContext(data: {
  regime: string;
  regimePenalty: number;
  crisisProb: number;
  vix: number;
  moveIndex: number;
  bond10y: number;
  bond2y: number;
  creditSpread: number;
  m2Growth: number;
  dxy: number;
  wtiOil: number;
  btcPrice: number;
  btcRsiWeekly: number;
  btcDominance: number;
  mvrvRatio: number;
  fearGreedValue: number;
  portfolioValue: number;
  portfolioVol: number;
  portfolioDrawdown: number;
  expectedReturn: number;
  elliottWave?: string;
  hashRibbonState?: string;
  puellMultiple?: number;
  contradictions: string[];
}): string {
  const ts = new Date().toISOString().slice(0, 10);

  return `FECHA: ${ts}
RÉGIMEN: ${data.regime} | penalty=${(data.regimePenalty * 100).toFixed(0)}% | P(crisis)=${(data.crisisProb * 100).toFixed(0)}%
MACRO: VIX=${data.vix.toFixed(1)} MOVE=${data.moveIndex.toFixed(0)} Bond10y=${data.bond10y.toFixed(2)}% Bond2y=${data.bond2y.toFixed(2)}% CreditSpread=${data.creditSpread.toFixed(2)}% M2=${data.m2Growth.toFixed(1)}% DXY=${data.dxy.toFixed(1)} Brent=$${data.wtiOil.toFixed(0)}
CRYPTO: BTC=€${data.btcPrice.toFixed(0)} RSI_semanal=${data.btcRsiWeekly.toFixed(0)} DOM=${data.btcDominance.toFixed(1)}% MVRV=${data.mvrvRatio.toFixed(2)} FearGreed=${data.fearGreedValue}/50
PORTFOLIO: €${data.portfolioValue.toFixed(0)} vol=${(data.portfolioVol * 100).toFixed(1)}% drawdown=${(data.portfolioDrawdown * 100).toFixed(1)}% mu=${(Math.min(0.25, data.expectedReturn) * 100).toFixed(1)}%
ELLIOTT: Onda ${data.elliottWave ?? 'N/D'} | Hash Ribbon: ${data.hashRibbonState ?? 'N/D'} | Puell: ${(data.puellMultiple ?? 0).toFixed(2)}
${data.contradictions.length > 0 ? 'CONTRADICCIONES: ' + data.contradictions.join(' | ') : ''}`.trim();
}

/**
 * Obtiene inteligencia de IA desde Mistral Cloud
 *
 * @param apiKey - API key de Mistral (o usar VITE_MISTRAL_API_KEY)
 * @param context - Datos del mercado y portfolio
 * @param forceRefresh - Forzar llamada a API (ignorar caché)
 */
export async function fetchMistralIntelligence(
  context: {
    regime: string;
    regimePenalty: number;
    crisisProb: number;
    vix: number;
    moveIndex: number;
    bond10y: number;
    bond2y: number;
    creditSpread: number;
    m2Growth: number;
    dxy: number;
    wtiOil: number;
    btcPrice: number;
    btcRsiWeekly: number;
    btcDominance: number;
    mvrvRatio: number;
    fearGreedValue: number;
    portfolioValue: number;
    portfolioVol: number;
    portfolioDrawdown: number;
    expectedReturn: number;
    elliottWave?: string;
    hashRibbonState?: string;
    puellMultiple?: number;
    contradictions: string[];
  },
  apiKey?: string,
  forceRefresh: boolean = false
): Promise<MistralIntelligence> {
  const config = {
    ...DEFAULT_CONFIG,
    apiKey: apiKey || import.meta.env.VITE_MISTRAL_API_KEY || '',
  };

  // Hash para caché
  const ctxHash = `${context.regime}-${Math.round(context.vix)}-${Math.round(context.mvrvRatio * 100)}-${Math.round(context.fearGreedValue)}`;
  const now = Date.now();

  if (!forceRefresh && cacheRef && cacheRef.hash === ctxHash && cacheRef.expiresAt > now) {
    return { ...cacheRef.result, cacheHit: true };
  }

  const ts = new Date().toISOString();
  const ctx = buildContext(context);

  // Prompts para los 3 roles
  const macroPrompt = `Eres estratega macro senior de hedge fund institucional. Responde ÚNICAMENTE con JSON válido, sin markdown:
{"regimeNarrative":"<3 frases sobre régimen macro e implicaciones>","macroValidation":"<2 frases sobre coherencia de señales>","btcCycleSummary":"<2 frases sobre ciclo BTC y expectativas>"}`;

  const elliottPrompt = `Eres analista técnico especialista en ciclos crypto y Elliott Wave. Responde ÚNICAMENTE con JSON válido, sin markdown:
{"elliottAnalysis":"<3 frases sobre onda actual y proyección>","rebalanceAdvice":"<2 frases de rebalanceo concreto>","contradictionAnalysis":"<2 frases sobre señales contradictorias>"}`;

  const bsAlert = context.vix > 35 && context.creditSpread > 6 || context.mvrvRatio > 7;
  const sentinelPrompt = `Eres analista de riesgo sistémico. Responde ÚNICAMENTE con JSON válido, sin markdown:
{"marketSentiment":"<2 frases del sentimiento>","topNarratives":["<narrativa 1>","<narrativa 2>","<narrativa 3>"],"blackSwanAlert":${bsAlert},"blackSwanReason":${bsAlert ? '"<riesgo sistémico>"' : 'null'}}`;

  try {
    // Llamar los 3 roles en paralelo
    const [r1, r2, r3] = await Promise.all([
      callMistralAPI(macroPrompt, ctx, config),
      callMistralAPI(elliottPrompt, ctx, config),
      callMistralAPI(sentinelPrompt, ctx, config),
    ]);

    const parseRole = (text: string, fallback: Record<string, any>): Record<string, any> => {
      try {
        const parsed = parseMistralResponse(text);
        return { ...parsed, model: config.model, cachedAt: ts };
      } catch {
        return { ...fallback, error: `Parse error`, model: config.model, cachedAt: ts };
      }
    };

    const gemini = parseRole(r1, { regimeNarrative: '', macroValidation: '', btcCycleSummary: '' });
    const claude = parseRole(r2, { elliottAnalysis: '', rebalanceAdvice: '', contradictionAnalysis: '' });
    const grok = parseRole(r3, { marketSentiment: '', topNarratives: [], blackSwanAlert: false, blackSwanReason: null });

    const result: MistralIntelligence = {
      regimeNarrative: gemini.regimeNarrative,
      macroValidation: gemini.macroValidation,
      btcCycleSummary: gemini.btcCycleSummary,
      elliottAnalysis: claude.elliottAnalysis,
      rebalanceAdvice: claude.rebalanceAdvice,
      contradictionAnalysis: claude.contradictionAnalysis,
      marketSentiment: grok.marketSentiment,
      topNarratives: grok.topNarratives,
      blackSwanAlert: grok.blackSwanAlert,
      blackSwanReason: grok.blackSwanReason,
      model: config.model,
      cachedAt: ts,
    };

    // Actualizar caché
    cacheRef.hash = ctxHash;
    cacheRef.result = result;
    cacheRef.expiresAt = now + CACHE_TTL;

    return result;
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    return {
      regimeNarrative: '',
      macroValidation: '',
      btcCycleSummary: '',
      elliottAnalysis: '',
      rebalanceAdvice: '',
      contradictionAnalysis: '',
      marketSentiment: '',
      topNarratives: [],
      blackSwanAlert: false,
      blackSwanReason: errMsg.includes('API') ? 'Error conectando con Mistral API' : null,
      model: config.model,
      cachedAt: ts,
      error: errMsg.slice(0, 300),
    };
  }
}

/**
 * Limpia la caché de IA
 */
export function clearMistralCache(): void {
  cacheRef.hash = '';
  cacheRef.result = null as any;
  cacheRef.expiresAt = 0;
}
