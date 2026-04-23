// ============================================================
// src/core/tactical/tacticalUniverse.ts
// Universo UCITS — 100% comprable desde España (PRIIPs compliant)
// Más de 100 activos con fallback americano para datos
// ============================================================

export interface UniverseAsset {
  ticker:      string;
  name:        string;
  sector:      string;
  type:        'ETF' | 'ETC' | 'CRYPTO' | 'INDEX';
  exchange:    string;
  currency:    'EUR' | 'USD' | 'GBP';
  yahooSymbol: string;          // símbolo principal (UCITS)
  fallbackYahooSymbol?: string; // ETF americano equivalente si el UCITS falla
}

// ── Portfolio Olympus (siempre monitorizados) ─────────────────
export const OLYMPUS_ASSETS: UniverseAsset[] = [
  { ticker:'BTC-EUR',  name:'Bitcoin EUR',             sector:'Crypto',      type:'CRYPTO', exchange:'Crypto',     currency:'EUR', yahooSymbol:'BTC-EUR',  fallbackYahooSymbol:'BTC-USD' },
  { ticker:'IS3Q.DE',  name:'iShares MSCI World Quality', sector:'Equity',   type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'IS3Q.DE',  fallbackYahooSymbol:'URTH' },
  { ticker:'VVSM.DE',  name:'VanEck Semiconductor',    sector:'Technology',  type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'VVSM.DE',  fallbackYahooSymbol:'SMH' },
  { ticker:'URNU.DE',  name:'Global X Uranium',         sector:'Energy',      type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'URNU.DE',  fallbackYahooSymbol:'URA' },
  { ticker:'EMXC.DE',  name:'iShares MSCI EM ex-China',sector:'Emerging',    type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'EMXC.DE',  fallbackYahooSymbol:'EEM' },
  { ticker:'PPFB.DE',  name:'iShares Physical Gold',    sector:'Commodities', type:'ETC',   exchange:'XETRA',      currency:'EUR', yahooSymbol:'PPFB.DE',  fallbackYahooSymbol:'GLD' },
  { ticker:'XNAS.DE',  name:'iShares NASDAQ 100 UCITS', sector:'Technology',  type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'XNAS.DE',  fallbackYahooSymbol:'QQQ' },
];

