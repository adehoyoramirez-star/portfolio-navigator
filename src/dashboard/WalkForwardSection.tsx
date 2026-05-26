// ═══════════════════════════════════════════════════════════════
// WalkForwardSection — Walk-Forward Robustness Display Component
// ═══════════════════════════════════════════════════════════════

import React from "react";
import wf, { WalkforwardWindow } from "@/data/walkforward-results";

const WalkForwardSection: React.FC = () => {
  const { config, windows, summary } = wf;
  if (!windows || windows.length === 0) return null;

  const impr = windows.filter((w: WalkforwardWindow) => w.Sharpe_OOS > w.Sharpe_IS).length;

  const cell: Record<string, string | number> = { padding: "4px 10px", borderBottom: "1px solid #1f2937", fontSize: "0.875rem" };
  const th: Record<string, string | number> = { padding: "4px 10px", borderBottom: "2px solid #374151", fontSize: "0.75rem", fontWeight: 600, color: "#9ca3af", whiteSpace: "nowrap" };
  const tc: Record<string, string | number> = { ...cell, textAlign: "center" };
  const tr: Record<string, string | number> = { ...cell, textAlign: "right" };

  const gradeColor: Record<string, string> = { A: "#10b981", B: "#3b82f6", C: "#f59e0b", D: "#ef4444", F: "#dc2626" };
  const riskColor: Record<string, string> = { LOW: "#10b981", MODERATE: "#f59e0b", HIGH: "#ef4444", CRITICAL: "#dc2626" };

  const btnStyle: Record<string, string | number> = {
    padding: "0.3rem 0.8rem", borderRadius: 20, fontSize: "0.8rem", fontWeight: "bold", border: "none", cursor: "pointer",
    backgroundColor: riskColor[summary.overfittingRisk as keyof typeof riskColor] || "#374151",
    color: "#fff"
  };

  return (
    <div style={{ backgroundColor: "#111827", borderRadius: 12, padding: "1.25rem", border: "1px solid " + (summary.overfittingRisk === "LOW" ? "#065f46" : summary.overfittingRisk === "HIGH" ? "#7f1d1d" : "#1e3a5f") }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>🔬 Walk-Forward Robustness</h2>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <span style={{ fontSize: "1.8rem", fontWeight: "bold", color: gradeColor[summary.grade as keyof typeof gradeColor] || "#fff" }}>{summary.grade}</span>
          <span style={btnStyle}>Overfitting: {summary.overfittingRisk}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "0.75rem", marginBottom: "1rem" }}>
        <div style={{ backgroundColor: "#1f2937", borderRadius: 8, padding: "0.5rem 0.75rem", textAlign: "center" }}>
          <div style={{ fontSize: "0.7rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Consistencia</div>
          <div style={{ fontSize: "1.3rem", fontWeight: "bold", color: "#10b981" }}>{summary.consistency.toFixed(1)}%</div>
        </div>
        <div style={{ backgroundColor: "#1f2937", borderRadius: 8, padding: "0.5rem 0.75rem", textAlign: "center" }}>
          <div style={{ fontSize: "0.7rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Sharpe IS→OOS</div>
          <div style={{ fontSize: "1.3rem", fontWeight: "bold", color: "#818cf8" }}>{summary.avgSharpeIS.toFixed(2)} → {summary.avgSharpeOOS.toFixed(2)}</div>
        </div>
        <div style={{ backgroundColor: "#1f2937", borderRadius: 8, padding: "0.5rem 0.75rem", textAlign: "center" }}>
          <div style={{ fontSize: "0.7rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>CAGR IS→OOS</div>
          <div style={{ fontSize: "1.3rem", fontWeight: "bold", color: "#34d399" }}>{summary.avgCAGR_IS.toFixed(1)}% → {summary.avgCAGR_OOS.toFixed(1)}%</div>
        </div>
        <div style={{ backgroundColor: "#1f2937", borderRadius: 8, padding: "0.5rem 0.75rem", textAlign: "center" }}>
          <div style={{ fontSize: "0.7rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Peor MaxDD</div>
          <div style={{ fontSize: "1.3rem", fontWeight: "bold", color: "#f87171" }}>{summary.worstMaxDD_IS.toFixed(1)}% → {summary.worstMaxDD_OOS.toFixed(1)}%</div>
        </div>
        <div style={{ backgroundColor: "#1f2937", borderRadius: 8, padding: "0.5rem 0.75rem", textAlign: "center" }}>
          <div style={{ fontSize: "0.7rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Ventanas OK</div>
          <div style={{ fontSize: "1.3rem", fontWeight: "bold", color: summary.windowsAllPositiveOOS ? "#10b981" : "#f59e0b" }}>{impr}/{windows.length}</div>
        </div>
      </div>

      <div style={{ overflowX: "auto", marginBottom: "1rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
          <thead>
            <tr>
              <th style={th}>V</th>
              <th style={th}>Sharpe IS</th>
              <th style={th}>Sharpe OOS</th>
              <th style={th}>Degrad.</th>
              <th style={th}>CAGR IS</th>
              <th style={th}>CAGR OOS</th>
              <th style={th}>MaxDD IS</th>
              <th style={th}>MaxDD OOS</th>
              <th style={th}>WinRate OOS</th>
              <th style={th}>Consist.</th>
            </tr>
          </thead>
          <tbody>
            {windows.map((w: WalkforwardWindow, i: number) => {
              const isBest = w.Consistencia_PCT === Math.max(...windows.map((x: WalkforwardWindow) => x.Consistencia_PCT));
              const isWorst = w.Consistencia_PCT === Math.min(...windows.map((x: any) => x.Consistencia_PCT));
              const rowBg = isBest ? "rgba(16,185,129,0.08)" : isWorst ? "rgba(239,68,68,0.08)" : "transparent";
              const degradOk = w.Sharpe_OOS >= w.Sharpe_IS * 0.7;
              return (
                <tr key={i} style={{ backgroundColor: rowBg }}>
                  <td style={{ ...tc, fontWeight: 600, color: "#9ca3af" }}>V{w.Ventana}</td>
                  <td style={{ ...tr, color: "#818cf8" }}>{w.Sharpe_IS.toFixed(2)}</td>
                  <td style={{ ...tr, color: w.Sharpe_OOS > w.Sharpe_IS ? "#10b981" : "#f59e0b" }}>{w.Sharpe_OOS.toFixed(2)}</td>
                  <td style={{ ...tr, color: degradOk ? "#6b7280" : "#ef4444" }}>{w.Sharpe_Degradacion.toFixed(2)}</td>
                  <td style={{ ...tr, color: "#34d399" }}>{w.CAGR_IS_PCT.toFixed(1)}%</td>
                  <td style={{ ...tr, color: "#34d399" }}>{w.CAGR_OOS_PCT.toFixed(1)}%</td>
                  <td style={{ ...tr, color: "#f87171" }}>{w.MaxDD_IS_PCT.toFixed(1)}%</td>
                  <td style={{ ...tr, color: "#f87171" }}>{w.MaxDD_OOS_PCT.toFixed(1)}%</td>
                  <td style={{ ...tc, color: w.WinRate_OOS_PCT >= 70 ? "#10b981" : "#f59e0b" }}>{w.WinRate_OOS_PCT.toFixed(0)}%</td>
                  <td style={{ ...tc, fontWeight: "bold", color: w.Consistencia_PCT >= 85 ? "#10b981" : w.Consistencia_PCT >= 70 ? "#f59e0b" : "#ef4444" }}>{w.Consistencia_PCT.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <div style={{ backgroundColor: "#1f2937", borderRadius: 6, padding: "0.4rem 0.75rem", fontSize: "0.8rem", color: "#6b7280", border: "1px solid #1f2937" }}>
          Config: nWindows=<strong style={{color:"#fff"}}>{config.nWindows}</strong>, trainRatio=<strong style={{color:"#fff"}}>{config.trainRatio}</strong>
        </div>
        {summary.windowsAllPositiveOOS && (
          <div style={{ backgroundColor: "rgba(16,185,129,0.1)", borderRadius: 6, padding: "0.4rem 0.75rem", fontSize: "0.8rem", color: "#10b981", border: "1px solid rgba(16,185,129,0.2)" }}>
            ✅ 100% ventanas con Sharpe OOS positivo
          </div>
        )}
      </div>
    </div>
  );
};

export default WalkForwardSection;
