// ===============================================
// ARCHIVO: src/lib/marketDataExport.ts
// FEAT: Exportacion CSV de datos de mercado para auditoria externa.
// ===============================================

import type { MarketData } from '@/lib/marketData';
import { ASSETS } from '@/lib/constants';

export interface ExportContext {
  marketData: MarketData;
  portfolioValue: number;
  cashReserve: number;
  defensiveLiquidity: number;
  regime: string;
  allocations: { name: string; ticker: string; finalAllocation: number; price: number }[];
  shares: { ticker: string; name: string; shares: number; avgPrice: number }[];
}

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export function generateAuditCSV(ctx: ExportContext): string {
  const lines: string[] = [];
  const { marketData: md } = ctx;
  const now = new Date().toISOString();

  lines.push('# HENDE FUND - Auditoria de Datos de Mercado');
  lines.push('# Exportado: ' + now);
  lines.push('# Regimen: ' + ctx.regime);
  lines.push('');

  lines.push('=== PRECIOS ACTUALES ===');
  lines.push('Ticker,Nombre,Precio (EUR),Timestamp');
  for (const ticker of ASSETS) {
    const price = md.prices[ticker] ?? 0;
    lines.push(csvEscape(ticker) + ',' + csvEscape(ticker) + ',' + price.toFixed(2) + ',' + now.slice(0,19));
  }
  lines.push('');

  lines.push('=== RETORNOS HISTORICOS ===');
  lines.push('Ticker,Retorno 12m,Retorno 3m,Retorno 1m,Retorno Esperado (JS)');
  for (let i = 0; i < ASSETS.length; i++) {
    const ticker = ASSETS[i];
    lines.push(csvEscape(ticker) + ',' + ((md.returns12m[i] ?? 0) * 100).toFixed(2) + '%,' + ((md.returns3m[i] ?? 0) * 100).toFixed(2) + '%,' + ((md.returns1m[i] ?? 0) * 100).toFixed(2) + '%,' + ((md.expectedReturns[i] ?? 0) * 100).toFixed(2) + '%');
  }
  lines.push('');

  lines.push('=== VOLATILIDADES REALIZADAS (anualizadas) ===');
  lines.push('Ticker,Vol Realizada');
  for (let i = 0; i < ASSETS.length; i++) {
    const ticker = ASSETS[i];
    lines.push(csvEscape(ticker) + ',' + ((md.realizedVols[i] ?? 0) * 100).toFixed(2) + '%');
  }
  lines.push('');

  if (md.covMatrix.length > 0) {
    lines.push('=== MATRIZ DE COVARIANZA (anualizada) ===');
    lines.push(',' + ASSETS.map(function(t) { return csvEscape(t); }).join(','));
    for (let i = 0; i < ASSETS.length; i++) {
      const row = md.covMatrix[i] ?? [];
      lines.push(csvEscape(ASSETS[i]) + ',' + row.map(function(v) { return (v ?? 0).toFixed(6); }).join(','));
    }
    lines.push('');
  }

  lines.push('=== DATOS MACRO ===');
  lines.push('Indicador,Valor,Fuente');
  lines.push('VIX,' + md.vix.toFixed(1) + ',Yahoo Finance');
  lines.push('Bono USA 10y,' + md.tnx.toFixed(2) + '%,Yahoo Finance');
  lines.push('Bono USA 2y,' + md.irx.toFixed(2) + '%,Yahoo Finance');
  lines.push('DXY,' + md.dxy.toFixed(2) + ',Yahoo Finance');
  lines.push('Brent Crude,' + md.wtiOil.toFixed(2) + ' USD,Yahoo Finance');
  lines.push('MOVE Index,' + md.moveIndex.toFixed(1) + ',Yahoo Finance');
  lines.push('M2 Growth YoY,' + md.m2Growth.toFixed(2) + '%,' + md.m2GrowthSource);
  lines.push('Shiller CAPE,' + md.per.toFixed(2) + ',' + md.perSource);
  lines.push('Credit Spread,' + md.creditSpread.toFixed(2) + '%,' + md.creditSpreadSource);
  lines.push('Inflation Breakeven 5y,' + (md.inflationBreakeven?.toFixed(2) ?? 'N/D') + '%,' + md.inflationBESource);
  lines.push('SP500 RSI 14,' + md.sp500Rsi.toFixed(1) + ',Yahoo');
  lines.push('SP500 Momentum 12m,' + (md.sp500Momentum12m * 100).toFixed(2) + '%,Yahoo');
  lines.push('BTC RSI Weekly,' + md.btcRsiWeekly.toFixed(1) + ',Yahoo');
  lines.push('SOX RSI Weekly,' + md.soxRsiWeekly.toFixed(1) + ',Yahoo');
  lines.push('BTC Z-Score 200d,' + md.btcZScore.toFixed(2) + ',Yahoo');
  lines.push('Liquidity Score,' + md.liquidityScore.toFixed(2) + ',' + md.liquidityDataQuality);
  lines.push('Stale Data Block,' + (md.staleDataBlock ? 'TRUE (>72h)' : 'FALSE (OK)') + ',Circuit Breaker');
  lines.push('');

  lines.push('=== COMPOSICION DEL PORTFOLIO ===');
  lines.push('Ticker,Nombre,Shares,Precio Medio,Valor,Peso,Alloc Engine');
  for (const s of ctx.shares) {
    const price = md.prices[s.ticker] ?? 0;
    const value = s.shares * price;
    const weight = ctx.portfolioValue > 0 ? (value / ctx.portfolioValue) * 100 : 0;
    const alloc = ctx.allocations.find(function(a) { return a.ticker === s.ticker; })?.finalAllocation ?? 0;
    lines.push(csvEscape(s.ticker) + ',' + csvEscape(s.name) + ',' + (s.ticker === 'BTC-EUR' ? s.shares.toFixed(6) : s.shares.toFixed(2)) + ',' + s.avgPrice.toFixed(2) + ',' + value.toFixed(2) + ',' + weight.toFixed(2) + '%,' + (alloc * 100).toFixed(2) + '%');
  }
  lines.push('');

  lines.push('=== RESUMEN ===');
  lines.push('Portfolio Value (EUR),' + ctx.portfolioValue.toFixed(2));
  lines.push('Cash Reserve (EUR),' + ctx.cashReserve.toFixed(2));
  lines.push('Defensive Liquidity (EUR),' + ctx.defensiveLiquidity.toFixed(2));
  lines.push('Total (EUR),' + (ctx.portfolioValue + ctx.cashReserve + ctx.defensiveLiquidity).toFixed(2));
  lines.push('Regimen,' + csvEscape(ctx.regime));
  lines.push('Fecha Export,' + now);

  return lines.join('\n');
}

export function downloadCSV(csv: string, filename?: string): void {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename ?? 'olympus_audit_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
