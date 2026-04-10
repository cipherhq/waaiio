import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

const PLATFORM_PAYSTACK_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PLATFORM_FLUTTERWAVE_KEY = process.env.FLUTTERWAVE_SECRET_KEY || '';

/**
 * POST: Save & verify BYO payment credentials
 * 1. Validate user owns business
 * 2. Verify API key via test call
 * 3. Create platform subaccount on business's gateway account
 * 4. Store credentials + platform_subaccount_code
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id, gateway, secret_key, public_key } = body;

  if (!business_id || !gateway || !secret_key) {
    return NextResponse.json({ error: 'Missing required fields: business_id, gateway, secret_key' }, { status: 400 });
  }

  if (!['paystack', 'flutterwave', 'stripe'].includes(gateway)) {
    return NextResponse.json({ error: 'Invalid gateway. Must be paystack, flutterwave, or stripe.' }, { status: 400 });
  }

  // Verify user owns the business
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, country_code')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  try {
    // Step 1: Verify the API key works
    if (gateway === 'paystack') {
      const res = await fetch('https://api.paystack.co/balance', {
        headers: { Authorization: `Bearer ${secret_key}` },
      });
      if (!res.ok) {
        return NextResponse.json({ error: 'Invalid Paystack secret key. Could not verify balance.' }, { status: 400 });
      }
    } else if (gateway === 'flutterwave') {
      const res = await fetch('https://api.flutterwave.com/v3/balances', {
        headers: { Authorization: `Bearer ${secret_key}` },
      });
      if (!res.ok) {
        return NextResponse.json({ error: 'Invalid Flutterwave secret key. Could not verify balance.' }, { status: 400 });
      }
    } else if (gateway === 'stripe') {
      // For Stripe BYO, verify the key by listing balance
      const res = await fetch('https://api.stripe.com/v1/balance', {
        headers: { Authorization: `Bearer ${secret_key}` },
      });
      if (!res.ok) {
        return NextResponse.json({ error: 'Invalid Stripe secret key. Could not verify balance.' }, { status: 400 });
      }
    }

    // Step 2: Fetch platform bank details from platform_settings
    const serviceClient = createServiceClient();
    const { data: platformBankRow } = await serviceClient
      .from('platform_settings')
      .select('value')
      .eq('key', 'platform_bank_ng')
      .single();

    let platformSubaccountCode = '';

    // Step 3: Create platform subaccount on business's gateway account
    if (gateway === 'paystack' && platformBankRow?.value) {
      const bankDetails = platformBankRow.value as { bank_code: string; account_number: string; account_name: string };

      const res = await fetch('https://api.paystack.co/subaccount', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          business_name: `Waaiio Platform Fee`,
          settlement_bank: bankDetails.bank_code,
          account_number: bankDetails.account_number,
          percentage_charge: 100, // platform receives split as subaccount
          description: `Platform fee collection for ${biz.name}`,
        }),
      });

      const subData = await res.json();
      if (!subData.status || !subData.data?.subaccount_code) {
        return NextResponse.json({
          error: 'Could not create platform subaccount on your Paystack account. Check your bank details in platform settings.',
          details: subData.message || null,
        }, { status: 400 });
      }
      platformSubaccountCode = subData.data.subaccount_code;
    } else if (gateway === 'flutterwave' && platformBankRow?.value) {
      const bankDetails = platformBankRow.value as { bank_code: string; account_number: string; account_name: string };

      const res = await fetch('https://api.flutterwave.com/v3/subaccounts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          account_bank: bankDetails.bank_code,
          account_number: bankDetails.account_number,
          business_name: `Waaiio Platform Fee`,
          business_email: 'platform@waaiio.com',
          country: biz.country_code || 'NG',
          split_type: 'flat',
          split_value: 0,
        }),
      });

      const subData = await res.json();
      if (subData.status !== 'success' || !subData.data?.id) {
        return NextResponse.json({
          error: 'Could not create platform subaccount on your Flutterwave account.',
          details: subData.message || null,
        }, { status: 400 });
      }
      platformSubaccountCode = String(subData.data.id);
    } else if (gateway === 'stripe') {
      // Stripe uses Connect — no subaccount creation needed on business side
      // The existing stripe_account_id from Connect is the BYO mechanism
      platformSubaccountCode = 'stripe_connect';
    }

    // Step 4: Deactivate old credentials for this gateway, then store new ones
    await serviceClient
      .from('business_payment_credentials')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('gateway', gateway);

    const { data: cred, error: insertError } = await serviceClient
      .from('business_payment_credentials')
      .insert({
        business_id,
        gateway,
        secret_key,
        public_key: public_key || null,
        platform_subaccount_code: platformSubaccountCode,
        is_active: true,
        verified_at: new Date().toISOString(),
      })
      .select('id, gateway, platform_subaccount_code, verified_at')
      .single();

    if (insertError) {
      return NextResponse.json({ error: 'Failed to save credentials' }, { status: 500 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
    const webhookUrl = `${appUrl}/api/payments/byo-webhook/${business_id}`;

    return NextResponse.json({
      success: true,
      credential: cred,
      webhookUrl,
      message: `BYO ${gateway} credentials verified and saved. Set the webhook URL in your ${gateway} dashboard.`,
    });
  } catch (error) {
    logger.error('BYO credential setup error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to set up BYO credentials' }, { status: 500 });
  }
}

/**
 * DELETE: Remove BYO credentials (fall back to platform gateway)
 */
export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('business_id');
  const gateway = searchParams.get('gateway');

  if (!businessId) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 });
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  const serviceClient = createServiceClient();
  let query = serviceClient
    .from('business_payment_credentials')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('business_id', businessId);

  if (gateway) {
    query = query.eq('gateway', gateway);
  }

  await query;

  return NextResponse.json({ success: true, message: 'BYO credentials deactivated. Payments will use platform gateway.' });
}

/**
 * GET: Check if BYO credentials exist for a business
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('business_id');

  if (!businessId) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 });
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  const { data: creds } = await supabase
    .from('business_payment_credentials')
    .select('id, gateway, platform_subaccount_code, is_active, verified_at, created_at, connection_type, connect_account_id')
    .eq('business_id', businessId)
    .eq('is_active', true);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
  const webhookUrl = `${appUrl}/api/payments/byo-webhook/${businessId}`;

  return NextResponse.json({
    credentials: creds || [],
    webhookUrl,
  });
}
