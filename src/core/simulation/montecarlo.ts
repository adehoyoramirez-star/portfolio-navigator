export function monteCarloSimulation(
  mu: number,
  sigma: number,
  years: number,
  simulations = 5000
): number[] {
  const results: number[] = [];
  for (let i = 0; i < simulations; i++) {
    let value = 1;
    for (let t = 0; t < years; t++) {
      const randomShock = (mu - 0.5 * sigma ** 2) + sigma * randomNormal();
      value *= Math.exp(randomShock);
    }
    results.push(value);
  }
  return results;
}

function randomNormal(): number {
  return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
}