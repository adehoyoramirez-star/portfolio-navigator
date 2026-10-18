// ===============================================
// TEST: src/test/decisionLog.test.ts
// FIX-REG-AUDIT (Oct-2026): REGISTRO DE DECISIÓN COMPLETO Y TRAZABLE.
//
// Qué se protege aquí (los invariantes que hacen el registro auditable):
//   1. Los inputs MANUALES quedan ESTAMPADOS con valor + as_of + fuente.
//   2. Queda constancia de la política de data quality (stale / blocked).
//   3. El hash es determinista y encadenado; alterar una fila se detecta.
//   4. Sin red NADA se pierde: la fila queda pendiente y se reintenta.
//   5. El histórico del formato antiguo sigue siendo legible.
// ===============================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  logEngineDecision,
  loadDecisionRecords,
  loadDecisionHistory,
  loadLocalDecisionRows,
  pendingDecisionRecords,
  flushPendingDecisions,
  getChainHead,
  trimLocalRows,
  verifyLocalChain,
  clearDecisionLog,
  type LocalDecisionRow,
  type DecisionLogInput,
} from "../lib/decisionLog";
import {
  buildDecisionRecord,
  chainDecisionRecord,
  canonicalize,
  hashDecision,
  verifyDecisionRecord,
} from "../lib/decisionRecord";
import type { EngineOutput } from "../core/engine/olympusV3";
import { STORAGE_KEYS } from "../core/config/engineConfig";

const MACRO = { vix: 19, creditSpread: 1.5, yieldSpread: 0.4, m2Growth: 4.3 };
const AS_OF = Date.UTC(2026, 9, 1, 12, 0, 0); // 01-oct-2026 12:00 UTC

// Mock mínimo: el constructor del registro solo lee estos campos del motor.
function mockEngine(overrides: Record<string, unknown> = {}): EngineOutput {
  const base = {
    engineVersion: "v5.4.6",
    regime: "EXPANSION",
    masterRegime: { regimePenalty: 0.85 },
    correlationPenalty: 1,
    totalInvested: 0.9,
    volTargetMultiplier: 1,
    tailRiskOverlay: 1,
    tailRiskActive: false,
    tailRiskReason: "",
    killSwitchLevel: 0,
    killSwitchName: "NINGUNO",
    meta: {
      allCash: false,
      confidence: "HIGH",
      dominantSignal: "MOMENTUM",
      hasRealCovMatrix: true,
      dcaDataMissing: false,
      erpTriggered: false,
      erpValue: 0.025,
      correlationPanicTriggered: false,
      avgCorrelationValue: 0.4,
      absoluteTrendGateActive: false,
      absoluteTrendGateMultiplier: 1,
      absoluteTrendGateReason: "",
      absoluteTrendGateNegativeCount: 0,
      absoluteTrendGateNegativePct: 0,
      totalInvestedAlpha: 0.9,
      totalInvestedAfterGate: 0.9,
      totalInvestedBase: 0.85,
      erpCapFactor: 1,
      breadthPolicy: "PROVISIONAL_LEGACY",
      riskOverlayPriority: ["TAIL_RISK"],
      regimeBreadthDivergence: false,
      institutionalBreadthShadow: null,
      institutionalBreadthShadowApplied: false,
      breadthEffectiveMultiplier: 1,
      breadthEffectiveSource: "legacy",
      coreMode: false,
      coreTrendGateActive: false,
      coreTrendGateMultiplier: 1,
      coreTrendGateReason: "",
    },
    allocations: [
      {
        name: "BTC",
        finalAllocation: 0.2,
        blendedAllocation: 0.22,
        kellyFraction: 0.1,
        effectiveCap: 0.25,
        isCapped: false,
        expectedReturn: 0.15,
        provenance: null,
      },
    ],
    ...overrides,
  };
  return base as unknown as EngineOutput;
}

function logOnce(extra: Partial<DecisionLogInput> = {}) {
  return logEngineDecision({
    engineResult: mockEngine(),
    macro: MACRO,
    marketData: null,
    allocationsBefore: [],
    triggerReason: "test",
    capturedAt: AS_OF,
    ...extra,
  });
}

/** Respuesta mínima con la forma que consume el cliente (sin depender de `Response`). */
function okResponse(duplicate = false) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true, id: 1, duplicate, errors: [] }),
  };
}

