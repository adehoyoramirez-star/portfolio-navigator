// ════════════════════════════════════════════════════════════════
// ARCHIVO: src/dashboard/RealTimeMonitorPanel.tsx
// SPRINT 7: Monitoreo en Tiempo Real con Polling Adaptativo
// ════════════════════════════════════════════════════════════════
//
// PROPÓSITO:
//   Panel de monitoreo en vivo que muestra precios, señales y estado
//   del sistema con actualización periódica adaptativa, usando
//   el OlympusLiveMonitor como fuente de datos.
//
// POLLING ADAPTATIVO:
//   - Mercado abierto (lunes-viernes 15:30-22:00 UTC): cada 15s
//   - Fuera de horas: cada 60s
//   - Fin de semana: cada 300s
//   - Alertas activas o DCA opportunity: cada 10s
//   - STALE: cada 120s
// ════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useRef } from "react";
import { getLiveMonitor, type LiveMonitorState } from "@/core/monitor/liveMonitor";

export interface MonitorPanelProps {
  totalPortfolioValue: number;
  availableCash: number;
  prices?: Record<string, number>;
  onManualRefresh?: () => void;
  loading?: boolean;
  compact?: boolean;
}

interface PollingConfig {
  label: string;
  intervalMs: number;
  color: string;
}

function getPollingConfig(ms?: LiveMonitorState): PollingConfig {
  if (!ms) return { label: "INIT", intervalMs: 15000, color: "#6b7280" };
  const { connection, alerts, dcaOpportunities } = ms;
  if (connection.dataFreshness === "STALE")
    return { label: "STALE", intervalMs: 120000, color: "#ef4444" };
  const hasCritical = alerts.some((a) => a.level === "CRITICAL" && !a.dismissed);
  const hasDCA = dcaOpportunities.some((o) => o.active && o.confidence === "HIGH");
  if (hasCritical || hasDCA)
    return { label: "ALERT", intervalMs: 10000, color: "#f59e0b" };
  if (connection.dataFreshness === "DELAYED")
    return { label: "DELAYED", intervalMs: 30000, color: "#f59e0b" };
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const isOpen = day >= 1 && day <= 5 && hour >= 14.5 && hour < 21;
  if (isOpen) return { label: "LIVE", intervalMs: 15000, color: "#10b981" };
  if (day === 0 || day === 6)
    return { label: "WEEKEND", intervalMs: 300000, color: "#64748b" };
  return { label: "CLOSED", intervalMs: 60000, color: "#f59e0b" };
}

