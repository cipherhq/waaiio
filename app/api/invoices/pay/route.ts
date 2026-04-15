import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { initializePayment } from '@/lib/bot/flows/shared/payment';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: invoice } = await supabase
      .from('invoices')
      .select('id, business_id, reference_code, total_amount, amount_paid, currency, status, token_expires_at, customer_phone, customer_email, customer_name')
      .eq('token', token)
      .single();

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    // Validate
    if (invoice.status === 'paid') {
      return NextResponse.json({ error: 'Invoice already paid' }, { status: 400 });
    }
    if (invoice.status === 'cancelled') {
      return NextResponse.json({ error: 'Invoice has been cancelled' }, { status: 400 });
    }
    if (invoice.token_expires_at && new Date(invoice.token_expires_at) < new Date()) {
      return NextResponse.json({ error: 'Payment link has expired' }, { status: 400 });
    }

    // Check for existing pending payment to prevent duplicates
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('id, gateway_reference, status')
      .eq('invoice_id', invoice.id)
      .eq('status', 'pending')
      .maybeSingle();

    if (existingPayment) {
      // Re-use existing pending payment — fetch gateway URL from metadata
      // For now, create a new one (old pending one will be superseded by webhook)
    }

    // Fetch business info for payment
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, country_code, payment_gateway')
      .eq('id', invoice.business_id)
      .single();

    if (!biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 500 });
    }

    const { getCountry } = await import('@/lib/countries');
    const countryCode = biz.country_code || 'NG';

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.waaiio.com';

    const result = await initializePayment(supabase, {
      invoiceId: invoice.id,
      userId: '00000000-0000-0000-0000-000000000000', // public, no auth user
      amount: invoice.total_amount,
      referenceCode: invoice.reference_code,
      businessName: biz.name,
      phone: invoice.customer_phone || '',
      userEmail: invoice.customer_email || undefined,
      countryCode: countryCode as 'NG' | 'US' | 'GB' | 'GH' | 'KE' | 'ZA',
      gatewayOverride: biz.payment_gateway,
      businessId: biz.id,
    });

    if (!result) {
      return NextResponse.json({ error: 'Failed to initialize payment' }, { status: 500 });
    }

    return NextResponse.json({ url: result.url, reference: result.reference });
  } catch (err) {
    console.error('invoices/pay error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
