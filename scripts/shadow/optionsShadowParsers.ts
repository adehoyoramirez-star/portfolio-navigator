// ============================================================
// scripts/shadow/optionsShadowParsers.ts
// Parsers PUROS (sin red) de las respuestas de Yahoo chart y Deribit DVOL.
// Separados del script de descarga para poder testearlos con fixtures.
//
// Formato Deribit verificado contra docs.deribit.com (public/get_volatility_index_data):
//   result.data = [[timestamp_ms, open, high, low, close], ...]
//   result.continuation = entero (end_timestamp de la siguiente petición) o null
// ============================================================

export type Bars = Map<string, number>;

export function utcDay(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

/** Descarta la barra del día UTC en curso salvo que ya sean >= 21:00 UTC (cierre EE. UU. completo). */
export function isCompleteDay(day: string, now: Date): boolean {
  const today = now.toISOString().slice(0, 10);
  if (day < today) return true;
  if (day > today) return false;
  return now.getUTCHours() >= 21;
}

/** Yahoo chart v8 → barras diarias {YYYY-MM-DD → cierre SIN ajustar}. */
export function parseYahooChart(json: any, now: Date): Bars {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error("respuesta sin chart.result");
  const ts: number[] = r.timestamp ?? [];
  const close: Array<number | null> = r.indicators?.quote?.[0]?.close ?? [];
  const out: Bars = new Map();
  for (let i = 0; i < ts.length; i++) {
    const px = close[i];
    if (px == null || !Number.isFinite(px) || px <= 0) continue;
    const day = utcDay(ts[i]);
    if (!isCompleteDay(day, now)) continue;
    out.set(day, px);
  }
  return out;
}

/** Valor mínimo plausible de DVOL en puntos porcentuales (nunca ha estado cerca de 5). */
export const DVOL_MIN_PLAUSIBLE_PCT = 5;

/**
 * Deribit DVOL → barras diarias. Devuelve también `continuation` (o null).
 * Lanza si la unidad parece fracción (mediana < 5): sería un escalado silencioso erróneo (I3).
 */
export function parseDeribitDvol(
  json: any,
  now: Date,
): { bars: Bars; continuation: number | null } {
  const data: unknown = json?.result?.data;
  if (!Array.isArray(data)) throw new Error("respuesta sin result.data");
  const bars: Bars = new Map();
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = Number(row[0]);
    const c = Number(row[4]);
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
    const day = utcDay(t / 1000);
    if (!isCompleteDay(day, now)) continue;
    bars.set(day, c);
  }
  if (bars.size > 0) {
    const vals = [...bars.values()].sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length / 2)];
    if (median < DVOL_MIN_PLAUSIBLE_PCT) {
      throw new Error(
        `DVOL con unidad inesperada (mediana ${median}); se esperaba % (p. ej. 45). Serie descartada.`,
      );
    }
  }
  const cont = json?.result?.continuation;
  return { bars, continuation: typeof cont === "number" && Number.isFinite(cont) ? cont : null };
}
