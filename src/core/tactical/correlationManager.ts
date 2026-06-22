// ============================================================
// src/core/tactical/correlationManager.ts — v3 ELITE
//
// CORRECCIÓN CRÍTICA v3:
//   El filtro sectorial usaba p.type (OpportunityType) como clave
//   de SECTOR_GROUPS. Las claves de SECTOR_GROUPS son strings de
//   sector ('Technology', 'Equity', ...). OpportunityType es
//   'MOMENTUM_BREAKOUT', 'BLOOD_IN_STREETS', etc. — nunca coinciden.
//   Resultado: sectorCount siempre 0 → filtro nunca activo.
//
//   FIX: TacticalPosition ahora almacena sectorGroup (string real)
//   asignado en el momento de apertura desde asset.sector.
//   checkCorrelation lee p.sectorGroup directamente, sin ningún
//   mapeo adicional que pueda fallar silenciosamente.
// ============================================================

import type { TacticalPosition, TacticalOpportunity } from './types';

// Mapa de sectores → grupos de correlación
// Fuente de verdad: estos deben coincidir con asset.sector en tacticalUniverse.ts
export const SECTOR_GROUPS: Record<string, string> = {
  'Technology':     'TECH',
  'Semiconductores':'TECH',
  'Equity':         'EQUITY',
  'Small Cap':      'EQUITY',
  'Factor':         'EQUITY',
  'Energy':         'ENERGY',
  'Utilities':      'ENERGY',
  'Healthcare':     'HEALTH',
  'Finance':        'FINANCE',
  'Commodities':    'COMMOD',
  'Materials':      'COMMOD',
  'Emerging':       'EM',
  'Emerging Bonds': 'BONDS',
  'Fixed Income':   'BONDS',
  'Real Estate':    'REITS',
  'Crypto':         'CRYPTO',
  'Consumer':       'CONSUMER',
};

// ── Límites de concentración por grupo ───────────────────────
const MAX_PER_SECTOR_GROUP: Record<string, number> = {
  TECH:     2,
  EQUITY:   2,
  ENERGY:   2,
  HEALTH:   2,
  FINANCE:  2,
  COMMOD:   2,
  EM:       1,
  BONDS:    1,
  REITS:    1,
  CRYPTO:   1,
  CONSUMER: 2,
};
const DEFAULT_MAX = 2;

export interface CorrelationCheck {
  allowed:      boolean;
  reason:       string;
  sectorGroup:  string;
  currentCount: number;
  maxAllowed:   number;
}

// ── Helper: mapear sector string a grupo ─────────────────────
// Exportado para uso en openPosition (al construir TacticalPosition)
export function getSectorGroup(sector: string): string {
  return SECTOR_GROUPS[sector] ?? 'OTHER';
}

// ── Verificar correlación antes de abrir posición ────────────
export function checkCorrelation(
  opportunity:       TacticalOpportunity,
  openPositions:     TacticalPosition[],
  maxTotalPositions: number,
): CorrelationCheck {
  // 1. Límite total de posiciones
  if (openPositions.length >= maxTotalPositions) {
    return {
      allowed: false,
      reason:  `Máximo de ${maxTotalPositions} posiciones simultáneas alcanzado`,
      sectorGroup: '', currentCount: openPositions.length, maxAllowed: maxTotalPositions,
    };
  }

  // 2. No duplicar el mismo activo
  if (openPositions.some(p => p.ticker === opportunity.asset.ticker)) {
    return {
      allowed: false,
      reason: `${opportunity.asset.ticker} ya tiene posición abierta`,
      sectorGroup: '', currentCount: 1, maxAllowed: 1,
    };
  }

  // 3. Correlación entre pares conocidos
  const corrCheck = hasHighCorrelation(opportunity.asset.ticker, openPositions);
  if (corrCheck.correlated) {
    return {
      allowed: false,
      reason: `${opportunity.asset.ticker} está altamente correlacionado con ${corrCheck.withTicker} (ρ>0.80 histórico)`,
      sectorGroup: '', currentCount: 1, maxAllowed: 1,
    };
  }

  // 4. Límite por grupo sectorial
  // FIX CRÍTICO: usar p.sectorGroup (campo en TacticalPosition) en lugar de
  // SECTOR_GROUPS[p.type] que SIEMPRE devolvía undefined porque p.type es
  // OpportunityType ('MOMENTUM_BREAKOUT', etc.) — nunca una clave de SECTOR_GROUPS.
  const sectorGroup = getSectorGroup(opportunity.asset.sector);
  const maxSector   = MAX_PER_SECTOR_GROUP[sectorGroup] ?? DEFAULT_MAX;

  const sectorCount = openPositions.filter(p => p.sectorGroup === sectorGroup).length;

  if (sectorCount >= maxSector) {
    return {
      allowed: false,
      reason:  `Sector ${sectorGroup} ya tiene ${sectorCount}/${maxSector} posiciones. Diversifica.`,
      sectorGroup, currentCount: sectorCount, maxAllowed: maxSector,
    };
  }

  return {
    allowed: true,
    reason:  `OK — ${sectorGroup}: ${sectorCount + 1}/${maxSector} posiciones`,
    sectorGroup, currentCount: sectorCount, maxAllowed: maxSector,
  };
}

