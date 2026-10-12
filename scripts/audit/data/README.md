# scripts/audit/data — fuentes y fecha

Descargado: 2026-10-08T11:19:27.845Z · comando: `npx tsx scripts/audit/fase1_data.ts`

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
