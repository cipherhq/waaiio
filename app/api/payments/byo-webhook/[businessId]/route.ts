import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
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
 * 3. Server-side provider verification before marking success (amount, currency, reference).
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
      // (c) Flutterwave: compare verif-hash against a dedicated webhook secret hash,
      //     never the secret key. If none is configured, reject.
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
      // Flutterwave provider verification also needs the secret key
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

    // (a) Look up payment by gateway_reference AND business_id — ignore foreign references
    const { data: payment } = await supabase
      .from('payments')
      .select('id, status, amount, currency')
      .eq('gateway_reference', reference)
      .eq('business_id', businessId)
      .maybeSingle();

    if (!payment) {
      // No matching payment for this business — silently acknowledge
      return NextResponse.json({ received: true });
    }

    // Idempotency: atomic dedup via ON CONFLICT
    const eventId = `byo:${businessId}:${event}:${reference}`;
    const { data: inserted } = await supabase
      .from('processed_webhook_events')
      .upsert(
        { event_id: eventId, gateway: 'byo', event_type: `byo_${event}`, processed_at: new Date().toISOString() },
        { onConflict: 'event_id', ignoreDuplicates: true },
      )
      .select('id');

    if (!inserted || inserted.length === 0) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    // Paystack uses 'charge.success', Flutterwave uses 'charge.completed'
    if (event === 'charge.success' || event === 'charge.completed') {
      // (b) Server-side provider verification before marking success
      const verifyResult = await verifyWithProviderServerSide(
        creds.gateway, data, reference, payment, decryptedKey!,
      );

      if (!verifyResult.success) {
        // Provider verification failed — mark payment as failed (only if still pending)
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: verifyResult.reason })
          .eq('id', payment.id)
          .in('status', ['pending']);
        return NextResponse.json({ received: true });
      }

      // Provider verified — delegate to shared handler
      await processPaystackChargeSuccess(data, reference, supabase);
    } else if (event === 'charge.failed') {
      await processPaystackChargeFailed(data, reference, supabase);
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ received: true }, { status: 200 });
  }
}

/**
 * Server-side verification with the payment provider.
 * Calls the provider's verify endpoint using the business's decrypted key
 * and validates status, amount, currency, and reference.
 */
async function verifyWithProviderServerSide(
  gateway: string,
  webhookData: Record<string, unknown>,
  reference: string,
  payment: { id: string; amount: number; currency: string },
  decryptedKey: string,
): Promise<{ success: boolean; reason?: string }> {
  try {
    if (gateway === 'paystack') {
      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${decryptedKey}` }, signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) {
        return { success: false, reason: `paystack_verify_http_${response.status}` };
      }
      const result = await response.json();
      if (result.data?.status !== 'success') {
        return { success: false, reason: `paystack_verify_status_${result.data?.status || 'unknown'}` };
      }
      // Paystack amounts are in kobo
      const verifiedAmountKobo = result.data.amount as number;
      const expectedAmountKobo = payment.amount * 100;
      if (verifiedAmountKobo !== expectedAmountKobo) {
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
      return { success: true };
    }

    if (gateway === 'flutterwave') {
      // Flutterwave: verify by transaction ID from webhook data
      const txId = webhookData.id as number;
      if (!txId) {
        return { success: false, reason: 'missing_transaction_id' };
      }
      const response = await fetch(
        `https://api.flutterwave.com/v3/transactions/${txId}/verify`,
        { headers: { Authorization: `Bearer ${decryptedKey}` }, signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) {
        return { success: false, reason: `flutterwave_verify_http_${response.status}` };
      }
      const result = await response.json();
      if (result.data?.status !== 'successful') {
        return { success: false, reason: `flutterwave_verify_status_${result.data?.status || 'unknown'}` };
      }
      // Flutterwave amounts are in major currency units
      if (result.data.amount !== payment.amount) {
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
      return { success: true };
    }

    return { success: false, reason: 'unsupported_gateway' };
  } catch {
    return { success: false, reason: 'verify_network_error' };
  }
}
