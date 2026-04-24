// ============================================================
// src/dashboard/TacticalDashboard.tsx
// Dashboard del Motor Táctico Olympus
// ============================================================

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { supabase } from './supabaseClient';
import type {
  TacticalEngineState, TacticalOpportunity,
  TacticalPosition, TacticalConfig,
} from '@/core/tactical/types';
import {
  initTacticalState, loadTacticalState, saveTacticalState,
  openPosition, closePosition, updatePositionPrices,
  getTacticalSummary,
} from '@/core/tactical/tacticalPortfolio';
import {
  runTacticalScreener, defaultTacticalConfig, getScanModeCount,
} from '@/core/tactical/tacticalScreener';
import type { ScanMode } from '@/core/tactical/tacticalScreener';

// ── Estilos base ─────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page:    { background:'#0f172a', minHeight:'100vh', color:'#e2e8f0', fontFamily:'system-ui,sans-serif', padding:'1.5rem' },
  card:    { background:'#1e293b', border:'1px solid #334155', borderRadius:12, padding:'1.25rem', marginBottom:'1rem' },
  cardG:   { background:'#1e293b', border:'2px solid #16a34a', borderRadius:12, padding:'1.25rem', marginBottom:'1rem' },
  cardR:   { background:'#1e293b', border:'1px solid #ef4444', borderRadius:12, padding:'1.25rem', marginBottom:'1rem' },
  cardB:   { background:'#1e293b', border:'1px solid #3b82f6', borderRadius:12, padding:'1.25rem', marginBottom:'1rem' },
  h2:      { fontSize:'1rem', fontWeight:700, color:'#f8fafc', marginBottom:'0.75rem', margin:0 },
  h3:      { fontSize:'0.85rem', fontWeight:700, color:'#94a3b8', letterSpacing:'0.05em', textTransform:'uppercase', margin:'0 0 0.5rem' },
  mGrid:   { display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:'0.6rem', marginBottom:'1rem' },
  metric:  { background:'#0f172a', borderRadius:8, padding:'0.75rem 1rem', textAlign:'center', border:'1px solid #1e293b' },
  mVal:    { fontSize:'1.2rem', fontWeight:700, color:'#f8fafc' },
  mLbl:    { fontSize:'0.65rem', color:'#64748b', marginTop:2 },
  btn:     { padding:'0.5rem 1rem', borderRadius:6, fontWeight:700, cursor:'pointer', fontSize:'0.8rem', border:'none', transition:'opacity .15s' },
  btnB:    { background:'#1d4ed8', color:'#fff' },
  btnG:    { background:'#15803d', color:'#fff' },
  btnR:    { background:'#b91c1c', color:'#fff' },
  btnGr:   { background:'#334155', color:'#94a3b8' },
  badge:   { display:'inline-block', padding:'2px 8px', borderRadius:4, fontSize:'0.7rem', fontWeight:700 },
  input:   { background:'#0f172a', border:'1px solid #334155', borderRadius:6, color:'#f8fafc', fontSize:'0.8rem', padding:'0.4rem 0.6rem', width:'100%' },
  table:   { width:'100%', borderCollapse:'collapse' as const, fontSize:'0.78rem' },
  th:      { textAlign:'left' as const, padding:'6px 8px', background:'#0f172a', color:'#64748b', fontWeight:700, fontSize:'0.7rem', borderBottom:'1px solid #334155' },
  td:      { padding:'6px 8px', borderBottom:'1px solid #1e293b', color:'#e2e8f0', verticalAlign:'top' as const },
};

const clr = (v: number) => v >= 0 ? '#22c55e' : '#ef4444';
const pct = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const eur = (v: number | undefined | null) => `€${Math.round(v ?? 0).toLocaleString('es-ES')}`;

const typeColors: Record<string, string> = {
  BLOOD_IN_STREETS:  '#ef4444',
  MEAN_REVERSION:    '#3b82f6',
  MOMENTUM_BREAKOUT: '#22c55e',
  OVERSOLD_BOUNCE:   '#f59e0b',
  SECTOR_ROTATION:   '#a78bfa',
  EVENT_DRIVEN:      '#f97316',
};
const typeLabels: Record<string, string> = {
  BLOOD_IN_STREETS:  '🩸 Blood Streets',
  MEAN_REVERSION:    '↩ Mean Revert',
  MOMENTUM_BREAKOUT: '🚀 Breakout',
  OVERSOLD_BOUNCE:   '↑ Rebote',
  SECTOR_ROTATION:   '🔄 Rotación',
  EVENT_DRIVEN:      '⚡ Evento',
};