beforeEach(() => {
  clearDecisionLog();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1. Canonicalización y hash: determinismo ───────────────────────────────
describe("canonicalize / hashDecision", () => {
  it("es determinista e independiente del orden de claves", () => {
    expect(canonicalize({ b: 1, a: [1, { z: undefined, y: 2 }] }))
      .toBe(canonicalize({ a: [1, { y: 2 }], b: 1 }));
  });

  it("normaliza NaN e Infinity a null (JSON no los admite)", () => {
    expect(canonicalize({ a: NaN })).toBe('{"a":null}');
    expect(canonicalize({ a: Infinity })).toBe('{"a":null}');
    expect(canonicalize({ a: -Infinity })).toBe('{"a":null}');
  });

  it("hashDecision es determinista", async () => {
    expect(await hashDecision("olympus")).toBe(await hashDecision("olympus"));
    expect(await hashDecision("olympus")).not.toBe(await hashDecision("olympus "));
  });
});

// ── 2. El registro incluye la procedencia de los inputs manuales ───────────
describe("buildDecisionRecord — procedencia y data quality", () => {
  it("estampa valor + as_of + fuente de cada input manual", () => {
    const rec = buildDecisionRecord({
      engineResult: mockEngine(),
      macro: MACRO,
      capturedAt: AS_OF,
      manualInputs: {
        mvrvZScore: { value: 6.4, asOfMs: AS_OF, source: "glassnode" },
        uraniumSpot: { value: 82.5, asOfMs: Date.UTC(2026, 8, 28), source: "manual" },
      },
      dataQuality: { stale: ["wlgEpsGrowth", "uraniumSpot"], blocked: ["wlgRsiWeekly"] },
    });

    const manual = (rec.inputs as Record<string, unknown>).manual as Record<string, {
      value: number; as_of: string; as_of_ms: number; source: string;
    }>;

    expect(manual.mvrvZScore.value).toBe(6.4);
    expect(manual.mvrvZScore.as_of).toBe(new Date(AS_OF).toISOString());
    expect(manual.mvrvZScore.source).toBe("glassnode");
    expect(manual.uraniumSpot.value).toBe(82.5);
    // stale/blocked se ordenan para que dos ejecuciones equivalentes den el
    // mismo registro (y por tanto el mismo hash).
    expect(rec.data_quality).toEqual({
      stale: ["uraniumSpot", "wlgEpsGrowth"],
      blocked: ["wlgRsiWeekly"],
    });
  });

  it("omite los inputs no declarados (undefined ≠ declarado como vacío)", () => {
    const rec = buildDecisionRecord({
      engineResult: mockEngine(),
      macro: MACRO,
      capturedAt: AS_OF,
      manualInputs: {
        dxy: { value: undefined, source: "yahoo" },
        mvrvZScore: { value: 6.4, source: "glassnode" },
      },
    });
    const manual = (rec.inputs as Record<string, unknown>).manual as Record<string, unknown>;
    expect(Object.keys(manual)).toEqual(["mvrvZScore"]);
  });

  it("etiqueta el camino de producción (core vs legacy) desde el motor", () => {
    const coreResult = mockEngine();
    (coreResult.meta as unknown as { coreMode: boolean }).coreMode = true;

    const legacy = buildDecisionRecord({ engineResult: mockEngine(), macro: MACRO, capturedAt: AS_OF });
    const core = buildDecisionRecord({ engineResult: coreResult, macro: MACRO, capturedAt: AS_OF });

    expect(legacy.path).toBe("legacy");
    expect(core.path).toBe("core");
  });
});

// ── 3. Cadena de hashes: enlace y detección de manipulación ────────────────
describe("cadena de hashes", () => {
  it("encadena el hash propio con el anterior y verifica", async () => {
    const r1 = await chainDecisionRecord(
      buildDecisionRecord({ engineResult: mockEngine(), macro: MACRO, capturedAt: AS_OF }),
      null,
    );
    const r2 = await chainDecisionRecord(
      buildDecisionRecord({ engineResult: mockEngine({ regime: "CONTRACTION" }), macro: MACRO, capturedAt: AS_OF }),
      r1.record_hash ?? null,
    );

    expect(r1.prev_hash).toBeNull();
    expect(r2.prev_hash).toBe(r1.record_hash);
    expect(r1.record_hash).not.toBe(r2.record_hash);

    const ok1 = await verifyDecisionRecord(r1, null);
    const ok2 = await verifyDecisionRecord(r2, r1.record_hash ?? null);
    expect(ok1.ok).toBe(true);
    expect(ok2.ok).toBe(true);
  });

  it("detecta una fila alterada (hash o enlace roto)", async () => {
    const r1 = await chainDecisionRecord(
      buildDecisionRecord({ engineResult: mockEngine(), macro: MACRO, capturedAt: AS_OF }),
      null,
    );

    const tampered = { ...r1, regime: "CRISIS" };
    const res = await verifyDecisionRecord(tampered, null);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("record_hash");

    // Enlace roto: el registro es coherente consigo mismo pero NO enlaza con
    // el anterior esperado → la cadena de custodia queda rota.
    const relinked = await chainDecisionRecord(
      buildDecisionRecord({ engineResult: mockEngine(), macro: MACRO, capturedAt: AS_OF }),
      "sha256:ajeno",
    );
    const res2 = await verifyDecisionRecord(relinked, null);
    expect(res2.ok).toBe(false);
    expect(res2.reason).toContain("prev_hash");
  });
});

// ── 4. Persistencia: sin red nada se pierde ────────────────────────────────
describe("logEngineDecision — persistencia y cola offline", () => {
  it("con red: guarda, sincroniza y encadena", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const r1 = await logOnce();
    const r2 = await logOnce();
    if (!r1 || !r2) throw new Error("el registro no debe devolver null");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r2.prev_hash).toBe(r1.record_hash);
    expect(pendingDecisionRecords()).toHaveLength(0);
    expect(loadDecisionRecords()).toHaveLength(2);
    expect(loadLocalDecisionRows()[0].record?.record_hash).toBe(r2.record_hash);

    const chain = await verifyLocalChain();
    expect(chain.ok).toBe(true);
    expect(chain.checked).toBe(2);
  });

  it("sin red: la fila queda PENDIENTE y el registro local se conserva", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));

    const rec = await logOnce();
    expect(rec).not.toBeNull();
    expect(pendingDecisionRecords()).toHaveLength(1);
    expect(getChainHead()).toBe(rec?.record_hash ?? null);
  });

  it("reintenta la cola y la marca sincronizada (idempotente por hash)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await logOnce();
    expect(pendingDecisionRecords()).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse(true)))); // 409: ya existía
    const res = await flushPendingDecisions();
    expect(res.synced).toBe(1);
    expect(pendingDecisionRecords()).toHaveLength(0);
  });

  it("no lanza si fetch no existe o el cuerpo no es JSON válido", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) })));
    await expect(logOnce()).resolves.not.toBeNull();
    expect(pendingDecisionRecords()).toHaveLength(1);
  });
});


