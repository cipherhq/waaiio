/**
 * Provider verification adapters — READ-ONLY.
 *
 * Each adapter calls the provider API and returns a normalized
 * VerifiedPaymentResult WITHOUT mutating Waaiio business state.
 *
 * Credential resolution uses the payment's stored metadata to
 * select the exact connection context that created the transaction.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import type { VerifiedPaymentResult, PaymentProviderName } from './authority';

/** Outcome from attempting provider verification. */
export type ProviderVerificationOutcome =
  | { status: 'verified'; result: VerifiedPaymentResult }
  | { status: 'not_paid'; reason: string }
  | { status: 'retryable_error'; reason: string }
  | { status: 'config_error'; reason: string };

/** Explicit payment origin — how the provider transaction was created. */
export type PaymentOrigin = 'platform' | 'byo' | 'connect';

/** Credential context resolved from the payment's stored connection identity. */
interface ResolvedCredential {
  secretKey: string;
  connectAccountId?: string;
  isByo: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Credential resolution (payment-scoped)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the exact credential context for a payment based on its stored metadata.
 * Returns null if credential cannot be resolved (fail closed).
 */
async function resolvePaystackCredential(
  supabase: SupabaseClient,
  paymentMeta: Record<string, unknown>,
  paymentBusinessId: string | null,
): Promise<ResolvedCredential | null> {
  const origin = resolvePaymentOrigin(paymentMeta);

  if (origin === 'byo') {
    const connectionId = paymentMeta.provider_connection_id as string | undefined;
    const byoBusinessId = paymentMeta.byo_business_id as string | undefined;

    if (!connectionId && !byoBusinessId) return null;

    // Prefer exact connection row ID (rotation-safe)
    // Fall back to business_id+gateway only for legacy BYO payments without connection ID
    const query = connectionId
      ? supabase.from('business_payment_credentials').select('id, business_id, secret_key, gateway').eq('id', connectionId).maybeSingle()
      : supabase.from('business_payment_credentials').select('id, business_id, secret_key, gateway').eq('business_id', byoBusinessId!).eq('gateway', 'paystack').eq('is_active', true).not('verified_at', 'is', null).maybeSingle();

    const { data: cred, error } = await query;
    if (error || !cred?.secret_key) return null;

    // Validate ownership: credential business must match payment business
    if (paymentBusinessId && cred.business_id !== paymentBusinessId) return null;
    // Validate gateway match
    if (cred.gateway !== 'paystack') return null;

    try {
      const { decryptToken } = await import('@/lib/encryption');
      return { secretKey: decryptToken(cred.secret_key), isByo: true };
    } catch {
      return null;
    }
  }

  if (origin === 'connect') {
    const connectAccountId = paymentMeta.connect_account_id as string | undefined;
    if (!connectAccountId) return null;
    const platformKey = process.env.PAYSTACK_SECRET_KEY;
    if (!platformKey) return null;
    return { secretKey: platformKey, connectAccountId, isByo: false };
  }

  // Platform mode (origin === 'platform' or legacy null with inferred platform)
  const platformKey = process.env.PAYSTACK_SECRET_KEY;
  if (!platformKey) return null;
  return { secretKey: platformKey, isByo: false };
}

async function resolveStripeCredential(
  paymentMeta: Record<string, unknown>,
): Promise<ResolvedCredential | null> {
  const isConnect = paymentMeta.connect === true;
  const connectAccountId = paymentMeta.connect_account_id as string | undefined;

  const platformKey = process.env.STRIPE_SECRET_KEY;
  if (!platformKey) return null;

  if (isConnect && connectAccountId) {
    return { secretKey: platformKey, connectAccountId, isByo: false };
  }
  return { secretKey: platformKey, isByo: false };
}

async function resolveFlutterwaveCredential(
  supabase: SupabaseClient,
  paymentMeta: Record<string, unknown>,
  paymentBusinessId: string | null,
): Promise<ResolvedCredential | null> {
  const origin = resolvePaymentOrigin(paymentMeta);

  if (origin === 'byo') {
    const connectionId = paymentMeta.provider_connection_id as string | undefined;
    const byoBusinessId = paymentMeta.byo_business_id as string | undefined;
    if (!connectionId && !byoBusinessId) return null;

    const query = connectionId
      ? supabase.from('business_payment_credentials').select('id, business_id, secret_key, gateway').eq('id', connectionId).maybeSingle()
      : supabase.from('business_payment_credentials').select('id, business_id, secret_key, gateway').eq('business_id', byoBusinessId!).eq('gateway', 'flutterwave').eq('is_active', true).not('verified_at', 'is', null).maybeSingle();

    const { data: cred, error } = await query;
    if (error || !cred?.secret_key) return null;
    if (paymentBusinessId && cred.business_id !== paymentBusinessId) return null;
    if (cred.gateway !== 'flutterwave') return null;

    try {
      const { decryptToken } = await import('@/lib/encryption');
      return { secretKey: decryptToken(cred.secret_key), isByo: true };
    } catch {
      return null;
    }
  }

  const platformKey = process.env.FLUTTERWAVE_SECRET_KEY || process.env.FLW_SECRET_KEY;
  if (!platformKey) return null;
  return { secretKey: platformKey, isByo: false };
}

async function resolveSquareCredential(
  supabase: SupabaseClient,
  paymentMeta: Record<string, unknown>,
  businessId: string | null,
): Promise<ResolvedCredential | null> {
  const origin = resolvePaymentOrigin(paymentMeta);
  const connectionId = paymentMeta.provider_connection_id as string | undefined;

  if (origin === 'connect' || (origin === null && businessId)) {
    // Merchant OAuth — load exact connection by ID if available, else by business
    const query = connectionId
      ? supabase.from('payout_accounts').select('id, business_id, access_token').eq('id', connectionId).maybeSingle()
      : businessId
        ? supabase.from('payout_accounts').select('id, business_id, access_token').eq('business_id', businessId).eq('provider', 'square').eq('is_active', true).maybeSingle()
        : null;

    if (query) {
      const { data: payoutAccount, error } = await query;
      if (!error && payoutAccount?.access_token) {
        if (businessId && payoutAccount.business_id !== businessId) return null;
        try {
          const { decryptToken } = await import('@/lib/encryption');
          return { secretKey: decryptToken(payoutAccount.access_token), isByo: false };
        } catch {
          return null;
        }
      }
    }
    // If merchant connection not found and origin was explicitly 'connect', fail closed
    if (origin === 'connect') return null;
  }

  // Platform mode (origin === 'platform' or legacy null without merchant connection)
  const platformToken = process.env.SQUARE_ACCESS_TOKEN;
  if (!platformToken) return null;
  return { secretKey: platformToken, isByo: false };
}

function resolvePaypalCredential(): ResolvedCredential | null {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  // PayPal uses client_id + client_secret for OAuth token
  return { secretKey: `${clientId}:${clientSecret}`, isByo: false };
}

// ────────────────────────────────────────────────────────────────────────────
// Provider-specific READ-ONLY verification
// ────────────────────────────────────────────────────────────────────────────

/**
 * Verify a payment with the appropriate provider.
 * Returns normalized VerifiedPaymentResult or failure reason.
 * Does NOT mutate Waaiio business/payment state.
 */
/**
 * Determine the explicit payment origin from metadata.
 * New-authority payments (payment_authority_version=1) MUST have an explicit origin.
 */
const VALID_ORIGINS = new Set<string>(['platform', 'byo', 'connect']);

export function resolvePaymentOrigin(meta: Record<string, unknown>): PaymentOrigin | null {
  const explicit = meta.payment_origin as string | undefined;
  if (explicit && VALID_ORIGINS.has(explicit)) return explicit as PaymentOrigin;
  if (explicit) return null; // Unknown origin string → fail closed
  // Infer from legacy metadata fields (backward compat for pre-authority payments)
  if (meta.byo === true) return 'byo';
  if (meta.connect === true) return 'connect';
  return null;
}

export async function verifyWithProvider(
  supabase: SupabaseClient,
  opts: {
    provider: PaymentProviderName;
    gatewayReference: string;
    expectedAmount: number;
    expectedCurrency: string;
    paymentMetadata: Record<string, unknown>;
    businessId: string | null;
    isNewAuthority: boolean;
  },
): Promise<ProviderVerificationOutcome> {
  const { provider, gatewayReference, expectedAmount, expectedCurrency, paymentMetadata, businessId, isNewAuthority } = opts;

  // Mock mode (non-production without credentials)
  if (gatewayReference.startsWith('mock_')) {
    if (process.env.NODE_ENV === 'production') {
      return { status: 'config_error', reason: 'mock_reference_in_production' };
    }
    return {
      status: 'verified',
      result: {
        provider, waaiioReference: gatewayReference, amount: expectedAmount,
        currency: expectedCurrency, verifiedAt: new Date().toISOString(),
        providerStatus: 'mock_success',
      },
    };
  }

  // For new-authority payments, require explicit valid origin
  const origin = resolvePaymentOrigin(paymentMetadata);
  if (isNewAuthority && !origin) {
    return { status: 'config_error', reason: 'missing_payment_origin' };
  }
  // New-authority BYO/connect must have exact provider_connection_id (no fallback to current-active)
  if (isNewAuthority && (origin === 'byo' || origin === 'connect') && !paymentMetadata.provider_connection_id) {
    return { status: 'config_error', reason: 'missing_provider_connection_id' };
  }

  switch (provider) {
    case 'paystack':
      return verifyPaystack(supabase, gatewayReference, expectedAmount, expectedCurrency, paymentMetadata, businessId);
    case 'stripe':
      return verifyStripe(gatewayReference, expectedAmount, expectedCurrency, paymentMetadata);
    case 'flutterwave':
      return verifyFlutterwave(supabase, gatewayReference, expectedAmount, expectedCurrency, paymentMetadata, businessId);
    case 'square':
      return verifySquare(supabase, gatewayReference, expectedAmount, expectedCurrency, paymentMetadata, businessId);
    case 'paypal':
      return verifyPaypal(gatewayReference, expectedAmount, expectedCurrency);
    default:
      return { status: 'config_error', reason: `unsupported_provider: ${provider}` };
  }
}

async function verifyPaystack(
  supabase: SupabaseClient,
  reference: string,
  expectedAmount: number,
  expectedCurrency: string,
  meta: Record<string, unknown>,
  businessId: string | null,
): Promise<ProviderVerificationOutcome> {
  const cred = await resolvePaystackCredential(supabase, meta, businessId);
  if (!cred) return { status: 'config_error', reason: 'paystack_credential_missing' };

  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${cred.secretKey}` };

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers, signal: AbortSignal.timeout(15000) },
    );

    // HTTP safety: non-2xx responses must never become not_paid (#172)
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { status: 'config_error', reason: `paystack_http_${response.status}` };
      }
      return { status: 'retryable_error', reason: `paystack_http_${response.status}` };
    }

    const data = await response.json();
    const txStatus = data?.data?.status as string | undefined;

    if (txStatus === 'success') {
      const providerAmountKobo = data.data.amount as number;
      const providerCurrency = (data.data.currency as string || '').toUpperCase();
      const authorization = data.data.authorization as Record<string, string> | undefined;

      return {
        status: 'verified',
        result: {
          provider: 'paystack',
          waaiioReference: reference,
          providerTransactionId: String(data.data.id || ''),
          amount: providerAmountKobo / 100, // kobo → naira
          currency: providerCurrency,
          paymentMethod: (data.data.channel as string) || 'card',
          cardLast4: authorization?.last4,
          cardBrand: authorization?.brand,
          gatewayFee: data.data.fees ? (data.data.fees as number) / 100 : undefined,
          providerStatus: 'success',
          verifiedAt: new Date().toISOString(),
        },
      };
    }

    // Terminal unpaid: only definitive provider states that cannot settle later
    const PAYSTACK_TERMINAL_UNPAID = new Set(['failed', 'abandoned']);
    if (txStatus && PAYSTACK_TERMINAL_UNPAID.has(txStatus)) {
      return { status: 'not_paid', reason: `paystack_status: ${txStatus}` };
    }

    // Everything else (pending, ongoing, processing, queued, reversed, unknown) → fail closed
    return { status: 'retryable_error', reason: `paystack_status_indeterminate: ${txStatus || 'unknown'}` };
  } catch (err) {
    logger.withContext({ op: 'provider-adapter.paystack', ...safeLogErrorContext(err) }).error('[PROVIDER] Paystack verify error');
    return { status: 'retryable_error', reason: 'paystack_network_error' };
  }
}

async function verifyStripe(
  reference: string,
  expectedAmount: number,
  expectedCurrency: string,
  meta: Record<string, unknown>,
): Promise<ProviderVerificationOutcome> {
  const cred = await resolveStripeCredential(meta);
  if (!cred) return { status: 'config_error', reason: 'stripe_credential_missing' };

  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${cred.secretKey}` };
    if (cred.connectAccountId) headers['Stripe-Account'] = cred.connectAccountId;

