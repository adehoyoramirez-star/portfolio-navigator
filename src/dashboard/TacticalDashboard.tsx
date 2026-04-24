// ============================================================
// src/components/tactical/TacticalDashboard.tsx
// Motor Táctico Olympus — Dashboard completo con pestañas
// ============================================================

import React, { useState, useCallback, useEffect } from 'react';
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
import {
  initTacticalState,
  loadTacticalState,
  saveTacticalState,
  openPosition,
  closePosition,
  getTacticalSummary,
} from '@/core/tactical/tacticalPortfolio';
import type {
  TacticalOpportunity,
  TacticalPosition,
  ScreenerResult,
  TacticalConfig,
  TacticalEngineState,
  OpportunityStatus,
} from '@/core/tactical/types';

// ── Props ─────────────────────────────────────────────────────
interface TacticalDashboardProps {
  supabase:           any;
  tacticalCapital:    number;
  defensiveLiquidity: number;
}

// ── Helpers ───────────────────────────────────────────────────
const safeNum = (v: any): number =>
  typeof v === 'number' && isFinite(v) ? v : 0;

const cur = (c?: string) => c === 'USD' ? '$' : c === 'GBP' ? '£' : '€';

const fmt = (n: number, d = 2) => safeNum(n).toFixed(d);

const fmtEur = (n: number) =>
  safeNum(n).toLocaleString('es-ES', { maximumFractionDigits: 0 });

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
};

// ── Colores de señal ──────────────────────────────────────────
const SIGNAL_COLORS: Record<string, string> = {
  BLOOD_IN_STREETS:  'bg-red-600 text-white',
  MOMENTUM_BREAKOUT: 'bg-blue-600 text-white',
  MEAN_REVERSION:    'bg-yellow-500 text-black',
  OVERSOLD_BOUNCE:   'bg-orange-500 text-white',
  SECTOR_ROTATION:   'bg-purple-500 text-white',
  EVENT_DRIVEN:      'bg-pink-500 text-white',
};

const SIGNAL_EMOJIS: Record<string, string> = {
  BLOOD_IN_STREETS:  '🩸',
  MOMENTUM_BREAKOUT: '🚀',
  MEAN_REVERSION:    '🔄',
  OVERSOLD_BOUNCE:   '📈',
  SECTOR_ROTATION:   '🎯',
  EVENT_DRIVEN:      '⚡',
};

type Tab = 'opportunities' | 'positions' | 'history' | 'config';