// ── 5. Recorte local: nunca se descarta una fila pendiente ─────────────────
describe("trimLocalRows", () => {
  const row = (id: number, sync: LocalDecisionRow["sync"]): LocalDecisionRow => ({
    id,
    created_at: new Date(AS_OF).toISOString(),
    engine_version: "v5.4.6",
    regime: "EXPANSION",
    record_hash: `h${id}`,
    prev_hash: null,
    sync,
  });

  it("conserva siempre las pendientes al recortar", () => {
    const rows = [row(5, "synced"), row(4, "pending"), row(3, "synced"), row(2, "synced"), row(1, "synced")];
    const trimmed = trimLocalRows(rows, 3);
    expect(trimmed).toHaveLength(3);
    expect(trimmed.map(r => r.id)).toContain(4); // la pendiente sobrevive
    expect(trimmed.map(r => r.id)).toEqual([5, 4, 3]);
  });

  it("no toca el array si cabe entero", () => {
    const rows = [row(2, "synced"), row(1, "pending")];
    expect(trimLocalRows(rows, 10)).toEqual(rows);
  });
});

// ── 6. Compatibilidad con el histórico antiguo ─────────────────────────────
describe("compatibilidad con el formato anterior", () => {
  it("lee filas antiguas (sin registro canónico) y no las confunde con nuevas", async () => {
    localStorage.setItem("olympus_decision_log", JSON.stringify([
      {
        id: 1,
        created_at: "2026-09-01T00:00:00.000Z",
        engine_version: "v5.4.6",
        regime: "EXPANSION",
        regime_penalty: 0.85,
        vix: 19,
        trigger_reason: "manual",
      },
    ]));

    const hist = await loadDecisionHistory();
    expect(hist).toHaveLength(1);
    expect(hist[0].regime).toBe("EXPANSION");
    expect(hist[0].sync).toBe("synced");

    // Sin registro canónico no hay nada que encadenar ni enviar.
    expect(loadDecisionRecords()).toHaveLength(0);
    expect(getChainHead()).toBeNull();
  });
});