    // Stripe checkout sessions use cs_ prefix
    const isCheckout = reference.startsWith('cs_');
    const url = isCheckout
      ? `https://api.stripe.com/v1/checkout/sessions/${reference}`
      : `https://api.stripe.com/v1/payment_intents/${reference}`;

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { status: 'config_error', reason: `stripe_http_${response.status}` };
      }
      return { status: 'retryable_error', reason: `stripe_http_${response.status}` };
    }

    const data = await response.json();

    if (isCheckout) {
      // Stripe Checkout: payment_status + session status
      if (data.payment_status === 'paid') {
        return {
          status: 'verified',
          result: {
            provider: 'stripe', waaiioReference: reference,
            providerTransactionId: data.payment_intent,
            amount: (data.amount_total as number) / 100,
            currency: ((data.currency as string) || '').toUpperCase(),
            paymentMethod: 'card', providerStatus: 'success',
            verifiedAt: new Date().toISOString(),
          },
        };
      }
      // Terminal: expired session with unpaid → safe not_paid
      if (data.status === 'expired' && data.payment_status === 'unpaid') {
        return { status: 'not_paid', reason: 'stripe_checkout_expired_unpaid' };
      }
      // no_payment_required → config anomaly (Waaiio creates mode='payment')
      if (data.payment_status === 'no_payment_required') {
        return { status: 'config_error', reason: 'stripe_checkout_no_payment_required' };
      }
      // open+unpaid, complete+unpaid, unknown → fail closed
      return { status: 'retryable_error', reason: `stripe_checkout_indeterminate: status=${data.status} payment_status=${data.payment_status}` };
    }

    // Stripe PaymentIntent
    if (data.status === 'succeeded') {
      return {
        status: 'verified',
        result: {
          provider: 'stripe', waaiioReference: reference,
          providerTransactionId: data.id,
          amount: (data.amount as number) / 100,
          currency: ((data.currency as string) || '').toUpperCase(),
          paymentMethod: 'card', providerStatus: 'success',
          verifiedAt: new Date().toISOString(),
        },
      };
    }
    const STRIPE_PI_TERMINAL_UNPAID = new Set(['canceled']);
    if (STRIPE_PI_TERMINAL_UNPAID.has(data.status)) {
      return { status: 'not_paid', reason: `stripe_pi_status: ${data.status}` };
    }
    // processing, requires_action, requires_capture, etc. → fail closed
    return { status: 'retryable_error', reason: `stripe_pi_indeterminate: ${data.status || 'unknown'}` };
  } catch (err) {
    logger.withContext({ op: 'provider-adapter.stripe', ...safeLogErrorContext(err) }).error('[PROVIDER] Stripe verify error');
    return { status: 'retryable_error', reason: 'stripe_network_error' };
  }
}

