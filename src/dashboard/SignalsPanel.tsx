import { Recommendation } from "@/types/analytics"

interface Props {
  recommendations: Recommendation[]
}

export default function SignalsPanel({ recommendations }: Props) {
  return (
    <div className="bg-[#161B22] p-6 rounded-xl">
      <h2 className="text-xl font-semibold mb-4">
        Sugerencias de Compra / Venta
      </h2>

      {recommendations.length === 0 && (
        <p className="text-gray-400 text-sm">
          No hay recomendaciones generadas.
        </p>
      )}

      {recommendations.map((rec: Recommendation, idx: number) => (
        <div key={idx} className="border-b border-gray-700 py-3">
          <div className="flex justify-between">
            <span className="font-bold">{rec.ticker}</span>
            <span
              className={`font-semibold ${
                rec.action === "BUY"
                  ? "text-green-400"
                  : rec.action === "SELL"
                  ? "text-red-400"
                  : "text-yellow-400"
              }`}
            >
              {rec.action}
            </span>
          </div>

          <p className="text-sm text-gray-400 mt-2">{rec.rationale}</p>

          <p className="text-xs mt-1">
            Convicción: {rec.conviction}%
          </p>
        </div>
      ))}
    </div>
  )
}