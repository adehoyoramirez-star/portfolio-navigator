// ============================================================
// src/core/tactical/tacticalUniverse.ts
// Universo EUROPEO — XETRA + Euronext + Crypto EUR
// Solo activos negociables en IBKR Europa sin restricciones
// ============================================================

export interface UniverseAsset {
  ticker:      string;
  name:        string;
  sector:      string;
  type:        'ETF' | 'ETC' | 'CRYPTO' | 'INDEX';
  exchange:    string;
  currency:    'EUR' | 'USD';
  yahooSymbol: string;
  volatility:  'HIGH' | 'MED' | 'LOW';
}

// ── 1. PORTFOLIO OLYMPUS ─────────────────────────────────────
export const OLYMPUS_ASSETS: UniverseAsset[] = [
  { ticker:'BTC-EUR',  name:'Bitcoin EUR',           sector:'Crypto',     type:'CRYPTO', exchange:'Crypto', currency:'EUR', yahooSymbol:'BTC-EUR',  volatility:'HIGH' },
  { ticker:'IS3Q.DE',  name:'MSCI World Quality',    sector:'Equity',     type:'ETF',    exchange:'XETRA',  currency:'EUR', yahooSymbol:'IS3Q.DE',  volatility:'LOW'  },
  { ticker:'VVSM.DE',  name:'Semiconductores',       sector:'Technology', type:'ETF',    exchange:'XETRA',  currency:'EUR', yahooSymbol:'VVSM.DE',  volatility:'MED'  },
  { ticker:'URNU.DE',  name:'Uranio Global',          sector:'Energy',     type:'ETF',    exchange:'XETRA',  currency:'EUR', yahooSymbol:'URNU.DE',  volatility:'HIGH' },
  { ticker:'EMXC.DE',  name:'Mercados Emergentes',   sector:'Emerging',   type:'ETF',    exchange:'XETRA',  currency:'EUR', yahooSymbol:'EMXC.DE',  volatility:'MED'  },
  { ticker:'PPFB.DE',  name:'Oro (ETC)',              sector:'Commodities',type:'ETC',    exchange:'XETRA',  currency:'EUR', yahooSymbol:'PPFB.DE',  volatility:'MED'  },
  { ticker:'XNAS.DE',  name:'NASDAQ 100 EUR',         sector:'Technology', type:'ETF',    exchange:'XETRA',  currency:'EUR', yahooSymbol:'XNAS.DE',  volatility:'MED'  },
];

