// ============================================================
// src/dashboard/TacticalDashboard.tsx — v3 ELITE
// CORRECCIONES:
//   1. handleConfirmOpen: ahora calcula optimalDaysTP1/2 y
//      optimalProbTP1 usando calcOptimalHorizon sin cap duro.
//      Antes estos campos quedaban como undefined → PositionRow
//      fallaba al leer optimalDaysTP1 y siempre mostraba "día 10".
//   2. maxDaysAllowed en apertura manual: usa calcDynamicMaxDays
//      en vez del valor fijo state.config.maxDaysPerTrade.
//   3. PositionRow: muestra TP2 en la columna de niveles y en
//      el bloque de horizonte óptimo. Antes solo se mostraba TP1.
//   4. PositionRow: "fila de salud" incluye suggestedExit y
//      scaleUpAmount cuando aplica.
//   5. Posiciones de demo INTC y BAYN precargadas en initState
//      para que el dashboard muestre datos reales desde el primer render.
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
  calcExpectedDays, calcTimingScore,
  evaluatePositionHealth, type PositionHealth,
  getTacticalSummary,
} from '@/core/tactical/tacticalPortfolio';
import {
  calcOptimalHorizon,
  classifyAssetSpeed,
  calcDynamicMaxDays,
} from '@/core/tactical/tacticalSignals';
import {
  runTacticalScreener, defaultTacticalConfig, getScanModeCount,
} from '@/core/tactical/tacticalScreener';
import type { ScanMode } from '@/core/tactical/tacticalScreener';

// ── Estilos base ─────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page:  { background:'#0f172a', minHeight:'100vh', color:'#e2e8f0', fontFamily:'system-ui,sans-serif', padding:'1.5rem' },
  card:  { background:'#1e293b', border:'1px solid #334155', borderRadius:12, padding:'1.25rem', marginBottom:'1rem' },
  cardG: { background:'#1e293b', border:'2px solid #16a34a', borderRadius:12, padding:'1.25rem', marginBottom:'1rem' },
  cardR: { background:'#1e293b', border:'1px solid #ef4444', borderRadius:12, padding:'1.25rem', marginBottom:'1rem' },
  cardB: { background:'#1e293b', border:'1px solid #3b82f6', borderRadius:12, padding:'1.25rem', marginBottom:'1rem' },
  h2:   { fontSize:'1rem', fontWeight:700, color:'#f8fafc', marginBottom:'0.75rem', margin:0 },
  h3:   { fontSize:'0.85rem', fontWeight:700, color:'#94a3b8', letterSpacing:'0.05em', textTransform:'uppercase', margin:'0 0 0.5rem' },
  mGrid:  { display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:'0.6rem', marginBottom:'1rem' },
  metric: { background:'#0f172a', borderRadius:8, padding:'0.75rem 1rem', textAlign:'center', border:'1px solid #1e293b' },
  mVal:   { fontSize:'1.2rem', fontWeight:700, color:'#f8fafc' },
  mLbl:   { fontSize:'0.65rem', color:'#64748b', marginTop:2 },
  btn:    { padding:'0.5rem 1rem', borderRadius:6, fontWeight:700, cursor:'pointer', fontSize:'0.8rem', border:'none', transition:'opacity .15s' },
  btnB:   { background:'#1d4ed8', color:'#fff' },
  btnG:   { background:'#15803d', color:'#fff' },
  btnR:   { background:'#b91c1c', color:'#fff' },
  btnGr:  { background:'#334155', color:'#94a3b8' },
  badge:  { display:'inline-block', padding:'2px 8px', borderRadius:4, fontSize:'0.7rem', fontWeight:700 },
  input:  { background:'#0f172a', border:'1px solid #334155', borderRadius:6, color:'#f8fafc', fontSize:'0.8rem', padding:'0.4rem 0.6rem', width:'100%' },
  table:  { width:'100%', borderCollapse:'collapse' as const, fontSize:'0.78rem' },
  th:     { textAlign:'left' as const, padding:'6px 8px', background:'#0f172a', color:'#64748b', fontWeight:700, fontSize:'0.7rem', borderBottom:'1px solid #334155' },
  td:     { padding:'6px 8px', borderBottom:'1px solid #1e293b', color:'#e2e8f0', verticalAlign:'top' as const },
};

const clr = (v: number) => v >= 0 ? '#22c55e' : '#ef4444';
const pct = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const eur = (v: number | undefined | null) => `€${Math.round(v ?? 0).toLocaleString('es-ES')}`;

// ── Estadísticas de probabilidad ─────────────────────────────
function erfApprox(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-x*x);
  return x >= 0 ? y : -y;
}
function normCDF(z: number): number { return 0.5 * (1 + erfApprox(z / Math.SQRT2)); }
function calcSuccessProb(entry: number, target: number, atr: number, days: number): number {
  if (atr <= 0 || days <= 0 || target <= entry) return 0;
  const z = (target - entry) / (atr * Math.sqrt(days));
  return Math.max(0, Math.min(100, (1 - normCDF(z)) * 100));
}
function probColor(p: number): string {
  return p >= 50 ? '#22c55e' : p >= 25 ? '#f59e0b' : p >= 10 ? '#f97316' : '#ef4444';
}

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

// ── Posiciones de demo precargadas (INTC + BAYN) ─────────────
// Se insertan en el estado inicial si no hay estado guardado en localStorage.
// Los valores de horizonte óptimo se calculan en tiempo de ejecución
// usando calcOptimalHorizon sin cap duro.
function buildDemoPositions(): TacticalPosition[] {
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

  // INTC: 1 acc entrada €72.21, SL €57, TP1 €95, TP2 €138
  const intcEntry = 72.21, intcAtr = 72.21 * 0.021;
  const intcOpt1  = calcOptimalHorizon(intcEntry, 95,  intcAtr);
  const intcOpt2  = calcOptimalHorizon(intcEntry, 138, intcAtr);
  const intcMax   = Math.min(calcDynamicMaxDays(0.021), Math.max(5, Math.round(intcOpt2.days * 1.2)));
  const intc: TacticalPosition = {
    id: 'demo-intc-1',
    ticker: 'INTC', name: 'Intel Corporation',
    type: 'OVERSOLD_BOUNCE',
    entryDate: daysAgo(3),
    entryPrice: intcEntry,
    shares: 1,
    capitalRisked: intcEntry - 57,
    totalInvested: intcEntry,
    stopLoss: 57,
    takeProfit1: 95,
    takeProfit2: 138,
    status: 'OPEN',
    currentPrice: 68.40,
    exitDate: null, exitPrice: null, exitReason: null,
    unrealizedPnL: (68.40 - intcEntry) * 1,
    unrealizedPnLPct: (68.40 / intcEntry - 1) * 100,
    realizedPnL: null, realizedPnLPct: null,
    daysOpen: 3,
    maxDaysAllowed: intcMax,
    expectedDaysToTP1: calcExpectedDays(intcEntry, 95,  intcAtr, 'OVERSOLD_BOUNCE'),
    expectedDaysToTP2: calcExpectedDays(intcEntry, 138, intcAtr, 'OVERSOLD_BOUNCE'),
    daysToBreakeven: 4,
    timingScore: 0,
    optimalDaysTP1: intcOpt1.days,
    optimalDaysTP2: intcOpt2.days,
    optimalProbTP1: intcOpt1.prob,
  };

  // BAYN: 2 acc entrada €36.63. SL, TP1, TP2 calculados por motor.
  const baynEntry = 36.63, baynAtr = 36.63 * 0.019;
  const baynSL  = baynEntry - baynAtr * 2;
  const baynTP1 = baynEntry + (baynEntry - baynSL) * 1.2;
  const baynTP2 = baynEntry + (baynEntry - baynSL) * 1.8;
  const baynOpt1 = calcOptimalHorizon(baynEntry, baynTP1, baynAtr);
  const baynOpt2 = calcOptimalHorizon(baynEntry, baynTP2, baynAtr);
  const baynMax  = Math.min(calcDynamicMaxDays(0.019), Math.max(5, Math.round(baynOpt2.days * 1.2)));
  const bayn: TacticalPosition = {
    id: 'demo-bayn-1',
    ticker: 'BAYN', name: 'Bayer AG',
    type: 'MEAN_REVERSION',
    entryDate: daysAgo(1),
    entryPrice: baynEntry,
    shares: 2,
    capitalRisked: (baynEntry - baynSL) * 2,
    totalInvested: baynEntry * 2,
    stopLoss: parseFloat(baynSL.toFixed(2)),
    takeProfit1: parseFloat(baynTP1.toFixed(2)),
    takeProfit2: parseFloat(baynTP2.toFixed(2)),
    status: 'OPEN',
    currentPrice: 35.10,
    exitDate: null, exitPrice: null, exitReason: null,
    unrealizedPnL: (35.10 - baynEntry) * 2,
    unrealizedPnLPct: (35.10 / baynEntry - 1) * 100,
    realizedPnL: null, realizedPnLPct: null,
    daysOpen: 1,
    maxDaysAllowed: baynMax,
    expectedDaysToTP1: calcExpectedDays(baynEntry, baynTP1, baynAtr, 'MEAN_REVERSION'),
    expectedDaysToTP2: calcExpectedDays(baynEntry, baynTP2, baynAtr, 'MEAN_REVERSION'),
    daysToBreakeven: 2,
    timingScore: 0,
    optimalDaysTP1: baynOpt1.days,
    optimalDaysTP2: baynOpt2.days,
    optimalProbTP1: baynOpt1.prob,
  };

  return [intc, bayn];
}

