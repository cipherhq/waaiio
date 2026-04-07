import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

const FLUTTERWAVE_SECRET_HASH = process.env.FLUTTERWAVE_WEBHOOK_HASH || '';

export async function POST(request: NextRequest) {
  try {
    // Validate webhook signature
    const verifHash = request.headers.get('verif-hash');
    if (FLUTTERWAVE_SECRET_HASH && verifHash !== FLUTTERWAVE_SECRET_HASH) {
      return NextResponse.json({ message: 'Invalid hash' }, { status: 401 });
    }

    const body = await request.json();
    const event = body.event;
    const data = body.data;

    if (event !== 'charge.completed' || !data) {
      return NextResponse.json({ message: 'Ignored' }, { status: 200 });
    }

    if (data.status !== 'successful') {
      return NextResponse.json({ message: 'Payment not successful' }, { status: 200 });
    }

    const txRef = data.tx_ref as string;
    if (!txRef) {
      return NextResponse.json({ message: 'Missing tx_ref' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Find the payment record
    const { data: payment } = await supabase
      .from('payments')
      .select('id, booking_id, amount')
      .eq('gateway_reference', txRef)
      .single();

    if (!payment) {
      return NextResponse.json({ message: 'Payment not found' }, { status: 404 });
    }

    // Verify amount matches
    const webhookAmount = data.amount as number;
    if (webhookAmount !== payment.amount) {
      return NextResponse.json({ message: 'Amount mismatch' }, { status: 400 });
    }

    // Update payment status
    await supabase
      .from('payments')
      .update({
        status: 'success',
        gateway_status: 'successful',
        payment_method: (data.payment_type as string) || 'card',
        card_last_four: data.card?.last_4digits || null,
        card_brand: data.card?.type || null,
        paid_at: new Date().toISOString(),
      })
      .eq('id', payment.id);

    // Confirm booking if applicable
    if (payment.booking_id) {
      await supabase
        .from('bookings')
        .update({
          deposit_status: 'paid',
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
        })
        .eq('id', payment.booking_id);
    }

    return NextResponse.json({ message: 'OK' }, { status: 200 });
  } catch (error) {
    console.error('Flutterwave webhook error:', (error as Error).message);
    return NextResponse.json({ message: 'Internal error' }, { status: 500 });
  }
}
