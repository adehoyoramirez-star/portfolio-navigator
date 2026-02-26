import ExecutiveSummary from "./ExecutiveSummary"
import LiquidityPanel from "./LiquidityPanel"
import SignalsPanel from "./SignalsPanel"
import RiskPanel from "./RiskPanel"
import MarketRegimePanel from "./MarketRegimePanel"
import { Recommendation } from "@/types/analytics"

export default function InstitutionalDashboard() {
  const recommendations: Recommendation[] = []

  return (
    <div className="bg-[#0E1117] text-gray-200 min-h-screen p-6 space-y-6">
      <ExecutiveSummary />
      <MarketRegimePanel />
      <LiquidityPanel />
      <SignalsPanel recommendations={recommendations} />
      <RiskPanel />
    </div>
  )
}