// ════════════════════════════════════════════════════════════
// PANEL SUPERIOR DE MÉTRICAS
// ════════════════════════════════════════════════════════════
function MetricsBar({
  state, lastScan,
}: { state: TacticalEngineState; lastScan: string | null }) {
  const summary = getTacticalSummary(state);

  const metrics = [
    { label: 'Capital táctico',  value: `€${fmtEur(state.config.tacticalCapitalEur)}`, color: 'text-white' },
    { label: 'Disponible',       value: `€${fmtEur(summary.capitalAvailable)}`,        color: 'text-white' },
    { label: 'En posiciones',    value: `€${fmtEur(summary.capitalUsed)}`,             color: 'text-white' },
    { label: 'PnL no realizado', value: `€${fmtEur(summary.unrealizedPnL)}`,           color: summary.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400' },
    { label: 'PnL realizado',    value: `€${fmtEur(summary.realizedPnL)}`,             color: summary.realizedPnL >= 0 ? 'text-green-400' : 'text-red-400' },
    { label: 'Win rate',         value: `${fmt(summary.winRate, 0)}%`,                 color: 'text-white' },
    { label: 'Profit factor',    value: fmt(summary.profitFactor, 2),                  color: 'text-white' },
    { label: 'Posiciones',       value: `${state.openPositions.length}/${state.config.maxOpenPositions}`, color: 'text-white' },
  ];

  return (
    <div className="bg-gray-900 border-b border-gray-700">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-base font-bold text-white">⚡ Motor Táctico Olympus</span>
          {['Blood in the streets', 'Mean reversion', 'Momentum breakout'].map(s => (
            <span key={s} className="text-[10px] bg-gray-800 text-gray-500 rounded px-2 py-0.5 hidden sm:inline">
              {s}
            </span>
          ))}
        </div>
        {lastScan && (
          <span className="text-[10px] text-gray-600">
            Último scan: {new Date(lastScan).toLocaleTimeString('es-ES')}
          </span>
        )}
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-8 divide-x divide-gray-800">
        {metrics.map(m => (
          <div key={m.label} className="px-3 py-2 text-center">
            <div className={`text-sm font-bold tabular-nums ${m.color}`}>{m.value}</div>
            <div className="text-[8px] text-gray-600 mt-0.5 uppercase tracking-wide leading-tight">{m.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TARJETA DE OPORTUNIDAD
// ════════════════════════════════════════════════════════════
function OpportunityCard({
  opp, rank, config, onOpen, onIbkr, alreadyOpen,
}: {
  opp:         TacticalOpportunity;
  rank:        number;
  config:      TacticalConfig;
  onOpen:      (opp: TacticalOpportunity) => void;
  onIbkr:      (opp: TacticalOpportunity) => void;
  alreadyOpen: boolean;
}) {
  const { asset, score, riskReward, entryPrice, stopLoss, takeProfit1, takeProfit2 } = opp;
  const ind     = asset.indicators;
  const atrPct  = ind && asset.price > 0 ? (ind.atr14 / asset.price * 100) : 0;
  const c       = cur(asset.currency);
  const sizing  = calcPositionSize(safeNum(config.tacticalCapitalEur), entryPrice, stopLoss, config);

  const scoreColor =
    score >= 70 ? 'text-green-400' :
    score >= 50 ? 'text-yellow-400' : 'text-blue-400';

  const emoji = SIGNAL_EMOJIS[opp.type] ?? '📊';
  const pill  = SIGNAL_COLORS[opp.type] ?? 'bg-gray-600 text-white';

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 hover:border-gray-600 transition-colors flex flex-col gap-3">
      {/* Cabecera */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="text-gray-600 font-bold">#{rank}</span>
          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-white text-base">{asset.ticker}</span>
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${pill}`}>
                {emoji} {opp.type.replace(/_/g, ' ')}
              </span>
              <span className="text-[9px] bg-gray-700 text-gray-400 rounded px-1.5 py-0.5">
                {asset.type}
              </span>
            </div>
            <p className="text-[10px] text-gray-400 mt-0.5 max-w-[180px] truncate">{asset.name}</p>
            <p className="text-[9px] text-gray-600">{asset.exchange} · {asset.sector}</p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-2xl font-black tabular-nums ${scoreColor}`}>{fmt(score, 0)}</div>
          <div className="text-[9px] text-gray-600 uppercase tracking-wide">score</div>
        </div>
      </div>

      {/* Niveles */}
      <div className="grid grid-cols-4 gap-1 text-center">
        {[
          { label: 'Entrada', val: `${c}${fmt(entryPrice)}`, cls: 'text-white' },
          { label: 'Stop Loss', val: `${c}${fmt(stopLoss)}`, cls: 'text-red-400' },
          { label: 'TP1 (50%)', val: `${c}${fmt(takeProfit1)}`, cls: 'text-green-400' },
          { label: 'TP2 (50%)', val: `${c}${fmt(takeProfit2)}`, cls: 'text-emerald-400' },
        ].map(({ label, val, cls }) => (
          <div key={label} className="bg-gray-900 rounded-lg p-1.5">
            <div className="text-[8px] text-gray-600 mb-0.5">{label}</div>
            <div className={`font-semibold text-[11px] tabular-nums ${cls}`}>{val}</div>
          </div>
        ))}
      </div>

      {/* Ratio R:R */}
      <div className="text-center text-[10px] font-semibold">
        <span className={riskReward >= 2 ? 'text-green-400' : riskReward >= 1.5 ? 'text-yellow-400' : 'text-orange-400'}>
          R:R {fmt(riskReward, 1)}:1
        </span>
      </div>

      {/* Indicadores técnicos */}
      <div className="text-[10px] text-gray-400 space-y-0.5">
        <div>
          RSI(2)={fmt(ind?.rsi2 ?? 0, 1)} · RSI(14)={fmt(ind?.rsi14 ?? 0, 1)} · Z={fmt(ind?.zScore20 ?? 0, 2)}
          {ind?.volumeRatio && ind.volumeRatio > 1.2 && ` · Vol×${fmt(ind.volumeRatio, 1)}`}
          {atrPct > 0 ? ` · ATR=${fmt(atrPct, 1)}%` : ' · ATR=0.0%'}
        </div>
      </div>

      {/* Sizing */}
      {sizing.shares > 0 && (
        <div className="bg-gray-900/60 rounded-lg px-3 py-2 text-[10px] text-gray-400 flex justify-between">
          <span>Riesgo estimado: ~{c}{fmt(sizing.capitalRisked, 0)}</span>
          <span>Capital: ~{c}{fmt(sizing.totalInvested, 0)}</span>
        </div>
      )}

      {/* Acciones */}
      <div className="flex gap-2">
        <button
          onClick={() => onOpen(opp)}
          disabled={alreadyOpen}
          className={`flex-1 py-2 rounded-lg font-bold text-xs transition-all ${
            alreadyOpen
              ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white'
          }`}
        >
          {alreadyOpen ? '✅ En posición' : '⚡ Abrir posición'}
        </button>
        <button
          onClick={() => onIbkr(opp)}
          className="px-3 py-2 rounded-lg bg-blue-900 hover:bg-blue-800 text-blue-300 text-xs font-bold transition-colors"
        >
          IBKR
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// FILA DE POSICIÓN ABIERTA
// ════════════════════════════════════════════════════════════
function PositionRow({
  pos, onClose,
}: {
  pos:     TacticalPosition;
  onClose: (id: string, reason: OpportunityStatus) => void;
}) {
  const pnlColor = pos.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400';
  const pill     = SIGNAL_COLORS[pos.type] ?? 'bg-gray-600 text-white';
  const nearStop = pos.currentPrice <= pos.stopLoss * 1.03;
  const nearTP   = pos.currentPrice >= pos.takeProfit1 * 0.97;
  const daysLeft = Math.max(0, pos.maxDaysAllowed - pos.daysOpen);

  return (
    <div className={`bg-gray-800 border rounded-xl p-4 space-y-3 ${
      nearStop ? 'border-red-700/60' : nearTP ? 'border-green-700/60' : 'border-gray-700'
    }`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-white">{pos.ticker}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${pill}`}>
              {(SIGNAL_EMOJIS[pos.type] ?? '📊')} {pos.type.replace(/_/g, ' ')}
            </span>
            {nearStop && <span className="text-[9px] bg-red-900/60 text-red-300 rounded px-1.5 py-0.5">⚠️ NEAR STOP</span>}
            {nearTP   && <span className="text-[9px] bg-green-900/60 text-green-300 rounded px-1.5 py-0.5">🎯 NEAR TP1</span>}
          </div>
          <p className="text-[10px] text-gray-400 mt-0.5 truncate max-w-[220px]">{pos.name}</p>
          <p className="text-[9px] text-gray-600">
            {fmtDate(pos.entryDate)} · {pos.daysOpen}d abierta · {daysLeft}d restantes
          </p>
        </div>
        <div className="text-right">
          <div className={`text-xl font-black tabular-nums ${pnlColor}`}>
            {pos.unrealizedPnL >= 0 ? '+' : ''}€{fmt(pos.unrealizedPnL, 0)}
          </div>
          <div className={`text-xs font-semibold ${pnlColor}`}>
            {pos.unrealizedPnLPct >= 0 ? '+' : ''}{fmt(pos.unrealizedPnLPct, 2)}%
          </div>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1 text-center text-[10px]">
        {[
          { label: 'Entrada',   val: `€${fmt(pos.entryPrice)}`,   cls: 'text-gray-300' },
          { label: 'Actual',    val: `€${fmt(pos.currentPrice)}`, cls: pos.currentPrice >= pos.entryPrice ? 'text-green-400' : 'text-red-400' },
          { label: 'Stop',      val: `€${fmt(pos.stopLoss)}`,     cls: 'text-red-400' },
          { label: 'TP1',       val: `€${fmt(pos.takeProfit1)}`,  cls: 'text-green-400' },
          { label: 'TP2',       val: `€${fmt(pos.takeProfit2)}`,  cls: 'text-emerald-400' },
        ].map(({ label, val, cls }) => (
          <div key={label} className="bg-gray-900 rounded p-1">
            <div className="text-[8px] text-gray-600">{label}</div>
            <div className={`font-semibold tabular-nums ${cls}`}>{val}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 text-[10px] text-gray-500">
        <span>{pos.shares} acc.</span>
        <span>Inv: €{fmt(pos.totalInvested, 0)}</span>
        <span>Riesgo: €{fmt(pos.capitalRisked, 0)}</span>
      </div>

      <div className="flex gap-2">
        <button onClick={() => onClose(pos.id, 'CLOSED_TP')}
          className="flex-1 py-1.5 rounded-lg bg-green-900/60 hover:bg-green-800 text-green-300 text-[10px] font-bold transition-colors">
          🎯 TP manual
        </button>
        <button onClick={() => onClose(pos.id, 'CLOSED_SL')}
          className="flex-1 py-1.5 rounded-lg bg-red-900/60 hover:bg-red-800 text-red-300 text-[10px] font-bold transition-colors">
          🛑 Stop manual
        </button>
        <button onClick={() => onClose(pos.id, 'CLOSED_MANUAL')}
          className="flex-1 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-[10px] font-bold transition-colors">
          ✕ Cerrar
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// HISTORIAL
// ════════════════════════════════════════════════════════════
function HistoryTable({ positions }: { positions: TacticalPosition[] }) {
  if (positions.length === 0) {
    return (
      <div className="text-center py-16 text-gray-600">
        <div className="text-4xl mb-3">📋</div>
        <p className="text-sm">Sin operaciones cerradas aún</p>
      </div>
    );
  }

  const sorted = [...positions].sort(
    (a, b) => new Date(b.exitDate ?? 0).getTime() - new Date(a.exitDate ?? 0).getTime()
  );

  const reasonLabel: Record<string, string> = {
    CLOSED_TP: '🎯 TP', CLOSED_SL: '🛑 SL',
    CLOSED_TIME: '⏰ Tiempo', CLOSED_MANUAL: '✕ Manual', OPEN: '—',
  };

  const totalPnL = positions.reduce((s, p) => s + (p.realizedPnL ?? 0), 0);
  const wins     = positions.filter(p => (p.realizedPnL ?? 0) > 0).length;
  const wr       = positions.length > 0 ? (wins / positions.length * 100).toFixed(0) : '0';

  return (
    <div className="space-y-3">
      {/* Resumen */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Total operaciones', value: positions.length, color: 'text-white' },
          { label: 'Win rate', value: `${wr}%`, color: 'text-white' },
          { label: 'PnL total', value: `${totalPnL >= 0 ? '+' : ''}€${fmt(totalPnL, 0)}`, color: totalPnL >= 0 ? 'text-green-400' : 'text-red-400' },
        ].map(m => (
          <div key={m.label} className="bg-gray-800 border border-gray-700 rounded-xl p-3 text-center">
            <div className={`text-xl font-black tabular-nums ${m.color}`}>{m.value}</div>
            <div className="text-[9px] text-gray-500 mt-0.5">{m.label}</div>
          </div>
        ))}
      </div>

      {sorted.map(pos => {
        const pnl = pos.realizedPnL ?? 0;
        const pct = pos.realizedPnLPct ?? 0;
        const win = pnl > 0;
        const pill = SIGNAL_COLORS[pos.type] ?? 'bg-gray-600 text-white';
        return (
          <div key={pos.id} className={`bg-gray-800 border rounded-xl p-3 flex items-center gap-3 ${
            win ? 'border-green-900/60' : 'border-red-900/40'
          }`}>
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${win ? 'bg-green-500' : 'bg-red-500'}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-bold text-white text-sm">{pos.ticker}</span>
                <span className={`text-[8px] px-1 py-0.5 rounded font-bold ${pill}`}>
                  {pos.type.replace(/_/g, ' ')}
                </span>
                <span className="text-[9px] text-gray-500">{reasonLabel[pos.status]}</span>
              </div>
              <div className="text-[9px] text-gray-600 mt-0.5">
                {fmtDate(pos.entryDate)} → {fmtDate(pos.exitDate)} · {pos.daysOpen}d · {pos.shares} acc.
                · entrada €{fmt(pos.entryPrice)} → salida €{fmt(pos.exitPrice ?? 0)}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className={`font-black tabular-nums text-sm ${win ? 'text-green-400' : 'text-red-400'}`}>
                {pnl >= 0 ? '+' : ''}€{fmt(pnl, 0)}
              </div>
              <div className={`text-[10px] ${win ? 'text-green-500' : 'text-red-500'}`}>
                {pct >= 0 ? '+' : ''}{fmt(pct, 2)}%
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════════
function ConfigPanel({
  config, onChange, onReset,
}: {
  config:   TacticalConfig;
  onChange: (c: TacticalConfig) => void;
  onReset:  () => void;
}) {
  const [local, setLocal] = useState<TacticalConfig>(config);

  useEffect(() => { setLocal(config); }, [config]);

  const numField = (
    label: string, key: keyof TacticalConfig, step = 1, min = 0, hint?: string,
  ) => (
    <div key={key} className="flex items-center justify-between py-3 border-b border-gray-700 last:border-0">
      <div>
        <div className="text-sm text-gray-200">{label}</div>
        {hint && <div className="text-[10px] text-gray-500 mt-0.5">{hint}</div>}
      </div>
      <input
        type="number" step={step} min={min}
        value={local[key] as number}
        onChange={e => setLocal(l => ({ ...l, [key]: Number(e.target.value) }))}
        className="w-24 bg-gray-900 border border-gray-600 rounded-lg px-2 py-1.5 text-right text-sm text-white focus:border-indigo-400 outline-none tabular-nums"
      />
    </div>
  );

  const boolField = (label: string, key: keyof TacticalConfig) => (
    <div key={key} className="flex items-center justify-between py-3 border-b border-gray-700 last:border-0">
      <div className="text-sm text-gray-200">{label}</div>
      <button
        onClick={() => setLocal(l => ({ ...l, [key]: !l[key as keyof TacticalConfig] }))}
        className={`relative w-10 h-5 rounded-full transition-colors ${local[key] ? 'bg-indigo-500' : 'bg-gray-600'}`}
      >
        <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${local[key] ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Capital y riesgo</p>
        {numField('Capital táctico total (€) — máx 20% de liquidez defensiva', 'tacticalCapitalEur', 10, 0)}
        {numField('Riesgo por operación (%) — recomendado 1-2%', 'riskPerTradePct', 0.005, 0.001, 'Escribe 0.01 para 1%')}
        {numField('Máx posiciones simultáneas', 'maxOpenPositions', 1, 1)}
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Filtros de calidad</p>
        {numField('Score mínimo (0-100) — recomendado 45+', 'minScore', 5, 0)}
        {numField('Ratio riesgo/recompensa mínimo — recomendado 1.5', 'minRiskReward', 0.1, 0.5)}
        {boolField('Solo activos sobre MA200 (filtro de tendencia)', 'requireAboveMA200')}
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => onChange(local)}
          className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm transition-colors"
        >
          ✅ Aplicar configuración
        </button>
        <button
          onClick={onReset}
          className="px-4 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-gray-300 font-bold text-sm transition-colors"
        >
          🗑 Reset completo
        </button>
      </div>

      {/* Reglas */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
          📋 Reglas de operativa (no las rompas)
        </p>
        <div className="space-y-2">
          {[
            ['🔒', 'El motor táctico usa MÁXIMO el 20% de la liquidez defensiva de Olympus. El 80% restante queda para el ATTACK_MAX de octubre.'],
            ['⏰', 'Toda posición se cierra en 10 días hábiles aunque no haya llegado al TP ni al SL. El tiempo es enemigo en trading táctico.'],
            ['🚫', 'Nunca abrir una posición táctica en un activo que Olympus esté comprando ese mes para no duplicar riesgo.'],
            ['📊', 'Stop loss es SAGRADO. Si el precio llega al stop, se ejecuta sin excepción, nunca se mueve hacia abajo.'],
            ['🎯', 'Al llegar al TP1: cerrar el 50% de la posición y subir el stop al precio de entrada (posición gratis).'],
            ['💰', 'Los beneficios del motor táctico se reinvierten en el motor táctico, no en Olympus.'],
            ['🔴', 'Si el motor táctico pierde más del 15% del capital asignado en un mes, parar operativa ese mes.'],
          ].map(([icon, rule], i) => (
            <div key={i} className="flex gap-2 text-xs">
              <span className="flex-shrink-0">{icon}</span>
              <span className="text-gray-400">{rule}</span>
            </div>
          ))}
        </div>
      </div>

      {/* IBKR */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-gray-200">
              Interactive Brokers — Datos reales y órdenes directas
            </p>
            <p className="text-[10px] text-gray-500 mt-0.5">
              Conecta IBKR para operar directamente desde el motor
            </p>
          </div>
          <button className="px-3 py-1.5 rounded-lg bg-blue-800 hover:bg-blue-700 text-white text-xs font-bold transition-colors">
            Activar IBKR
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MODAL IBKR
// ════════════════════════════════════════════════════════════
function IbkrOrderModal({
  opp, config, onClose,
}: {
  opp:     TacticalOpportunity;
  config:  TacticalConfig;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const sizing = calcPositionSize(safeNum(config.tacticalCapitalEur), opp.entryPrice, opp.stopLoss, config);
  const ibkr   = buildIbkrOrder(opp, sizing.shares, 'LMT');
  const json   = JSON.stringify(ibkr, null, 2);
  const c      = cur(opp.asset.currency);
  const s      = ibkr.summary;
  const ct     = ibkr.contract as any;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <div>
            <h3 className="font-bold text-white">Orden IBKR — {opp.asset.ticker}</h3>
            <p className="text-xs text-gray-400">{opp.asset.name} · {opp.asset.exchange}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          <div className="bg-blue-900/20 border border-blue-800/40 rounded-xl p-3 grid grid-cols-2 gap-2 text-sm">
            {[
              ['Símbolo IBKR', ct.symbol], ['Exchange IBKR', ct.exchange],
              ['Tipo instrumento', ct.secType], ['Divisa', opp.asset.currency],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="text-[9px] text-gray-500">{k}</div>
                <div className="font-bold text-white">{v}</div>
              </div>
            ))}
          </div>

          <div className="bg-gray-900 rounded-xl p-3 space-y-2 text-sm">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-1">Bracket completo</p>
            <div className="flex justify-between border-b border-gray-700 pb-2">
              <span className="text-gray-400">BUY {s.sharesTotal} acc. @ LMT</span>
              <span className="font-bold text-white">{c}{fmt(s.entryPrice)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">SELL {s.sharesTotal} acc. — Stop</span>
              <span className="font-bold text-red-400">{c}{fmt(s.stopPrice)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">SELL {s.sharesTP1} acc. — TP1 (50%)</span>
              <span className="font-bold text-green-400">{c}{fmt(s.tp1Price)}</span>
            </div>
            <div className="flex justify-between border-b border-gray-700 pb-2">
              <span className="text-gray-400">SELL {s.sharesTP2} acc. — TP2 (50%)</span>
              <span className="font-bold text-emerald-400">{c}{fmt(s.tp2Price)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
              {[
                { label: 'Riesgo máx.', val: `${c}${fmt(s.maxRisk)}`, cls: 'text-red-400' },
                { label: 'Ganancia TP1', val: `+${c}${fmt(s.maxGainTP1)}`, cls: 'text-green-400' },
                { label: 'Ganancia TP2', val: `+${c}${fmt(s.maxGainTP2)}`, cls: 'text-emerald-400' },
                { label: 'R:R', val: fmt(s.riskReward), cls: 'text-indigo-400' },
              ].map(({ label, val, cls }) => (
                <div key={label} className="bg-gray-800 rounded-lg p-2 text-center">
                  <div className="text-gray-500">{label}</div>
                  <div className={`font-bold ${cls}`}>{val}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-yellow-900/10 border border-yellow-800/30 rounded-xl p-3 text-xs text-gray-400 whitespace-pre-line leading-relaxed">
            {opp.reasoning}
          </div>

          <details>
            <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300 font-medium select-none">
              📄 JSON completo — IBKR TWS API / Gateway
            </summary>
            <pre className="mt-2 bg-gray-950 text-green-400 rounded-xl p-3 text-[9px] overflow-x-auto max-h-48 leading-relaxed">
              {json}
            </pre>
          </details>
        </div>

        <div className="px-5 py-4 border-t border-gray-700">
          <button
            onClick={() =>
              navigator.clipboard.writeText(json).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2500);
              })
            }
            className="w-full py-2.5 rounded-xl font-bold text-sm bg-gray-900 hover:bg-black text-white transition-colors"
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
  const safeTac = safeNum(tacticalCapital);
  const safeDef = safeNum(defensiveLiquidity);
  const defaultConfig = defaultTacticalConfig(safeTac, safeDef);

  const [engineState, setEngineState] = useState<TacticalEngineState>(() => {
    const saved = loadTacticalState();
    return saved ?? initTacticalState(defaultConfig);
  });

  const [activeTab,  setActiveTab]  = useState<Tab>('opportunities');
  const [scanMode,   setScanMode]   = useState<ScanMode>('volatile');
  const [isScanning, setIsScanning] = useState(false);
  const [result,     setResult]     = useState<ScreenerResult | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [ibkrOpp,    setIbkrOpp]   = useState<TacticalOpportunity | null>(null);

  // Persistir estado
  useEffect(() => { saveTacticalState(engineState); }, [engineState]);

  // Sync capital cuando cambia el portfolio
  useEffect(() => {
    const newCfg = defaultTacticalConfig(safeTac, safeDef);
    setEngineState(s => ({
      ...s,
      config: { ...s.config, tacticalCapitalEur: newCfg.tacticalCapitalEur },
    }));
  }, [safeTac, safeDef]);

  const config = engineState.config;

  // ── Escanear ─────────────────────────────────────────────────
  const handleScan = useCallback(async () => {
    setIsScanning(true);
    setError(null);
    setResult(null);
    try {
      const res = await runTacticalScreener(supabase, config, scanMode);
      setResult(res);
      setEngineState(s => ({
        ...s,
        opportunities: res.opportunities,
        lastScreened:  res.screennedAt,
      }));
      setActiveTab('opportunities');
    } catch (e: any) {
      setError(e?.message ?? 'Error desconocido durante el escaneo');
    } finally {
      setIsScanning(false);
    }
  }, [supabase, config, scanMode]);

  // ── Abrir posición ───────────────────────────────────────────
  const handleOpenPosition = useCallback((opp: TacticalOpportunity) => {
    setEngineState(s => openPosition(s, opp));
    setActiveTab('positions');
  }, []);

  // ── Cerrar posición ──────────────────────────────────────────
  const handleClosePosition = useCallback((id: string, reason: OpportunityStatus) => {
    setEngineState(s => {
      const pos = s.openPositions.find(p => p.id === id);
      if (!pos) return s;
      return closePosition(s, id, pos.currentPrice, reason);
    });
  }, []);

  // ── Config ───────────────────────────────────────────────────
  const handleConfigChange = useCallback((newCfg: TacticalConfig) => {
    setEngineState(s => ({ ...s, config: newCfg }));
  }, []);

  const handleReset = useCallback(() => {
    setEngineState(initTacticalState(defaultConfig));
    setResult(null);
    setActiveTab('opportunities');
  }, [defaultConfig]);

  const opportunities = result?.opportunities ?? engineState.opportunities ?? [];
  const topPicks      = opportunities.filter(o => o.score >= 70);
  const openTickers   = new Set(engineState.openPositions.map(p => p.ticker));
  const summary       = getTacticalSummary(engineState);

  // Pestañas
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'opportunities', label: '🎯 Oportunidades', count: opportunities.length },
    { id: 'positions',     label: '📊 Posiciones',    count: engineState.openPositions.length },
    { id: 'history',       label: '📋 Historial',     count: engineState.closedPositions.length },
    { id: 'config',        label: '⚙️ Configuración' },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Métricas */}
      <MetricsBar state={engineState} lastScan={engineState.lastScreened} />

      <div className="max-w-5xl mx-auto p-4 space-y-4">

        {/* Escaneo */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {(['volatile', 'core', 'full'] as ScanMode[]).map(mode => {
              const active = scanMode === mode;
              const icons: Record<ScanMode, string> = { volatile: '⚡', core: '🎯', full: '📊' };
              return (
                <button
                  key={mode}
                  onClick={() => setScanMode(mode)}
                  disabled={isScanning}
                  className={`flex flex-col items-center py-2.5 px-2 rounded-lg font-semibold text-sm transition-all border ${
                    active
                      ? 'bg-indigo-600 border-indigo-500 text-white'
                      : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'
                  } ${isScanning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <span className="font-bold">{icons[mode]} {SCAN_MODE_LABELS[mode]}</span>
                  <span className={`text-[10px] font-normal mt-0.5 ${active ? 'text-indigo-200' : 'text-gray-500'}`}>
                    ({getScanModeCount(mode)})
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-center text-gray-500">{SCAN_MODE_DESCRIPTIONS[scanMode]}</p>
          <button
            onClick={handleScan}
            disabled={isScanning}
            className={`w-full py-3 rounded-xl font-bold text-sm transition-all ${
              isScanning
                ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg'
            }`}
          >
            {isScanning ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                Escaneando {SCAN_MODE_LABELS[scanMode]} ({getScanModeCount(scanMode)} activos)…
              </span>
            ) : '🔍 Escanear mercado'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 text-red-300 text-sm">
            ⚠️ {error}
          </div>
        )}

        {/* Alertas de posiciones */}
        {summary.alertsToAction.length > 0 && (
          <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-3 space-y-1">
            {summary.alertsToAction.map((a, i) => (
              <p key={i} className="text-xs text-yellow-300">{a}</p>
            ))}
          </div>
        )}

        {/* Pestañas */}
        <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-2 px-1 rounded-lg text-[11px] font-semibold transition-all flex items-center justify-center gap-1 ${
                activeTab === tab.id
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <span className="truncate">{tab.label}</span>
              {tab.count !== undefined && (
                <span className={`text-[9px] rounded-full px-1.5 py-0.5 flex-shrink-0 ${
                  activeTab === tab.id ? 'bg-indigo-800 text-indigo-200' : 'bg-gray-700 text-gray-500'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Contenido */}
        {activeTab === 'opportunities' && (
          <div className="space-y-4">
            {opportunities.length === 0 ? (
              <div className="text-center py-16 text-gray-600">
                <div className="text-5xl mb-3">🔍</div>
                <p className="text-sm">Inicia un escaneo para ver oportunidades</p>
                <p className="text-xs mt-1 text-gray-700">Los resultados aparecerán aquí</p>
              </div>
            ) : (
              <>
                {topPicks.length > 0 && (
                  <>
                    <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                      🏆 Top Picks — Score ≥ 70
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {topPicks.map((opp, i) => (
                        <OpportunityCard
                          key={opp.id}
                          opp={opp}
                          rank={i + 1}
                          config={config}
                          onOpen={handleOpenPosition}
                          onIbkr={setIbkrOpp}
                          alreadyOpen={openTickers.has(opp.asset.ticker)}
                        />
                      ))}
                    </div>
                  </>
                )}

                {opportunities.filter(o => o.score < 70).length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300 font-medium select-none py-1">
                      Ver {opportunities.filter(o => o.score < 70).length} oportunidades adicionales (score &lt; 70)
                    </summary>
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {opportunities.filter(o => o.score < 70).map((opp, i) => (
                        <OpportunityCard
                          key={opp.id}
                          opp={opp}
                          rank={topPicks.length + i + 1}
                          config={config}
                          onOpen={handleOpenPosition}
                          onIbkr={setIbkrOpp}
                          alreadyOpen={openTickers.has(opp.asset.ticker)}
                        />
                      ))}
                    </div>
                  </details>
                )}

                {result?.errors && result.errors.length > 0 && (
                  <details className="text-xs text-gray-600">
                    <summary className="cursor-pointer hover:text-gray-400 select-none">
                      ⚠️ {result.errors.length} activos sin datos
                    </summary>
                    <ul className="mt-1 list-disc list-inside space-y-0.5 pl-2 text-gray-700">
                      {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'positions' && (
          <div className="space-y-3">
            {engineState.openPositions.length === 0 ? (
              <div className="text-center py-16 text-gray-600">
                <div className="text-5xl mb-3">📊</div>
                <p className="text-sm">Sin posiciones abiertas</p>
                <p className="text-xs mt-1 text-gray-700">
                  Abre una posición desde la pestaña de Oportunidades
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: 'Abiertas', val: `${engineState.openPositions.length}/${config.maxOpenPositions}`, color: 'text-white' },
                    { label: 'Capital usado', val: `€${fmtEur(summary.capitalUsed)}`, color: 'text-white' },
                    { label: 'PnL total', val: `${summary.unrealizedPnL >= 0 ? '+' : ''}€${fmtEur(summary.unrealizedPnL)}`, color: summary.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400' },
                  ].map(m => (
                    <div key={m.label} className="bg-gray-800 border border-gray-700 rounded-xl p-3">
                      <div className={`text-lg font-black tabular-nums ${m.color}`}>{m.val}</div>
                      <div className="text-[9px] text-gray-500 mt-0.5">{m.label}</div>
                    </div>
                  ))}
                </div>
                {engineState.openPositions.map(pos => (
                  <PositionRow key={pos.id} pos={pos} onClose={handleClosePosition} />
                ))}
              </>
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <HistoryTable positions={engineState.closedPositions} />
        )}

        {activeTab === 'config' && (
          <ConfigPanel
            config={config}
            onChange={handleConfigChange}
            onReset={handleReset}
          />
        )}
      </div>

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