// ── UCITS PROXIES: todos los ETFs UCITS con réplica americana ─
export const UCITS_PROXIES: UniverseAsset[] = [
  // ===== RENTA VARIABLE GLOBAL =====
  { ticker:'CSPX.AS',  name:'iShares Core S&P 500 UCITS',      sector:'Equity',      type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CSPX.AS',  fallbackYahooSymbol:'SPY' },
  { ticker:'CNDX.AS',  name:'iShares Core NASDAQ 100 UCITS',   sector:'Technology',  type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CNDX.AS',  fallbackYahooSymbol:'QQQ' },
  { ticker:'IWDA.AS',  name:'iShares Core MSCI World UCITS',   sector:'Equity',      type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'IWDA.AS',  fallbackYahooSymbol:'URTH' },
  { ticker:'IUSN.DE',  name:'iShares MSCI World Small Cap',    sector:'Small Cap',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IUSN.DE',  fallbackYahooSymbol:'IWM' },
  { ticker:'EIMI.AS',  name:'iShares Core MSCI EM UCITS',      sector:'Emerging',    type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EIMI.AS',  fallbackYahooSymbol:'EEM' },
  { ticker:'EMBE.AS',  name:'iShares JPM USD EM Bond UCITS',   sector:'Emerging Bonds', type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EMBE.AS', fallbackYahooSymbol:'EMB' },
  { ticker:'IWDA.L',   name:'iShares Core MSCI World UCITS (LSE)', sector:'Equity',  type:'ETF', exchange:'LSE',       currency:'GBP', yahooSymbol:'IWDA.L',   fallbackYahooSymbol:'URTH' },
  { ticker:'CSP1.L',   name:'iShares Core S&P 500 UCITS (LSE)', sector:'Equity',    type:'ETF', exchange:'LSE',       currency:'GBP', yahooSymbol:'CSP1.L',   fallbackYahooSymbol:'SPY' },

  // ===== EUROPA =====
  { ticker:'EXH3.DE',  name:'iShares Core DAX UCITS',          sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXH3.DE',  fallbackYahooSymbol:'EWG' },
  { ticker:'DBXD.DE',  name:'Xtrackers DAX UCITS',             sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DBXD.DE',  fallbackYahooSymbol:'DAX' },
  { ticker:'IMEA.AS',  name:'iShares Core MSCI Europe UCITS',  sector:'Equity',      type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'IMEA.AS',  fallbackYahooSymbol:'IEUR' },
  { ticker:'CEU1.DE',  name:'iShares MSCI Europe UCITS',       sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'CEU1.DE',  fallbackYahooSymbol:'IEUR' },
  { ticker:'XESX.DE',  name:'Xtrackers Euro Stoxx 50 UCITS',   sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'XESX.DE',  fallbackYahooSymbol:'FEZ' },
  { ticker:'EXSA.DE',  name:'iShares STOXX Europe 600 UCITS',  sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXSA.DE',  fallbackYahooSymbol:'STOXX' },
  { ticker:'MEUD.PA',  name:'Lyxor MSCI Europe UCITS',         sector:'Equity',      type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'MEUD.PA',  fallbackYahooSymbol:'IEUR' },
  { ticker:'SMEA.DE',  name:'iShares MSCI Europe SRI UCITS',   sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'SMEA.DE',  fallbackYahooSymbol:'IEUR' },

  // ===== NORTEAMÉRICA =====
  { ticker:'CS51.DE',  name:'iShares MSCI USA UCITS',          sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'CS51.DE',  fallbackYahooSymbol:'IUSA' },
  { ticker:'XD9U.DE',  name:'Xtrackers MSCI USA UCITS',        sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'XD9U.DE',  fallbackYahooSymbol:'IUSA' },

  // ===== ASIA / EMERGENTES =====
  { ticker:'IAPD.AS',  name:'iShares MSCI Pacific ex-Japan UCITS', sector:'Equity',  type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'IAPD.AS',  fallbackYahooSymbol:'EPP' },
  { ticker:'EMIN.AS',  name:'iShares MSCI India UCITS',        sector:'Emerging',    type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EMIN.AS',  fallbackYahooSymbol:'INDA' },
  { ticker:'CNYA.AS',  name:'iShares MSCI China A UCITS',      sector:'Emerging',    type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CNYA.AS',  fallbackYahooSymbol:'CNYA' },

  // ===== SECTORIALES EUROPEOS (STOXX 600) =====
  { ticker:'EXV1.DE',  name:'iShares STOXX Eur 600 Oil&Gas',   sector:'Energy',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV1.DE',  fallbackYahooSymbol:'XLE' },
  { ticker:'EXV3.DE',  name:'iShares STOXX Eur 600 Tech',      sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV3.DE',  fallbackYahooSymbol:'XLK' },
  { ticker:'EXV4.DE',  name:'iShares STOXX Eur 600 Financials',sector:'Finance',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV4.DE',  fallbackYahooSymbol:'XLF' },
  { ticker:'EXV6.DE',  name:'iShares STOXX Eur 600 Health Care',sector:'Healthcare',type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV6.DE',  fallbackYahooSymbol:'XLV' },
  { ticker:'EXV5.DE',  name:'iShares STOXX Eur 600 Utilities', sector:'Utilities',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV5.DE',  fallbackYahooSymbol:'XLU' },
  { ticker:'EXV2.DE',  name:'iShares STOXX Eur 600 Chemicals', sector:'Materials',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV2.DE',  fallbackYahooSymbol:'XLB' },
  { ticker:'EXV9.DE',  name:'iShares STOXX Eur 600 Food&Bev',  sector:'Consumer',    type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV9.DE',  fallbackYahooSymbol:'XLP' },
  { ticker:'EXV8.DE',  name:'iShares STOXX Eur 600 Telecom',   sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV8.DE',  fallbackYahooSymbol:'IXP' },

  // ===== COMMODITIES (ETCs) =====
  { ticker:'SSLN.DE',  name:'iShares Physical Silver ETC',     sector:'Commodities', type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'SSLN.DE',  fallbackYahooSymbol:'SLV' },
  { ticker:'4GLD.DE',  name:'Xetra-Gold ETC',                  sector:'Commodities', type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'4GLD.DE',  fallbackYahooSymbol:'GLD' },
  { ticker:'OILG.DE',  name:'WisdomTree Crude Oil ETC',        sector:'Energy',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'OILG.DE',  fallbackYahooSymbol:'USO' },
  { ticker:'COPP.DE',  name:'WisdomTree Copper ETC',           sector:'Materials',   type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'COPP.DE',  fallbackYahooSymbol:'CPER' },
  { ticker:'LNGG.DE',  name:'WisdomTree Natural Gas ETC',      sector:'Energy',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'LNGG.DE',  fallbackYahooSymbol:'UNG' },
  { ticker:'ALUM.DE',  name:'WisdomTree Aluminium ETC',        sector:'Materials',   type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ALUM.DE',  fallbackYahooSymbol:'JJU' },
  { ticker:'ZINC.DE',  name:'Xtrackers Zinc ETC',              sector:'Materials',   type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ZINC.DE',  fallbackYahooSymbol:'ZINC' },

  // ===== RENTA FIJA =====
  { ticker:'DTLA.DE',  name:'iShares $ Treasury 20yr UCITS',   sector:'Fixed Income',type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DTLA.DE',  fallbackYahooSymbol:'TLT' },
  { ticker:'IBTU.DE',  name:'iShares $ Corp Bond UCITS',       sector:'Fixed Income',type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IBTU.DE',  fallbackYahooSymbol:'HYG' },
  { ticker:'EMUE.DE',  name:'iShares EUR Govt Bond UCITS',     sector:'Fixed Income',type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EMUE.DE',  fallbackYahooSymbol:'BNDX' },
  { ticker:'IEGA.DE',  name:'iShares EUR Corporate Bond UCITS',sector:'Fixed Income',type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IEGA.DE',  fallbackYahooSymbol:'IBCX' },
  { ticker:'GLTL.AS',  name:'iShares Global Govt Bond UCITS',  sector:'Fixed Income',type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'GLTL.AS',  fallbackYahooSymbol:'IGVT' },
  { ticker:'IGLH.AS',  name:'iShares Global High Yield UCITS', sector:'Fixed Income',type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'IGLH.AS',  fallbackYahooSymbol:'GHYG' },

  // ===== TEMÁTICOS / MEGATENDENCIAS =====
  { ticker:'GDX.DE',   name:'VanEck Gold Miners UCITS',         sector:'Commodities', type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'GDX.DE',   fallbackYahooSymbol:'GDX' },
  { ticker:'IQQH.DE',  name:'iShares Global Clean Energy UCITS', sector:'Energy',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IQQH.DE',  fallbackYahooSymbol:'ICLN' },
  { ticker:'ECAR.DE',  name:'iShares Electric Vehicles UCITS',  sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ECAR.DE',  fallbackYahooSymbol:'DRIV' },
  { ticker:'ARKY.DE',  name:'ARK Innovation UCITS',             sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ARKY.DE',  fallbackYahooSymbol:'ARKK' },
  { ticker:'LITG.DE',  name:'Global X Lithium Battery UCITS',   sector:'Materials',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'LITG.DE',  fallbackYahooSymbol:'LIT' },
  { ticker:'COPX.DE',  name:'Global X Copper Miners UCITS',     sector:'Materials',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'COPX.DE',  fallbackYahooSymbol:'COPX' },
  { ticker:'IQHI.DE',  name:'iShares Global Healthcare UCITS',  sector:'Healthcare',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IQHI.DE',  fallbackYahooSymbol:'IXJ' },
  { ticker:'WFH.DE',   name:'Global X Telemedicine UCITS',      sector:'Healthcare',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'WFH.DE',   fallbackYahooSymbol:'EDOC' },
  { ticker:'CLOU.DE',  name:'Global X Cloud Computing UCITS',   sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'CLOU.DE',  fallbackYahooSymbol:'CLOU' },
  { ticker:'ESGB.DE',  name:'VanEck Video Gaming UCITS',        sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ESGB.DE',  fallbackYahooSymbol:'ESPO' },
  { ticker:'FINX.DE',  name:'Global X FinTech UCITS',           sector:'Finance',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'FINX.DE',  fallbackYahooSymbol:'FINX' },
  { ticker:'RBOT.DE',  name:'iShares Robotics & AI UCITS',      sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'RBOT.DE',  fallbackYahooSymbol:'BOTZ' },
  { ticker:'ISPY.DE',  name:'iShares Cybersecurity UCITS',      sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ISPY.DE',  fallbackYahooSymbol:'CIBR' },
  { ticker:'INRG.DE',  name:'iShares Global Clean Energy UCITS (LSE)', sector:'Energy', type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'INRG.DE',  fallbackYahooSymbol:'ICLN' },

  // ===== INTELIGENCIA ARTIFICIAL =====
  { ticker:'AI.DE',    name:'iShares S&P 500 AI & Robotics UCITS', sector:'Technology', type:'ETF', exchange:'XETRA',   currency:'EUR', yahooSymbol:'AI.DE',    fallbackYahooSymbol:'AIEQ' },
];

// ── Universo completo UCITS = 7 + proxies (ya incluidos) ──
export const FULL_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_PROXIES,
];

// ── CORE: 22 activos más líquidos ────────────────────────────
export const CORE_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_PROXIES.filter(a => [
    'CSPX.AS','CNDX.AS','IWDA.AS','EIMI.AS',
    'SSLN.DE','4GLD.DE','DTLA.DE',
    'EXV1.DE','EXV3.DE','EXV4.DE','EXV6.DE',
    'GDX.DE','IQQH.DE','IUSN.DE','ARKY.DE',
  ].includes(a.ticker)),
];

// ── VOLATILE: 17 activos de alta volatilidad ─────────────────
export const VOLATILE_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_PROXIES.filter(a => [
    'ARKY.DE','LITG.DE','OILG.DE','LNGG.DE',
    'GDX.DE','IQQH.DE','ECAR.DE','COPP.DE',
    'SSLN.DE','CNDX.AS',
  ].includes(a.ticker)),
];