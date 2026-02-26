// ===============================================
// INSTITUTIONAL DASHBOARD
// ===============================================

import { calculateERP } from "@/core/macro/erp"
import { liquidityScore } from "@/core/macro/liquidity"
import { monteCarlo } from "@/core/simulation/montecarlo"
import { generateDecision } from "@/core/decision/engine"
import { executiveSummary } from "@/core/summary/executive"

export default function InstitutionalDashboard() {

  // --- Macro Layer ---
  const erp = calculateERP({
    forwardPER: 22,
    tenYearYield: 0.04,
    earningsGrowth: 0.04
  })

  const liquidity = liquidityScore({
    m2Growth: 5.2,
    vix: 19,
    yieldCurveSpread: 0.4
  })

  const mc = monteCarlo(
    6000,     // initial capital
    150000,   // target
    0.18,     // expected return
    0.15,     // volatility
    10,       // years
    0         // contribution
  )

  // --- Decision Engine ---
  const decision = generateDecision({
    erp,
    liquidity,
    regimeScore: liquidity
  })

  const summary = executiveSummary(
    erp,
    liquidity,
    mc.probability
  )

  return (
    <div className="min-h-screen bg-[#0A0F1C] text-gray-200 p-8 space-y-8">

      <h1 className="text-3xl font-bold">
        INSTITUTIONAL CONTROL PANEL
      </h1>

      <div className="grid grid-cols-3 gap-6">

        <div className="bg-[#121826] p-6 rounded-xl">
          <h2 className="text-gray-400">ERP</h2>
          <p className="text-2xl font-bold">
            {(erp * 100).toFixed(2)}%
          </p>
        </div>

        <div className="bg-[#121826] p-6 rounded-xl">
          <h2 className="text-gray-400">Liquidity</h2>
          <p className="text-2xl font-bold">
            {liquidity.toFixed(2)}
          </p>
        </div>

        <div className="bg-[#121826] p-6 rounded-xl">
          <h2 className="text-gray-400">Prob ≥150k</h2>
          <p className="text-2xl font-bold">
            {(mc.probability * 100).toFixed(1)}%
          </p>
        </div>

      </div>

      <div className="bg-[#121826] p-6 rounded-xl space-y-2">
        <h2 className="text-xl font-semibold">Decision</h2>
        <p className="text-2xl font-bold">{decision.action}</p>
        <p>{decision.explanation}</p>
        <p>Conviction: {decision.conviction.toFixed(0)}%</p>
      </div>

      <div className="bg-[#121826] p-6 rounded-xl">
        <h2 className="text-xl font-semibold">
          Executive Summary
        </h2>
        <p>{summary}</p>
      </div>

    </div>
  )
}