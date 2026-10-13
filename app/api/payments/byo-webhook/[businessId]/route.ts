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
 * 4. Only provider-verified data is passed to shared handlers (never webhook body).
 * 5. Transient verify failures (network, 5xx, 429, non-terminal status) → 503.
 * 6. Config errors (401/403, bad key) → 200 + Sentry, payment unchanged.
 * 7. Fast-path dedup read before verify; write-path dedup after processing.
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

    // ── Parse body (fix 5: safe JSON parse) ──
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const event = body.event as string;
    const data = body.data as Record<string, unknown>;

    // Extract reference based on gateway
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

    // ── Fast-path dedup read (fix 4) ──
    const eventId = `byo:${businessId}:${event}:${reference}`;
    const { data: existingEvent } = await supabase
      .from('processed_webhook_events')
      .select('event_id')
      .eq('event_id', eventId)
      .maybeSingle();

    if (existingEvent) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    // ── Server-side provider verification BEFORE any state change ──
    const verifyResult = await verifyWithProviderServerSide(
      creds.gateway, data, reference, payment, decryptedKey!,
    );

    // Transient (5xx, 429, network, timeout, non-terminal status) → 503
    if (verifyResult.transient) {
      return NextResponse.json({ error: 'Provider verification temporarily unavailable' }, { status: 503 });
    }

    // Config error (401/403) → 200, payment unchanged, Sentry error
    if (verifyResult.configError) {
      Sentry.captureMessage('BYO webhook: provider credential error', {
        level: 'error',
        extra: { businessId, reference, reason: verifyResult.reason, paymentId: payment.id },
      });
      return NextResponse.json({ received: true });
    }

    // ── Process the event ──
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
        // Provider verified — pass ONLY verified data to shared handler (fix 1)
        await processPaystackChargeSuccess(verifyResult.verifiedData!, reference, supabase);
      }
    } else if (event === 'charge.failed') {
      if (verifyResult.providerStatus === 'success' || verifyResult.providerStatus === 'successful') {
        return NextResponse.json({ received: true });
      }
      // charge.failed may use webhook data — handler only runs after verify
      // shows the payment did not succeed
      await processPaystackChargeFailed(data, reference, supabase);
    }

    // Processing succeeded — record dedup event
    await supabase
      .from('processed_webhook_events')
      .upsert(
        { event_id: eventId, gateway: 'byo', event_type: `byo_${event}`, processed_at: new Date().toISOString() },
        { onConflict: 'event_id', ignoreDuplicates: true },
      );

    return NextResponse.json({ received: true });
  } catch (err) {
    Sentry.captureException(err, { tags: { component: 'byo-webhook' } });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

/** Verification outcome. */
interface VerifyResult {
  success: boolean;
  transient?: boolean;
  configError?: boolean;
  reason?: string;
  providerStatus?: string;
  /** Normalized data in Paystack shape for processPaystackChargeSuccess. */
  verifiedData?: Record<string, unknown>;
}

// Non-terminal Paystack statuses — transaction may still settle
const PAYSTACK_TRANSIENT_STATUSES = new Set(['ongoing', 'pending', 'processing', 'queued']);
// Non-terminal Flutterwave statuses
const FLUTTERWAVE_TRANSIENT_STATUSES = new Set(['pending']);

/**
 * Server-side verification with the payment provider.
 *
 * On success, returns `verifiedData` normalized to the Paystack shape that
 * processPaystackChargeSuccess reads. Webhook body data is never passed through.
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
        return { success: false, reason: `paystack_verify_http_${response.status}` };
      }

      const result = await response.json();
      const providerStatus = (result.data?.status as string) || 'unknown';

      // Non-terminal statuses → transient (fix 2)
      if (PAYSTACK_TRANSIENT_STATUSES.has(providerStatus)) {
        return { success: false, transient: true, reason: `paystack_verify_status_${providerStatus}`, providerStatus };
      }

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

      // Build verifiedData from provider response (Paystack)
      // Strip authorization_code — BYO cards are never reusable through Waaiio
      const psAuth = result.data.authorization as Record<string, unknown> | undefined;
      const sanitizedAuth = psAuth ? {
        last4: psAuth.last4,
        brand: psAuth.brand,
        country_code: psAuth.country_code,
        bin: psAuth.bin,
        exp_month: psAuth.exp_month,
        exp_year: psAuth.exp_year,
        card_type: psAuth.card_type,
        bank: psAuth.bank,
        // authorization_code intentionally omitted
      } : undefined;

      return {
        success: true,
        providerStatus: 'success',
        verifiedData: {
          reference: result.data.reference,
          id: result.data.id,
          amount: result.data.amount,  // already kobo
          currency: verifiedCurrency,
          status: 'success',
          channel: result.data.channel,
          fees: result.data.fees,      // already kobo
          authorization: sanitizedAuth,
          customer: result.data.customer,
        },
      };
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

      // Non-terminal statuses → transient (fix 2)
      if (FLUTTERWAVE_TRANSIENT_STATUSES.has(providerStatus)) {
        return { success: false, transient: true, reason: `flutterwave_verify_status_${providerStatus}`, providerStatus };
      }

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

      // Build verifiedData normalized to Paystack shape (fix 1 — Flutterwave)
      const fwData = result.data as Record<string, unknown>;
      const fwCard = fwData.card as Record<string, unknown> | undefined;
      const fwCustomer = fwData.customer as Record<string, unknown> | undefined;

      return {
        success: true,
        providerStatus: 'successful',
        verifiedData: {
          reference: fwData.tx_ref,
          id: fwData.id,
          amount: Math.round((fwData.amount as number) * 100), // major → minor
          currency: verifiedCurrency,
          status: 'success',
          channel: fwData.payment_type,
          fees: Math.round(((fwData.app_fee as number) || 0) * 100), // major → minor
          authorization: fwCard ? {
            last4: fwCard.last_4digits,
            brand: fwCard.type,
            country_code: fwCard.country,
            // NEVER set authorization_code — BYO cards are not reusable through Waaiio
          } : undefined,
          customer: fwCustomer ? {
            email: fwCustomer.email,
            phone: fwCustomer.phone_number,
          } : undefined,
        },
      };
    }

    return { success: false, reason: 'unsupported_gateway' };
  } catch {
    return { success: false, transient: true, reason: 'verify_network_error' };
  }
}
