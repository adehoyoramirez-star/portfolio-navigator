export const ASSETS = [
  "BTC-EUR",
  "EMXC.DE",
  "IS3Q.DE",
  "PPFB.DE",
  "URNU.DE",
  "VVSM.DE",
  "ZPRR.DE"
] as const;

export type Asset = typeof ASSETS[number];

export const SECTOR_MAP: Record<Asset, string> = {
  "BTC-EUR": "crypto",
  "EMXC.DE": "emerging",
  "IS3Q.DE": "equity",    // FIX BUG-SECTOR-IS3Q: era "emerging" — IS3Q es MSCI World Momentum (mercados DESARROLLADOS, no emergentes)
  "PPFB.DE": "gold",
  "URNU.DE": "uranium",
  "VVSM.DE": "semis",
  "ZPRR.DE": "real_estate"
};

export const SECTOR_CAP = 0.35;
export const TARGET_GOAL = 150000;
export const DEFAULT_MONTHLY = 400;
export const STRUCTURAL_RESERVE_PCT = 0.08;
export const DEFAULT_POSITIONS = {
  "BTC-EUR": { shares: 0.031285, avgPrice: 88010.99 },
  "EMXC.DE": { shares: 31, avgPrice: 28.93 },
  "IS3Q.DE": { shares: 26, avgPrice: 67.53 },
  "PPFB.DE": { shares: 4, avgPrice: 69.39 },
  "URNU.DE": { shares: 13, avgPrice: 26.48 },
  "VVSM.DE": { shares: 2, avgPrice: 52.01 },
  "ZPRR.DE": { shares: 6, avgPrice: 61.67 }
};