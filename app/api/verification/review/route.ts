import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { kycApprovedEmail, kycRejectedEmail } from '@/lib/email/templates';
import { getPayoutLimit, formatPayoutLimit, type CountryCode, type VerificationLevel } from '@/lib/constants';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logAdminAudit } from '@/lib/admin-audit';

const LEVEL_LABELS: Record<string, string> = {
  unverified: 'Unverified',
  basic: 'Basic',
  standard: 'Standard',
  full: 'Full',
};

export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

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
    const { data: bizUpdated, error: bizUpdateError } = await supabase
      .from('businesses')
      .update({
        verification_level: verLevel,
        verification_status: 'verified',
        verification_notes: notes || null,
        verified_at: new Date().toISOString(),
        verified_by: admin.userId,
        payout_limit_monthly: limit,
      })
      .eq('id', business_id)
      .select('id');

    if (bizUpdateError) {
      return NextResponse.json({ error: 'Failed to update business verification' }, { status: 500 });
    }
    if (!bizUpdated || bizUpdated.length === 0) {
      return NextResponse.json({ error: 'Business update affected no rows' }, { status: 500 });
    }

    // Approve specified documents
    if (document_ids?.length) {
      const { data: docsUpdated, error: docsUpdateError } = await supabase
        .from('business_documents')
        .update({
          status: 'approved',
          reviewed_by: admin.userId,
          reviewed_at: new Date().toISOString(),
        })
        .in('id', document_ids)
        .eq('business_id', business_id)
        .select('id');

      if (docsUpdateError) {
        return NextResponse.json({ error: 'Failed to update business documents' }, { status: 500 });
      }
      if (!docsUpdated || docsUpdated.length === 0) {
        return NextResponse.json({ error: 'Document update affected no rows — document_ids may be invalid' }, { status: 500 });
      }
    }

    // Complete any pending verification requests
    const { data: reqUpdated, error: reqUpdateError } = await supabase
      .from('verification_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('status', 'pending')
      .select('id');

    if (reqUpdateError) {
      return NextResponse.json({ error: 'Failed to update verification requests' }, { status: 500 });
    }
    if (!reqUpdated || reqUpdated.length === 0) {
      console.log(`No pending verification requests found for business ${business_id} — continuing`);
    }

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
    await logAdminAudit({
      actorId: admin.userId,
      action: 'approve_verification',
      entityType: 'business',
      entityId: business_id,
      details: { level: verLevel, limit, country_code: cc },
    });

    return NextResponse.json({ success: true });
  }

  if (action === 'reject') {
    if (!reason) {
      return NextResponse.json({ error: 'Rejection reason is required' }, { status: 400 });
    }

    const { data: bizUpdatedReject, error: bizUpdateError } = await supabase
      .from('businesses')
      .update({
        verification_status: 'rejected',
        verification_notes: reason,
      })
      .eq('id', business_id)
      .select('id');

    if (bizUpdateError) {
      return NextResponse.json({ error: 'Failed to update business verification' }, { status: 500 });
    }
    if (!bizUpdatedReject || bizUpdatedReject.length === 0) {
      return NextResponse.json({ error: 'Business update affected no rows' }, { status: 500 });
    }

    // Reject specified documents
    if (document_ids?.length) {
      const { data: docsUpdatedReject, error: docsUpdateError } = await supabase
        .from('business_documents')
        .update({
          status: 'rejected',
          reviewed_by: admin.userId,
          reviewed_at: new Date().toISOString(),
          rejection_reason: reason,
        })
        .in('id', document_ids)
        .eq('business_id', business_id)
        .select('id');

      if (docsUpdateError) {
        return NextResponse.json({ error: 'Failed to update business documents' }, { status: 500 });
      }
      if (!docsUpdatedReject || docsUpdatedReject.length === 0) {
        return NextResponse.json({ error: 'Document update affected no rows — document_ids may be invalid' }, { status: 500 });
      }
    }

    // Complete any pending requests
    const { data: reqUpdatedReject, error: reqUpdateErrorReject } = await supabase
      .from('verification_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('status', 'pending')
      .select('id');

    if (reqUpdateErrorReject) {
      return NextResponse.json({ error: 'Failed to update verification requests' }, { status: 500 });
    }
    if (!reqUpdatedReject || reqUpdatedReject.length === 0) {
      console.log(`No pending verification requests found for business ${business_id} — continuing`);
    }

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
    await logAdminAudit({
      actorId: admin.userId,
      action: 'reject_verification',
      entityType: 'business',
      entityId: business_id,
      details: { reason },
    });

    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
