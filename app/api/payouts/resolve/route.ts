import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
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
  const { gateway, bank_code, account_number } = body;

  if (!gateway || !bank_code || !account_number) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  try {
    let accountName = '';

    if (gateway === 'paystack') {
      if (!paystackSecretKey) {
        return NextResponse.json({ account_name: 'JOHN DOE (Mock)' });
      }
      const res = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`,
        { headers: { Authorization: `Bearer ${paystackSecretKey}` } },
      );
      const data = await res.json();
      if (!data.status) {
        return NextResponse.json({ error: data.message || 'Could not resolve account' }, { status: 400 });
      }
      accountName = data.data.account_name;
    } else if (gateway === 'flutterwave') {
      if (!flutterwaveSecretKey) {
        return NextResponse.json({ account_name: 'JOHN DOE (Mock)' });
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
    return NextResponse.json({ error: 'Failed to resolve account' }, { status: 500 });
  }
}
