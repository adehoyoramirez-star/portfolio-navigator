// ============================================================
// src/core/tactical/bridgeQ5Scores.ts
// Bridge: Python ML scores → TypeScript tactical module
// ============================================================

export interface Q5ScoreData {
  generatedAt: string;
  mode: string;
  modelMetrics: { ic: number; ir: number; hitRate: number };
  q5Tickers: string[];
  allScores: Record<string, {
    score: number; quintile: number; hybrid: number; signal: string; passes: boolean;
  }>;
}

const CACHE_TTL = 30 * 60 * 1000;
let _q5Cache: { data: Q5ScoreData; fetchedAt: number } | null = null;

export async function fetchQ5Scores(baseUrl?: string): Promise<Q5ScoreData | null> {
  const now = Date.now();
  if (_q5Cache && _q5Cache.fetchedAt + CACHE_TTL > now) return _q5Cache.data;
  try {
    const url = `${baseUrl ?? ''}/q5_scores.json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data: Q5ScoreData = await resp.json();
    if (!data.allScores || Object.keys(data.allScores).length === 0) return null;
    _q5Cache = { data, fetchedAt: now };
    console.log(`[Q5Bridge] ${Object.keys(data.allScores).length} tickers · ${data.q5Tickers.length} Q5`);
    return data;
  } catch {
    console.debug('[Q5Bridge] No Q5 scores (fallback a scoring propio)');
    return null;
  }
}

export function getQ5Score(ticker: string, data: Q5ScoreData | null): { mlScore: number; isQ5: boolean } | null {
  if (!data) return null;
  const e = data.allScores[ticker];
  return e ? { mlScore: e.score, isQ5: e.quintile >= 5 } : null;
}

export function applyQ5Boost(current: number, ticker: string, data: Q5ScoreData | null): number {
  const q5 = getQ5Score(ticker, data);
  if (!q5?.isQ5) return current;
  const boost = q5.mlScore >= 90 ? 20 : q5.mlScore >= 80 ? 15 : q5.mlScore >= 70 ? 10 : 5;
  return Math.min(100, current + boost);
}

export function calcExecutionScoreWithQ5(
  signalScore: number, qualityScore: number, ticker: string, data: Q5ScoreData | null
): number {
  const q5 = getQ5Score(ticker, data);
  let q5Boost = 0;
  if (q5?.isQ5) q5Boost = q5.mlScore >= 90 ? 20 : q5.mlScore >= 80 ? 15 : q5.mlScore >= 70 ? 10 : 5;
  return Math.min(100, Math.max(0, Math.round(signalScore * 0.5 + qualityScore * 0.3 + q5Boost * 0.2)));
}
