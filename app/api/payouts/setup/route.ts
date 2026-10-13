import { NextRequest, NextResponse } from 'next/server';
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

  const { error: authError } = await supabase.auth.signInWithPassword({
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

    // Check for existing active account (for notification wording)
    const { data: existingAccount } = await service
      .from('payout_accounts')
      .select('id')
      .eq('business_id', business_id)
      .eq('is_active', true)
      .maybeSingle();

    // Use provider-returned name when available, client-sent name as fallback
    const storedAccountName = verifiedAccountName || account_name || account_number;

    // Insert new payout account first (service client).
    // We insert with is_active = false, then atomically swap: deactivate old, activate new.
    // This ensures the business is never left without an active account if insert fails.
    const { data: payout, error: insertError } = await service
      .from('payout_accounts')
      .insert({
        business_id,
        gateway,
        subaccount_code: subaccountCode,
        bank_code,
        bank_name: bank_name || '',
        account_number,
        account_name: storedAccountName,
        platform_percentage: 2.5,
        is_active: false, // inserted inactive; activated below after old is deactivated
        verified_at: verifiedAt,
      })
      .select('id')
      .single();

    if (insertError) {
      logger.error('Insert payout account error:', insertError);
      return NextResponse.json({ error: 'Failed to save payout account' }, { status: 500 });
    }

    // Deactivate any existing payout accounts (service client bypasses RLS)
    if (existingAccount) {
      const { error: deactivateError } = await service
        .from('payout_accounts')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('business_id', business_id)
        .eq('is_active', true);

      if (deactivateError) {
        logger.error('Deactivate payout account error:', deactivateError);
        // Clean up the newly inserted (inactive) record
        await service.from('payout_accounts').delete().eq('id', payout.id);
        return NextResponse.json({ error: 'Failed to update payout account' }, { status: 500 });
      }
    }

    // Activate the new account
    const { error: activateError } = await service
      .from('payout_accounts')
      .update({ is_active: true })
      .eq('id', payout.id);

    if (activateError) {
      logger.error('Activate payout account error:', activateError);
      return NextResponse.json({ error: 'Failed to activate payout account' }, { status: 500 });
    }

    // Send notification email
    const action = existingAccount ? 'changed' : 'connected';
    sendEmail({
      to: user.email!,
      subject: `Payout account ${action} — ${biz.name}`,
      html: `<p>The payout account for <strong>${biz.name}</strong> has been ${action}.</p><p>If this wasn't you, contact support immediately.</p>`,
    }).catch(e => logger.error('Failed to send payout notification:', e));

    return NextResponse.json({
      success: true,
      payout_account_id: payout.id,
      verified: !!verifiedAt,
      account_name: storedAccountName,
    });
  } catch (error) {
    logger.error('Setup payout error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to create payout account' }, { status: 500 });
  }
}
