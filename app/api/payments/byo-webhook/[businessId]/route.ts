import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { processPaystackChargeSuccess, processPaystackChargeFailed } from '@/lib/payments/webhook-handler';
import { decryptToken } from '@/lib/encryption';

/**
 * BYO (Bring Your Own) Payment Webhook
 *
 * Receives webhooks from a business's own Paystack/Flutterwave account.
 *
 * Security invariants:
 * 1. Signature verification using the business's stored secret (Paystack HMAC)
 *    or dedicated webhook_secret_hash (Flutterwave verif-hash).
 * 2. Payment must belong to the URL's businessId (foreign references are ignored).
 * 3. Server-side provider verification before ANY state change.
 * 4. Transient verify failures (network, 5xx, 429) → 503 so the provider retries.
 * 5. Config errors (401/403, bad key) → 200 + Sentry, payment unchanged, no retry loop.
 * 6. Dedup event recorded only after processing succeeds (handlers are idempotent).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { businessId: string } },
) {
  try {
    const { businessId } = params;
    if (!businessId) {
      return NextResponse.json({ error: 'Missing businessId' }, { status: 400 });
    }

    const rawBody = await request.text();
    const supabase = createServiceClient();

    // Look up BYO credentials for this business
    const { data: creds } = await supabase
      .from('business_payment_credentials')
      .select('secret_key, gateway, webhook_secret_hash')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .maybeSingle();

    if (!creds) {
      return NextResponse.json({ error: 'No active BYO credentials' }, { status: 404 });
    }

    // Decrypt secret key (needed for Paystack signature + provider verification)
    let decryptedKey: string | null = null;
    if (creds.secret_key) {
      decryptedKey = decryptToken(creds.secret_key);
      if (!decryptedKey) {
        return NextResponse.json({ error: 'Invalid BYO credentials' }, { status: 400 });
      }
    }

    // ── Signature verification ──
    if (creds.gateway === 'paystack') {
      if (!decryptedKey) {
        return NextResponse.json({ error: 'Invalid BYO credentials' }, { status: 400 });
      }
      const signature = request.headers.get('x-paystack-signature') || '';
      const hash = createHmac('sha512', decryptedKey)
        .update(rawBody)
        .digest('hex');

      try {
        if (!timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
          return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
        }
      } catch {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    } else if (creds.gateway === 'flutterwave') {
      if (!creds.webhook_secret_hash) {
        return NextResponse.json({ error: 'Flutterwave webhook secret not configured' }, { status: 400 });
      }
      const decryptedHash = decryptToken(creds.webhook_secret_hash);
      if (!decryptedHash) {
        return NextResponse.json({ error: 'Invalid webhook secret' }, { status: 400 });
      }
      const verifHash = request.headers.get('verif-hash') || '';
      if (!verifHash) {
        return NextResponse.json({ error: 'Missing verification hash' }, { status: 400 });
      }
      try {
        if (!timingSafeEqual(Buffer.from(verifHash), Buffer.from(decryptedHash))) {
          return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
      }
      if (!decryptedKey) {
        return NextResponse.json({ error: 'Invalid BYO credentials' }, { status: 400 });
      }
    } else {
      return NextResponse.json({ error: 'Unsupported gateway' }, { status: 400 });
    }

    const body = JSON.parse(rawBody);
    const event = body.event as string;
    const data = body.data as Record<string, unknown>;

    // Extract reference based on gateway (Paystack uses 'reference', Flutterwave uses 'tx_ref')
    const reference = creds.gateway === 'flutterwave'
      ? (data.tx_ref as string)
      : (data.reference as string);

    if (!reference) {
      return NextResponse.json({ received: true });
    }

    // Look up payment by gateway_reference AND business_id — ignore foreign references
    const { data: payment } = await supabase
      .from('payments')
      .select('id, status, amount, currency')
      .eq('gateway_reference', reference)
      .eq('business_id', businessId)
      .maybeSingle();

    if (!payment) {
      return NextResponse.json({ received: true });
    }

    // ── Server-side provider verification BEFORE any state change ──
    const verifyResult = await verifyWithProviderServerSide(
      creds.gateway, data, reference, payment, decryptedKey!,
    );

    // Transient (5xx, 429, network, timeout) → 503, payment unchanged, no dedup
    if (verifyResult.transient) {
      return NextResponse.json({ error: 'Provider verification temporarily unavailable' }, { status: 503 });
    }

    // Config error (401/403, bad key) → 200, payment unchanged, Sentry error, no dedup.
    // Return 200 so the provider stops retrying a key that won't fix itself.
    if (verifyResult.configError) {
      Sentry.captureMessage('BYO webhook: provider credential error', {
        level: 'error',
        extra: { businessId, reference, reason: verifyResult.reason, paymentId: payment.id },
      });
      return NextResponse.json({ received: true });
    }

    // ── Process the event ──
    // Dedup is inserted AFTER processing succeeds. Both handlers are idempotent
    // (status guards, exactly-once RPCs), so a retry after a thrown error is safe.

    if (event === 'charge.success' || event === 'charge.completed') {
      if (!verifyResult.success) {
        // Definitive failure — mark payment as failed (only if still pending)
        Sentry.captureMessage('BYO webhook: provider verification failed (definitive)', {
          level: 'warning',
          extra: { businessId, reference, reason: verifyResult.reason, paymentId: payment.id },
        });
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: verifyResult.reason })
          .eq('id', payment.id)
          .in('status', ['pending']);
      } else {
        // Provider verified — delegate to shared handler
        await processPaystackChargeSuccess(data, reference, supabase);
      }
    } else if (event === 'charge.failed') {
      if (verifyResult.providerStatus === 'success' || verifyResult.providerStatus === 'successful') {
        // Provider says success but webhook says failed — do NOT mark as failed
        return NextResponse.json({ received: true });
      }
      await processPaystackChargeFailed(data, reference, supabase);
    }

    // Processing succeeded — record dedup event
    const eventId = `byo:${businessId}:${event}:${reference}`;
    await supabase
      .from('processed_webhook_events')
      .upsert(
        { event_id: eventId, gateway: 'byo', event_type: `byo_${event}`, processed_at: new Date().toISOString() },
        { onConflict: 'event_id', ignoreDuplicates: true },
      );

    return NextResponse.json({ received: true });
  } catch (err) {
    // Unhandled errors → 500 so providers retry. No dedup row was inserted,
    // so the retry will be processed normally by the idempotent handlers.
    Sentry.captureException(err, { tags: { component: 'byo-webhook' } });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

/** Verification outcome with transient/definitive/config distinction. */
interface VerifyResult {
  success: boolean;
  /** Network errors, timeouts, 5xx, 429 → caller returns 503 */
  transient?: boolean;
  /** Auth/credential errors (401/403) → caller returns 200, Sentry error, no state change */
  configError?: boolean;
  reason?: string;
  /** The provider's reported transaction status (for charge.failed cross-check). */
  providerStatus?: string;
}

