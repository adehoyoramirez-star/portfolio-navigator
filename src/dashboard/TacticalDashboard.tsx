// ============================================================
// src/components/tactical/TacticalDashboard.tsx
// Dashboard del screener táctico Olympus
// ============================================================

import React, { useState, useCallback } from 'react';
import {
  runTacticalScreener,
  calcPositionSize,
  buildIbkrOrder,
  defaultTacticalConfig,
  getScanModeCount,
  SCAN_MODE_LABELS,
  SCAN_MODE_DESCRIPTIONS,
  SCAN_MODE_TIMES,
  type ScanMode,
} from '@/core/tactical/tacticalScreener';
import type {
  TacticalOpportunity,
  ScreenerResult,
  TacticalConfig,
} from '@/core/tactical/types';

interface TacticalDashboardProps {
  supabase:           any;
  /**
   * tacticalCapital: € que el portfolio Olympus tiene reservados para el motor táctico.
   * Viene de engineState.capitalAvailable o de la configuración del usuario.
   */
  tacticalCapital:    number;
  /**
   * defensiveLiquidity: € en cash/liquidez defensiva dentro del portfolio Olympus.
   * El motor táctico solo puede usar hasta el 20% de este valor para operar,
   * para no comprometer la liquidez de cobertura del portfolio estratégico.
   */
  defensiveLiquidity: number;
}

const safeNumber = (v: any): number => {
  if (typeof v !== 'number' || !isFinite(v)) return 0;
  return v;
};

const SIGNAL_COLORS: Record<string, string> = {
  BLOOD_IN_STREETS: 'bg-red-600 text-white',
  MOMENTUM_BREAKOUT:'bg-blue-600 text-white',
  MEAN_REVERSION:   'bg-yellow-500 text-black',
  OVERSOLD_BOUNCE:  'bg-orange-500 text-white',
  SECTOR_ROTATION:  'bg-purple-500 text-white',
  EVENT_DRIVEN:     'bg-pink-500 text-white',
};

const cur = (c: string) => c === 'USD' ? '$' : c === 'GBP' ? '£' : '€';
/** Formatea número con `d` decimales (default 2) */
const fmt  = (n: number, d = 2) => n.toFixed(d);

