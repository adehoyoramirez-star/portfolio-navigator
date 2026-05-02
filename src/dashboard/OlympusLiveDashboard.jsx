import { useState, useEffect, useCallback, useRef } from "react";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ── Simulación del estado del monitor (reemplazar con getLiveMonitor() real) ──
const PORTFOLIO = {
  positions: [
    { ticker: "BTC-EUR",  shares: 0.031285, avgPrice: 88010.99, livePrice: 91200,  assetClass: "CRYPTO" },
    { ticker: "IS3Q.DE",  shares: 26,       avgPrice: 67.53,    livePrice: 70.20,  assetClass: "EQUITY" },
    { ticker: "EMXC.DE",  shares: 31,       avgPrice: 28.93,    livePrice: 28.10,  assetClass: "EQUITY" },
    { ticker: "XNAS.DE",  shares: 6,        avgPrice: 61.67,    livePrice: 68.40,  assetClass: "EQUITY" },
    { ticker: "URNU.DE",  shares: 13,       avgPrice: 26.48,    livePrice: 24.50,  assetClass: "COMMODITY" },
    { ticker: "PPFB.DE",  shares: 4,        avgPrice: 69.39,    livePrice: 72.10,  assetClass: "COMMODITY" },
    { ticker: "VVSM.DE",  shares: 2,        avgPrice: 52.01,    livePrice: 58.20,  assetClass: "EQUITY" },
  ],
  cash: 0,
  initialEquity: 7000,
};

function buildLiveState(prices) {
  const pos = PORTFOLIO.positions.map(p => {
    const live = prices[p.ticker] ?? p.livePrice;
    const mv = p.shares * live;
    const pnl = (live - p.avgPrice) * p.shares;
    const pnlPct = p.avgPrice > 0 ? (live - p.avgPrice) / p.avgPrice : 0;
    const ddFromAvg = p.avgPrice > live ? (p.avgPrice - live) / p.avgPrice : 0;
    return { ...p, livePrice: live, marketValue: mv, unrealizedPnL: pnl, pnlPct, ddFromAvg };
  });
  const total = pos.reduce((s, p) => s + p.marketValue, 0);
  return {
    positions: pos.map(p => ({ ...p, weight: total > 0 ? p.marketValue / total : 0 })),
    totalEquity: total,
    totalPnL: pos.reduce((s, p) => s + p.unrealizedPnL, 0),
    totalPnLPct: total > 0 ? (total - PORTFOLIO.initialEquity) / PORTFOLIO.initialEquity : 0,
  };
}

function generateEquityCurve(days = 60) {
  const curve = [];
  let equity = 6400;
  const now = Date.now();
  for (let i = days; i >= 0; i--) {
    const noise = (Math.random() - 0.46) * 120;
    equity = Math.max(5500, equity + noise);
    curve.push({
      t: now - i * 86400000,
      equity: parseFloat(equity.toFixed(0)),
      label: new Date(now - i * 86400000).toLocaleDateString("es-ES", { month: "short", day: "numeric" }),
    });
  }
  curve[curve.length - 1].equity = 6622;
  return curve;
}

const PHASE_COLOR = {
  BULL_EARLY: "#2a7a4a", BULL_EXPANSION: "#2a7a4a", RECOVERY: "#2a7a4a",
  ACCUMULATION: "#4a6fa5", NEUTRAL: "#6060a0",
  DISTRIBUTION: "#c9a227", BULL_LATE: "#c9a227",
  BEAR_EARLY: "#c44444", BEAR_DEEP: "#a02020",
};
const ASSET_CYCLES = {
  "BTC-EUR": { phase: "ACCUMULATION", score: 55, rsi: 38 },
  "IS3Q.DE": { phase: "BULL_EXPANSION", score: 72, rsi: 61 },
  "EMXC.DE": { phase: "BEAR_EARLY", score: 34, rsi: 33 },
  "XNAS.DE": { phase: "BULL_EXPANSION", score: 74, rsi: 64 },
  "URNU.DE": { phase: "ACCUMULATION", score: 48, rsi: 42 },
  "PPFB.DE": { phase: "BULL_EARLY", score: 68, rsi: 55 },
  "VVSM.DE": { phase: "BULL_EXPANSION", score: 71, rsi: 60 },
};

