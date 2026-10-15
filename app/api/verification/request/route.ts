import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { kycRequestedEmail } from '@/lib/email/templates';
import { getDocTypeLabel, type CountryCode } from '@/lib/constants';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logAdminAudit } from '@/lib/admin-audit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  const body = await request.json();
  const { business_id, requested_level, documents_required, message } = body;

  if (!business_id || !requested_level) {
    return NextResponse.json(
      { error: 'Missing required fields: business_id, requested_level' },
      { status: 400 },
    );
  }

  // Option B: update business status first, then insert request.
  // If the insert fails, restore the captured status.
  // This avoids the half-done state where a request exists but the
  // business status is stale (the dangerous inconsistency).

  // 1. Capture the current verification_status so we can restore on failure
  const { data: biz, error: bizError } = await supabase
    .from('businesses')
    .select('name, owner_id, country_code, verification_status')
    .eq('id', business_id)
    .single();

  if (bizError || !biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  const previousStatus = biz.verification_status;

  // 2. Update business status to pending FIRST (the step that can fail harmlessly)
  const { error: updateError } = await supabase
    .from('businesses')
    .update({ verification_status: 'pending' })
    .eq('id', business_id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update business verification status' }, { status: 500 });
  }

  // 3. Insert the verification request
  const { data: req, error: insertError } = await supabase
    .from('verification_requests')
    .insert({
      business_id,
      requested_level,
      requested_by: admin.userId,
      documents_required: documents_required || [],
      message: message || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError) {
    // Compensate: restore the original verification_status using CAS —
    // only overwrite if still 'pending' (what we set it to). If a concurrent
    // review changed it to 'verified' or 'rejected', don't overwrite.
    const { data: restored, error: restoreError } = await supabase
      .from('businesses')
      .update({ verification_status: previousStatus })
      .eq('id', business_id)
      .eq('verification_status', 'pending')
      .select('id');

    if (restoreError) {
      logger.error('[VERIFICATION] Failed to restore verification_status after insert failure', {
        business_id,
        previous_status: previousStatus,
        insert_error: insertError.message,
        restore_error: restoreError.message,
      });
      return NextResponse.json({
        error: 'Failed to create verification request and failed to restore business status — manual intervention required',
      }, { status: 500 });
    }

    if (!restored || restored.length === 0) {
      // CAS matched zero rows — check if a concurrent change happened
      const { data: current } = await supabase
        .from('businesses')
        .select('verification_status')
        .eq('id', business_id)
        .single();

      if (current && current.verification_status !== 'pending') {
        // A concurrent legitimate change (e.g. review approved/rejected)
        logger.warn('[VERIFICATION] Restore skipped — concurrent status change', {
          business_id,
          previous_status: previousStatus,
          current_status: current.verification_status,
        });
        return NextResponse.json({
          error: 'Failed to create verification request — business verification status was changed concurrently',
        }, { status: 409 });
      }

      // Status is still pending but CAS returned zero rows — compensation failure
      logger.error('[VERIFICATION] Compensation failure — CAS returned zero rows but status is still pending', {
        business_id,
        previous_status: previousStatus,
        insert_error: insertError.message,
      });
      return NextResponse.json({
        error: 'Failed to create verification request and failed to restore business status — manual intervention required',
      }, { status: 500 });
    }

    return NextResponse.json({ error: 'Failed to create verification request' }, { status: 500 });
  }

  // Send email to business owner (non-blocking)
  if (biz.owner_id) {
    const { data: owner } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', biz.owner_id)
      .single();

    if (owner?.email) {
      const levelLabels: Record<string, string> = {
        basic: 'Basic', standard: 'Standard', full: 'Full',
      };
      const cc = (biz.country_code || 'NG') as CountryCode;
      const docNames = (documents_required || []).map((d: string) => getDocTypeLabel(cc, d));
      const email = kycRequestedEmail(biz.name, levelLabels[requested_level] || requested_level, docNames);
      sendEmail({ to: owner.email, ...email }).catch(() => {});
    }
  }

  // Audit log
  await logAdminAudit({
    actorId: admin.userId,
    action: 'request_verification',
    entityType: 'business',
    entityId: business_id,
    details: { requested_level, documents_required, request_id: req.id },
  });

  return NextResponse.json({ success: true, request_id: req.id });
}