// ════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ════════════════════════════════════════════════════════════
export default function TacticalDashboard() {
  const [state, setState] = useState<TacticalEngineState>(() => {
    const saved = loadTacticalState();
    return saved ?? initTacticalState(defaultTacticalConfig(300, 600));
  });
  const [loading, setLoading]     = useState(false);
  const [tab, setTab]             = useState<'opportunities' | 'positions' | 'history' | 'config'>('opportunities');
  const [error, setError]         = useState<string | null>(null);
  const [lastRun, setLastRun]     = useState<string | null>(state.lastScreened);
  const [scanMode, setScanMode]   = useState<ScanMode>('core');

  // ── Modal "Confirmar apertura" con precios editables ────────
  const [openModal,   setOpenModal]   = useState<TacticalOpportunity | null>(null);
  const [modalEntry,  setModalEntry]  = useState('');
  const [modalStop,   setModalStop]   = useState('');
  const [modalTP1,    setModalTP1]    = useState('');
  const [modalTP2,    setModalTP2]    = useState('');
  const [modalShares, setModalShares] = useState('');
  const [modalNote,   setModalNote]   = useState('');

  // Config local editable
  const [cfgCapital, setCfgCapital]   = useState(state.config.tacticalCapitalEur);
  const [cfgMinScore, setCfgMinScore] = useState(state.config.minScore);
  const [cfgMinRR, setCfgMinRR]       = useState(state.config.minRiskReward);
  const [cfgMaxPos, setCfgMaxPos]     = useState(state.config.maxOpenPositions);
  const [cfgRiskPct, setCfgRiskPct]   = useState(state.config.riskPerTradePct * 100);
  const [cfgMA200, setCfgMA200]       = useState(state.config.requireAboveMA200);

  // IBKR config
  const [ibkrEnabled,    setIbkrEnabled]    = useState(() => localStorage.getItem('ibkr_enabled') === 'true');
  const [ibkrAccountId,  setIbkrAccountId]  = useState(() => localStorage.getItem('ibkr_account_id') ?? '');
  const [ibkrGateway,    setIbkrGateway]    = useState(() => localStorage.getItem('ibkr_gateway') ?? 'https://localhost:5000');
  const [ibkrStatus,     setIbkrStatus]     = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [ibkrMsg,        setIbkrMsg]        = useState<string>('');
  const [ibkrAccounts,   setIbkrAccounts]   = useState<string[]>([]);
  const [ibkrPositions,  setIbkrPositions]  = useState<any[]>([]);
  const [ibkrNLV,        setIbkrNLV]        = useState<number>(0);

  // Persistir al cambiar estado
  useEffect(() => { saveTacticalState(state); }, [state]);

  const summary = useMemo(() => getTacticalSummary(state), [state]);

  // ── Ejecutar screener ──────────────────────────────────────
  const runScreener = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await runTacticalScreener(supabase, state.config, scanMode);
      setState(prev => ({
        ...prev,
        opportunities: result.opportunities,
        lastScreened:  result.screennedAt,
      }));
      setLastRun(result.screennedAt);
      if (result.errors.length > 0) {
        setError(`Datos parciales (${result.errors.length} activos sin datos)`);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Error en el screener');
    } finally {
      setLoading(false);
    }
  }, [state.config, scanMode]);

  // ── Abrir posición: abre modal con precios editables ─────────
  const handleOpenModal = useCallback((opp: TacticalOpportunity) => {
    const riskPerSh = Math.max(0.01, opp.entryPrice - opp.stopLoss);
    const shares    = Math.max(1, Math.floor(
      (state.config.tacticalCapitalEur * state.config.riskPerTradePct) / riskPerSh
    ));
    setOpenModal(opp);
    setModalEntry(opp.entryPrice.toFixed(2));
    setModalStop(opp.stopLoss.toFixed(2));
    setModalTP1(opp.takeProfit1.toFixed(2));
    setModalTP2(opp.takeProfit2.toFixed(2));
    setModalShares(String(shares));
    setModalNote('');
  }, [state.config]);

  // ── Confirmar apertura con precios reales editados ─────────
  const handleConfirmOpen = useCallback(() => {
    if (!openModal) return;
    const entry  = parseFloat(modalEntry);
    const stop   = parseFloat(modalStop);
    const tp1    = parseFloat(modalTP1);
    const tp2    = parseFloat(modalTP2);
    const shares = parseFloat(modalShares);
    if (!entry || !stop || !tp1 || !tp2 || !shares || entry <= stop) return;
    // Crear oportunidad modificada con precios reales ejecutados
    const modified: TacticalOpportunity = {
      ...openModal,
      entryPrice:  entry,
      stopLoss:    stop,
      takeProfit1: tp1,
      takeProfit2: tp2,
      riskReward:  (tp1 - entry) / (entry - stop),
    };
    setState(prev => openPosition(prev, modified));
    setOpenModal(null);
  }, [openModal, modalEntry, modalStop, modalTP1, modalTP2, modalShares]);

  // ── Cerrar posición ────────────────────────────────────────
  const handleClose = useCallback((posId: string, exitPrice: number, reason: 'CLOSED_MANUAL' | 'CLOSED_TP' | 'CLOSED_SL') => {
    setState(prev => closePosition(prev, posId, exitPrice, reason));
  }, []);

  // ── Aplicar config ─────────────────────────────────────────
  const applyConfig = useCallback(() => {
    const newConfig: TacticalConfig = {
      ...state.config,
      tacticalCapitalEur:   cfgCapital,
      minScore:             cfgMinScore,
      minRiskReward:        cfgMinRR,
      maxOpenPositions:     cfgMaxPos,
      riskPerTradePct:      cfgRiskPct / 100,
      requireAboveMA200:    cfgMA200,
    };
    setState(prev => ({ ...prev, config: newConfig }));
  }, [cfgCapital, cfgMinScore, cfgMinRR, cfgMaxPos, cfgRiskPct, cfgMA200, state.config]);

  // ── IBKR: verificar conexión ────────────────────────────────
  const verifyIBKR = useCallback(async () => {
    setIbkrStatus('checking');
    setIbkrMsg('Conectando con el Gateway...');
    try {
      const authRes = await fetch(`${ibkrGateway}/v1/api/iserver/auth/status`, {
        credentials: 'include',
      });
      if (!authRes.ok) throw new Error(`Gateway no responde (${authRes.status}). ¿Está corriendo en ${ibkrGateway}?`);
      const auth = await authRes.json();
      if (!auth.authenticated) {
        setIbkrStatus('error');
        setIbkrMsg(`Gateway responde pero no estás autenticado. Ve a ${ibkrGateway} en el navegador e inicia sesión con tus credenciales de IBKR.`);
        return;
      }

      const accRes  = await fetch(`${ibkrGateway}/v1/api/portfolio/accounts`, { credentials: 'include' });
      const accData = await accRes.json();
      const accounts: string[] = accData.accounts ?? [];
      setIbkrAccounts(accounts);

      const acct = ibkrAccountId || accounts[0] || '';
      if (!acct) throw new Error('No se encontraron cuentas en el Gateway.');

      const sumRes  = await fetch(`${ibkrGateway}/v1/api/portfolio/${acct}/summary`, { credentials: 'include' });
      const sumData = await sumRes.json();
      const nlv = parseFloat(sumData?.netliquidation?.amount ?? sumData?.NetLiquidation?.amount ?? 0);
      setIbkrNLV(nlv);

      const posRes  = await fetch(`${ibkrGateway}/v1/api/portfolio/${acct}/positions/0`, { credentials: 'include' });
      const posData = await posRes.json();
      setIbkrPositions(Array.isArray(posData) ? posData : []);

      localStorage.setItem('ibkr_enabled',    'true');
      localStorage.setItem('ibkr_account_id', acct);
      localStorage.setItem('ibkr_gateway',    ibkrGateway);
      if (!ibkrAccountId) setIbkrAccountId(acct);

      setIbkrStatus('ok');
      setIbkrMsg(`Conectado a cuenta ${acct} — Valor neto: €${Math.round(nlv).toLocaleString('es-ES')} — ${posData?.length ?? 0} posiciones`);
    } catch (e: any) {
      setIbkrStatus('error');
      setIbkrMsg(e?.message ?? 'Error desconocido al conectar con IBKR');
      localStorage.setItem('ibkr_enabled', 'false');
    }
  }, [ibkrGateway, ibkrAccountId]);

  // ── Render oportunidad ─────────────────────────────────────
  const OpportunityCard = ({ opp }: { opp: TacticalOpportunity }) => {
    const alreadyOpen = state.openPositions.some(p => p.ticker === opp.asset.ticker);
    // BUG FIX: state.capitalAvailable no se actualiza → usar summary.capitalAvailable
    const canOpen     = !alreadyOpen && summary.capitalAvailable >= opp.entryPrice;
    const tc          = typeColors[opp.type] ?? '#64748b';
    const riskPerSh   = Math.max(0.01, opp.entryPrice - opp.stopLoss);
    const shares      = Math.max(1, Math.floor((state.config.tacticalCapitalEur * state.config.riskPerTradePct) / riskPerSh));
    const riskEur     = riskPerSh * shares;
    const capitalUsed = opp.entryPrice * shares;
    // ATR: Average True Range — volatilidad diaria media del activo (14 días)
    // Representa el rango típico de movimiento en un día. Ej: ATR=2.5% en URNU.DE a €30
    // significa que el activo se mueve ±€0.75/día de media. Se usa para calcular el stop loss.
    const atrEur = opp.asset.indicators
      ? opp.asset.indicators.atr14
      : 0;
    const atrPct = opp.asset.indicators && opp.asset.price > 0
      ? (opp.asset.indicators.atr14 / opp.asset.price * 100)
      : 0;

    return (
      <div style={{ ...S.card, borderLeft:`3px solid ${tc}`, marginBottom:'0.75rem' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'0.6rem' }}>
          <div>
            <span style={{ fontWeight:700, fontSize:'1rem', color:'#f8fafc' }}>{opp.asset.ticker}</span>
            <span style={{ color:'#64748b', fontSize:'0.75rem', marginLeft:8 }}>{opp.asset.name}</span>
            <span style={{ ...S.badge, background:tc+'22', color:tc, marginLeft:8 }}>
              {typeLabels[opp.type]}
            </span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <div style={{ background:'#0f172a', borderRadius:20, width:40, height:40, display:'flex', alignItems:'center', justifyContent:'center', border:`2px solid ${opp.score >= 70 ? '#22c55e' : '#f59e0b'}` }}>
              <span style={{ fontWeight:700, fontSize:'0.8rem', color: opp.score >= 70 ? '#22c55e' : '#f59e0b' }}>
                {opp.score.toFixed(0)}
              </span>
            </div>
          </div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:6, marginBottom:'0.6rem' }}>
          {[
            ['Entrada',   `€${opp.entryPrice.toFixed(2)}`,   '#e2e8f0'],
            ['Stop Loss', `€${opp.stopLoss.toFixed(2)}`,      '#ef4444'],
            ['TP1 (50%)', `€${opp.takeProfit1.toFixed(2)}`,   '#22c55e'],
            ['TP2 (50%)', `€${opp.takeProfit2.toFixed(2)}`,   '#4ade80'],
            ['R:R',       `${opp.riskReward.toFixed(1)}:1`,   '#60a5fa'],
          ].map(([l, v, c]) => (
            <div key={l} style={{ background:'#0f172a', borderRadius:6, padding:'5px 8px', textAlign:'center', border:`1px solid ${l === 'Stop Loss' ? '#450a0a' : l.startsWith('TP') ? '#052e16' : '#1e293b'}` }}>
              <div style={{ fontSize:'0.6rem', color:'#64748b' }}>{l}</div>
              <div style={{ fontSize:'0.82rem', fontWeight:700, color: c }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Señales activas */}
        <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:'0.6rem' }}>
          {opp.activeSignals.map(s => (
            <span key={s.type} style={{ ...S.badge, background:'#0f172a', color: s.strength === 'EXTREME' ? '#ef4444' : s.strength === 'STRONG' ? '#f59e0b' : '#60a5fa', border:`1px solid #334155` }}>
              {s.type.replace('_',' ')} {s.score.toFixed(2)}
            </span>
          ))}
        </div>

        {/* Indicadores técnicos — ATR explicado con valor € real */}
        <div style={{ fontSize:'0.72rem', color:'#64748b', marginBottom:'0.5rem', lineHeight:1.5 }}>
          {opp.asset.indicators && (
            <>
              RSI(2)={opp.asset.indicators.rsi2.toFixed(1)} · RSI(14)={opp.asset.indicators.rsi14.toFixed(1)} · Z={opp.asset.indicators.zScore20.toFixed(2)} · Vol×{opp.asset.indicators.volumeRatio.toFixed(1)}
            </>
          )}
        </div>
        {/* ATR con explicación — clave para validar el stop loss */}
        <div style={{ fontSize:'0.7rem', background:'#0f172a', borderRadius:6, padding:'5px 8px', marginBottom:'0.6rem', border:'1px solid #1e293b' }}>
          <span style={{ color:'#60a5fa', fontWeight:700 }}>
            ATR(14): €{atrEur.toFixed(2)} ({atrPct.toFixed(2)}%/día)
          </span>
          <span style={{ color:'#475569', marginLeft:6 }}>
            · rango diario típico · stop = entrada − {opp.type === 'MOMENTUM_BREAKOUT' ? '1×' : opp.type === 'BLOOD_IN_STREETS' ? '1.5×' : '2×'}ATR
          </span>
          {atrPct === 0 && (
            <span style={{ color:'#f59e0b', marginLeft:6 }}>⚠ 0% → Yahoo no devolvió OHLC, usa aproximación</span>
          )}
        </div>

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:'0.7rem', color:'#475569' }}>
            {shares} acc. · riesgo ~{eur(riskEur)} · capital ~{eur(capitalUsed)}
          </span>
          {alreadyOpen ? (
            <span style={{ ...S.badge, background:'#1e3a5f', color:'#60a5fa' }}>Ya abierta</span>
          ) : (
            <button
              style={{ ...S.btn, ...S.btnG, opacity: canOpen ? 1 : 0.4 }}
              disabled={!canOpen}
              onClick={() => handleOpenModal(opp)}
            >
              ⚡ Abrir posición
            </button>
          )}
        </div>
      </div>
    );
  };

  // ── Render posición abierta ────────────────────────────────
  const PositionRow = ({ pos }: { pos: TacticalPosition }) => {
    const [exitP, setExitP] = useState(pos.currentPrice.toFixed(2));
    const pnlColor = clr(pos.unrealizedPnL);
    const nearSL   = pos.currentPrice <= pos.stopLoss * 1.03;
    const nearTP   = pos.currentPrice >= pos.takeProfit1 * 0.97;

    return (
      <tr style={{ background: nearSL ? '#1c0505' : nearTP ? '#052e16' : 'transparent' }}>
        <td style={S.td}>
          <div style={{ fontWeight:700 }}>{pos.ticker}</div>
          <div style={{ fontSize:'0.65rem', color:'#64748b' }}>{pos.name}</div>
          <span style={{ ...S.badge, background: typeColors[pos.type]+'22', color: typeColors[pos.type], marginTop:3 }}>
            {typeLabels[pos.type]}
          </span>
        </td>
        <td style={S.td}>
          <div>€{pos.entryPrice.toFixed(2)}</div>
          <div style={{ fontSize:'0.65rem', color:'#64748b' }}>{pos.shares} uds</div>
        </td>
        <td style={S.td}>
          <div style={{ fontWeight:700 }}>€{pos.currentPrice.toFixed(2)}</div>
        </td>
        <td style={S.td}>
          <div style={{ color:pnlColor, fontWeight:700 }}>
            {pos.unrealizedPnL >= 0 ? '+' : ''}{eur(pos.unrealizedPnL)}
          </div>
          <div style={{ fontSize:'0.7rem', color:pnlColor }}>
            {pct(pos.unrealizedPnLPct)}
          </div>
        </td>
        <td style={S.td}>
          <div style={{ color:'#ef4444', fontSize:'0.75rem' }}>SL €{pos.stopLoss.toFixed(2)}</div>
          <div style={{ color:'#22c55e', fontSize:'0.75rem' }}>TP1 €{pos.takeProfit1.toFixed(2)}</div>
          <div style={{ color:'#4ade80', fontSize:'0.7rem' }}>TP2 €{pos.takeProfit2.toFixed(2)}</div>
        </td>
        <td style={S.td}>
          <div style={{ color: pos.daysOpen >= pos.maxDaysAllowed - 2 ? '#f59e0b' : '#94a3b8' }}>
            Día {pos.daysOpen}/{pos.maxDaysAllowed}
          </div>
        </td>
        <td style={{ ...S.td, minWidth:200 }}>
          <div style={{ display:'flex', gap:4, alignItems:'center' }}>
            <input
              style={{ ...S.input, width:80 }}
              type="number"
              value={exitP}
              onChange={e => setExitP(e.target.value)}
              step="0.01"
            />
            <button style={{ ...S.btn, ...S.btnG, padding:'4px 8px', fontSize:'0.7rem' }}
              onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_TP')}>
              TP
            </button>
            <button style={{ ...S.btn, ...S.btnR, padding:'4px 8px', fontSize:'0.7rem' }}
              onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_SL')}>
              SL
            </button>
            <button style={{ ...S.btn, ...S.btnGr, padding:'4px 8px', fontSize:'0.7rem' }}
              onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_MANUAL')}>
              M
            </button>
          </div>
        </td>
      </tr>
    );
  };

  // ══════════════════════════════════════════════════════════
  // RENDER PRINCIPAL
  // ══════════════════════════════════════════════════════════
  return (
    <div style={S.page}>
      {/* Cabecera */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'1.25rem' }}>
        <div>
          <h1 style={{ margin:0, fontSize:'1.3rem', fontWeight:800, color:'#f8fafc' }}>
            ⚡ Motor Táctico Olympus
          </h1>
          <p style={{ margin:0, fontSize:'0.72rem', color:'#64748b' }}>
            Blood in the streets · Mean reversion · Momentum breakout
            {lastRun && ` · Último scan: ${new Date(lastRun).toLocaleTimeString('es-ES')}`}
          </p>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button
            style={{ ...S.btn, ...S.btnB, opacity: loading ? 0.6 : 1 }}
            onClick={runScreener}
            disabled={loading}
          >
            {loading ? '⏳ Escaneando...' : '🔍 Escanear mercado'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background:'#450a0a', border:'1px solid #ef4444', borderRadius:8, padding:'0.6rem 1rem', marginBottom:'1rem', fontSize:'0.78rem', color:'#fca5a5' }}>
          ⚠️ {error}
        </div>
      )}

      {/* Alertas de acción */}
      {summary.alertsToAction.length > 0 && (
        <div style={{ background:'#422006', border:'1px solid #f59e0b', borderRadius:8, padding:'0.75rem 1rem', marginBottom:'1rem' }}>
          <div style={{ fontWeight:700, color:'#fcd34d', fontSize:'0.8rem', marginBottom:4 }}>🔔 Alertas ({summary.alertsToAction.length})</div>
          {summary.alertsToAction.map((a, i) => (
            <div key={i} style={{ fontSize:'0.75rem', color:'#fde68a', marginTop:2 }}>{a}</div>
          ))}
        </div>
      )}

      {/* Métricas resumen */}
      <div style={S.mGrid}>
        {[
          { l:'Capital táctico', v:eur(state.config.tacticalCapitalEur), c:'#60a5fa' },
          { l:'Disponible',      v:eur(summary.capitalAvailable),        c:'#22c55e' },
          { l:'En posiciones',   v:eur(summary.capitalUsed),             c:'#f59e0b' },
          { l:'PnL no realizado',v:eur(summary.unrealizedPnL),           c:clr(summary.unrealizedPnL) },
          { l:'PnL realizado',   v:eur(summary.realizedPnL),             c:clr(summary.realizedPnL) },
          { l:'Win rate',        v:`${summary.winRate.toFixed(0)}%`,     c:summary.winRate >= 50 ? '#22c55e' : '#f59e0b' },
          { l:'Profit factor',   v:summary.profitFactor.toFixed(2),      c:summary.profitFactor >= 1.5 ? '#22c55e' : '#f59e0b' },
          { l:'Posiciones',      v:`${summary.openCount}/${state.config.maxOpenPositions}`, c:'#e2e8f0' },
        ].map(m => (
          <div key={m.l} style={S.metric}>
            <div style={{ ...S.mVal, color:m.c }}>{m.v}</div>
            <div style={S.mLbl}>{m.l}</div>
          </div>
        ))}
      </div>

      {/* Selector de universo */}
      <div style={{ display:'flex', gap:6, marginBottom:'0.75rem' }}>
        {(['volatile','core','full'] as ScanMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => setScanMode(mode)}
            style={{
              padding:'0.35rem 0.8rem', borderRadius:6, border:'1px solid #334155',
              background: scanMode === mode ? '#1d4ed8' : '#1e293b',
              color: scanMode === mode ? '#fff' : '#64748b',
              fontWeight:700, fontSize:'0.72rem', cursor:'pointer'
            }}
          >
            {mode === 'volatile' ? `⚡ RÁPIDO (${getScanModeCount('volatile')})` : mode === 'core' ? `🎯 CORE (${getScanModeCount('core')})` : `📊 FULL (${getScanModeCount('full')})`}
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:'1rem' }}>
        {(['opportunities','positions','history','config'] as const).map(t => (
          <button
            key={t}
            style={{ ...S.btn, background: tab === t ? '#1d4ed8' : '#1e293b', color: tab === t ? '#fff' : '#64748b', border:'1px solid #334155' }}
            onClick={() => setTab(t)}
          >
            {t === 'opportunities' ? `🎯 Oportunidades (${state.opportunities.length})`
             : t === 'positions'   ? `📊 Posiciones (${state.openPositions.length})`
             : t === 'history'     ? `📋 Historial (${state.closedPositions.length})`
             : '⚙️ Configuración'}
          </button>
        ))}
      </div>

      {/* ── TAB: OPORTUNIDADES ────────────────────────── */}
      {tab === 'opportunities' && (
        <div>
          {state.opportunities.length === 0 ? (
            <div style={{ ...S.card, textAlign:'center', padding:'3rem' }}>
              <div style={{ fontSize:'2rem', marginBottom:'1rem' }}>🔍</div>
              <div style={{ color:'#64748b' }}>
                {loading ? 'Escaneando el universo de activos...' : 'Pulsa "Escanear mercado" para detectar oportunidades'}
              </div>
            </div>
          ) : (
            <>
              {/* Top picks destacados */}
              {state.opportunities.filter(o => o.score >= 70).length > 0 && (
                <div style={{ ...S.cardG, marginBottom:'1rem' }}>
                  <div style={{ fontWeight:700, color:'#4ade80', marginBottom:'0.5rem' }}>
                    🏆 TOP PICKS — Score ≥ 70
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(100px,1fr))', gap:6 }}>
                    {state.opportunities.filter(o => o.score >= 70).slice(0,5).map(o => (
                      <div key={o.id} style={{ background:'#052e16', borderRadius:8, padding:'8px 12px', textAlign:'center', border:'1px solid #16a34a' }}>
                        <div style={{ fontWeight:700, fontSize:'0.9rem', color:'#f8fafc' }}>{o.asset.ticker}</div>
                        <div style={{ fontSize:'0.65rem', color:'#64748b' }}>{typeLabels[o.type]}</div>
                        <div style={{ fontWeight:700, color:'#22c55e', fontSize:'1rem' }}>{o.score.toFixed(0)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Todas las oportunidades */}
              {state.opportunities.map(opp => (
                <OpportunityCard key={opp.id} opp={opp} />
              ))}
            </>
          )}
        </div>
      )}

      {/* ── TAB: POSICIONES ABIERTAS ──────────────────── */}
      {tab === 'positions' && (
        <div style={S.card}>
          {state.openPositions.length === 0 ? (
            <div style={{ textAlign:'center', padding:'2rem', color:'#64748b' }}>
              No hay posiciones abiertas. Abre una desde la pestaña Oportunidades.
            </div>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {['Activo','Entrada','Precio actual','P&L','SL / TP1','Días','Cerrar'].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.openPositions.map(pos => (
                    <PositionRow key={pos.id} pos={pos} />
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background:'#0f172a' }}>
                    <td colSpan={3} style={{ ...S.td, fontWeight:700, color:'#94a3b8' }}>TOTAL</td>
                    <td style={{ ...S.td, fontWeight:700, color:clr(summary.unrealizedPnL) }}>
                      {summary.unrealizedPnL >= 0 ? '+' : ''}{eur(summary.unrealizedPnL)}
                    </td>
                    <td colSpan={3} style={S.td}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: HISTORIAL ───────────────────────────── */}
      {tab === 'history' && (
        <div style={S.card}>
          {state.closedPositions.length === 0 ? (
            <div style={{ textAlign:'center', padding:'2rem', color:'#64748b' }}>
              Sin operaciones cerradas todavía.
            </div>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {['Activo','Tipo','Entrada','Salida','P&L €','P&L %','Días','Motivo'].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...state.closedPositions].reverse().map(pos => (
                    <tr key={pos.id}>
                      <td style={S.td}><div style={{ fontWeight:700 }}>{pos.ticker}</div></td>
                      <td style={S.td}>
                        <span style={{ ...S.badge, background: typeColors[pos.type]+'22', color: typeColors[pos.type] }}>
                          {typeLabels[pos.type]}
                        </span>
                      </td>
                      <td style={S.td}>€{pos.entryPrice.toFixed(2)}</td>
                      <td style={S.td}>€{(pos.exitPrice ?? 0).toFixed(2)}</td>
                      <td style={{ ...S.td, fontWeight:700, color:clr(pos.realizedPnL ?? 0) }}>
                        {(pos.realizedPnL ?? 0) >= 0 ? '+' : ''}{eur(pos.realizedPnL ?? 0)}
                      </td>
                      <td style={{ ...S.td, color:clr(pos.realizedPnLPct ?? 0) }}>
                        {pct(pos.realizedPnLPct ?? 0)}
                      </td>
                      <td style={S.td}>{pos.daysOpen}d</td>
                      <td style={S.td}>
                        <span style={{ ...S.badge,
                          background: pos.status === 'CLOSED_TP' ? '#052e16' : pos.status === 'CLOSED_SL' ? '#450a0a' : '#1e293b',
                          color:      pos.status === 'CLOSED_TP' ? '#4ade80' : pos.status === 'CLOSED_SL' ? '#fca5a5' : '#94a3b8',
                        }}>
                          {pos.status === 'CLOSED_TP' ? '✅ TP' : pos.status === 'CLOSED_SL' ? '🛑 SL' : pos.status === 'CLOSED_TIME' ? '⏰ Tiempo' : '📤 Manual'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Métricas historial */}
          {state.closedPositions.length > 0 && (
            <div style={{ marginTop:'1rem', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))', gap:8 }}>
              {[
                { l:'Operaciones', v:state.closedPositions.length },
                { l:'Ganadoras',   v:state.closedPositions.filter(p => (p.realizedPnL ?? 0) > 0).length },
                { l:'Perdedoras',  v:state.closedPositions.filter(p => (p.realizedPnL ?? 0) <= 0).length },
                { l:'Win Rate',    v:`${summary.winRate.toFixed(0)}%` },
                { l:'Profit Factor', v:summary.profitFactor.toFixed(2) },
                { l:'PnL Total',   v:eur(summary.realizedPnL) },
              ].map(m => (
                <div key={m.l} style={S.metric}>
                  <div style={{ ...S.mVal, color:'#f8fafc', fontSize:'1rem' }}>{m.v}</div>
                  <div style={S.mLbl}>{m.l}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: CONFIGURACIÓN ────────────────────────── */}
      {tab === 'config' && (
        <div style={S.card}>
          <h2 style={{ ...S.h2, marginBottom:'1rem' }}>⚙️ Configuración del Motor Táctico</h2>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1rem' }}>
            {/* Capital */}
            <div style={{ background:'#0f172a', borderRadius:8, padding:'1rem', border:'1px solid #334155' }}>
              <div style={S.h3}>Capital y riesgo</div>
              <div style={{ marginBottom:8 }}>
                <label style={{ fontSize:'0.75rem', color:'#64748b', display:'block', marginBottom:3 }}>
                  Capital táctico total (€) <span style={{ color:'#475569' }}>— máx 20% de liquidez defensiva</span>
                </label>
                <input style={S.input} type="number" value={cfgCapital} onChange={e => setCfgCapital(+e.target.value)} step={50} min={100} />
              </div>
              <div style={{ marginBottom:8 }}>
                <label style={{ fontSize:'0.75rem', color:'#64748b', display:'block', marginBottom:3 }}>
                  Riesgo por operación (%) <span style={{ color:'#475569' }}>— recomendado 1-2%</span>
                </label>
                <input style={S.input} type="number" value={cfgRiskPct} onChange={e => setCfgRiskPct(+e.target.value)} step={0.5} min={0.5} max={5} />
              </div>
              <div>
                <label style={{ fontSize:'0.75rem', color:'#64748b', display:'block', marginBottom:3 }}>
                  Máx posiciones simultáneas
                </label>
                <input style={S.input} type="number" value={cfgMaxPos} onChange={e => setCfgMaxPos(+e.target.value)} step={1} min={1} max={10} />
              </div>
            </div>

            {/* Filtros */}
            <div style={{ background:'#0f172a', borderRadius:8, padding:'1rem', border:'1px solid #334155' }}>
              <div style={S.h3}>Filtros de calidad</div>
              <div style={{ marginBottom:8 }}>
                <label style={{ fontSize:'0.75rem', color:'#64748b', display:'block', marginBottom:3 }}>
                  Score mínimo (0-100) <span style={{ color:'#475569' }}>— recomendado 45+</span>
                </label>
                <input style={S.input} type="number" value={cfgMinScore} onChange={e => setCfgMinScore(+e.target.value)} step={5} min={20} max={90} />
              </div>
              <div style={{ marginBottom:8 }}>
                <label style={{ fontSize:'0.75rem', color:'#64748b', display:'block', marginBottom:3 }}>
                  Ratio riesgo/recompensa mínimo <span style={{ color:'#475569' }}>— recomendado 1.5</span>
                </label>
                <input style={S.input} type="number" value={cfgMinRR} onChange={e => setCfgMinRR(+e.target.value)} step={0.1} min={1} max={5} />
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <input type="checkbox" checked={cfgMA200} onChange={e => setCfgMA200(e.target.checked)} id="ma200check" style={{ width:16, height:16, cursor:'pointer', accentColor:'#22c55e' }} />
                <label htmlFor="ma200check" style={{ fontSize:'0.75rem', color:'#94a3b8', cursor:'pointer' }}>
                  Solo activos sobre MA200 (filtro de tendencia)
                </label>
              </div>
            </div>
          </div>

          <div style={{ marginTop:'1rem', display:'flex', gap:8 }}>
            <button style={{ ...S.btn, ...S.btnG }} onClick={applyConfig}>
              ✅ Aplicar configuración
            </button>
            <button
              style={{ ...S.btn, ...S.btnR }}
              onClick={() => {
                if (confirm('¿Borrar todo el historial y posiciones del motor táctico?')) {
                  setState(initTacticalState(state.config));
                  localStorage.removeItem('olympus_tactical_state');
                }
              }}
            >
              🗑 Reset completo
            </button>
          </div>

          {/* Reglas de operativa */}
          <div style={{ marginTop:'1.5rem', background:'#0f172a', borderRadius:8, padding:'1rem', border:'1px solid #334155' }}>
            <div style={{ ...S.h3, marginBottom:'0.75rem' }}>📋 Reglas de operativa (no las rompas)</div>
            {[
              '🔒 El motor táctico usa MÁXIMO el 20% de la liquidez defensiva de Olympus. El 80% restante queda para el ATTACK_MAX de octubre.',
              '⏰ Toda posición se cierra en 10 días hábiles aunque no haya llegado al TP ni al SL. El tiempo es enemigo en trading táctico.',
              '🚫 Nunca abrir una posición táctica en un activo que Olympus esté comprando ese mes para no duplicar riesgo.',
              '📊 Stop loss es SAGRADO. Si el precio llega al stop, se ejecuta sin excepción, nunca se mueve hacia abajo.',
              '🎯 Al llegar al TP1: cerrar el 50% de la posición y subir el stop al precio de entrada (posición gratis).',
              '💰 Los beneficios del motor táctico se reinvierten en el motor táctico, no en Olympus.',
              '🔴 Si el motor táctico pierde más del 15% del capital asignado en un mes, parar operativa ese mes.',
            ].map((rule, i) => (
              <div key={i} style={{ fontSize:'0.78rem', color:'#94a3b8', padding:'5px 0', borderBottom:'1px solid #1e293b', lineHeight:1.5 }}>
                {rule}
              </div>
            ))}
          </div>

          {/* ── IBKR ─────────────────────────────────────────── */}
          <div style={{ marginTop:'1.5rem', background:'#0f172a', borderRadius:8, padding:'1rem', border:`2px solid ${ibkrStatus === 'ok' ? '#16a34a' : ibkrStatus === 'error' ? '#ef4444' : '#334155'}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.75rem' }}>
              <div style={{ ...S.h3, margin:0 }}>
                Interactive Brokers — Datos reales y ordenes directas
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:'0.72rem', color:'#64748b' }}>Activar IBKR</span>
                <div
                  onClick={() => {
                    const next = !ibkrEnabled;
                    setIbkrEnabled(next);
                    localStorage.setItem('ibkr_enabled', String(next));
                    if (!next) { setIbkrStatus('idle'); setIbkrMsg(''); }
                  }}
                  style={{
                    width:44, height:24, borderRadius:12, cursor:'pointer',
                    background: ibkrEnabled ? '#16a34a' : '#334155',
                    position:'relative', transition:'background .2s',
                  }}
                >
                  <div style={{
                    width:18, height:18, borderRadius:9, background:'white',
                    position:'absolute', top:3,
                    left: ibkrEnabled ? 23 : 3,
                    transition:'left .2s',
                  }} />
                </div>
              </div>
            </div>

            {ibkrEnabled && (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
                  <div>
                    <label style={{ fontSize:'0.72rem', color:'#64748b', display:'block', marginBottom:3 }}>
                      URL del Gateway (default: https://localhost:5000)
                    </label>
                    <input
                      style={S.input}
                      value={ibkrGateway}
                      onChange={e => setIbkrGateway(e.target.value)}
                      placeholder="https://localhost:5000"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize:'0.72rem', color:'#64748b', display:'block', marginBottom:3 }}>
                      Account ID (formato U1234567) — opcional, se detecta solo
                    </label>
                    <input
                      style={S.input}
                      value={ibkrAccountId}
                      onChange={e => setIbkrAccountId(e.target.value)}
                      placeholder="U1234567"
                    />
                  </div>
                </div>

                <button
                  style={{ ...S.btn, background: ibkrStatus === 'checking' ? '#334155' : '#1d4ed8', color:'#fff', opacity: ibkrStatus === 'checking' ? 0.6 : 1 }}
                  onClick={verifyIBKR}
                  disabled={ibkrStatus === 'checking'}
                >
                  {ibkrStatus === 'checking' ? '⏳ Verificando...' : '🔌 Verificar conexión IBKR'}
                </button>

                {ibkrMsg && (
                  <div style={{
                    marginTop:8, padding:'8px 12px', borderRadius:6, fontSize:'0.78rem',
                    background: ibkrStatus === 'ok' ? '#052e16' : ibkrStatus === 'error' ? '#450a0a' : '#1e293b',
                    color: ibkrStatus === 'ok' ? '#4ade80' : ibkrStatus === 'error' ? '#fca5a5' : '#94a3b8',
                    border: `1px solid ${ibkrStatus === 'ok' ? '#16a34a' : ibkrStatus === 'error' ? '#ef4444' : '#334155'}`,
                  }}>
                    {ibkrStatus === 'ok' ? '✅ ' : ibkrStatus === 'error' ? '❌ ' : 'ℹ️ '}{ibkrMsg}
                  </div>
                )}

                {/* Cuentas detectadas */}
                {ibkrAccounts.length > 0 && (
                  <div style={{ marginTop:8, fontSize:'0.72rem', color:'#64748b' }}>
                    Cuentas detectadas: {ibkrAccounts.join(', ')}
                  </div>
                )}

                {/* Posiciones reales de IBKR */}
                {ibkrPositions.length > 0 && (
                  <div style={{ marginTop:12 }}>
                    <div style={{ fontSize:'0.75rem', fontWeight:700, color:'#94a3b8', marginBottom:6 }}>
                      POSICIONES REALES EN IBKR ({ibkrPositions.length})
                    </div>
                    <div style={{ overflowX:'auto' }}>
                      <table style={S.table}>
                        <thead>
                          <tr>
                            {['Activo','Qty','Precio actual','Valor','P&L','Precio medio'].map(h => (
                              <th key={h} style={S.th}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {ibkrPositions.slice(0, 15).map((p: any, i: number) => {
                            const pnl = p.unrealizedPnl ?? 0;
                            return (
                              <tr key={i}>
                                <td style={S.td}>
                                  <div style={{ fontWeight:700 }}>{p.ticker ?? p.contractDesc?.split(' ')[0] ?? '—'}</div>
                                  <div style={{ fontSize:'0.65rem', color:'#64748b' }}>{p.contractDesc ?? ''}</div>
                                </td>
                                <td style={S.td}>{p.position}</td>
                                <td style={S.td}>€{(p.mktPrice ?? 0).toFixed(2)}</td>
                                <td style={S.td}>€{Math.round(p.mktValue ?? 0).toLocaleString('es-ES')}</td>
                                <td style={{ ...S.td, color: pnl >= 0 ? '#22c55e' : '#ef4444', fontWeight:700 }}>
                                  {pnl >= 0 ? '+' : ''}€{Math.round(pnl).toLocaleString('es-ES')}
                                </td>
                                <td style={S.td}>€{(p.avgPrice ?? 0).toFixed(2)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Guía rápida si no está conectado */}
                {ibkrStatus !== 'ok' && (
                  <div style={{ marginTop:12, padding:'10px 12px', background:'#1e293b', borderRadius:6, fontSize:'0.75rem', color:'#94a3b8', lineHeight:1.8 }}>
                    <div style={{ fontWeight:700, color:'#f8fafc', marginBottom:4 }}>Como conectar IBKR en 3 pasos:</div>
                    <div>1. Abre el Gateway que descargaste: ejecuta <span style={{ fontFamily:'monospace', color:'#60a5fa' }}>bin\run.bat root\conf.yaml</span></div>
                    <div>2. Ve a <span style={{ fontFamily:'monospace', color:'#60a5fa' }}>{ibkrGateway}</span> en el navegador y haz login con tus credenciales IBKR</div>
                    <div>3. Vuelve aquí y pulsa "Verificar conexión IBKR"</div>
                    <div style={{ marginTop:6, color:'#475569' }}>Nota: acepta el certificado autofirmado en el navegador (click en "Avanzado" → "Continuar")</div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {/* ── MODAL: Confirmar apertura de posición ───────────────── */}
      {openModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:999, padding:'1rem' }}>
          <div style={{ background:'#1e293b', border:'1px solid #334155', borderRadius:16, padding:'1.5rem', width:'100%', maxWidth:480 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'1rem' }}>
              <div>
                <div style={{ fontWeight:800, fontSize:'1.1rem', color:'#f8fafc' }}>
                  ⚡ Confirmar apertura — {openModal.asset.ticker}
                </div>
                <div style={{ fontSize:'0.72rem', color:'#64748b', marginTop:2 }}>
                  {openModal.asset.name} · Edita los precios con los que has ejecutado realmente en IBKR
                </div>
              </div>
              <button
                onClick={() => setOpenModal(null)}
                style={{ background:'none', border:'none', color:'#64748b', fontSize:'1.5rem', cursor:'pointer', lineHeight:1 }}
              >×</button>
            </div>

            {/* Precio sugerido vs precio real */}
            <div style={{ background:'#0f172a', borderRadius:8, padding:'0.75rem', marginBottom:'1rem', fontSize:'0.72rem', color:'#64748b', border:'1px solid #334155' }}>
              📌 Precio sugerido por el motor: <span style={{ color:'#60a5fa', fontWeight:700 }}>€{openModal.entryPrice.toFixed(2)}</span> ·
              ATR: <span style={{ color:'#60a5fa' }}>€{(openModal.asset.indicators?.atr14 ?? 0).toFixed(2)} ({openModal.asset.indicators ? (openModal.asset.indicators.atr14 / openModal.asset.price * 100).toFixed(2) : '0.00'}%/día)</span>
            </div>

            {/* Campos editables */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.6rem', marginBottom:'0.75rem' }}>
              {[
                { label:'Precio entrada real (€)', val:modalEntry, set:setModalEntry, color:'#e2e8f0', hint:'Precio al que ejecutaste la orden BUY en IBKR' },
                { label:'Stop Loss (€)',           val:modalStop,  set:setModalStop,  color:'#ef4444', hint:'Precio de stop — SAGRADO, no lo muevas abajo' },
                { label:'Take Profit 1 — 50% (€)', val:modalTP1,  set:setModalTP1,   color:'#22c55e', hint:'Al llegar aquí: vende 50% y sube stop a entrada' },
                { label:'Take Profit 2 — 50% (€)', val:modalTP2,  set:setModalTP2,   color:'#4ade80', hint:'Objetivo final del 50% restante' },
              ].map(({ label, val, set, color, hint }) => (
                <div key={label}>
                  <label style={{ fontSize:'0.68rem', color:'#64748b', display:'block', marginBottom:3 }}>
                    <span style={{ color, fontWeight:700 }}>{label}</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={val}
                    onChange={e => set(e.target.value)}
                    style={{ ...S.input, borderColor: color + '44' }}
                  />
                  <div style={{ fontSize:'0.62rem', color:'#475569', marginTop:2 }}>{hint}</div>
                </div>
              ))}
            </div>

            {/* Acciones */}
            <div>
              <label style={{ fontSize:'0.68rem', color:'#64748b', display:'block', marginBottom:3 }}>
                Número de acciones / participaciones
              </label>
              <input
                type="number"
                step="1"
                min="1"
                value={modalShares}
                onChange={e => setModalShares(e.target.value)}
                style={{ ...S.input, marginBottom:'0.5rem' }}
              />
            </div>

            {/* Resumen live del R:R con precios editados */}
            {(() => {
              const e = parseFloat(modalEntry);
              const s = parseFloat(modalStop);
              const t1 = parseFloat(modalTP1);
              const sh = parseFloat(modalShares);
              const risk   = e && s && e > s ? (e - s) * (sh || 0) : null;
              const reward = e && t1 && t1 > e ? (t1 - e) * (sh || 0) : null;
              const rr     = risk && risk > 0 && reward ? (reward / risk) : null;
              return (
                <div style={{ background:'#0f172a', borderRadius:6, padding:'8px 10px', marginBottom:'1rem', fontSize:'0.72rem', display:'flex', gap:16, flexWrap:'wrap' as const }}>
                  <span style={{ color:'#ef4444' }}>Riesgo: {risk != null ? eur(risk) : '—'}</span>
                  <span style={{ color:'#22c55e' }}>Ganancia TP1: {reward != null ? eur(reward) : '—'}</span>
                  <span style={{ color:'#60a5fa', fontWeight:700 }}>R:R = {rr != null ? rr.toFixed(2) : '—'}</span>
                  <span style={{ color:'#64748b' }}>Capital: {e && sh ? eur(e * sh) : '—'}</span>
                </div>
              );
            })()}

            <div style={{ display:'flex', gap:8 }}>
              <button
                onClick={handleConfirmOpen}
                style={{ ...S.btn, ...S.btnG, flex:1 }}
                disabled={!modalEntry || !modalStop || !modalTP1 || !modalTP2 || !modalShares || parseFloat(modalEntry) <= parseFloat(modalStop)}
              >
                ✅ Confirmar apertura
              </button>
              <button
                onClick={() => setOpenModal(null)}
                style={{ ...S.btn, ...S.btnGr }}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}