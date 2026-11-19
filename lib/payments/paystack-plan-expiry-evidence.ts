/**
 * Expiry evidence for a Waaiio plan billed by Paystack whose renewal was
 * stopped (#1135, M554). The subscription-renewal-recovery cron records the
 * result with record_reconciliation_evidence; expire_subscription_with_authority
 * expires the plan only on 'terminal_no_payment' for the exact period boundary.
 *
 * Fail closed: 'terminal_no_payment' only when Paystack, read with Waaiio's
 * platform key, says the subscription will not renew AND lists no paid invoice
 * on or after (period end - 24h), the same window the Flutterwave pass uses.
 * A paid invoice in that window means our period end did not move although a
 * payment exists, which needs a person: 'ambiguous'. Any read problem is
 * 'unavailable'; an active or retrying subscription is 'provider_active_or_retrying'.
 */

export type PaystackExpiryOutcome = 'terminal_no_payment' | 'provider_active_or_retrying' | 'ambiguous' | 'unavailable';

export interface PaystackExpiryEvidence {
  outcome: PaystackExpiryOutcome;
  providerStatus: string;
  invoiceCount: number;
  paidInWindow: number;
}

/** Paystack statuses that mean "will not charge again". */
const NOT_RENEWING = new Set(['cancelled', 'completed', 'non-renewing']);
/** Paystack statuses that mean it may still charge. */
const STILL_BILLING = new Set(['active', 'attention']);
const WINDOW_MS = 24 * 60 * 60 * 1000;

function isPaid(invoice: Record<string, unknown>): boolean {
  return invoice.status === 'success' || invoice.paid === true || invoice.paid === 1;
}

function invoiceTime(invoice: Record<string, unknown>): number | null {
  for (const key of ['paid_at', 'paidAt', 'created_at', 'createdAt', 'period_start']) {
    const value = invoice[key];
    if (typeof value === 'string' && value) {
      const time = Date.parse(value);
      if (Number.isFinite(time)) return time;
    }
  }
  return null;
}

export async function paystackPlanExpiryEvidence(subscriptionCode: string, periodEnd: string): Promise<PaystackExpiryEvidence> {
  const unavailable = (providerStatus: string): PaystackExpiryEvidence => ({ outcome: 'unavailable', providerStatus, invoiceCount: 0, paidInWindow: 0 });
  const key = process.env.PAYSTACK_SECRET_KEY || '';
  const periodEndMs = Date.parse(periodEnd);
  if (!key || !subscriptionCode || !Number.isFinite(periodEndMs)) return unavailable('unknown');

  let data: Record<string, unknown>;
  try {
    const response = await fetch(`https://api.paystack.co/subscription/${encodeURIComponent(subscriptionCode)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return unavailable(`http_${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (body.status !== true || !body.data || typeof body.data !== 'object') return unavailable('invalid_response');
    data = body.data as Record<string, unknown>;
  } catch {
    return unavailable('network_error');
  }

  const providerStatus = typeof data.status === 'string' ? data.status : '';
  if (STILL_BILLING.has(providerStatus)) return { outcome: 'provider_active_or_retrying', providerStatus, invoiceCount: 0, paidInWindow: 0 };
  if (!NOT_RENEWING.has(providerStatus)) return unavailable(providerStatus || 'unknown');

  if (data.invoices !== undefined && !Array.isArray(data.invoices)) return unavailable(providerStatus);
  const invoices = [...((data.invoices as Array<Record<string, unknown>> | undefined) || [])];
  if (data.most_recent_invoice && typeof data.most_recent_invoice === 'object') invoices.push(data.most_recent_invoice as Record<string, unknown>);

  let paidInWindow = 0;
  for (const invoice of invoices) {
    if (!invoice || typeof invoice !== 'object' || !isPaid(invoice)) continue;
    const time = invoiceTime(invoice);
    // A paid invoice with no readable date cannot be ruled out.
    if (time === null || time >= periodEndMs - WINDOW_MS) paidInWindow++;
  }
  return {
    outcome: paidInWindow > 0 ? 'ambiguous' : 'terminal_no_payment',
    providerStatus,
    invoiceCount: invoices.length,
    paidInWindow,
  };
}
