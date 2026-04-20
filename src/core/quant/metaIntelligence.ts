// ============================================================
// src/core/quant/metaIntelligence.ts
// Meta-inteligencia: aprende qué señales funcionan mejor
// Trackea el historial de predicciones vs resultados reales
// Ajusta los pesos de los factores automáticamente con el tiempo
// ============================================================

import type { TacticalPosition } from '../tactical/types';

export interface SignalRecord {
  signalType:   string;
  ticker:       string;
  entryDate:    string;
  exitDate:     string | null;
  pnlPct:       number | null;
  won:          boolean | null;
  regime:       string;
  factorScore:  number;
}

export interface SignalStats {
  signalType:   string;
  totalTrades:  number;
  wins:         number;
  losses:       number;
  winRate:      number;
  avgPnLPct:    number;
  profitFactor: number;
  bestRegime:   string;
  avgFactorScore: number;
  // Ajuste de peso sugerido
  suggestedWeightAdj: number;  // -0.3 a +0.3
}

// ── Construir registros desde posiciones cerradas ─────────────
export function buildSignalRecords(
  positions: TacticalPosition[]
): SignalRecord[] {
  return positions
    .filter(p => p.exitDate !== null && p.realizedPnL !== null)
    .map(p => ({
      signalType:  p.type,
      ticker:      p.ticker,
      entryDate:   p.entryDate,
      exitDate:    p.exitDate,
      pnlPct:      p.realizedPnLPct,
      won:         (p.realizedPnL ?? 0) > 0,
      regime:      'UNKNOWN', // Se puede enriquecer si se guarda el régimen al abrir
      factorScore: 0,
    }));
}

// ── Calcular estadísticas por tipo de señal ───────────────────
export function calcSignalStats(records: SignalRecord[]): SignalStats[] {
  const byType: Record<string, SignalRecord[]> = {};
  records.forEach(r => {
    if (!byType[r.signalType]) byType[r.signalType] = [];
    byType[r.signalType].push(r);
  });

  return Object.entries(byType).map(([type, recs]) => {
    const closed  = recs.filter(r => r.won !== null);
    const wins    = closed.filter(r => r.won).length;
    const losses  = closed.length - wins;
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
    const avgPnL  = closed.length > 0
      ? closed.reduce((s, r) => s + (r.pnlPct ?? 0), 0) / closed.length
      : 0;

    const sumWins   = closed.filter(r => r.won).reduce((s, r) => s + (r.pnlPct ?? 0), 0);
    const sumLosses = Math.abs(closed.filter(r => !r.won).reduce((s, r) => s + (r.pnlPct ?? 0), 0));
    const profitFactor = sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? 99 : 1;

    // Régimen con mejor performance
    const byRegime: Record<string, number[]> = {};
    recs.forEach(r => {
      if (!byRegime[r.regime]) byRegime[r.regime] = [];
      if (r.pnlPct !== null) byRegime[r.regime].push(r.pnlPct);
    });
    const bestRegime = Object.entries(byRegime)
      .map(([reg, pnls]) => ({ reg, avg: pnls.reduce((a, b) => a + b, 0) / pnls.length }))
      .sort((a, b) => b.avg - a.avg)[0]?.reg ?? 'UNKNOWN';

    // Ajuste de peso sugerido: señales con WR > 60% merecen más peso
    const suggestedWeightAdj = winRate > 60 ? 0.15 : winRate < 40 ? -0.20 : 0;

    return {
      signalType: type, totalTrades: closed.length,
      wins, losses, winRate, avgPnLPct: avgPnL,
      profitFactor, bestRegime,
      avgFactorScore: recs.reduce((s, r) => s + r.factorScore, 0) / recs.length,
      suggestedWeightAdj,
    };
  });
}

// ── Expectancy del sistema ────────────────────────────────────
export function calcSystemExpectancy(records: SignalRecord[]): {
  expectancy: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
} {
  const closed  = records.filter(r => r.won !== null && r.pnlPct !== null);
  if (closed.length === 0) return { expectancy: 0, winRate: 0, avgWin: 0, avgLoss: 0 };

  const wins    = closed.filter(r => r.won);
  const losses  = closed.filter(r => !r.won);
  const winRate = (wins.length / closed.length) * 100;
  const avgWin  = wins.length > 0 ? wins.reduce((s, r) => s + (r.pnlPct ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + (r.pnlPct ?? 0), 0) / losses.length) : 0;
  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;
  return { expectancy, winRate, avgWin, avgLoss };
}

// ── Persistencia en localStorage ─────────────────────────────
const META_KEY = 'olympus_meta_intelligence';
export function saveMetaStats(stats: SignalStats[]): void {
  try { localStorage.setItem(META_KEY, JSON.stringify({ stats, updatedAt: new Date().toISOString() })); } catch {}
}
export function loadMetaStats(): SignalStats[] | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as { stats: SignalStats[] }).stats : null;
  } catch { return null; }
}