export default function OlympusLiveDashboard() {
  const [liveState, setLiveState] = useState(() => buildLiveState({}));
  const [equityCurve] = useState(generateEquityCurve);
  const [tick, setTick] = useState(0);
  const [ibkrStatus, setIbkrStatus] = useState("CONNECTING");
  const [activeTab, setActiveTab] = useState("overview");
  const [dismissedAlerts, setDismissedAlerts] = useState(new Set());
  const pricesRef = useRef({});

  // Simular precio en tiempo real con pequeñas variaciones
  useEffect(() => {
    const interval = setInterval(() => {
      const newPrices = { ...pricesRef.current };
      PORTFOLIO.positions.forEach(p => {
        const base = pricesRef.current[p.ticker] ?? p.livePrice;
        const drift = (Math.random() - 0.498) * base * 0.0008;
        newPrices[p.ticker] = parseFloat(Math.max(base * 0.95, base + drift).toFixed(4));
      });
      pricesRef.current = newPrices;
      setLiveState(buildLiveState(newPrices));
      setTick(t => t + 1);
      if (tick === 3) setIbkrStatus("LIVE");
    }, 2000);
    return () => clearInterval(interval);
  }, [tick]);

  const { positions, totalEquity, totalPnL, totalPnLPct } = liveState;
  const peakEquity = Math.max(...equityCurve.map(p => p.equity), totalEquity);
  const currentDD = (peakEquity - totalEquity) / peakEquity;
  const btcPos = positions.find(p => p.ticker === "BTC-EUR");
  const btcDD = btcPos?.ddFromAvg ?? 0;

  const rolling = {
    sharpe: 1.72, sortino: 2.31, vol: 0.223, cvar: 0.112,
    sharpe_trend: "UP", risk_trend: "STABLE",
  };

  const alerts = [
    btcDD > 0.03 && {
      id: "btc-dca", level: "DCA_OPPORTUNITY",
      msg: `🎯 DCA BTC: caída ${(btcDD * 100).toFixed(1)}% desde precio medio`,
      detail: `Tranche 1/4 sugerido: €${(totalEquity * 0.06 * (btcDD > 0.2 ? 1.8 : 1.0)).toFixed(0)}`,
      action: "Ejecutar TWAP BTC",
    },
    currentDD > 0.05 && {
      id: "dd-warn", level: "WARNING",
      msg: `Portfolio DD: -${(currentDD * 100).toFixed(1)}%`,
      detail: `Máximo tolerable: -25%. Margen disponible: ${((0.25 - currentDD) * 100).toFixed(1)}pp`,
      action: null,
    },
    ASSET_CYCLES["EMXC.DE"].phase === "BEAR_EARLY" && {
      id: "emxc-bear", level: "WARNING",
      msg: "EMXC.DE en Bear Early — reducir ligeramente",
      detail: "Emerging markets en ciclo bajista temprano. RSI 33 confirmando.",
      action: "Reducir a 10%",
    },
  ].filter(Boolean).filter(a => !dismissedAlerts.has(a.id));

  const tabs = [
    { id: "overview", label: "Vista general" },
    { id: "positions", label: "Posiciones" },
    { id: "risk", label: "Riesgo" },
    { id: "dca", label: "DCA / Ataques" },
    { id: "alerts", label: `Alertas${alerts.length > 0 ? ` (${alerts.length})` : ""}` },
  ];

  const fmtEur = n => `€${Math.abs(n) >= 1000 ? (n / 1000).toFixed(2) + "k" : n.toFixed(0)}`;
  const fmtPct = n => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
  const pnlColor = n => n >= 0 ? "#3db56e" : "#e05555";

  return (
    <div style={{
      background: "var(--color-background-primary)",
      color: "var(--color-text-primary)",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      padding: "8px 0",
      minHeight: "100vh",
    }}>
      {/* ── HEADER ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>OLYMPUS LIVE</span>
            <span style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 4, fontWeight: 500,
              background: ibkrStatus === "LIVE" ? "var(--color-background-success)" : "var(--color-background-warning)",
              color: ibkrStatus === "LIVE" ? "var(--color-text-success)" : "var(--color-text-warning)",
              display: "flex", alignItems: "center", gap: 4,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: ibkrStatus === "LIVE" ? "var(--color-text-success)" : "var(--color-text-warning)",
                display: "inline-block",
                animation: ibkrStatus === "LIVE" ? "pulse 2s infinite" : "none",
              }} />
              {ibkrStatus === "LIVE" ? "IBKR LIVE" : "CONECTANDO..."}
            </span>
            <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
              {new Date().toLocaleTimeString("es-ES")}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
            Monitor institucional · BTC estrategia HODL+DCA
          </div>
        </div>

        {/* KPIs rápidos */}
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          {[
            { label: "Portfolio", val: fmtEur(totalEquity), color: "var(--color-text-primary)" },
            { label: "PnL total", val: fmtPct(totalPnLPct), color: pnlColor(totalPnL) },
            { label: "Sharpe 20d", val: rolling.sharpe.toFixed(2), color: rolling.sharpe > 1.5 ? "var(--color-text-success)" : "var(--color-text-warning)" },
            { label: "CVaR 95%", val: `${(rolling.cvar * 100).toFixed(1)}%`, color: rolling.cvar < 0.15 ? "var(--color-text-success)" : "var(--color-text-warning)" },
          ].map(k => (
            <div key={k.label} style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 500, color: k.color }}>{k.val}</div>
              <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{k.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 14, gap: 0 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            background: "none", border: "none", padding: "6px 16px",
            fontSize: 12, cursor: "pointer",
            borderBottom: activeTab === t.id ? "2px solid var(--color-text-primary)" : "2px solid transparent",
            color: activeTab === t.id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            fontWeight: activeTab === t.id ? 500 : 400,
            fontFamily: "var(--font-sans)",
          }}>{t.label}</button>
        ))}
      </div>

      {/* ════════════════ TAB: OVERVIEW ════════════════ */}
      {activeTab === "overview" && (
        <div>
          {/* Equity curve */}
          <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)" }}>Equity curve — 60 días</span>
              <div style={{ display: "flex", gap: 12 }}>
                <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Pico: {fmtEur(peakEquity)}</span>
                <span style={{ fontSize: 11, color: currentDD > 0.05 ? "var(--color-text-danger)" : "var(--color-text-success)" }}>
                  DD: {currentDD > 0 ? `-${(currentDD * 100).toFixed(1)}%` : "0%"}
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={equityCurve} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3db56e" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#3db56e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--color-text-secondary)" }} interval={9} tickLine={false} axisLine={false} />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fill: "var(--color-text-secondary)" }} tickLine={false} axisLine={false} tickFormatter={v => `€${v}`} width={44} />
                <Tooltip contentStyle={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 6, fontSize: 11 }} formatter={v => [`€${v}`, "Equity"]} />
                <ReferenceLine y={PORTFOLIO.initialEquity} stroke="var(--color-text-secondary)" strokeDasharray="3 3" />
                <Area type="monotone" dataKey="equity" stroke="#3db56e" strokeWidth={1.5} fill="url(#eqGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Allocation bars + cycle */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)", marginBottom: 10 }}>Allocación live</div>
              {positions.map(p => (
                <div key={p.ticker} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500, minWidth: 68 }}>{p.ticker}</span>
                  <div style={{ flex: 1, height: 5, background: "var(--color-border-tertiary)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(p.weight * 100).toFixed(1)}%`, background: PHASE_COLOR[ASSET_CYCLES[p.ticker]?.phase] ?? "#4a6fa5", borderRadius: 3, transition: "width 0.5s" }} />
                  </div>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, minWidth: 36, textAlign: "right" }}>{(p.weight * 100).toFixed(1)}%</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, minWidth: 52, textAlign: "right", color: pnlColor(p.unrealizedPnL) }}>{fmtEur(p.unrealizedPnL)}</span>
                </div>
              ))}
            </div>
            <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)", marginBottom: 10 }}>Ciclos por activo</div>
              {positions.map(p => {
                const cycle = ASSET_CYCLES[p.ticker] ?? { phase: "NEUTRAL", score: 50 };
                return (
                  <div key={p.ticker} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500, minWidth: 68 }}>{p.ticker}</span>
                    <div style={{ flex: 1, height: 5, background: "var(--color-border-tertiary)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${cycle.score}%`, background: PHASE_COLOR[cycle.phase] ?? "#6060a0", borderRadius: 3 }} />
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 28, textAlign: "right", color: "var(--color-text-secondary)" }}>{cycle.score}</span>
                    <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "var(--color-background-primary)", color: PHASE_COLOR[cycle.phase] ?? "var(--color-text-secondary)", minWidth: 90, textAlign: "center", border: `0.5px solid ${PHASE_COLOR[cycle.phase] ?? "var(--color-border-tertiary)"}`, opacity: 0.9 }}>
                      {cycle.phase.replace(/_/g, " ")}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ════════════════ TAB: POSICIONES ════════════════ */}
      {activeTab === "positions" && (
        <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                {["Activo", "Acciones", "Precio medio", "Precio live", "Valor €", "PnL €", "PnL %", "Peso", "Cambio día", "Fuente"].map(h => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 10, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-secondary)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map(p => (
                <tr key={p.ticker} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", fontWeight: 500 }}>{p.ticker}</td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>{p.shares.toFixed(p.shares < 1 ? 6 : 0)}</td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>€{p.avgPrice.toFixed(2)}</td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", fontWeight: 500 }}>€{p.livePrice.toFixed(2)}</td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)" }}>€{p.marketValue.toFixed(0)}</td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: pnlColor(p.unrealizedPnL), fontWeight: 500 }}>{p.unrealizedPnL >= 0 ? "+" : ""}€{p.unrealizedPnL.toFixed(0)}</td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: pnlColor(p.pnlPct) }}>{fmtPct(p.pnlPct)}</td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)" }}>{(p.weight * 100).toFixed(1)}%</td>
                  <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", color: pnlColor(p.dailyChange ?? 0), fontSize: 11 }}>{p.dailyChange ? fmtPct(p.dailyChange) : "—"}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: ibkrStatus === "LIVE" ? "var(--color-background-success)" : "var(--color-background-secondary)", color: ibkrStatus === "LIVE" ? "var(--color-text-success)" : "var(--color-text-secondary)" }}>
                      {ibkrStatus === "LIVE" ? "IBKR" : "MANUAL"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "var(--color-background-primary)" }}>
                <td colSpan={4} style={{ padding: "8px 10px", fontWeight: 500 }}>TOTAL PORTFOLIO</td>
                <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 14 }}>€{totalEquity.toFixed(0)}</td>
                <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", fontWeight: 600, color: pnlColor(totalPnL) }}>{totalPnL >= 0 ? "+" : ""}€{totalPnL.toFixed(0)}</td>
                <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)", fontWeight: 600, color: pnlColor(totalPnLPct) }}>{fmtPct(totalPnLPct)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* ════════════════ TAB: RIESGO ════════════════ */}
      {activeTab === "risk" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 12 }}>
            {[
              { label: "Sharpe 20d", val: rolling.sharpe.toFixed(2), sub: `tendencia: ${rolling.sharpe_trend}`, ok: rolling.sharpe >= 1.5, trend: rolling.sharpe_trend },
              { label: "Sortino 20d", val: rolling.sortino.toFixed(2), sub: "retornos negativos", ok: rolling.sortino >= 2.0 },
              { label: "Volatilidad 20d", val: `${(rolling.vol * 100).toFixed(1)}%`, sub: "anualizada", ok: rolling.vol < 0.30 },
              { label: "CVaR 95%", val: `${(rolling.cvar * 100).toFixed(1)}%`, sub: "pérdida esperada tail", ok: rolling.cvar < 0.15 },
              { label: "Max DD actual", val: `-${(currentDD * 100).toFixed(1)}%`, sub: `desde €${peakEquity.toFixed(0)}`, ok: currentDD < 0.10 },
              { label: "Riesgo tendencia", val: rolling.risk_trend, sub: "vol 10d vs 20d", ok: rolling.risk_trend !== "INCREASING" },
            ].map(m => (
              <div key={m.label} style={{ background: "var(--color-background-secondary)", border: `0.5px solid ${m.ok ? "var(--color-border-tertiary)" : "var(--color-border-warning)"}`, borderRadius: "var(--border-radius-md)", padding: "12px 14px", textAlign: "center" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 500, color: m.ok ? "var(--color-text-primary)" : "var(--color-text-warning)", marginBottom: 4 }}>{m.val}</div>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--color-text-secondary)" }}>{m.label}</div>
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 2 }}>{m.sub}</div>
              </div>
            ))}
          </div>
          <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)", marginBottom: 10 }}>Escenarios de stress</div>
            {[
              { scenario: "BTC -30% (corrección ciclo normal)", impact: -totalEquity * 0.416 * 0.30, prob: "Alta (2-3 veces por ciclo)" },
              { scenario: "Crash equity -20% (recesión leve)", impact: -totalEquity * (0.276 + 0.062 + 0.138) * 0.20, prob: "Media" },
              { scenario: "BTC -65% + equity -33% (2022-style)", impact: -totalEquity * 0.416 * 0.65 - totalEquity * 0.476 * 0.33, prob: "Baja (1 vez por ciclo)" },
              { scenario: "Flash crash -20% en 1 día (FTX-style)", impact: -totalEquity * 0.20, prob: "Muy baja (<5%)" },
            ].map(s => (
              <div key={s.scenario} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                <div style={{ flex: 1, fontSize: 12 }}>{s.scenario}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, color: "#e05555", minWidth: 80, textAlign: "right" }}>€{s.impact.toFixed(0)}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", minWidth: 140, textAlign: "right" }}>{s.prob}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ════════════════ TAB: DCA / ATAQUES ════════════════ */}
      {activeTab === "dca" && (
        <div>
          <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)", marginBottom: 10 }}>
              Estrategia BTC — HODL + DCA en caídas
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.7 }}>
              <strong style={{ color: "var(--color-text-primary)" }}>Precio medio actual BTC: €{btcPos?.avgPrice.toFixed(0)}</strong>
              {" · "}<strong style={{ color: "var(--color-text-primary)" }}>Precio live: €{btcPos?.livePrice.toFixed(0)}</strong>
              {" · "}<span style={{ color: btcDD > 0 ? "#3db56e" : "var(--color-text-secondary)" }}>
                {btcDD > 0 ? `BTC bajo precio medio: -${(btcDD * 100).toFixed(1)}%` : `BTC sobre precio medio: +${Math.abs(btcDD * 100).toFixed(1)}%`}
              </span>
            </div>
            {[
              { pct: 10, mult: 1.0, label: "Pullback leve", eur: (totalEquity * 0.06 * 1.0).toFixed(0), active: btcDD >= 0.10 },
              { pct: 20, mult: 1.8, label: "Corrección normal", eur: (totalEquity * 0.06 * 1.8).toFixed(0), active: btcDD >= 0.20 },
              { pct: 30, mult: 2.5, label: "Caída significativa", eur: (totalEquity * 0.06 * 2.5).toFixed(0), active: btcDD >= 0.30 },
              { pct: 40, mult: 3.5, label: "Capitulación", eur: (totalEquity * 0.06 * 3.5).toFixed(0), active: btcDD >= 0.40 },
            ].map((level, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: "var(--border-radius-md)", marginBottom: 6,
                background: level.active ? "var(--color-background-success)" : "var(--color-background-primary)",
                border: `0.5px solid ${level.active ? "var(--color-border-success, #2a7a4a)" : "var(--color-border-tertiary)"}`,
                opacity: level.active ? 1 : 0.6,
              }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: level.active ? "#2a7a4a" : "var(--color-border-tertiary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: level.active ? "#fff" : "var(--color-text-secondary)", flexShrink: 0 }}>{i + 1}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{level.label}: BTC -{level.pct}%</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>×{level.mult} DCA base</div>
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 500, color: level.active ? "#3db56e" : "var(--color-text-secondary)" }}>€{level.eur}</div>
                <div style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: level.active ? "rgba(61,181,110,0.15)" : "var(--color-background-secondary)", color: level.active ? "#3db56e" : "var(--color-text-secondary)" }}>
                  {level.active ? "🟢 ACTIVO" : "⏳ ESPERAR"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ════════════════ TAB: ALERTAS ════════════════ */}
      {activeTab === "alerts" && (
        <div>
          {alerts.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 13 }}>
              ✓ Sin alertas activas
            </div>
          )}
          {alerts.map(alert => (
            <div key={alert.id} style={{
              display: "flex", gap: 12, padding: "12px 16px", marginBottom: 8, borderRadius: "var(--border-radius-lg)",
              background: "var(--color-background-secondary)",
              border: `0.5px solid ${alert.level === "CRITICAL" ? "var(--color-border-danger, #c44)" : alert.level === "DCA_OPPORTUNITY" ? "var(--color-border-success, #2a7a4a)" : "var(--color-border-warning, #c9a227)"}`,
            }}>
              <div style={{ fontSize: 20, flexShrink: 0, marginTop: 2 }}>
                {alert.level === "CRITICAL" ? "🚨" : alert.level === "DCA_OPPORTUNITY" ? "🎯" : "⚠️"}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{alert.msg}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>{alert.detail}</div>
                {alert.action && (
                  <div style={{ fontSize: 11, padding: "4px 8px", borderRadius: 4, background: "var(--color-background-primary)", display: "inline-block" }}>
                    → {alert.action}
                  </div>
                )}
              </div>
              <button onClick={() => setDismissedAlerts(s => new Set([...s, alert.id]))} style={{
                background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: 16, padding: "0 4px", alignSelf: "flex-start",
              }}>×</button>
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
