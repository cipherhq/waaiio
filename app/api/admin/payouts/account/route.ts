import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Require admin or finance role
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (!profile || !['admin', 'finance'].includes(profile.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const payoutAccountId = searchParams.get('payout_account_id');
  const businessId = searchParams.get('business_id');

  if (!payoutAccountId || !businessId) {
    return NextResponse.json({ error: 'Missing payout_account_id or business_id' }, { status: 400 });
  }

  const service = createServiceClient();

  const { data: account } = await service
    .from('payout_accounts')
    .select('bank_name, account_name, account_number, is_active, verified_at')
    .eq('id', payoutAccountId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (!account) {
    return NextResponse.json({ error: 'Payout account not found' }, { status: 404 });
  }

  // Always mask account number — full number only needed server-side for actual transfers
  const maskedNumber = account.account_number
    ? '****' + account.account_number.slice(-4)
    : null;

  return NextResponse.json({
    bank_name: account.bank_name,
    account_name: account.account_name,
    account_number: maskedNumber,
    is_active: account.is_active,
    verified_at: account.verified_at,
  });
}
