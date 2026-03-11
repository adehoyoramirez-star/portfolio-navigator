import { useEffect, useMemo, useState } from "react";
import InstitutionalDashboard from "@/dashboard/InstitutionalDashboard";
import { portfolio } from "@/data/portfolio";
import { fetchRealMarketData } from "@/lib/marketData";
import "./elite-dashboard.css";

const euro = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

const baseExpectedReturn = portfolio.assets.reduce((acc, asset) => acc + (asset.weight / 100) * asset.expectedReturn, 0);
const targetLoaded = portfolio.assets.reduce((acc, asset) => acc + asset.weight, 0);
const offensiveExposure = portfolio.assets
  .filter((asset) => ["Crypto", "Technology"].includes(asset.sector))
  .reduce((acc, asset) => acc + asset.weight, 0);

export default function EliteDashboard() {
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [lastUpdate, setLastUpdate] = useState<string>("sin actualizar");
  const [dataSource, setDataSource] = useState<"LIVE" | "FALLBACK">("FALLBACK");

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        const { marketData, fetchErrors } = await fetchRealMarketData();
        if (!mounted) return;
        setLivePrices(marketData.prices);
        setLastUpdate(new Date().toLocaleString("es-ES"));
        setDataSource(fetchErrors.length === 0 ? "LIVE" : "FALLBACK");
      } catch {
        if (!mounted) return;
        setDataSource("FALLBACK");
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, []);

  const liveAum = useMemo(() => {
    const liveVal = portfolio.assets.reduce((sum, asset) => {
      const px = livePrices[asset.ticker] ?? asset.price;
      return sum + px * asset.shares;
    }, portfolio.cashReserve);
    return liveVal > 0 ? liveVal : portfolio.totalValue;
  }, [livePrices]);

  const growthProgress = Math.min((liveAum / portfolio.targetGoal) * 100, 100);

  const topPositions = useMemo(
    () =>
      [...portfolio.assets]
        .map((asset) => ({
          ...asset,
          livePrice: livePrices[asset.ticker] ?? asset.price,
          marketValue: (livePrices[asset.ticker] ?? asset.price) * asset.shares,
        }))
        .sort((a, b) => b.marketValue - a.marketValue)
        .slice(0, 5),
    [livePrices]
  );

  return (
    <div className="hf-shell">
      <header className="hf-header">
        <div>
          <p className="hf-kicker">Olympus Capital · Institutional Desk</p>
          <h1>Panel de Control — Hedge Fund View</h1>
          <p className="hf-subtitle">
            Arquitectura visual para lectura rápida de riesgo, concentración y progreso del mandato.
          </p>
          <p className="hf-meta">
            Fuente: {dataSource === "LIVE" ? "Yahoo/FRED (gratis)" : "Fallback local"} · Última actualización: {lastUpdate}
          </p>
        </div>
        <div className="hf-regime">
          <span>Régimen actual</span>
          <strong>{portfolio.regime}</strong>
          <small>Risk-free: {portfolio.riskFreeRate.toFixed(1)}%</small>
        </div>
      </header>

      <section className="hf-kpis">
        <article className="hf-kpi-card">
          <span>Assets Under Management</span>
          <strong>{euro.format(liveAum)}</strong>
          <small>Cash reserve: {euro.format(portfolio.cashReserve)}</small>
        </article>
        <article className="hf-kpi-card">
          <span>Expected Return (blend)</span>
          <strong>{baseExpectedReturn.toFixed(1)}%</strong>
          <small>Vol. objetivo: {portfolio.expectedVolatility.toFixed(1)}%</small>
        </article>
        <article className="hf-kpi-card">
          <span>Offensive Exposure</span>
          <strong>{offensiveExposure.toFixed(1)}%</strong>
          <small>Crypto + Tech allocation</small>
        </article>
        <article className="hf-kpi-card">
          <span>Funding Rate</span>
          <strong>{euro.format(portfolio.monthlyInjection)}/mes</strong>
          <small>Target loaded: {targetLoaded.toFixed(1)}%</small>
        </article>
      </section>

      <section className="hf-grid">
        <article className="hf-panel">
          <div className="hf-panel-head">
            <h2>Mandate Progress</h2>
            <strong>{growthProgress.toFixed(1)}%</strong>
          </div>
          <p>Progreso hacia objetivo de capital institucional de {euro.format(portfolio.targetGoal)}.</p>
          <div className="hf-progress-track" role="progressbar" aria-valuenow={growthProgress} aria-valuemin={0} aria-valuemax={100}>
            <div className="hf-progress-fill" style={{ width: `${growthProgress}%` }} />
          </div>
        </article>

        <article className="hf-panel">
          <div className="hf-panel-head">
            <h2>Core Concentration</h2>
            <small>Top 5 por valor de mercado vivo</small>
          </div>
          <table className="hf-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Sector</th>
                <th>Valor</th>
                <th>ER</th>
              </tr>
            </thead>
            <tbody>
              {topPositions.map((asset) => (
                <tr key={asset.ticker}>
                  <td>{asset.name}</td>
                  <td>{asset.sector}</td>
                  <td>{euro.format(asset.marketValue)}</td>
                  <td>{asset.expectedReturn.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>

      <section className="hf-engine">
        <InstitutionalDashboard />
      </section>
    </div>
  );
}