/**
 * Server-side verification with the payment provider.
 *
 * Returns:
 * - `{ success: true }` — provider confirms paid + amounts match
 * - `{ transient: true }` — network, timeout, 5xx, 429 → 503
 * - `{ configError: true }` — 401, 403 → 200, Sentry, payment unchanged
 * - `{ success: false }` — definitive: 404, non-success status, mismatch → mark failed
 *
 * Amounts compared in integer minor units via Math.round to avoid floating-point drift.
 */
async function verifyWithProviderServerSide(
  gateway: string,
  webhookData: Record<string, unknown>,
  reference: string,
  payment: { id: string; amount: number; currency: string },
  decryptedKey: string,
): Promise<VerifyResult> {
  try {
    if (gateway === 'paystack') {
      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${decryptedKey}` }, signal: AbortSignal.timeout(15000) },
      );

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          return { success: false, transient: true, reason: `paystack_verify_http_${response.status}` };
        }
        if (response.status === 401 || response.status === 403) {
          return { success: false, configError: true, reason: `paystack_verify_http_${response.status}` };
        }
        // 404 = transaction not found at provider → definitive
        return { success: false, reason: `paystack_verify_http_${response.status}` };
      }

      const result = await response.json();
      const providerStatus = (result.data?.status as string) || 'unknown';

      if (providerStatus !== 'success') {
        return { success: false, reason: `paystack_verify_status_${providerStatus}`, providerStatus };
      }

      // Compare in integer minor units (kobo)
      const verifiedKobo = result.data.amount as number;
      const expectedKobo = Math.round(payment.amount * 100);
      if (verifiedKobo !== expectedKobo) {
        return { success: false, reason: 'amount_mismatch' };
      }

      const verifiedCurrency = ((result.data.currency as string) || '').toUpperCase();
      const expectedCurrency = (payment.currency || '').toUpperCase();
      if (verifiedCurrency !== expectedCurrency) {
        return { success: false, reason: 'currency_mismatch' };
      }

      if (result.data.reference !== reference) {
        return { success: false, reason: 'reference_mismatch' };
      }

      return { success: true, providerStatus: 'success' };
    }

    if (gateway === 'flutterwave') {
      const txId = webhookData.id as number;
      if (!txId) {
        return { success: false, reason: 'missing_transaction_id' };
      }

      const response = await fetch(
        `https://api.flutterwave.com/v3/transactions/${txId}/verify`,
        { headers: { Authorization: `Bearer ${decryptedKey}` }, signal: AbortSignal.timeout(15000) },
      );

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          return { success: false, transient: true, reason: `flutterwave_verify_http_${response.status}` };
        }
        if (response.status === 401 || response.status === 403) {
          return { success: false, configError: true, reason: `flutterwave_verify_http_${response.status}` };
        }
        return { success: false, reason: `flutterwave_verify_http_${response.status}` };
      }

      const result = await response.json();
      const providerStatus = (result.data?.status as string) || 'unknown';

      if (providerStatus !== 'successful') {
        return { success: false, reason: `flutterwave_verify_status_${providerStatus}`, providerStatus };
      }

      // Compare in integer minor units
      const verifiedMinor = Math.round((result.data.amount as number) * 100);
      const expectedMinor = Math.round(payment.amount * 100);
      if (verifiedMinor !== expectedMinor) {
        return { success: false, reason: 'amount_mismatch' };
      }

      const verifiedCurrency = ((result.data.currency as string) || '').toUpperCase();
      const expectedCurrency = (payment.currency || '').toUpperCase();
      if (verifiedCurrency !== expectedCurrency) {
        return { success: false, reason: 'currency_mismatch' };
      }

      if (result.data.tx_ref !== reference) {
        return { success: false, reason: 'reference_mismatch' };
      }

      return { success: true, providerStatus: 'successful' };
    }

    return { success: false, reason: 'unsupported_gateway' };
  } catch {
    // Network errors, timeouts, and any unknown errors → transient
    return { success: false, transient: true, reason: 'verify_network_error' };
  }
}
