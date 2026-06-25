// ===============================================
// ARCHIVO: src/lib/assetRegistry.ts
// FIX-AUDIT-R8 3.5: SINGLE SOURCE OF TRUTH para activos.
// Añadir/eliminar un activo = editar solo este archivo.
// ===============================================

export interface AssetConfig {
  ticker: string;
  name: string;
  sector: string;
  proxyUS: string;
  earningsYield: number;
  longRunPriorReturn: number;
  fallbackVol: number;
  isCrypto: boolean;
  benchmarkWeight: number;
  stressProxy: string;
}

export const ASSET_REGISTRY: AssetConfig[] = [
  { ticker: "BTC-EUR", name: "Bitcoin", sector: "crypto", proxyUS: "BTC-EUR", earningsYield: 0, longRunPriorReturn: 0.15, fallbackVol: 0.60, isCrypto: true, benchmarkWeight: 0.10, stressProxy: "BTC-EUR" },
  { ticker: "EMXC.DE", name: "Emerging Markets", sector: "emerging", proxyUS: "EEM", earningsYield: 0.05, longRunPriorReturn: 0.08, fallbackVol: 0.18, isCrypto: false, benchmarkWeight: 0.10, stressProxy: "EEM" },
  { ticker: "PPFB.DE", name: "Gold (ETC)", sector: "gold", proxyUS: "GLD", earningsYield: 0, longRunPriorReturn: 0.06, fallbackVol: 0.15, isCrypto: false, benchmarkWeight: 0.20, stressProxy: "GLD" },
  { ticker: "URNU.DE", name: "Uranium", sector: "uranium", proxyUS: "URA", earningsYield: 0.03, longRunPriorReturn: 0.10, fallbackVol: 0.35, isCrypto: false, benchmarkWeight: 0.10, stressProxy: "URA" },
  { ticker: "VVSM.DE", name: "Semiconductors", sector: "semis", proxyUS: "SMH", earningsYield: 0.04, longRunPriorReturn: 0.14, fallbackVol: 0.25, isCrypto: false, benchmarkWeight: 0.15, stressProxy: "SMH" },
  { ticker: "0P00000WLG.F", name: "Vanguard Global Stock Index", sector: "equity", proxyUS: "URTH", earningsYield: 0.05, longRunPriorReturn: 0.09, fallbackVol: 0.16, isCrypto: false, benchmarkWeight: 0.35, stressProxy: "URTH" },
];

export const ASSET_TICKERS = ASSET_REGISTRY.map(a => a.ticker) as readonly string[];

export function getAssetConfig(ticker: string): AssetConfig | undefined {
  return ASSET_REGISTRY.find(a => a.ticker === ticker);
}
export function getProxyUS(ticker: string): string {
  return getAssetConfig(ticker)?.proxyUS ?? ticker;
}
export function getEarningsYield(ticker: string): number {
  return getAssetConfig(ticker)?.earningsYield ?? 0;
}
export function getLongRunPrior(ticker: string): number {
  return getAssetConfig(ticker)?.longRunPriorReturn ?? 0.08;
}
export function getBenchmarkWeight(ticker: string): number {
  return getAssetConfig(ticker)?.benchmarkWeight ?? 0;
}
export function isAssetCrypto(ticker: string): boolean {
  return getAssetConfig(ticker)?.isCrypto ?? false;
}
