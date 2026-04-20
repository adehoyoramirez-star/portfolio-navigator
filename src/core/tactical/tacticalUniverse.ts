// ============================================================
// src/core/tactical/tacticalUniverse.ts
// Universo de activos del motor táctico — 80 activos
// ETFs europeos + ETCs + Índices + Proxies americanos
// ============================================================

export interface UniverseAsset {
  ticker:    string;
  name:      string;
  sector:    string;
  type:      'ETF' | 'ETC' | 'CRYPTO' | 'INDEX';
  exchange:  string;
  currency:  'EUR' | 'USD';
  yahooSymbol: string;  // Símbolo para Yahoo Finance
}

// ── Portfolio Olympus (siempre monitorizados) ─────────────────
export const OLYMPUS_ASSETS: UniverseAsset[] = [
  { ticker:'BTC-EUR',  name:'Bitcoin EUR',           sector:'Crypto',      type:'CRYPTO', exchange:'Crypto',  currency:'EUR', yahooSymbol:'BTC-EUR'  },
  { ticker:'IS3Q.DE',  name:'MSCI World Quality',    sector:'Equity',      type:'ETF',    exchange:'XETRA',   currency:'EUR', yahooSymbol:'IS3Q.DE'  },
  { ticker:'VVSM.DE',  name:'Semiconductores',       sector:'Technology',  type:'ETF',    exchange:'XETRA',   currency:'EUR', yahooSymbol:'VVSM.DE'  },
  { ticker:'URNU.DE',  name:'Uranio Global',          sector:'Energy',      type:'ETF',    exchange:'XETRA',   currency:'EUR', yahooSymbol:'URNU.DE'  },
  { ticker:'EMXC.DE',  name:'Mercados Emergentes',   sector:'Emerging',    type:'ETF',    exchange:'XETRA',   currency:'EUR', yahooSymbol:'EMXC.DE'  },
  { ticker:'PPFB.DE',  name:'Oro (ETC)',              sector:'Commodities', type:'ETC',    exchange:'XETRA',   currency:'EUR', yahooSymbol:'PPFB.DE'  },
  { ticker:'XNAS.DE',  name:'NASDAQ 100',             sector:'Technology',  type:'ETF',    exchange:'XETRA',   currency:'EUR', yahooSymbol:'XNAS.DE'  },
];

