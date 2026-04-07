import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/client';
import { kycApprovedEmail, kycRejectedEmail } from '@/lib/email/templates';
import { getPayoutLimit, formatPayoutLimit, type CountryCode, type VerificationLevel } from '@/lib/constants';

const LEVEL_LABELS: Record<string, string> = {
  unverified: 'Unverified',
  basic: 'Basic',
  standard: 'Standard',
  full: 'Full',
};

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { business_id, action, level, notes, reason, document_ids } = body;

  if (!business_id || !action) {
    return NextResponse.json(
      { error: 'Missing required fields: business_id, action' },
      { status: 400 },
    );
  }

  const { data: biz } = await supabase
    .from('businesses')
    .select('name, owner_id, country_code')
    .eq('id', business_id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  const cc = (biz.country_code || 'NG') as CountryCode;

  if (action === 'approve') {
    const verLevel = (level || 'basic') as VerificationLevel;
    const limit = getPayoutLimit(cc, verLevel);

    // Update business
    await supabase
      .from('businesses')
      .update({
        verification_level: verLevel,
        verification_status: 'verified',
        verification_notes: notes || null,
        verified_at: new Date().toISOString(),
        verified_by: user.id,
        payout_limit_monthly: limit,
      })
      .eq('id', business_id);

    // Approve specified documents
    if (document_ids?.length) {
      await supabase
        .from('business_documents')
        .update({
          status: 'approved',
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
        })
        .in('id', document_ids);
    }

    // Complete any pending verification requests
    await supabase
      .from('verification_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('status', 'pending');

    // Send email
    const { data: owner } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', biz.owner_id)
      .single();

    if (owner?.email) {
      const limitStr = formatPayoutLimit(cc, verLevel);
      const email = kycApprovedEmail(biz.name, LEVEL_LABELS[verLevel], limitStr);
      sendEmail({ to: owner.email, ...email }).catch(() => {});
    }

    // Audit log
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action: 'approve_verification',
      entity_type: 'business',
      entity_id: business_id,
      details: { level: verLevel, limit, country_code: cc },
    });

    return NextResponse.json({ success: true });
  }

  if (action === 'reject') {
    if (!reason) {
      return NextResponse.json({ error: 'Rejection reason is required' }, { status: 400 });
    }

    await supabase
      .from('businesses')
      .update({
        verification_status: 'rejected',
        verification_notes: reason,
      })
      .eq('id', business_id);

    // Reject specified documents
    if (document_ids?.length) {
      await supabase
        .from('business_documents')
        .update({
          status: 'rejected',
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          rejection_reason: reason,
        })
        .in('id', document_ids);
    }

    // Complete any pending requests
    await supabase
      .from('verification_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('status', 'pending');

    // Send email
    const { data: owner } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', biz.owner_id)
      .single();

    if (owner?.email) {
      const email = kycRejectedEmail(biz.name, reason);
      sendEmail({ to: owner.email, ...email }).catch(() => {});
    }

    // Audit log
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action: 'reject_verification',
      entity_type: 'business',
      entity_id: business_id,
      details: { reason },
    });

    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
