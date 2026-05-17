// ============================================================
// src/core/tactical/tacticalUniverse.ts — v5
// CORRECCIONES:
//   - ✅ v2: ADR/US fallbacks para todos los valores europeos, 9 fallbacks rotos arreglados
//   - ✅ v2: RSX eliminado, BAS.DE eliminado (duplicado)
//   - ✅ v3: Fallbacks añadidos a todos los activos sin fallbackYahooSymbol
//   - ✅ v3: Fallbacks OTC thin sustituidos (THLEF→ITA, BOUYE→XLI, etc.)
//   - ✅ v4: Fallbacks que coincidían con activos del propio universo (XLF, XLU,
//     XLI, XLK, JETS) sustituidos por tickers líquidos fuera del universo
//     (C, NEE, CAT, AMT, DAL, TGT, UAL) — evita el bug de "alreadyHave=false
//     porque el propio activo US también falló en el batch primario"
//   - ✅ v5: XLE → fallback VDE (Vanguard Energy); XOM → fallback CVX (Chevron)
//     Ambos confirmados fallando en log real sin fallback, usando GLD (incorrecto)
// Universo táctico ~189 activos | XETRA · Euronext · LSE · NYSE · NASDAQ
// Compatible con Interactive Brokers (ibkrExchange · ibkrSymbol · ibkrSecType)
// ============================================================

export interface UniverseAsset {
  ticker:               string;
  name:                 string;
  sector:               string;
  type:                 'ETF' | 'ETC' | 'CRYPTO' | 'STOCK';
  exchange:             string;
  currency:             'EUR' | 'USD' | 'GBP';
  yahooSymbol:          string;
  fallbackYahooSymbol?: string;
  ibkrExchange:         string;   // IBIS | AEB | LSE | SBF | NYSE | NASDAQ | PAXOS
  ibkrSymbol:           string;
  ibkrSecType:          'STK' | 'CRYPTO' | 'CFD';
}

// ── Portfolio Olympus (7 ETFs core — siempre monitorizados) ──
export const OLYMPUS_ASSETS: UniverseAsset[] = [
  { ticker:'BTC-EUR',  name:'Bitcoin EUR',                  sector:'Crypto',      type:'CRYPTO', exchange:'Crypto',    currency:'EUR', yahooSymbol:'BTC-EUR',  fallbackYahooSymbol:'BTC-USD', ibkrExchange:'PAXOS', ibkrSymbol:'BTC',  ibkrSecType:'CRYPTO' },
  { ticker:'IS3Q.DE',  name:'iShares MSCI World Quality',   sector:'Equity',      type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'IS3Q.DE',  fallbackYahooSymbol:'URTH',    ibkrExchange:'IBIS',  ibkrSymbol:'IS3Q', ibkrSecType:'STK' },
  { ticker:'VVSM.DE',  name:'VanEck Semiconductor',         sector:'Technology',  type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'VVSM.DE',  fallbackYahooSymbol:'SMH',     ibkrExchange:'IBIS',  ibkrSymbol:'VVSM', ibkrSecType:'STK' },
  { ticker:'URNU.DE',  name:'Global X Uranium',             sector:'Energy',      type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'URNU.DE',  fallbackYahooSymbol:'URA',     ibkrExchange:'IBIS',  ibkrSymbol:'URNU', ibkrSecType:'STK' },
  { ticker:'EMXC.DE',  name:'iShares MSCI EM ex-China',     sector:'Emerging',    type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'EMXC.DE',  fallbackYahooSymbol:'EEM',     ibkrExchange:'IBIS',  ibkrSymbol:'EMXC', ibkrSecType:'STK' },
  { ticker:'PPFB.DE',  name:'iShares Physical Gold',        sector:'Commodities', type:'ETC',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'PPFB.DE',  fallbackYahooSymbol:'GLD',     ibkrExchange:'IBIS',  ibkrSymbol:'PPFB', ibkrSecType:'STK' },
  { ticker:'XNAS.DE',  name:'iShares NASDAQ 100 UCITS',     sector:'Technology',  type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'XNAS.DE',  fallbackYahooSymbol:'QQQ',     ibkrExchange:'IBIS',  ibkrSymbol:'XNAS', ibkrSecType:'STK' },
];

