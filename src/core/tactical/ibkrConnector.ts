// src/core/tactical/ibkrConnector.ts
// Interactive Brokers Client Portal Web API – Conexión vía proxy serverless

export interface IBKRConfig {
  gatewayUrl: string;   // URL base del gateway (local en dev, /api/ibkr en prod)
  accountId: string;
  enabled: boolean;
}

// Determinar si estamos en desarrollo local o en producción (Vercel)
const isProduction = import.meta.env.PROD || import.meta.env.VERCEL === '1';

// En desarrollo: conectamos directamente a localhost:5000
// En producción: usamos el proxy serverless /api/ibkr
const DEV_GATEWAY = 'http://localhost:5000';
const PROD_GATEWAY = '/api/ibkr';  // Vercel redirige a la función serverless

export const DEFAULT_IBKR_CONFIG: IBKRConfig = {
  gatewayUrl: isProduction ? PROD_GATEWAY : DEV_GATEWAY,
  accountId: import.meta.env.VITE_IBKR_ACCOUNT_ID || 'U25387834',
  enabled: import.meta.env.VITE_IBKR_ENABLED === 'true' || !isProduction, // en dev siempre true
};

// ── Tipos de respuesta IBKR ───────────────────────────────────
export interface IBKRPosition {
  conid: number;
  contractDesc: string;
  position: number;
  mktPrice: number;
  mktValue: number;
  avgPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  currency: string;
  assetClass: string;
  ticker?: string;
}

export interface IBKROrder {
  orderId: number;
  conid: number;
  ticker: string;
  orderType: string;
  side: 'BUY' | 'SELL';
  totalSize: number;
  price?: number;
  status: string;
  timeInForce: string;
}

export interface IBKRMarketData {
  conid: number;
  '31'?: string;   // Last price
  '84'?: string;   // Bid
  '86'?: string;   // Ask
  '7295'?: string; // Open
  '7296'?: string; // Close (prev)
  '7762'?: string; // Volume
  lastUpdateTime?: string;
}

export interface IBKRAccountSummary {
  accountId: string;
  netliquidation: number;
  totalCashValue: number;
  buyingPower: number;
  equity: number;
  currency: string;
}

// ── Cliente IBKR ─────────────────────────────────────────────
export class IBKRClient {
  private config: IBKRConfig;
  private authenticated = false;

  constructor(config: IBKRConfig) {
    this.config = config;
  }

  private get base() {
    return this.config.gatewayUrl;
  }

  // Función fetch con manejo de cookies y errores
  private async req<T>(path: string, opts?: RequestInit): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts?.headers ?? {}),
      },
      credentials: 'include', // Necesario para mantener la sesión IBKR
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
      buyingPower: parseFloat(data.buyingpower?.amount ?? 0),
      equity: parseFloat(data.equitywithloanvalue?.amount ?? 0),
      currency: data.netliquidation?.currency ?? 'EUR',
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
    const fields = '31,84,86,7295,7296,7762';
    const data = await this.req<IBKRMarketData[]>(
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
    accountId: string,
    conid: number,
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number,
    ticker: string
  ): Promise<{ orderId: string; status: string; message?: string }> {
    const body = [
      {
        acctId: accountId,
        conid,
        orderType: 'LMT',
        side,
        quantity,
        price: price.toFixed(2),
        tif: 'GTC',
        listingExch: 'SMART',
      },
    ];

    const data = await this.req<any[]>(`/iserver/account/${accountId}/orders`, {
      method: 'POST',
      body: JSON.stringify({ orders: body }),
    });

    if (data?.[0]?.id) {
      const confirm = await this.req<any[]>(`/iserver/reply/${data[0].id}`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      });
      return {
        orderId: confirm?.[0]?.order_id ?? data[0].id,
        status: confirm?.[0]?.order_status ?? 'SUBMITTED',
        message: `${side} ${quantity} ${ticker} @ €${price}`,
      };
    }

    return {
      orderId: data?.[0]?.order_id ?? '',
      status: data?.[0]?.order_status ?? 'UNKNOWN',
      message: `${side} ${quantity} ${ticker} @ €${price}`,
    };
  }

  // ── Colocar orden de mercado ──────────────────────────────
  async placeMarketOrder(
    accountId: string,
    conid: number,
    side: 'BUY' | 'SELL',
    quantity: number,
    ticker: string
  ): Promise<{ orderId: string; status: string; message?: string }> {
    const body = [
      {
        acctId: accountId,
        conid,
        orderType: 'MKT',
        side,
        quantity,
        tif: 'DAY',
      },
    ];

    const data = await this.req<any[]>(`/iserver/account/${accountId}/orders`, {
      method: 'POST',
      body: JSON.stringify({ orders: body }),
    });

    if (data?.[0]?.id) {
      const confirm = await this.req<any[]>(`/iserver/reply/${data[0].id}`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      });
      return {
        orderId: confirm?.[0]?.order_id ?? '',
        status: confirm?.[0]?.order_status ?? 'SUBMITTED',
        message: `${side} MKT ${quantity} ${ticker}`,
      };
    }

    return { orderId: '', status: 'ERROR', message: 'No response from IBKR' };
  }

  // ── Cancelar orden ────────────────────────────────────────
  async cancelOrder(accountId: string, orderId: string): Promise<boolean> {
    try {
      await this.req(`/iserver/account/${accountId}/order/${orderId}`, { method: 'DELETE' });
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
export const KNOWN_CONIDS: Record<string, number> = {
  'BTC-EUR': 13977784,
  'IS3Q.DE': 107373649,
  'VVSM.DE': 354262162,
  'URNU.DE': 478170349,
  'EMXC.DE': 107373578,
  'PPFB.DE': 35271851,
  'XNAS.DE': 185844684,
  'QQQ': 320227571,
  'SPY': 756733,
  'GLD': 13399735,
  'SLV': 13399780,
  'URA': 95697706,
  'SMH': 99038698,
  'EEM': 22209243,
  'TLT': 22209460,
  'HYG': 22209447,
  'IWM': 9579970,
};