const fmtEUR = (v: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
const fmtPct = (v: number) => (v * 100).toFixed(1) + "%";

export default function RealTimeMonitorPanel({
  totalPortfolioValue,
  availableCash,
  onManualRefresh,
  loading,
  compact,
}: MonitorPanelProps) {
  const [monitorState, setMonitorState] = useState<LiveMonitorState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const initRef = useRef(false);

  useEffect(() => {
    const monitor = getLiveMonitor();
    if (!initRef.current) {
      initRef.current = true;
      monitor.start();
    }
    const unsub = monitor.subscribe(setMonitorState);
    return () => unsub();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (monitorState) setElapsed(0);
  }, [monitorState?.lastUpdate]);

  const pc = getPollingConfig(monitorState ?? undefined);
  const lastUpdate = monitorState?.lastUpdate
    ? new Date(monitorState.lastUpdate).toLocaleTimeString("es-ES")
    : "\u2014";

  const positions = monitorState?.positions ?? [];
  const totalEquity = monitorState?.totalEquity ?? totalPortfolioValue;
  const drawdown = monitorState?.drawdown;
  const rolling = monitorState?.rolling;
  const dcaOpps = monitorState?.dcaOpportunities ?? [];
  const alerts = monitorState?.alerts ?? [];
  const conn = monitorState?.connection;

  const activeAlerts = alerts.filter((a) => !a.dismissed);
  const criticalAlerts = activeAlerts.filter((a) => a.level === "CRITICAL");
  const warningAlerts = activeAlerts.filter((a) => a.level === "WARNING");
  const dcaAlerts = activeAlerts.filter((a) => a.level === "DCA_OPPORTUNITY");

  if (compact) {
    return (
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "4px 12px", background: "#0f172a",
          border: `1px solid ${pc.color}44`, borderRadius: 20,
          cursor: "pointer", fontSize: "0.75rem", color: "#94a3b8", userSelect: "none",
        }}
        title="Click para detalles de monitoreo en vivo"
      >
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: conn?.dataFreshness === "LIVE" ? "#10b981" : pc.color,
          display: "inline-block",
        }} />
        <span style={{ color: pc.color, fontWeight: 600 }}>{pc.label}</span>
        {criticalAlerts.length > 0 && (
          <span style={{ color: "#ef4444", fontWeight: 700 }}>
            {"\uD83D\uDD34"} {criticalAlerts.length}
          </span>
        )}
        {dcaAlerts.length > 0 && (
          <span style={{ color: "#10b981", fontWeight: 700 }}>
            {"\uD83C\uDFAF"} {dcaAlerts.length}
          </span>
        )}
      </div>
    );
  }

  return (
    <div style={{
      background: "#0f172a", border: `1px solid ${pc.color}33`,
      borderRadius: 10, marginBottom: "1rem", overflow: "hidden",
    }}>
      {/* Header */}
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "8px 14px", cursor: "pointer", userSelect: "none",
          background: "#1e293b",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "0.85rem" }}>{"\uD83D\uDCE1"}</span>
          <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#e2e8f0" }}>
            Monitoreo en Vivo
          </span>
          <span style={{
            fontSize: "0.65rem", padding: "2px 8px", borderRadius: 10,
            background: pc.color + "22", color: pc.color, fontWeight: 600,
          }}>
            {pc.label}
          </span>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: conn?.dataFreshness === "LIVE" ? "#10b981"
              : conn?.dataFreshness === "DELAYED" ? "#f59e0b" : "#ef4444",
            display: "inline-block",
          }} />
          {conn?.dataFreshness === "LIVE" && (
            <span style={{ fontSize: "0.62rem", color: "#10b981" }}>
              Yahoo {"\u00B7"} cada {pc.intervalMs / 1000}s
            </span>
          )}
          {elapsed > 0 && (
            <span style={{ fontSize: "0.62rem", color: "#64748b" }}>
              {"\u23F1"} {elapsed}s
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {onManualRefresh && (
            <button
              onClick={(e) => { e.stopPropagation(); onManualRefresh(); }}
              disabled={loading}
              style={{
                background: "transparent", border: "1px solid #374151",
                color: "#94a3b8", borderRadius: 6, padding: "3px 10px",
                fontSize: "0.7rem", cursor: "pointer",
              }}
            >
              {loading ? "..." : "\u21BB"}
            </button>
          )}
          <span style={{ fontSize: "0.65rem", color: "#475569" }}>{lastUpdate}</span>
          <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
            {expanded ? "\u25B2" : "\u25BC"}
          </span>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div style={{ padding: "10px 14px" }}>
          {/* Metrics grid */}
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
            gap: 8, marginBottom: 10,
          }}>
            {[
              { label: "Equity", value: fmtEUR(totalEquity), color: "#e2e8f0" },
              { label: "Cash", value: fmtEUR(monitorState?.cashBalance ?? availableCash), color: "#e2e8f0" },
              {
                label: "Drawdown",
                value: drawdown ? fmtPct(drawdown.currentDrawdown) : "\u2014",
                color: (drawdown?.currentDrawdown ?? 0) > 0.15 ? "#ef4444"
                  : (drawdown?.currentDrawdown ?? 0) > 0.08 ? "#f59e0b" : "#94a3b8",
              },
              {
                label: "Vol 20d",
                value: rolling ? fmtPct(rolling.volatility20d) : "\u2014",
                color: (rolling?.volatility20d ?? 0) > 0.25 ? "#ef4444"
                  : (rolling?.volatility20d ?? 0) > 0.18 ? "#f59e0b" : "#94a3b8",
              },
              {
                label: "Sharpe 20d",
                value: rolling ? rolling.sharpe20d.toFixed(2) : "\u2014",
                color: (rolling?.sharpe20d ?? 0) > 1.0 ? "#10b981"
                  : (rolling?.sharpe20d ?? 0) > 0.5 ? "#f59e0b" : "#94a3b8",
              },
              {
                label: "CVaR 95%",
                value: rolling ? fmtPct(rolling.cvar95_20d) : "\u2014",
                color: (rolling?.cvar95_20d ?? 0) > 0.12 ? "#ef4444"
                  : (rolling?.cvar95_20d ?? 0) > 0.06 ? "#f59e0b" : "#94a3b8",
              },
            ].map((m) => (
              <div key={m.label} style={{
                background: "#1e293b", borderRadius: 6, padding: "6px 10px",
                display: "flex", flexDirection: "column", gap: 2,
              }}>
                <span style={{ fontSize: "0.6rem", color: "#64748b", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {m.label}
                </span>
                <span style={{ fontSize: "0.85rem", fontWeight: 700, color: m.color, fontVariantNumeric: "tabular-nums" }}>
                  {m.value}
                </span>
              </div>
            ))}
          </div>

          {/* Alerts */}
          {activeAlerts.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {criticalAlerts.map((a) => (
                <div key={a.id} style={{ background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 6, padding: "6px 10px", marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 700, fontSize: "0.78rem", color: "#fca5a5" }}>
                      {"\uD83D\uDD34"} {a.message}
                    </span>
                    <button onClick={() => getLiveMonitor().dismissAlert(a.id)}
                      style={{ background: "transparent", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "0.7rem" }}>
                      {"\u2715"}
                    </button>
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "#fca5a5", marginTop: 2 }}>{a.detail.slice(0, 200)}</div>
                  {a.suggestedAction && (
                    <div style={{ fontSize: "0.68rem", color: "#fbbf24", marginTop: 3 }}>
                      {"\uD83D\uDCA1"} {a.suggestedAction.slice(0, 150)}
                    </div>
                  )}
                </div>
              ))}
              {warningAlerts.map((a) => (
                <div key={a.id} style={{ background: "#1c1107", border: "1px solid #78350f", borderRadius: 6, padding: "5px 10px", marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600, fontSize: "0.75rem", color: "#fbbf24" }}>
                      {"\u26A0\uFE0F"} {a.message}
                    </span>
                    <button onClick={() => getLiveMonitor().dismissAlert(a.id)}
                      style={{ background: "transparent", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "0.7rem" }}>
                      {"\u2715"}
                    </button>
                  </div>
                </div>
              ))}
              {dcaAlerts.map((a) => (
                <div key={a.id} style={{ background: "#022c22", border: "1px solid #065f46", borderRadius: 6, padding: "5px 10px", marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600, fontSize: "0.75rem", color: "#10b981" }}>
                      {"\uD83C\uDFAF"} {a.message}
                    </span>
                    <button onClick={() => getLiveMonitor().dismissAlert(a.id)}
                      style={{ background: "transparent", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "0.7rem" }}>
                      {"\u2715"}
                    </button>
                  </div>
                  <div style={{ fontSize: "0.68rem", color: "#6ee7b7", marginTop: 2 }}>{a.detail.slice(0, 150)}</div>
                </div>
              ))}
            </div>
          )}

          {/* DCA Opportunities */}
          {dcaOpps.filter((o) => o.active).length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: "0.7rem", fontWeight: 600, color: "#10b981", marginBottom: 4 }}>
                {"\uD83C\uDFAF"} Oportunidades DCA Activas
              </div>
              {dcaOpps.filter((o) => o.active).map((opp, i) => (
                <div key={opp.ticker + i} style={{
                  background: "#064e3b22", border: "1px solid #065f4622",
                  borderRadius: 6, padding: "6px 10px", marginBottom: 4,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem" }}>
                    <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{opp.ticker}</span>
                    <span style={{
                      color: opp.confidence === "HIGH" ? "#10b981"
                        : opp.confidence === "MEDIUM" ? "#f59e0b" : "#94a3b8",
                    }}>
                      {opp.confidence}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.68rem", color: "#94a3b8", marginTop: 2 }}>
                    {opp.reason} {"\u00B7"} EUR{"\u20AC"}{opp.suggestedAmount.toFixed(0)}
                    {" \u00D7"}{opp.multiplier.toFixed(1)} {"\u00B7"} Tranche {opp.tranche}/{opp.totalTranches}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Positions */}
          {positions.length > 0 && (
            <div>
              <div style={{ fontSize: "0.7rem", fontWeight: 600, color: "#64748b", marginBottom: 4 }}>
                Posiciones en Vivo ({positions.length})
              </div>
              <div style={{ display: "grid", gap: 4, maxHeight: 200, overflowY: "auto" }}>
                {positions.map((pos) => (
                  <div key={pos.ticker} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "4px 8px", background: "#1e293b", borderRadius: 4, fontSize: "0.72rem",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "#e2e8f0", fontWeight: 600, minWidth: 60 }}>{pos.ticker}</span>
                      <span style={{ color: "#94a3b8" }}>EUR{pos.livePrice.toFixed(2)}</span>
                      <span style={{
                        fontSize: "0.6rem",
                        color: pos.priceSource === "YAHOO" ? "#10b981"
                          : pos.priceSource === "MANUAL" ? "#60a5fa" : "#ef4444",
                      }}>
                        {pos.priceSource}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 10, color: pos.unrealizedPnL >= 0 ? "#10b981" : "#ef4444" }}>
                      <span>{pos.unrealizedPnL >= 0 ? "+" : ""}{fmtEUR(pos.unrealizedPnL)}</span>
                      <span>{pos.unrealizedPct >= 0 ? "+" : ""}{fmtPct(pos.unrealizedPct)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Connection status */}
          {conn && (
            <div style={{
              display: "flex", justifyContent: "space-between", marginTop: 8,
              paddingTop: 8, borderTop: "1px solid #1e293b", fontSize: "0.62rem", color: "#475569",
            }}>
              <span>
                Yahoo: <span style={{ color: conn.dataFreshness === "LIVE" ? "#10b981" : "#ef4444" }}>{conn.dataFreshness}</span>
                {" \u00B7"}Errores: {conn.consecutiveErrors}
                {conn.circuitBreakerOpen && (
                  <span style={{ color: "#ef4444" }}> {"\u00B7"} {"\u26D4"} Circuit breaker abierto</span>
                )}
              </span>
              <span>DCA activas: {dcaOpps.filter((o) => o.active).length}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
