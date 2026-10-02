// FASE 3B · CORRECCIÓN 5 — CONTROL MUERTO (dcaEngine liquidación 30%).
//  Verifica que la "VENTA DE EMERGENCIA" NO tiene consumidores fuera de la capa de
//  compatibilidad (dcaEngine.ts + olympusV3.ts output.dca). No conectada a ejecución.
import { describe, test, expect } from "vitest";
import fs from "fs";
import path from "path";
import { computeDCADecision } from "../core/dca/dcaEngine";

const ALLOWED = new Set([
  path.join("core", "dca", "dcaEngine.ts"),
  path.join("core", "engine", "olympusV3.ts"),
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("CORRECCIÓN 5 — liquidación 30% es control muerto", () => {
  test("ningún consumidor de `investAmount` fuera de la capa de compatibilidad", () => {
    const root = path.join(process.cwd(), "src");
    const files = walk(root);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(root, f);
      if (ALLOWED.has(rel) || rel.startsWith("test")) continue;
      const txt = fs.readFileSync(f, "utf8");
      if (/\binvestAmount\b/.test(txt)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("en pánico devuelve una notificación (investAmount<0) pero effectiveIntensity=0 → no es una orden ejecutable", () => {
    const r = computeDCADecision({ regime: "CRISIS", portfolioVolatility: 0.50, availableCash: 0, totalPortfolioValue: 10_000 });
    expect(r.investAmount).toBeLessThan(0);
    expect(r.effectiveIntensity).toBe(0);
    expect(r.baseIntensity).toBe(0);
    expect(r.riskConstraintActive).toBe(true);
  });
});
