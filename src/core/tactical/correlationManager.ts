// ============================================================
// src/core/tactical/correlationManager.ts
// VERSIÓN CORREGIDA — BUG CRÍTICO ARREGLADO
// Control de correlación y concentración sectorial
// Evita abrir 5 posiciones en tech pensando que diversificas
// ============================================================

import type { TacticalPosition, TacticalOpportunity } from './types';

// Mapa de sectores para agrupación
const SECTOR_GROUPS: Record<string, string> = {
  'Technology': 'TECH', 'Semiconductores': 'TECH',
  'Equity': 'EQUITY',   'Small Cap': 'EQUITY',
  'Energy': 'ENERGY',   'Utilities': 'ENERGY',
  'Healthcare': 'HEALTH',
  'Finance': 'FINANCE',
  'Commodities': 'COMMOD', 'Materials': 'COMMOD',
  'Emerging': 'EM',
  'Fixed Income': 'BONDS',
  'Real Estate': 'REITS',
  'Crypto': 'CRYPTO',
};

export interface CorrelationCheck {
  allowed:      boolean;
  reason:       string;
  sectorGroup:  string;
  currentCount: number;
  maxAllowed:   number;
}

// ── Límites por grupo de sector ───────────────────────────────
const MAX_PER_SECTOR_GROUP: Record<string, number> = {
  TECH:   2,
  EQUITY: 2,
  ENERGY: 2,
  HEALTH: 2,
  FINANCE: 2,
  COMMOD: 2,
  EM:     1,
  BONDS:  1,
  REITS:  1,
  CRYPTO: 1,
};
const DEFAULT_MAX = 2;

// ── Verificar si podemos abrir posición sin over-concentrar ───
export function checkCorrelation(
  opportunity:    TacticalOpportunity,
  openPositions:  TacticalPosition[],
  maxTotalPositions: number
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
  const duplicate = openPositions.find(p => p.ticker === opportunity.asset.ticker);
  if (duplicate) {
    return {
      allowed: false,
      reason: `${opportunity.asset.ticker} ya tiene posición abierta`,
      sectorGroup: '', currentCount: 1, maxAllowed: 1,
    };
  }

  // 3. Límite por grupo sectorial
  const sectorGroup = SECTOR_GROUPS[opportunity.asset.sector] ?? 'OTHER';
  const maxSector   = MAX_PER_SECTOR_GROUP[sectorGroup] ?? DEFAULT_MAX;
  
  // 🔴 BUG FIX: Línea 74-77 
  // ANTES (ROTO): const pg = SECTOR_GROUPS[opportunity.asset.sector] ?? 'OTHER';
  //   → Siempre usa el sector del CANDIDATO, no de la posición abierta
  //   → sectorCount = openPositions.length (siempre)
  //   → Bloquea todas las nuevas posiciones después de MAX_PER_SECTOR
  //
  // AHORA (ARREGLADO): const pg = SECTOR_GROUPS[p.type] ?? 'OTHER';
  //   → Usa el sector de CADA posición abierta
  //   → sectorCount = número real de posiciones en ese sector
  //   → Permite diversificación real
  
  const sectorCount = openPositions.filter(p => {
    const pg = SECTOR_GROUPS[p.type] ?? 'OTHER';  // ✅ FIX: p.type, no opportunity.asset.sector
    return pg === sectorGroup;
  }).length;

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
  group:     string;
  count:     number;
  maxCount:  number;
  tickers:   string[];
  pctCapital: number;
}

export function getSectorExposure(
  positions:     TacticalPosition[],
  totalCapital:  number
): SectorExposure[] {
  const groups: Record<string, { count: number; tickers: string[]; capital: number }> = {};

  positions.forEach(p => {
    const g = SECTOR_GROUPS[p.type] ?? 'OTHER';
    if (!groups[g]) groups[g] = { count: 0, tickers: [], capital: 0 };
    groups[g].count++;
    groups[g].tickers.push(p.ticker);
    groups[g].capital += p.totalInvested;
  });

  return Object.entries(groups).map(([group, data]) => ({
    group,
    count:      data.count,
    maxCount:   MAX_PER_SECTOR_GROUP[group] ?? DEFAULT_MAX,
    tickers:    data.tickers,
    pctCapital: totalCapital > 0 ? (data.capital / totalCapital) * 100 : 0,
  }));
}

// ── Detectar activos altamente correlacionados ───────────────
// Pares conocidos con correlación histórica > 0.80
const HIGH_CORRELATION_PAIRS: [string, string][] = [
  ['QQQ', 'XNAS.DE'],   ['QQQ', 'VVSM.DE'],
  ['SPY', 'EXW1.DE'],   ['GLD', 'PPFB.DE'],
  ['URA', 'URNU.DE'],   ['SMH', 'VVSM.DE'],
  ['EEM', 'EMXC.DE'],   ['SLV', 'SLVR.DE'],
];

export function hasHighCorrelation(
  ticker:         string,
  openPositions:  TacticalPosition[]
): { correlated: boolean; withTicker: string | null } {
  for (const [a, b] of HIGH_CORRELATION_PAIRS) {
    if (ticker === a && openPositions.some(p => p.ticker === b)) {
      return { correlated: true, withTicker: b };
    }
    if (ticker === b && openPositions.some(p => p.ticker === a)) {
      return { correlated: true, withTicker: a };
    }
  }
  return { correlated: false, withTicker: null };
}