// ════════════════════════════════════════════════════════════
// Panel de capital — explica de dónde vienen los valores
// ════════════════════════════════════════════════════════════
function CapitalPanel({
  tacticalCapital,
  defensiveLiquidity,
  config,
}: {
  tacticalCapital:    number;
  defensiveLiquidity: number;
  config:             TacticalConfig;
}) {
  const safeTac = safeNumber(tacticalCapital);
  const safeDef = safeNumber(defensiveLiquidity);
  const maxFromLiq = defensiveLiquidity * 0.20;
  const usable     = config.tacticalCapitalEur;
  const usablePct  = defensiveLiquidity > 0
    ? ((usable / defensiveLiquidity) * 100).toFixed(1)
    : '—';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-4">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Capital táctico disponible
      </p>

      <div className="grid grid-cols-3 gap-3">
        {/* Capital táctico asignado (viene del portfolio Olympus) */}
        <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-xl p-3 text-center">
          <div className="text-[10px] text-gray-400 mb-0.5">Asignado al motor</div>
          <div className="font-bold text-indigo-600 dark:text-indigo-400 text-lg tabular-nums">
            €{safeTac.toLocaleString('es-ES', { maximumFractionDigits: 0 })}
          </div>
          <div className="text-[9px] text-gray-400 mt-0.5">Capital táctico total</div>
        </div>

        {/* Liquidez defensiva del portfolio */}
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-3 text-center">
          <div className="text-[10px] text-gray-400 mb-0.5">Liquidez defensiva</div>
          <div className="font-bold text-gray-700 dark:text-gray-200 text-lg tabular-nums">
            €{safeDef.toLocaleString('es-ES', { maximumFractionDigits: 0 })}
          </div>
          <div className="text-[9px] text-gray-400 mt-0.5">Cash/bonos portfolio</div>
        </div>

        {/* Capital usable = min(liq×20%, táctico) */}
        <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-3 text-center">
          <div className="text-[10px] text-gray-400 mb-0.5">Usable ahora</div>
          <div className="font-bold text-green-600 dark:text-green-400 text-lg tabular-nums">
            €{usable.toLocaleString('es-ES', { maximumFractionDigits: 0 })}
          </div>
          <div className="text-[9px] text-gray-400 mt-0.5">
            {usablePct}% liq. · máx 20% ({`€${maxFromLiq.toFixed(0)}`})
          </div>
        </div>
      </div>

      <p className="text-[10px] text-gray-400 mt-2 text-center">
        Usable = min(liq.defensiva × 20%, capital táctico) — protege el portfolio estratégico
      </p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Tarjeta de oportunidad
// ════════════════════════════════════════════════════════════
function OpportunityCard({
  opp, rank, config, onShowIbkr,
}: {
  opp:        TacticalOpportunity;
  rank:       number;
  config:     TacticalConfig;
  onShowIbkr: (opp: TacticalOpportunity) => void;
}) {
  const { asset, score, riskReward, entryPrice, stopLoss, takeProfit1, takeProfit2 } = opp;
  const ind    = asset.indicators;
  const atrPct = ind && asset.price > 0 ? (ind.atr14 / asset.price * 100) : 0;
  const c      = cur(asset.currency);
  const sizing = calcPositionSize(config.tacticalCapitalEur, entryPrice, stopLoss, config);
  const sharesTP1 = Math.max(1, Math.floor(sizing.shares / 2));
  const sharesTP2 = Math.max(1, sizing.shares - sharesTP1);

  // Color del score: >70 verde, >50 amarillo, resto naranja
  const scoreColor = score >= 70
    ? 'text-green-600 dark:text-green-400'
    : score >= 50
      ? 'text-yellow-600 dark:text-yellow-400'
      : 'text-indigo-600 dark:text-indigo-400';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3">

      {/* Cabecera */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold text-gray-300 dark:text-gray-600">#{rank}</span>
          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-lg text-gray-900 dark:text-white">{asset.ticker}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${SIGNAL_COLORS[opp.type] ?? 'bg-gray-500 text-white'}`}>
                {opp.type.replace(/_/g,' ')}
              </span>
              <span className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-500 rounded px-1.5 py-0.5">
                {asset.type}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5 max-w-[200px] truncate">{asset.name}</p>
            <p className="text-[10px] text-gray-300 dark:text-gray-600">
              {asset.exchange} · {asset.sector}
              {asset.ibkrSymbol && (
                <span className="ml-1 text-blue-400">IBKR:{asset.ibkrSymbol}</span>
              )}
            </p>
          </div>
        </div>
        {/* Score con exactamente 2 decimales (fmt usa toFixed(2)) */}
        <div className="text-right shrink-0">
          <div className={`text-3xl font-bold tabular-nums ${scoreColor}`}>
            {fmt(score, 2)}
          </div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wider">score</div>
        </div>
      </div>

      {/* Precios: Entrada / Stop / TP1 / TP2 */}
      <div className="grid grid-cols-4 gap-1.5 text-center">
        <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-1.5">
          <div className="text-[9px] text-gray-400 mb-0.5">Entrada</div>
          <div className="font-semibold text-xs text-gray-900 dark:text-white tabular-nums">{c}{fmt(entryPrice)}</div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-1.5">
          <div className="text-[9px] text-gray-400 mb-0.5">Stop</div>
          <div className="font-semibold text-xs text-red-600 dark:text-red-400 tabular-nums">{c}{fmt(stopLoss)}</div>
        </div>
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-1.5">
          <div className="text-[9px] text-gray-400 mb-0.5">TP1 50%</div>
          <div className="font-semibold text-xs text-green-600 dark:text-green-400 tabular-nums">{c}{fmt(takeProfit1)}</div>
        </div>
        <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-1.5">
          <div className="text-[9px] text-gray-400 mb-0.5">TP2 50%</div>
          <div className="font-semibold text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">{c}{fmt(takeProfit2)}</div>
        </div>
      </div>

      {/* Métricas técnicas */}
      <div className="grid grid-cols-5 gap-1 text-center text-xs">
        {[
          {
            label: 'R:R',
            val:   fmt(riskReward),
            cls:   riskReward >= 2 ? 'text-green-600' : riskReward >= 1.5 ? 'text-yellow-600' : 'text-orange-500',
          },
          {
            label: 'ATR%',
            val:   atrPct > 0 ? `${fmt(atrPct)}%` : '—',
            cls:   atrPct === 0 ? 'text-red-400' : 'text-gray-700 dark:text-gray-300',
          },
          { label:'RSI2',  val: fmt(ind?.rsi2  ?? 0, 1), cls:'text-gray-700 dark:text-gray-300' },
          { label:'RSI14', val: fmt(ind?.rsi14 ?? 0, 1), cls:'text-gray-700 dark:text-gray-300' },
          {
            label: 'MA200',
            val:   ind?.aboveMA200 ? '✓' : '✗',
            cls:   ind?.aboveMA200 ? 'text-green-500' : 'text-red-400',
          },
        ].map(({ label, val, cls }) => (
          <div key={label}>
            <div className="text-[9px] text-gray-400">{label}</div>
            <div className={`font-bold tabular-nums ${cls}`}>{val}</div>
          </div>
        ))}
      </div>

      {/* Sizing con desglose TP1/TP2 */}
      {sizing.shares > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-xl p-2.5 text-xs space-y-1">
          <div className="flex justify-between">
            <span className="text-indigo-700 dark:text-indigo-300 font-semibold">
              {sizing.shares} acc. · {c}{fmt(sizing.totalInvested, 0)} invertido
            </span>
            <span className="text-red-600 font-medium">riesgo {c}{fmt(sizing.capitalRisked, 0)}</span>
          </div>
          <div className="flex justify-between text-[10px] text-gray-500">
            <span>TP1: {sharesTP1} acc. @ {c}{fmt(takeProfit1)} → +{c}{fmt((takeProfit1-entryPrice)*sharesTP1, 0)}</span>
            <span>TP2: {sharesTP2} acc. @ {c}{fmt(takeProfit2)} → +{c}{fmt((takeProfit2-entryPrice)*sharesTP2, 0)}</span>
          </div>
        </div>
      )}

      {/* Señales activas */}
      <div className="flex flex-wrap gap-1">
        {opp.activeSignals.map(s => (
          <span key={s.type} className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded px-1.5 py-0.5">
            {s.type}
          </span>
        ))}
      </div>

      <button
        onClick={() => onShowIbkr(opp)}
        className="w-full py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-bold transition-colors"
      >
        📋 Ver orden IBKR (bracket TP1 + TP2 + Stop)
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Modal orden IBKR
// ════════════════════════════════════════════════════════════
function IbkrOrderModal({
  opp, config, onClose,
}: {
  opp:     TacticalOpportunity;
  config:  TacticalConfig;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const sizing = calcPositionSize(config.tacticalCapitalEur, opp.entryPrice, opp.stopLoss, config);
  const ibkr   = buildIbkrOrder(opp, sizing.shares, 'LMT');
  const json   = JSON.stringify(ibkr, null, 2);
  const c      = cur(opp.asset.currency);
  const s      = ibkr.summary;
  const ct     = ibkr.contract as any;

  const handleCopy = () => {
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h3 className="font-bold text-lg text-gray-900 dark:text-white">
              Orden IBKR — {opp.asset.ticker}
            </h3>
            <p className="text-xs text-gray-400">{opp.asset.name} · {opp.asset.exchange}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">

          {/* Contrato IBKR */}
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 grid grid-cols-2 gap-2 text-sm">
            <div>
              <div className="text-[10px] text-gray-400">Símbolo IBKR</div>
              <div className="font-bold text-gray-900 dark:text-white">{ct.symbol}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-400">Exchange IBKR</div>
              <div className="font-bold text-gray-900 dark:text-white">{ct.exchange}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-400">Tipo instrumento</div>
              <div className="font-bold text-gray-900 dark:text-white">{ct.secType}</div>
            </div>
            <div>
              <div className="text-[10px] text-gray-400">Divisa</div>
              <div className="font-bold text-gray-900 dark:text-white">{opp.asset.currency}</div>
            </div>
          </div>

          {/* Resumen del bracket */}
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-3 space-y-2 text-sm">
            <div className="font-semibold text-gray-700 dark:text-gray-300 text-xs uppercase tracking-wider mb-1">
              Bracket completo
            </div>

            <div className="flex justify-between border-b border-gray-200 dark:border-gray-600 pb-2">
              <span className="text-gray-500">BUY {s.sharesTotal} acc. @ LMT</span>
              <span className="font-bold text-gray-900 dark:text-white">{c}{fmt(s.entryPrice)}</span>
            </div>

            <div className="flex justify-between">
              <span className="text-gray-500">SELL {s.sharesTotal} acc. — Stop</span>
              <span className="font-bold text-red-600">{c}{fmt(s.stopPrice)}</span>
            </div>

            <div className="flex justify-between">
              <span className="text-gray-500">SELL {s.sharesTP1} acc. — TP1 (50%)</span>
              <span className="font-bold text-green-600">{c}{fmt(s.tp1Price)}</span>
            </div>

            <div className="flex justify-between border-b border-gray-200 dark:border-gray-600 pb-2">
              <span className="text-gray-500">SELL {s.sharesTP2} acc. — TP2 (50%)</span>
              <span className="font-bold text-emerald-600">{c}{fmt(s.tp2Price)}</span>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2 text-center">
                <div className="text-gray-400">Riesgo máx.</div>
                <div className="font-bold text-red-600">{c}{fmt(s.maxRisk)}</div>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2 text-center">
                <div className="text-gray-400">Ganancia TP1</div>
                <div className="font-bold text-green-600">+{c}{fmt(s.maxGainTP1)}</div>
              </div>
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-2 text-center">
                <div className="text-gray-400">Ganancia TP2</div>
                <div className="font-bold text-emerald-600">+{c}{fmt(s.maxGainTP2)}</div>
              </div>
              <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-lg p-2 text-center">
                <div className="text-gray-400">R:R</div>
                <div className="font-bold text-indigo-600">{fmt(s.riskReward)}</div>
              </div>
            </div>
          </div>

          {/* Reasoning */}
          <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-xl p-3 text-xs text-gray-600 dark:text-gray-300 whitespace-pre-line leading-relaxed">
            {opp.reasoning}
          </div>

          {/* JSON completo para TWS API / IBKR Gateway */}
          <details>
            <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 font-medium select-none">
              📄 JSON completo — IBKR TWS API / Gateway
            </summary>
            <pre className="mt-2 bg-gray-900 text-green-400 rounded-xl p-3 text-[10px] overflow-x-auto leading-relaxed max-h-64">
              {json}
            </pre>
          </details>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={handleCopy}
            className="w-full py-2.5 rounded-xl font-bold text-sm transition-all bg-gray-900 hover:bg-black text-white"
          >
            {copied ? '✅ ¡Copiado!' : '📋 Copiar JSON para IBKR'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// DASHBOARD PRINCIPAL
// ════════════════════════════════════════════════════════════
export default function TacticalDashboard({
  supabase,
  tacticalCapital,
  defensiveLiquidity,
}: TacticalDashboardProps) {
  const [scanMode,   setScanMode]   = useState<ScanMode>('core');
  const [isScanning, setIsScanning] = useState(false);
  const [result,     setResult]     = useState<ScreenerResult | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [ibkrOpp,    setIbkrOpp]   = useState<TacticalOpportunity | null>(null);

  // defaultTacticalConfig calcula el capital usable como
  // min(defensiveLiquidity × 20%, tacticalCapital)
  const safeTac = safeNumber(tacticalCapital);
  const safeDef = safeNumber(defensiveLiquidity);
  const config = defaultTacticalConfig(safeTac, safeDef);

  const handleScan = useCallback(async () => {
    setIsScanning(true);
    setError(null);
    setResult(null);
    try {
      const res = await runTacticalScreener(supabase, config, scanMode);
      setResult(res);
    } catch (e: any) {
      setError(e?.message ?? 'Error desconocido durante el escaneo');
    } finally {
      setIsScanning(false);
    }
  }, [supabase, config, scanMode]);

  const opportunities = result?.opportunities ?? [];
  const topPicks      = result?.topPicks      ?? [];

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-5">

      {/* Cabecera */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">🎯 Screener Táctico</h1>
          <p className="text-xs text-gray-400">
            ETFs UCITS · IBEX35 · DAX40 · CAC40 · FTSE100 · US Stocks · IBKR ready
          </p>
        </div>
      </div>

      {/* Panel de capital — explica de dónde vienen los valores */}
      <CapitalPanel
        tacticalCapital={tacticalCapital}
        defensiveLiquidity={defensiveLiquidity}
        config={config}
      />

      {/* Selector de modo de escaneo */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-4 space-y-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Modo de escaneo
        </p>

        <div className="grid grid-cols-3 gap-2">
          {(['volatile', 'core', 'full'] as ScanMode[]).map(mode => {
            const active = scanMode === mode;
            const count  = getScanModeCount(mode);
            return (
              <button
                key={mode}
                onClick={() => setScanMode(mode)}
                disabled={isScanning}
                className={`
                  flex flex-col items-center py-3 px-2 rounded-xl font-semibold text-sm
                  transition-all border-2
                  ${active
                    ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg scale-[1.02]'
                    : 'bg-gray-50 dark:bg-gray-700 border-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600'}
                  ${isScanning ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                <span className="font-bold tracking-wide">{SCAN_MODE_LABELS[mode]}</span>
                <span className={`text-xs font-normal mt-0.5 ${active ? 'text-indigo-200' : 'text-gray-400'}`}>
                  {count} activos
                </span>
                <span className={`text-[10px] ${active ? 'text-indigo-300' : 'text-gray-300 dark:text-gray-500'}`}>
                  {SCAN_MODE_TIMES[mode]}
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-xs text-center text-gray-400">
          {SCAN_MODE_DESCRIPTIONS[scanMode]}
        </p>

        <button
          onClick={handleScan}
          disabled={isScanning}
          className={`
            w-full py-3.5 rounded-xl font-bold text-base transition-all
            ${isScanning
              ? 'bg-gray-200 dark:bg-gray-600 text-gray-400 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg hover:shadow-xl active:scale-[0.99]'}
          `}
        >
          {isScanning ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
              Escaneando {SCAN_MODE_LABELS[scanMode]} ({getScanModeCount(scanMode)} activos)…
            </span>
          ) : (
            `🔍 Iniciar escaneo ${SCAN_MODE_LABELS[scanMode]}`
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-xl p-4 text-red-700 dark:text-red-300 text-sm">
          ⚠️ {error}
        </div>
      )}

      {/* Resultados */}
      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              { label:'Analizados',    value: result.assets.length,  color:'text-gray-700 dark:text-gray-200' },
              { label:'Oportunidades', value: opportunities.length,  color:'text-indigo-600 dark:text-indigo-400' },
              { label:'Top picks',     value: topPicks.length,       color:'text-green-600 dark:text-green-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3 text-center">
                <div className={`text-3xl font-bold ${color}`}>{value}</div>
                <div className="text-xs text-gray-400 mt-0.5">{label}</div>
              </div>
            ))}
          </div>

          {topPicks.length > 0 ? (
            <>
              <h2 className="text-base font-bold text-gray-900 dark:text-white">
                ⭐ Top {topPicks.length} oportunidades
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {topPicks.map((opp, i) => (
                  <OpportunityCard
                    key={opp.id}
                    opp={opp}
                    rank={i + 1}
                    config={config}
                    onShowIbkr={setIbkrOpp}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl p-8 text-center">
              <div className="text-4xl mb-3">🔍</div>
              <p className="font-semibold text-yellow-800 dark:text-yellow-200">
                Sin oportunidades con los filtros actuales
              </p>
              <p className="text-sm text-yellow-600 dark:text-yellow-400 mt-1">
                Prueba el modo FULL o reduce minScore / minRiskReward en la configuración
              </p>
            </div>
          )}

          {opportunities.length > 5 && (
            <details>
              <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-medium select-none">
                Ver {opportunities.length - 5} oportunidades adicionales
              </summary>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {opportunities.slice(5).map((opp, i) => (
                  <OpportunityCard
                    key={opp.id}
                    opp={opp}
                    rank={i + 6}
                    config={config}
                    onShowIbkr={setIbkrOpp}
                  />
                ))}
              </div>
            </details>
          )}

          {result.errors.length > 0 && (
            <details className="text-xs text-gray-400">
              <summary className="cursor-pointer hover:text-gray-600 dark:hover:text-gray-200 select-none">
                ⚠️ {result.errors.length} activos sin datos — click para ver
              </summary>
              <ul className="mt-1 list-disc list-inside space-y-0.5 pl-2">
                {result.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {ibkrOpp && (
        <IbkrOrderModal
          opp={ibkrOpp}
          config={config}
          onClose={() => setIbkrOpp(null)}
        />
      )}
    </div>
  );
}