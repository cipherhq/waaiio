import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { processPaystackChargeSuccess, processPaystackChargeFailed } from '@/lib/payments/webhook-handler';
import { decryptToken } from '@/lib/encryption';

/**
 * BYO (Bring Your Own) Payment Webhook
 * Receives webhooks from a business's own Paystack/Flutterwave account.
 * Validates signature using the business's secret key, then delegates
 * to shared processing logic.
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
      .select('secret_key, gateway')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .maybeSingle();

    if (!creds?.secret_key) {
      return NextResponse.json({ error: 'No active BYO credentials' }, { status: 404 });
    }

    const decryptedKey = decryptToken(creds.secret_key);
    if (!decryptedKey) {
      return NextResponse.json({ error: 'Invalid BYO credentials' }, { status: 400 });
    }

    // Validate webhook signature using business's own secret key
    if (creds.gateway === 'paystack') {
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
      const verifyHash = request.headers.get('verif-hash') || '';
      if (!verifyHash || !timingSafeEqual(Buffer.from(verifyHash), Buffer.from(decryptedKey))) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
      }
    }

    const body = JSON.parse(rawBody);
    const event = body.event as string;
    const data = body.data as Record<string, unknown>;
    const reference = data.reference as string;

    if (!reference) {
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

    // Delegate to shared handlers (payment events only — no subscription events for BYO)
    // Paystack uses 'charge.success', Flutterwave uses 'charge.completed'
    if (event === 'charge.success' || event === 'charge.completed') {
      await processPaystackChargeSuccess(data, reference, supabase);
    } else if (event === 'charge.failed') {
      await processPaystackChargeFailed(data, reference, supabase);
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
