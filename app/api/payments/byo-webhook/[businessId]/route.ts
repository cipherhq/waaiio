import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { processPaystackChargeSuccess, processPaystackChargeFailed } from '@/lib/payments/webhook-handler';
import { decryptToken } from '@/lib/encryption';

// Terminal Paystack failure statuses — only these justify marking a payment failed
const PAYSTACK_TERMINAL_FAILURES = new Set(['failed', 'reversed', 'abandoned']);
// Terminal Flutterwave failure statuses
const FLUTTERWAVE_TERMINAL_FAILURES = new Set(['failed']);
// Non-terminal statuses — transaction may still settle (→ 503)
const PAYSTACK_TRANSIENT_STATUSES = new Set(['ongoing', 'pending', 'processing', 'queued']);
const FLUTTERWAVE_TRANSIENT_STATUSES = new Set(['pending']);

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

    // Look up BYO credentials — deployment safety for M443
    let creds: { secret_key: string | null; gateway: string; webhook_secret_hash: string | null } | null = null;
    {
      const { data, error } = await supabase
        .from('business_payment_credentials')
        .select('secret_key, gateway, webhook_secret_hash')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle();

      if (error) {
        // Column may not exist (M443 not yet applied) — try without webhook_secret_hash
        const { data: fallback, error: fallbackError } = await supabase
          .from('business_payment_credentials')
          .select('secret_key, gateway')
          .eq('business_id', businessId)
          .eq('is_active', true)
          .maybeSingle();

        if (fallbackError || !fallback) {
          Sentry.captureMessage('BYO webhook: credential lookup failed', {
            level: 'error',
            extra: { businessId, errorMessage: error.message },
          });
          return NextResponse.json({ error: 'Provider temporarily unavailable' }, { status: 503 });
        }

        if (fallback.gateway === 'flutterwave') {
          Sentry.captureMessage('BYO webhook: webhook_secret_hash column unavailable', {
            level: 'error',
            extra: { businessId },
          });
          return NextResponse.json({ error: 'Provider temporarily unavailable' }, { status: 503 });
        }

        creds = { secret_key: fallback.secret_key, gateway: fallback.gateway, webhook_secret_hash: null };
      } else {
        creds = data;
      }
    }

    if (!creds) {
      return NextResponse.json({ error: 'No active BYO credentials' }, { status: 404 });
    }

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
      const hash = createHmac('sha512', decryptedKey).update(rawBody).digest('hex');
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

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const event = body.event as string;
    const data = body.data as Record<string, unknown>;
    const reference = creds.gateway === 'flutterwave'
      ? (data.tx_ref as string)
      : (data.reference as string);

    if (!reference) {
      return NextResponse.json({ received: true });
    }

    const { data: payment } = await supabase
      .from('payments')
      .select('id, status, amount, currency')
      .eq('gateway_reference', reference)
      .eq('business_id', businessId)
      .maybeSingle();

    if (!payment) {
      return NextResponse.json({ received: true });
    }

    // Fast-path dedup read
    const eventId = `byo:${businessId}:${event}:${reference}`;
    const { data: existingEvent } = await supabase
      .from('processed_webhook_events')
      .select('event_id')
      .eq('event_id', eventId)
      .maybeSingle();

    if (existingEvent) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    const verifyResult = await verifyWithProviderServerSide(
      creds.gateway, data, reference, payment, decryptedKey!,
    );

    if (verifyResult.transient) {
      return NextResponse.json({ error: 'Provider verification temporarily unavailable' }, { status: 503 });
    }

    if (verifyResult.configError) {
      Sentry.captureMessage('BYO webhook: provider credential error', {
        level: 'error',
        extra: { businessId, reference, reason: verifyResult.reason, paymentId: payment.id },
      });
      return NextResponse.json({ received: true });
    }

    // P1-A: scope for all handler calls
    const scope = { paymentId: payment.id, businessId };

    if (event === 'charge.success' || event === 'charge.completed') {
      if (!verifyResult.success) {
        Sentry.captureMessage('BYO webhook: provider verification failed (definitive)', {
          level: 'warning',
          extra: { businessId, reference, reason: verifyResult.reason, paymentId: payment.id },
        });
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: verifyResult.reason })
          .eq('id', payment.id)
          .eq('business_id', businessId)
          .in('status', ['pending']);
        // P1-C: amount_mismatch/definitive → NO dedup row
        return NextResponse.json({ received: true });
      }

      const outcome = await processPaystackChargeSuccess(
        verifyResult.verifiedData!, reference, supabase, scope,
      );

      if (outcome === 'incomplete') {
        return NextResponse.json({ error: 'Finalization incomplete' }, { status: 503 });
      }
      // amount_mismatch from handler → already returned via throw/early return
    } else if (event === 'charge.failed') {
      const ps = verifyResult.providerStatus || '';

      if (ps === 'success' || ps === 'successful') {
        return NextResponse.json({ received: true });
      }

      const isTerminal = creds.gateway === 'flutterwave'
        ? FLUTTERWAVE_TERMINAL_FAILURES.has(ps)
        : PAYSTACK_TERMINAL_FAILURES.has(ps);

      if (!isTerminal) {
        return NextResponse.json({ error: 'Provider verification temporarily unavailable' }, { status: 503 });
      }

      await processPaystackChargeFailed(
        { gateway_response: verifyResult.reason || ps },
        reference, supabase, scope,
      );
    }

    // Processing succeeded — write dedup
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

