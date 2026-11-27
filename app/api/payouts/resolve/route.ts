import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit/log';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';

// Owner decision 2026-11-27: 10 account-name lookups per user per hour.
const LOOKUPS_PER_HOUR = 10;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Records one account-name lookup in audit_log. Only the last 4 digits of the
 * account number are stored. A failed write is logged and never blocks the
 * response.
 */
async function recordLookup(params: {
  userId: string;
  businessId: string;
  bankCode: string;
  accountNumber: string;
  ok: boolean;
}) {
  try {
    const { error } = await logAudit(createServiceClient(), {
      businessId: params.businessId,
      userId: params.userId,
      action: 'payout_account_lookup',
      entityType: 'payout',
      changes: {
        bank_code: params.bankCode,
        account_last4: String(params.accountNumber).slice(-4),
        result: params.ok ? 'ok' : 'fail',
        looked_up_at: new Date().toISOString(),
      },
    });
    if (error) logger.error('Payout lookup audit write failed:', error.message);
  } catch (err) {
    logger.error('Payout lookup audit write failed:', (err as Error).message);
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id, gateway, bank_code, account_number } = body;

  if (!gateway || !bank_code || !account_number) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  if (gateway === 'flutterwave') {
    return NextResponse.json({ error: 'Flutterwave is unavailable for new payout setup' }, { status: 400 });
  }

  // Reject test bank code in production
  if (bank_code === '001' && (process.env.WAAIIO_ENVIRONMENT === 'production' || !paystackSecretKey.startsWith('sk_test_'))) {
    return NextResponse.json({ error: 'Invalid bank' }, { status: 400 });
  }

  // Only the business owner may look up payout account names (same rule as payout setup)
  if (!business_id) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const limited = await rateLimitResponseAsync(`payout-resolve:${user.id}`, LOOKUPS_PER_HOUR, ONE_HOUR_MS);
  if (limited) return limited;

  let lookupRecorded = false;
  try {
    let accountName = '';

    if (gateway === 'paystack') {
      if (!paystackSecretKey) {
        return NextResponse.json(
          { error: 'Payment provider not configured' },
          { status: 503 },
        );
      }
      const res = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`,
        { headers: { Authorization: `Bearer ${paystackSecretKey}` } },
      );
      const data = await res.json();
      const ok = !!data.status;
      lookupRecorded = true;
      await recordLookup({ userId: user.id, businessId: business_id, bankCode: bank_code, accountNumber: account_number, ok });
      if (!ok) {
        return NextResponse.json({ error: data.message || 'Could not resolve account' }, { status: 400 });
      }
      accountName = data.data.account_name;
    } else if (gateway === 'flutterwave') {
      if (!flutterwaveSecretKey) {
        return NextResponse.json(
          { error: 'Payment provider not configured' },
          { status: 503 },
        );
      }
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
        return NextResponse.json({ error: data.message || 'Could not resolve account' }, { status: 400 });
      }
      accountName = data.data.account_name;
    } else {
      return NextResponse.json({ error: 'Unsupported gateway' }, { status: 400 });
    }

    return NextResponse.json({ account_name: accountName });
  } catch (error) {
    logger.error('Resolve account error:', (error as Error).message);
    if (gateway === 'paystack' && paystackSecretKey && !lookupRecorded) {
      await recordLookup({ userId: user.id, businessId: business_id, bankCode: bank_code, accountNumber: account_number, ok: false });
    }
    return NextResponse.json({ error: 'Failed to resolve account' }, { status: 500 });
  }
}
