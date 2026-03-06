export function clippedERP(erp: number): number {
  return Math.max(-0.03, Math.min(0.05, erp));
}