interface VerifyResult {
  success: boolean;
  transient?: boolean;
  configError?: boolean;
  reason?: string;
  providerStatus?: string;
  verifiedData?: Record<string, unknown>;
}

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
        if (response.status === 429 || response.status >= 500) return { success: false, transient: true, reason: `paystack_verify_http_${response.status}` };
        if (response.status === 401 || response.status === 403) return { success: false, configError: true, reason: `paystack_verify_http_${response.status}` };
        return { success: false, reason: `paystack_verify_http_${response.status}` };
      }

      const result = await response.json();
      const providerStatus = (result.data?.status as string) || 'unknown';

      if (PAYSTACK_TRANSIENT_STATUSES.has(providerStatus)) return { success: false, transient: true, reason: `paystack_verify_status_${providerStatus}`, providerStatus };
      if (providerStatus !== 'success') return { success: false, reason: `paystack_verify_status_${providerStatus}`, providerStatus };

      const verifiedKobo = result.data.amount as number;
      const expectedKobo = Math.round(payment.amount * 100);
      if (verifiedKobo !== expectedKobo) return { success: false, reason: 'amount_mismatch' };

      const verifiedCurrency = ((result.data.currency as string) || '').toUpperCase();
      if (verifiedCurrency !== (payment.currency || '').toUpperCase()) return { success: false, reason: 'currency_mismatch' };
      if (result.data.reference !== reference) return { success: false, reason: 'reference_mismatch' };

      const psAuth = result.data.authorization as Record<string, unknown> | undefined;
      const sanitizedAuth = psAuth ? {
        last4: psAuth.last4, brand: psAuth.brand, country_code: psAuth.country_code,
        bin: psAuth.bin, exp_month: psAuth.exp_month, exp_year: psAuth.exp_year,
        card_type: psAuth.card_type, bank: psAuth.bank,
      } : undefined;

      return {
        success: true, providerStatus: 'success',
        verifiedData: {
          reference: result.data.reference, id: result.data.id,
          amount: result.data.amount, currency: verifiedCurrency,
          status: 'success', channel: result.data.channel,
          fees: result.data.fees, authorization: sanitizedAuth,
          customer: result.data.customer,
        },
      };
    }

    if (gateway === 'flutterwave') {
      const txId = webhookData.id as number;
      if (!txId) return { success: false, reason: 'missing_transaction_id' };

      const response = await fetch(
        `https://api.flutterwave.com/v3/transactions/${txId}/verify`,
        { headers: { Authorization: `Bearer ${decryptedKey}` }, signal: AbortSignal.timeout(15000) },
      );

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) return { success: false, transient: true, reason: `flutterwave_verify_http_${response.status}` };
        if (response.status === 401 || response.status === 403) return { success: false, configError: true, reason: `flutterwave_verify_http_${response.status}` };
        return { success: false, reason: `flutterwave_verify_http_${response.status}` };
      }

      const result = await response.json();
      const providerStatus = (result.data?.status as string) || 'unknown';

      if (FLUTTERWAVE_TRANSIENT_STATUSES.has(providerStatus)) return { success: false, transient: true, reason: `flutterwave_verify_status_${providerStatus}`, providerStatus };
      if (providerStatus !== 'successful') return { success: false, reason: `flutterwave_verify_status_${providerStatus}`, providerStatus };

      const verifiedMinor = Math.round((result.data.amount as number) * 100);
      const expectedMinor = Math.round(payment.amount * 100);
      if (verifiedMinor !== expectedMinor) return { success: false, reason: 'amount_mismatch' };

      const verifiedCurrency = ((result.data.currency as string) || '').toUpperCase();
      if (verifiedCurrency !== (payment.currency || '').toUpperCase()) return { success: false, reason: 'currency_mismatch' };
      if (result.data.tx_ref !== reference) return { success: false, reason: 'reference_mismatch' };

      const fwData = result.data as Record<string, unknown>;
      const fwCard = fwData.card as Record<string, unknown> | undefined;
      const fwCustomer = fwData.customer as Record<string, unknown> | undefined;

      return {
        success: true, providerStatus: 'successful',
        verifiedData: {
          reference: fwData.tx_ref, id: fwData.id,
          amount: Math.round((fwData.amount as number) * 100),
          currency: verifiedCurrency, status: 'success',
          channel: fwData.payment_type,
          fees: Math.round(((fwData.app_fee as number) || 0) * 100),
          authorization: fwCard ? {
            last4: fwCard.last_4digits, brand: fwCard.type, country_code: fwCard.country,
          } : undefined,
          customer: fwCustomer ? {
            email: fwCustomer.email, phone: fwCustomer.phone_number,
          } : undefined,
        },
      };
    }

    return { success: false, reason: 'unsupported_gateway' };
  } catch {
    return { success: false, transient: true, reason: 'verify_network_error' };
  }
}
