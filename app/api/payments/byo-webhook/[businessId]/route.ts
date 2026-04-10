import { NextResponse, type NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { processPaystackChargeSuccess, processPaystackChargeFailed } from '@/lib/payments/webhook-handler';

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

    // Validate webhook signature using business's secret key
    if (creds.gateway === 'paystack') {
      const signature = request.headers.get('x-paystack-signature') || '';
      const hash = createHmac('sha512', creds.secret_key)
        .update(rawBody)
        .digest('hex');

      if (hash !== signature) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
      }
    } else if (creds.gateway === 'flutterwave') {
      const verifyHash = request.headers.get('verif-hash') || '';
      const secretHash = process.env.FLW_SECRET_HASH || creds.secret_key;
      if (verifyHash !== secretHash) {
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

    // Idempotency check
    const eventId = `byo:${businessId}:${event}:${reference}`;
    const { data: alreadyProcessed } = await supabase
      .from('processed_webhook_events')
      .select('id')
      .eq('event_id', eventId)
      .maybeSingle();

    if (alreadyProcessed) {
      return NextResponse.json({ received: true });
    }

    await supabase.from('processed_webhook_events').insert({
      event_id: eventId,
      gateway: creds.gateway,
      event_type: event,
    });

    // Delegate to shared handlers (payment events only — no subscription events for BYO)
    if (event === 'charge.success') {
      await processPaystackChargeSuccess(data, reference, supabase);
    } else if (event === 'charge.failed') {
      await processPaystackChargeFailed(data, reference, supabase);
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
