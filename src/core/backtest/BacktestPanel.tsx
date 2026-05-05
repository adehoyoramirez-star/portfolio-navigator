// ===============================================
// ARCHIVO: src/core/backtest/BacktestPanel.tsx
// CORREGIDO: IIFE para forzar recálculo del backtest
// ===============================================

import React, { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, AreaChart, Area,
} from "recharts";
import { runBacktest, BacktestOutput, BacktestMetrics, RegimeMetrics, PROXY_MAP } from "./backtestEngine";
import { MarketData } from "@/lib/marketData";
import { ASSETS } from "@/lib/constants";

interface BacktestPanelProps {
  marketData: MarketData | null;
  currentVix: number;
  currentCreditSpread: number;
  portfolioInitialValue: number;
}

const COLORS = {
  strategy: "#6366f1",
  benchmark: "#10b981",
  drawdown: "#ef4444",
  expansion: "#10b981",
  contraction: "#f59e0b",
  crisis: "#ef4444",
  rollingSharp: "#818cf8",
};

export default function BacktestPanel({
  marketData, currentVix, currentCreditSpread, portfolioInitialValue,
}: BacktestPanelProps) {

  const [rebalanceDays, setRebalanceDays] = useState(126);
  const [lookbackDays, setLookbackDays]   = useState(252);
  const [activeTab, setActiveTab]         = useState<"equity" | "regime" | "rolling">("equity");

  const availableDays = useMemo(() => {
    if (!marketData?.closesHistory) return 0;
    const allTickers = [...ASSETS.map(t => PROXY_MAP[t] ?? t), ...ASSETS];
    const lengths = allTickers.map(t => (marketData.closesHistory[t] ?? []).length);
    return Math.max(...lengths);
  }, [marketData]);

  // Cálculo del backtest SIN useMemo, ejecutado en cada render
  const result: BacktestOutput | null = (() => {
    if (!marketData?.closesHistory) return null;

    const length = marketData.closesHistory['BTC-EUR']?.length || 0;
    const vixCloses = marketData.closesHistory['^VIX'] ?? [];
    const spxCloses = marketData.closesHistory['^GSPC'] ?? marketData.closesHistory['SPY'] ?? [];
    
    const buildVixProxy = (closes: number[], targetLen: number): number[] => {
      if (closes.length < 22) return Array(targetLen).fill(currentVix);
      const vixProxy: number[] = [];
      for (let i = 0; i < closes.length - 1; i++) {
        if (closes[i] > 0 && closes[i + 1] > 0) {
          vixProxy.push(Math.log(closes[i + 1] / closes[i]));
        }
      }
      const result: number[] = [];
      for (let i = 0; i < vixProxy.length; i++) {
        const window = vixProxy.slice(Math.max(0, i - 21), i + 1);
        if (window.length < 5) { result.push(currentVix); continue; }
        const mean = window.reduce((s, v) => s + v, 0) / window.length;
        const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
        const annualVol = Math.sqrt(variance * 252);
        result.push(Math.max(10, Math.min(80, annualVol * 100)));
      }
      while (result.length < targetLen) result.unshift(currentVix);
      return result.slice(-targetLen);
    };

    const buildCreditProxy = (vixArr: number[]): number[] =>
      vixArr.map(v => Math.min(8, currentCreditSpread * Math.sqrt(Math.max(1, v / 17))));

    let vixHistorical: number[];
    if (vixCloses.length > 0) {
      const padded = [...vixCloses];
      while (padded.length < length) {
        padded.unshift(padded[0]);
      }
      vixHistorical = padded.slice(-length);
    } else {
      vixHistorical = buildVixProxy(spxCloses, length);
    }
    const creditHistorical = buildCreditProxy(vixHistorical);
    
    const macroHistory = {
      vix: vixHistorical,
      yieldSpread: Array(length).fill(0),
      creditSpread: creditHistorical,
    };
    
    return runBacktest({
      closesHistory: marketData.closesHistory,
      covMatrix: marketData.covMatrix,
      macroHistory,
      lookbackDays,
      rebalanceDays,
      initialCapital: portfolioInitialValue > 0 ? portfolioInitialValue : 10_000,
      transactionCostBps: 10,
    });
  })();

  if (!marketData) {
    return (
      <div style={styles.card}>
        <h2>📈 Backtesting — Nivel 4</h2>
        <p style={{ color: "#9ca3af" }}>Pulsa "Actualizar datos" para cargar el histórico desde Supabase.</p>
      </div>
    );
  }

  if (!result || result.dailyRecords.length === 0) {
    return (
      <div style={styles.card}>
        <h2>📈 Backtesting — Nivel 4</h2>
        <p style={{ color: "#f59e0b" }}>
          Datos insuficientes. Disponible: <strong>{availableDays} días</strong> con proxies.
          Necesario: mínimo 90 días.
        </p>
      </div>
    );
  }

  const { metrics: m, benchmarkMetrics: b, regimeConditional: rc, regimeDays } = result;
  const totalDays = result.dailyRecords.length;
  const years = (totalDays / 252).toFixed(1);

  const fmt = (v: number) => `${(v * 100).toFixed(1)}%`;

  const step = Math.max(1, Math.floor(totalDays / 300));
  const chartData = result.dailyRecords
    .filter((_, i) => i % step === 0)
    .map(r => ({
      day:              r.day,
      strategy:         +r.portfolioValue.toFixed(2),
      benchmark:        +(portfolioInitialValue * Math.pow(1 + b.cagr, r.day / 252)).toFixed(2),
      drawdown:         +(r.drawdown * 100).toFixed(2),
      rollingSharp:     r.rolling252Sharpe != null ? +r.rolling252Sharpe.toFixed(2) : null,
      regimeColor:      r.regime === "CRISIS" ? "#ef4444" : r.regime === "CONTRACTION" ? "#f59e0b" : "#10b981",
    }));

  const exportCSV = () => {
    const header = "Día,Valor,Benchmark,Drawdown,Sharpe252d,Régimen\n";
    const rows = result.dailyRecords
      .filter((_, i) => i % step === 0)
      .map(r => `${r.day},${r.portfolioValue.toFixed(2)},${(portfolioInitialValue * Math.pow(1 + b.cagr, r.day / 252)).toFixed(2)},${(r.drawdown * 100).toFixed(2)},${r.rolling252Sharpe?.toFixed(2) ?? ""},${r.regime}`)
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "olympus_backtest.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const totalRegimeDays = Object.values(regimeDays).reduce((a, b) => a + b, 0) || 1;

  return (
    <div style={styles.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>📈 Backtesting Walk-Forward — {totalDays} días ({years} años)</h2>
        <button onClick={exportCSV} style={styles.exportBtn}>⬇ Exportar CSV</button>
      </div>

      <div style={styles.proxyBar}>
        <span style={{ color: "#9ca3af", fontSize: "0.8rem" }}>
          🔄 Proxies: EEM (EMXC) · QUAL (IS3Q) · GLD (PPFB) · URA (URNU) · SMH (VVSM) · QQQ (XNAS) · BTC-EUR directo
        </span>
        <span style={{ color: "#6b7280", fontSize: "0.75rem", marginLeft: "1rem" }}>
          {result.daysWithProxies}d proxies · {result.daysWithRealData}d ETFs reales
        </span>
        {result.totalTransactionCosts > 0 && (
          <span style={{ color: "#f59e0b", fontSize: "0.75rem", marginLeft: "1rem" }}>
            💸 Costes transacción: −€{result.totalTransactionCosts.toFixed(0)} acum.
            ({result.rebalanceCount} rebalanceos × {result.transactionCostBps}bps)
            · CAGR neto ya incluye estos costes
          </span>
        )}
      </div>

      {totalDays < 504 && (
        <div style={{ ...styles.alert, borderColor: "#ef4444", backgroundColor: "#7f1d1d" }}>
          ⛔ Solo {totalDays} días — resultados NO fiables. Necesario mínimo 504 días (2 años).
        </div>
      )}
      {totalDays >= 504 && totalDays < 1260 && (
        <div style={{ ...styles.alert, borderColor: "#f59e0b", backgroundColor: "#78350f" }}>
          ⚠️ {totalDays} días ({years} años) — fiabilidad moderada. Ideal: 5+ años para incluir crisis.
        </div>
      )}
      {totalDays >= 1260 && (
        <div style={{ ...styles.alert, borderColor: "#10b981", backgroundColor: "#064e3b" }}>
          ✅ {totalDays} días ({years} años) — estadísticamente robusto.
        </div>
      )}

      <div style={{ display: "flex", gap: "2rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <label style={styles.label}>
          Rebalanceo cada
          <select value={rebalanceDays} onChange={e => setRebalanceDays(Number(e.target.value))} style={styles.select}>
            <option value={5}>5 días</option>
            <option value={21}>21 días (mensual)</option>
            <option value={63}>63 días (trimestral)</option>
            <option value={126}>126 días (semestral)</option>
          </select>
        </label>
        <label style={styles.label}>
          Lookback
          <select value={lookbackDays} onChange={e => setLookbackDays(Number(e.target.value))} style={styles.select}>
            <option value={126}>6 meses</option>
            <option value={252}>1 año</option>
            <option value={504}>2 años</option>
          </select>
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", margin: "1rem 0" }}>
        <MetricsCard title="🟣 Olympus Engine" metrics={m} color={COLORS.strategy} />
        <MetricsCard title="⚖️ Equal Weight B&H" metrics={b} color={COLORS.benchmark} />
      </div>

      <div style={styles.alphaBar}>
        <span>Alpha vs benchmark:</span>
        <span style={{ color: m.cagr > b.cagr ? "#10b981" : "#ef4444", fontWeight: "bold", marginLeft: "0.5rem" }}>
          {m.cagr > b.cagr ? "+" : ""}{fmt(m.cagr - b.cagr)} CAGR · {(m.sharpe - b.sharpe).toFixed(2)} Sharpe
        </span>
        {m.maxDrawdown < b.maxDrawdown && (
          <span style={{ color: "#f59e0b", fontSize: "0.8rem", marginLeft: "1rem" }}>
            ⚠️ Mayor drawdown ({fmt(m.maxDrawdown)} vs {fmt(b.maxDrawdown)})
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", margin: "1rem 0 0.5rem" }}>
        {(["equity", "regime", "rolling"] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            ...styles.tab,
            backgroundColor: activeTab === tab ? "#4f46e5" : "#1f2937",
            color: activeTab === tab ? "#fff" : "#9ca3af",
          }}>
            {tab === "equity" ? "📈 Capital" : tab === "regime" ? "🏛️ Régimen" : "📊 Rolling Sharpe"}
          </button>
        ))}
      </div>

      {activeTab === "equity" && (
        <>
          <h3 style={styles.chartTitle}>Curva de capital (€)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="day" stroke="#9ca3af" fontSize={11} tickFormatter={d => `D${d}`} />
              <YAxis stroke="#9ca3af" fontSize={11} tickFormatter={v => `€${v.toLocaleString()}`} />
              <Tooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 6 }} />
              <Legend />
              <Line type="monotone" dataKey="strategy" stroke={COLORS.strategy} dot={false} strokeWidth={2} name="Olympus" />
              <Line type="monotone" dataKey="benchmark" stroke={COLORS.benchmark} dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="Equal Weight" />
            </LineChart>
          </ResponsiveContainer>
          <h3 style={styles.chartTitle}>Drawdown (%)</h3>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="day" stroke="#9ca3af" fontSize={11} tickFormatter={d => `D${d}`} />
              <YAxis stroke="#9ca3af" fontSize={11} tickFormatter={v => `${v}%`} />
              <Tooltip />
              <ReferenceLine y={-20} stroke="#f59e0b" strokeDasharray="3 3" />
              <ReferenceLine y={-35} stroke="#ef4444" strokeDasharray="3 3" />
              <Area type="monotone" dataKey="drawdown" stroke={COLORS.drawdown} fill="#ef444422" dot={false} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </>
      )}

      {activeTab === "regime" && (
        <>
          <div style={{ display: "flex", gap: "0.75rem", margin: "1rem 0", flexWrap: "wrap" }}>
            {(["EXPANSION", "CONTRACTION", "CRISIS"] as const).map(r => (
              <div key={r} style={{ flex: 1, minWidth: 120, backgroundColor: "#1f2937", borderRadius: 6, padding: "0.5rem 0.75rem",
                borderLeft: `3px solid ${r === "CRISIS" ? COLORS.crisis : r === "CONTRACTION" ? COLORS.contraction : COLORS.expansion}` }}>
                <p style={{ color: r === "CRISIS" ? COLORS.crisis : r === "CONTRACTION" ? COLORS.contraction : COLORS.expansion,
                  fontWeight: "bold", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{r}</p>
                <p style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
                  {regimeDays[r]}d · {((regimeDays[r] / totalRegimeDays) * 100).toFixed(0)}% del período
                </p>
              </div>
            ))}
          </div>
          <p style={{ color: "#9ca3af", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            ¿Cómo rinde el motor en cada entorno macro? (pregunta clave para validación institucional)
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #374151", color: "#6b7280" }}>
                  <th style={{ textAlign: "left",  padding: "0.4rem 0.5rem" }}>Régimen</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>CAGR</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Sharpe</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Max DD</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Volatilidad</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Días</th>
                </tr>
              </thead>
              <tbody>
                {(["EXPANSION", "CONTRACTION", "CRISIS"] as const).map(r => {
                  const rm: RegimeMetrics = rc[r];
                  const color = r === "CRISIS" ? COLORS.crisis : r === "CONTRACTION" ? COLORS.contraction : COLORS.expansion;
                  return (
                    <tr key={r} style={{ borderBottom: "1px solid #1f2937" }}>
                      <td style={{ padding: "0.5rem", fontWeight: "bold", color }}>{r}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right", color: rm.cagr >= 0.05 ? "#10b981" : rm.cagr >= 0 ? "#f59e0b" : "#ef4444" }}>
                        {fmt(rm.cagr)}
                      </td>
                      <td style={{ padding: "0.5rem", textAlign: "right", color: rm.sharpe >= 0.5 ? "#10b981" : rm.sharpe >= 0 ? "#f59e0b" : "#ef4444" }}>
                        {rm.sharpe.toFixed(2)}
                      </td>
                      <td style={{ padding: "0.5rem", textAlign: "right", color: rm.maxDrawdown > -0.15 ? "#10b981" : rm.maxDrawdown > -0.30 ? "#f59e0b" : "#ef4444" }}>
                        {fmt(rm.maxDrawdown)}
                      </td>
                      <td style={{ padding: "0.5rem", textAlign: "right", color: "#9ca3af" }}>
                        {fmt(rm.volatility)}
                      </td>
                      <td style={{ padding: "0.5rem", textAlign: "right", color: "#6b7280" }}>
                        {rm.totalDays > 0 ? rm.totalDays : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: "1rem", backgroundColor: "#1f2937", borderRadius: 6, padding: "0.75rem 1rem", fontSize: "0.8rem", color: "#9ca3af" }}>
            <p style={{ fontWeight: "bold", color: "#f9fafb", marginBottom: "0.25rem" }}>Interpretación:</p>
            {rc.CRISIS.totalDays > 0 && rc.CRISIS.maxDrawdown < 0 && (
              <p>• En periodos de CRISIS el motor {rc.CRISIS.maxDrawdown > -0.25 ? `limitó el drawdown al ${fmt(rc.CRISIS.maxDrawdown)} ✅` : `sufrió un drawdown de ${fmt(rc.CRISIS.maxDrawdown)} ⚠️ — revisar calibración del tail risk`}</p>
            )}
            {rc.CRISIS.totalDays === 0 && <p>• No hay suficientes días en régimen CRISIS en el período — añadir más histórico (goal: incluir 2008 o 2020).</p>}
            {rc.EXPANSION.sharpe > 0.5 && rc.CRISIS.sharpe < rc.EXPANSION.sharpe && <p>• Sharpe en EXPANSION ({rc.EXPANSION.sharpe.toFixed(2)}) &gt; CRISIS ({rc.CRISIS.sharpe.toFixed(2)}) — motor funcionando correctamente. ✅</p>}
            {rc.CONTRACTION.cagr > 0 && <p>• Motor mantiene retorno positivo en CONTRACTION ({fmt(rc.CONTRACTION.cagr)} CAGR) — buen balance riesgo/retorno.</p>}
          </div>
        </>
      )}

      {activeTab === "rolling" && (
        <>
          <p style={{ color: "#9ca3af", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            Sharpe ratio móvil de 252 días. Indica si el motor está añadiendo valor consistentemente en el tiempo.
            Valor &gt; 0.5 = bueno · &gt; 1.0 = excelente · &lt; 0 = el motor destruye valor en ese período.
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData.filter(d => d.rollingSharp != null)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="day" stroke="#9ca3af" fontSize={11} tickFormatter={d => `D${d}`} />
              <YAxis stroke="#9ca3af" fontSize={11} domain={[-2, 3]} />
              <Tooltip />
              <ReferenceLine y={0}   stroke="#6b7280" strokeDasharray="3 3" />
              <ReferenceLine y={0.5} stroke="#f59e0b" strokeDasharray="4 2" />
              <ReferenceLine y={1.0} stroke="#10b981" strokeDasharray="4 2" />
              <Line type="monotone" dataKey="rollingSharp" stroke={COLORS.rollingSharp} dot={false} strokeWidth={2} name="Sharpe 252d" />
            </LineChart>
          </ResponsiveContainer>
          {(() => {
            const validSharpes = chartData.map(d => d.rollingSharp).filter(v => v != null) as number[];
            if (validSharpes.length === 0) return null;
            const avg = validSharpes.reduce((a, b) => a + b, 0) / validSharpes.length;
            const pctPos = validSharpes.filter(v => v > 0).length / validSharpes.length;
            const min = Math.min(...validSharpes);
            const max = Math.max(...validSharpes);
            return (
              <div style={{ display: "flex", gap: "1rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
                {[
                  { label: "Sharpe medio", value: avg.toFixed(2), ok: avg > 0.5 },
                  { label: "% períodos > 0", value: `${(pctPos * 100).toFixed(0)}%`, ok: pctPos > 0.7 },
                  { label: "Mínimo", value: min.toFixed(2), ok: min > -0.5 },
                  { label: "Máximo", value: max.toFixed(2), ok: true },
                ].map(({ label, value, ok }) => (
                  <div key={label} style={{ backgroundColor: "#1f2937", borderRadius: 6, padding: "0.5rem 0.75rem", fontSize: "0.8rem" }}>
                    <p style={{ color: "#6b7280" }}>{label}</p>
                    <p style={{ fontWeight: "bold", color: ok ? "#10b981" : "#f59e0b" }}>{value}</p>
                  </div>
                ))}
              </div>
            );
          })()}
        </>
      )}

      <p style={{ color: "#6b7280", fontSize: "0.75rem", marginTop: "1rem" }}>
        Proxies americanos para ETFs europeos. Backtest incluye costes de transacción. Resultados pasados no garantizan rendimiento futuro.
      </p>
    </div>
  );
}

function MetricsCard({ title, metrics: m, color }: { title: string; metrics: BacktestMetrics; color: string }) {
  const fmt = (v: number) => `${(v * 100).toFixed(1)}%`;
  const ok = (v: number, t: number) => ({ color: v >= t ? "#10b981" : "#ef4444" });
  return (
    <div style={{ ...styles.metricsCard, borderLeft: `3px solid ${color}` }}>
      <p style={{ color, fontWeight: "bold", marginBottom: "0.5rem" }}>{title}</p>
      <p>CAGR: <strong style={ok(m.cagr, 0.08)}>{fmt(m.cagr)}</strong></p>
      <p>Sharpe: <strong style={ok(m.sharpe, 0.5)}>{m.sharpe.toFixed(2)}</strong></p>
      <p>Max Drawdown: <strong style={{ color: m.maxDrawdown < -0.30 ? "#ef4444" : "#f59e0b" }}>{fmt(m.maxDrawdown)}</strong></p>
      <p>Calmar: <strong>{m.calmar.toFixed(2)}</strong></p>
      <p>Volatilidad: <strong>{fmt(m.volatility)}</strong></p>
      <p>Win rate mensual: <strong style={ok(m.winRate, 0.5)}>{fmt(m.winRate)}</strong></p>
      <p>Retorno total: <strong style={ok(m.totalReturn, 0)}>{fmt(m.totalReturn)}</strong></p>
      <p style={{ color: "#6b7280", fontSize: "0.8rem" }}>Capital final: €{m.finalValue.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</p>
    </div>
  );
}

const styles = {
  card: { backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "1.5rem", marginBottom: "1.5rem", color: "#f9fafb" } as React.CSSProperties,
  proxyBar: { backgroundColor: "#1f2937", borderRadius: 6, padding: "0.5rem 1rem", marginBottom: "1rem" } as React.CSSProperties,
  label: { color: "#9ca3af", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.5rem" } as React.CSSProperties,
  select: { backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "#f9fafb", padding: "0.25rem 0.5rem", fontSize: "0.85rem" } as React.CSSProperties,
  metricsCard: { backgroundColor: "#1f2937", borderRadius: 6, padding: "1rem", fontSize: "0.85rem", lineHeight: 1.8 } as React.CSSProperties,
  alphaBar: { backgroundColor: "#1f2937", borderRadius: 6, padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.9rem" } as React.CSSProperties,
  chartTitle: { color: "#9ca3af", fontSize: "0.85rem", fontWeight: "normal", marginBottom: "0.5rem", marginTop: "1rem" } as React.CSSProperties,
  alert: { border: "1px solid", borderRadius: 6, padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.85rem" } as React.CSSProperties,
  tab: { padding: "0.35rem 0.75rem", borderRadius: 6, border: "none", cursor: "pointer", fontSize: "0.82rem" } as React.CSSProperties,
  exportBtn: { backgroundColor: "#1f2937", border: "1px solid #374151", color: "#9ca3af", borderRadius: 6, padding: "0.35rem 0.75rem", cursor: "pointer", fontSize: "0.8rem" } as React.CSSProperties,
};