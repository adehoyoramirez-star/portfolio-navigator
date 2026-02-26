export interface MonteCarloResult {
  probability: number
  p5: number
  p50: number
  p95: number
}

function randomNormal(): number {
  const u = Math.random()
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function monteCarlo(
  initial: number,
  target: number,
  mu: number,
  vol: number,
  years: number,
  monthlyContribution: number
): MonteCarloResult {
  const sims = 50000
  const months = years * 12
  const monthlyMu = mu / 12
  const monthlyVol = vol / Math.sqrt(12)
  const results: number[] = []

  for (let s = 0; s < sims; s++) {
    let value = initial

    for (let m = 0; m < months; m++) {
      const shock = randomNormal()
      const ret = monthlyMu + monthlyVol * shock
      value = value * (1 + ret) + monthlyContribution
    }

    results.push(value)
  }

  const sorted = results.sort((a, b) => a - b)

  return {
    probability: results.filter(v => v >= target).length / sims,
    p5: sorted[Math.floor(0.05 * sims)],
    p50: sorted[Math.floor(0.5 * sims)],
    p95: sorted[Math.floor(0.95 * sims)]
  }
}