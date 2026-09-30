import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

interface TopUpPackage {
  amount_minor: number;
  label: string;
  description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const { business_id, package_amount_minor } = await request.json();

    if (!business_id || !package_amount_minor) {
      return NextResponse.json(
        { message: 'Missing business_id or package_amount_minor' },
        { status: 400 },
      );
    }

    if (typeof package_amount_minor !== 'number' || package_amount_minor <= 0 || !Number.isInteger(package_amount_minor)) {
      return NextResponse.json(
        { message: 'package_amount_minor must be a positive integer' },
        { status: 400 },
      );
    }

    // ── Verify business ownership ──

    const { data: business } = await supabase
      .from('businesses')
      .select('id, owner_id, country_code')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) {
      return NextResponse.json(
        { message: 'Business not found or not owned by you' },
        { status: 403 },
      );
    }

    if (!business.country_code) {
      return NextResponse.json(
        { message: 'Business country code is required' },
        { status: 400 },
      );
    }

    // ── Resolve country → currency → gateway ──

    const service = createServiceClient();
    const { data: countryRow, error: countryError } = await service
      .from('countries')
      .select('currency_code, payment_gateway')
      .eq('code', business.country_code)
      .eq('is_active', true)
      .single();

    if (countryError || !countryRow) {
      return NextResponse.json(
        { message: 'Regional configuration is unavailable. Please try again later.' },
        { status: 503 },
      );
    }

    const currency = countryRow.currency_code as string;
    const gateway = countryRow.payment_gateway as string;

    if (!currency) {
      return NextResponse.json({ message: 'Currency not configured for this region.' }, { status: 503 });
    }
    if (!gateway) {
      return NextResponse.json({ message: 'Payment gateway not configured for this region.' }, { status: 503 });
    }

    // Only stripe and paystack are supported for top-up
    if (gateway !== 'stripe' && gateway !== 'paystack') {
      return NextResponse.json(
        { message: `Payment gateway "${gateway}" is not supported for messaging top-up.` },
        { status: 400 },
      );
    }

    // ── Validate package exists in canonical config ──

    const { data: configRow } = await service
      .from('platform_settings')
      .select('value')
      .eq('key', 'messaging_topup_packages')
      .single();

    if (!configRow?.value || !isRecord(configRow.value)) {
      return NextResponse.json(
        { message: 'Top-up packages are not configured. Please try again later.' },
        { status: 503 },
      );
    }

    const allPackages = configRow.value as Record<string, TopUpPackage[]>;
    const currencyPackages = allPackages[currency];

    if (!Array.isArray(currencyPackages) || currencyPackages.length === 0) {
      return NextResponse.json(
        { message: 'No top-up packages available for your currency.' },
        { status: 400 },
      );
    }

    const matchedPackage = currencyPackages.find(
      (pkg) => pkg.amount_minor === package_amount_minor,
    );

    if (!matchedPackage) {
      return NextResponse.json(
        { message: 'Invalid package amount. Please select a valid top-up package.' },
        { status: 400 },
      );
    }

    // ── Pin config version ──

    const { data: configVersionId, error: configErr } = await service.rpc('get_effective_config_version_id');
    if (configErr || !configVersionId) {
      return NextResponse.json({ message: 'Configuration unavailable' }, { status: 503 });
    }

    // ── Create purchase intent ──

    const { data: purchase, error: purchaseError } = await service
      .from('messaging_topup_purchases')
      .insert({
        business_id,
        owner_id: user.id,
        package_amount_minor,
        currency_code: currency,
        gateway,
        config_version_id: configVersionId,
        status: 'pending',
      })
      .select('id')
      .single();

    if (purchaseError || !purchase) {
      return NextResponse.json(
        { message: 'Failed to create purchase record' },
        { status: 500 },
      );
    }

    const purchaseId = purchase.id;
    const providerReference = `topup_${purchaseId}`;

    // Set provider_reference on the purchase
    await service
      .from('messaging_topup_purchases')
      .update({ provider_reference: providerReference })
      .eq('id', purchaseId);

    // ── Resolve email ──

    const { data: profile } = await supabase
      .from('profiles')
      .select('email, phone')
      .eq('id', user.id)
      .single();

    const email = profile?.email || `${(profile?.phone || user.id).replace('+', '')}@whatsapp.waaiio.com`;
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com').trim();

    // ── Paystack path ──

    if (gateway === 'paystack') {
      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      if (!paystackKey) {
        await service
          .from('messaging_topup_purchases')
          .update({ status: 'failed' })
          .eq('id', purchaseId);
        return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
      }

      const payload = {
        email,
        amount: package_amount_minor,
        currency,
        reference: providerReference,
        metadata: {
          type: 'messaging_topup',
          purchase_id: purchaseId,
          business_id,
        },
        callback_url: `${appUrl}/api/messaging/topup/callback?reference=${providerReference}`,
      };

      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!data.status) {
        await service
          .from('messaging_topup_purchases')
          .update({ status: 'failed' })
          .eq('id', purchaseId);
        return NextResponse.json(
          { message: 'Failed to initialize payment', error: data.message },
          { status: 500 },
        );
      }

      // Update purchase with provider checkout ID
      await service
        .from('messaging_topup_purchases')
        .update({ provider_checkout_id: data.data.reference })
        .eq('id', purchaseId);

      return NextResponse.json({
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
        purchase_id: purchaseId,
      });
    }

    // ── Stripe path ──

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      await service
        .from('messaging_topup_purchases')
        .update({ status: 'failed' })
        .eq('id', purchaseId);
      return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
    }

    const stripeBody = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][quantity]': '1',
      mode: 'payment',
      success_url: `${appUrl}/dashboard/billing?topup=success`,
      cancel_url: `${appUrl}/dashboard/billing?topup=cancelled`,
      customer_email: email,
      'metadata[type]': 'messaging_topup',
      'metadata[purchase_id]': purchaseId,
      'metadata[business_id]': business_id,
    });

    stripeBody.set('line_items[0][price_data][currency]', currency.toLowerCase());
    stripeBody.set('line_items[0][price_data][product_data][name]', 'Waaiio Messaging Credit Top-Up');
    stripeBody.set('line_items[0][price_data][unit_amount]', String(package_amount_minor));

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: stripeBody.toString(),
    });

    const data = await response.json();

    if (!data.url) {
      await service
        .from('messaging_topup_purchases')
        .update({ status: 'failed' })
        .eq('id', purchaseId);
      return NextResponse.json(
        { message: 'Failed to initialize payment', error: data.error?.message },
        { status: 500 },
      );
    }

    // Update purchase with Stripe session ID
    await service
      .from('messaging_topup_purchases')
      .update({ provider_checkout_id: data.id })
      .eq('id', purchaseId);

    return NextResponse.json({
      authorization_url: data.url,
      reference: data.id,
      purchase_id: purchaseId,
    });
  } catch (error) {
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 },
    );
  }
}
