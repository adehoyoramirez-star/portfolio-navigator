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
}

// ── Portfolio Olympus (7 ETFs core — siempre monitorizados) ──
export const OLYMPUS_ASSETS: UniverseAsset[] = [
  { ticker:'BTC-EUR',  name:'Bitcoin EUR',                  sector:'Crypto',      type:'CRYPTO', exchange:'Crypto',    currency:'EUR', yahooSymbol:'BTC-EUR',  fallbackYahooSymbol:'BTC-USD' },
  { ticker:'IS3Q.DE',  name:'iShares MSCI World Quality',   sector:'Equity',      type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'IS3Q.DE',  fallbackYahooSymbol:'URTH', },
  { ticker:'VVSM.DE',  name:'VanEck Semiconductor',         sector:'Technology',  type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'VVSM.DE',  fallbackYahooSymbol:'SMH', },
  { ticker:'URNU.DE',  name:'Global X Uranium',             sector:'Energy',      type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'URNU.DE',  fallbackYahooSymbol:'URA', },
  { ticker:'EMXC.DE',  name:'iShares MSCI EM ex-China',     sector:'Emerging',    type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'EMXC.DE',  fallbackYahooSymbol:'EEM', },
  { ticker:'PPFB.DE',  name:'iShares Physical Gold',        sector:'Commodities', type:'ETC',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'PPFB.DE',  fallbackYahooSymbol:'GLD', },
  { ticker:'XNAS.DE',  name:'iShares NASDAQ 100 UCITS',     sector:'Technology',  type:'ETF',    exchange:'XETRA',     currency:'EUR', yahooSymbol:'XNAS.DE',  fallbackYahooSymbol:'QQQ', },
];

