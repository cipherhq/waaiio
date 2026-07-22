import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutPaidEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import { logger } from '@/lib/logger';

/**
 * Mark an approved payout as paid (manual completion step).
 * Requires: transfer_reference (mandatory), notes (optional).
 * Only works on status='approved' payouts.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (process.env.ENABLE_PAYOUTS !== 'true') {
    return NextResponse.json({ error: 'Payouts are currently disabled' }, { status: 503 });
  }

  const { id } = await params;
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
  }

  const body = await request.json();
  const { transfer_reference, notes } = body;

  if (!transfer_reference || typeof transfer_reference !== 'string' || !transfer_reference.trim()) {
    return NextResponse.json({ error: 'transfer_reference is required' }, { status: 400 });
  }

  // Fetch payout
  const { data: payout } = await service
    .from('business_payouts')
    .select('id, status, business_id, net_amount, transfer_reference, notes')
    .eq('id', id)
    .single();

  if (!payout) return NextResponse.json({ error: 'Payout not found' }, { status: 404 });

  if (payout.status === 'paid') {
    return NextResponse.json({ error: 'Payout is already paid' }, { status: 409 });
  }

  if (payout.status !== 'approved') {
    return NextResponse.json({ error: 'Payout must be approved before marking as paid' }, { status: 400 });
  }

  // Compare-and-set: claim completion
  const { data: claimed, error: claimError } = await service
    .from('business_payouts')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      transfer_reference: transfer_reference.trim(),
      notes: notes || payout.notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['approved'])
    .select('id')
    .maybeSingle();

  if (claimError || !claimed) {
    return NextResponse.json({ error: 'Payout was already completed or status changed' }, { status: 409 });
  }

  // Mandatory audit log
  const { error: auditError } = await service.from('admin_audit_logs').insert({
    actor_id: user.id,
    action: 'complete_payout',
    entity_type: 'business_payout',
    entity_id: id,
    details: {
      business_id: payout.business_id,
      amount: payout.net_amount,
      transfer_reference: transfer_reference.trim(),
    },
  });

  if (auditError) {
    // Revert completion
    await service.from('business_payouts')
      .update({ status: 'approved', paid_at: null, transfer_reference: payout.transfer_reference, notes: payout.notes, updated_at: new Date().toISOString() })
      .eq('id', id);
    logger.error(`[ADMIN-PAYOUT] Audit failed on completion, reverted for ${id}:`, auditError.message);
    return NextResponse.json({ error: 'Audit logging failed' }, { status: 500 });
  }

  // Non-blocking notification
  try {
    const { data: biz } = await service
      .from('businesses')
      .select('name, owner_id, country_code')
      .eq('id', payout.business_id)
      .single();
    if (biz) {
      const cc = (biz.country_code || 'NG') as CountryCode;
      const countryConfig = getCountry(cc);
      const amountStr = formatCurrency(Number(payout.net_amount), cc);
      const { data: ownerProfile } = await service.from('profiles').select('email').eq('id', biz.owner_id).single();
      if (ownerProfile?.email) {
        sendEmail({ to: ownerProfile.email, ...payoutPaidEmail(biz.name, amountStr, transfer_reference.trim()) }).catch(() => {});
      }
    }
  } catch {
    // Non-blocking — payout is already marked paid
  }

  return NextResponse.json({ success: true, status: 'paid' });
}
