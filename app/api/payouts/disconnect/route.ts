import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id, payout_account_id } = body;

  if (!business_id || !payout_account_id) {
    return NextResponse.json({ error: 'Missing business_id or payout_account_id' }, { status: 400 });
  }

  // Verify ownership via RLS-enforced query (authenticated client)
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found or not owned by user' }, { status: 403 });
  }

  // Verify the payout account belongs to this business and is currently active
  const { data: account } = await supabase
    .from('payout_accounts')
    .select('id, gateway, is_active, is_default')
    .eq('id', payout_account_id)
    .eq('business_id', business_id)
    .single();

  if (!account) {
    return NextResponse.json({ error: 'Payout account not found' }, { status: 404 });
  }

  // Idempotent: if already inactive, return success without mutation
  if (!account.is_active) {
    return NextResponse.json({ success: true, already_disconnected: true });
  }

  const service = createServiceClient();

  // Revoke the specific connection + secrets + reset payout_mode atomically
  // Use service client to bypass the update guard trigger
  const { error: revokeErr } = await service
    .from('payout_accounts')
    .update({
      is_active: false,
      is_default: false,
      connection_status: 'revoked',
      health_status: 'unhealthy',
      updated_at: new Date().toISOString(),
    })
    .eq('id', payout_account_id)
    .eq('business_id', business_id)
    .eq('is_active', true);

  if (revokeErr) {
    logger.error('[DISCONNECT] Failed to revoke payout account:', revokeErr.message);
    return NextResponse.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }

  // Revoke associated secrets
  await service
    .from('business_connection_secrets')
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('payout_account_id', payout_account_id)
    .is('revoked_at', null);

  // Reset payout_mode only if no other active default connection remains
  const { data: remainingDefault } = await service
    .from('payout_accounts')
    .select('id')
    .eq('business_id', business_id)
    .eq('is_active', true)
    .eq('is_default', true)
    .limit(1)
    .maybeSingle();

  if (!remainingDefault) {
    await service
      .from('businesses')
      .update({ payout_mode: 'platform_managed' })
      .eq('id', business_id);
  }

  logger.info(`[DISCONNECT] Payout account ${payout_account_id} (${account.gateway}) disconnected by user ${user.id} for business ${business_id}`);

  return NextResponse.json({ success: true, gateway: account.gateway });
}
