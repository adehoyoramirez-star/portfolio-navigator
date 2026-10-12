// ============================================================
// scripts/audit/fase1_data.ts — FASE 1: datos reales largos
// Fuentes (todas públicas, sin key):
//   FRED CSV: DFII10 (real 10Y TIPS), T10YIE (breakeven), BAMLH0A0HYM2
//             (spread HY), DTWEXBGS (dólar amplio, alternativa declarada a DXY)
//   Yahoo chart (UA browser): ^GSPC, ^SOX, EEM, GLD, URTH, BTC-USD, DX-Y.NYB, ^IRX
//   Coin Metrics Community: CapMVRVCur, CapMrktCurUSD, CapRealUSD, IssTotUSD (btc, 1d)
// Guarda CSV crudo en scripts/audit/data/ + README con fecha y fuente.
// Ejecutar: npx tsx scripts/audit/fase1_data.ts
// ============================================================
import { writeFileSync, mkdirSync, existsSync } from "fs";

const OUT = "audit/data";
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" };

async function fetchRetry(url: string, tries = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      return r;
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw new Error(`fetch falló tras ${tries} intentos: ${url} · ${lastErr}`);
}

// ── FRED ────────────────────────────────────────────────────────
async function fred(id: string, cosd = "1990-01-01") {
  const r = await fetchRetry(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`);
  const txt = await r.text();
  writeFileSync(`${OUT}/fred_${id}.csv`, txt);
  const rows = txt.trim().split("\n").length;
  const first = txt.split("\n")[1]?.split(",")[0];
  console.log(`FRED ${id}: ${rows - 1} filas, primera ${first}, http ${r.status}`);
}

// ── Yahoo chart ─────────────────────────────────────────────────
async function yahoo(ticker: string) {
  const period1 = Date.UTC(1980, 0, 1) / 1000;
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
  const r = await fetchRetry(url);
  const j = await r.json() as any;
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`yahoo ${ticker}: sin result (${JSON.stringify(j?.chart?.error).slice(0, 120)})`);
  const ts: number[] = res.timestamp ?? [];
  const closes: (number | null)[] = res.indicators?.quote?.[0]?.close ?? [];
  const adj: (number | null)[] = res.indicators?.adjclose?.[0]?.adjclose ?? closes;
  let lines = "date,close,adjclose\n";
  let kept = 0;
  for (let i = 0; i < ts.length; i++) {
    const c = adj[i] ?? closes[i];
    if (c === null || c === undefined || !Number.isFinite(c)) continue;
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    lines += `${d},${closes[i]},${c}\n`;
    kept++;
  }
  writeFileSync(`${OUT}/yahoo_${ticker.replace(/[^A-Za-z0-9]/g, "_")}.csv`, lines);
  console.log(`YAHOO ${ticker}: ${kept} filas, primera ${lines.split("\n")[1]?.split(",")[0]}, http ${r.status}`);
}

// ── Coin Metrics Community ──────────────────────────────────────
async function coinmetrics() {
  // CapRealUSD está FORBIDDEN en tier Community. Identidad: MVRV = Cap/RealCap
  //   ⇒ RealCap = Cap/MVRV. Pedimos CapMVRVCur + CapMrktCurUSD + IssTotUSD por separado.
  const wanted = ["CapMVRVCur", "CapMrktCurUSD", "IssTotUSD"];
  const per: Record<string, Map<string, string>> = {};
  for (const m of wanted) {
    let all: any[] = [];
    let nextPageToken: string | undefined;
    do {
      const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=${m}&frequency=1d&page_size=10000` + (nextPageToken ? `&next_page_token=${nextPageToken}` : "");
      const r = await fetchRetry(url);
      const j = await r.json() as any;
      if (!j.data) { console.log(`COINMETRICS ${m}: NO DISPONIBLE (${JSON.stringify(j.error ?? j).slice(0, 160)})`); all = []; break; }
      all = all.concat(j.data);
      nextPageToken = j.next_page_token;
      await sleep(300);
    } while (nextPageToken);
    per[m] = new Map(all.map(x => [x.time.slice(0, 10), String(x[m])]));
    if (all.length) console.log(`COINMETRICS ${m}: ${all.length} filas (${all[0].time.slice(0, 10)} → ${all[all.length - 1].time.slice(0, 10)})`);
  }
  const dates = [...per["CapMVRVCur"].keys()].sort();
  let csv = "date,CapMVRVCur,CapMrktCurUSD,CapRealUSD,IssTotUSD\n";
  for (const day of dates) {
    const mv = per["CapMVRVCur"].get(day) ?? "";
    const cap = per["CapMrktCurUSD"].get(day) ?? "";
    const real = mv && cap ? String(Number(cap) / Number(mv)) : "";
    csv += `${day},${mv},${cap},${real},${per["IssTotUSD"].get(day) ?? ""}\n`;
  }
  writeFileSync(`${OUT}/coinmetrics_btc.csv`, csv);
  console.log(`COINMETRICS combinado: ${dates.length} días`);
}