async function verifyFlutterwave(
  supabase: SupabaseClient,
  reference: string,
  expectedAmount: number,
  expectedCurrency: string,
  meta: Record<string, unknown>,
  businessId: string | null,
): Promise<ProviderVerificationOutcome> {
  const cred = await resolveFlutterwaveCredential(supabase, meta, businessId);
  if (!cred) return { status: 'config_error', reason: 'flutterwave_credential_missing' };

  try {
    // Flutterwave uses transaction ID, not reference, for verification
    // The reference may need lookup — use the verify-by-reference endpoint
    const response = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${cred.secretKey}` }, signal: AbortSignal.timeout(15000) },
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { status: 'config_error', reason: `flutterwave_http_${response.status}` };
      }
      return { status: 'retryable_error', reason: `flutterwave_http_${response.status}` };
    }

    const data = await response.json();
    const txStatus = data.data?.status as string | undefined;

    if (data.status === 'success' && txStatus === 'successful') {
      return {
        status: 'verified',
        result: {
          provider: 'flutterwave',
          waaiioReference: reference,
          providerTransactionId: String(data.data.id || ''),
          amount: data.data.amount as number,
          currency: ((data.data.currency as string) || '').toUpperCase(),
          paymentMethod: data.data.payment_type || 'card',
          gatewayFee: data.data.app_fee as number | undefined,
          providerStatus: 'successful',
          verifiedAt: new Date().toISOString(),
        },
      };
    }

    const FLUTTERWAVE_TERMINAL_UNPAID = new Set(['failed']);
    if (txStatus && FLUTTERWAVE_TERMINAL_UNPAID.has(txStatus)) {
      return { status: 'not_paid', reason: `flutterwave_status: ${txStatus}` };
    }

    return { status: 'retryable_error', reason: `flutterwave_status_indeterminate: ${txStatus || data.status || 'unknown'}` };
  } catch (err) {
    logger.withContext({ op: 'provider-adapter.flutterwave', ...safeLogErrorContext(err) }).error('[PROVIDER] Flutterwave verify error');
    return { status: 'retryable_error', reason: 'flutterwave_network_error' };
  }
}

async function verifySquare(
  supabase: SupabaseClient,
  reference: string,
  expectedAmount: number,
  expectedCurrency: string,
  meta: Record<string, unknown>,
  businessId: string | null,
): Promise<ProviderVerificationOutcome> {
  const cred = await resolveSquareCredential(supabase, meta, businessId);
  if (!cred) return { status: 'config_error', reason: 'square_credential_missing' };

  try {
    const squareEnv = process.env.SQUARE_ENVIRONMENT === 'production' ? 'connect' : 'connect.squareupsandbox';
    const response = await fetch(
      `https://${squareEnv}.com/v2/payments/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${cred.secretKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) },
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { status: 'config_error', reason: `square_http_${response.status}` };
      }
      return { status: 'retryable_error', reason: `square_http_${response.status}` };
    }

    const data = await response.json();
    const paymentStatus = data.payment?.status as string | undefined;

    if (paymentStatus === 'COMPLETED') {
      const amountMoney = data.payment.amount_money;
      return {
        status: 'verified',
        result: {
          provider: 'square',
          waaiioReference: reference,
          providerTransactionId: data.payment.id,
          amount: (amountMoney?.amount as number) / 100,
          currency: ((amountMoney?.currency as string) || '').toUpperCase(),
          paymentMethod: data.payment.source_type || 'card',
          providerStatus: 'COMPLETED',
          verifiedAt: new Date().toISOString(),
        },
      };
    }

    const SQUARE_TERMINAL_UNPAID = new Set(['CANCELED', 'FAILED']);
    if (paymentStatus && SQUARE_TERMINAL_UNPAID.has(paymentStatus)) {
      return { status: 'not_paid', reason: `square_status: ${paymentStatus}` };
    }

    return { status: 'retryable_error', reason: `square_status_indeterminate: ${paymentStatus || 'unknown'}` };
  } catch (err) {
    logger.withContext({ op: 'provider-adapter.square', ...safeLogErrorContext(err) }).error('[PROVIDER] Square verify error');
    return { status: 'retryable_error', reason: 'square_network_error' };
  }
}

