import { calculateERP } from "@/core/macro/erp"
import { liquidityScore } from "@/core/macro/liquidity"
import { monteCarlo } from "@/core/simulation/montecarlo"
import { generateDecision } from "@/core/decision/engine"
import { executiveSummary } from "@/core/summary/executive"

export default function InstitutionalDashboard() {
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

  const mc = monteCarlo(6000, 150000, 0.18, 0.15, 10, 0)

  const decision = generateDecision({
    erp,
    liquidity,
    regimeScore: liquidity
  })

  const summary = executiveSummary(erp, liquidity, mc.probability)

  return (
    <div className="min-h-screen bg-[#0A0F1C] text-gray-200 p-8 space-y-8">
      <h1 className="text-3xl font-bold">INSTITUTIONAL CONTROL PANEL</h1>

      <div className="grid grid-cols-3 gap-6">
        <div className="bg-[#121826] p-6 rounded-xl">
          <h2>ERP</h2>
          <p className="text-2xl">{(erp * 100).toFixed(2)}%</p>
        </div>

        <div className="bg-[#121826] p-6 rounded-xl">
          <h2>Liquidez</h2>
          <p className="text-2xl">{liquidity}</p>
        </div>

        <div className="bg-[#121826] p-6 rounded-xl">
          <h2>Prob ≥150k</h2>
          <p className="text-2xl">
            {(mc.probability * 100).toFixed(1)}%
          </p>
        </div>
      </div>

      <div className="bg-[#121826] p-6 rounded-xl">
        <h2>Decisión</h2>
        <p className="text-xl font-bold">{decision.action}</p>
        <p>{decision.explanation}</p>
        <p>Convicción: {decision.conviction.toFixed(0)}%</p>
      </div>

      <div className="bg-[#121826] p-6 rounded-xl">
        <h2>Resumen Ejecutivo</h2>
        <p>{summary}</p>
      </div>
    </div>
  )
}