// ── ETFs / ETCs UCITS (55 activos) ───────────────────────────
export const UCITS_ETFS: UniverseAsset[] = [
  // Índices globales
  { ticker:'CSPX.AS',  name:'iShares Core S&P 500 UCITS',         sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CSPX.AS',  fallbackYahooSymbol:'SPY',   ibkrExchange:'AEB',  ibkrSymbol:'CSPX',  ibkrSecType:'STK' },
  { ticker:'CNDX.AS',  name:'iShares Core NASDAQ 100 UCITS',       sector:'Technology',     type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CNDX.AS',  fallbackYahooSymbol:'QQQ',   ibkrExchange:'AEB',  ibkrSymbol:'CNDX',  ibkrSecType:'STK' },
  { ticker:'IWDA.AS',  name:'iShares Core MSCI World UCITS',       sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'IWDA.AS',  fallbackYahooSymbol:'URTH',  ibkrExchange:'AEB',  ibkrSymbol:'IWDA',  ibkrSecType:'STK' },
  { ticker:'IUSN.DE',  name:'iShares MSCI World Small Cap',        sector:'Small Cap',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IUSN.DE',  fallbackYahooSymbol:'IWM',   ibkrExchange:'IBIS', ibkrSymbol:'IUSN',  ibkrSecType:'STK' },
  { ticker:'EIMI.AS',  name:'iShares Core MSCI EM UCITS',          sector:'Emerging',       type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EIMI.AS',  fallbackYahooSymbol:'EEM',   ibkrExchange:'AEB',  ibkrSymbol:'EIMI',  ibkrSecType:'STK' },
  { ticker:'EMBE.AS',  name:'iShares JPM USD EM Bond UCITS',       sector:'Emerging Bonds', type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EMBE.AS',  fallbackYahooSymbol:'EMB',   ibkrExchange:'AEB',  ibkrSymbol:'EMBE',  ibkrSecType:'STK' },
  { ticker:'IWDA.L',   name:'iShares Core MSCI World (LSE)',        sector:'Equity',         type:'ETF', exchange:'LSE',      currency:'GBP', yahooSymbol:'IWDA.L',   fallbackYahooSymbol:'URTH',  ibkrExchange:'LSE',  ibkrSymbol:'IWDA',  ibkrSecType:'STK' },
  { ticker:'CSP1.L',   name:'iShares Core S&P 500 (LSE)',           sector:'Equity',         type:'ETF', exchange:'LSE',      currency:'GBP', yahooSymbol:'CSP1.L',   fallbackYahooSymbol:'SPY',   ibkrExchange:'LSE',  ibkrSymbol:'CSP1',  ibkrSecType:'STK' },
  // Europa
  { ticker:'EXH3.DE',  name:'iShares Core DAX UCITS',              sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXH3.DE',  fallbackYahooSymbol:'EWG',   ibkrExchange:'IBIS', ibkrSymbol:'EXH3',  ibkrSecType:'STK' },
  { ticker:'DBXD.DE',  name:'Xtrackers DAX UCITS',                 sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DBXD.DE',  fallbackYahooSymbol:'EWG',   ibkrExchange:'IBIS', ibkrSymbol:'DBXD',  ibkrSecType:'STK' },  // FIX: DAX→EWG
  { ticker:'IMEA.AS',  name:'iShares Core MSCI Europe UCITS',      sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'IMEA.AS',  fallbackYahooSymbol:'IEUR',  ibkrExchange:'AEB',  ibkrSymbol:'IMEA',  ibkrSecType:'STK' },
  { ticker:'XESX.DE',  name:'Xtrackers Euro Stoxx 50 UCITS',       sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'XESX.DE',  fallbackYahooSymbol:'FEZ',   ibkrExchange:'IBIS', ibkrSymbol:'XESX',  ibkrSecType:'STK' },
  { ticker:'EXSA.DE',  name:'iShares STOXX Europe 600 UCITS',      sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXSA.DE',  fallbackYahooSymbol:'VGK',   ibkrExchange:'IBIS', ibkrSymbol:'EXSA',  ibkrSecType:'STK' },  // FIX: STOXX→VGK
  { ticker:'MEUD.PA',  name:'Lyxor MSCI Europe UCITS',             sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'MEUD.PA',  fallbackYahooSymbol:'IEUR',  ibkrExchange:'SBF',  ibkrSymbol:'MEUD',  ibkrSecType:'STK' },
  // Norteamérica
  { ticker:'CS51.DE',  name:'iShares MSCI USA UCITS',              sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'CS51.DE',  fallbackYahooSymbol:'SPY',   ibkrExchange:'IBIS', ibkrSymbol:'CS51',  ibkrSecType:'STK' },  // FIX: IUSA→SPY
  { ticker:'XD9U.DE',  name:'Xtrackers MSCI USA UCITS',            sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'XD9U.DE',  fallbackYahooSymbol:'SPY',   ibkrExchange:'IBIS', ibkrSymbol:'XD9U',  ibkrSecType:'STK' },  // FIX: IUSA→SPY
  // Asia / Emergentes
  { ticker:'IAPD.AS',  name:'iShares MSCI Pacific ex-Japan UCITS', sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'IAPD.AS',  fallbackYahooSymbol:'EPP',   ibkrExchange:'AEB',  ibkrSymbol:'IAPD',  ibkrSecType:'STK' },
  { ticker:'EMIN.AS',  name:'iShares MSCI India UCITS',            sector:'Emerging',       type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EMIN.AS',  fallbackYahooSymbol:'INDA',  ibkrExchange:'AEB',  ibkrSymbol:'EMIN',  ibkrSecType:'STK' },
  { ticker:'CNYA.AS',  name:'iShares MSCI China A UCITS',          sector:'Emerging',       type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CNYA.AS',  fallbackYahooSymbol:'MCHI',  ibkrExchange:'AEB',  ibkrSymbol:'CNYA',  ibkrSecType:'STK' },  // FIX: CNYA→MCHI
  // Sectoriales STOXX 600
  { ticker:'EXV1.DE',  name:'iShares STOXX Eur 600 Oil&Gas',       sector:'Energy',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV1.DE',  fallbackYahooSymbol:'XLE',   ibkrExchange:'IBIS', ibkrSymbol:'EXV1',  ibkrSecType:'STK' },
  { ticker:'EXV3.DE',  name:'iShares STOXX Eur 600 Tech',          sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV3.DE',  fallbackYahooSymbol:'XLK',   ibkrExchange:'IBIS', ibkrSymbol:'EXV3',  ibkrSecType:'STK' },
  { ticker:'EXV4.DE',  name:'iShares STOXX Eur 600 Financials',    sector:'Finance',        type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV4.DE',  fallbackYahooSymbol:'XLF',   ibkrExchange:'IBIS', ibkrSymbol:'EXV4',  ibkrSecType:'STK' },
  { ticker:'EXV6.DE',  name:'iShares STOXX Eur 600 Health Care',   sector:'Healthcare',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV6.DE',  fallbackYahooSymbol:'XLV',   ibkrExchange:'IBIS', ibkrSymbol:'EXV6',  ibkrSecType:'STK' },
  { ticker:'EXV5.DE',  name:'iShares STOXX Eur 600 Utilities',     sector:'Utilities',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV5.DE',  fallbackYahooSymbol:'XLU',   ibkrExchange:'IBIS', ibkrSymbol:'EXV5',  ibkrSecType:'STK' },
  { ticker:'EXV2.DE',  name:'iShares STOXX Eur 600 Chemicals',     sector:'Materials',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV2.DE',  fallbackYahooSymbol:'XLB',   ibkrExchange:'IBIS', ibkrSymbol:'EXV2',  ibkrSecType:'STK' },
  { ticker:'EXV9.DE',  name:'iShares STOXX Eur 600 Food&Bev',      sector:'Consumer',       type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV9.DE',  fallbackYahooSymbol:'XLP',   ibkrExchange:'IBIS', ibkrSymbol:'EXV9',  ibkrSecType:'STK' },
  { ticker:'EXV8.DE',  name:'iShares STOXX Eur 600 Telecom',       sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV8.DE',  fallbackYahooSymbol:'IXP',   ibkrExchange:'IBIS', ibkrSymbol:'EXV8',  ibkrSecType:'STK' },
  // Commodities ETCs
  { ticker:'SSLN.DE',  name:'iShares Physical Silver ETC',         sector:'Commodities',    type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'SSLN.DE',  fallbackYahooSymbol:'SLV',   ibkrExchange:'IBIS', ibkrSymbol:'SSLN',  ibkrSecType:'STK' },
  { ticker:'4GLD.DE',  name:'Xetra-Gold ETC',                      sector:'Commodities',    type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'4GLD.DE',  fallbackYahooSymbol:'GLD',   ibkrExchange:'IBIS', ibkrSymbol:'4GLD',  ibkrSecType:'STK' },
  { ticker:'OILG.DE',  name:'WisdomTree Crude Oil ETC',            sector:'Energy',         type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'OILG.DE',  fallbackYahooSymbol:'USO',   ibkrExchange:'IBIS', ibkrSymbol:'OILG',  ibkrSecType:'STK' },
  { ticker:'COPP.DE',  name:'WisdomTree Copper ETC',               sector:'Materials',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'COPP.DE',  fallbackYahooSymbol:'CPER',  ibkrExchange:'IBIS', ibkrSymbol:'COPP',  ibkrSecType:'STK' },
  { ticker:'LNGG.DE',  name:'WisdomTree Natural Gas ETC',          sector:'Energy',         type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'LNGG.DE',  fallbackYahooSymbol:'UNG',   ibkrExchange:'IBIS', ibkrSymbol:'LNGG',  ibkrSecType:'STK' },
  { ticker:'ALUM.DE',  name:'WisdomTree Aluminium ETC',            sector:'Materials',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ALUM.DE',  fallbackYahooSymbol:'DBB',   ibkrExchange:'IBIS', ibkrSymbol:'ALUM',  ibkrSecType:'STK' },  // FIX: JJU→DBB
  { ticker:'ZINC.DE',  name:'Xtrackers Zinc ETC',                  sector:'Materials',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ZINC.DE',  fallbackYahooSymbol:'DBB',   ibkrExchange:'IBIS', ibkrSymbol:'ZINC',  ibkrSecType:'STK' },  // FIX: ZINC→DBB
  // Renta fija
  { ticker:'DTLA.DE',  name:'iShares $ Treasury 20yr UCITS',       sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DTLA.DE',  fallbackYahooSymbol:'TLT',   ibkrExchange:'IBIS', ibkrSymbol:'DTLA',  ibkrSecType:'STK' },
  { ticker:'IBTU.DE',  name:'iShares $ Corp Bond UCITS',           sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IBTU.DE',  fallbackYahooSymbol:'HYG',   ibkrExchange:'IBIS', ibkrSymbol:'IBTU',  ibkrSecType:'STK' },
  { ticker:'EMUE.DE',  name:'iShares EUR Govt Bond UCITS',         sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EMUE.DE',  fallbackYahooSymbol:'BNDX',  ibkrExchange:'IBIS', ibkrSymbol:'EMUE',  ibkrSecType:'STK' },
  { ticker:'IEGA.DE',  name:'iShares EUR Corporate Bond UCITS',    sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IEGA.DE',  fallbackYahooSymbol:'LQD',   ibkrExchange:'IBIS', ibkrSymbol:'IEGA',  ibkrSecType:'STK' },  // FIX: IBCX→LQD
  { ticker:'GLTL.AS',  name:'iShares Global Govt Bond UCITS',      sector:'Fixed Income',   type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'GLTL.AS',  fallbackYahooSymbol:'BNDX',  ibkrExchange:'AEB',  ibkrSymbol:'GLTL',  ibkrSecType:'STK' },  // FIX: IGVT→BNDX
  // Temáticos
  { ticker:'GDX.DE',   name:'VanEck Gold Miners UCITS',            sector:'Commodities',    type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'GDX.DE',   fallbackYahooSymbol:'GDX',   ibkrExchange:'IBIS', ibkrSymbol:'GDX',   ibkrSecType:'STK' },
  { ticker:'IQQH.DE',  name:'iShares Global Clean Energy UCITS',   sector:'Energy',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IQQH.DE',  fallbackYahooSymbol:'ICLN',  ibkrExchange:'IBIS', ibkrSymbol:'IQQH',  ibkrSecType:'STK' },
  { ticker:'ECAR.DE',  name:'iShares Electric Vehicles UCITS',     sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ECAR.DE',  fallbackYahooSymbol:'DRIV',  ibkrExchange:'IBIS', ibkrSymbol:'ECAR',  ibkrSecType:'STK' },
  { ticker:'ARKY.DE',  name:'ARK Innovation UCITS',                sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ARKY.DE',  fallbackYahooSymbol:'ARKK',  ibkrExchange:'IBIS', ibkrSymbol:'ARKY',  ibkrSecType:'STK' },
  { ticker:'LITG.DE',  name:'Global X Lithium Battery UCITS',      sector:'Materials',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'LITG.DE',  fallbackYahooSymbol:'LIT',   ibkrExchange:'IBIS', ibkrSymbol:'LITG',  ibkrSecType:'STK' },
  { ticker:'COPX.DE',  name:'Global X Copper Miners UCITS',        sector:'Materials',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'COPX.DE',  fallbackYahooSymbol:'COPX',  ibkrExchange:'IBIS', ibkrSymbol:'COPX',  ibkrSecType:'STK' },
  { ticker:'IQHI.DE',  name:'iShares Global Healthcare UCITS',     sector:'Healthcare',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IQHI.DE',  fallbackYahooSymbol:'IXJ',   ibkrExchange:'IBIS', ibkrSymbol:'IQHI',  ibkrSecType:'STK' },
  { ticker:'CLOU.DE',  name:'Global X Cloud Computing UCITS',      sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'CLOU.DE',  fallbackYahooSymbol:'CLOU',  ibkrExchange:'IBIS', ibkrSymbol:'CLOU',  ibkrSecType:'STK' },
  { ticker:'RBOT.DE',  name:'iShares Robotics & AI UCITS',         sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'RBOT.DE',  fallbackYahooSymbol:'BOTZ',  ibkrExchange:'IBIS', ibkrSymbol:'RBOT',  ibkrSecType:'STK' },
  { ticker:'ISPY.DE',  name:'iShares Cybersecurity UCITS',         sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ISPY.DE',  fallbackYahooSymbol:'CIBR',  ibkrExchange:'IBIS', ibkrSymbol:'ISPY',  ibkrSecType:'STK' },
  { ticker:'AI.DE',    name:'iShares S&P 500 AI & Robotics UCITS', sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'AI.DE',    fallbackYahooSymbol:'BOTZ',  ibkrExchange:'IBIS', ibkrSymbol:'AI',    ibkrSecType:'STK' },  // FIX: AIEQ→BOTZ
  { ticker:'FINX.DE',  name:'Global X FinTech UCITS',              sector:'Finance',        type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'FINX.DE',  fallbackYahooSymbol:'FINX',  ibkrExchange:'IBIS', ibkrSymbol:'FINX',  ibkrSecType:'STK' },
  { ticker:'ESGB.DE',  name:'VanEck Video Gaming UCITS',           sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ESGB.DE',  fallbackYahooSymbol:'ESPO',  ibkrExchange:'IBIS', ibkrSymbol:'ESGB',  ibkrSecType:'STK' },
  { ticker:'INRG.DE',  name:'iShares Global Clean Energy (DE)',    sector:'Energy',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'INRG.DE',  fallbackYahooSymbol:'ICLN',  ibkrExchange:'IBIS', ibkrSymbol:'INRG',  ibkrSecType:'STK' },
  { ticker:'WFH.DE',   name:'Global X Telemedicine UCITS',         sector:'Healthcare',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'WFH.DE',   fallbackYahooSymbol:'IHI',   ibkrExchange:'IBIS', ibkrSymbol:'WFH',   ibkrSecType:'STK' },  // FIX: EDOC→IHI
];

// ── IBEX 35 — 25 acciones (con ADR/US fallback donde existe) ─
export const IBEX35_STOCKS: UniverseAsset[] = [
  // Con ADR en NYSE/NASDAQ
  { ticker:'SAN.MC',   name:'Banco Santander',        sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'SAN.MC',   fallbackYahooSymbol:'SAN',   ibkrExchange:'BM',  ibkrSymbol:'SAN',   ibkrSecType:'STK' },  // NYSE ADR
  { ticker:'BBVA.MC',  name:'BBVA',                   sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'BBVA.MC',  fallbackYahooSymbol:'BBVA',  ibkrExchange:'BM',  ibkrSymbol:'BBVA',  ibkrSecType:'STK' },  // NYSE ADR
  { ticker:'TEF.MC',   name:'Telefónica',             sector:'Technology',    type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'TEF.MC',   fallbackYahooSymbol:'TEF',   ibkrExchange:'BM',  ibkrSymbol:'TEF',   ibkrSecType:'STK' },  // NYSE ADR
  { ticker:'MTS.MC',   name:'ArcelorMittal',          sector:'Materials',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'MTS.MC',   fallbackYahooSymbol:'MT',    ibkrExchange:'BM',  ibkrSymbol:'MTS',   ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'GRF.MC',   name:'Grifols',                sector:'Healthcare',    type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'GRF.MC',   fallbackYahooSymbol:'GRFS',  ibkrExchange:'BM',  ibkrSymbol:'GRF',   ibkrSecType:'STK' },  // NASDAQ dual-listed
  { ticker:'FER.MC',   name:'Ferrovial',              sector:'Infrastructure', type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'FER.MC',   fallbackYahooSymbol:'FER',   ibkrExchange:'BM',  ibkrSymbol:'FER',   ibkrSecType:'STK' },  // NASDAQ (2023)
  { ticker:'IBE.MC',   name:'Iberdrola',              sector:'Utilities',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'IBE.MC',   fallbackYahooSymbol:'IBDRY', ibkrExchange:'BM',  ibkrSymbol:'IBE',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'REP.MC',   name:'Repsol',                 sector:'Energy',        type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'REP.MC',   fallbackYahooSymbol:'REPYY', ibkrExchange:'BM',  ibkrSymbol:'REP',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'AMS.MC',   name:'Amadeus IT',             sector:'Technology',    type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'AMS.MC',   fallbackYahooSymbol:'AMADY', ibkrExchange:'BM',  ibkrSymbol:'AMS',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'IAG.MC',   name:'IAG (Iberia)',            sector:'Consumer',      type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'IAG.MC',   fallbackYahooSymbol:'DAL',   ibkrExchange:'BM',  ibkrSymbol:'IAG',   ibkrSecType:'STK' },  // DAL (Delta Air Lines) — líquido, no en universo
  { ticker:'NTGY.MC',  name:'Naturgy',                sector:'Utilities',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'NTGY.MC',  fallbackYahooSymbol:'NEE',   ibkrExchange:'BM',  ibkrSymbol:'NTGY',  ibkrSecType:'STK' },  // NEE (NextEra Energy) — líquido, no en universo
  { ticker:'ITX.MC',   name:'Inditex',                sector:'Consumer',      type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'ITX.MC',   fallbackYahooSymbol:'TGT',   ibkrExchange:'BM',  ibkrSymbol:'ITX',   ibkrSecType:'STK' },  // TGT (Target) — retail proxy, no en universo
  // Sin ADR líquido — fallback a acciones US líquidas fuera del universo
  { ticker:'CABK.MC',  name:'CaixaBank',              sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'CABK.MC',  fallbackYahooSymbol:'C',     ibkrExchange:'BM',  ibkrSymbol:'CABK',  ibkrSecType:'STK' },  // Citigroup — finance proxy, no en universo
  { ticker:'AENA.MC',  name:'AENA',                   sector:'Infrastructure', type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'AENA.MC',  fallbackYahooSymbol:'UAL',   ibkrExchange:'BM',  ibkrSymbol:'AENA',  ibkrSecType:'STK' },  // United Airlines — infra/transport proxy, no en universo
  { ticker:'ENG.MC',   name:'Enagás',                 sector:'Utilities',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'ENG.MC',   fallbackYahooSymbol:'NEE',   ibkrExchange:'BM',  ibkrSymbol:'ENG',   ibkrSecType:'STK' },  // NEE — utilities proxy, no en universo
  { ticker:'RED.MC',   name:'Red Eléctrica',          sector:'Utilities',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'RED.MC',   fallbackYahooSymbol:'NEE',   ibkrExchange:'BM',  ibkrSymbol:'RED',   ibkrSecType:'STK' },  // NEE — utilities proxy, no en universo
  { ticker:'MAP.MC',   name:'MAPFRE',                 sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'MAP.MC',   fallbackYahooSymbol:'C',     ibkrExchange:'BM',  ibkrSymbol:'MAP',   ibkrSecType:'STK' },  // Citigroup — finance proxy, no en universo
  { ticker:'ACS.MC',   name:'ACS',                    sector:'Infrastructure', type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'ACS.MC',   fallbackYahooSymbol:'CAT',   ibkrExchange:'BM',  ibkrSymbol:'ACS',   ibkrSecType:'STK' },  // Caterpillar — industrials proxy, no en universo
  { ticker:'CLNX.MC',  name:'Cellnex Telecom',        sector:'Technology',    type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'CLNX.MC',  fallbackYahooSymbol:'AMT',   ibkrExchange:'BM',  ibkrSymbol:'CLNX',  ibkrSecType:'STK' },  // American Tower — cell tower proxy, no en universo
  { ticker:'COL.MC',   name:'Inmobiliaria Colonial',  sector:'Real Estate',   type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'COL.MC',   fallbackYahooSymbol:'XLRE',  ibkrExchange:'BM',  ibkrSymbol:'COL',   ibkrSecType:'STK' },  // proxy: Real Estate ETF
  { ticker:'MRL.MC',   name:'Merlin Properties',      sector:'Real Estate',   type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'MRL.MC',   fallbackYahooSymbol:'XLRE',  ibkrExchange:'BM',  ibkrSymbol:'MRL',   ibkrSecType:'STK' },  // proxy: Real Estate ETF
  { ticker:'SAB.MC',   name:'Banco Sabadell',         sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'SAB.MC',   fallbackYahooSymbol:'XLF',   ibkrExchange:'BM',  ibkrSymbol:'SAB',   ibkrSecType:'STK' },  // proxy: Financial ETF
  { ticker:'BKT.MC',   name:'Bankinter',              sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'BKT.MC',   fallbackYahooSymbol:'XLF',   ibkrExchange:'BM',  ibkrSymbol:'BKT',   ibkrSecType:'STK' },  // proxy: Financial ETF
  { ticker:'ACX.MC',   name:'Acerinox',               sector:'Materials',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'ACX.MC',   fallbackYahooSymbol:'XLB',   ibkrExchange:'BM',  ibkrSymbol:'ACX',   ibkrSecType:'STK' },  // proxy: Materials ETF
  { ticker:'VIS.MC',   name:'Viscofan',               sector:'Consumer',      type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'VIS.MC',   fallbackYahooSymbol:'XLP',   ibkrExchange:'BM',  ibkrSymbol:'VIS',   ibkrSecType:'STK' },  // proxy: Consumer Staples ETF
];

// ── DAX 40 — 19 acciones (BAS.DE eliminado: duplicado de BASF.DE)
export const DAX40_STOCKS: UniverseAsset[] = [
  { ticker:'SAP.DE',   name:'SAP SE',                 sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'SAP.DE',   fallbackYahooSymbol:'SAP',    ibkrExchange:'IBIS', ibkrSymbol:'SAP',   ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'DBK.DE',   name:'Deutsche Bank',          sector:'Finance',     type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'DBK.DE',   fallbackYahooSymbol:'DB',     ibkrExchange:'IBIS', ibkrSymbol:'DBK',   ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'QGEN.DE',  name:'Qiagen NV',              sector:'Healthcare',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'QGEN.DE',  fallbackYahooSymbol:'QGEN',   ibkrExchange:'IBIS', ibkrSymbol:'QGEN',  ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'SIE.DE',   name:'Siemens AG',             sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'SIE.DE',   fallbackYahooSymbol:'SIEGY',  ibkrExchange:'IBIS', ibkrSymbol:'SIE',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'ALV.DE',   name:'Allianz SE',             sector:'Finance',     type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'ALV.DE',   fallbackYahooSymbol:'ALIZY',  ibkrExchange:'IBIS', ibkrSymbol:'ALV',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'BAYN.DE',  name:'Bayer AG',               sector:'Healthcare',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BAYN.DE',  fallbackYahooSymbol:'BAYRY',  ibkrExchange:'IBIS', ibkrSymbol:'BAYN',  ibkrSecType:'STK' },  // OTC ADR
  { ticker:'MUV2.DE',  name:'Munich Re',              sector:'Finance',     type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'MUV2.DE',  fallbackYahooSymbol:'MURGY',  ibkrExchange:'IBIS', ibkrSymbol:'MUV2',  ibkrSecType:'STK' },  // OTC ADR
  { ticker:'BMW.DE',   name:'BMW AG',                 sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BMW.DE',   fallbackYahooSymbol:'BMWYY',  ibkrExchange:'IBIS', ibkrSymbol:'BMW',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'ADS.DE',   name:'Adidas AG',              sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'ADS.DE',   fallbackYahooSymbol:'ADDYY',  ibkrExchange:'IBIS', ibkrSymbol:'ADS',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'EOAN.DE',  name:'E.ON SE',                sector:'Utilities',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'EOAN.DE',  fallbackYahooSymbol:'EONGY',  ibkrExchange:'IBIS', ibkrSymbol:'EOAN',  ibkrSecType:'STK' },  // OTC ADR
  { ticker:'RWE.DE',   name:'RWE AG',                 sector:'Utilities',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'RWE.DE',   fallbackYahooSymbol:'RWEOY',  ibkrExchange:'IBIS', ibkrSymbol:'RWE',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'BASF.DE',  name:'BASF SE',                sector:'Materials',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BASF.DE',  fallbackYahooSymbol:'BASFY',  ibkrExchange:'IBIS', ibkrSymbol:'BASF',  ibkrSecType:'STK' },  // OTC ADR
  { ticker:'VOW3.DE',  name:'Volkswagen AG',          sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'VOW3.DE',  fallbackYahooSymbol:'VWAGY',  ibkrExchange:'IBIS', ibkrSymbol:'VOW3',  ibkrSecType:'STK' },  // OTC ADR
  { ticker:'MBG.DE',   name:'Mercedes-Benz',          sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'MBG.DE',   fallbackYahooSymbol:'MBGYY',  ibkrExchange:'IBIS', ibkrSymbol:'MBG',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'DTE.DE',   name:'Deutsche Telekom',       sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'DTE.DE',   fallbackYahooSymbol:'DTEGY',  ibkrExchange:'IBIS', ibkrSymbol:'DTE',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'HEN3.DE',  name:'Henkel AG',              sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'HEN3.DE',  fallbackYahooSymbol:'HENKY',  ibkrExchange:'IBIS', ibkrSymbol:'HEN3',  ibkrSecType:'STK' },  // OTC ADR
  { ticker:'MERCK.DE', name:'Merck KGaA',             sector:'Healthcare',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'MERCK.DE', fallbackYahooSymbol:'MKKGY',  ibkrExchange:'IBIS', ibkrSymbol:'MERCK', ibkrSecType:'STK' },  // OTC ADR
  { ticker:'IFX.DE',   name:'Infineon Technologies',  sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'IFX.DE',   fallbackYahooSymbol:'IFNNY',  ibkrExchange:'IBIS', ibkrSymbol:'IFX',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'DHER.DE',  name:'Delivery Hero',          sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'DHER.DE',  fallbackYahooSymbol:'XLY',   ibkrExchange:'IBIS', ibkrSymbol:'DHER',  ibkrSecType:'STK' },  // proxy: Consumer Discr ETF
];

// ── CAC 40 — 15 acciones ──────────────────────────────────────
export const CAC40_STOCKS: UniverseAsset[] = [
  { ticker:'TTE.PA',   name:'TotalEnergies',          sector:'Energy',      type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'TTE.PA',   fallbackYahooSymbol:'TTE',    ibkrExchange:'SBF',  ibkrSymbol:'TTE',   ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'SAN.PA',   name:'Sanofi',                 sector:'Healthcare',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'SAN.PA',   fallbackYahooSymbol:'SNY',    ibkrExchange:'SBF',  ibkrSymbol:'SAN',   ibkrSecType:'STK' },  // NASDAQ dual-listed
  { ticker:'MC.PA',    name:'LVMH',                   sector:'Consumer',    type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'MC.PA',    fallbackYahooSymbol:'LVMUY',  ibkrExchange:'SBF',  ibkrSymbol:'MC',    ibkrSecType:'STK' },  // OTC ADR
  { ticker:'OR.PA',    name:"L'Oréal",                sector:'Consumer',    type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'OR.PA',    fallbackYahooSymbol:'LRLCY',  ibkrExchange:'SBF',  ibkrSymbol:'OR',    ibkrSecType:'STK' },  // OTC ADR
  { ticker:'AIR.PA',   name:'Airbus SE',              sector:'Defense',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AIR.PA',   fallbackYahooSymbol:'EADSY',  ibkrExchange:'SBF',  ibkrSymbol:'AIR',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'BNP.PA',   name:'BNP Paribas',            sector:'Finance',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'BNP.PA',   fallbackYahooSymbol:'BNPQY',  ibkrExchange:'SBF',  ibkrSymbol:'BNP',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'AXA.PA',   name:'AXA SA',                 sector:'Finance',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AXA.PA',   fallbackYahooSymbol:'AXAHY',  ibkrExchange:'SBF',  ibkrSymbol:'AXA',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'KER.PA',   name:'Kering SA',              sector:'Consumer',    type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'KER.PA',   fallbackYahooSymbol:'PPRUY',  ibkrExchange:'SBF',  ibkrSymbol:'KER',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'SU.PA',    name:'Schneider Electric',     sector:'Technology',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'SU.PA',    fallbackYahooSymbol:'SBGSY',  ibkrExchange:'SBF',  ibkrSymbol:'SU',    ibkrSecType:'STK' },  // OTC ADR
  { ticker:'AI.PA',    name:'Air Liquide',            sector:'Materials',   type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AI.PA',    fallbackYahooSymbol:'AIQUY',  ibkrExchange:'SBF',  ibkrSymbol:'AI',    ibkrSecType:'STK' },  // OTC ADR
  { ticker:'DSY.PA',   name:'Dassault Systèmes',      sector:'Technology',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'DSY.PA',   fallbackYahooSymbol:'DASTY',  ibkrExchange:'SBF',  ibkrSymbol:'DSY',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'VIE.PA',   name:'Veolia Environnement',   sector:'Utilities',   type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'VIE.PA',   fallbackYahooSymbol:'VEOEY',  ibkrExchange:'SBF',  ibkrSymbol:'VIE',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'CAP.PA',   name:'Capgemini SE',           sector:'Technology',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'CAP.PA',   fallbackYahooSymbol:'CGEMY',  ibkrExchange:'SBF',  ibkrSymbol:'CAP',   ibkrSecType:'STK' },  // OTC ADR
  { ticker:'HO.PA',    name:'Thales SA',              sector:'Defense',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'HO.PA',    fallbackYahooSymbol:'ITA',   ibkrExchange:'SBF',  ibkrSymbol:'HO',    ibkrSecType:'STK' },  // proxy: iShares Aerospace & Defense ETF (THLEF demasiado thin)
  { ticker:'EN.PA',    name:'Bouygues SA',            sector:'Infrastructure',type:'STOCK',exchange:'EURONEXT',currency:'EUR', yahooSymbol:'EN.PA',    fallbackYahooSymbol:'XLI',   ibkrExchange:'SBF',  ibkrSymbol:'EN',    ibkrSecType:'STK' },  // proxy: Industrials ETF (BOUYE demasiado thin)
];

// ── FTSE 100 — 15 acciones (todas con US listing/ADR) ────────
export const FTSE100_STOCKS: UniverseAsset[] = [
  { ticker:'SHEL.L',   name:'Shell PLC',              sector:'Energy',      type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'SHEL.L',   fallbackYahooSymbol:'SHEL',  ibkrExchange:'LSE',  ibkrSymbol:'SHEL',  ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'AZN.L',    name:'AstraZeneca',            sector:'Healthcare',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'AZN.L',    fallbackYahooSymbol:'AZN',   ibkrExchange:'LSE',  ibkrSymbol:'AZN',   ibkrSecType:'STK' },  // NASDAQ dual-listed
  { ticker:'HSBA.L',   name:'HSBC Holdings',          sector:'Finance',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'HSBA.L',   fallbackYahooSymbol:'HSBC',  ibkrExchange:'LSE',  ibkrSymbol:'HSBA',  ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'ULVR.L',   name:'Unilever PLC',           sector:'Consumer',    type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'ULVR.L',   fallbackYahooSymbol:'UL',    ibkrExchange:'LSE',  ibkrSymbol:'ULVR',  ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'BP.L',     name:'BP PLC',                 sector:'Energy',      type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'BP.L',     fallbackYahooSymbol:'BP',    ibkrExchange:'LSE',  ibkrSymbol:'BP',    ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'GSK.L',    name:'GSK PLC',                sector:'Healthcare',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'GSK.L',    fallbackYahooSymbol:'GSK',   ibkrExchange:'LSE',  ibkrSymbol:'GSK',   ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'RIO.L',    name:'Rio Tinto PLC',          sector:'Materials',   type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'RIO.L',    fallbackYahooSymbol:'RIO',   ibkrExchange:'LSE',  ibkrSymbol:'RIO',   ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'VOD.L',    name:'Vodafone Group',         sector:'Technology',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'VOD.L',    fallbackYahooSymbol:'VOD',   ibkrExchange:'LSE',  ibkrSymbol:'VOD',   ibkrSecType:'STK' },  // NASDAQ dual-listed
  { ticker:'LLOY.L',   name:'Lloyds Banking Group',  sector:'Finance',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'LLOY.L',   fallbackYahooSymbol:'LYG',   ibkrExchange:'LSE',  ibkrSymbol:'LLOY',  ibkrSecType:'STK' },  // NYSE ADR
  { ticker:'BARC.L',   name:'Barclays PLC',           sector:'Finance',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'BARC.L',   fallbackYahooSymbol:'BCS',   ibkrExchange:'LSE',  ibkrSymbol:'BARC',  ibkrSecType:'STK' },  // NYSE ADR
  { ticker:'DGE.L',    name:'Diageo PLC',             sector:'Consumer',    type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'DGE.L',    fallbackYahooSymbol:'DEO',   ibkrExchange:'LSE',  ibkrSymbol:'DGE',   ibkrSecType:'STK' },  // NYSE dual-listed
  { ticker:'RR.L',     name:'Rolls-Royce Holdings',  sector:'Defense',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'RR.L',     fallbackYahooSymbol:'RYCEY', ibkrExchange:'LSE',  ibkrSymbol:'RR',    ibkrSecType:'STK' },  // OTC ADR
  { ticker:'BT-A.L',   name:'BT Group',               sector:'Technology',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'BT-A.L',   fallbackYahooSymbol:'BT',    ibkrExchange:'LSE',  ibkrSymbol:'BT.A',  ibkrSecType:'STK' },  // NYSE ADR
  { ticker:'GLEN.L',   name:'Glencore PLC',           sector:'Materials',   type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'GLEN.L',   fallbackYahooSymbol:'GLNCY', ibkrExchange:'LSE',  ibkrSymbol:'GLEN',  ibkrSecType:'STK' },  // OTC ADR
  { ticker:'NXT.L',    name:'Next PLC',               sector:'Consumer',    type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'NXT.L',    fallbackYahooSymbol:'XLY',   ibkrExchange:'LSE',  ibkrSymbol:'NXT',   ibkrSecType:'STK' },  // proxy: Consumer Discr ETF
];

// ── ETFs Sectoriales US (iShares SPDR) — sin fallback necesario
export const US_SECTOR_ETFS: UniverseAsset[] = [
  { ticker:'XLK',    name:'Technology Select Sector SPDR',    sector:'Technology',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLK',   ibkrExchange:'NYSE',   ibkrSymbol:'XLK',  ibkrSecType:'STK' },
  { ticker:'XLE',    name:'Energy Select Sector SPDR',        sector:'Energy',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLE',   fallbackYahooSymbol:'VDE',  ibkrExchange:'NYSE',   ibkrSymbol:'XLE',  ibkrSecType:'STK' },  // FIX v5: VDE (Vanguard Energy, fuera del universo)
  { ticker:'XLF',    name:'Financial Select Sector SPDR',     sector:'Finance',     type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLF',   ibkrExchange:'NYSE',   ibkrSymbol:'XLF',  ibkrSecType:'STK' },
  { ticker:'XLV',    name:'Health Care Select Sector SPDR',   sector:'Healthcare',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLV',   ibkrExchange:'NYSE',   ibkrSymbol:'XLV',  ibkrSecType:'STK' },
  { ticker:'XLI',    name:'Industrial Select Sector SPDR',    sector:'Industry',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLI',   ibkrExchange:'NYSE',   ibkrSymbol:'XLI',  ibkrSecType:'STK' },
  { ticker:'XLP',    name:'Consumer Staples Select Sector',   sector:'Consumer',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLP',   ibkrExchange:'NYSE',   ibkrSymbol:'XLP',  ibkrSecType:'STK' },
  { ticker:'XLY',    name:'Consumer Discr Select Sector SPDR',sector:'Consumer',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLY',   ibkrExchange:'NYSE',   ibkrSymbol:'XLY',  ibkrSecType:'STK' },
  { ticker:'XLU',    name:'Utilities Select Sector SPDR',     sector:'Utilities',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLU',   ibkrExchange:'NYSE',   ibkrSymbol:'XLU',  ibkrSecType:'STK' },
  { ticker:'XLB',    name:'Materials Select Sector SPDR',     sector:'Materials',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLB',   ibkrExchange:'NYSE',   ibkrSymbol:'XLB',  ibkrSecType:'STK' },
  { ticker:'XLRE',   name:'Real Estate Select Sector SPDR',   sector:'Real Estate', type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLRE',  ibkrExchange:'NYSE',   ibkrSymbol:'XLRE', ibkrSecType:'STK' },
  { ticker:'SOXX',   name:'iShares Semiconductor ETF',        sector:'Technology',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'SOXX',  ibkrExchange:'NASDAQ', ibkrSymbol:'SOXX', ibkrSecType:'STK' },
  { ticker:'IBB',    name:'iShares Biotechnology ETF',        sector:'Healthcare',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'IBB',   ibkrExchange:'NASDAQ', ibkrSymbol:'IBB',  ibkrSecType:'STK' },
  { ticker:'KRE',    name:'SPDR S&P Regional Bank ETF',       sector:'Finance',     type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'KRE',   ibkrExchange:'NYSE',   ibkrSymbol:'KRE',  ibkrSecType:'STK' },
  { ticker:'GDXJ',   name:'VanEck Junior Gold Miners ETF',    sector:'Materials',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'GDXJ',  ibkrExchange:'NYSE',   ibkrSymbol:'GDXJ', ibkrSecType:'STK' },
  { ticker:'USO',    name:'United States Oil Fund',           sector:'Energy',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'USO',   ibkrExchange:'NYSE',   ibkrSymbol:'USO',  ibkrSecType:'STK' },
];

// ── Emerging Markets ex-China (RSX ELIMINADO — suspendido 2022)
export const EM_EX_CHINA: UniverseAsset[] = [
  { ticker:'INDA',   name:'iShares MSCI India ETF',           sector:'Emerging',    type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'INDA',  ibkrExchange:'NASDAQ', ibkrSymbol:'INDA', ibkrSecType:'STK' },
  { ticker:'EPI',    name:'WisdomTree India Earnings Fund',   sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EPI',   ibkrExchange:'NYSE',   ibkrSymbol:'EPI',  ibkrSecType:'STK' },
  { ticker:'EWT',    name:'iShares MSCI Taiwan ETF',          sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWT',   ibkrExchange:'NYSE',   ibkrSymbol:'EWT',  ibkrSecType:'STK' },
  { ticker:'EWY',    name:'iShares MSCI South Korea ETF',     sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWY',   ibkrExchange:'NYSE',   ibkrSymbol:'EWY',  ibkrSecType:'STK' },
  { ticker:'EWZ',    name:'iShares MSCI Brazil ETF',          sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWZ',   ibkrExchange:'NYSE',   ibkrSymbol:'EWZ',  ibkrSecType:'STK' },
  { ticker:'EWW',    name:'iShares MSCI Mexico ETF',          sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWW',   ibkrExchange:'NYSE',   ibkrSymbol:'EWW',  ibkrSecType:'STK' },
  { ticker:'VNM',    name:'VanEck Vietnam ETF',               sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'VNM',   ibkrExchange:'NYSE',   ibkrSymbol:'VNM',  ibkrSecType:'STK' },
  { ticker:'THD',    name:'iShares MSCI Thailand ETF',        sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'THD',   ibkrExchange:'NYSE',   ibkrSymbol:'THD',  ibkrSecType:'STK' },
  { ticker:'EPHE',   name:'iShares MSCI Philippines ETF',     sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EPHE',  ibkrExchange:'NYSE',   ibkrSymbol:'EPHE', ibkrSecType:'STK' },
];

// ── Small Caps & Factor ETFs ─────────────────────────────────
export const FACTOR_ETFS: UniverseAsset[] = [
  { ticker:'IWM',    name:'iShares Russell 2000 ETF',         sector:'Small Cap',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'IWM',   ibkrExchange:'NYSE',   ibkrSymbol:'IWM',  ibkrSecType:'STK' },
  { ticker:'SLYV',   name:'SPDR S&P 600 Small Cap Value ETF', sector:'Small Cap',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'SLYV',  ibkrExchange:'NYSE',   ibkrSymbol:'SLYV', ibkrSecType:'STK' },
  { ticker:'AVUV',   name:'Avantis U.S. Small Cap Value ETF', sector:'Small Cap',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'AVUV',  ibkrExchange:'NYSE',   ibkrSymbol:'AVUV', ibkrSecType:'STK' },
  { ticker:'MTUM',   name:'iShares MSCI USA Momentum ETF',    sector:'Factor',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'MTUM',  ibkrExchange:'NYSE',   ibkrSymbol:'MTUM', ibkrSecType:'STK' },
  { ticker:'VLUE',   name:'iShares MSCI USA Value ETF',       sector:'Factor',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'VLUE',  ibkrExchange:'NYSE',   ibkrSymbol:'VLUE', ibkrSecType:'STK' },
  { ticker:'QUAL',   name:'iShares MSCI USA Quality ETF',     sector:'Factor',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'QUAL',  ibkrExchange:'NYSE',   ibkrSymbol:'QUAL', ibkrSecType:'STK' },
  { ticker:'USMV',   name:'iShares MSCI USA Min Vol ETF',     sector:'Factor',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'USMV',  ibkrExchange:'NYSE',   ibkrSymbol:'USMV', ibkrSecType:'STK' },
  { ticker:'TIP',    name:'iShares TIPS Bond ETF',            sector:'Fixed Income',type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'TIP',   ibkrExchange:'NYSE',   ibkrSymbol:'TIP',  ibkrSecType:'STK' },
];

// ── Crypto ETPs ──────────────────────────────────────────────
export const CRYPTO_ETPS: UniverseAsset[] = [
  { ticker:'ETHE',   name:'Grayscale Ethereum Trust',         sector:'Crypto',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'ETHE',  ibkrExchange:'NYSE',   ibkrSymbol:'ETHE', ibkrSecType:'STK' },
  { ticker:'BITO',   name:'ProShares Bitcoin Strategy ETF',   sector:'Crypto',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'BITO',  ibkrExchange:'NYSE',   ibkrSymbol:'BITO', ibkrSecType:'STK' },
];

// ── US Mega-caps — sin fallback (siempre disponibles en Yahoo)
export const US_STOCKS: UniverseAsset[] = [
  { ticker:'AAPL',     name:'Apple Inc.',             sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AAPL',  ibkrExchange:'NASDAQ', ibkrSymbol:'AAPL',  ibkrSecType:'STK' },
  { ticker:'MSFT',     name:'Microsoft Corp.',        sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'MSFT',  ibkrExchange:'NASDAQ', ibkrSymbol:'MSFT',  ibkrSecType:'STK' },
  { ticker:'NVDA',     name:'NVIDIA Corp.',           sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'NVDA',  ibkrExchange:'NASDAQ', ibkrSymbol:'NVDA',  ibkrSecType:'STK' },
  { ticker:'AMZN',     name:'Amazon.com Inc.',        sector:'Consumer',    type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AMZN',  ibkrExchange:'NASDAQ', ibkrSymbol:'AMZN',  ibkrSecType:'STK' },
  { ticker:'GOOGL',    name:'Alphabet Inc.',          sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'GOOGL', ibkrExchange:'NASDAQ', ibkrSymbol:'GOOGL', ibkrSecType:'STK' },
  { ticker:'META',     name:'Meta Platforms Inc.',    sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'META',  ibkrExchange:'NASDAQ', ibkrSymbol:'META',  ibkrSecType:'STK' },
  { ticker:'TSLA',     name:'Tesla Inc.',             sector:'Consumer',    type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'TSLA',  ibkrExchange:'NASDAQ', ibkrSymbol:'TSLA',  ibkrSecType:'STK' },
  { ticker:'JPM',      name:'JPMorgan Chase',         sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'JPM',   ibkrExchange:'NYSE',   ibkrSymbol:'JPM',   ibkrSecType:'STK' },
  { ticker:'V',        name:'Visa Inc.',              sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'V',     ibkrExchange:'NYSE',   ibkrSymbol:'V',     ibkrSecType:'STK' },
  { ticker:'XOM',      name:'ExxonMobil Corp.',       sector:'Energy',      type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'XOM',   fallbackYahooSymbol:'CVX',  ibkrExchange:'NYSE',   ibkrSymbol:'XOM',   ibkrSecType:'STK' },  // FIX v5: CVX (Chevron, fuera del universo)
  { ticker:'JNJ',      name:'Johnson & Johnson',      sector:'Healthcare',  type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'JNJ',   ibkrExchange:'NYSE',   ibkrSymbol:'JNJ',   ibkrSecType:'STK' },
  { ticker:'WMT',      name:'Walmart Inc.',           sector:'Consumer',    type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'WMT',   ibkrExchange:'NYSE',   ibkrSymbol:'WMT',   ibkrSecType:'STK' },
  { ticker:'MA',       name:'Mastercard Inc.',        sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'MA',    ibkrExchange:'NYSE',   ibkrSymbol:'MA',    ibkrSecType:'STK' },
  { ticker:'BAC',      name:'Bank of America',        sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'BAC',   ibkrExchange:'NYSE',   ibkrSymbol:'BAC',   ibkrSecType:'STK' },
  { ticker:'PLTR',     name:'Palantir Technologies',  sector:'Technology',  type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'PLTR',  ibkrExchange:'NYSE',   ibkrSymbol:'PLTR',  ibkrSecType:'STK' },
  { ticker:'AMD',      name:'Advanced Micro Devices', sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AMD',   ibkrExchange:'NASDAQ', ibkrSymbol:'AMD',   ibkrSecType:'STK' },
  { ticker:'INTC',     name:'Intel Corporation',      sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'INTC',  ibkrExchange:'NASDAQ', ibkrSymbol:'INTC',  ibkrSecType:'STK' },
  { ticker:'SMCI',     name:'Super Micro Computer',   sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'SMCI',  ibkrExchange:'NASDAQ', ibkrSymbol:'SMCI',  ibkrSecType:'STK' },
  { ticker:'COIN',     name:'Coinbase Global',        sector:'Finance',     type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'COIN',  ibkrExchange:'NASDAQ', ibkrSymbol:'COIN',  ibkrSecType:'STK' },
  { ticker:'MSTR',     name:'MicroStrategy Inc.',     sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'MSTR',  ibkrExchange:'NASDAQ', ibkrSymbol:'MSTR',  ibkrSecType:'STK' },
];

// ════════════════════════════════════════════════════════════
// UNIVERSOS COMPUESTOS
// ════════════════════════════════════════════════════════════

// FULL: ~189 activos (~15-20 min)
export const FULL_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_ETFS,
  ...IBEX35_STOCKS,
  ...DAX40_STOCKS,
  ...CAC40_STOCKS,
  ...FTSE100_STOCKS,
  ...US_STOCKS,
  ...US_SECTOR_ETFS,
  ...EM_EX_CHINA,
  ...FACTOR_ETFS,
  ...CRYPTO_ETPS,
];

// CORE: ~60 activos (~5-7 min)
export const CORE_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_ETFS.filter(a => [
    'CSPX.AS','CNDX.AS','IWDA.AS','EIMI.AS',
    'SSLN.DE','4GLD.DE','DTLA.DE',
    'EXV1.DE','EXV3.DE','EXV4.DE','EXV6.DE',
    'GDX.DE','IQQH.DE','IUSN.DE','ARKY.DE',
  ].includes(a.ticker)),
  ...IBEX35_STOCKS.filter(a => ['SAN.MC','BBVA.MC','IBE.MC','ITX.MC','AMS.MC'].includes(a.ticker)),
  ...DAX40_STOCKS.filter(a => ['SAP.DE','SIE.DE','ALV.DE','BAYN.DE','IFX.DE'].includes(a.ticker)),
  ...CAC40_STOCKS.filter(a => ['MC.PA','AIR.PA','SAN.PA','TTE.PA','SU.PA'].includes(a.ticker)),
  ...FTSE100_STOCKS.filter(a => ['SHEL.L','AZN.L','HSBA.L','ULVR.L','BP.L'].includes(a.ticker)),
  ...US_STOCKS.filter(a => ['NVDA','AAPL','MSFT','TSLA','META','GOOGL','AMZN','AMD','JPM','V'].includes(a.ticker)),
  ...US_SECTOR_ETFS.filter(a => ['XLK','XLE','XLF','XLV','SOXX'].includes(a.ticker)),
];

// VOLATILE: ~35 activos (~2-3 min)
export const VOLATILE_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_ETFS.filter(a => [
    'ARKY.DE','LITG.DE','OILG.DE','LNGG.DE',
    'GDX.DE','IQQH.DE','ECAR.DE','COPP.DE',
    'SSLN.DE','CNDX.AS',
  ].includes(a.ticker)),
  ...US_STOCKS.filter(a => ['NVDA','TSLA','AMD','SMCI','COIN','MSTR','PLTR'].includes(a.ticker)),
  ...IBEX35_STOCKS.filter(a => ['IAG.MC','GRF.MC','MTS.MC'].includes(a.ticker)),
  ...US_SECTOR_ETFS.filter(a => ['SOXX','GDXJ','KRE'].includes(a.ticker)),
  ...EM_EX_CHINA.filter(a => ['EWZ','VNM'].includes(a.ticker)),
  ...CRYPTO_ETPS,
];

// ── Helper: contrato IBKR listo para la API ──────────────────
export function toIbkrContract(asset: UniverseAsset): {
  symbol:   string;
  secType:  string;
  exchange: string;
  currency: string;
} {
  return {
    symbol:   asset.ibkrSymbol,
    secType:  asset.ibkrSecType,
    exchange: asset.ibkrExchange,
    currency: asset.currency,
  };
}