// ── 7. Extremo a extremo: lo que se PERSISTE lleva la procedencia ─────────
// El valor de auditoría no está en saber construir el registro, sino en que la
// fila guardada (y enviada) lleve los inputs manuales con su fecha y su fuente.
describe("registro persistido — la procedencia llega al almacén", () => {
  it("guarda el bloque manual, la política de data quality y el camino", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse())));

    await logOnce({
      path: "core",
      dataQuality: { stale: ["wlgEpsGrowth"], blocked: ["wlgRsiWeekly"] },
      manualInputs: {
        mvrvZScore: { value: 6.4, asOfMs: AS_OF, source: "manual:glassnode" },
        manualPER: { value: 29.69, source: "manual (P/E TTM S&P 500)" },
      },
    });

    const row = loadLocalDecisionRows()[0];
    if (!row.record) throw new Error("la fila debe conservar el registro canónico");
    const rec = row.record;

    const manual = (rec.inputs as Record<string, unknown>).manual as Record<
      string,
      { value: number; as_of: string; as_of_ms: number; source: string }
    >;
    expect(Object.keys(manual)).toEqual(["manualPER", "mvrvZScore"]); // ordenado → hash estable
    expect(manual.mvrvZScore.value).toBe(6.4);
    expect(manual.mvrvZScore.as_of).toBe(new Date(AS_OF).toISOString());
    expect(manual.mvrvZScore.as_of_ms).toBe(AS_OF);
    expect(manual.mvrvZScore.source).toBe("manual:glassnode");
    expect(manual.manualPER.source).toContain("P/E");

    expect(rec.data_quality).toEqual({ stale: ["wlgEpsGrowth"], blocked: ["wlgRsiWeekly"] });
    expect(rec.path).toBe("core");
    expect(row.sync).toBe("synced");
  });

  it("sella la versión de CONFIGURACIÓN (sin ella no se sabe con qué config se decidió)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse())));
    await logOnce();
    const rec = loadLocalDecisionRows()[0].record;
    if (!rec) throw new Error("la fila debe conservar el registro canónico");
    expect(rec.config_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(rec.config_version).not.toBe("unversioned");
  });

  it("una fila manipulada en el espejo local rompe la cadena y se detecta", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse())));
    await logOnce();
    await logOnce();

    // Manipulación directa del almacén local: se reescribe el régimen de la fila
    // MÁS ANTIGUA. Su hash deja de coincidir con su contenido → eslabón roto.
    const key = STORAGE_KEYS.DECISION_LOG;
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ record: { regime: string } }>;
    raw[1].record.regime = "CRISIS";
    localStorage.setItem(key, JSON.stringify(raw));

    const chain = await verifyLocalChain();
    expect(chain.ok).toBe(false);
    expect(chain.reason).toContain("record_hash");
  });
});

describe("sombras CORE / CORE-DEF dentro del registro (evidencia forward persistida)", () => {
  const shadow = { engineVersion: "v5.4.6", regime: "EXPANSION", totalInvested: 1, allocations: [{ name: "BTC", finalAllocation: 0.4 }, { name: "Oro", finalAllocation: 0.6 }] };

  it("guarda las sombras en breadth con los pesos redondeados", () => {
    const e = mockEngine();
    (e.meta as unknown as Record<string, unknown>).coreShadow = shadow;
    (e.meta as unknown as Record<string, unknown>).coreDefShadow = { ...shadow, volTargetMultiplier: 0.8, tailRiskOverlay: 1, killSwitchLevel: 1 };
    const r = buildDecisionRecord({ engineResult: e, macro: MACRO, capturedAt: AS_OF });
    const b = r.breadth as Record<string, { weights?: Record<string, number>; kill_switch_level?: number; vol_target_multiplier?: number }>;
    expect(b.core_shadow.weights).toEqual({ BTC: 0.4, Oro: 0.6 });
    expect(b.core_def_shadow.kill_switch_level).toBe(1);
    expect(b.core_def_shadow.vol_target_multiplier).toBe(0.8);
  });

  it("sin sombra el registro NO cambia (el hash anterior sigue válido)", async () => {
    const r = buildDecisionRecord({ engineResult: mockEngine(), macro: MACRO, capturedAt: AS_OF });
    expect("core_shadow" in (r.breadth as object)).toBe(false);
    expect("core_def_shadow" in (r.breadth as object)).toBe(false);
  });

  it("la sombra entra en el hash: alterarla se detecta", async () => {
    const e = mockEngine();
    (e.meta as unknown as Record<string, unknown>).coreShadow = shadow;
    const r = await chainDecisionRecord(buildDecisionRecord({ engineResult: e, macro: MACRO, capturedAt: AS_OF }), null);
    expect((await verifyDecisionRecord(r, null)).ok).toBe(true);
    const tampered = JSON.parse(JSON.stringify(r));
    tampered.breadth.core_shadow.weights.Oro = 0.1;
    expect((await verifyDecisionRecord(tampered, null)).ok).toBe(false);
  });
});
