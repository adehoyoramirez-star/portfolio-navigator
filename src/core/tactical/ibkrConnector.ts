// ============================================================
// src/core/tactical/ibkrConnector.ts
// Interactive Brokers Client Portal Web API
//
// PREREQUISITO: IBKR Gateway/TWS corriendo localmente
//
// Opción A (RECOMENDADA): IBKR TWS/Gateway nativo en Windows
//   1. Descarga: https://www.interactivebrokers.com/en/trading/ibgateway.php
//   2. Instala y ejecuta IBKR Gateway
//   3. Configura API: Settings → API → Settings
//      - Enable ActiveX and Socket EClients: ✓
//      - Socket port: 4001 (producción) o 4002 (paper)
//      - Allow connections from localhost only: ✓
//   4. El conector se conecta directamente al puerto 4001/4002
//
// Opción B: Client Portal Gateway (puerto 5000)
//   - Requiere Docker con imagen compatible
//   - Ver docker-compose.yml para configuración
//
// Account ID: U25387834
// Documentación: https://interactivebrokers.github.io/cpwebapi/
// ============================================================

export interface IBKRConfig {
  gatewayUrl:  string;  // default: 'http://localhost:5000'
  accountId:   string;  // Tu account ID de IBKR
  enabled:     boolean;
}

export const DEFAULT_IBKR_CONFIG: IBKRConfig = {
  gatewayUrl: 'http://localhost:5000',  // Client Portal API (puerto 5000)
                                         // o 'http://localhost:4001' para TWS Socket API
  accountId:  'U25387834',  // Interactive Brokers account ID
  enabled:    false,        // Deshabilitado por defecto hasta configurar IBKR Gateway
};

// ── Tipos de respuesta IBKR ───────────────────────────────────
export interface IBKRPosition {
  conid:          number;
  contractDesc:   string;
  position:       number;
  mktPrice:       number;
  mktValue:       number;
  avgPrice:       number;
  unrealizedPnl:  number;
  realizedPnl:    number;
  currency:       string;
  assetClass:     string;
  ticker?:        string;
}

export interface IBKROrder {
  orderId:     number;
  conid:       number;
  ticker:      string;
  orderType:   string;
  side:        'BUY' | 'SELL';
  totalSize:   number;
  price?:      number;
  status:      string;
  timeInForce: string;
}

export interface IBKRMarketData {
  conid:           number;
  '31'?:           string;  // Last price
  '84'?:           string;  // Bid
  '86'?:           string;  // Ask
  '7295'?:         string;  // Open
  '7296'?:         string;  // Close (prev)
  '7762'?:         string;  // Volume
  lastUpdateTime?: string;
}

export interface IBKRAccountSummary {
  accountId:       string;
  netliquidation:  number;
  totalCashValue:  number;
  buyingPower:     number;
  equity:          number;
  currency:        string;
}

// ── Cliente IBKR ─────────────────────────────────────────────
export class IBKRClient {
  private config: IBKRConfig;
  private authenticated = false;

  constructor(config: IBKRConfig) {
    this.config = config;
  }

  private get base() { return this.config.gatewayUrl; }

