interface Props {
  styles: Record<string, React.CSSProperties>;
  years: number;
  setYears: (v: number) => void;
  expectedReturn: number;
  marketData: any;
  engineResult: any;
  jumpIntensityPortfolio: number;
  formatCurrency: (v: number) => string;
  medianValue: number;
  p25: number;
  p75: number;
  meanValue: number;
  worst5: number;
  best95: number;
  probability: number;
  target: number;
  totalPortfolioValue: number;
  monthlyInjection: number;
  cvarResult: any;
  simulations: number[];
  histogramData: Array<{range: string; count: number}>;
}

const MonteCarloSection: React.FC<Props> = (props) => {
  const { styles, years, setYears, expectedReturn, marketData, engineResult, jumpIntensityPortfolio, formatCurrency, medianValue, p25, p75, meanValue, worst5, best95, probability, target, totalPortfolioValue, monthlyInjection, cvarResult, simulations, histogramData } = props;
  return (
      {/* Simulación Monte Carlo */}
      <div style={styles.card}>
        <h2>Distribución de valores finales (Monte Carlo con Jump Diffusion)</h2>
        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="years" style={styles.label}>Años de simulación:</label>
          <input id="years" name="years" type="number" value={years} onChange={(e) => setYears(Number(e.target.value))} style={styles.smallInput} min="1" max="50" step="1" />
        </div>

        <div style={{ background: "#0c1228", border: "1px solid #3b82f6", borderRadius: 6, padding: "0.6rem 1rem", marginBottom: "1rem", fontSize: "0.78rem" }}>
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <span style={{ color: "#60a5fa", fontWeight: "bold" }}>μ efectivo: </span>
              <span style={{ color: "#e5e7eb", fontWeight: "bold", fontSize: "1rem" }}>{(Math.min(0.25, expectedReturn) * 100).toFixed(2)}%</span>
              <span style={{ color: "#6b7280" }}> anual</span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Fuente: </span>
              <span style={{ color: marketData?.expectedReturns?.length ? "#10b981" : "#f59e0b", fontWeight: "bold" }}>
                {marketData?.expectedReturns?.length ? "✅ James-Stein (Yahoo + shrinkage φ=0.65)" : "⚠️ Hardcoded portfolio.ts (sin datos Yahoo)"}
              </span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Régimen: </span>
              <span style={{ color: "#f59e0b" }}>{engineResult?.regime ?? "—"} ×{(engineResult?.masterRegime.regimePenalty ?? 1).toFixed(3)}</span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Modo: </span>
              <span style={{ color: marketData?.covMatrix?.length ? "#10b981" : "#f59e0b" }}>
                {marketData?.covMatrix?.length ? "Multivariante Cholesky" : "Univariante (λ_p=" + jumpIntensityPortfolio.toFixed(1) + "/año)"}
              </span>
            </div>
          </div>
          <div style={{ marginTop: "0.3rem", color: "#4b5563", fontSize: "0.7rem" }}>
            Priors LP (Damodaran 2024): BTC 15% · Semis 14% · MSCI World 9% (Portfolio 6 activos desde refactor 22-Jun-2026: IS3Q.DE + XNAS.DE consolidados en 0P00000WLG.F.) — shrinkage 65% hacia prior, 35% histórico Yahoo.
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
          <div style={{ background: "#0f172a", border: "2px solid #6366f1", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#818cf8", fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.2rem" }}>MEDIANA (resultado más probable)</div>
            <div style={{ color: "#e5e7eb", fontSize: "1.3rem", fontWeight: "bold" }}>{formatCurrency(medianValue)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>50% de simulaciones por encima</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>RANGO CENTRAL (P25–P75)</div>
            <div style={{ color: "#10b981", fontSize: "1rem", fontWeight: "bold" }}>{formatCurrency(p25)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>— a —</div>
            <div style={{ color: "#10b981", fontSize: "1rem", fontWeight: "bold" }}>{formatCurrency(p75)}</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>MEDIA (sesgada al alza)</div>
            <div style={{ color: "#d1d5db", fontSize: "1.1rem", fontWeight: "bold" }}>{formatCurrency(meanValue)}</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>PEOR 5% (cola bajista)</div>
            <div style={{ color: "#ef4444", fontSize: "1.1rem", fontWeight: "bold" }}>{formatCurrency(worst5)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>VaR 95%</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>MEJOR 5% (cola alcista)</div>
            <div style={{ color: "#f59e0b", fontSize: "1.1rem", fontWeight: "bold" }}>{formatCurrency(best95)}</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>PROB. OBJETIVO</div>
            <div style={{ color: probability >= 50 ? "#10b981" : probability >= 25 ? "#f59e0b" : "#ef4444", fontSize: "1.3rem", fontWeight: "bold" }}>{probability.toFixed(1)}%</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>Alcanzar {formatCurrency(target)}</div>
          </div>
        </div>

        <div style={{ background: "#111827", borderRadius: 6, padding: "0.5rem 1rem", marginBottom: "1rem", fontSize: "0.8rem", color: "#9ca3af" }}>
          Capital total invertido en {years} años:{" "}
          <strong style={{ color: "#d1d5db" }}>{formatCurrency(totalPortfolioValue + monthlyInjection * years * 12)}</strong>
          {" · "}Multiplicador mediana:{" "}
          <strong style={{ color: "#6366f1" }}>{(medianValue / (totalPortfolioValue + monthlyInjection * years * 12)).toFixed(1)}x</strong>
        </div>

        <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          {cvarResult && (
            <div style={{ borderLeft: "2px solid #f59e0b", paddingLeft: "0.75rem", marginBottom: "0.75rem" }}>
              <p style={{ margin: 0 }}>
                <strong>CVaR 95% — valor esperado peor 5%:</strong>{" "}
                <span style={{ color: "#f59e0b" }}>{formatCurrency(cvarResult.cvar95Abs)}</span>
              </p>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#9ca3af" }}>
                Pérdida esperada vs capital invertido:{" "}
                <span style={{ color: cvarResult.loss95 > 0 ? "#ef4444" : "#10b981" }}>
                  {cvarResult.loss95 > 0 ? "−" : "+"}{formatCurrency(Math.abs(cvarResult.loss95))}
                </span>
                {" · "}Tail ratio: {cvarResult.tailRatio.toFixed(2)}x
              </p>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#ef4444" }}>
                CVaR 99%: {formatCurrency(cvarResult.cvar99Abs)}{" · "}Estándar Basel III/IV
              </p>
            </div>
          )}
        </div>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={histogramData} barSize={15}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="range" tick={{ fontSize: 10, fill: "#9ca3af" }} interval={0} angle={-45} textAnchor="end" height={80} />
            <YAxis tick={{ fill: "#9ca3af" }} />
            <Tooltip formatter={(value: number) => value} labelFormatter={() => ""} />
            <Bar dataKey="count" fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
        <p style={{ fontSize: "0.9rem", color: "#9ca3af" }}>Histograma basado en {simulations.length} simulaciones (20 bins).</p>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════  );
};

export default MonteCarloSection;
