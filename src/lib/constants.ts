// ===============================================
// ARCHIVO: src/lib/constants.ts
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
  "XNAS.DE"
] as const;

export type Asset = typeof ASSETS[number];

export const SECTOR_MAP: Record<Asset, string> = {
  "BTC-EUR": "crypto",
  "EMXC.DE": "emerging",
  // FIX-IS3Q-SECTOR: IS3Q.DE = iShares MSCI World Quality Factor (ISIN: IE00BP3QZ601)
  // Era "equity" genérico — ahora etiquetado correctamente como "equity" (mercados desarrollados)
  // pero con factorRole = "quality" en portfolio.ts para que el factor scoring sea correcto.
  // No confundir con IS3R.DE (MSCI World Momentum Factor, ISIN IE00BP3QZ825) que es distinto.
  "IS3Q.DE": "equity",
  "PPFB.DE": "gold",
  "URNU.DE": "uranium",
  "VVSM.DE": "semis",
  // FIX-XNAS-SECTOR: era "real_estate" — INCORRECTO
  // XNAS.DE = iShares NASDAQ 100 UCITS ETF → Technology
  "XNAS.DE": "semis",  // agrupado con tech/semis para el SECTOR_CAP — si se activa, suma a IS3Q+VVSM
};

// Cap máximo por sector — si IS3Q + VVSM + XNAS superan 35%, el motor limita.
// Con IS3Q(Quality) + VVSM(Semis) + XNAS(NASDAQ): tecnología total puede ser ~46% → vigilar.
// El motor aplica SECTOR_CAP automáticamente en rebalanceos.
export const SECTOR_CAP = 0.35;
export const TARGET_GOAL = 150000;
export const DEFAULT_MONTHLY = 400;
export const STRUCTURAL_RESERVE_PCT = 0.08;

// Pesos objetivo a largo plazo — revisados para apuntar al 15% de retorno
// Ponderación actual genera ~10.4% esperado. Para el 15% anualizado:
//   BTC debe subir a 30-35% cuando el ciclo cripto sea favorable (MVRV < 1.5, Dominance > 52%).
//   El motor gestiona esto automáticamente vía smartDCA Attack Mode.
export const DEFAULT_POSITIONS = {
  "BTC-EUR": { shares: 0.031285, avgPrice: 88010.99 },
  "EMXC.DE": { shares: 31, avgPrice: 28.93 },
  "IS3Q.DE": { shares: 26, avgPrice: 67.53 },
  "PPFB.DE": { shares: 4, avgPrice: 69.39 },
  "URNU.DE": { shares: 13, avgPrice: 26.48 },
  "VVSM.DE": { shares: 2, avgPrice: 52.01 },
  "XNAS.DE": { shares: 6, avgPrice: 61.67 }
};

// ─── NOTA: IS3R.DE y IS3Q.DE — NO SON LO MISMO ────────────────────────────
// IS3Q.DE = iShares MSCI World Quality Factor (ISIN: IE00BP3QZ601)
//   → Selección: ROE alto, deuda baja, beneficios estables
//   → Comportamiento: defensivo, vol ~15%, buen compounder LP
//   → factorRole: "quality"
//
// IS3R.DE = iShares MSCI World Momentum Factor (ISIN: IE00BP3QZ825)
//   → Selección: acciones con mejor rendimiento relativo 6-12 meses
//   → Comportamiento: cíclico, sigue tendencias, vol ~18%
//   → factorRole: "momentum"
//   → *** NO es Russell 2000 — ese es ZPRR.DE o IWM (solo en USA) ***
//
// Son complementarios: Quality defiende en CONTRACTION/CRISIS,
// Momentum acelera en EXPANSION. Si añades IS3R, reducir VVSM.DE
// o XNAS.DE para no superar SECTOR_CAP 35% en tech/equity.
// ──────────────────────────────────────────────────────────────────────────