// ── 2. INDICES EUROPEOS AMPLIOS ──────────────────────────────
export const EU_BROAD: UniverseAsset[] = [
  { ticker:'EXH3.DE', name:'iShares Core DAX',           sector:'Equity',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXH3.DE', volatility:'MED' },
  { ticker:'DBXD.DE', name:'Xtrackers DAX',              sector:'Equity',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DBXD.DE', volatility:'MED' },
  { ticker:'EXW1.DE', name:'iShares Core MSCI World',    sector:'Equity',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXW1.DE', volatility:'LOW' },
  { ticker:'XDWD.DE', name:'Xtrackers MSCI World',       sector:'Equity',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'XDWD.DE', volatility:'LOW' },
  { ticker:'IUSN.DE', name:'iShares MSCI World SmallCap',sector:'Small Cap',type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IUSN.DE', volatility:'MED' },
  { ticker:'IS3S.DE', name:'iShares MSCI World Value',   sector:'Equity',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IS3S.DE', volatility:'LOW' },
  { ticker:'IWDA.AS', name:'iShares Core MSCI World AS', sector:'Equity',   type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'IWDA.AS', volatility:'LOW' },
  { ticker:'C6E.DE',  name:'iShares Core Euro Stoxx 50', sector:'Equity',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'C6E.DE',  volatility:'MED' },
];

// ── 3. SECTORES EUROPEOS (Stoxx 600) ────────────────────────
export const EU_SECTORS: UniverseAsset[] = [
  { ticker:'EXV3.DE', name:'iShares Stoxx 600 Technology',     sector:'Technology',   type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV3.DE', volatility:'MED'  },
  { ticker:'EXV4.DE', name:'iShares Stoxx 600 Banks',          sector:'Finance',      type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV4.DE', volatility:'HIGH' },
  { ticker:'EXV1.DE', name:'iShares Stoxx 600 Energy',         sector:'Energy',       type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV1.DE', volatility:'HIGH' },
  { ticker:'EXV6.DE', name:'iShares Stoxx 600 Healthcare',     sector:'Healthcare',   type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV6.DE', volatility:'LOW'  },
  { ticker:'EXV5.DE', name:'iShares Stoxx 600 Utilities',      sector:'Utilities',    type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV5.DE', volatility:'LOW'  },
  { ticker:'EXV2.DE', name:'iShares Stoxx 600 Telecom',        sector:'Telecom',      type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV2.DE', volatility:'MED'  },
  { ticker:'EXV8.DE', name:'iShares Stoxx 600 Industrials',    sector:'Industrial',   type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV8.DE', volatility:'MED'  },
  { ticker:'EXV7.DE', name:'iShares Stoxx 600 Basic Resources',sector:'Materials',    type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV7.DE', volatility:'HIGH' },
  { ticker:'EXV9.DE', name:'iShares Stoxx 600 Consumer Disc',  sector:'Discretionary',type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV9.DE', volatility:'MED'  },
  { ticker:'SXRV.DE', name:'iShares S&P 500 IT EUR',           sector:'Technology',   type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'SXRV.DE', volatility:'MED'  },
  { ticker:'ISPA.DE', name:'iShares S&P 500 Healthcare EUR',   sector:'Healthcare',   type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'ISPA.DE', volatility:'LOW'  },
  { ticker:'QDVE.DE', name:'iShares S&P 500 Financials EUR',   sector:'Finance',      type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'QDVE.DE', volatility:'MED'  },
];

// ── 4. TEMATICOS ALTA VOLATILIDAD ───────────────────────────
export const EU_THEMATIC: UniverseAsset[] = [
  { ticker:'IQQH.DE', name:'iShares Global Clean Energy',      sector:'Energy',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IQQH.DE', volatility:'HIGH' },
  { ticker:'ECAR.DE', name:'iShares Electric Vehicles',        sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ECAR.DE', volatility:'HIGH' },
  { ticker:'BATE.DE', name:'iShares Battery Tech',             sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'BATE.DE', volatility:'HIGH' },
  { ticker:'CYBR.DE', name:'L&G Cybersecurity EUR',            sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'CYBR.DE', volatility:'HIGH' },
  { ticker:'WTAI.DE', name:'WisdomTree AI EUR',                sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'WTAI.DE', volatility:'HIGH' },
  { ticker:'AERO.PA', name:'Lyxor Aerospace & Defence',        sector:'Industrial',  type:'ETF', exchange:'EURONEXT', currency:'EUR', yahooSymbol:'AERO.PA', volatility:'HIGH' },
  { ticker:'HEAL.DE', name:'L&G Healthcare Innovation EUR',    sector:'Healthcare',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'HEAL.DE', volatility:'HIGH' },
];

// ── 5. COMMODITIES EUROPEOS ──────────────────────────────────
export const EU_COMMODITIES: UniverseAsset[] = [
  { ticker:'4GLD.DE',  name:'Xetra Gold',                      sector:'Commodities', type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'4GLD.DE',  volatility:'MED'  },
  { ticker:'SLVR.DE',  name:'iShares Physical Silver EUR',      sector:'Commodities', type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'SLVR.DE',  volatility:'HIGH' },
  { ticker:'COPP.DE',  name:'WisdomTree Copper EUR',            sector:'Materials',   type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'COPP.DE',  volatility:'HIGH' },
  { ticker:'OILG.DE',  name:'WisdomTree Crude Oil EUR',         sector:'Energy',      type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'OILG.DE',  volatility:'HIGH' },
  { ticker:'LNGG.DE',  name:'WisdomTree Natural Gas EUR',       sector:'Energy',      type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'LNGG.DE',  volatility:'HIGH' },
  { ticker:'AIGG.DE',  name:'WisdomTree Grains EUR',            sector:'Commodities', type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'AIGG.DE',  volatility:'HIGH' },
  { ticker:'ZINC.DE',  name:'WisdomTree Zinc EUR',              sector:'Materials',   type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'ZINC.DE',  volatility:'HIGH' },
  { ticker:'PHPT.DE',  name:'WisdomTree Physical Platinum EUR', sector:'Commodities', type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'PHPT.DE',  volatility:'HIGH' },
];

// ── 6. RENTA FIJA EUROPEA ────────────────────────────────────
export const EU_FIXED_INCOME: UniverseAsset[] = [
  { ticker:'IBGL.DE', name:'iShares EUR Govt Bond 15-30yr', sector:'Fixed Income', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IBGL.DE', volatility:'MED' },
  { ticker:'IEAG.DE', name:'iShares EUR Aggregate Bond',    sector:'Fixed Income', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IEAG.DE', volatility:'LOW' },
  { ticker:'IHYG.DE', name:'iShares EUR High Yield Bond',   sector:'Fixed Income', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IHYG.DE', volatility:'MED' },
];

// ── 7. INTERNACIONALES DESDE EUROPA ─────────────────────────
export const EU_INTERNATIONAL: UniverseAsset[] = [
  { ticker:'IEMS.DE', name:'iShares Core MSCI EM IMI EUR', sector:'Emerging', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IEMS.DE', volatility:'MED'  },
  { ticker:'FXC.DE',  name:'iShares MSCI China EUR',       sector:'Emerging', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'FXC.DE',  volatility:'HIGH' },
  { ticker:'IIND.DE', name:'iShares MSCI India EUR',       sector:'Emerging', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IIND.DE', volatility:'HIGH' },
  { ticker:'IBZL.DE', name:'iShares MSCI Brazil EUR',      sector:'Emerging', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IBZL.DE', volatility:'HIGH' },
  { ticker:'IJPN.DE', name:'iShares Core MSCI Japan EUR',  sector:'Equity',   type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IJPN.DE', volatility:'MED'  },
];

// ── 8. MINEROS Y ENERGIA ALTERNATIVA ────────────────────────
export const EU_MINERS: UniverseAsset[] = [
  { ticker:'GDGB.DE', name:'VanEck Gold Miners EUR',        sector:'Commodities', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'GDGB.DE', volatility:'HIGH' },
  { ticker:'URNM.DE', name:'Sprott Uranium Miners EUR',     sector:'Energy',      type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'URNM.DE', volatility:'HIGH' },
  { ticker:'LITH.DE', name:'Global X Lithium & Battery EUR',sector:'Materials',   type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'LITH.DE', volatility:'HIGH' },
];

// ── 9. CRYPTO EUROPEO REGULADO ───────────────────────────────
export const EU_CRYPTO: UniverseAsset[] = [
  { ticker:'BTC-EUR', name:'Bitcoin EUR',               sector:'Crypto', type:'CRYPTO', exchange:'Crypto', currency:'EUR', yahooSymbol:'BTC-EUR', volatility:'HIGH' },
  { ticker:'ETH-EUR', name:'Ethereum EUR',              sector:'Crypto', type:'CRYPTO', exchange:'Crypto', currency:'EUR', yahooSymbol:'ETH-EUR', volatility:'HIGH' },
  { ticker:'BTCE.DE', name:'ETC Group Bitcoin ETP EUR', sector:'Crypto', type:'ETC',    exchange:'XETRA',  currency:'EUR', yahooSymbol:'BTCE.DE', volatility:'HIGH' },
];

// ════════════════════════════════════════════════════════════
// UNIVERSOS DE SCAN
// ════════════════════════════════════════════════════════════

// ── CORE (48 activos) ~2 min ─────────────────────────────────
export const CORE_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...EU_BROAD.filter(a => ['EXH3.DE','EXW1.DE','C6E.DE','IUSN.DE'].includes(a.ticker)),
  ...EU_SECTORS,
  ...EU_THEMATIC.filter(a => ['IQQH.DE','ECAR.DE','BATE.DE','CYBR.DE','AERO.PA'].includes(a.ticker)),
  ...EU_COMMODITIES.filter(a => ['4GLD.DE','SLVR.DE','COPP.DE','OILG.DE'].includes(a.ticker)),
  ...EU_FIXED_INCOME.filter(a => ['IBGL.DE','IHYG.DE'].includes(a.ticker)),
  ...EU_INTERNATIONAL.filter(a => ['IEMS.DE','FXC.DE','IIND.DE'].includes(a.ticker)),
  ...EU_MINERS,
  ...EU_CRYPTO.filter(a => ['BTC-EUR','BTCE.DE'].includes(a.ticker)),
];

// ── FULL (90 activos) ~7 min ─────────────────────────────────
export const FULL_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...EU_BROAD,
  ...EU_SECTORS,
  ...EU_THEMATIC,
  ...EU_COMMODITIES,
  ...EU_FIXED_INCOME,
  ...EU_INTERNATIONAL,
  ...EU_MINERS,
  ...EU_CRYPTO,
];

// ── VOLATILE (20 activos HIGH) ~1 min ────────────────────────
export const VOLATILE_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS.filter(a => a.volatility === 'HIGH'),
  ...EU_SECTORS.filter(a => a.volatility === 'HIGH'),
  ...EU_THEMATIC,
  ...EU_COMMODITIES.filter(a => a.volatility === 'HIGH'),
  ...EU_MINERS,
  ...EU_CRYPTO,
];