const YAHOO_TICKERS = ["^GSPC", "^SOX", "EEM", "GLD", "URTH", "BTC-USD", "DX-Y.NYB", "^IRX"];

const main = async () => {
  const stamp = new Date().toISOString();
  console.log(`[fase1_data] descarga ${stamp}`);
  for (const id of [["DFII10", "2003-01-01"], ["T10YIE", "2003-01-01"], ["BAMLH0A0HYM2", "1996-01-01"], ["DTWEXBGS", "2006-01-01"]] as const) {
    try { await fred(id[0], id[1]); } catch (e) { console.log(`FRED ${id[0]}: FALLO ${e}`); }
    await sleep(400);
  }
  for (const t of YAHOO_TICKERS) {
    try { await yahoo(t); } catch (e) { console.log(`YAHOO ${t}: FALLO ${e}`); }
    await sleep(900);
  }
  try { await coinmetrics(); } catch (e) { console.log(`COINMETRICS: FALLO ${e}`); }
  writeFileSync(`${OUT}/README.md`,
`# scripts/audit/data — fuentes y fecha

Descargado: ${stamp} · comando: \`npx tsx scripts/audit/fase1_data.ts\`

| Fichero | Fuente | Serie | Notas |
|---|---|---|---|
| fred_DFII10.csv | FRED graph CSV | Tipo real 10Y TIPS (%) | desde 2003-01 |
| fred_T10YIE.csv | FRED | Breakeven 10Y (%) | desde 2003 |
| fred_BAMLH0A0HYM2.csv | FRED | Spread HY OAS (pp) | desde 1996 |
| fred_DTWEXBGS.csv | FRED | Índice dólar amplio | desde 2006 (alt. declarada a DXY) |
| yahoo_^GSPC.csv → yahoo__GSPC.csv | Yahoo chart | SPX | adjclose |
| yahoo_^SOX.csv → yahoo__SOX.csv | Yahoo chart | PHLX Semiconductor | adjclose |
| yahoo_EEM.csv | Yahoo | iShares EM | desde 2003-04 |
| yahoo_GLD.csv | Yahoo | oro físico | desde 2004-11 |
| yahoo_URTH.csv | Yahoo | MSCI World | desde 2012-01 |
| yahoo_BTC-USD.csv | Yahoo | BTC | desde 2014-09 |
| yahoo_DX-Y.NYB.csv | Yahoo | DXY | Ice BofA |
| yahoo_^IRX.csv → yahoo__IRX.csv | Yahoo | T-bill 3m (%) | para cash rendimientado |
| coinmetrics_btc.csv | Coin Metrics Community API | CapMVRVCur, CapMrktCurUSD, CapRealUSD, IssTotUSD | desde 2010-07 |

Sin rellenado hacia atrás: cada serie empieza en su primera barra real.
`, "utf8");
  console.log("[fase1_data] OK");
};
main();