// ── ETFs / ETCs UCITS (55 activos) ───────────────────────────
export const UCITS_ETFS: UniverseAsset[] = [
  // Índices globales
  { ticker:'CSPX.AS',  name:'iShares Core S&P 500 UCITS',         sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CSPX.AS',  fallbackYahooSymbol:'SPY', },
  { ticker:'CNDX.AS',  name:'iShares Core NASDAQ 100 UCITS',       sector:'Technology',     type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CNDX.AS',  fallbackYahooSymbol:'QQQ', },
  { ticker:'IWDA.AS',  name:'iShares Core MSCI World UCITS',       sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'IWDA.AS',  fallbackYahooSymbol:'URTH', },
  { ticker:'IUSN.DE',  name:'iShares MSCI World Small Cap',        sector:'Small Cap',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IUSN.DE',  fallbackYahooSymbol:'IWM', },
  { ticker:'EIMI.AS',  name:'iShares Core MSCI EM UCITS',          sector:'Emerging',       type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EIMI.AS',  fallbackYahooSymbol:'EEM', },
  { ticker:'EMBE.AS',  name:'iShares JPM USD EM Bond UCITS',       sector:'Emerging Bonds', type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EMBE.AS',  fallbackYahooSymbol:'EMB', },
  { ticker:'IWDA.L',   name:'iShares Core MSCI World (LSE)',        sector:'Equity',         type:'ETF', exchange:'LSE',      currency:'GBP', yahooSymbol:'IWDA.L',   fallbackYahooSymbol:'URTH', },
  { ticker:'CSP1.L',   name:'iShares Core S&P 500 (LSE)',           sector:'Equity',         type:'ETF', exchange:'LSE',      currency:'GBP', yahooSymbol:'CSP1.L',   fallbackYahooSymbol:'SPY', },
  // Europa
  { ticker:'EXH3.DE',  name:'iShares Core DAX UCITS',              sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXH3.DE',  fallbackYahooSymbol:'EWG', },
  { ticker:'DBXD.DE',  name:'Xtrackers DAX UCITS',                 sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DBXD.DE',  fallbackYahooSymbol:'EWG', },  // FIX: DAX→EWG
  { ticker:'IMEA.AS',  name:'iShares Core MSCI Europe UCITS',      sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'IMEA.AS',  fallbackYahooSymbol:'IEUR', },
  { ticker:'XESX.DE',  name:'Xtrackers Euro Stoxx 50 UCITS',       sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'XESX.DE',  fallbackYahooSymbol:'FEZ', },
  { ticker:'EXSA.DE',  name:'iShares STOXX Europe 600 UCITS',      sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXSA.DE',  fallbackYahooSymbol:'VGK', },  // FIX: STOXX→VGK
  { ticker:'MEUD.PA',  name:'Lyxor MSCI Europe UCITS',             sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'MEUD.PA',  fallbackYahooSymbol:'IEUR', },
  // Norteamérica
  { ticker:'CS51.DE',  name:'iShares MSCI USA UCITS',              sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'CS51.DE',  fallbackYahooSymbol:'SPY', },  // FIX: IUSA→SPY
  { ticker:'XD9U.DE',  name:'Xtrackers MSCI USA UCITS',            sector:'Equity',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'XD9U.DE',  fallbackYahooSymbol:'SPY', },  // FIX: IUSA→SPY
  // Asia / Emergentes
  { ticker:'IAPDM.XD',  name:'iShares MSCI Pacific ex-Japan UCITS', sector:'Equity',         type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'IAPDM.XD',  fallbackYahooSymbol:'EPP', },
  { ticker:'EMIN.AS',  name:'iShares MSCI India UCITS',            sector:'Emerging',       type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EMIN.AS',  fallbackYahooSymbol:'INDA', },
  { ticker:'CNYA.AS',  name:'iShares MSCI China A UCITS',          sector:'Emerging',       type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CNYA.AS',  fallbackYahooSymbol:'MCHI', },  // FIX: CNYA→MCHI
  // Sectoriales STOXX 600
  { ticker:'EXV1.DE',  name:'iShares STOXX Eur 600 Oil&Gas',       sector:'Energy',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV1.DE',  fallbackYahooSymbol:'XLE', },
  { ticker:'EXV3.DE',  name:'iShares STOXX Eur 600 Tech',          sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV3.DE',  fallbackYahooSymbol:'XLK', },
  { ticker:'EXV4.DE',  name:'iShares STOXX Eur 600 Financials',    sector:'Finance',        type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV4.DE',  fallbackYahooSymbol:'XLF', },
  { ticker:'EXV6.DE',  name:'iShares STOXX Eur 600 Health Care',   sector:'Healthcare',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV6.DE',  fallbackYahooSymbol:'XLV', },
  { ticker:'EXV5.DE',  name:'iShares STOXX Eur 600 Utilities',     sector:'Utilities',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV5.DE',  fallbackYahooSymbol:'XLU', },
  { ticker:'EXV2.DE',  name:'iShares STOXX Eur 600 Chemicals',     sector:'Materials',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV2.DE',  fallbackYahooSymbol:'XLB', },
  { ticker:'EXV9.DE',  name:'iShares STOXX Eur 600 Food&Bev',      sector:'Consumer',       type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV9.DE',  fallbackYahooSymbol:'XLP', },
  { ticker:'EXV8.DE',  name:'iShares STOXX Eur 600 Telecom',       sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV8.DE',  fallbackYahooSymbol:'IXP', },
  // Commodities ETCs
  { ticker:'SSLN.DE',  name:'iShares Physical Silver ETC',         sector:'Commodities',    type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'SSLN.DE',  fallbackYahooSymbol:'SLV', },
  { ticker:'4GLD.DE',  name:'Xetra-Gold ETC',                      sector:'Commodities',    type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'4GLD.DE',  fallbackYahooSymbol:'GLD', },
  { ticker:'OILG.DE',  name:'WisdomTree Crude Oil ETC',            sector:'Energy',         type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'OILG.DE',  fallbackYahooSymbol:'USO', },
  { ticker:'COPP.DE',  name:'WisdomTree Copper ETC',               sector:'Materials',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'COPP.DE',  fallbackYahooSymbol:'CPER', },
  { ticker:'LNGG.DE',  name:'WisdomTree Natural Gas ETC',          sector:'Energy',         type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'LNGG.DE',  fallbackYahooSymbol:'UNG', },
  { ticker:'ALUM.DE',  name:'WisdomTree Aluminium ETC',            sector:'Materials',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ALUM.DE',  fallbackYahooSymbol:'DBB', },  // FIX: JJU→DBB
  { ticker:'ZINC.DE',  name:'Xtrackers Zinc ETC',                  sector:'Materials',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ZINC.DE',  fallbackYahooSymbol:'DBB', },  // FIX: ZINC→DBB
  // Renta fija
  { ticker:'DTLA.DE',  name:'iShares $ Treasury 20yr UCITS',       sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DTLA.DE',  fallbackYahooSymbol:'TLT', },
  { ticker:'IBTU.DE',  name:'iShares $ Corp Bond UCITS',           sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IBTU.DE',  fallbackYahooSymbol:'HYG', },
  { ticker:'EMUE.DE',  name:'iShares EUR Govt Bond UCITS',         sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EMUE.DE',  fallbackYahooSymbol:'BNDX', },
  { ticker:'IEGA.DE',  name:'iShares EUR Corporate Bond UCITS',    sector:'Fixed Income',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IEGA.DE',  fallbackYahooSymbol:'LQD', },  // FIX: IBCX→LQD
  { ticker:'GLTL.AS',  name:'iShares Global Govt Bond UCITS',      sector:'Fixed Income',   type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'GLTL.AS',  fallbackYahooSymbol:'BNDX', },  // FIX: IGVT→BNDX
  // Temáticos
  { ticker:'GDX.DE',   name:'VanEck Gold Miners UCITS',            sector:'Commodities',    type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'GDX.DE',   fallbackYahooSymbol:'GDX', },
  { ticker:'IQQH.DE',  name:'iShares Global Clean Energy UCITS',   sector:'Energy',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IQQH.DE',  fallbackYahooSymbol:'ICLN', },
  { ticker:'ECAR.DE',  name:'iShares Electric Vehicles UCITS',     sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ECAR.DE',  fallbackYahooSymbol:'DRIV', },
  { ticker:'ARKY.DE',  name:'ARK Innovation UCITS',                sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ARKY.DE',  fallbackYahooSymbol:'ARKK', },
  { ticker:'LITG.DE',  name:'Global X Lithium Battery UCITS',      sector:'Materials',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'LITG.DE',  fallbackYahooSymbol:'LIT', },
  { ticker:'COPX.DE',  name:'Global X Copper Miners UCITS',        sector:'Materials',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'COPX.DE',  fallbackYahooSymbol:'COPX', },
  { ticker:'IQHI.DE',  name:'iShares Global Healthcare UCITS',     sector:'Healthcare',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IQHI.DE',  fallbackYahooSymbol:'IXJ', },
  { ticker:'CLOU.DE',  name:'Global X Cloud Computing UCITS',      sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'CLOU.DE',  fallbackYahooSymbol:'CLOU', },
  { ticker:'RBOT.DE',  name:'iShares Robotics & AI UCITS',         sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'RBOT.DE',  fallbackYahooSymbol:'BOTZ', },
  { ticker:'ISPY.DE',  name:'iShares Cybersecurity UCITS',         sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ISPY.DE',  fallbackYahooSymbol:'CIBR', },
  { ticker:'AI.DE',    name:'iShares S&P 500 AI & Robotics UCITS', sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'AI.DE',    fallbackYahooSymbol:'BOTZ', },  // FIX: AIEQ→BOTZ
  { ticker:'FINX.DE',  name:'Global X FinTech UCITS',              sector:'Finance',        type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'FINX.DE',  fallbackYahooSymbol:'FINX', },
  { ticker:'ESGB.DE',  name:'VanEck Video Gaming UCITS',           sector:'Technology',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ESGB.DE',  fallbackYahooSymbol:'ESPO', },
  { ticker:'INRG.DE',  name:'iShares Global Clean Energy (DE)',    sector:'Energy',         type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'INRG.DE',  fallbackYahooSymbol:'ICLN', },
  { ticker:'WFH.DE',   name:'Global X Telemedicine UCITS',         sector:'Healthcare',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'WFH.DE',   fallbackYahooSymbol:'IHI', },  // FIX: EDOC→IHI
];

// ── IBEX 35 — 25 acciones (con ADR/US fallback donde existe) ─
export const IBEX35_STOCKS: UniverseAsset[] = [
  // Con ADR en NYSE/NASDAQ
  { ticker:'SAN.MC',   name:'Banco Santander',        sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'SAN.MC',   fallbackYahooSymbol:'SAN', },  // NYSE ADR
  { ticker:'BBVA.MC',  name:'BBVA',                   sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'BBVA.MC',  fallbackYahooSymbol:'BBVA', },  // NYSE ADR
  { ticker:'TEF.MC',   name:'Telefónica',             sector:'Technology',    type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'TEF.MC',   fallbackYahooSymbol:'TEF', },  // NYSE ADR
  { ticker:'MTS.MC',   name:'ArcelorMittal',          sector:'Materials',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'MTS.MC',   fallbackYahooSymbol:'MT', },  // NYSE dual-listed
  { ticker:'GRF.MC',   name:'Grifols',                sector:'Healthcare',    type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'GRF.MC',   fallbackYahooSymbol:'GRFS', },  // NASDAQ dual-listed
  { ticker:'FER.MC',   name:'Ferrovial',              sector:'Infrastructure', type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'FER.MC',   fallbackYahooSymbol:'FER', },  // NASDAQ (2023)
  { ticker:'IBE.MC',   name:'Iberdrola',              sector:'Utilities',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'IBE.MC',   fallbackYahooSymbol:'IBDRY' },  // OTC ADR
  { ticker:'REP.MC',   name:'Repsol',                 sector:'Energy',        type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'REP.MC',   fallbackYahooSymbol:'REPYY' },  // OTC ADR
  { ticker:'AMS.MC',   name:'Amadeus IT',             sector:'Technology',    type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'AMS.MC',   fallbackYahooSymbol:'AMADY' },  // OTC ADR
  { ticker:'IAG.MC',   name:'IAG (Iberia)',            sector:'Consumer',      type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'IAG.MC',   fallbackYahooSymbol:'DAL', },  // DAL (Delta Air Lines) — líquido, no en universo
  { ticker:'NTGY.MC',  name:'Naturgy',                sector:'Utilities',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'NTGY.MC',  fallbackYahooSymbol:'NEE', },  // NEE (NextEra Energy) — líquido, no en universo
  { ticker:'ITX.MC',   name:'Inditex',                sector:'Consumer',      type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'ITX.MC',   fallbackYahooSymbol:'TGT', },  // TGT (Target) — retail proxy, no en universo
  // Sin ADR líquido — fallback a acciones US líquidas fuera del universo
  { ticker:'CABK.MC',  name:'CaixaBank',              sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'CABK.MC',  fallbackYahooSymbol:'C', },  // Citigroup — finance proxy, no en universo
  { ticker:'AENA.MC',  name:'AENA',                   sector:'Infrastructure', type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'AENA.MC',  fallbackYahooSymbol:'UAL', },  // United Airlines — infra/transport proxy, no en universo
  { ticker:'ENG.MC',   name:'Enagás',                 sector:'Utilities',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'ENG.MC',   fallbackYahooSymbol:'NEE', },  // NEE — utilities proxy, no en universo
  { ticker:'RED.MC',   name:'Red Eléctrica',          sector:'Utilities',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'RED.MC',   fallbackYahooSymbol:'NEE', },  // NEE — utilities proxy, no en universo
  { ticker:'MAP.MC',   name:'MAPFRE',                 sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'MAP.MC',   fallbackYahooSymbol:'C', },  // Citigroup — finance proxy, no en universo
  { ticker:'ACS.MC',   name:'ACS',                    sector:'Infrastructure', type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'ACS.MC',   fallbackYahooSymbol:'CAT', },  // Caterpillar — industrials proxy, no en universo
  { ticker:'CLNX.MC',  name:'Cellnex Telecom',        sector:'Technology',    type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'CLNX.MC',  fallbackYahooSymbol:'AMT', },  // American Tower — cell tower proxy, no en universo
  { ticker:'COL.MC',   name:'Inmobiliaria Colonial',  sector:'Real Estate',   type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'COL.MC',   fallbackYahooSymbol:'XLRE', },  // proxy: Real Estate ETF
  { ticker:'MRL.MC',   name:'Merlin Properties',      sector:'Real Estate',   type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'MRL.MC',   fallbackYahooSymbol:'XLRE', },  // proxy: Real Estate ETF
  { ticker:'SAB.MC',   name:'Banco Sabadell',         sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'SAB.MC',   fallbackYahooSymbol:'XLF', },  // proxy: Financial ETF
  { ticker:'BKT.MC',   name:'Bankinter',              sector:'Finance',       type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'BKT.MC',   fallbackYahooSymbol:'XLF', },  // proxy: Financial ETF
  { ticker:'ACX.MC',   name:'Acerinox',               sector:'Materials',     type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'ACX.MC',   fallbackYahooSymbol:'XLB', },  // proxy: Materials ETF
  { ticker:'VIS.MC',   name:'Viscofan',               sector:'Consumer',      type:'STOCK', exchange:'BME', currency:'EUR', yahooSymbol:'VIS.MC',   fallbackYahooSymbol:'XLP', },  // proxy: Consumer Staples ETF
];

// ── DAX 40 — 19 acciones (BAS.DE eliminado: duplicado de BASF.DE)
export const DAX40_STOCKS: UniverseAsset[] = [
  { ticker:'SAP.DE',   name:'SAP SE',                 sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'SAP.DE',   fallbackYahooSymbol:'SAP', },  // NYSE dual-listed
  { ticker:'DBK.DE',   name:'Deutsche Bank',          sector:'Finance',     type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'DBK.DE',   fallbackYahooSymbol:'DB', },  // NYSE dual-listed
  { ticker:'QGEN.DE',  name:'Qiagen NV',              sector:'Healthcare',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'QGEN.DE',  fallbackYahooSymbol:'QGEN', },  // NYSE dual-listed
  { ticker:'SIE.DE',   name:'Siemens AG',             sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'SIE.DE',   fallbackYahooSymbol:'SIEGY', },  // OTC ADR
  { ticker:'ALV.DE',   name:'Allianz SE',             sector:'Finance',     type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'ALV.DE',   fallbackYahooSymbol:'ALIZY', },  // OTC ADR
  { ticker:'BAYN.DE',  name:'Bayer AG',               sector:'Healthcare',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BAYN.DE',  fallbackYahooSymbol:'BAYRY', },  // OTC ADR
  { ticker:'MUV2.DE',  name:'Munich Re',              sector:'Finance',     type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'MUV2.DE',  fallbackYahooSymbol:'MURGY', },  // OTC ADR
  { ticker:'BMW.DE',   name:'BMW AG',                 sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BMW.DE',   fallbackYahooSymbol:'BMWYY', },  // OTC ADR
  { ticker:'ADS.DE',   name:'Adidas AG',              sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'ADS.DE',   fallbackYahooSymbol:'ADDYY', },  // OTC ADR
  { ticker:'EOAN.DE',  name:'E.ON SE',                sector:'Utilities',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'EOAN.DE',  fallbackYahooSymbol:'EONGY', },  // OTC ADR
  { ticker:'RWE.DE',   name:'RWE AG',                 sector:'Utilities',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'RWE.DE',   fallbackYahooSymbol:'RWEOY', },  // OTC ADR
  { ticker:'BASF.DE',  name:'BASF SE',                sector:'Materials',   type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'BASF.DE',  fallbackYahooSymbol:'BASFY', },  // OTC ADR
  { ticker:'VOW3.DE',  name:'Volkswagen AG',          sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'VOW3.DE',  fallbackYahooSymbol:'VWAGY', },  // OTC ADR
  { ticker:'MBG.DE',   name:'Mercedes-Benz',          sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'MBG.DE',   fallbackYahooSymbol:'MBGYY', },  // OTC ADR
  { ticker:'DTE.DE',   name:'Deutsche Telekom',       sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'DTE.DE',   fallbackYahooSymbol:'DTEGY', },  // OTC ADR
  { ticker:'HEN3.DE',  name:'Henkel AG',              sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'HEN3.DE',  fallbackYahooSymbol:'HENKY', },  // OTC ADR
  { ticker:'MERCK.DE', name:'Merck KGaA',             sector:'Healthcare',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'MERCK.DE', fallbackYahooSymbol:'MKKGY', },  // OTC ADR
  { ticker:'IFX.DE',   name:'Infineon Technologies',  sector:'Technology',  type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'IFX.DE',   fallbackYahooSymbol:'IFNNY', },  // OTC ADR
  { ticker:'DHER.DE',  name:'Delivery Hero',          sector:'Consumer',    type:'STOCK', exchange:'XETRA', currency:'EUR', yahooSymbol:'DHER.DE',  fallbackYahooSymbol:'XLY', },  // proxy: Consumer Discr ETF
];

// ── CAC 40 — 15 acciones ──────────────────────────────────────
export const CAC40_STOCKS: UniverseAsset[] = [
  { ticker:'TTE.PA',   name:'TotalEnergies',          sector:'Energy',      type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'TTE.PA',   fallbackYahooSymbol:'TTE', },  // NYSE dual-listed
  { ticker:'SAN.PA',   name:'Sanofi',                 sector:'Healthcare',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'SAN.PA',   fallbackYahooSymbol:'SNY', },  // NASDAQ dual-listed
  { ticker:'MC.PA',    name:'LVMH',                   sector:'Consumer',    type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'MC.PA',    fallbackYahooSymbol:'LVMUY', },  // OTC ADR
  { ticker:'OR.PA',    name:"L'Oréal",                sector:'Consumer',    type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'OR.PA',    fallbackYahooSymbol:'LRLCY', },  // OTC ADR
  { ticker:'AIR.PA',   name:'Airbus SE',              sector:'Defense',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AIR.PA',   fallbackYahooSymbol:'EADSY', },  // OTC ADR
  { ticker:'BNP.PA',   name:'BNP Paribas',            sector:'Finance',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'BNP.PA',   fallbackYahooSymbol:'BNPQY', },  // OTC ADR
  { ticker:'AXA.PA',   name:'AXA SA',                 sector:'Finance',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AXA.PA',   fallbackYahooSymbol:'AXAHY', },  // OTC ADR
  { ticker:'KER.PA',   name:'Kering SA',              sector:'Consumer',    type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'KER.PA',   fallbackYahooSymbol:'PPRUY', },  // OTC ADR
  { ticker:'SU.PA',    name:'Schneider Electric',     sector:'Technology',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'SU.PA',    fallbackYahooSymbol:'SBGSY', },  // OTC ADR
  { ticker:'AI.PA',    name:'Air Liquide',            sector:'Materials',   type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AI.PA',    fallbackYahooSymbol:'AIQUY', },  // OTC ADR
  { ticker:'DSY.PA',   name:'Dassault Systèmes',      sector:'Technology',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'DSY.PA',   fallbackYahooSymbol:'DASTY', },  // OTC ADR
  { ticker:'VIE.PA',   name:'Veolia Environnement',   sector:'Utilities',   type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'VIE.PA',   fallbackYahooSymbol:'VEOEY', },  // OTC ADR
  { ticker:'CAP.PA',   name:'Capgemini SE',           sector:'Technology',  type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'CAP.PA',   fallbackYahooSymbol:'CGEMY', },  // OTC ADR
  { ticker:'HO.PA',    name:'Thales SA',              sector:'Defense',     type:'STOCK', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'HO.PA',    fallbackYahooSymbol:'ITA', },  // proxy: iShares Aerospace & Defense ETF (THLEF demasiado thin)
  { ticker:'EN.PA',    name:'Bouygues SA',            sector:'Infrastructure',type:'STOCK',exchange:'EURONEXT',currency:'EUR', yahooSymbol:'EN.PA',    fallbackYahooSymbol:'XLI', },  // proxy: Industrials ETF (BOUYE demasiado thin)
];

// ── FTSE 100 — 15 acciones (todas con US listing/ADR) ────────
export const FTSE100_STOCKS: UniverseAsset[] = [
  { ticker:'SHEL.L',   name:'Shell PLC',              sector:'Energy',      type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'SHEL.L',   fallbackYahooSymbol:'SHEL', },  // NYSE dual-listed
  { ticker:'AZN.L',    name:'AstraZeneca',            sector:'Healthcare',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'AZN.L',    fallbackYahooSymbol:'AZN', },  // NASDAQ dual-listed
  { ticker:'HSBA.L',   name:'HSBC Holdings',          sector:'Finance',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'HSBA.L',   fallbackYahooSymbol:'HSBC', },  // NYSE dual-listed
  { ticker:'ULVR.L',   name:'Unilever PLC',           sector:'Consumer',    type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'ULVR.L',   fallbackYahooSymbol:'UL', },  // NYSE dual-listed
  { ticker:'BP.L',     name:'BP PLC',                 sector:'Energy',      type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'BP.L',     fallbackYahooSymbol:'BP', },  // NYSE dual-listed
  { ticker:'GSK.L',    name:'GSK PLC',                sector:'Healthcare',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'GSK.L',    fallbackYahooSymbol:'GSK', },  // NYSE dual-listed
  { ticker:'RIO.L',    name:'Rio Tinto PLC',          sector:'Materials',   type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'RIO.L',    fallbackYahooSymbol:'RIO', },  // NYSE dual-listed
  { ticker:'VOD.L',    name:'Vodafone Group',         sector:'Technology',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'VOD.L',    fallbackYahooSymbol:'VOD', },  // NASDAQ dual-listed
  { ticker:'LLOY.L',   name:'Lloyds Banking Group',  sector:'Finance',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'LLOY.L',   fallbackYahooSymbol:'LYG', },  // NYSE ADR
  { ticker:'BARC.L',   name:'Barclays PLC',           sector:'Finance',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'BARC.L',   fallbackYahooSymbol:'BCS', },  // NYSE ADR
  { ticker:'DGE.L',    name:'Diageo PLC',             sector:'Consumer',    type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'DGE.L',    fallbackYahooSymbol:'DEO', },  // NYSE dual-listed
  { ticker:'RR.L',     name:'Rolls-Royce Holdings',  sector:'Defense',     type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'RR.L',     fallbackYahooSymbol:'RYCEY' },  // OTC ADR
  { ticker:'BT-A.L',   name:'BT Group',               sector:'Technology',  type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'BT-A.L',   fallbackYahooSymbol:'BT', },  // NYSE ADR
  { ticker:'GLEN.L',   name:'Glencore PLC',           sector:'Materials',   type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'GLEN.L',   fallbackYahooSymbol:'GLNCY' },  // OTC ADR
  { ticker:'NXT.L',    name:'Next PLC',               sector:'Consumer',    type:'STOCK', exchange:'LSE',  currency:'GBP', yahooSymbol:'NXT.L',    fallbackYahooSymbol:'XLY', },  // proxy: Consumer Discr ETF
];

// ── ETFs Sectoriales US (iShares SPDR) — sin fallback necesario
export const US_SECTOR_ETFS: UniverseAsset[] = [
  { ticker:'XLK',    name:'Technology Select Sector SPDR',    sector:'Technology',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLK', },
  { ticker:'XLE',    name:'Energy Select Sector SPDR',        sector:'Energy',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLE',   fallbackYahooSymbol:'VDE', },  // FIX v5: VDE (Vanguard Energy, fuera del universo)
  { ticker:'XLF',    name:'Financial Select Sector SPDR',     sector:'Finance',     type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLF', },
  { ticker:'XLV',    name:'Health Care Select Sector SPDR',   sector:'Healthcare',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLV', },
  { ticker:'XLI',    name:'Industrial Select Sector SPDR',    sector:'Industry',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLI', },
  { ticker:'XLP',    name:'Consumer Staples Select Sector',   sector:'Consumer',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLP', },
  { ticker:'XLY',    name:'Consumer Discr Select Sector SPDR',sector:'Consumer',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLY', },
  { ticker:'XLU',    name:'Utilities Select Sector SPDR',     sector:'Utilities',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLU', },
  { ticker:'XLB',    name:'Materials Select Sector SPDR',     sector:'Materials',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLB', },
  { ticker:'XLRE',   name:'Real Estate Select Sector SPDR',   sector:'Real Estate', type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLRE', },
  { ticker:'SOXX',   name:'iShares Semiconductor ETF',        sector:'Technology',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'SOXX', },
  { ticker:'IBB',    name:'iShares Biotechnology ETF',        sector:'Healthcare',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'IBB', },
  { ticker:'KRE',    name:'SPDR S&P Regional Bank ETF',       sector:'Finance',     type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'KRE', },
  { ticker:'GDXJ',   name:'VanEck Junior Gold Miners ETF',    sector:'Materials',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'GDXJ', },
  { ticker:'USO',    name:'United States Oil Fund',           sector:'Energy',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'USO', },
];

// ── Emerging Markets ex-China (RSX ELIMINADO — suspendido 2022)
export const EM_EX_CHINA: UniverseAsset[] = [
  { ticker:'INDA',   name:'iShares MSCI India ETF',           sector:'Emerging',    type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'INDA', },
  { ticker:'EPI',    name:'WisdomTree India Earnings Fund',   sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EPI', },
  { ticker:'EWT',    name:'iShares MSCI Taiwan ETF',          sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWT', },
  { ticker:'EWY',    name:'iShares MSCI South Korea ETF',     sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWY', },
  { ticker:'EWZ',    name:'iShares MSCI Brazil ETF',          sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWZ', },
  { ticker:'EWW',    name:'iShares MSCI Mexico ETF',          sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWW', },
  { ticker:'VNM',    name:'VanEck Vietnam ETF',               sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'VNM', },
  { ticker:'THD',    name:'iShares MSCI Thailand ETF',        sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'THD', },
  { ticker:'EPHE',   name:'iShares MSCI Philippines ETF',     sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EPHE', },
];

// ── Small Caps & Factor ETFs ─────────────────────────────────
export const FACTOR_ETFS: UniverseAsset[] = [
  { ticker:'IWM',    name:'iShares Russell 2000 ETF',         sector:'Small Cap',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'IWM', },
  { ticker:'SLYV',   name:'SPDR S&P 600 Small Cap Value ETF', sector:'Small Cap',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'SLYV', },
  { ticker:'AVUV',   name:'Avantis U.S. Small Cap Value ETF', sector:'Small Cap',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'AVUV', },
  { ticker:'MTUM',   name:'iShares MSCI USA Momentum ETF',    sector:'Factor',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'MTUM', },
  { ticker:'VLUE',   name:'iShares MSCI USA Value ETF',       sector:'Factor',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'VLUE', },
  { ticker:'QUAL',   name:'iShares MSCI USA Quality ETF',     sector:'Factor',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'QUAL', },
  { ticker:'USMV',   name:'iShares MSCI USA Min Vol ETF',     sector:'Factor',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'USMV', },
  { ticker:'TIP',    name:'iShares TIPS Bond ETF',            sector:'Fixed Income',type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'TIP', },
];

// ── Crypto ETPs ──────────────────────────────────────────────
export const CRYPTO_ETPS: UniverseAsset[] = [
  { ticker:'ETHE',   name:'Grayscale Ethereum Trust',         sector:'Crypto',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'ETHE', },
  { ticker:'BITO',   name:'ProShares Bitcoin Strategy ETF',   sector:'Crypto',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'BITO', },
];

// ── US Mega-caps — sin fallback (siempre disponibles en Yahoo)
export const US_STOCKS: UniverseAsset[] = [
  { ticker:'AAPL',     name:'Apple Inc.',             sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AAPL', },
  { ticker:'MSFT',     name:'Microsoft Corp.',        sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'MSFT', },
  { ticker:'NVDA',     name:'NVIDIA Corp.',           sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'NVDA', },
  { ticker:'AMZN',     name:'Amazon.com Inc.',        sector:'Consumer',    type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AMZN', },
  { ticker:'GOOGL',    name:'Alphabet Inc.',          sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'GOOGL' },
  { ticker:'META',     name:'Meta Platforms Inc.',    sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'META', },
  { ticker:'TSLA',     name:'Tesla Inc.',             sector:'Consumer',    type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'TSLA', },
  { ticker:'JPM',      name:'JPMorgan Chase',         sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'JPM', },
  { ticker:'V',        name:'Visa Inc.',              sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'V', },
  { ticker:'XOM',      name:'ExxonMobil Corp.',       sector:'Energy',      type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'XOM',   fallbackYahooSymbol:'CVX', },  // FIX v5: CVX (Chevron, fuera del universo)
  { ticker:'JNJ',      name:'Johnson & Johnson',      sector:'Healthcare',  type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'JNJ', },
  { ticker:'WMT',      name:'Walmart Inc.',           sector:'Consumer',    type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'WMT', },
  { ticker:'MA',       name:'Mastercard Inc.',        sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'MA', },
  { ticker:'BAC',      name:'Bank of America',        sector:'Finance',     type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'BAC', },
  { ticker:'PLTR',     name:'Palantir Technologies',  sector:'Technology',  type:'STOCK', exchange:'NYSE',   currency:'USD', yahooSymbol:'PLTR', },
  { ticker:'AMD',      name:'Advanced Micro Devices', sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AMD', },
  { ticker:'INTC',     name:'Intel Corporation',      sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'INTC', },
  { ticker:'SMCI',     name:'Super Micro Computer',   sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'SMCI', },
  { ticker:'COIN',     name:'Coinbase Global',        sector:'Finance',     type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'COIN', },
  { ticker:'MSTR',     name:'MicroStrategy Inc.',     sector:'Technology',  type:'STOCK', exchange:'NASDAQ', currency:'USD', yahooSymbol:'MSTR', },
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
