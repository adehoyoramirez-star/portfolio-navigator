import React from "react"
import { calculateERP } from "@/core/macro/erp"
import { runMonteCarlo } from "@/core/simulation/montecarlo"
import { generateExecutiveSummary } from "@/core/summary/executive"

const InstitutionalDashboard: React.FC = () => {
  // === MACRO INPUTS (mock institucional) ===
  const earningsYield = 0.065
  const riskFreeRate = 0.04

  const erpResult = calculateERP(earningsYield, riskFreeRate)

  // === MONTECARLO SIMULATION (simplificada) ===
  const monteCarlo = runMonteCarlo(0.08, 0.15)

  // === EXECUTIVE SUMMARY ===
  const executive = generateExecutiveSummary()

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Institutional Portfolio Dashboard</h1>

      {/* ERP SECTION */}
      <div style={styles.card}>
        <h2>Equity Risk Premium</h2>
        <p><strong>ERP:</strong> {(erpResult.equityRiskPremium * 100).toFixed(2)}%</p>
        <p>
          <strong>Signal:</strong>{" "}
          <span
            style={{
              color: erpResult.signal === "RISK_ON" ? "limegreen" : "red"
            }}
          >
            {erpResult.signal}
          </span>
        </p>
      </div>

      {/* MONTECARLO SECTION */}
      <div style={styles.card}>
        <h2>Monte Carlo Simulation</h2>
        <p>
          <strong>Expected Return:</strong>{" "}
          {(monteCarlo.expectedReturn * 100).toFixed(2)}%
        </p>
        <p>
          <strong>Volatility:</strong>{" "}
          {(monteCarlo.volatility * 100).toFixed(2)}%
        </p>
      </div>

      {/* EXECUTIVE SUMMARY */}
      <div style={styles.card}>
        <h2>Executive Summary</h2>
        <p>
          <strong>Liquidity Score:</strong> {executive.liquidityScore}
        </p>
        <p>
          <strong>Macro Regime:</strong> {executive.macroRegime}
        </p>
      </div>
    </div>
  )
}

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    padding: "40px",
    fontFamily: "Inter, sans-serif",
    backgroundColor: "#0e1117",
    minHeight: "100vh",
    color: "white"
  },
  title: {
    marginBottom: "40px"
  },
  card: {
    backgroundColor: "#161b22",
    padding: "24px",
    borderRadius: "12px",
    marginBottom: "24px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)"
  }
}

export default InstitutionalDashboard