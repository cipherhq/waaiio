import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { PRICING_TIERS, type SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { business_id, bank_code, bank_name, account_number, account_name } = await request.json();
  if (!business_id || !bank_code || !account_number || !account_name) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Verify user owns this business
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, email, country_code, subscription_tier')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  try {
    // percentage_charge = what the platform keeps per transaction
    const tier = PRICING_TIERS[(biz.subscription_tier || 'free') as SubscriptionTier];
    const platformFeePercentage = tier ? tier.feePercentage : 5;

    if (!paystackSecretKey) {
      // Mock mode for development
      const mockCode = `MOCK_SUBACCOUNT_${Date.now()}`;
      const serviceClient = createServiceClient();

      await serviceClient
        .from('business_payment_credentials')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('business_id', business_id)
        .eq('is_active', true);

      const { error: mockInsertError } = await serviceClient
        .from('business_payment_credentials')
        .insert({
          business_id,
          gateway: 'paystack',
          platform_subaccount_code: mockCode,
          connect_account_id: mockCode,
          connection_type: 'connect',
          secret_key: null,
          verified_at: new Date().toISOString(),
          is_active: true,
        });

      if (mockInsertError) {
        logger.error('Mock insert error:', mockInsertError);
        return NextResponse.json({ error: 'Failed to save credentials' }, { status: 500 });
      }

      return NextResponse.json({ success: true, subaccount_code: mockCode });
    }

    // Create subaccount on platform's Paystack account
    const response = await fetch('https://api.paystack.co/subaccount', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${paystackSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        business_name: biz.name,
        settlement_bank: bank_code,
        account_number,
        percentage_charge: platformFeePercentage,
        description: `${biz.name} — connected via Waaiio`,
      }),
    });

    const data = await response.json();

    if (!data.status || !data.data) {
      logger.error('Paystack subaccount creation failed:', data);
      return NextResponse.json({
        error: data.message || 'Failed to create Paystack subaccount',
      }, { status: 400 });
    }

    const subaccountCode = data.data.subaccount_code;

    // Deactivate existing BYO credentials for this business
    const serviceClient = createServiceClient();
    await serviceClient
      .from('business_payment_credentials')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('is_active', true);

    // Insert new credential with subaccount code
    // connect_account_id is set to satisfy chk_credentials_mode constraint
    const { error: insertError } = await serviceClient
      .from('business_payment_credentials')
      .insert({
        business_id,
        gateway: 'paystack',
        platform_subaccount_code: subaccountCode,
        connect_account_id: subaccountCode,
        connection_type: 'connect',
        secret_key: null,
        verified_at: new Date().toISOString(),
        is_active: true,
      });

    if (insertError) {
      logger.error('Credential insert error:', insertError);
      return NextResponse.json({ error: 'Failed to save credentials' }, { status: 500 });
    }

    return NextResponse.json({ success: true, subaccount_code: subaccountCode });
  } catch (error) {
    logger.error('Paystack subaccount error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to create Paystack subaccount' }, { status: 500 });
  }
}
