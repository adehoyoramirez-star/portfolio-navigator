// ============================================================
// src/core/tactical/tacticalUniverse.ts
// Universo táctico amplio — UCITS + Acciones europeas/americanas
// ~200 activos | XETRA · Euronext · LSE · NYSE · NASDAQ
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

// ── ETFs / ETCs UCITS (57 activos) ───────────────────────────
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
  { ticker:'DBXD.DE',  name:'Xtrackers DAX UCITS',                 sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DBXD.DE',  fallbackYahooSymbol:'DAX',   ibkrExchange:'IBIS', ibkrSymbol:'DBXD',  ibkrSecType:'STK' },
  { ticker:'IMEA.AS',  name:'iShares Core MSCI Europe UCITS',      sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'IMEA.AS',  fallbackYahooSymbol:'IEUR',  ibkrExchange:'AEB',  ibkrSymbol:'IMEA',  ibkrSecType:'STK' },
  { ticker:'XESX.DE',  name:'Xtrackers Euro Stoxx 50 UCITS',       sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'XESX.DE',  fallbackYahooSymbol:'FEZ',   ibkrExchange:'IBIS', ibkrSymbol:'XESX',  ibkrSecType:'STK' },
  { ticker:'EXSA.DE',  name:'iShares STOXX Europe 600 UCITS',      sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXSA.DE',  fallbackYahooSymbol:'STOXX', ibkrExchange:'IBIS', ibkrSymbol:'EXSA',  ibkrSecType:'STK' },
  { ticker:'MEUD.PA',  name:'Lyxor MSCI Europe UCITS',             sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'MEUD.PA',  fallbackYahooSymbol:'IEUR',  ibkrExchange:'SBF',  ibkrSymbol:'MEUD',  ibkrSecType:'STK' },
  // Norteamérica
  { ticker:'CS51.DE',  name:'iShares MSCI USA UCITS',              sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'CS51.DE',  fallbackYahooSymbol:'IUSA',  ibkrExchange:'IBIS', ibkrSymbol:'CS51',  ibkrSecType:'STK' },
  { ticker:'XD9U.DE',  name:'Xtrackers MSCI USA UCITS',            sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'XD9U.DE',  fallbackYahooSymbol:'IUSA',  ibkrExchange:'IBIS', ibkrSymbol:'XD9U',  ibkrSecType:'STK' },
  // Asia / Emergentes
  { ticker:'IAPD.AS',  name:'iShares MSCI Pacific ex-Japan UCITS', sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'IAPD.AS',  fallbackYahooSymbol:'EPP',   ibkrExchange:'AEB',  ibkrSymbol:'IAPD',  ibkrSecType:'STK' },
  { ticker:'EMIN.AS',  name:'iShares MSCI India UCITS',            sector:'Emerging',       type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EMIN.AS',  fallbackYahooSymbol:'INDA',  ibkrExchange:'AEB',  ibkrSymbol:'EMIN',  ibkrSecType:'STK' },
  { ticker:'CNYA.AS',  name:'iShares MSCI China A UCITS',          sector:'Emerging',       type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CNYA.AS',  fallbackYahooSymbol:'CNYA',  ibkrExchange:'AEB',  ibkrSymbol:'CNYA',  ibkrSecType:'STK' },
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
  { ticker:'ALUM.DE',  name:'WisdomTree Aluminium ETC',            sector:'Materials',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ALUM.DE',  fallbackYahooSymbol:'JJU',   ibkrExchange:'IBIS', ibkrSymbol:'ALUM',  ibkrSecType:'STK' },
  { ticker:'ZINC.DE',  name:'Xtrackers Zinc ETC',                  sector:'Materials',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ZINC.DE',  fallbackYahooSymbol:'ZINC',  ibkrExchange:'IBIS', ibkrSymbol:'ZINC',  ibkrSecType:'STK' },
  // Renta fija
  { ticker:'DTLA.DE',  name:'iShares $ Treasury 20yr UCITS',       sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DTLA.DE',  fallbackYahooSymbol:'TLT',   ibkrExchange:'IBIS', ibkrSymbol:'DTLA',  ibkrSecType:'STK' },
  { ticker:'IBTU.DE',  name:'iShares $ Corp Bond UCITS',           sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IBTU.DE',  fallbackYahooSymbol:'HYG',   ibkrExchange:'IBIS', ibkrSymbol:'IBTU',  ibkrSecType:'STK' },
  { ticker:'EMUE.DE',  name:'iShares EUR Govt Bond UCITS',         sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EMUE.DE',  fallbackYahooSymbol:'BNDX',  ibkrExchange:'IBIS', ibkrSymbol:'EMUE',  ibkrSecType:'STK' },
  { ticker:'IEGA.DE',  name:'iShares EUR Corporate Bond UCITS',    sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IEGA.DE',  fallbackYahooSymbol:'IBCX',  ibkrExchange:'IBIS', ibkrSymbol:'IEGA',  ibkrSecType:'STK' },
  { ticker:'GLTL.AS',  name:'iShares Global Govt Bond UCITS',      sector:'Fixed Income',   type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'GLTL.AS',  fallbackYahooSymbol:'IGVT',  ibkrExchange:'AEB',  ibkrSymbol:'GLTL',  ibkrSecType:'STK' },
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
  { ticker:'AI.DE',    name:'iShares S&P 500 AI & Robotics UCITS', sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'AI.DE',    fallbackYahooSymbol:'AIEQ',  ibkrExchange:'IBIS', ibkrSymbol:'AI',    ibkrSecType:'STK' },
  { ticker:'FINX.DE',  name:'Global X FinTech UCITS',              sector:'Finance',        type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'FINX.DE',  fallbackYahooSymbol:'FINX',  ibkrExchange:'IBIS', ibkrSymbol:'FINX',  ibkrSecType:'STK' },
  { ticker:'ESGB.DE',  name:'VanEck Video Gaming UCITS',           sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ESGB.DE',  fallbackYahooSymbol:'ESPO',  ibkrExchange:'IBIS', ibkrSymbol:'ESGB',  ibkrSecType:'STK' },
  { ticker:'INRG.DE',  name:'iShares Global Clean Energy (DE)',    sector:'Energy',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'INRG.DE',  fallbackYahooSymbol:'ICLN',  ibkrExchange:'IBIS', ibkrSymbol:'INRG',  ibkrSecType:'STK' },
  { ticker:'WFH.DE',   name:'Global X Telemedicine UCITS',         sector:'Healthcare',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'WFH.DE',   fallbackYahooSymbol:'EDOC',  ibkrExchange:'IBIS', ibkrSymbol:'WFH',   ibkrSecType:'STK' },
];

// ── IBEX 35 — 35 acciones ─────────────────────────────────────
export const IBEX35_STOCKS: UniverseAsset[] = [
  { ticker:'SAN.MC',   name:'Banco Santander',        sector:'Finance',     type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'SAN.MC',   ibkrExchange:'BM',   ibkrSymbol:'SAN',   ibkrSecType:'STK' },
  { ticker:'BBVA.MC',  name:'BBVA',                   sector:'Finance',     type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'BBVA.MC',  ibkrExchange:'BM',   ibkrSymbol:'BBVA',  ibkrSecType:'STK' },
  { ticker:'IBE.MC',   name:'Iberdrola',              sector:'Utilities',   type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'IBE.MC',   ibkrExchange:'BM',   ibkrSymbol:'IBE',   ibkrSecType:'STK' },
  { ticker:'ITX.MC',   name:'Inditex',                sector:'Consumer',    type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'ITX.MC',   ibkrExchange:'BM',   ibkrSymbol:'ITX',   ibkrSecType:'STK' },
  { ticker:'REP.MC',   name:'Repsol',                 sector:'Energy',      type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'REP.MC',   ibkrExchange:'BM',   ibkrSymbol:'REP',   ibkrSecType:'STK' },
  { ticker:'TEF.MC',   name:'Telefónica',             sector:'Technology',  type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'TEF.MC',   ibkrExchange:'BM',   ibkrSymbol:'TEF',   ibkrSecType:'STK' },
  { ticker:'CABK.MC',  name:'CaixaBank',              sector:'Finance',     type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'CABK.MC',  ibkrExchange:'BM',   ibkrSymbol:'CABK',  ibkrSecType:'STK' },
  { ticker:'AMS.MC',   name:'Amadeus IT',             sector:'Technology',  type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'AMS.MC',   ibkrExchange:'BM',   ibkrSymbol:'AMS',   ibkrSecType:'STK' },
  { ticker:'FER.MC',   name:'Ferrovial',              sector:'Infrastructure',type:'STOCK',exchange:'BME', currency:'EUR', yahooSymbol:'FER.MC',   ibkrExchange:'BM',   ibkrSymbol:'FER',   ibkrSecType:'STK' },
  { ticker:'AENA.MC',  name:'AENA',                   sector:'Infrastructure',type:'STOCK',exchange:'BME', currency:'EUR', yahooSymbol:'AENA.MC',  ibkrExchange:'BM',   ibkrSymbol:'AENA',  ibkrSecType:'STK' },
  { ticker:'IAG.MC',   name:'IAG (Iberia)',            sector:'Consumer',    type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'IAG.MC',   ibkrExchange:'BM',   ibkrSymbol:'IAG',   ibkrSecType:'STK' },
  { ticker:'MTS.MC',   name:'ArcelorMittal',          sector:'Materials',   type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'MTS.MC',   ibkrExchange:'BM',   ibkrSymbol:'MTS',   ibkrSecType:'STK' },
  { ticker:'ENG.MC',   name:'Enagás',                 sector:'Utilities',   type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'ENG.MC',   ibkrExchange:'BM',   ibkrSymbol:'ENG',   ibkrSecType:'STK' },
  { ticker:'RED.MC',   name:'Red Eléctrica',          sector:'Utilities',   type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'RED.MC',   ibkrExchange:'BM',   ibkrSymbol:'RED',   ibkrSecType:'STK' },
  { ticker:'GRF.MC',   name:'Grifols',                sector:'Healthcare',  type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'GRF.MC',   ibkrExchange:'BM',   ibkrSymbol:'GRF',   ibkrSecType:'STK' },
  { ticker:'MAP.MC',   name:'MAPFRE',                 sector:'Finance',     type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'MAP.MC',   ibkrExchange:'BM',   ibkrSymbol:'MAP',   ibkrSecType:'STK' },
  { ticker:'ACS.MC',   name:'ACS',                    sector:'Infrastructure',type:'STOCK',exchange:'BME', currency:'EUR', yahooSymbol:'ACS.MC',   ibkrExchange:'BM',   ibkrSymbol:'ACS',   ibkrSecType:'STK' },
  { ticker:'CLNX.MC',  name:'Cellnex Telecom',        sector:'Technology',  type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'CLNX.MC',  ibkrExchange:'BM',   ibkrSymbol:'CLNX',  ibkrSecType:'STK' },
  { ticker:'COL.MC',   name:'Inmobiliaria Colonial',  sector:'Real Estate', type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'COL.MC',   ibkrExchange:'BM',   ibkrSymbol:'COL',   ibkrSecType:'STK' },
  { ticker:'MRL.MC',   name:'Merlin Properties',      sector:'Real Estate', type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'MRL.MC',   ibkrExchange:'BM',   ibkrSymbol:'MRL',   ibkrSecType:'STK' },
  { ticker:'SAB.MC',   name:'Banco Sabadell',         sector:'Finance',     type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'SAB.MC',   ibkrExchange:'BM',   ibkrSymbol:'SAB',   ibkrSecType:'STK' },
  { ticker:'BKT.MC',   name:'Bankinter',              sector:'Finance',     type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'BKT.MC',   ibkrExchange:'BM',   ibkrSymbol:'BKT',   ibkrSecType:'STK' },
  { ticker:'NTGY.MC',  name:'Naturgy',                sector:'Utilities',   type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'NTGY.MC',  ibkrExchange:'BM',   ibkrSymbol:'NTGY',  ibkrSecType:'STK' },
  { ticker:'ACX.MC',   name:'Acerinox',               sector:'Materials',   type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'ACX.MC',   ibkrExchange:'BM',   ibkrSymbol:'ACX',   ibkrSecType:'STK' },
  { ticker:'VIS.MC',   name:'Viscofan',               sector:'Consumer',    type:'STOCK', exchange:'BME',  currency:'EUR', yahooSymbol:'VIS.MC',   ibkrExchange:'BM',   ibkrSymbol:'VIS',   ibkrSecType:'STK' },
];

// ── DAX 40 — selección de 20 más líquidas ────────────────────
export const DAX40_STOCKS: UniverseAsset[] = [
  { ticker:'SAP.DE',   name:'SAP SE',                 sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'SAP.DE',   ibkrExchange:'IBIS', ibkrSymbol:'SAP',   ibkrSecType:'STK' },
  { ticker:'SIE.DE',   name:'Siemens AG',             sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'SIE.DE',   ibkrExchange:'IBIS', ibkrSymbol:'SIE',   ibkrSecType:'STK' },
  { ticker:'ALV.DE',   name:'Allianz SE',             sector:'Finance',     type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'ALV.DE',   ibkrExchange:'IBIS', ibkrSymbol:'ALV',   ibkrSecType:'STK' },
  { ticker:'DTE.DE',   name:'Deutsche Telekom',       sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'DTE.DE',   ibkrExchange:'IBIS', ibkrSymbol:'DTE',   ibkrSecType:'STK' },
  { ticker:'BAYN.DE',  name:'Bayer AG',               sector:'Healthcare',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BAYN.DE',  ibkrExchange:'IBIS', ibkrSymbol:'BAYN',  ibkrSecType:'STK' },
  { ticker:'MUV2.DE',  name:'Munich Re',              sector:'Finance',     type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'MUV2.DE',  ibkrExchange:'IBIS', ibkrSymbol:'MUV2',  ibkrSecType:'STK' },
  { ticker:'BMW.DE',   name:'BMW AG',                 sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BMW.DE',   ibkrExchange:'IBIS', ibkrSymbol:'BMW',   ibkrSecType:'STK' },
  { ticker:'ADS.DE',   name:'Adidas AG',              sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'ADS.DE',   ibkrExchange:'IBIS', ibkrSymbol:'ADS',   ibkrSecType:'STK' },
  { ticker:'EOAN.DE',  name:'E.ON SE',                sector:'Utilities',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'EOAN.DE',  ibkrExchange:'IBIS', ibkrSymbol:'EOAN',  ibkrSecType:'STK' },
  { ticker:'RWE.DE',   name:'RWE AG',                 sector:'Utilities',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'RWE.DE',   ibkrExchange:'IBIS', ibkrSymbol:'RWE',   ibkrSecType:'STK' },
  { ticker:'BASF.DE',  name:'BASF SE',                sector:'Materials',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BASF.DE',  ibkrExchange:'IBIS', ibkrSymbol:'BASF',  ibkrSecType:'STK' },
  { ticker:'VOW3.DE',  name:'Volkswagen AG',          sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'VOW3.DE',  ibkrExchange:'IBIS', ibkrSymbol:'VOW3',  ibkrSecType:'STK' },
  { ticker:'MBG.DE',   name:'Mercedes-Benz',          sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'MBG.DE',   ibkrExchange:'IBIS', ibkrSymbol:'MBG',   ibkrSecType:'STK' },
  { ticker:'DBK.DE',   name:'Deutsche Bank',          sector:'Finance',     type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'DBK.DE',   ibkrExchange:'IBIS', ibkrSymbol:'DBK',   ibkrSecType:'STK' },
  { ticker:'BAS.DE',   name:'BASF SE (alt)',           sector:'Materials',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BAS.DE',   ibkrExchange:'IBIS', ibkrSymbol:'BAS',   ibkrSecType:'STK' },
  { ticker:'HEN3.DE',  name:'Henkel AG',              sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'HEN3.DE',  ibkrExchange:'IBIS', ibkrSymbol:'HEN3',  ibkrSecType:'STK' },
  { ticker:'MERCK.DE', name:'Merck KGaA',             sector:'Healthcare',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'MERCK.DE', ibkrExchange:'IBIS', ibkrSymbol:'MERCK', ibkrSecType:'STK' },
  { ticker:'IFX.DE',   name:'Infineon Technologies',  sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'IFX.DE',   ibkrExchange:'IBIS', ibkrSymbol:'IFX',   ibkrSecType:'STK' },
  { ticker:'DHER.DE',  name:'Delivery Hero',          sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'DHER.DE',  ibkrExchange:'IBIS', ibkrSymbol:'DHER',  ibkrSecType:'STK' },
  { ticker:'QGEN.DE',  name:'Qiagen NV',              sector:'Healthcare',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'QGEN.DE',  ibkrExchange:'IBIS', ibkrSymbol:'QGEN',  ibkrSecType:'STK' },
];

// ── CAC 40 — selección de 15 más líquidas ────────────────────
export const CAC40_STOCKS: UniverseAsset[] = [
  { ticker:'MC.PA',    name:'LVMH',                   sector:'Consumer',    type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'MC.PA',    ibkrExchange:'SBF',  ibkrSymbol:'MC',    ibkrSecType:'STK' },
  { ticker:'OR.PA',    name:"L'Oréal",                sector:'Consumer',    type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'OR.PA',    ibkrExchange:'SBF',  ibkrSymbol:'OR',    ibkrSecType:'STK' },
  { ticker:'TTE.PA',   name:'TotalEnergies',          sector:'Energy',      type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'TTE.PA',   ibkrExchange:'SBF',  ibkrSymbol:'TTE',   ibkrSecType:'STK' },
  { ticker:'AIR.PA',   name:'Airbus SE',              sector:'Defense',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AIR.PA',   ibkrExchange:'SBF',  ibkrSymbol:'AIR',   ibkrSecType:'STK' },
  { ticker:'SAN.PA',   name:'Sanofi',                 sector:'Healthcare',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'SAN.PA',   ibkrExchange:'SBF',  ibkrSymbol:'SAN',   ibkrSecType:'STK' },
  { ticker:'BNP.PA',   name:'BNP Paribas',            sector:'Finance',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'BNP.PA',   ibkrExchange:'SBF',  ibkrSymbol:'BNP',   ibkrSecType:'STK' },
  { ticker:'AXA.PA',   name:'AXA SA',                 sector:'Finance',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AXA.PA',   ibkrExchange:'SBF',  ibkrSymbol:'AXA',   ibkrSecType:'STK' },
  { ticker:'KER.PA',   name:'Kering SA',              sector:'Consumer',    type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'KER.PA',   ibkrExchange:'SBF',  ibkrSymbol:'KER',   ibkrSecType:'STK' },
  { ticker:'HO.PA',    name:'Thales SA',              sector:'Defense',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'HO.PA',    ibkrExchange:'SBF',  ibkrSymbol:'HO',    ibkrSecType:'STK' },
  { ticker:'DSY.PA',   name:'Dassault Systèmes',      sector:'Technology',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'DSY.PA',   ibkrExchange:'SBF',  ibkrSymbol:'DSY',   ibkrSecType:'STK' },
  { ticker:'VIE.PA',   name:'Veolia Environnement',   sector:'Utilities',   type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'VIE.PA',   ibkrExchange:'SBF',  ibkrSymbol:'VIE',   ibkrSecType:'STK' },
  { ticker:'AI.PA',    name:'Air Liquide',            sector:'Materials',   type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AI.PA',    ibkrExchange:'SBF',  ibkrSymbol:'AI',    ibkrSecType:'STK' },
  { ticker:'SU.PA',    name:'Schneider Electric',     sector:'Technology',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'SU.PA',    ibkrExchange:'SBF',  ibkrSymbol:'SU',    ibkrSecType:'STK' },
  { ticker:'CAP.PA',   name:'Capgemini SE',           sector:'Technology',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'CAP.PA',   ibkrExchange:'SBF',  ibkrSymbol:'CAP',   ibkrSecType:'STK' },
  { ticker:'EN.PA',    name:'Bouygues SA',            sector:'Infrastructure',type:'STOCK',exchange:'EURONEXT',currency:'EUR', yahooSymbol:'EN.PA',    ibkrExchange:'SBF',  ibkrSymbol:'EN',    ibkrSecType:'STK' },
];

// ── FTSE 100 — selección de 15 más líquidas ──────────────────
export const FTSE100_STOCKS: UniverseAsset[] = [
  { ticker:'SHEL.L',   name:'Shell PLC',              sector:'Energy',      type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'SHEL.L',   ibkrExchange:'LSE',  ibkrSymbol:'SHEL',  ibkrSecType:'STK' },
  { ticker:'AZN.L',    name:'AstraZeneca',            sector:'Healthcare',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'AZN.L',    ibkrExchange:'LSE',  ibkrSymbol:'AZN',   ibkrSecType:'STK' },
  { ticker:'HSBA.L',   name:'HSBC Holdings',          sector:'Finance',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'HSBA.L',   ibkrExchange:'LSE',  ibkrSymbol:'HSBA',  ibkrSecType:'STK' },
  { ticker:'ULVR.L',   name:'Unilever PLC',           sector:'Consumer',    type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'ULVR.L',   ibkrExchange:'LSE',  ibkrSymbol:'ULVR',  ibkrSecType:'STK' },
  { ticker:'BP.L',     name:'BP PLC',                 sector:'Energy',      type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'BP.L',     ibkrExchange:'LSE',  ibkrSymbol:'BP',    ibkrSecType:'STK' },
  { ticker:'GSK.L',    name:'GSK PLC',                sector:'Healthcare',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'GSK.L',    ibkrExchange:'LSE',  ibkrSymbol:'GSK',   ibkrSecType:'STK' },
  { ticker:'RIO.L',    name:'Rio Tinto PLC',          sector:'Materials',   type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'RIO.L',    ibkrExchange:'LSE',  ibkrSymbol:'RIO',   ibkrSecType:'STK' },
  { ticker:'GLEN.L',   name:'Glencore PLC',           sector:'Materials',   type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'GLEN.L',   ibkrExchange:'LSE',  ibkrSymbol:'GLEN',  ibkrSecType:'STK' },
  { ticker:'BT-A.L',   name:'BT Group',               sector:'Technology',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'BT-A.L',   ibkrExchange:'LSE',  ibkrSymbol:'BT.A',  ibkrSecType:'STK' },
  { ticker:'VOD.L',    name:'Vodafone Group',         sector:'Technology',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'VOD.L',    ibkrExchange:'LSE',  ibkrSymbol:'VOD',   ibkrSecType:'STK' },
  { ticker:'LLOY.L',   name:'Lloyds Banking Group',  sector:'Finance',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'LLOY.L',   ibkrExchange:'LSE',  ibkrSymbol:'LLOY',  ibkrSecType:'STK' },
  { ticker:'BARC.L',   name:'Barclays PLC',           sector:'Finance',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'BARC.L',   ibkrExchange:'LSE',  ibkrSymbol:'BARC',  ibkrSecType:'STK' },
  { ticker:'DGE.L',    name:'Diageo PLC',             sector:'Consumer',    type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'DGE.L',    ibkrExchange:'LSE',  ibkrSymbol:'DGE',   ibkrSecType:'STK' },
  { ticker:'RR.L',     name:'Rolls-Royce Holdings',  sector:'Defense',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'RR.L',     ibkrExchange:'LSE',  ibkrSymbol:'RR',    ibkrSecType:'STK' },
  { ticker:'NXT.L',    name:'Next PLC',               sector:'Consumer',    type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'NXT.L',    ibkrExchange:'LSE',  ibkrSymbol:'NXT',   ibkrSecType:'STK' },
];

// ── US Mega-caps (accesibles desde IBKR Europa) ──────────────
export const US_STOCKS: UniverseAsset[] = [
  { ticker:'AAPL',     name:'Apple Inc.',             sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AAPL',     ibkrExchange:'NASDAQ', ibkrSymbol:'AAPL',  ibkrSecType:'STK' },
  { ticker:'MSFT',     name:'Microsoft Corp.',        sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'MSFT',     ibkrExchange:'NASDAQ', ibkrSymbol:'MSFT',  ibkrSecType:'STK' },
  { ticker:'NVDA',     name:'NVIDIA Corp.',           sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'NVDA',     ibkrExchange:'NASDAQ', ibkrSymbol:'NVDA',  ibkrSecType:'STK' },
  { ticker:'AMZN',     name:'Amazon.com Inc.',        sector:'Consumer',    type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AMZN',     ibkrExchange:'NASDAQ', ibkrSymbol:'AMZN',  ibkrSecType:'STK' },
  { ticker:'GOOGL',    name:'Alphabet Inc.',          sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'GOOGL',    ibkrExchange:'NASDAQ', ibkrSymbol:'GOOGL', ibkrSecType:'STK' },
  { ticker:'META',     name:'Meta Platforms Inc.',    sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'META',     ibkrExchange:'NASDAQ', ibkrSymbol:'META',  ibkrSecType:'STK' },
  { ticker:'TSLA',     name:'Tesla Inc.',             sector:'Consumer',    type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'TSLA',     ibkrExchange:'NASDAQ', ibkrSymbol:'TSLA',  ibkrSecType:'STK' },
  { ticker:'JPM',      name:'JPMorgan Chase',         sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'JPM',      ibkrExchange:'NYSE',   ibkrSymbol:'JPM',   ibkrSecType:'STK' },
  { ticker:'V',        name:'Visa Inc.',              sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'V',        ibkrExchange:'NYSE',   ibkrSymbol:'V',     ibkrSecType:'STK' },
  { ticker:'XOM',      name:'ExxonMobil Corp.',       sector:'Energy',      type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'XOM',      ibkrExchange:'NYSE',   ibkrSymbol:'XOM',   ibkrSecType:'STK' },
  { ticker:'JNJ',      name:'Johnson & Johnson',      sector:'Healthcare',  type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'JNJ',      ibkrExchange:'NYSE',   ibkrSymbol:'JNJ',   ibkrSecType:'STK' },
  { ticker:'WMT',      name:'Walmart Inc.',           sector:'Consumer',    type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'WMT',      ibkrExchange:'NYSE',   ibkrSymbol:'WMT',   ibkrSecType:'STK' },
  { ticker:'MA',       name:'Mastercard Inc.',        sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'MA',       ibkrExchange:'NYSE',   ibkrSymbol:'MA',    ibkrSecType:'STK' },
  { ticker:'BAC',      name:'Bank of America',        sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'BAC',      ibkrExchange:'NYSE',   ibkrSymbol:'BAC',   ibkrSecType:'STK' },
  { ticker:'PLTR',     name:'Palantir Technologies',  sector:'Technology',  type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'PLTR',     ibkrExchange:'NYSE',   ibkrSymbol:'PLTR',  ibkrSecType:'STK' },
  { ticker:'AMD',      name:'Advanced Micro Devices', sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AMD',      ibkrExchange:'NASDAQ', ibkrSymbol:'AMD',   ibkrSecType:'STK' },
  { ticker:'INTC',     name:'Intel Corporation',      sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'INTC',     ibkrExchange:'NASDAQ', ibkrSymbol:'INTC',  ibkrSecType:'STK' },
  { ticker:'SMCI',     name:'Super Micro Computer',   sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'SMCI',     ibkrExchange:'NASDAQ', ibkrSymbol:'SMCI',  ibkrSecType:'STK' },
  { ticker:'COIN',     name:'Coinbase Global',        sector:'Finance',     type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'COIN',     ibkrExchange:'NASDAQ', ibkrSymbol:'COIN',  ibkrSecType:'STK' },
  { ticker:'MSTR',     name:'MicroStrategy Inc.',     sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'MSTR',     ibkrExchange:'NASDAQ', ibkrSymbol:'MSTR',  ibkrSecType:'STK' },
];

// ════════════════════════════════════════════════════════════
// UNIVERSOS COMPUESTOS
// ════════════════════════════════════════════════════════════

// FULL: 7 + 57 + 25 + 20 + 15 + 15 + 20 = ~159 activos  (~15-20 min)
export const FULL_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_ETFS,
  ...IBEX35_STOCKS,
  ...DAX40_STOCKS,
  ...CAC40_STOCKS,
  ...FTSE100_STOCKS,
  ...US_STOCKS,
];

// CORE: 22 ETFs UCITS más líquidos + top 10 acciones europeas  (~3-5 min)
export const CORE_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_ETFS.filter(a => [
    'CSPX.AS','CNDX.AS','IWDA.AS','EIMI.AS',
    'SSLN.DE','4GLD.DE','DTLA.DE',
    'EXV1.DE','EXV3.DE','EXV4.DE','EXV6.DE',
    'GDX.DE','IQQH.DE','IUSN.DE','ARKY.DE',
  ].includes(a.ticker)),
  // Top ibex + top dax + top cac + top ftse
  ...IBEX35_STOCKS.filter(a => ['SAN.MC','BBVA.MC','IBE.MC','ITX.MC','AMS.MC'].includes(a.ticker)),
  ...DAX40_STOCKS.filter(a => ['SAP.DE','SIE.DE','ALV.DE','BAYN.DE','IFX.DE'].includes(a.ticker)),
  ...CAC40_STOCKS.filter(a => ['MC.PA','AIR.PA','SAN.PA','TTE.PA','SU.PA'].includes(a.ticker)),
  ...US_STOCKS.filter(a => ['NVDA','AAPL','MSFT','TSLA','META'].includes(a.ticker)),
];

// VOLATILE: alta beta  (~2-3 min)
export const VOLATILE_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_ETFS.filter(a => [
    'ARKY.DE','LITG.DE','OILG.DE','LNGG.DE',
    'GDX.DE','IQQH.DE','ECAR.DE','COPP.DE',
    'SSLN.DE','CNDX.AS',
  ].includes(a.ticker)),
  ...US_STOCKS.filter(a => ['NVDA','TSLA','AMD','SMCI','COIN','MSTR','PLTR'].includes(a.ticker)),
  ...IBEX35_STOCKS.filter(a => ['IAG.MC','GRF.MC','MTS.MC'].includes(a.ticker)),
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