async function verifyPaypal(
  reference: string,
  expectedAmount: number,
  expectedCurrency: string,
): Promise<ProviderVerificationOutcome> {
  const cred = resolvePaypalCredential();
  if (!cred) return { status: 'config_error', reason: 'paypal_credential_missing' };

  try {
    const [clientId, clientSecret] = cred.secretKey.split(':');
    const paypalEnv = process.env.PAYPAL_ENVIRONMENT === 'live' ? 'api-m' : 'api-m.sandbox';

    // OAuth token boundary
    const tokenRes = await fetch(`https://${paypalEnv}.paypal.com/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000),
    });

    if (!tokenRes.ok) {
      if (tokenRes.status === 401 || tokenRes.status === 403) {
        return { status: 'config_error', reason: `paypal_oauth_http_${tokenRes.status}` };
      }
      return { status: 'retryable_error', reason: `paypal_oauth_http_${tokenRes.status}` };
    }

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return { status: 'config_error', reason: 'paypal_oauth_no_token' };
    }

    // Order verification boundary
    const orderRes = await fetch(`https://${paypalEnv}.paypal.com/v2/checkout/orders/${reference}`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!orderRes.ok) {
      if (orderRes.status === 401 || orderRes.status === 403) {
        return { status: 'config_error', reason: `paypal_order_http_${orderRes.status}` };
      }
      return { status: 'retryable_error', reason: `paypal_order_http_${orderRes.status}` };
    }

    const order = await orderRes.json();
    const orderStatus = order.status as string | undefined;

    // Terminal unpaid at order level
    if (orderStatus === 'VOIDED') {
      return { status: 'not_paid', reason: 'paypal_order_voided' };
    }

    // Non-terminal orders → fail closed
    if (orderStatus !== 'COMPLETED') {
      return { status: 'retryable_error', reason: `paypal_order_indeterminate: ${orderStatus || 'unknown'}` };
    }

    // Order COMPLETED — must validate capture status
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) {
      return { status: 'retryable_error', reason: 'paypal_capture_missing' };
    }

    const captureStatus = capture.status as string | undefined;
    if (captureStatus === 'COMPLETED') {
      return {
        status: 'verified',
        result: {
          provider: 'paypal',
          waaiioReference: reference,
          providerTransactionId: capture.id || order.id,
          amount: parseFloat(capture.amount?.value || '0'),
          currency: ((capture.amount?.currency_code as string) || '').toUpperCase(),
          paymentMethod: 'paypal',
          providerStatus: 'COMPLETED',
          verifiedAt: new Date().toISOString(),
        },
      };
    }

    // Terminal capture failure
    if (captureStatus === 'DECLINED') {
      return { status: 'not_paid', reason: `paypal_capture_declined` };
    }

    // FAILED (retryable), PENDING, REFUNDED, PARTIALLY_REFUNDED, unknown → fail closed
    return { status: 'retryable_error', reason: `paypal_capture_indeterminate: ${captureStatus || 'unknown'}` };
  } catch (err) {
    logger.withContext({ op: 'provider-adapter.paypal', ...safeLogErrorContext(err) }).error('[PROVIDER] PayPal verify error');
    return { status: 'retryable_error', reason: 'paypal_network_error' };
  }
}