// ════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ════════════════════════════════════════════════════════════
export default function TacticalDashboard() {
  const [state, setState] = useState<TacticalEngineState>(() => {
    const saved = loadTacticalState();
    if (saved) return saved;
    const base = initTacticalState(defaultTacticalConfig(300, 600));
    // Precarga INTC y BAYN si no hay estado guardado
    const demos = buildDemoPositions();
    const capitalUsed = demos.reduce((s: number, p: TacticalPosition) => s + p.totalInvested, 0);
    return {
      ...base,
      openPositions:    demos,
      capitalUsed,
      capitalAvailable: Math.max(0, base.config.tacticalCapitalEur - capitalUsed),
    };
  });

  const [loading, setLoading]   = useState(false);
  const [tab, setTab]           = useState<'opportunities' | 'positions' | 'history' | 'config'>('positions');
  const [error, setError]       = useState<string | null>(null);
  const [lastRun, setLastRun]   = useState<string | null>(state.lastScreened);
  const [scanMode, setScanMode] = useState<ScanMode>('core');

  // ── Modal "Confirmar apertura" con precios editables ────────
  const [openModal,   setOpenModal]   = useState<TacticalOpportunity | null>(null);
  const [modalEntry,  setModalEntry]  = useState('');
  const [modalStop,   setModalStop]   = useState('');
  const [modalTP1,    setModalTP1]    = useState('');
  const [modalTP2,    setModalTP2]    = useState('');
  const [modalShares, setModalShares] = useState('');

  // ── Modal "Añadir posición manual" ──────────────────────────
  const [manualModal,   setManualModal]   = useState(false);
  const [manualTicker,  setManualTicker]  = useState('INTC');
  const [manualName,    setManualName]    = useState('Intel Corporation');
  const [manualType,    setManualType]    = useState<string>('OVERSOLD_BOUNCE');
  const [manualEntry,   setManualEntry]   = useState('72.21');
  const [manualStop,    setManualStop]    = useState('57.00');
  const [manualTP1,     setManualTP1]     = useState('95.00');
  const [manualTP2,     setManualTP2]     = useState('138.00');
  const [manualShares,  setManualShares]  = useState('1');
  const [manualCurrent, setManualCurrent] = useState('68.40');

  // Config local editable
  const [cfgCapital,  setCfgCapital]  = useState(state.config.tacticalCapitalEur);
  const [cfgMinScore, setCfgMinScore] = useState(state.config.minScore);
  const [cfgMinRR,    setCfgMinRR]    = useState(state.config.minRiskReward);
  const [cfgMaxPos,   setCfgMaxPos]   = useState(state.config.maxOpenPositions);
  const [cfgRiskPct,  setCfgRiskPct]  = useState(state.config.riskPerTradePct * 100);
  const [cfgMA200,    setCfgMA200]    = useState(state.config.requireAboveMA200);

  // IBKR
  const [ibkrEnabled,   setIbkrEnabled]   = useState(() => localStorage.getItem('ibkr_enabled') === 'true');
  const [ibkrAccountId, setIbkrAccountId] = useState(() => localStorage.getItem('ibkr_account_id') ?? '');
  const [ibkrGateway,   setIbkrGateway]   = useState(() => localStorage.getItem('ibkr_gateway') ?? 'https://localhost:5000');
  const [ibkrStatus,    setIbkrStatus]    = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [ibkrMsg,       setIbkrMsg]       = useState<string>('');
  const [ibkrAccounts,  setIbkrAccounts]  = useState<string[]>([]);
  const [ibkrPositions, setIbkrPositions] = useState<any[]>([]);
  const [ibkrNLV,       setIbkrNLV]       = useState<number>(0);

  useEffect(() => { saveTacticalState(state); }, [state]);
  const summary = useMemo(() => getTacticalSummary(state), [state]);

  // Helper ventana óptima
  const getOptimalWindow = (optDays: number | undefined | null, currentDays: number) => {
    if (!optDays || optDays <= 0) return '';
    const start = Math.max(1, optDays - 2);
    const end   = optDays + 2;
    if (currentDays >= start && currentDays <= end) return `✅ En ventana óptima (día ${currentDays}/${optDays})`;
    if (currentDays < start) return `⏳ Ventana: días ${start}-${end}`;
    return `⚠️ Ventana cerrada (fue ${start}-${end})`;
  };

  // ── Screener ────────────────────────────────────────────────
  const runScreener = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await runTacticalScreener(supabase, state.config, scanMode);
      setState((prev: TacticalEngineState) => ({
        ...prev,
        opportunities: result.opportunities,
        lastScreened:  result.screennedAt,
      }));
      setLastRun(result.screennedAt);
      if (result.errors.length > 0) setError(`Datos parciales (${result.errors.length} activos sin datos)`);
    } catch (e: any) {
      setError(e?.message ?? 'Error en el screener');
    } finally {
      setLoading(false);
    }
  }, [state.config, scanMode]);

  // ── Abrir modal ─────────────────────────────────────────────
  const handleOpenModal = useCallback((opp: TacticalOpportunity) => {
    const riskPerSh = Math.max(0.01, opp.entryPrice - opp.stopLoss);
    const autoShares = Math.max(1, Math.floor(
      (state.config.tacticalCapitalEur * state.config.riskPerTradePct) / riskPerSh,
    ));
    setOpenModal(opp);
    setModalEntry(opp.entryPrice.toFixed(2));
    setModalStop(opp.stopLoss.toFixed(2));
    setModalTP1(opp.takeProfit1.toFixed(2));
    setModalTP2(opp.takeProfit2.toFixed(2));
    setModalShares(String(autoShares));
  }, [state.config]);

  // ── Confirmar apertura — CORRECCIÓN CRÍTICA ─────────────────
  // Antes: optimalDaysTP1/2 quedaban como undefined porque handleConfirmOpen
  // no los calculaba. Ahora se calculan con calcOptimalHorizon sin cap duro.
  // Antes: maxDaysAllowed usaba state.config.maxDaysPerTrade (fijo 10-30d).
  // Ahora: usa calcDynamicMaxDays desde el ATR del activo.
  const handleConfirmOpen = useCallback(() => {
    if (!openModal) return;
    const entry  = parseFloat(modalEntry);
    const stop   = parseFloat(modalStop);
    const tp1    = parseFloat(modalTP1);
    const tp2    = parseFloat(modalTP2);
    const shares = Math.max(1, parseInt(modalShares, 10) || 1);
    if (!entry || !stop || !tp1 || !tp2 || entry <= stop) return;

    const atr    = openModal.asset.indicators?.atr14 ?? (entry * 0.02);
    const atrPct = atr / Math.max(0.01, entry);

    // CORRECCIÓN: calcOptimalHorizon sin maxDays → usa dynMax interno
    const optTP1 = calcOptimalHorizon(entry, tp1, atr);
    const optTP2 = calcOptimalHorizon(entry, tp2, atr);

    // CORRECCIÓN: maxDaysAllowed usa dynMax, no el valor fijo del config
    const dynMax = calcDynamicMaxDays(atrPct);
    const maxDaysAllowed = Math.min(dynMax, Math.max(5, Math.round(optTP2.days * 1.2)));

    const riskPerSh     = Math.max(0.01, entry - stop);
    const capitalRisked = +(shares * riskPerSh).toFixed(2);
    const totalInvested = +(shares * entry).toFixed(2);

    const position: TacticalPosition = {
      id:               `pos-${Date.now()}`,
      ticker:           openModal.asset.ticker,
      name:             openModal.asset.name,
      type:             openModal.type,
      entryDate:        new Date().toISOString(),
      entryPrice:       entry,
      shares,
      capitalRisked,
      totalInvested,
      stopLoss:         stop,
      takeProfit1:      tp1,
      takeProfit2:      tp2,
      status:           'OPEN',
      currentPrice:     entry,
      exitDate:         null,
      exitPrice:        null,
      exitReason:       null,
      unrealizedPnL:    0,
      unrealizedPnLPct: 0,
      realizedPnL:      null,
      realizedPnLPct:   null,
      daysOpen:         0,
      maxDaysAllowed,
      expectedDaysToTP1: calcExpectedDays(entry, tp1, atr, openModal.type),
      expectedDaysToTP2: calcExpectedDays(entry, tp2, atr, openModal.type),
      daysToBreakeven:   calcExpectedDays(entry, tp1, atr, openModal.type),
      timingScore:       0,
      // CORRECCIÓN: campos antes undefined, ahora calculados correctamente
      optimalDaysTP1:    optTP1.days,
      optimalDaysTP2:    optTP2.days,
      optimalProbTP1:    optTP1.prob,
    };

    setState((prev: TacticalEngineState) => {
      const capitalUsed      = +(prev.capitalUsed + totalInvested).toFixed(2);
      const capitalAvailable = +(prev.capitalAvailable - totalInvested).toFixed(2);
      return { ...prev, openPositions: [...prev.openPositions, position], capitalUsed, capitalAvailable };
    });
    setOpenModal(null);
  }, [openModal, modalEntry, modalStop, modalTP1, modalTP2, modalShares]);

  // ── Cerrar posición ─────────────────────────────────────────
  const handleClose = useCallback((
    posId: string, exitPrice: number,
    reason: 'CLOSED_MANUAL' | 'CLOSED_TP' | 'CLOSED_SL',
  ) => {
    setState((prev: TacticalEngineState) => closePosition(prev, posId, exitPrice, reason));
  }, []);

  // ── Añadir posición manualmente (recuperar INTC u otras) ────
  const handleAddManual = useCallback(() => {
    const entry   = parseFloat(manualEntry);
    const stop    = parseFloat(manualStop);
    const tp1     = parseFloat(manualTP1);
    const tp2     = parseFloat(manualTP2);
    const curr    = parseFloat(manualCurrent) || entry;
    const shares  = Math.max(1, parseInt(manualShares, 10) || 1);
    if (!entry || !stop || !tp1 || !tp2 || entry <= stop) return;

    const atr    = entry * 0.021;
    const atrPct = atr / entry;
    const optTP1 = calcOptimalHorizon(entry, tp1, atr);
    const optTP2 = calcOptimalHorizon(entry, tp2, atr);
    const dynMax = calcDynamicMaxDays(atrPct);
    const maxDaysAllowed = Math.min(dynMax, Math.max(5, Math.round(optTP2.days * 1.2)));

    const position: TacticalPosition = {
      id:               `manual-${manualTicker.toLowerCase()}-${Date.now()}`,
      ticker:           manualTicker.trim().toUpperCase(),
      name:             manualName.trim(),
      type:             manualType as TacticalPosition['type'],
      entryDate:        new Date().toISOString(),
      entryPrice:       entry,
      shares,
      capitalRisked:    +((entry - stop) * shares).toFixed(2),
      totalInvested:    +(entry * shares).toFixed(2),
      stopLoss:         stop,
      takeProfit1:      tp1,
      takeProfit2:      tp2,
      status:           'OPEN',
      currentPrice:     curr,
      exitDate:         null, exitPrice: null, exitReason: null,
      unrealizedPnL:    +((curr - entry) * shares).toFixed(2),
      unrealizedPnLPct: +((curr / entry - 1) * 100).toFixed(2),
      realizedPnL:      null, realizedPnLPct: null,
      daysOpen:         0,
      maxDaysAllowed,
      expectedDaysToTP1: calcExpectedDays(entry, tp1, atr, manualType as TacticalPosition['type']),
      expectedDaysToTP2: calcExpectedDays(entry, tp2, atr, manualType as TacticalPosition['type']),
      daysToBreakeven:   calcExpectedDays(entry, tp1, atr, manualType as TacticalPosition['type']),
      timingScore:       0,
      optimalDaysTP1:    optTP1.days,
      optimalDaysTP2:    optTP2.days,
      optimalProbTP1:    optTP1.prob,
    };

    setState((prev: TacticalEngineState) => ({
      ...prev,
      openPositions:    [...prev.openPositions, position],
      capitalUsed:      +(prev.capitalUsed + position.totalInvested).toFixed(2),
      capitalAvailable: +Math.max(0, prev.capitalAvailable - position.totalInvested).toFixed(2),
    }));
    setManualModal(false);
  }, [manualTicker, manualName, manualType, manualEntry, manualStop, manualTP1, manualTP2, manualShares, manualCurrent]);

  // ── Aplicar config ──────────────────────────────────────────
  const applyConfig = useCallback(() => {
    setState((prev: TacticalEngineState) => {
      const newConfig: TacticalConfig = {
        ...prev.config,
        tacticalCapitalEur: cfgCapital,
        minScore:           cfgMinScore,
        minRiskReward:      cfgMinRR,
        maxOpenPositions:   cfgMaxPos,
        riskPerTradePct:    cfgRiskPct / 100,
        requireAboveMA200:  cfgMA200,
      };
      const capitalUsed = prev.openPositions.reduce((s: number, p: TacticalPosition) => s + (p.totalInvested ?? 0), 0);
      return { ...prev, config: newConfig, capitalUsed, capitalAvailable: Math.max(0, cfgCapital - capitalUsed) };
    });
  }, [cfgCapital, cfgMinScore, cfgMinRR, cfgMaxPos, cfgRiskPct, cfgMA200]);

  // ── IBKR ────────────────────────────────────────────────────
  const verifyIBKR = useCallback(async () => {
    setIbkrStatus('checking');
    setIbkrMsg('Conectando con el Gateway...');
    try {
      const authRes = await fetch(`${ibkrGateway}/v1/api/iserver/auth/status`, { credentials: 'include' });
      if (!authRes.ok) throw new Error(`Gateway no responde (${authRes.status}). ¿Está corriendo en ${ibkrGateway}?`);
      const auth = await authRes.json();
      if (!auth.authenticated) {
        setIbkrStatus('error');
        setIbkrMsg(`Gateway responde pero no autenticado. Ve a ${ibkrGateway} e inicia sesión.`);
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
      const nlv = parseFloat(sumData?.netliquidation?.amount ?? 0);
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
      setIbkrMsg(e?.message ?? 'Error desconocido');
      localStorage.setItem('ibkr_enabled', 'false');
    }
  }, [ibkrGateway, ibkrAccountId]);

  // ════════════════════════════════════════════════════════════
  // SUB-COMPONENTE: OpportunityCard
  // ════════════════════════════════════════════════════════════
  const OpportunityCard = ({ opp }: { opp: TacticalOpportunity }) => {
    const alreadyOpen = state.openPositions.some(p => p.ticker === opp.asset.ticker);
    const canOpen     = !alreadyOpen && state.openPositions.length < state.config.maxOpenPositions;
    const tc          = typeColors[opp.type] ?? '#64748b';
    const riskPerSh   = Math.max(0.01, opp.entryPrice - opp.stopLoss);
    const shares      = Math.max(1, Math.floor(
      (state.config.tacticalCapitalEur * state.config.riskPerTradePct) / riskPerSh,
    ));
    const riskEur     = riskPerSh * shares;
    const capitalUsed = opp.entryPrice * shares;
    const atrEur      = opp.asset.indicators?.atr14 ?? 0;
    const atrPct      = (opp.asset.price > 0 && opp.asset.indicators)
      ? (opp.asset.indicators.atr14 / opp.asset.price * 100) : 0;

    // CORRECCIÓN: calcOptimalHorizon sin maxDays → dynMax interno
    const optTP1 = calcOptimalHorizon(opp.entryPrice, opp.takeProfit1, atrEur);
    const optTP2 = calcOptimalHorizon(opp.entryPrice, opp.takeProfit2, atrEur);
    const probTP1 = optTP1.prob;
    const probTP2 = optTP2.prob;
    const sigmaND = atrEur * Math.sqrt(optTP1.days);

    const assetSpeedCls = atrPct > 0 ? classifyAssetSpeed(atrPct / 100) : 'MEDIUM';
    const verdict = assetSpeedCls === 'TOO_SLOW'
      ? { txt:'❌ Activo demasiado lento — no apto táctico', c:'#ef4444' }
      : probTP1 >= 40 ? { txt:'✅ Alta prob. en horizonte óptimo', c:'#22c55e' }
      : probTP1 >= 20 ? { txt:'⚡ Prob. moderada — válido', c:'#f59e0b' }
      : probTP1 >= 8  ? { txt:'⚠ Prob. baja — ampliar horizonte', c:'#f97316' }
      : { txt:'🔴 Improbable — revisar target o ATR', c:'#ef4444' };

    const speedLabels: Record<string, { label: string; color: string; bg: string }> = {
      FAST:     { label:'⚡ RÁPIDO',    color:'#22c55e', bg:'#052e16' },
      MEDIUM:   { label:'🎯 MEDIO',     color:'#60a5fa', bg:'#1e3a5f' },
      SLOW:     { label:'🐢 LENTO',     color:'#f59e0b', bg:'#422006' },
      TOO_SLOW: { label:'❌ MUY LENTO', color:'#ef4444', bg:'#450a0a' },
    };
    const sp = speedLabels[assetSpeedCls];

    return (
      <div style={{ ...S.card, borderLeft:`3px solid ${tc}`, marginBottom:'0.75rem' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'0.6rem' }}>
          <div>
            <span style={{ fontWeight:700, fontSize:'1rem', color:'#f8fafc' }}>{opp.asset.ticker}</span>
            <span style={{ color:'#64748b', fontSize:'0.75rem', marginLeft:8 }}>{opp.asset.name}</span>
            <span style={{ ...S.badge, background:tc+'22', color:tc, marginLeft:8 }}>{typeLabels[opp.type]}</span>
          </div>
          <div style={{ background:'#0f172a', borderRadius:20, width:40, height:40, display:'flex', alignItems:'center', justifyContent:'center', border:`2px solid ${opp.score >= 70 ? '#22c55e' : '#f59e0b'}` }}>
            <span style={{ fontWeight:700, fontSize:'0.8rem', color: opp.score >= 70 ? '#22c55e' : '#f59e0b' }}>{opp.score.toFixed(0)}</span>
          </div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:6, marginBottom:'0.6rem' }}>
          {[
            ['Entrada',    `€${opp.entryPrice.toFixed(2)}`,   '#e2e8f0'],
            ['Stop Loss',  `€${opp.stopLoss.toFixed(2)}`,      '#ef4444'],
            ['TP1 (50%)',  `€${opp.takeProfit1.toFixed(2)}`,   '#22c55e'],
            ['TP2 (50%)',  `€${opp.takeProfit2.toFixed(2)}`,   '#4ade80'],
            ['R:R',        `${opp.riskReward.toFixed(1)}:1`,   '#60a5fa'],
          ].map(([l, v, c]) => (
            <div key={l} style={{ background:'#0f172a', borderRadius:6, padding:'5px 8px', textAlign:'center', border:`1px solid ${l === 'Stop Loss' ? '#450a0a' : l.startsWith('TP') ? '#052e16' : '#1e293b'}` }}>
              <div style={{ fontSize:'0.6rem', color:'#64748b' }}>{l}</div>
              <div style={{ fontSize:'0.82rem', fontWeight:700, color: c }}>{v}</div>
            </div>
          ))}
        </div>

        <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:'0.6rem' }}>
          {opp.activeSignals.map(s => (
            <span key={s.type} style={{ ...S.badge, background:'#0f172a', color: s.strength === 'EXTREME' ? '#ef4444' : s.strength === 'STRONG' ? '#f59e0b' : '#60a5fa', border:'1px solid #334155' }}>
              {s.type.replace('_',' ')} {s.score.toFixed(2)}
            </span>
          ))}
        </div>

        <div style={{ fontSize:'0.72rem', color:'#64748b', marginBottom:'0.4rem', lineHeight:1.5 }}>
          {opp.asset.indicators && (
            <>RSI(2)={opp.asset.indicators.rsi2.toFixed(1)} · RSI(14)={opp.asset.indicators.rsi14.toFixed(1)} · Z={opp.asset.indicators.zScore20.toFixed(2)} · Vol×{opp.asset.indicators.volumeRatio.toFixed(1)}</>
          )}
        </div>

        {/* ATR + velocidad */}
        <div style={{ background:'#0f172a', borderRadius:6, padding:'4px 8px', marginBottom:'0.5rem', border:'1px solid #1e293b', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' as const }}>
          <span style={{ color:'#60a5fa', fontWeight:700 }}>ATR(14): €{atrEur.toFixed(2)} · {atrPct.toFixed(2)}%/día</span>
          {sp && (
            <span style={{ fontSize:'0.65rem', fontWeight:700, color:sp.color, background:sp.bg, padding:'1px 5px', borderRadius:3 }}>
              {sp.label}{assetSpeedCls === 'TOO_SLOW' ? ' — no apto' : ''}
            </span>
          )}
          <span style={{ color:'#334155' }}>|</span>
          <span style={{ color:'#475569', fontSize:'0.65rem' }}>stop = entrada − {opp.type === 'MOMENTUM_BREAKOUT' ? '1×' : opp.type === 'BLOOD_IN_STREETS' ? '1.5×' : '2×'}ATR</span>
        </div>

        {/* Horizonte óptimo dinámico TP1 + TP2 */}
        <div style={{ background:'#0f172a', borderRadius:8, padding:'8px 10px', marginBottom:'0.6rem', border:`1px solid ${probColor(probTP1)}44` }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:5 }}>
            <span style={{ fontSize:'0.65rem', color:'#64748b', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em' }}>
              🎯 Horizonte óptimo dinámico
            </span>
            <span style={{ fontSize:'0.7rem', fontWeight:700, color: verdict.c }}>{verdict.txt}</span>
          </div>

          {/* TP1 */}
          <div style={{ marginBottom:6 }}>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:'0.65rem', marginBottom:2 }}>
              <span style={{ color:'#22c55e', fontWeight:700 }}>
                TP1 (+{((opp.takeProfit1/opp.entryPrice-1)*100).toFixed(0)}%) — óptimo día {optTP1.days}
              </span>
              <span style={{ fontWeight:700, color: probColor(probTP1) }}>{probTP1.toFixed(1)}%</span>
            </div>
            <div style={{ background:'#1e293b', borderRadius:4, height:6, overflow:'hidden' }}>
              <div style={{ width:`${Math.min(100,probTP1)}%`, height:'100%', background: probColor(probTP1), borderRadius:4 }} />
            </div>
            {(() => {
              const showDays = Math.min(optTP1.probs.length, Math.max(15, optTP1.days + 5));
              const displayProbs = optTP1.probs.slice(0, showDays);
              const maxProb = Math.max(...displayProbs, 0.1);
              return (
                <div style={{ display:'flex', gap:1, marginTop:4, alignItems:'flex-end', height:22 }}>
                  {displayProbs.map((p, i) => {
                    const isOptimal = i + 1 === optTP1.days;
                    const heightPct = Math.max(8, (p / maxProb) * 100);
                    return (
                      <div key={i} style={{
                        flex:1, height:`${heightPct}%`,
                        background: isOptimal ? '#22c55e' : p > maxProb * 0.6 ? '#3b82f6' : '#1e293b',
                        borderRadius: isOptimal ? '2px 2px 0 0' : '1px',
                        border: isOptimal ? '1px solid #4ade80' : 'none',
                      }} title={`Día ${i+1}: ${p.toFixed(1)}%${i+1 === optTP1.days ? ' ← ÓPTIMO' : ''}`} />
                    );
                  })}
                </div>
              );
            })()}
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:'0.58rem', color:'#334155', marginTop:1 }}>
              <span>d1</span>
              {optTP1.days > 3 && <span style={{ color:'#22c55e' }}>d{optTP1.days}★</span>}
              <span>d{Math.min(optTP1.probs.length, Math.max(15, optTP1.days + 5))}</span>
            </div>
          </div>

          {/* TP2 — CORRECCIÓN: antes no se mostraba */}
          <div style={{ marginBottom:4 }}>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:'0.65rem', marginBottom:2 }}>
              <span style={{ color:'#4ade80', fontWeight:700 }}>
                TP2 (+{((opp.takeProfit2/opp.entryPrice-1)*100).toFixed(0)}%) — óptimo día {optTP2.days}
              </span>
              <span style={{ fontWeight:700, color: probColor(probTP2) }}>{probTP2.toFixed(1)}%</span>
            </div>
            <div style={{ background:'#1e293b', borderRadius:4, height:5, overflow:'hidden' }}>
              <div style={{ width:`${Math.min(100,probTP2)}%`, height:'100%', background: probColor(probTP2), borderRadius:4 }} />
            </div>
            {(() => {
              const showDays = Math.min(optTP2.probs.length, Math.max(15, optTP2.days + 5));
              const displayProbs = optTP2.probs.slice(0, showDays);
              const maxProb = Math.max(...displayProbs, 0.1);
              return (
                <div style={{ display:'flex', gap:1, marginTop:4, alignItems:'flex-end', height:18 }}>
                  {displayProbs.map((p, i) => {
                    const isOptimal = i + 1 === optTP2.days;
                    const heightPct = Math.max(8, (p / maxProb) * 100);
                    return (
                      <div key={i} style={{
                        flex:1, height:`${heightPct}%`,
                        background: isOptimal ? '#4ade80' : p > maxProb * 0.6 ? '#6366f1' : '#1e293b',
                        borderRadius: '1px',
                        border: isOptimal ? '1px solid #4ade80' : 'none',
                      }} title={`Día ${i+1}: ${p.toFixed(1)}%${i+1 === optTP2.days ? ' ← ÓPTIMO TP2' : ''}`} />
                    );
                  })}
                </div>
              );
            })()}
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:'0.58rem', color:'#334155', marginTop:1 }}>
              <span>d1</span>
              {optTP2.days > 3 && <span style={{ color:'#4ade80' }}>d{optTP2.days}★</span>}
              <span>d{Math.min(optTP2.probs.length, Math.max(15, optTP2.days + 5))}</span>
            </div>
          </div>

          <div style={{ marginTop:5, fontSize:'0.62rem', color:'#475569', display:'flex', gap:10, flexWrap:'wrap' as const }}>
            <span>σ({optTP1.days}d)=±€{sigmaND.toFixed(2)}</span>
            <span>·</span>
            <span>TP1 a {sigmaND>0?((opp.takeProfit1-opp.entryPrice)/sigmaND).toFixed(1):'—'}σ</span>
            <span>·</span>
            <span>TP2 a {sigmaND>0?((opp.takeProfit2-opp.entryPrice)/sigmaND).toFixed(1):'—'}σ</span>
            <span>·</span>
            <span style={{ color:'#94a3b8' }}>Horizonte: {optTP1.days}d / {optTP2.days}d</span>
          </div>
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

  // ════════════════════════════════════════════════════════════
  // SUB-COMPONENTE: PositionRow — con TP2, salud completa
  // ════════════════════════════════════════════════════════════
  const PositionRow = ({ pos }: { pos: TacticalPosition }) => {
    const [exitP,   setExitP]   = useState(pos.currentPrice.toFixed(2));
    const [currP,   setCurrP]   = useState(pos.currentPrice.toFixed(2));
    const [entryP,  setEntryP]  = useState(pos.entryPrice.toFixed(2));
    const [sharesP, setSharesP] = useState(String(pos.shares));
    const pnlColor = clr(pos.unrealizedPnL);
    const nearSL   = pos.currentPrice <= pos.stopLoss * 1.02;
    const nearTP   = pos.currentPrice >= pos.takeProfit1 * 0.97;
    const inGreen  = pos.currentPrice >= pos.entryPrice;

    // CORRECCIÓN: horizonte óptimo desde campos calculados correctamente
    const optTP1Days = (pos.optimalDaysTP1 ?? 0) > 0 ? pos.optimalDaysTP1! : (pos.expectedDaysToTP1 ?? 10);
    const optTP2Days = (pos.optimalDaysTP2 ?? 0) > 0 ? pos.optimalDaysTP2! : (pos.expectedDaysToTP2 ?? 15);

    const timing     = calcTimingScore(pos.daysOpen, optTP1Days);
    const timingClr  = timing <= 50 ? '#22c55e' : timing <= 90 ? '#f59e0b' : '#ef4444';
    const daysLeft   = Math.max(0, optTP1Days - pos.daysOpen);

    const dtbDays  = pos.daysToBreakeven ?? 0;
    const dtbLabel = inGreen ? '✅ En verde' : dtbDays > 0 ? `~${dtbDays}d para verde` : '—';

    // Motor de salud
    const health = evaluatePositionHealth(pos);
    const healthColors: Record<string, string> = {
      STRONG: '#22c55e', HOLDING: '#60a5fa', WEAKENING: '#f59e0b', ABANDON: '#ef4444',
    };
    const healthBg: Record<string, string> = {
      STRONG: '#052e16', HOLDING: '#1e3a5f', WEAKENING: '#422006', ABANDON: '#450a0a',
    };
    const hClr = healthColors[health.status] ?? '#94a3b8';
    const hBg  = healthBg[health.status]    ?? '#1e293b';
    const rowBg = nearTP ? '#052e16'
                : health.action === 'EXIT_NOW'  ? '#1c0505'
                : health.action === 'SCALE_UP'  ? '#052e16'
                : nearSL ? '#1c0505'
                : 'transparent';

    // Probabilidades actuales de TP1 y TP2
    const atrEst = pos.entryPrice * 0.02;
    const probTP1now = calcSuccessProb(pos.entryPrice, pos.takeProfit1, atrEst, optTP1Days);
    const probTP2now = calcSuccessProb(pos.entryPrice, pos.takeProfit2, atrEst, optTP2Days);

    return (
      <>
        <tr style={{ background: rowBg }}>
          {/* Activo */}
          <td style={S.td}>
            <div style={{ fontWeight:700 }}>{pos.ticker}</div>
            <div style={{ fontSize:'0.65rem', color:'#64748b' }}>{pos.name}</div>
            <span style={{ ...S.badge, background: typeColors[pos.type]+'22', color: typeColors[pos.type], marginTop:3 }}>
              {typeLabels[pos.type]}
            </span>
          </td>

          {/* Entrada — editable */}
          <td style={S.td}>
            <input type="number" step="0.01" value={entryP}
              onChange={e => setEntryP(e.target.value)}
              onBlur={() => {
                const v = parseFloat(entryP);
                if (v > 0) setState((prev: TacticalEngineState) => ({
                  ...prev,
                  openPositions: prev.openPositions.map((p: TacticalPosition) =>
                    p.id === pos.id ? {
                      ...p, entryPrice: v,
                      totalInvested: v * p.shares,
                      capitalRisked: (v - p.stopLoss) * p.shares,
                      unrealizedPnL: (p.currentPrice - v) * p.shares,
                      unrealizedPnLPct: (p.currentPrice / v - 1) * 100,
                    } : p)
                }));
              }}
              style={{ ...S.input, width:72, marginBottom:2 }} />
            <input type="number" step="1" min="0.000001" value={sharesP}
              onChange={e => setSharesP(e.target.value)}
              onBlur={() => {
                const v = parseFloat(sharesP);
                if (v > 0) setState((prev: TacticalEngineState) => ({
                  ...prev,
                  openPositions: prev.openPositions.map((p: TacticalPosition) =>
                    p.id === pos.id ? {
                      ...p, shares: v,
                      totalInvested: p.entryPrice * v,
                      capitalRisked: (p.entryPrice - p.stopLoss) * v,
                      unrealizedPnL: (p.currentPrice - p.entryPrice) * v,
                      unrealizedPnLPct: (p.currentPrice / p.entryPrice - 1) * 100,
                    } : p)
                }));
              }}
              style={{ ...S.input, width:72, marginBottom:2 }} />
            <div style={{ fontSize:'0.6rem', color:'#475569' }}>€{pos.totalInvested.toFixed(0)} inv.</div>
          </td>

          {/* Precio actual — editable */}
          <td style={S.td}>
            <input type="number" step="0.01" value={currP}
              onChange={e => setCurrP(e.target.value)}
              onBlur={() => {
                const v = parseFloat(currP);
                if (v > 0) {
                  setState((prev: TacticalEngineState) => ({
                    ...prev,
                    openPositions: prev.openPositions.map((p: TacticalPosition) =>
                      p.id === pos.id ? {
                        ...p, currentPrice: v,
                        unrealizedPnL: (v - p.entryPrice) * p.shares,
                        unrealizedPnLPct: (v / p.entryPrice - 1) * 100,
                      } : p)
                  }));
                  setExitP(v.toFixed(2));
                }
              }}
              style={{ ...S.input, width:72, marginBottom:2,
                color: parseFloat(currP) >= pos.entryPrice ? '#22c55e' : '#f8fafc',
                fontWeight: 700 }} />
            <div style={{ fontSize:'0.65rem', color: inGreen ? '#22c55e' : '#f59e0b' }}>
              {dtbLabel}
            </div>
          </td>

          {/* P&L */}
          <td style={S.td}>
            <div style={{ color:pnlColor, fontWeight:700 }}>
              {pos.unrealizedPnL >= 0 ? '+' : ''}{eur(pos.unrealizedPnL)}
            </div>
            <div style={{ fontSize:'0.7rem', color:pnlColor }}>{pct(pos.unrealizedPnLPct)}</div>
          </td>

          {/* Niveles — CORRECCIÓN: incluye TP2 */}
          <td style={S.td}>
            <div style={{ color:'#ef4444', fontSize:'0.72rem' }}>SL €{pos.stopLoss.toFixed(2)}</div>
            <div style={{ color:'#22c55e', fontSize:'0.72rem' }}>TP1 €{pos.takeProfit1.toFixed(2)}</div>
            <div style={{ color:'#4ade80', fontSize:'0.70rem' }}>TP2 €{pos.takeProfit2.toFixed(2)}</div>
            <div style={{ display:'flex', gap:4, marginTop:3 }}>
              <span style={{ fontSize:'0.58rem', color:'#22c55e', background:'#052e16', padding:'1px 4px', borderRadius:3 }}>
                {probTP1now.toFixed(0)}% TP1
              </span>
              <span style={{ fontSize:'0.58rem', color:'#4ade80', background:'#052e16', padding:'1px 4px', borderRadius:3 }}>
                {probTP2now.toFixed(0)}% TP2
              </span>
            </div>
          </td>

          {/* Timing con TP2 — CORRECCIÓN: muestra optTP2Days */}
          <td style={{ ...S.td, minWidth:145 }}>
            <div style={{ marginBottom:4 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:'0.62rem', marginBottom:2 }}>
                <span style={{ color:timingClr, fontWeight:700 }}>
                  {timing <= 50 ? '✅ En plazo' : timing <= 90 ? '⚡ Revisar' : '🔴 Tarde'}
                </span>
                <span style={{ color:'#64748b' }}>d{pos.daysOpen}/{optTP1Days}</span>
              </div>
              <div style={{ background:'#0f172a', borderRadius:3, height:5, overflow:'hidden' }}>
                <div style={{ width:`${Math.min(100,timing)}%`, height:'100%', background:timingClr, borderRadius:3 }}/>
              </div>
            </div>
            <div style={{ fontSize:'0.6rem', color:'#475569', lineHeight:1.5 }}>
              <div>~{daysLeft}d restantes TP1</div>
              <div style={{ color:'#4ade80' }}>TP2 óptimo: d{optTP2Days}</div>
              <div>Máx: {pos.maxDaysAllowed}d</div>
            </div>
          </td>

          {/* Acciones */}
          <td style={{ ...S.td, minWidth:175 }}>
            <div style={{ display:'flex', gap:4, alignItems:'center', marginBottom:4, flexWrap:'wrap' }}>
              <input style={{ ...S.input, width:68 }} type="number" value={exitP}
                onChange={e => setExitP(e.target.value)} step="0.01" />
              <button style={{ ...S.btn, ...S.btnG, padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => { setExitP(pos.takeProfit1.toFixed(2)); handleClose(pos.id, pos.takeProfit1, 'CLOSED_TP'); }}
                title={`Cerrar en TP1 €${pos.takeProfit1.toFixed(2)}`}>TP1</button>
              <button style={{ ...S.btn, background:'#14532d', color:'#86efac', border:'1px solid #22c55e', padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => { setExitP(pos.takeProfit2.toFixed(2)); handleClose(pos.id, pos.takeProfit2, 'CLOSED_TP'); }}
                title={`Cerrar en TP2 €${pos.takeProfit2.toFixed(2)}`}>TP2</button>
              <button style={{ ...S.btn, ...S.btnR, padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_SL')}
                title="Cerrar en Stop Loss">SL</button>
              <button style={{ ...S.btn, ...S.btnGr, padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_MANUAL')}
                title="Cierre manual al precio del input">M</button>
            </div>
            {health.suggestedExit && health.action === 'EXIT_NOW' && (
              <button onClick={() => handleClose(pos.id, health.suggestedExit!, 'CLOSED_MANUAL')}
                style={{ ...S.btn, background:'#7f1d1d', color:'#fca5a5', border:'1px solid #ef4444', width:'100%', padding:'3px 6px', fontSize:'0.65rem', marginBottom:2 }}>
                ⚡ Salida recomendada €{health.suggestedExit!.toFixed(2)}
              </button>
            )}
            {health.action === 'REDUCE_50' && (
              <div style={{ fontSize:'0.6rem', color:'#22c55e', marginTop:2 }}>
                📉 Vender 50% → precio TP1 €{pos.takeProfit1.toFixed(2)}
              </div>
            )}
            {health.action === 'SCALE_UP' && (
              <div style={{ fontSize:'0.6rem', color:'#22c55e', marginTop:2 }}>
                🚀 Añadir ~€{(health.scaleUpAmount ?? 0).toFixed(0)} si hay capital
              </div>
            )}
          </td>
        </tr>

        {/* Fila de salud expandida */}
        <tr>
          <td colSpan={7} style={{ padding:'0 8px 8px', background: rowBg }}>
            <div style={{
              background: hBg, border:`1px solid ${hClr}44`, borderRadius:6,
              padding:'8px 12px', display:'flex', justifyContent:'space-between',
              alignItems:'flex-start', gap:8,
            }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:'0.72rem', fontWeight:700, color:hClr, marginBottom:2 }}>
                  {health.reason}
                </div>
                <div style={{ fontSize:'0.65rem', color:'#64748b', lineHeight:1.5 }}>
                  {health.detail}
                </div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                <div style={{
                  fontSize:'0.6rem', color:hClr, fontWeight:700,
                  background: hClr + '22', padding:'2px 6px', borderRadius:4,
                }}>
                  {health.action.replace('_',' ')} · conf {health.confidence}%
                </div>
                {health.urgency === 'CRITICAL' && (
                  <div style={{ fontSize:'0.65rem', background:'#450a0a', color:'#fca5a5', padding:'2px 6px', borderRadius:4, fontWeight:700 }}>
                    🔴 CRÍTICO
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      </>
    );
  };

  // ════════════════════════════════════════════════════════════
  // RENDER PRINCIPAL
  // ════════════════════════════════════════════════════════════
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
        <button style={{ ...S.btn, ...S.btnB, opacity: loading ? 0.6 : 1 }}
          onClick={runScreener} disabled={loading}>
          {loading ? '⏳ Escaneando...' : '🔍 Escanear mercado'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background:'#450a0a', border:'1px solid #ef4444', borderRadius:8, padding:'0.6rem 1rem', marginBottom:'1rem', fontSize:'0.78rem', color:'#fca5a5' }}>
          ⚠️ {error}
        </div>
      )}

      {/* Alertas */}
      {summary.alertsToAction.length > 0 && (
        <div style={{ background:'#422006', border:'1px solid #f59e0b', borderRadius:8, padding:'0.75rem 1rem', marginBottom:'1rem' }}>
          <div style={{ fontWeight:700, color:'#fcd34d', fontSize:'0.8rem', marginBottom:4 }}>🔔 Alertas ({summary.alertsToAction.length})</div>
          {summary.alertsToAction.map((a, i) => (
            <div key={i} style={{ fontSize:'0.75rem', color:'#fde68a', marginTop:2 }}>{a}</div>
          ))}
        </div>
      )}

      {/* Métricas */}
      <div style={S.mGrid}>
        {[
          { l:'Capital táctico',  v:eur(state.config.tacticalCapitalEur), c:'#60a5fa' },
          { l:'Disponible',       v:eur(summary.capitalAvailable),        c:'#22c55e' },
          { l:'En posiciones',    v:eur(summary.capitalUsed),             c:'#f59e0b' },
          { l:'PnL no realizado', v:eur(summary.unrealizedPnL),           c:clr(summary.unrealizedPnL) },
          { l:'PnL realizado',    v:eur(summary.realizedPnL),             c:clr(summary.realizedPnL) },
          { l:'Win rate',         v:`${summary.winRate.toFixed(0)}%`,     c:summary.winRate >= 50 ? '#22c55e' : '#f59e0b' },
          { l:'Profit factor',    v:summary.profitFactor.toFixed(2),      c:summary.profitFactor >= 1.5 ? '#22c55e' : '#f59e0b' },
          { l:'Posiciones',       v:`${summary.openCount}/${state.config.maxOpenPositions}`, c:'#e2e8f0' },
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
          <button key={mode} onClick={() => setScanMode(mode)} style={{
            padding:'0.35rem 0.8rem', borderRadius:6, border:'1px solid #334155',
            background: scanMode === mode ? '#1d4ed8' : '#1e293b',
            color: scanMode === mode ? '#fff' : '#64748b',
            fontWeight:700, fontSize:'0.72rem', cursor:'pointer',
          }}>
            {mode === 'volatile' ? `⚡ RÁPIDO (${getScanModeCount('volatile')})`
             : mode === 'core'   ? `🎯 CORE (${getScanModeCount('core')})`
             : `📊 FULL (${getScanModeCount('full')})`}
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:'1rem' }}>
        {(['opportunities','positions','history','config'] as const).map(t => (
          <button key={t}
            style={{ ...S.btn, background: tab === t ? '#1d4ed8' : '#1e293b', color: tab === t ? '#fff' : '#64748b', border:'1px solid #334155' }}
            onClick={() => setTab(t)}>
            {t === 'opportunities' ? `🎯 Oportunidades (${state.opportunities.length})`
             : t === 'positions'   ? `📊 Posiciones (${state.openPositions.length})`
             : t === 'history'     ? `📋 Historial (${state.closedPositions.length})`
             : '⚙️ Configuración'}
          </button>
        ))}
      </div>

      {/* ── TAB: OPORTUNIDADES ── */}
      {tab === 'opportunities' && (
        <div>
          {state.opportunities.length === 0 ? (
            <div style={{ ...S.card, textAlign:'center', padding:'3rem' }}>
              <div style={{ fontSize:'2rem', marginBottom:'1rem' }}>🔍</div>
              <div style={{ color:'#64748b' }}>{loading ? 'Escaneando...' : 'Pulsa "Escanear mercado" para detectar oportunidades'}</div>
            </div>
          ) : (
            <>
              {state.opportunities.filter(o => o.score >= 70).length > 0 && (
                <div style={{ ...S.cardG, marginBottom:'1rem' }}>
                  <div style={{ fontWeight:700, color:'#4ade80', marginBottom:'0.5rem' }}>🏆 TOP PICKS — Score ≥ 70</div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(100px,1fr))', gap:6 }}>
                    {state.opportunities.filter((o: TacticalOpportunity) => o.score >= 70).slice(0,5).map((o: TacticalOpportunity) => (
                      <div key={o.id} style={{ background:'#052e16', borderRadius:8, padding:'8px 12px', textAlign:'center', border:'1px solid #16a34a' }}>
                        <div style={{ fontWeight:700, fontSize:'0.9rem', color:'#f8fafc' }}>{o.asset.ticker}</div>
                        <div style={{ fontSize:'0.65rem', color:'#64748b' }}>{typeLabels[o.type]}</div>
                        <div style={{ fontWeight:700, color:'#22c55e', fontSize:'1rem' }}>{o.score.toFixed(0)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {state.opportunities.map((opp: TacticalOpportunity) => <OpportunityCard key={opp.id} opp={opp} />)}
            </>
          )}
        </div>
      )}

      {/* ── TAB: POSICIONES ── */}
      {tab === 'positions' && (
        <div style={S.card}>
          {/* Botón añadir posición manual */}
          <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'0.75rem' }}>
            <button style={{ ...S.btn, background:'#1e3a5f', color:'#93c5fd', border:'1px solid #3b82f6', fontSize:'0.78rem' }}
              onClick={() => setManualModal(true)}>
              ➕ Añadir posición manual
            </button>
          </div>
          {state.openPositions.length === 0 ? (
            <div style={{ textAlign:'center', padding:'2rem', color:'#64748b' }}>
              No hay posiciones abiertas. Abre una desde la pestaña Oportunidades.
            </div>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {['Activo','Entrada','Precio actual','P&L','SL / TP1 / TP2','⏱ Timing + TP2','Cerrar'].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.openPositions.map((pos: TacticalPosition) => <PositionRow key={pos.id} pos={pos} />)}
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

      {/* ── TAB: HISTORIAL ── */}
      {tab === 'history' && (
        <div style={S.card}>
          {state.closedPositions.length === 0 ? (
            <div style={{ textAlign:'center', padding:'2rem', color:'#64748b' }}>Sin operaciones cerradas todavía.</div>
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
                  {[...state.closedPositions].reverse().map((pos: TacticalPosition) => {
                    const ClosedRow = () => {
                      const [exitEdit,  setExitEdit]  = useState((pos.exitPrice ?? 0).toFixed(2));
                      const [entryEdit, setEntryEdit] = useState(pos.entryPrice.toFixed(2));
                      const handleExitBlur = () => {
                        const v = parseFloat(exitEdit);
                        if (v > 0) setState((prev: TacticalEngineState) => ({
                          ...prev,
                          closedPositions: prev.closedPositions.map((p: TacticalPosition) => {
                            if (p.id !== pos.id) return p;
                            const pnl    = +(( v - p.entryPrice) * p.shares).toFixed(2);
                            const pnlPct = +((v / p.entryPrice - 1) * 100).toFixed(2);
                            return { ...p, exitPrice: v, realizedPnL: pnl, realizedPnLPct: pnlPct };
                          }),
                        }));
                      };
                      const handleEntryBlur = () => {
                        const v = parseFloat(entryEdit);
                        if (v > 0) setState((prev: TacticalEngineState) => ({
                          ...prev,
                          closedPositions: prev.closedPositions.map((p: TacticalPosition) => {
                            if (p.id !== pos.id) return p;
                            const ep  = pos.exitPrice ?? v;
                            const pnl    = +((ep - v) * p.shares).toFixed(2);
                            const pnlPct = +((ep / v - 1) * 100).toFixed(2);
                            return { ...p, entryPrice: v, realizedPnL: pnl, realizedPnLPct: pnlPct };
                          }),
                        }));
                      };
                      return (
                        <tr key={pos.id}>
                          <td style={S.td}><div style={{ fontWeight:700 }}>{pos.ticker}</div></td>
                          <td style={S.td}>
                            <span style={{ ...S.badge, background: typeColors[pos.type]+'22', color: typeColors[pos.type] }}>
                              {typeLabels[pos.type]}
                            </span>
                          </td>
                          {/* Entrada editable */}
                          <td style={S.td}>
                            <input type="number" step="0.01" value={entryEdit}
                              onChange={e => setEntryEdit(e.target.value)}
                              onBlur={handleEntryBlur}
                              style={{ ...S.input, width:72 }} />
                          </td>
                          {/* Salida editable */}
                          <td style={S.td}>
                            <input type="number" step="0.01" value={exitEdit}
                              onChange={e => setExitEdit(e.target.value)}
                              onBlur={handleExitBlur}
                              style={{ ...S.input, width:72,
                                color: parseFloat(exitEdit) >= pos.entryPrice ? '#22c55e' : '#ef4444',
                                fontWeight:700 }} />
                          </td>
                          <td style={{ ...S.td, fontWeight:700, color:clr(pos.realizedPnL ?? 0) }}>
                            {(pos.realizedPnL ?? 0) >= 0 ? '+' : ''}{eur(pos.realizedPnL ?? 0)}
                          </td>
                          <td style={{ ...S.td, color:clr(pos.realizedPnLPct ?? 0) }}>{pct(pos.realizedPnLPct ?? 0)}</td>
                          <td style={S.td}>{pos.daysOpen}d</td>
                          <td style={S.td}>
                            <span style={{ ...S.badge,
                              background: pos.status === 'CLOSED_TP' ? '#052e16' : pos.status === 'CLOSED_SL' ? '#450a0a' : '#1e293b',
                              color:      pos.status === 'CLOSED_TP' ? '#4ade80' : pos.status === 'CLOSED_SL' ? '#fca5a5' : '#94a3b8',
                            }}>
                              {pos.status === 'CLOSED_TP' ? '✅ TP' : pos.status === 'CLOSED_SL' ? '🛑 SL' : pos.status === 'CLOSED_TIME' ? '⏰ Tiempo' : '📤 Manual'}
                            </span>
                          </td>
                          <td style={S.td}>
                            <button
                              style={{ ...S.btn, background:'#1e3a5f', color:'#93c5fd', border:'1px solid #3b82f6', padding:'3px 7px', fontSize:'0.62rem' }}
                              title="Reabrir posición cerrada"
                              onClick={() => setState((prev: TacticalEngineState) => {
                                const pos2 = prev.closedPositions.find((p: TacticalPosition) => p.id === pos.id);
                                if (!pos2) return prev;
                                const reopened = { ...pos2, status: 'OPEN' as const, exitDate: null, exitPrice: null, exitReason: null, realizedPnL: null, realizedPnLPct: null };
                                return {
                                  ...prev,
                                  openPositions: [...prev.openPositions, reopened],
                                  closedPositions: prev.closedPositions.filter((p: TacticalPosition) => p.id !== pos.id),
                                };
                              })}>
                              🔄 Reabrir
                            </button>
                          </td>
                        </tr>
                      );
                    };
                    return <ClosedRow key={pos.id} />;
                  })}
                </tbody>
              </table>
            </div>
          )}
          {state.closedPositions.length > 0 && (
            <div style={{ marginTop:'1rem', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))', gap:8 }}>
              {[
                { l:'Operaciones', v:state.closedPositions.length },
                { l:'Ganadoras',   v:state.closedPositions.filter((p: TacticalPosition) => (p.realizedPnL ?? 0) > 0).length },
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

      {/* ── TAB: CONFIGURACIÓN ── */}
      {tab === 'config' && (
        <div style={S.card}>
          <h2 style={{ ...S.h2, marginBottom:'1rem' }}>⚙️ Configuración del Motor Táctico</h2>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1rem' }}>
            <div style={{ background:'#0f172a', borderRadius:8, padding:'1rem', border:'1px solid #334155' }}>
              <div style={S.h3}>Capital y riesgo</div>
              {[
                { label:'Capital táctico total (€)', val:cfgCapital,  set:(v:number)=>setCfgCapital(v),  step:50,  min:100 },
                { label:'Riesgo por operación (%)',  val:cfgRiskPct,  set:(v:number)=>setCfgRiskPct(v),  step:0.5, min:0.5, max:5 },
                { label:'Máx posiciones simultáneas', val:cfgMaxPos, set:(v:number)=>setCfgMaxPos(v),   step:1,   min:1,   max:10 },
              ].map(({ label, val, set, step, min, max }) => (
                <div key={label} style={{ marginBottom:8 }}>
                  <label style={{ fontSize:'0.75rem', color:'#64748b', display:'block', marginBottom:3 }}>{label}</label>
                  <input style={S.input} type="number" value={val} onChange={e => set(+e.target.value)} step={step} min={min} max={max} />
                </div>
              ))}
            </div>
            <div style={{ background:'#0f172a', borderRadius:8, padding:'1rem', border:'1px solid #334155' }}>
              <div style={S.h3}>Filtros de calidad</div>
              {[
                { label:'Score mínimo (0-100)', val:cfgMinScore, set:(v:number)=>setCfgMinScore(v), step:5, min:20, max:90 },
                { label:'R:R mínimo',           val:cfgMinRR,    set:(v:number)=>setCfgMinRR(v),    step:0.1, min:1, max:5 },
              ].map(({ label, val, set, step, min, max }) => (
                <div key={label} style={{ marginBottom:8 }}>
                  <label style={{ fontSize:'0.75rem', color:'#64748b', display:'block', marginBottom:3 }}>{label}</label>
                  <input style={S.input} type="number" value={val} onChange={e => set(+e.target.value)} step={step} min={min} max={max} />
                </div>
              ))}
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <input type="checkbox" checked={cfgMA200} onChange={e => setCfgMA200(e.target.checked)} id="ma200check"
                  style={{ width:16, height:16, cursor:'pointer', accentColor:'#22c55e' }} />
                <label htmlFor="ma200check" style={{ fontSize:'0.75rem', color:'#94a3b8', cursor:'pointer' }}>
                  Solo activos sobre MA200
                </label>
              </div>
            </div>
          </div>
          <div style={{ marginTop:'1rem', display:'flex', gap:8 }}>
            <button style={{ ...S.btn, ...S.btnG }} onClick={applyConfig}>✅ Aplicar configuración</button>
            <button style={{ ...S.btn, ...S.btnR }} onClick={() => {
              if (confirm('¿Borrar todo el historial y posiciones?')) {
                const fresh = initTacticalState(state.config);
                setState({ ...fresh, openPositions: state.openPositions });
                localStorage.removeItem('olympus_tactical_state');
              }
            }}>🗑 Reset completo</button>
          </div>

          {/* Reglas de operativa */}
          <div style={{ marginTop:'1.5rem', background:'#0f172a', borderRadius:8, padding:'1rem', border:'1px solid #334155' }}>
            <div style={{ ...S.h3, marginBottom:'0.75rem' }}>📋 Reglas de operativa</div>
            {[
              '🔒 Máximo 20% de la liquidez defensiva de Olympus en el motor táctico.',
              '⏰ Toda posición se cierra en su maxDaysAllowed dinámico (calculado por ATR del activo), nunca fijo.',
              '🚫 No abrir táctica en activo que Olympus esté comprando ese mes.',
              '📐 Mínimo R:R 1.3:1. Si el mercado no te da ese ratio, no operes.',
              '🐢 Activos con ATR < 0.8%/día (TOO_SLOW) no son aptos. El motor los marca y los excluye.',
              '💡 TP1 al 50% de la posición → subir stop a entrada. TP2 con el 50% restante con trailing.',
            ].map((r, i) => (
              <div key={i} style={{ fontSize:'0.75rem', color:'#94a3b8', lineHeight:1.7, borderBottom:'1px solid #1e293b', paddingBottom:4, marginBottom:4 }}>{r}</div>
            ))}
          </div>

          {/* IBKR */}
          <div style={{ marginTop:'1.5rem', background:'#0f172a', borderRadius:8, padding:'1rem', border:'1px solid #334155' }}>
            <div style={{ ...S.h3, marginBottom:'0.75rem' }}>🔌 Conexión IBKR</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
              <div>
                <label style={{ fontSize:'0.75rem', color:'#64748b', display:'block', marginBottom:3 }}>Gateway URL</label>
                <input style={S.input} value={ibkrGateway} onChange={e => setIbkrGateway(e.target.value)} />
              </div>
              <div>
                <label style={{ fontSize:'0.75rem', color:'#64748b', display:'block', marginBottom:3 }}>Account ID</label>
                <input style={S.input} value={ibkrAccountId} onChange={e => setIbkrAccountId(e.target.value)} />
              </div>
            </div>
            <button style={{ ...S.btn, ...S.btnB }} onClick={verifyIBKR} disabled={ibkrStatus === 'checking'}>
              {ibkrStatus === 'checking' ? '⏳ Conectando...' : '🔌 Verificar conexión IBKR'}
            </button>
            {ibkrMsg && (
              <div style={{ marginTop:8, fontSize:'0.75rem', color: ibkrStatus === 'ok' ? '#4ade80' : ibkrStatus === 'error' ? '#fca5a5' : '#94a3b8' }}>
                {ibkrMsg}
              </div>
            )}
            {ibkrStatus === 'ok' && ibkrPositions.length > 0 && (
              <div style={{ overflowX:'auto', marginTop:12 }}>
                <table style={S.table}>
                  <thead>
                    <tr>{['Activo','Qty','Precio','Valor','P&L','Avg'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {ibkrPositions.slice(0, 15).map((p: any, i: number) => {
                      const pnl = p.unrealizedPnl ?? 0;
                      return (
                        <tr key={i}>
                          <td style={S.td}><div style={{ fontWeight:700 }}>{p.ticker ?? p.contractDesc?.split(' ')[0] ?? '—'}</div></td>
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
            )}
          </div>
        </div>
      )}

      {/* ── MODAL: Añadir posición manual ── */}
      {manualModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.85)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:998, padding:'1rem' }}>
          <div style={{ background:'#1e293b', border:'1px solid #3b82f6', borderRadius:16, padding:'1.5rem', width:'100%', maxWidth:480 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'1rem' }}>
              <div>
                <div style={{ fontWeight:800, fontSize:'1.05rem', color:'#f8fafc' }}>➕ Añadir posición manual</div>
                <div style={{ fontSize:'0.7rem', color:'#64748b', marginTop:2 }}>Útil para recuperar posiciones perdidas (ej. INTC) o añadir cualquier operación</div>
              </div>
              <button onClick={() => setManualModal(false)} style={{ background:'none', border:'none', color:'#64748b', fontSize:'1.4rem', cursor:'pointer', lineHeight:1, padding:0 }}>×</button>
            </div>

            {/* Ticker / nombre / tipo */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:'0.5rem', marginBottom:'0.5rem' }}>
              <div>
                <div style={{ fontSize:'0.65rem', color:'#60a5fa', fontWeight:700, marginBottom:2 }}>Ticker</div>
                <input style={S.input} value={manualTicker} onChange={e => setManualTicker(e.target.value.toUpperCase())} placeholder="INTC" />
              </div>
              <div>
                <div style={{ fontSize:'0.65rem', color:'#94a3b8', fontWeight:700, marginBottom:2 }}>Nombre</div>
                <input style={S.input} value={manualName} onChange={e => setManualName(e.target.value)} placeholder="Intel Corporation" />
              </div>
            </div>

            <div style={{ marginBottom:'0.6rem' }}>
              <div style={{ fontSize:'0.65rem', color:'#94a3b8', fontWeight:700, marginBottom:2 }}>Tipo de operación</div>
              <select value={manualType} onChange={e => setManualType(e.target.value)}
                style={{ ...S.input, cursor:'pointer' }}>
                {Object.entries(typeLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>

            {/* Precios */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem', marginBottom:'0.5rem' }}>
              {([
                { label:'Entrada (€)',       val:manualEntry,   set:setManualEntry,   c:'#e2e8f0' },
                { label:'Precio actual (€)', val:manualCurrent, set:setManualCurrent, c:'#60a5fa' },
                { label:'Stop Loss (€)',     val:manualStop,    set:setManualStop,    c:'#ef4444' },
                { label:'Acciones',          val:manualShares,  set:setManualShares,  c:'#94a3b8' },
                { label:'Take Profit 1 (€)', val:manualTP1,     set:setManualTP1,     c:'#22c55e' },
                { label:'Take Profit 2 (€)', val:manualTP2,     set:setManualTP2,     c:'#4ade80' },
              ] as { label:string; val:string; set:(v:string)=>void; c:string }[]).map(({ label, val, set, c }) => (
                <div key={label}>
                  <div style={{ fontSize:'0.65rem', color:c, fontWeight:700, marginBottom:2 }}>{label}</div>
                  <input type="number" step="0.01" value={val} onChange={e => set(e.target.value)}
                    style={{ ...S.input, borderColor: c + '55' }} />
                </div>
              ))}
            </div>

            {/* Resumen R:R */}
            {(() => {
              const e = parseFloat(manualEntry), s = parseFloat(manualStop);
              const t1 = parseFloat(manualTP1), t2 = parseFloat(manualTP2);
              const sh = parseInt(manualShares, 10) || 1;
              const risk    = e > s ? (e - s) * sh : null;
              const reward1 = t1 > e ? (t1 - e) * sh : null;
              const reward2 = t2 > e ? (t2 - e) * sh : null;
              const rr1 = risk && reward1 ? (reward1 / risk) : null;
              const rr2 = risk && reward2 ? (reward2 / risk) : null;
              const valid = e > s && sh >= 1;
              return (
                <div style={{ background:'#0f172a', borderRadius:6, padding:'8px 10px', marginBottom:'1rem', fontSize:'0.72rem', display:'flex', gap:10, flexWrap:'wrap' as const, border:`1px solid ${valid ? '#16a34a' : '#ef4444'}` }}>
                  <span style={{ color:'#ef4444' }}>Riesgo: {risk != null ? eur(risk) : '—'}</span>
                  <span style={{ color:'#22c55e' }}>TP1: R:R {rr1?.toFixed(2) ?? '—'}</span>
                  <span style={{ color:'#4ade80' }}>TP2: R:R {rr2?.toFixed(2) ?? '—'}</span>
                  <span style={{ color:'#64748b' }}>Capital: {e && sh ? eur(e * sh) : '—'}</span>
                </div>
              );
            })()}

            <div style={{ display:'flex', gap:8 }}>
              <button onClick={handleAddManual}
                disabled={!manualEntry || !manualStop || !manualTP1 || !manualTP2 || parseFloat(manualEntry) <= parseFloat(manualStop)}
                style={{ ...S.btn, ...S.btnG, flex:1, opacity: (!manualEntry || parseFloat(manualEntry) <= parseFloat(manualStop)) ? 0.4 : 1 }}>
                ✅ Añadir posición
              </button>
              <button onClick={() => setManualModal(false)} style={{ ...S.btn, ...S.btnGr }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: Confirmar apertura ── */}
      {openModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:999, padding:'1rem' }}>
          <div style={{ background:'#1e293b', border:'1px solid #334155', borderRadius:16, padding:'1.5rem', width:'100%', maxWidth:460 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'1rem' }}>
              <div>
                <div style={{ fontWeight:800, fontSize:'1.05rem', color:'#f8fafc' }}>⚡ Abrir posición — {openModal.asset.ticker}</div>
                <div style={{ fontSize:'0.7rem', color:'#64748b', marginTop:2 }}>{openModal.asset.name} · Edita los precios reales ejecutados</div>
              </div>
              <button onClick={() => setOpenModal(null)} style={{ background:'none', border:'none', color:'#64748b', fontSize:'1.4rem', cursor:'pointer', lineHeight:1, padding:0 }}>×</button>
            </div>

            <div style={{ background:'#0f172a', borderRadius:6, padding:'6px 10px', marginBottom:'1rem', fontSize:'0.7rem', color:'#64748b', border:'1px solid #334155' }}>
              Motor sugiere: entrada <span style={{ color:'#60a5fa', fontWeight:700 }}>€{openModal.entryPrice.toFixed(2)}</span> ·
              ATR <span style={{ color:'#60a5fa' }}>€{(openModal.asset.indicators?.atr14 ?? 0).toFixed(2)}</span> ·
              tipo <span style={{ color: typeColors[openModal.type] ?? '#fff' }}>{typeLabels[openModal.type]}</span>
            </div>

            {/* Grid precios editables — incluye TP2 */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.6rem', marginBottom:'0.75rem' }}>
              {([
                { label:'Entrada real (€)',    val:modalEntry,  set:setModalEntry,  c:'#e2e8f0' },
                { label:'Stop Loss (€)',        val:modalStop,   set:setModalStop,   c:'#ef4444' },
                { label:'Take Profit 1 — 50%', val:modalTP1,    set:setModalTP1,    c:'#22c55e' },
                { label:'Take Profit 2 — 50%', val:modalTP2,    set:setModalTP2,    c:'#4ade80' },
              ] as { label:string; val:string; set:(v:string)=>void; c:string }[]).map(({ label, val, set, c }) => (
                <div key={label}>
                  <div style={{ fontSize:'0.65rem', color:c, fontWeight:700, marginBottom:2 }}>{label}</div>
                  <input type="number" step="0.01" value={val} onChange={e => set(e.target.value)}
                    style={{ ...S.input, borderColor: c + '55' }} />
                </div>
              ))}
            </div>

            <div style={{ marginBottom:'0.75rem' }}>
              <div style={{ fontSize:'0.65rem', color:'#94a3b8', fontWeight:700, marginBottom:2 }}>Número de acciones</div>
              <input type="number" step="1" min="1" value={modalShares} onChange={e => setModalShares(e.target.value)} style={S.input} />
            </div>

            {/* Resumen R:R en tiempo real */}
            {(() => {
              const e = parseFloat(modalEntry), s = parseFloat(modalStop);
              const t1 = parseFloat(modalTP1), t2 = parseFloat(modalTP2);
              const sh = parseInt(modalShares, 10) || 1;
              const risk    = e > s && e && s ? (e - s) * sh : null;
              const reward1 = e && t1 && t1 > e ? (t1 - e) * sh : null;
              const reward2 = e && t2 && t2 > e ? (t2 - e) * sh : null;
              const rr1     = risk && risk > 0 && reward1 ? reward1 / risk : null;
              const rr2     = risk && risk > 0 && reward2 ? reward2 / risk : null;
              const valid   = e > s && sh >= 1;
              return (
                <div style={{ background:'#0f172a', borderRadius:6, padding:'8px 10px', marginBottom:'1rem', fontSize:'0.72rem', display:'flex', gap:10, flexWrap:'wrap' as const, border:`1px solid ${valid ? '#16a34a' : '#ef4444'}` }}>
                  <span style={{ color:'#ef4444' }}>Riesgo: {risk != null ? eur(risk) : '—'}</span>
                  <span style={{ color:'#22c55e' }}>TP1: {reward1 != null ? '+' + eur(reward1) : '—'} (R:R {rr1?.toFixed(2) ?? '—'})</span>
                  <span style={{ color:'#4ade80' }}>TP2: {reward2 != null ? '+' + eur(reward2) : '—'} (R:R {rr2?.toFixed(2) ?? '—'})</span>
                  <span style={{ color:'#64748b' }}>Capital: {e && sh ? eur(e * sh) : '—'}</span>
                </div>
              );
            })()}

            <div style={{ display:'flex', gap:8 }}>
              <button onClick={handleConfirmOpen}
                disabled={!modalEntry || !modalStop || !modalTP1 || !modalTP2 || parseFloat(modalEntry) <= parseFloat(modalStop)}
                style={{ ...S.btn, ...S.btnG, flex:1, opacity: (!modalEntry || parseFloat(modalEntry) <= parseFloat(modalStop)) ? 0.4 : 1 }}>
                ✅ Confirmar apertura
              </button>
              <button onClick={() => setOpenModal(null)} style={{ ...S.btn, ...S.btnGr }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}