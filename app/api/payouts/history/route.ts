import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

const PAYOUT_COLUMNS = 'id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, transfer_method, transfer_reference, notes, paid_at, created_at, payout_account_id, flags';

// M446 permits these authenticated columns; do not use a service client or
// provider account identifiers to explain a merchant's linked destination.
const ACCOUNT_COLUMNS = 'id, business_id, gateway, bank_name, account_number';
const NO_CONTEXT = 'No further reason recorded.';
const REASONS: Record<string, string> = {
  cooling_period: 'A business cooling-period review was recorded.',
  unverified: 'Business verification was required.',
  over_limit: 'A payout limit review was recorded.',
  verification_limit_exceeded: 'A verification-tier payout limit was exceeded.',
  high_velocity: 'Transaction activity was flagged for review.',
  large_payout: 'The payout amount was flagged for review.',
  adjustment_link_pending: 'Payout adjustments were awaiting reconciliation.',
  adjustment_link_failed: 'Payout adjustments required reconciliation.',
  currency_review: 'Payout currency required manual review.',
};
const LEGACY_REASONS: Record<string, string> = {
  'No payout account configured': 'No payout account was configured.',
  'Payout account not eligible for Paystack transfer': 'The linked account was not eligible for automated transfer.',
  'No eligible provider for automated transfer': 'Automated transfer was not available for this payout.',
  'Business too new (cooling period)': REASONS.cooling_period,
  'High transaction velocity': REASONS.high_velocity,
  'Amount exceeds auto-approve limit': REASONS.large_payout,
  'Business not verified': REASONS.unverified,
};
function recordedContext(flags: unknown): string[] {
  if (!Array.isArray(flags) || flags.length === 0) return [NO_CONTEXT];
  return [...new Set(flags.map((flag: unknown) => {
    if (typeof flag === 'string') return Object.hasOwn(LEGACY_REASONS, flag) ? LEGACY_REASONS[flag] : NO_CONTEXT;
    if (!flag || typeof flag !== 'object') return NO_CONTEXT;
    const value = flag as { type?: unknown; message?: unknown };
    if (typeof value.type === 'string' && Object.hasOwn(REASONS, value.type)) return REASONS[value.type];
    if (value.type === 'hold_reason' && typeof value.message === 'string' && Object.hasOwn(LEGACY_REASONS, value.message)) {
      return LEGACY_REASONS[value.message];
    }
    return NO_CONTEXT;
  }))];
}
function statusExplanation(status: string, method: string | null): string {
  switch (status) {
    case 'pending': return 'Awaiting payout review. A transfer is not confirmed.';
    case 'held': return 'On hold for review. See recorded context below.';
    case 'approved': return method === 'manual_bank'
      ? 'Approved for manual bank transfer; settlement confirmation has not been recorded.'
      : 'Approved for payout. Payment has not been recorded as complete.';
    case 'processing': return 'Claimed for processing. This does not confirm provider dispatch or receipt.';
    case 'review_required': return 'The transfer outcome requires review; neither success nor failure is confirmed.';
    case 'paid': return 'Payout settlement is recorded as paid.';
    case 'failed': return 'The payout is recorded as failed.';
    case 'rejected': return 'The payout was rejected.';
    default: return 'No explanation is available for this recorded status.';
  }
}
type LinkedAccount = {
  id: string; business_id: string; gateway: string | null;
  bank_name: string | null; account_number: string | null;
};
function linkedDestination(account: LinkedAccount | undefined): string {
  if (!account) return 'Unavailable — no linked payout account details recorded.';
  const providers: Record<string, string> = {
    paystack: 'Paystack', stripe: 'Stripe', flutterwave: 'Flutterwave', square: 'Square', paypal: 'PayPal',
  };
  const provider = account.gateway && Object.hasOwn(providers, account.gateway) ? providers[account.gateway] : 'Provider';
  const number = typeof account.account_number === 'string' ? account.account_number.trim() : '';
  // Very short values must not expose the complete stored account number.
  const masked = number ? '****' + (number.length > 4 ? number.slice(-4) : '') : '';
  return [provider, account.bank_name, masked || 'Bank details not recorded'].filter(Boolean).join(' · ');
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const businessId = params.get('business_id');
  const fetchAll = params.get('all') === 'true';
  const page = Math.max(1, parseInt(params.get('page') || '1'));
  const status = params.get('status') || 'all';
  const perPage = 20;

  if (!businessId) {
    return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });
  }

  // Verify the user owns this business
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  try {
    let query = supabase
      .from('business_payouts')
      .select(PAYOUT_COLUMNS, { count: 'exact' })
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (!fetchAll) {
      query = query.range((page - 1) * perPage, page * perPage - 1);
    }

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, count, error } = await query;

    if (error) {
      logger.error('Payout history error:', error);
      return NextResponse.json({ error: 'Failed to fetch payout history' }, { status: 500 });
    }

    const records = data || [];
    const accountIds = [...new Set(records.map(p => p.payout_account_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
    let accounts: LinkedAccount[] = [];
    if (accountIds.length > 0) {
      const { data: linked, error: accountError } = await supabase
        .from('payout_accounts')
        .select(ACCOUNT_COLUMNS)
        .eq('business_id', businessId)
        .in('id', accountIds);
      if (accountError) {
        logger.error('Payout destination lookup failed');
        return NextResponse.json({ error: 'Failed to fetch payout history' }, { status: 500 });
      }
      accounts = linked || [];
    }
    const accountById = new Map(accounts.filter(a => a.business_id === businessId).map(a => [a.id, a]));
    const payouts = records.map(p => ({
      id: p.id, period_start: p.period_start, period_end: p.period_end,
      gross_amount: p.gross_amount, platform_fee: p.platform_fee, gateway_fee: p.gateway_fee,
      net_amount: p.net_amount, status: p.status, transfer_method: p.transfer_method,
      transfer_reference: p.transfer_reference, notes: p.notes, paid_at: p.paid_at, created_at: p.created_at,
      status_explanation: statusExplanation(p.status, p.transfer_method),
      recorded_context: recordedContext(p.flags),
      linked_destination: linkedDestination(accountById.get(p.payout_account_id)),
    }));

    return NextResponse.json({
      payouts,
      total: count || 0,
      page,
      per_page: perPage,
      total_pages: Math.ceil((count || 0) / perPage),
    });
  } catch (error) {
    logger.error('History error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
  }
}
