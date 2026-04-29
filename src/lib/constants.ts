// ===============================================
// ARCHIVO: src/lib/constants.ts
// FIX-BAYN: Bayer AG añadida a ASSETS, SECTOR_MAP y DEFAULT_POSITIONS
// FIX-IS3Q-SECTOR: IS3Q es equity DESARROLLADO, factor QUALITY
// FIX-XNAS-SECTOR: XNAS.DE es NASDAQ 100 → Technology
// FIX-PPFB-SECTOR: PPFB.DE es ETC de oro → Commodities
// ===============================================

export const ASSETS = [
  "BTC-EUR",
  "EMXC.DE",
  "IS3Q.DE",
  "PPFB.DE",
  "URNU.DE",
  "VVSM.DE",
  "XNAS.DE",
  "BAYN.DE"   // FIX-BAYN: Bayer AG — Pharma (Crop Science + Consumer Health + Pharma)
] as const;

export type Asset = typeof ASSETS[number];

export const SECTOR_MAP: Record<Asset, string> = {
  "BTC-EUR":  "crypto",
  "EMXC.DE":  "emerging",
  // IS3Q.DE = iShares MSCI World Quality Factor (ISIN: IE00BP3QZ601)
  // → ROE alto, deuda baja, beneficios estables — defensivo, vol ~15%
  "IS3Q.DE":  "equity",
  "PPFB.DE":  "gold",
  "URNU.DE":  "uranium",
  "VVSM.DE":  "semis",
  // XNAS.DE = iShares NASDAQ 100 UCITS ETF → Technology
  "XNAS.DE":  "semis",   // agrupado con tech/semis para el SECTOR_CAP
  // BAYN.DE = Bayer AG (XETRA) — Farmacéutica / Crop Science / Consumer Health
  // Ticker Yahoo Finance: BAYN.DE ✅ (funciona en Europa, incluido en índice DAX 40)
  // Sector: healthcare — no computa hacia el SECTOR_CAP de tech/equity
  "BAYN.DE":  "healthcare",
};

// Cap máximo por sector — si IS3Q + VVSM + XNAS superan 35%, el motor limita.
export const SECTOR_CAP = 0.35;
export const TARGET_GOAL = 150000;
export const DEFAULT_MONTHLY = 400;
export const STRUCTURAL_RESERVE_PCT = 0.08;

// Pesos objetivo a largo plazo
// BAYN.DE: posición táctica value — Bayer cotiza con descuento histórico
// por litigios glifosato. Upside asymétrico si se resuelve el riesgo legal.
export const DEFAULT_POSITIONS = {
  "BTC-EUR":  { shares: 0.031285, avgPrice: 88010.99 },
  "EMXC.DE":  { shares: 31,       avgPrice: 28.93 },
  "IS3Q.DE":  { shares: 26,       avgPrice: 67.53 },
  "PPFB.DE":  { shares: 4,        avgPrice: 69.39 },
  "URNU.DE":  { shares: 13,       avgPrice: 26.48 },
  "VVSM.DE":  { shares: 2,        avgPrice: 52.01 },
  "XNAS.DE":  { shares: 6,        avgPrice: 61.67 },
  "BAYN.DE":  { shares: 0,        avgPrice: 0 },  // RELLENAR con datos reales de IBKR
};

// ─── NOTA: IS3R.DE y IS3Q.DE — NO SON LO MISMO ────────────────────────────
// IS3Q.DE = iShares MSCI World Quality Factor (ISIN: IE00BP3QZ601)
//   → factorRole: "quality"
//
// IS3R.DE = iShares MSCI World Momentum Factor (ISIN: IE00BP3QZ825)
//   → factorRole: "momentum"
//   → *** NO es Russell 2000 ***
//
// Son complementarios: Quality defiende en CONTRACTION/CRISIS,
// Momentum acelera en EXPANSION.
// ──────────────────────────────────────────────────────────────────────────

// ─── NOTA: BAYN.DE — Tesis de inversión ──────────────────────────────────
// Bayer AG cotiza con descuento de ~50% vs peers farmacéuticos (2024-2025)
// por litigios glifosato (Roundup) y pipeline oncológico. 
// - P/E ~8x vs sector 20x → value extremo
// - Dividendo histórico ~6% (actualmente suspendido por deuda)
// - Factores positivos: pipeline GLP-1, Crop Science resiliente, deuda manejable
// - Riesgo principal: resolución litigios USA (probabilidad favorable ~60% según consenso)
// - Estrategia: comprar en debilidad, liquidar en recuperación parcial (target €30-35)
// ──────────────────────────────────────────────────────────────────────────
