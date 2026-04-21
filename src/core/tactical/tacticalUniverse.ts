// ============================================================
// src/core/tactical/tacticalUniverse.ts
// Universo de activos del motor táctico — 120 activos
//
// FILOSOFÍA DE SELECCIÓN:
// 1. Liquidez alta → datos limpios en Yahoo, spreads bajos
// 2. Volatilidad táctica → ATR > 1.5% diario para que haya edge
// 3. Baja correlación entre grupos → diversificación real de señales
// 4. Prioridad a proxies USD → Yahoo tiene datos más ricos y limpios
// 5. ETFs europeos solo si no hay proxy americano equivalente
//
// ESTRUCTURA DE BATCHES (para no saturar Supabase):
// CORE_TACTICAL_UNIVERSE  → 50 activos (scan rápido ~2 min)
// FULL_TACTICAL_UNIVERSE  → 120 activos (scan profundo ~8 min)
// ============================================================

export interface UniverseAsset {
  ticker:      string;
  name:        string;
  sector:      string;
  type:        'ETF' | 'ETC' | 'CRYPTO' | 'INDEX';
  exchange:    string;
  currency:    'EUR' | 'USD';
  yahooSymbol: string;
  // Volatilidad esperada: HIGH > 3% ATR diario, MED 1.5-3%, LOW < 1.5%
  volatility:  'HIGH' | 'MED' | 'LOW';
}

// ── 1. PORTFOLIO OLYMPUS (siempre en CORE) ───────────────────
// Monitorizados siempre para detectar añadir en dips
export const OLYMPUS_ASSETS: UniverseAsset[] = [
  { ticker:'BTC-EUR',  name:'Bitcoin EUR',        sector:'Crypto',      type:'CRYPTO', exchange:'Crypto',   currency:'EUR', yahooSymbol:'BTC-EUR',  volatility:'HIGH' },
  { ticker:'IS3Q.DE',  name:'MSCI World Quality', sector:'Equity',      type:'ETF',    exchange:'XETRA',    currency:'EUR', yahooSymbol:'IS3Q.DE',  volatility:'LOW'  },
  { ticker:'VVSM.DE',  name:'Semiconductores',    sector:'Technology',  type:'ETF',    exchange:'XETRA',    currency:'EUR', yahooSymbol:'VVSM.DE',  volatility:'MED'  },
  { ticker:'URNU.DE',  name:'Uranio Global',       sector:'Energy',      type:'ETF',    exchange:'XETRA',    currency:'EUR', yahooSymbol:'URNU.DE',  volatility:'HIGH' },
  { ticker:'EMXC.DE',  name:'Mercados Emergentes', sector:'Emerging',   type:'ETF',    exchange:'XETRA',    currency:'EUR', yahooSymbol:'EMXC.DE',  volatility:'MED'  },
  { ticker:'PPFB.DE',  name:'Oro (ETC)',           sector:'Commodities', type:'ETC',    exchange:'XETRA',    currency:'EUR', yahooSymbol:'PPFB.DE',  volatility:'MED'  },
  { ticker:'XNAS.DE',  name:'NASDAQ 100',          sector:'Technology',  type:'ETF',    exchange:'XETRA',    currency:'EUR', yahooSymbol:'XNAS.DE',  volatility:'MED'  },
];

// ── 2. ÍNDICES AMPLIOS USA (alta liquidez, datos perfectos) ──
// Mejor fuente de señales macro — siempre en CORE
export const US_BROAD: UniverseAsset[] = [
  { ticker:'SPY',  name:'SPDR S&P 500',          sector:'Equity',     type:'ETF', exchange:'NYSE',    currency:'USD', yahooSymbol:'SPY',  volatility:'MED'  },
  { ticker:'QQQ',  name:'Invesco NASDAQ 100',     sector:'Technology', type:'ETF', exchange:'NASDAQ',  currency:'USD', yahooSymbol:'QQQ',  volatility:'MED'  },
  { ticker:'IWM',  name:'iShares Russell 2000',   sector:'Small Cap',  type:'ETF', exchange:'NYSE',    currency:'USD', yahooSymbol:'IWM',  volatility:'MED'  },
  { ticker:'DIA',  name:'SPDR Dow Jones',          sector:'Equity',     type:'ETF', exchange:'NYSE',    currency:'USD', yahooSymbol:'DIA',  volatility:'LOW'  },
  { ticker:'MDY',  name:'SPDR S&P 400 Mid Cap',   sector:'Mid Cap',    type:'ETF', exchange:'NYSE',    currency:'USD', yahooSymbol:'MDY',  volatility:'MED'  },
  { ticker:'VT',   name:'Vanguard Total World',   sector:'Equity',     type:'ETF', exchange:'NYSE',    currency:'USD', yahooSymbol:'VT',   volatility:'LOW'  },
];