  // Fetch con CORS — el gateway corre en localhost, mismo origen si se
  // hace desde Vite dev server. En prod necesita proxy Nginx/Vercel.
  private async req<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}/v1/api${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts?.headers ?? {}),
      },
      credentials: 'include', // Necesario para la cookie de sesión IBKR
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`IBKR API ${res.status}: ${err}`);
    }
    return res.json() as T;
  }

  // ── Verificar conexión ────────────────────────────────────
  async checkAuth(): Promise<boolean> {
    try {
      const data = await this.req<{ authenticated: boolean }>('/iserver/auth/status');
      this.authenticated = data.authenticated;
      return this.authenticated;
    } catch {
      return false;
    }
  }

  // ── Re-autenticar sesión ──────────────────────────────────
  async tickle(): Promise<void> {
    await this.req('/tickle', { method: 'POST' }).catch(() => {});
  }

  // ── Obtener cuentas ───────────────────────────────────────
  async getAccounts(): Promise<string[]> {
    const data = await this.req<{ accounts: string[] }>('/portfolio/accounts');
    return data.accounts ?? [];
  }

  // ── Resumen de cuenta ─────────────────────────────────────
  async getAccountSummary(accountId: string): Promise<IBKRAccountSummary> {
    const data = await this.req<any>(`/portfolio/${accountId}/summary`);
    return {
      accountId,
      netliquidation: parseFloat(data.netliquidation?.amount ?? 0),
      totalCashValue: parseFloat(data.totalcashvalue?.amount ?? 0),
      buyingPower:    parseFloat(data.buyingpower?.amount ?? 0),
      equity:         parseFloat(data.equitywithloanvalue?.amount ?? 0),
      currency:       data.netliquidation?.currency ?? 'EUR',
    };
  }

  // ── Posiciones abiertas ───────────────────────────────────
  async getPositions(accountId: string): Promise<IBKRPosition[]> {
    const data = await this.req<IBKRPosition[]>(`/portfolio/${accountId}/positions/0`);
    return data ?? [];
  }

  // ── Buscar contrato por ticker ────────────────────────────
  async searchContract(symbol: string): Promise<{ conid: number; description: string } | null> {
    try {
      const data = await this.req<any[]>(`/iserver/secdef/search?symbol=${symbol}&name=false&secType=STK`);
      if (!data?.length) return null;
      return { conid: data[0].conid, description: data[0].description };
    } catch {
      return null;
    }
  }

  // ── Precio en tiempo real ─────────────────────────────────
  async getMarketData(conids: number[]): Promise<IBKRMarketData[]> {
    const fields = '31,84,86,7295,7296,7762'; // Last, bid, ask, open, close, volume
    const data   = await this.req<IBKRMarketData[]>(
      `/iserver/marketdata/snapshot?conids=${conids.join(',')}&fields=${fields}`
    );
    return data ?? [];
  }

  // ── Órdenes pendientes ────────────────────────────────────
  async getOrders(): Promise<IBKROrder[]> {
    const data = await this.req<{ orders: IBKROrder[] }>('/iserver/account/orders');
    return data.orders ?? [];
  }

  // ── Colocar orden límite ──────────────────────────────────
  async placeLimitOrder(
    accountId:   string,
    conid:       number,
    side:        'BUY' | 'SELL',
    quantity:    number,
    price:       number,
    ticker:      string,
  ): Promise<{ orderId: string; status: string; message?: string }> {
    const body = [{
      acctId:      accountId,
      conid,
      orderType:   'LMT',
      side,
      quantity,
      price:       price.toFixed(2),
      tif:         'GTC',  // Good Till Cancelled
      listingExch: 'SMART',
    }];

    const data = await this.req<any[]>(
      `/iserver/account/${accountId}/orders`,
      { method: 'POST', body: JSON.stringify({ orders: body }) }
    );

    // La primera respuesta de IBKR suele ser una confirmación (reply needed)
    if (data?.[0]?.id) {
      // Confirmar orden automáticamente
      const confirm = await this.req<any[]>(
        `/iserver/reply/${data[0].id}`,
        { method: 'POST', body: JSON.stringify({ confirmed: true }) }
      );
      return {
        orderId: confirm?.[0]?.order_id ?? data[0].id,
        status:  confirm?.[0]?.order_status ?? 'SUBMITTED',
        message: `${side} ${quantity} ${ticker} @ €${price}`,
      };
    }

    return {
      orderId: data?.[0]?.order_id ?? '',
      status:  data?.[0]?.order_status ?? 'UNKNOWN',
      message: `${side} ${quantity} ${ticker} @ €${price}`,
    };
  }

  // ── Colocar orden de mercado ──────────────────────────────
  async placeMarketOrder(
    accountId:  string,
    conid:      number,
    side:       'BUY' | 'SELL',
    quantity:   number,
    ticker:     string,
  ): Promise<{ orderId: string; status: string; message?: string }> {
    const body = [{
      acctId:   accountId,
      conid,
      orderType:'MKT',
      side,
      quantity,
      tif:      'DAY',
    }];

    const data = await this.req<any[]>(
      `/iserver/account/${accountId}/orders`,
      { method: 'POST', body: JSON.stringify({ orders: body }) }
    );

    if (data?.[0]?.id) {
      const confirm = await this.req<any[]>(
        `/iserver/reply/${data[0].id}`,
        { method: 'POST', body: JSON.stringify({ confirmed: true }) }
      );
      return {
        orderId: confirm?.[0]?.order_id ?? '',
        status:  confirm?.[0]?.order_status ?? 'SUBMITTED',
        message: `${side} MKT ${quantity} ${ticker}`,
      };
    }

    return { orderId: '', status: 'ERROR', message: 'No response from IBKR' };
  }

  // ── Cancelar orden ────────────────────────────────────────
  async cancelOrder(accountId: string, orderId: string): Promise<boolean> {
    try {
      await this.req(
        `/iserver/account/${accountId}/order/${orderId}`,
        { method: 'DELETE' }
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Historial de trades ───────────────────────────────────
  async getTrades(): Promise<any[]> {
    try {
      const data = await this.req<any[]>('/iserver/account/trades');
      return data ?? [];
    } catch {
      return [];
    }
  }
}

// ── Instancia singleton del cliente ──────────────────────────
let _client: IBKRClient | null = null;

export function getIBKRClient(config: IBKRConfig): IBKRClient {
  if (!_client || _client['config'] !== config) {
    _client = new IBKRClient(config);
  }
  return _client;
}

// ── Mapa de tickers a conids de IBKR ─────────────────────────
// Conids de los activos más comunes — se cachean tras la primera búsqueda
export const KNOWN_CONIDS: Record<string, number> = {
  'BTC-EUR':  13977784,  // Bitcoin
  'IS3Q.DE':  107373649, // iShares MSCI World Quality
  'VVSM.DE':  354262162, // VanEck Semiconductor
  'URNU.DE':  478170349, // Global X Uranium
  'EMXC.DE':  107373578, // iShares EM ex-China
  'PPFB.DE':  35271851,  // iShares Physical Gold
  'XNAS.DE':  185844684, // iShares NASDAQ 100
  'QQQ':      320227571,
  'SPY':      756733,
  'GLD':      13399735,
  'SLV':      13399780,
  'URA':      95697706,
  'SMH':      99038698,
  'EEM':      22209243,
  'TLT':      22209460,
  'HYG':      22209447,
  'IWM':      9579970,
};
