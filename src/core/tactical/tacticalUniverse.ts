// ============================================================
// src/core/tactical/tacticalUniverse.ts
// Universo UCITS — 100% comprable desde España (PRIIPs compliant)
// Sin ETFs americanos. Solo XETRA, Euronext y LSE.
// ============================================================

export interface UniverseAsset {
  ticker:      string;
  name:        string;
  sector:      string;
  type:        'ETF' | 'ETC' | 'CRYPTO' | 'INDEX';
  exchange:    string;
  currency:    'EUR' | 'USD' | 'GBP';
  yahooSymbol: string;
}

// ── Portfolio Olympus (siempre monitorizados) ─────────────────
export const OLYMPUS_ASSETS: UniverseAsset[] = [
  { ticker:'BTC-EUR',  name:'Bitcoin EUR',             sector:'Crypto',      type:'CRYPTO', exchange:'Crypto',     currency:'EUR', yahooSymbol:'BTC-EUR'  },
  { ticker:'IS3Q.DE',  name:'MSCI World Quality',      sector:'Equity',      type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'IS3Q.DE'  },
  { ticker:'VVSM.DE',  name:'VanEck Semiconductor',    sector:'Technology',  type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'VVSM.DE'  },
  { ticker:'URNU.DE',  name:'Global X Uranium',         sector:'Energy',      type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'URNU.DE'  },
  { ticker:'EMXC.DE',  name:'iShares MSCI EM ex-China',sector:'Emerging',    type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'EMXC.DE'  },
  { ticker:'PPFB.DE',  name:'iShares Physical Gold',    sector:'Commodities', type:'ETC',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'PPFB.DE'  },
  { ticker:'XNAS.DE',  name:'iShares NASDAQ 100 UCITS', sector:'Technology',  type:'ETF',    exchange:'XETRA',      currency:'EUR', yahooSymbol:'XNAS.DE'  },
];

// ── Sustitutos UCITS de los proxies americanos ────────────────
// Misma exposición que QQQ/SPY/GLD etc. pero comprable en España
export const UCITS_PROXIES: UniverseAsset[] = [
  // Índices amplios
  { ticker:'CSPX.AS',  name:'iShares Core S&P 500 UCITS',      sector:'Equity',      type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CSPX.AS'  },
  { ticker:'CNDX.AS',  name:'iShares Core NASDAQ 100 UCITS',    sector:'Technology',  type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'CNDX.AS'  },
  { ticker:'IWDA.AS',  name:'iShares Core MSCI World UCITS',    sector:'Equity',      type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'IWDA.AS'  },
  { ticker:'IUSN.DE',  name:'iShares MSCI World Small Cap',     sector:'Small Cap',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IUSN.DE'  },
  { ticker:'EIMI.AS',  name:'iShares Core MSCI EM UCITS',       sector:'Emerging',    type:'ETF', exchange:'EURONEXT', currency:'USD', yahooSymbol:'EIMI.AS'  },

  // Commodities / Materias primas
  { ticker:'SSLN.DE',  name:'iShares Physical Silver ETC',      sector:'Commodities', type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'SSLN.DE'  },
  { ticker:'4GLD.DE',  name:'Xetra-Gold ETC',                   sector:'Commodities', type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'4GLD.DE'  },
  { ticker:'OILG.DE',  name:'WisdomTree Crude Oil ETC',         sector:'Energy',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'OILG.DE'  },
  { ticker:'COPP.DE',  name:'WisdomTree Copper ETC',            sector:'Materials',   type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'COPP.DE'  },
  { ticker:'LNGG.DE',  name:'WisdomTree Natural Gas ETC',       sector:'Energy',      type:'ETC', exchange:'XETRA',    currency:'EUR', yahooSymbol:'LNGG.DE'  },

  // Renta fija
  { ticker:'DTLA.DE',  name:'iShares $ Treasury 20yr UCITS',    sector:'Fixed Income',type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DTLA.DE'  },
  { ticker:'IBTU.DE',  name:'iShares $ Corp Bond UCITS',        sector:'Fixed Income',type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IBTU.DE'  },

  // Sectoriales europeos (sustituyen XLF, XLE, XLK, XLV)
  { ticker:'EXV1.DE',  name:'iShares STOXX Eur 600 Oil&Gas',    sector:'Energy',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV1.DE'  },
  { ticker:'EXV3.DE',  name:'iShares STOXX Eur 600 Tech',       sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV3.DE'  },
  { ticker:'EXV4.DE',  name:'iShares STOXX Eur 600 Financials', sector:'Finance',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV4.DE'  },
  { ticker:'EXV6.DE',  name:'iShares STOXX Eur 600 Health Care',sector:'Healthcare',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV6.DE'  },
  { ticker:'EXV5.DE',  name:'iShares STOXX Eur 600 Utilities',  sector:'Utilities',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXV5.DE'  },
  { ticker:'EXH3.DE',  name:'iShares Core DAX UCITS',           sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'EXH3.DE'  },
  { ticker:'DBXD.DE',  name:'Xtrackers DAX UCITS',              sector:'Equity',      type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'DBXD.DE'  },

  // Temáticos UCITS
  { ticker:'GDX.DE',   name:'VanEck Gold Miners UCITS',         sector:'Commodities', type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'GDX.DE'   },
  { ticker:'IQQH.DE',  name:'iShares Global Clean Energy UCITS', sector:'Energy',     type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'IQQH.DE'  },
  { ticker:'ECAR.DE',  name:'iShares Electric Vehicles UCITS',  sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ECAR.DE'  },
  { ticker:'ARKY.DE',  name:'ARK Innovation UCITS',             sector:'Technology',  type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'ARKY.DE'  },
  { ticker:'LITG.DE',  name:'Global X Lithium Battery UCITS',   sector:'Materials',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'LITG.DE'  },
  { ticker:'COPX.DE',  name:'Global X Copper Miners UCITS',     sector:'Materials',   type:'ETF', exchange:'XETRA',    currency:'EUR', yahooSymbol:'COPX.DE'  },
];

// ── Universo completo UCITS ───────────────────────────────────
export const FULL_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...UCITS_PROXIES,
];

// ── Universo core para screener rápido (los más líquidos) ─────
export const CORE_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  // Los 15 UCITS con mayor volumen y señales más limpias
  ...UCITS_PROXIES.filter(a => [
    'CSPX.AS','CNDX.AS','IWDA.AS','EIMI.AS',
    'SSLN.DE','4GLD.DE','DTLA.DE',
    'EXV1.DE','EXV3.DE','EXV4.DE','EXV6.DE',
    'GDX.DE','IQQH.DE','IUSN.DE','ARKY.DE',
  ].includes(a.ticker)),
];