// ── 3. SECTORES USA (SPDR Select) — alta rotación táctica ───
// Los 11 sectores del S&P500. Clave para SECTOR_ROTATION
export const US_SECTORS: UniverseAsset[] = [
  { ticker:'XLK',  name:'Technology Select',      sector:'Technology',  type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLK',  volatility:'MED'  },
  { ticker:'XLF',  name:'Financial Select',       sector:'Finance',     type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLF',  volatility:'MED'  },
  { ticker:'XLE',  name:'Energy Select',          sector:'Energy',      type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLE',  volatility:'HIGH' },
  { ticker:'XLV',  name:'Health Care Select',     sector:'Healthcare',  type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLV',  volatility:'LOW'  },
  { ticker:'XLI',  name:'Industrial Select',      sector:'Industrial',  type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLI',  volatility:'MED'  },
  { ticker:'XLU',  name:'Utilities Select',       sector:'Utilities',   type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLU',  volatility:'LOW'  },
  { ticker:'XLP',  name:'Consumer Staples Select',sector:'Staples',     type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLP',  volatility:'LOW'  },
  { ticker:'XLY',  name:'Consumer Discret Select',sector:'Discretionary',type:'ETF',exchange:'NYSE', currency:'USD', yahooSymbol:'XLY',  volatility:'MED'  },
  { ticker:'XLB',  name:'Materials Select',       sector:'Materials',   type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLB',  volatility:'MED'  },
  { ticker:'XLRE', name:'Real Estate Select',     sector:'Real Estate', type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLRE', volatility:'MED'  },
  { ticker:'XLC',  name:'Communication Services', sector:'Telecom',     type:'ETF', exchange:'NYSE', currency:'USD', yahooSymbol:'XLC',  volatility:'MED'  },
];

// ── 4. TEMÁTICOS USA (alta volatilidad = más señales tácticas) ─
export const US_THEMATIC: UniverseAsset[] = [
  { ticker:'SMH',   name:'VanEck Semiconductors',   sector:'Technology',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'SMH',   volatility:'HIGH' },
  { ticker:'SOXX',  name:'iShares Semiconductors',  sector:'Technology',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'SOXX',  volatility:'HIGH' },
  { ticker:'ARKK',  name:'ARK Innovation',          sector:'Technology',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'ARKK',  volatility:'HIGH' },
  { ticker:'ARKG',  name:'ARK Genomics',            sector:'Healthcare',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'ARKG',  volatility:'HIGH' },
  { ticker:'WCLD',  name:'WisdomTree Cloud',        sector:'Technology',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'WCLD',  volatility:'HIGH' },
  { ticker:'AIQ',   name:'Global X AI & Tech',      sector:'Technology',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'AIQ',   volatility:'HIGH' },
  { ticker:'BOTZ',  name:'Global X Robotics & AI',  sector:'Technology',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'BOTZ',  volatility:'HIGH' },
  { ticker:'URA',   name:'Global X Uranium',        sector:'Energy',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'URA',   volatility:'HIGH' },
  { ticker:'ICLN',  name:'iShares Clean Energy',    sector:'Energy',      type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'ICLN',  volatility:'HIGH' },
  { ticker:'TAN',   name:'Invesco Solar',           sector:'Energy',      type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'TAN',   volatility:'HIGH' },
  { ticker:'HACK',  name:'ETFMG Cybersecurity',     sector:'Technology',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'HACK',  volatility:'HIGH' },
  { ticker:'IBB',   name:'iShares Biotech',         sector:'Healthcare',  type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'IBB',   volatility:'HIGH' },
  { ticker:'XBI',   name:'SPDR Biotech',            sector:'Healthcare',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'XBI',   volatility:'HIGH' },
  { ticker:'JETS',  name:'US Global Jets',          sector:'Industrial',  type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'JETS',  volatility:'HIGH' },
  { ticker:'ITB',   name:'iShares Home Construction',sector:'Real Estate',type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'ITB',   volatility:'HIGH' },
];

// ── 5. COMMODITIES & METALES (descorrelacionados, alta ATR) ──
export const COMMODITIES: UniverseAsset[] = [
  { ticker:'GLD',   name:'SPDR Gold Shares',        sector:'Commodities', type:'ETC', exchange:'NYSE',   currency:'USD', yahooSymbol:'GLD',   volatility:'MED'  },
  { ticker:'SLV',   name:'iShares Silver Trust',    sector:'Commodities', type:'ETC', exchange:'NYSE',   currency:'USD', yahooSymbol:'SLV',   volatility:'HIGH' },
  { ticker:'GDX',   name:'VanEck Gold Miners',      sector:'Commodities', type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'GDX',   volatility:'HIGH' },
  { ticker:'GDXJ',  name:'VanEck Junior Gold Miners',sector:'Commodities',type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'GDXJ',  volatility:'HIGH' },
  { ticker:'COPX',  name:'Global X Copper Miners',  sector:'Materials',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'COPX',  volatility:'HIGH' },
  { ticker:'LIT',   name:'Global X Lithium',        sector:'Materials',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'LIT',   volatility:'HIGH' },
  { ticker:'USO',   name:'United States Oil Fund',  sector:'Energy',      type:'ETC', exchange:'NYSE',   currency:'USD', yahooSymbol:'USO',   volatility:'HIGH' },
  { ticker:'UNG',   name:'US Natural Gas Fund',     sector:'Energy',      type:'ETC', exchange:'NYSE',   currency:'USD', yahooSymbol:'UNG',   volatility:'HIGH' },
  { ticker:'PALL',  name:'Aberdeen Palladium',      sector:'Commodities', type:'ETC', exchange:'NYSE',   currency:'USD', yahooSymbol:'PALL',  volatility:'HIGH' },
  { ticker:'PPLT',  name:'Aberdeen Platinum',       sector:'Commodities', type:'ETC', exchange:'NYSE',   currency:'USD', yahooSymbol:'PPLT',  volatility:'HIGH' },
];

// ── 6. RENTA FIJA & VOLATILIDAD (señales contrarian) ─────────
// Cuando bonds caen fuerte = oportunidad de rebote
export const FIXED_INCOME: UniverseAsset[] = [
  { ticker:'TLT',  name:'iShares 20Y+ Treasury',   sector:'Fixed Income', type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'TLT',  volatility:'MED'  },
  { ticker:'HYG',  name:'iShares High Yield',      sector:'Fixed Income', type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'HYG',  volatility:'MED'  },
  { ticker:'LQD',  name:'iShares Corp Bond',       sector:'Fixed Income', type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'LQD',  volatility:'LOW'  },
  { ticker:'EMB',  name:'iShares EM Bond USD',     sector:'Fixed Income', type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EMB',  volatility:'MED'  },
];

// ── 7. MERCADOS INTERNACIONALES (rotación geográfica) ────────
export const INTERNATIONAL: UniverseAsset[] = [
  { ticker:'EEM',  name:'iShares MSCI Emerging',   sector:'Emerging',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EEM',  volatility:'MED'  },
  { ticker:'EWZ',  name:'iShares MSCI Brazil',     sector:'Emerging',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWZ',  volatility:'HIGH' },
  { ticker:'FXI',  name:'iShares China Large-Cap', sector:'Emerging',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'FXI',  volatility:'HIGH' },
  { ticker:'EWJ',  name:'iShares MSCI Japan',      sector:'Equity',     type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWJ',  volatility:'MED'  },
  { ticker:'EWG',  name:'iShares MSCI Germany',    sector:'Equity',     type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWG',  volatility:'MED'  },
  { ticker:'EWU',  name:'iShares MSCI UK',         sector:'Equity',     type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWU',  volatility:'MED'  },
  { ticker:'INDA', name:'iShares MSCI India',      sector:'Emerging',   type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'INDA', volatility:'HIGH' },
  { ticker:'EWY',  name:'iShares MSCI South Korea',sector:'Emerging',   type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'EWY',  volatility:'HIGH' },
  { ticker:'MCHI', name:'iShares MSCI China',      sector:'Emerging',   type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'MCHI', volatility:'HIGH' },
  { ticker:'VNQ',  name:'Vanguard Real Estate',    sector:'Real Estate',type:'ETF', exchange:'NYSE',   currency:'USD', yahooSymbol:'VNQ',  volatility:'MED'  },
];

// ── 8. ETFs EUROPEOS (para operar en XETRA si IBKR conectado) ─
export const EU_ETFS: UniverseAsset[] = [
  { ticker:'EXH3.DE',  name:'iShares Core DAX',             sector:'Equity',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXH3.DE',  volatility:'MED'  },
  { ticker:'DBXD.DE',  name:'Xtrackers DAX',                sector:'Equity',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'DBXD.DE',  volatility:'MED'  },
  { ticker:'EXV3.DE',  name:'iShares Stoxx 600 IT',         sector:'Technology', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV3.DE',  volatility:'MED'  },
  { ticker:'EXV1.DE',  name:'iShares Stoxx 600 Energy',     sector:'Energy',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV1.DE',  volatility:'HIGH' },
  { ticker:'EXV4.DE',  name:'iShares Stoxx 600 Finance',    sector:'Finance',    type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV4.DE',  volatility:'MED'  },
  { ticker:'EXV6.DE',  name:'iShares Stoxx 600 Healthcare', sector:'Healthcare', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'EXV6.DE',  volatility:'LOW'  },
  { ticker:'IQQH.DE',  name:'iShares Global Clean Energy',  sector:'Energy',     type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'IQQH.DE',  volatility:'HIGH' },
  { ticker:'ECAR.DE',  name:'iShares Electric Vehicles',    sector:'Technology', type:'ETF', exchange:'XETRA', currency:'EUR', yahooSymbol:'ECAR.DE',  volatility:'HIGH' },
  { ticker:'4GLD.DE',  name:'Xetra Gold',                   sector:'Commodities',type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'4GLD.DE',  volatility:'MED'  },
  { ticker:'SLVR.DE',  name:'iShares Physical Silver',      sector:'Commodities',type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'SLVR.DE',  volatility:'HIGH' },
  { ticker:'COPP.DE',  name:'WisdomTree Copper',            sector:'Commodities',type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'COPP.DE',  volatility:'HIGH' },
  { ticker:'LNGG.DE',  name:'WisdomTree Natural Gas',       sector:'Energy',     type:'ETC', exchange:'XETRA', currency:'EUR', yahooSymbol:'LNGG.DE',  volatility:'HIGH' },
];

// ── 9. CRYPTO PROXIES (muy alta volatilidad, señales extremas) ─
export const CRYPTO_PROXIES: UniverseAsset[] = [
  { ticker:'IBIT',  name:'iShares Bitcoin Trust',   sector:'Crypto', type:'ETC', exchange:'NASDAQ', currency:'USD', yahooSymbol:'IBIT',  volatility:'HIGH' },
  { ticker:'FBTC',  name:'Fidelity Bitcoin ETF',    sector:'Crypto', type:'ETC', exchange:'NASDAQ', currency:'USD', yahooSymbol:'FBTC',  volatility:'HIGH' },
  { ticker:'MSTR',  name:'MicroStrategy',           sector:'Crypto', type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'MSTR',  volatility:'HIGH' },
  { ticker:'COIN',  name:'Coinbase Global',         sector:'Crypto', type:'ETF', exchange:'NASDAQ', currency:'USD', yahooSymbol:'COIN',  volatility:'HIGH' },
];

// ════════════════════════════════════════════════════════════
// UNIVERSOS DE SCAN
// ════════════════════════════════════════════════════════════

// ── CORE (50 activos) — scan rápido ~2 min ──────────────────
// Selección inteligente: prioriza HIGH volatility (más señales)
// + todos los Olympus + todos los sectores USA
export const CORE_TACTICAL_UNIVERSE: UniverseAsset[] = [
  // Olympus completo (7)
  ...OLYMPUS_ASSETS,
  // Índices amplios USA (6)
  ...US_BROAD,
  // 11 sectores USA completos — fuente principal de SECTOR_ROTATION (11)
  ...US_SECTORS,
  // Temáticos HIGH volatility (8 mejores)
  ...US_THEMATIC.filter(a => ['SMH','ARKK','URA','IBB','XBI','ICLN','AIQ','BOTZ'].includes(a.ticker)),
  // Commodities principales (5)
  ...COMMODITIES.filter(a => ['GLD','SLV','GDX','COPX','USO'].includes(a.ticker)),
  // Renta fija para señales contrarian (2)
  ...FIXED_INCOME.filter(a => ['TLT','HYG'].includes(a.ticker)),
  // Internacionales clave (5)
  ...INTERNATIONAL.filter(a => ['EEM','EWZ','FXI','INDA','MCHI'].includes(a.ticker)),
  // Crypto proxies regulados (2)
  ...CRYPTO_PROXIES.filter(a => ['IBIT','MSTR'].includes(a.ticker)),
  // ETFs europeos Olympus adicionales (4)
  ...EU_ETFS.filter(a => ['EXV1.DE','EXV3.DE','4GLD.DE','SLVR.DE'].includes(a.ticker)),
];

// ── FULL (120 activos) — scan profundo ~8 min ───────────────
// Usar solo cuando quieras máxima cobertura
// Recomendado: ejecutar 1 vez al día, no en cada sesión
export const FULL_TACTICAL_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS,
  ...US_BROAD,
  ...US_SECTORS,
  ...US_THEMATIC,
  ...COMMODITIES,
  ...FIXED_INCOME,
  ...INTERNATIONAL,
  ...EU_ETFS,
  ...CRYPTO_PROXIES,
];

// ── VOLATILE_ONLY (25 activos) — señales Blood/Momentum ─────
// Solo activos HIGH volatility — para detectar oportunidades
// extremas en mercados en pánico o momentum fuerte
export const VOLATILE_UNIVERSE: UniverseAsset[] = [
  ...OLYMPUS_ASSETS.filter(a => a.volatility === 'HIGH'),
  ...US_THEMATIC.filter(a => a.volatility === 'HIGH'),
  ...COMMODITIES.filter(a => a.volatility === 'HIGH'),
  ...INTERNATIONAL.filter(a => a.volatility === 'HIGH'),
  ...CRYPTO_PROXIES,
];
