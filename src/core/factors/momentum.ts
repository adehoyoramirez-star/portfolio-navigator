export interface MomentumInput {
  returns12m: number;
  returns1m: number;
  returns3m: number;
}

export interface MomentumResult {
  momentumScore: number;
  momentum12_1: number;
  momentum3m: number;
}

export function calculateMomentum(input: MomentumInput): MomentumResult {
  const { returns12m, returns1m, returns3m } = input;
  const momentum12_1 = returns12m - returns1m;
  const momentum3m = returns3m;
  const momentumScore = momentum12_1 * 0.7 + momentum3m * 0.3;
  return { momentumScore, momentum12_1, momentum3m };
}