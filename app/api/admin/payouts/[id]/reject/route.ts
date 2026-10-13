import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutRejectedEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { logAdminAudit } from '@/lib/admin-audit';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const serviceClient = createServiceClient();

  const body = await request.json();
  const { reason, stepUpId } = body;

  if (!reason) {
    return NextResponse.json({ error: 'Rejection reason is required' }, { status: 400 });
  }

  // Fetch the payout BEFORE consuming step-up so we don't burn the token
  // if the payout doesn't exist or is in an invalid status
  const { data: payout } = await serviceClient
    .from('business_payouts')
    .select('id, business_id, net_amount, status')
    .eq('id', id)
    .single();

  if (!payout) {
    return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
  }

  if (!['pending', 'approved'].includes(payout.status)) {
    return NextResponse.json({ error: 'Payout cannot be rejected in current status' }, { status: 400 });
  }

  // SEC-005 Layer 4: Consume operation-bound step-up authorization
  try {
    await consumeStepUp(admin, stepUpId, 'payout_reject', id, { reason });
  } catch (err) {
    const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
    return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403 });
  }

  // Atomic reject: include status guard in UPDATE to prevent TOCTOU race
  // SEC-005: uses service client — authenticated DML revoked on business_payouts.
  const { data: updated, error: updateError } = await serviceClient
    .from('business_payouts')
    .update({
      status: 'rejected',
      rejected_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['pending', 'approved'])
    .select('id')
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: 'Failed to reject payout' }, { status: 500 });
  }

  if (!updated) {
    return NextResponse.json({ error: 'Payout status has changed — please refresh and try again' }, { status: 409 });
  }

  // Audit log
  await logAdminAudit({
    actorId: admin.id,
    action: 'reject_payout',
    entityType: 'business_payout',
    entityId: id,
    details: {
      business_id: payout.business_id,
      amount: payout.net_amount,
      reason,
    },
  });

  // Send rejection email to business owner (non-blocking)
  const { data: biz } = await serviceClient
    .from('businesses')
    .select('name, owner_id, country_code')
    .eq('id', payout.business_id)
    .single();
  if (biz) {
    const cc = (biz.country_code || 'NG') as CountryCode;
    const amountStr = formatCurrency(Number(payout.net_amount), cc);

    const { data: ownerProfile } = await serviceClient
      .from('profiles')
      .select('email')
      .eq('id', biz.owner_id)
      .single();
    if (ownerProfile?.email) {
      const email = payoutRejectedEmail(biz.name, amountStr, reason);
      sendEmail({ to: ownerProfile.email, ...email }).catch(() => {});
    }

    // Create in-app notification
    try {
      await serviceClient.from('notifications').insert({
        business_id: payout.business_id,
        type: 'payment',
        channel: 'email',
        status: 'sent',
        subject: `Payout rejected — ${amountStr}`,
        body: `Your payout of ${amountStr} for ${biz.name} was rejected. Reason: ${reason}`,
        sent_at: new Date().toISOString(),
      });
    } catch { /* non-critical */ }
  }

  return NextResponse.json({ success: true });
}
