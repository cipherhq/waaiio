import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/client';
import { payoutRejectedEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { requirePlatformAdmin } from '@/lib/admin-auth';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const supabase = await createClient();

  const body = await request.json();
  const { reason } = body;

  if (!reason) {
    return NextResponse.json({ error: 'Rejection reason is required' }, { status: 400 });
  }

  // Fetch the payout
  const { data: payout } = await supabase
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

  const { error: updateError } = await supabase
    .from('business_payouts')
    .update({
      status: 'rejected',
      rejected_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to reject payout' }, { status: 500 });
  }

  // Audit log
  await supabase.from('admin_audit_logs').insert({
    actor_id: admin.id,
    action: 'reject_payout',
    entity_type: 'business_payout',
    entity_id: id,
    details: {
      business_id: payout.business_id,
      amount: payout.net_amount,
      reason,
    },
  });

  // Send rejection email to business owner (non-blocking)
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, owner_id, country_code')
    .eq('id', payout.business_id)
    .single();
  if (biz) {
    const cc = (biz.country_code || 'NG') as CountryCode;
    const amountStr = formatCurrency(Number(payout.net_amount), cc);

    const { data: ownerProfile } = await supabase
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
      await supabase.from('notifications').insert({
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
