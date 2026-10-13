import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id, gateway, bank_code, bank_name, account_number, account_name, password } = body;

  if (!business_id || !gateway || !bank_code || !account_number) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Re-authentication required
  if (!password || typeof password !== 'string') {
    return NextResponse.json({ error: 'Password required for payout account changes' }, { status: 403 });
  }

  if (!user.email) {
    return NextResponse.json({ error: 'User email not found' }, { status: 400 });
  }

  // Verify password with a throwaway client so the session cookies are not rotated
  const authCheck = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error: authError } = await authCheck.auth.signInWithPassword({
    email: user.email,
    password,
  });
  if (authError) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 403 });
  }

  // Verify the user owns this business (session client enforces RLS)
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, payout_mode, country_code')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  const service = createServiceClient();

  try {
    // Provider verification: resolve account name from the payment provider
    let verifiedAccountName: string | null = null;
    let verifiedAt: string | null = null;

    if (gateway === 'paystack') {
      if (paystackSecretKey) {
        const res = await fetch(
          `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`,
          { headers: { Authorization: `Bearer ${paystackSecretKey}` } },
        );
        const data = await res.json();
        if (!data.status) {
          return NextResponse.json(
            { error: data.message || 'Account verification failed' },
            { status: 400 },
          );
        }
        verifiedAccountName = data.data.account_name;
        verifiedAt = new Date().toISOString();
      }
      // No key: save unverified (verified_at = null)
    } else if (gateway === 'flutterwave') {
      if (flutterwaveSecretKey) {
        const res = await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${flutterwaveSecretKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ account_number, account_bank: bank_code }),
        });
        const data = await res.json();
        if (data.status !== 'success') {
          return NextResponse.json(
            { error: data.message || 'Account verification failed' },
            { status: 400 },
          );
        }
        verifiedAccountName = data.data.account_name;
        verifiedAt = new Date().toISOString();
      }
      // No key: save unverified (verified_at = null)
    } else {
      return NextResponse.json({ error: 'Unsupported gateway for bank setup' }, { status: 400 });
    }

    // Subaccount creation for direct_split mode
    let subaccountCode: string | null = null;
    const isDirectSplit = biz.payout_mode === 'direct_split';

    if (isDirectSplit) {
      if (gateway === 'paystack' && paystackSecretKey) {
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
            percentage_charge: 2.5,
          }),
        });
        const data = await res.json();
        if (!data.status) {
          return NextResponse.json(
            { error: data.message || 'Failed to create subaccount' },
            { status: 400 },
          );
        }
        subaccountCode = data.data.subaccount_code;
      } else if (gateway === 'flutterwave' && flutterwaveSecretKey) {
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
            country: biz.country_code || 'NG',
            split_type: 'percentage',
            split_value: 2.5,
          }),
        });
        const data = await res.json();
        if (data.status !== 'success') {
          return NextResponse.json(
            { error: data.message || 'Failed to create subaccount' },
            { status: 400 },
          );
        }
        subaccountCode = String(data.data.id);
      }
      // No key in direct_split: subaccountCode stays null
    }

    // Use provider-returned name when available, client-sent name as fallback
    const storedAccountName = verifiedAccountName || account_name || account_number;

    // Atomic swap: deactivate old account + insert new one in a single transaction
    const { data: newId, error: rpcError } = await service.rpc('swap_payout_account', {
      p_business_id: business_id,
      p_gateway: gateway,
      p_bank_code: bank_code,
      p_bank_name: bank_name || '',
      p_account_number: account_number,
      p_account_name: storedAccountName,
      p_subaccount_code: subaccountCode,
      p_verified_at: verifiedAt,
    });

    if (rpcError || !newId) {
      logger.error('swap_payout_account RPC error:', rpcError || 'no id returned');
      return NextResponse.json({ error: 'Failed to save payout account' }, { status: 500 });
    }

    // Send notification email
    sendEmail({
      to: user.email!,
      subject: `Payout account updated — ${biz.name}`,
      html: `<p>The payout account for <strong>${biz.name}</strong> has been updated.</p><p>If this wasn't you, contact support immediately.</p>`,
    }).catch(e => logger.error('Failed to send payout notification:', e));

    return NextResponse.json({
      success: true,
      payout_account_id: newId,
      verified: !!verifiedAt,
      account_name: storedAccountName,
    });
  } catch (error) {
    logger.error('Setup payout error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to create payout account' }, { status: 500 });
  }
}
