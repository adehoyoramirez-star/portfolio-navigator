// ============================================================
// src/core/tactical/aiNarrative.ts
// AI Narrative Overlay — reglas determinísticas locales
//
// ¿Qué hace?
//   Una vez por scan, analiza datos de mercado para extraer
//   sesgos sectoriales usando reglas determinísticas (sin APIs externas).
//   Ajusta el qualityScore de cada activo según narrativas detectadas.
//
// Sin dependencia de APIs externas. El sistema funciona 100% offline.
// ============================================================

import type { TacticalAsset } from './types';
import { fetchAIIntelligence } from '@/lib/directApis';

// ── Mapa de palabras/sectores que buscamos en narrativas ─────
// Cada entrada tiene: palabras clave, sector a ajustar, dirección
// del sesgo (+1 alcista, -1 bajista)
const NARRATIVE_KEYWORDS: {
  keywords: string[];
  sector: string;
  direction: 1 | -1;
  weight: number;
}[] = [
  { keywords: ['tech', 'technology', 'semiconductor', 'AI', 'artificial intelligence', 'NVIDIA', 'AAPL'], sector: 'Technology', direction: 1, weight: 2 },
  { keywords: ['REIT', 'real estate', 'yields', 'bonds', 'interest rates', 'housing'], sector: 'Real Estate', direction: -1, weight: 2 },
  { keywords: ['oil', 'energy', 'crude', 'gas', 'OPEC', 'Brent'], sector: 'Energy', direction: 1, weight: 2 },
  { keywords: ['bank', 'banking', 'finance', 'financial', 'Fed', 'interest rate cut', 'rate hike'], sector: 'Finance', direction: 1, weight: 2 },
  { keywords: ['healthcare', 'health', 'pharma', 'biotech', 'drug'], sector: 'Healthcare', direction: 1, weight: 1 },
  { keywords: ['consumer', 'retail', 'spending', 'inflation', 'CPI'], sector: 'Consumer', direction: -1, weight: 1 },
  { keywords: ['commodities', 'gold', 'silver', 'copper', 'metals'], sector: 'Commodities', direction: 1, weight: 1 },
  { keywords: ['crypto', 'bitcoin', 'BTC', 'blockchain', 'regulation crypto'], sector: 'Crypto', direction: 1, weight: 2 },
  { keywords: ['crash', 'correction', 'bear market', 'risk-off', 'recession'], sector: '__MARKET_WIDE__', direction: -1, weight: 3 },
  { keywords: ['bull', 'rally', 'risk-on', 'optimism', 'recovery'], sector: '__MARKET_WIDE__', direction: 1, weight: 2 },
  { keywords: ['emerging markets', 'EM', 'China', 'Asia', 'developing'], sector: 'Emerging', direction: 1, weight: 1 },
  { keywords: ['defensive', 'bonds', 'Treasury', 'safe haven', 'flight to quality'], sector: 'Utilities', direction: 1, weight: 1 },
  { keywords: ['supply chain', 'shortage', 'shipping', 'logistics'], sector: 'Industrials', direction: -1, weight: 1 },
  { keywords: ['defense', 'military', 'aerospace', 'space'], sector: 'Industrials', direction: 1, weight: 2 },
];

let _narrativeCache: {
  sectorBiases: Record<string, number>;
  marketWideBias: number;
  marketSentiment: string;
  topNarratives: string[];
  fetchedAt: string;
  expiresAt: number;
} | null = null;

const NARRATIVE_CACHE_TTL = 15 * 60 * 1000;

function parseNarrativesToBiases(narratives: string[]): {
  sectorBiases: Record<string, number>;
  marketWideBias: number;
} {
  const sectorBiases: Record<string, number> = {};
  let marketWideBias = 0;

  for (const narrative of narratives) {
    const lower = narrative.toLowerCase();
    for (const rule of NARRATIVE_KEYWORDS) {
      const found = rule.keywords.some(kw => lower.includes(kw));
      if (!found) continue;
      const biasDelta = rule.direction * rule.weight * 5;
      if (rule.sector === '__MARKET_WIDE__') {
        marketWideBias += biasDelta;
      } else {
        sectorBiases[rule.sector] = (sectorBiases[rule.sector] ?? 0) + biasDelta;
      }
    }
  }

  for (const sector of Object.keys(sectorBiases)) {
    sectorBiases[sector] = Math.max(-30, Math.min(30, sectorBiases[sector]));
  }
  marketWideBias = Math.max(-30, Math.min(30, marketWideBias));

  return { sectorBiases, marketWideBias };
}

