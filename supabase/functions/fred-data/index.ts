// supabase/functions/fred-data/index.ts
// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

// ============================================================
// FRED Data Fetcher — Edge Function con cron diario
// ============================================================
// Recupera series macro: M2SL, BAML credit spread, T5YIFR breakeven.
// CAPE requiere Shiller data (manual hasta integrar dataset completo).
//
// Cron: 08:00 UTC diario (pre-market Europa).
// Requiere: FRED_API_KEY en Supabase Secrets.
// Registro gratuito: https://fred.stlouisfed.org/docs/api/api_key.html
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FRED_API_KEY = Deno.env.get("FRED_API_KEY") ?? "";

interface FredDataPoint {
  date: string;
  value: string;
}

interface FredResponse {
  observations: FredDataPoint[];
}

export interface FredOutput {
  m2GrowthYoY: number;
  cape: number;
  creditSpread: number;
  inflationBreakeven5y: number;
  fetchedAt: string;
  source: "FRED" | "error";
  errors: string[];
}

async function fetchFredSeries(seriesId: string): Promise<FredDataPoint[]> {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=24`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`FRED API ${res.status} for ${seriesId}`);
  }
  const json: FredResponse = await res.json();
  return json.observations.filter(o => o.value !== ".");
}

function computeM2YoY(observations: FredDataPoint[]): number | null {
  if (observations.length < 13) return null;
  const latest = parseFloat(observations[0].value);
  const yearAgo = parseFloat(observations[12].value);
  if (!latest || !yearAgo || yearAgo <= 0) return null;
  return ((latest / yearAgo) - 1) * 100;
}

function getLatestValue(observations: FredDataPoint[]): number | null {
  if (observations.length === 0) return null;
  return parseFloat(observations[0].value);
}

async function fetchAllFred(): Promise<FredOutput> {
  const errors: string[] = [];
  let m2GrowthYoY = 5.2;
  const cape = 29.5;
  let creditSpread = 3.0;
  let inflationBreakeven5y = 2.35;

  if (!FRED_API_KEY) {
    return {
      m2GrowthYoY, cape, creditSpread, inflationBreakeven5y,
      fetchedAt: new Date().toISOString(), source: "error",
      errors: ["FRED_API_KEY not configured in Supabase Secrets"],
    };
  }

  const results = await Promise.allSettled([
    fetchFredSeries("M2SL"),
    fetchFredSeries("BAMLH0A0HYM2"),
    fetchFredSeries("T5YIFR"),
  ]);

  if (results[0].status === "fulfilled") {
    const m2YoY = computeM2YoY(results[0].value);
    if (m2YoY !== null) m2GrowthYoY = parseFloat(m2YoY.toFixed(2));
    else errors.push("M2SL: insufficient data for YoY");
  } else errors.push(`M2SL: ${results[0].reason}`);

  if (results[1].status === "fulfilled") {
    const val = getLatestValue(results[1].value);
    if (val !== null) creditSpread = parseFloat(val.toFixed(2));
    else errors.push("BAMLH0A0HYM2: no data");
  } else errors.push(`BAMLH0A0HYM2: ${results[1].reason}`);

  if (results[2].status === "fulfilled") {
    const val = getLatestValue(results[2].value);
    if (val !== null) inflationBreakeven5y = parseFloat(val.toFixed(2));
    else errors.push("T5YIFR: no data");
  } else errors.push(`T5YIFR: ${results[2].reason}`);

  errors.push("CAPE: manual input (Shiller data not yet integrated)");

  return {
    m2GrowthYoY, cape, creditSpread, inflationBreakeven5y,
    fetchedAt: new Date().toISOString(),
    source: errors.length <= 1 ? "FRED" : "error", errors,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const data = await fetchAllFred();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    console.error("fred-data error:", err);
    return new Response(JSON.stringify({
      m2GrowthYoY: 5.2, cape: 29.5, creditSpread: 3.0, inflationBreakeven5y: 2.35,
      fetchedAt: new Date().toISOString(), source: "error",
      errors: [(err as Error)?.message ?? String(err)],
    } satisfies FredOutput), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