// ── ETFs sectoriales europeos (XETRA) ────────────────────────
export const SECTOR_ETFS: UniverseAsset[] = [
  { ticker:'IQQH.DE',  name:'iShares Global Clean Energy', sector:'Energy',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IQQH.DE'  },
  { ticker:'ECAR.DE',  name:'iShares Electric Vehicles',   sector:'Technology', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'ECAR.DE'  },
  { ticker:'EXH3.DE',  name:'iShares Core DAX',            sector:'Equity',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXH3.DE'  },
  { ticker:'EXW1.DE',  name:'iShares Core MSCI World',     sector:'Equity',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXW1.DE'  },
  { ticker:'IUSN.DE',  name:'iShares MSCI World Small Cap',sector:'Equity',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IUSN.DE'  },
  { ticker:'DBXD.DE',  name:'Xtrackers DAX',               sector:'Equity',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'DBXD.DE'  },
  { ticker:'XDWD.DE',  name:'Xtrackers MSCI World',        sector:'Equity',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'XDWD.DE'  },
  { ticker:'IS3S.DE',  name:'iShares MSCI World Value',    sector:'Equity',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IS3S.DE'  },
  { ticker:'IWDA.AS',  name:'iShares Core MSCI World',     sector:'Equity',     type:'ETF', exchange:'EURONEXT',currency:'EUR',yahooSymbol:'IWDA.AS'  },
  { ticker:'CSPX.AS',  name:'iShares Core S&P 500',        sector:'Equity',     type:'ETF', exchange:'EURONEXT',currency:'USD',yahooSymbol:'CSPX.AS'  },
];

// ── ETFs temáticos de alta oportunidad ──────────────────────
export const THEMATIC_ETFS: UniverseAsset[] = [
  { ticker:'SXRV.DE',  name:'iShares S&P 500 IT',         sector:'Technology',  type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'SXRV.DE'  },
  { ticker:'EXV3.DE',  name:'iShares Stoxx Europe 600 IT',sector:'Technology',  type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV3.DE'  },
  { ticker:'EXV6.DE',  name:'iShares Stoxx Europe 600 HC',sector:'Healthcare',  type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV6.DE'  },
  { ticker:'EXV1.DE',  name:'iShares Stoxx Europe 600 Energy',sector:'Energy',  type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV1.DE'  },
  { ticker:'EXV4.DE',  name:'iShares Stoxx Europe 600 Fin',sector:'Finance',    type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV4.DE'  },
  { ticker:'EXV5.DE',  name:'iShares Stoxx Europe 600 Util',sector:'Utilities', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV5.DE'  },
  { ticker:'ISPA.DE',  name:'iShares S&P 500 Health Care', sector:'Healthcare', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'ISPA.DE'  },
  { ticker:'QDVE.DE',  name:'iShares S&P 500 Financials',  sector:'Finance',    type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'QDVE.DE'  },
  { ticker:'4GLD.DE',  name:'Xetra Gold',                  sector:'Commodities',type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'4GLD.DE'  },
  { ticker:'SLVR.DE',  name:'iShares Physical Silver',     sector:'Commodities',type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'SLVR.DE'  },
];

// ── ETCs de materias primas ──────────────────────────────────
export const COMMODITY_ETCS: UniverseAsset[] = [
  { ticker:'COPP.DE',  name:'WisdomTree Copper',           sector:'Commodities',type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'COPP.DE'  },
  { ticker:'AIGG.DE',  name:'WisdomTree Grains',           sector:'Commodities',type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'AIGG.DE'  },
  { ticker:'LNGG.DE',  name:'WisdomTree Natural Gas',      sector:'Energy',     type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'LNGG.DE'  },
  { ticker:'OILG.DE',  name:'WisdomTree Crude Oil',        sector:'Energy',     type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'OILG.DE'  },
];

// ── Proxies americanos (datos más ricos en Yahoo) ────────────
export const US_PROXIES: UniverseAsset[] = [
  { ticker:'QQQ',   name:'Invesco QQQ NASDAQ 100',  sector:'Technology',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'QQQ'   },
  { ticker:'SPY',   name:'SPDR S&P 500',             sector:'Equity',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'SPY'   },
  { ticker:'IWM',   name:'iShares Russell 2000',     sector:'Small Cap',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'IWM'   },
  { ticker:'XLF',   name:'SPDR Financial Select',    sector:'Finance',     type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLF'   },
  { ticker:'XLE',   name:'SPDR Energy Select',       sector:'Energy',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLE'   },
  { ticker:'XLK',   name:'SPDR Technology Select',   sector:'Technology',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLK'   },
  { ticker:'XLV',   name:'SPDR Health Care Select',  sector:'Healthcare',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLV'   },
  { ticker:'XLU',   name:'SPDR Utilities Select',    sector:'Utilities',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XLU'   },
  { ticker:'GLD',   name:'SPDR Gold Shares',         sector:'Commodities', type:'ETC', exchange:'NYSE',   currency:'USD', yahooSymbol:'GLD'   },
  { ticker:'SLV',   name:'iShares Silver Trust',     sector:'Commodities', type:'ETC', exchange:'NYSE',   currency:'USD', yahooSymbol:'SLV'   },
  { ticker:'USO',   name:'United States Oil Fund',   sector:'Energy',      type:'ETC', exchange:'NYSE',   currency:'USD', yahooSymbol:'USO'   },
  { ticker:'URA',   name:'Global X Uranium ETF',     sector:'Energy',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'URA'   },
  { ticker:'SMH',   name:'VanEck Semiconductor ETF', sector:'Technology',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'SMH'   },
  { ticker:'ARKK',  name:'ARK Innovation ETF',       sector:'Technology',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'ARKK'  },
  { ticker:'EEM',   name:'iShares MSCI Emerging',    sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EEM'   },
  { ticker:'EWZ',   name:'iShares MSCI Brazil',      sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWZ'   },
  { ticker:'FXI',   name:'iShares China Large-Cap',  sector:'Emerging',    type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'FXI'   },
  { ticker:'VNQ',   name:'Vanguard Real Estate',     sector:'Real Estate', type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'VNQ'   },
  { ticker:'HYG',   name:'iShares High Yield Bond',  sector:'Fixed Income',type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'HYG'   },
  { ticker:'TLT',   name:'iShares 20+ Year Treasury',sector:'Fixed Income',type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'TLT'   },
  { ticker:'GDX',   name:'VanEck Gold Miners',       sector:'Commodities', type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'GDX'   },
  { ticker:'GDXJ',  name:'VanEck Junior Gold Miners',sector:'Commodities', type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'GDXJ'  },
  { ticker:'COPX',  name:'Global X Copper Miners',   sector:'Materials',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'COPX'  },
  { ticker:'LIT',   name:'Global X Lithium & Battery',sector:'Materials',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'LIT'   },
];

// ── Universo completo ────────────────────────────────────────
export const FULL_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...SECTOR_ETFS,
  ...THEMATIC_ETFS,
  ...COMMODITY_ETCS,
  ...US_PROXIES,
];

// ── Universo reducido (solo para screener rápido) ────────────
export const CORE_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...THEMATIC_ETFS.slice(0, 6),
  ...COMMODITY_ETCS.slice(0, 2),
  ...US_PROXIES.slice(0, 12),
];
