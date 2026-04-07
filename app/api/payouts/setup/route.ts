import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id, gateway, bank_code, bank_name, account_number, account_name } = body;

  if (!business_id || !gateway || !bank_code || !account_number || !account_name) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Verify the user owns this business
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, payout_mode')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  try {
    let subaccountCode = '';
    const isDirectSplit = biz.payout_mode === 'direct_split';

    // Platform-managed mode: save bank details only, skip gateway subaccount creation
    if (!isDirectSplit) {
      // Deactivate any existing payout accounts for this business
      await supabase
        .from('payout_accounts')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('business_id', business_id)
        .eq('is_active', true);

      // Insert payout account with bank details only (no subaccount)
      const { data: payout, error: insertError } = await supabase
        .from('payout_accounts')
        .insert({
          business_id,
          gateway,
          subaccount_code: null,
          bank_code,
          bank_name: bank_name || '',
          account_number,
          account_name,
          platform_percentage: 2.5,
          is_active: true,
          verified_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (insertError) {
        console.error('Insert payout account error:', insertError);
        return NextResponse.json({ error: 'Failed to save payout account' }, { status: 500 });
      }

      return NextResponse.json({ success: true, payout_account_id: payout.id });
    }

    // Direct split mode: create gateway subaccount
    if (gateway === 'paystack') {
      if (!paystackSecretKey) {
        subaccountCode = `ACCT_mock_${Date.now()}`;
      } else {
        const res = await fetch('https://api.paystack.co/subaccount', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            business_name: biz.name,
            settlement_bank: bank_code,
            account_number,
            percentage_charge: 2.5, // Platform's cut
          }),
        });
        const data = await res.json();
        if (!data.status) {
          return NextResponse.json({ error: data.message || 'Failed to create subaccount' }, { status: 400 });
        }
        subaccountCode = data.data.subaccount_code;
      }
    } else if (gateway === 'flutterwave') {
      if (!flutterwaveSecretKey) {
        subaccountCode = `FLW_mock_${Date.now()}`;
      } else {
        const res = await fetch('https://api.flutterwave.com/v3/subaccounts', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${flutterwaveSecretKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            account_bank: bank_code,
            account_number,
            business_name: biz.name,
            business_email: `${business_id}@waaiio.com`,
            country: 'NG',
            split_type: 'percentage',
            split_value: 2.5,
          }),
        });
        const data = await res.json();
        if (data.status !== 'success') {
          return NextResponse.json({ error: data.message || 'Failed to create subaccount' }, { status: 400 });
        }
        subaccountCode = String(data.data.id);
      }
    } else {
      return NextResponse.json({ error: 'Unsupported gateway for bank setup' }, { status: 400 });
    }

    // Deactivate any existing payout accounts for this business
    await supabase
      .from('payout_accounts')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('is_active', true);

    // Insert new payout account
    const { data: payout, error: insertError } = await supabase
      .from('payout_accounts')
      .insert({
        business_id,
        gateway,
        subaccount_code: subaccountCode,
        bank_code,
        bank_name: bank_name || '',
        account_number,
        account_name,
        platform_percentage: 2.5,
        is_active: true,
        verified_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Insert payout account error:', insertError);
      return NextResponse.json({ error: 'Failed to save payout account' }, { status: 500 });
    }

    return NextResponse.json({ success: true, payout_account_id: payout.id });
  } catch (error) {
    console.error('Setup payout error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to create payout account' }, { status: 500 });
  }
}