export async function fetchSectorNarrative(
  marketContext: {
    regime: string;
    vix: number;
    spyPrice?: number;
  },
): Promise<{
  sectorBiases: Record<string, number>;
  marketWideBias: number;
  marketSentiment: string;
  topNarratives: string[];
  narrativeActive: boolean;
}> {
  const now = Date.now();
  if (_narrativeCache && _narrativeCache.expiresAt > now) {
    return {
      sectorBiases: _narrativeCache.sectorBiases,
      marketWideBias: _narrativeCache.marketWideBias,
      marketSentiment: _narrativeCache.marketSentiment,
      topNarratives: _narrativeCache.topNarratives,
      narrativeActive: true,
    };
  }

  try {
    const data = await fetchAIIntelligence({
      regime: marketContext.regime,
      vix: marketContext.vix,
      btcPrice: 0,
      btcRsi: 50,
      btcDominance: 0,
      mvrv: 0,
      fearGreed: 50,
      fearGreedLabel: 'NEUTRAL',
      regimePenalty: 0,
      probCrisis: 0,
      move: 0,
      bond10y: 0,
      bond2y: 0,
      creditSpread: 0,
      m2Growth: 0,
      dxy: 0,
      brent: 0,
    });

    if (!data || data.ai?.error) {
      console.warn('[AINarrative] Motor AI offline:', data?.ai?.error ?? 'sin datos');
      return emptyNarrativeResponse();
    }

    const narratives: string[] = data.ai?.topNarratives ?? [];
    const marketSentiment: string = data.ai?.marketSentiment ?? '';

    const { sectorBiases, marketWideBias } = parseNarrativesToBiases(narratives);

    _narrativeCache = {
      sectorBiases,
      marketWideBias,
      marketSentiment: marketSentiment.slice(0, 200),
      topNarratives: narratives,
      fetchedAt: new Date().toISOString(),
      expiresAt: now + NARRATIVE_CACHE_TTL,
    };

    const activeSectors = Object.entries(sectorBiases)
      .filter(([, bias]) => Math.abs(bias) >= 5)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([s, b]) => `${s}:${b > 0 ? '+' : ''}${b}`)
      .join(', ');

    if (activeSectors) {
      console.log(
        `[AINarrative] Sesgos: ${activeSectors}` +
        `${marketWideBias !== 0 ? ` | Market: ${marketWideBias > 0 ? '+' : ''}${marketWideBias}` : ''}` +
        ` | Narrativas: ${narratives.join(' | ')}`
      );
    }

    return {
      sectorBiases,
      marketWideBias,
      marketSentiment: marketSentiment.slice(0, 200),
      topNarratives: narratives,
      narrativeActive: true,
    };
  } catch (err: any) {
    console.warn('[AINarrative] Exception:', err?.message ?? err);
    return emptyNarrativeResponse();
  }
}

function emptyNarrativeResponse() {
  return {
    sectorBiases: {} as Record<string, number>,
    marketWideBias: 0,
    marketSentiment: '',
    topNarratives: [] as string[],
    narrativeActive: false,
  };
}

export function applyNarrativeBias(
  asset: TacticalAsset,
  sectorBiases: Record<string, number>,
  marketWideBias: number,
): void {
  if (asset.qualityScore == null) asset.qualityScore = 50;
  const sectorBias = sectorBiases[asset.sector] ?? 0;
  const totalBias = sectorBias + marketWideBias;
  if (totalBias === 0) return;
  asset.qualityScore = Math.max(0, Math.min(100, asset.qualityScore + totalBias));
}

export function clearNarrativeCache(): void {
  _narrativeCache = null;
}
