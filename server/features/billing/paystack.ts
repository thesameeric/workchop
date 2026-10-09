// Paystack's API, as billing uses it: a redirect checkout for the first payment (and card changes),
// charging the saved card for renewals and added seats, refunds and forgetting a card. Answers and
// errors are never logged whole: they carry card authorizations and customers' addresses.

const TIMEOUT_MS = 20_000;

/** A transaction as verify, charge_authorization and the charge.success webhook give it. */
export interface PaystackTx {
  id?: number | string;
  status?: string;
  reference?: string;
  amount?: number | string;
  requested_amount?: number | string;
  currency?: string;
  paid_at?: string | null;
  channel?: string;
  gateway_response?: string;
  /** 'approved' for checkout payments; null for charges of a saved card. */
  gateway_response_code?: string | null;
  fees?: number | string | null;
  /** An object, or a JSON string (or "" / 0 when there's none). */
  metadata?: unknown;
  authorization?: {
    authorization_code?: string;
    signature?: string;
    reusable?: boolean;
    channel?: string;
    brand?: string;
    card_type?: string;
    last4?: string;
    exp_month?: string | number;
    exp_year?: string | number;
    bank?: string;
  } | null;
  customer?: { email?: string; customer_code?: string } | null;
  /** charge_authorization: the bank wants the payer to confirm, at authorization_url. */
  paused?: boolean;
  authorization_url?: string;
}

/** Paystack couldn't be reached, or didn't answer in time: the result is unknown. */
export class PaystackUnreachable extends Error {}

/** Paystack refused the request (`status: false`), with its message and code. */
export class PaystackRefused extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export interface Paystack {
  initialize(body: Record<string, unknown>): Promise<{ authorization_url: string; reference: string }>;
  /** Null when Paystack has no transaction with this reference. */
  verify(reference: string): Promise<PaystackTx | null>;
  chargeAuthorization(body: Record<string, unknown>): Promise<PaystackTx>;
  refund(reference: string): Promise<void>;
  deactivate(authorizationCode: string): Promise<void>;
}

export function createPaystack(opts: { secretKey: string; apiBase: string; fetch?: typeof fetch }): Paystack {
  const fetchImpl = opts.fetch ?? fetch;

  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${opts.apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${opts.secretKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': 'Workchop' },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PaystackUnreachable((err as Error).name === 'TimeoutError' ? 'Paystack did not answer in time' : 'Paystack could not be reached');
    }
    const answer = (await res.json().catch(() => null)) as { status?: unknown; message?: unknown; code?: unknown; data?: unknown } | null;
    if (res.status >= 500 || res.status === 429 || !answer) throw new PaystackUnreachable(`Paystack answered ${res.status}`);
    if (!res.ok || answer.status !== true) {
      const message = typeof answer.message === 'string' ? answer.message.slice(0, 200) : `Paystack answered ${res.status}`;
      throw new PaystackRefused(res.status, message, typeof answer.code === 'string' ? answer.code : null);
    }
    return (answer.data ?? {}) as T;
  };

  return {
    async initialize(body) {
      const data = await call<{ authorization_url?: unknown; reference?: unknown }>('POST', '/transaction/initialize', body);
      if (typeof data.authorization_url !== 'string' || !/^https?:\/\//.test(data.authorization_url)) throw new PaystackUnreachable('Paystack gave no checkout address');
      return { authorization_url: data.authorization_url, reference: String(data.reference ?? '') };
    },
    async verify(reference) {
      try {
        return await call<PaystackTx>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      } catch (err) {
        // "Transaction reference not found" comes back as a 400 (or 404).
        if (err instanceof PaystackRefused && (err.httpStatus === 400 || err.httpStatus === 404)) return null;
        throw err;
      }
    },
    chargeAuthorization: (body) => call<PaystackTx>('POST', '/transaction/charge_authorization', body),
    async refund(reference) {
      await call('POST', '/refund', { transaction: reference });
    },
    async deactivate(authorizationCode) {
      await call('POST', '/customer/authorization/deactivate', { authorization_code: authorizationCode });
    },
  };
}

/** A transaction's metadata as an object (Paystack may send it as a JSON string). */
export function metadataOf(tx: PaystackTx): Record<string, unknown> {
  let m = tx.metadata;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      return {};
    }
  }
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}
