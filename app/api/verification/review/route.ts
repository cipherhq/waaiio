import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { kycApprovedEmail, kycRejectedEmail } from '@/lib/email/templates';
import { getPayoutLimit, formatPayoutLimit, type CountryCode, type VerificationLevel } from '@/lib/constants';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logAdminAudit } from '@/lib/admin-audit';
import { logger } from '@/lib/logger';

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

  // ── Pre-validate document IDs before any write ──
  // If document_ids are provided, verify they all belong to this business.
  // Any missing or foreign ID is a 400 with no writes.
  const requestedDocCount = document_ids?.length ?? 0;
  if (requestedDocCount > 0) {
    const { data: ownedDocs, error: docCheckError } = await supabase
      .from('business_documents')
      .select('id')
      .in('id', document_ids)
      .eq('business_id', business_id);

    if (docCheckError) {
      return NextResponse.json({ error: 'Failed to validate document IDs' }, { status: 500 });
    }

    const ownedCount = ownedDocs?.length ?? 0;
    if (ownedCount !== requestedDocCount) {
      const missing = requestedDocCount - ownedCount;
      return NextResponse.json({
        error: `${missing} of ${requestedDocCount} document ID(s) do not belong to this business or do not exist`,
      }, { status: 400 });
    }
  }

  if (action === 'approve') {
    const verLevel = (level || 'basic') as VerificationLevel;
    const limit = getPayoutLimit(cc, verLevel);

    // Write order: documents → verification requests → business (last)
    // Business is only marked verified after the other writes succeed.

    // 1. Approve specified documents
    if (requestedDocCount > 0) {
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
      if (!docsUpdated || docsUpdated.length !== requestedDocCount) {
        return NextResponse.json({
          error: `Document update affected ${docsUpdated?.length ?? 0} row(s), expected ${requestedDocCount}`,
        }, { status: 500 });
      }
    }

    // 2. Complete any pending verification requests
    const { error: reqUpdateError } = await supabase
      .from('verification_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('status', 'pending');

    if (reqUpdateError) {
      return NextResponse.json({ error: 'Failed to update verification requests' }, { status: 500 });
    }

    // 3. Update business LAST — only after documents and requests succeeded
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
      logger.error('[VERIFICATION] Business update failed after documents/requests were already written', {
        business_id, action: 'approve', level: verLevel,
      });
      return NextResponse.json({ error: 'Failed to update business verification — documents were already updated' }, { status: 500 });
    }
    if (!bizUpdated || bizUpdated.length === 0) {
      logger.error('[VERIFICATION] Business update affected no rows after documents/requests were already written', {
        business_id, action: 'approve', level: verLevel,
      });
      return NextResponse.json({ error: 'Business update affected no rows — documents were already updated' }, { status: 500 });
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

    // Write order: documents → verification requests → business (last)

    // 1. Reject specified documents
    if (requestedDocCount > 0) {
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
      if (!docsUpdatedReject || docsUpdatedReject.length !== requestedDocCount) {
        return NextResponse.json({
          error: `Document update affected ${docsUpdatedReject?.length ?? 0} row(s), expected ${requestedDocCount}`,
        }, { status: 500 });
      }
    }

    // 2. Complete any pending requests
    const { error: reqUpdateErrorReject } = await supabase
      .from('verification_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('business_id', business_id)
      .eq('status', 'pending');

    if (reqUpdateErrorReject) {
      return NextResponse.json({ error: 'Failed to update verification requests' }, { status: 500 });
    }

    // 3. Update business LAST
    const { data: bizUpdatedReject, error: bizUpdateError } = await supabase
      .from('businesses')
      .update({
        verification_status: 'rejected',
        verification_notes: reason,
      })
      .eq('id', business_id)
      .select('id');

    if (bizUpdateError) {
      logger.error('[VERIFICATION] Business update failed after documents/requests were already written', {
        business_id, action: 'reject',
      });
      return NextResponse.json({ error: 'Failed to update business verification — documents were already updated' }, { status: 500 });
    }
    if (!bizUpdatedReject || bizUpdatedReject.length === 0) {
      logger.error('[VERIFICATION] Business update affected no rows after documents/requests were already written', {
        business_id, action: 'reject',
      });
      return NextResponse.json({ error: 'Business update affected no rows — documents were already updated' }, { status: 500 });
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

  if (action === 'set_level') {
    // Platform admin can set ANY verification level with a required reason.
    // Used by admin panel Businesses page and Verification page.
    const VALID_LEVELS = ['unverified', 'basic', 'standard', 'full'];
    const targetLevel = level as VerificationLevel;

    if (!level || !VALID_LEVELS.includes(level)) {
      return NextResponse.json(
        { error: `level must be one of: ${VALID_LEVELS.join(', ')}` },
        { status: 400 },
      );
    }

    if (!reason) {
      return NextResponse.json({ error: 'Reason is required when changing verification level' }, { status: 400 });
    }

    // Read old state for audit
    const { data: oldState } = await supabase
      .from('businesses')
      .select('verification_level, verification_status, payout_limit_monthly')
      .eq('id', business_id)
      .single();

    const newLimit = getPayoutLimit(cc, targetLevel);
    const newStatus = targetLevel === 'unverified' ? 'unverified' : 'verified';

    const { data: updated, error: updateError } = await supabase
      .from('businesses')
      .update({
        verification_level: targetLevel,
        verification_status: newStatus,
        payout_limit_monthly: newLimit,
        verified_at: newStatus === 'verified' ? new Date().toISOString() : null,
        verified_by: newStatus === 'verified' ? admin.userId : null,
        verification_notes: reason,
      })
      .eq('id', business_id)
      .select('id, verification_level, verification_status, payout_limit_monthly');

    if (updateError || !updated || updated.length === 0) {
      return NextResponse.json({ error: 'Failed to update business verification level' }, { status: 500 });
    }

    await logAdminAudit({
      actorId: admin.userId,
      action: 'set_verification_level',
      entityType: 'business',
      entityId: business_id,
      details: {
        old_level: oldState?.verification_level,
        new_level: targetLevel,
        old_limit: oldState?.payout_limit_monthly,
        new_limit: newLimit,
        reason,
      },
    });

    return NextResponse.json({
      success: true,
      verification_level: updated[0].verification_level,
      verification_status: updated[0].verification_status,
      payout_limit_monthly: updated[0].payout_limit_monthly,
    });
  }

  if (action === 'set_custom_fees') {
    // Platform admin can set or clear custom fee overrides.
    const { custom_fee_percentage, custom_fee_flat } = body;

    if (!reason) {
      return NextResponse.json({ error: 'Reason is required when changing custom fees' }, { status: 400 });
    }

    const { data: oldFees } = await supabase
      .from('businesses')
      .select('custom_fee_percentage, custom_fee_flat')
      .eq('id', business_id)
      .single();

    const { data: updated, error: updateError } = await supabase
      .from('businesses')
      .update({
        custom_fee_percentage: custom_fee_percentage ?? null,
        custom_fee_flat: custom_fee_flat ?? null,
      })
      .eq('id', business_id)
      .select('id, custom_fee_percentage, custom_fee_flat');

    if (updateError || !updated || updated.length === 0) {
      return NextResponse.json({ error: 'Failed to update custom fees' }, { status: 500 });
    }

    await logAdminAudit({
      actorId: admin.userId,
      action: 'set_custom_fees',
      entityType: 'business',
      entityId: business_id,
      details: {
        old_fee_percentage: oldFees?.custom_fee_percentage,
        new_fee_percentage: custom_fee_percentage ?? null,
        old_fee_flat: oldFees?.custom_fee_flat,
        new_fee_flat: custom_fee_flat ?? null,
        reason,
      },
    });

    return NextResponse.json({
      success: true,
      custom_fee_percentage: updated[0].custom_fee_percentage,
      custom_fee_flat: updated[0].custom_fee_flat,
    });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
