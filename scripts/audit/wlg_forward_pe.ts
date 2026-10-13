// ================================================================
// WLG-PE — Paso 0 (Oct-2026): serie histórica de P/E forward del MSCI World
// + baseline rolling 10a, SIN look-ahead.
// ================================================================
// ESTADO: **NO VALIDADO** — mecanismo listo, SIN datos. Comprobado el 13-oct-2026:
//   no existe en el repo ningún CSV de P/E forward histórico con fuente
//   verificable, así que **NO se inventan datos** y la ruta de valoración de WLG
//   queda SIN VALIDAR. Mientras no haya CSV, el modo A (control) es el único que
//   se ejecuta; en modo B/C la inyección NO ocurre y el harness lo avisa.
//
// Lo consume el harness de backtest (scripts/audit/m3_rerun.ts), en modo
// opt-in (WLG_PE_MODE=B/C). En modo A (default) NO se llama.
//
// Entrada: CSV mensual [date, forwardPE, source]
//   - date = fecha de PUBLICACIÓN del dato (no la del período).
//   - Fuente documentada a elegir por el comité (MSCI World factsheet,
//     Yardeni como proxy, o ficha del proveedor del ETF). Ver
//     scripts/audit/propuesta_wlg_pe/PROPUESTA_WLG_PE.md.
// Salida: { d, wlgForwardPE, asOf, baseline, baselineReliable } sobre el grid.
//   - asOf = fecha de publicación del P/E vigente en d (trazabilidad; permite
//     registrar QUÉ dato y DE CUÁNDO se aplicó en cada semana).

import { readFileSync, existsSync } from "fs";

export interface WlgPePoint {
  d: string;
  wlgForwardPE: number;
  /** Fecha de publicación del dato vigente (la fila usada: publicationDate ≤ d). */
  asOf: string;
  baseline: number;
  baselineReliable: boolean;
}

export interface WlgPeSourceInfo {
  path: string;
  exists: boolean;
  rows: number;
  firstAsOf: string | null;
  lastAsOf: string | null;
}

const DAY = 86400000;
const toMs = (d: string) => Date.parse(d + "T00:00:00Z");

// Un aviso por fichero y motivo: buildWlgForwardPeSeries + wlgPeSourceInfo leen
// el mismo CSV y no deben duplicar el warning (ruido en el log canónico).
const warned = new Set<string>();
const warnOnce = (key: string, msg: string) => { if (!warned.has(key)) { warned.add(key); console.warn(msg); } };

type PeRow = { t: number; asOf: string; pe: number };

/**
 * Lee el CSV de P/E forward. TOLERANTE: si el fichero no existe (o no se puede
 * leer) devuelve [] con un aviso — NO lanza y NO inventa datos. El llamador
 * decide qué hacer con una serie vacía (el harness avisa y deja la ruta sin validar).
 */
export function readWlgPeRows(csvPath: string): PeRow[] {
  if (!existsSync(csvPath)) {
    warnOnce(`missing:${csvPath}`, `[WLG-PE] CSV no encontrado: ${csvPath} → serie vacía. La ruta de valoración queda SIN VALIDAR (no se inventan datos históricos).`);
    return [];
  }
  let raw: string;
  try {
    raw = readFileSync(csvPath, "utf8");
  } catch (e) {
    warnOnce(`unreadable:${csvPath}`, `[WLG-PE] CSV ilegible (${csvPath}): ${(e as Error).message} → serie vacía. Ruta SIN VALIDAR.`);
    return [];
  }
  const lines = raw.trim().split("\n").slice(1); // cabecera
  const rows: PeRow[] = [];
  let dropped = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    const c = l.split(",");
    const t = toMs(c[0]);
    const pe = Number(c[1]);
    if (!Number.isFinite(t) || !Number.isFinite(pe)) { dropped++; continue; }
    rows.push({ t, asOf: c[0], pe });
  }
  if (dropped > 0) warnOnce(`dropped:${csvPath}`, `[WLG-PE] ${dropped} fila(s) descartada(s) por fecha o valor no numérico (${csvPath}).`);
  if (rows.length === 0) warnOnce(`empty:${csvPath}`, `[WLG-PE] CSV sin filas válidas: ${csvPath} → serie vacía. Ruta SIN VALIDAR.`);
  return rows.sort((a, b) => a.t - b.t);
}

/** Metadatos de la fuente (para registrar en el harness qué se usó y de cuándo). */
export function wlgPeSourceInfo(csvPath: string): WlgPeSourceInfo {
  const rows = readWlgPeRows(csvPath);
  return {
    path: csvPath,
    exists: existsSync(csvPath),
    rows: rows.length,
    firstAsOf: rows[0]?.asOf ?? null,
    lastAsOf: rows[rows.length - 1]?.asOf ?? null,
  };
}

export function buildWlgForwardPeSeries(
  csvPath: string,
  grid: string[],
  opts?: { windowMonths?: number; minMonths?: number; prior?: number },
): WlgPePoint[] {
  const windowMonths = opts?.windowMonths ?? 120; // 10 años
  const minMonths    = opts?.minMonths    ?? 60;  // 5 años mínimo
  const prior        = opts?.prior        ?? 16;  // prior documentado

  const rows = readWlgPeRows(csvPath);

  const out: WlgPePoint[] = [];
  for (const d of grid) {
    const t = toMs(d);
    // 1) valor vigente: último con publicationDate <= t (sin look-ahead)
    let cur: number | undefined;
    let curAsOf = "";
    for (const r of rows) { if (r.t <= t) { cur = r.pe; curAsOf = r.asOf; } else break; }
    if (cur === undefined) continue;

    // 2) baseline rolling: SOLO registros con fecha <= t, ventana trailing
    const from = t - windowMonths * 30.44 * DAY;
    const win = rows.filter(r => r.t <= t && r.t >= from).map(r => r.pe);
    let baseline: number;
    let reliable: boolean;
    if (win.length >= minMonths) {
      const s = [...win].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      baseline = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2; // mediana
      reliable = true;
    } else {
      baseline = prior;
      reliable = false;
    }
    out.push({ d, wlgForwardPE: cur, asOf: curAsOf, baseline, baselineReliable: reliable });
  }
  return out;
}