// ── Resumen de exposición por sector ─────────────────────────
export interface SectorExposure {
  group:      string;
  count:      number;
  maxCount:   number;
  tickers:    string[];
  pctCapital: number;
}

export function getSectorExposure(
  positions:    TacticalPosition[],
  totalCapital: number,
): SectorExposure[] {
  const groups: Record<string, { count: number; tickers: string[]; capital: number }> = {};

  for (const p of positions) {
    // FIX: usar p.sectorGroup (almacenado al abrir), no derivar dinámicamente
    const g = p.sectorGroup || 'OTHER';
    if (!groups[g]) groups[g] = { count: 0, tickers: [], capital: 0 };
    groups[g].count++;
    groups[g].tickers.push(p.ticker);
    groups[g].capital += p.totalInvested;
  }

  return Object.entries(groups).map(([group, data]) => ({
    group,
    count:      data.count,
    maxCount:   MAX_PER_SECTOR_GROUP[group] ?? DEFAULT_MAX,
    tickers:    data.tickers,
    pctCapital: totalCapital > 0 ? (data.capital / totalCapital) * 100 : 0,
  }));
}

// ── Pares de alta correlación histórica (ρ > 0.80) ───────────
// No se gestionan por rolling correlation (no tenemos datos simultáneos).
// Lista estática basada en correlaciones históricas documentadas.
// LIMITACIÓN CONOCIDA: correlaciones son régimen-dependientes.
// En crisis, pueden subir a 0.95+ incluso entre pares "no correlados".
const HIGH_CORRELATION_PAIRS: [string, string][] = [
  ['QQQ',     '0P00000WLG.F'],
  ['QQQ',     'CNDX.AS'],
  ['QQQ',     'VVSM.DE'],
  ['SMH',     'VVSM.DE'],
  ['SPY',     'CSPX.AS'],
  ['SPY',     'IWDA.AS'],
  ['SPY',     'IWDA.L'],
  ['URTH',    'IWDA.AS'],
  ['GLD',     'PPFB.DE'],
  ['URA',     'URNU.DE'],
  ['EEM',     'EMXC.DE'],
  ['EEM',     'EIMI.AS'],
  ['CSPX.AS', 'IWDA.AS'],  // Ambos USD S&P500/World, alta correlación real
  ['CSPX.AS', 'IWDA.L'],
  ['CSP1.L',  'CSPX.AS'],
];

export function hasHighCorrelation(
  ticker:        string,
  openPositions: TacticalPosition[],
): { correlated: boolean; withTicker: string | null } {
  for (const [a, b] of HIGH_CORRELATION_PAIRS) {
    if (ticker === a && openPositions.some(p => p.ticker === b))
      return { correlated: true, withTicker: b };
    if (ticker === b && openPositions.some(p => p.ticker === a))
      return { correlated: true, withTicker: a };
  }
  return { correlated: false, withTicker: null };
}
