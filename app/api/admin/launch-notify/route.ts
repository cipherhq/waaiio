import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import {
  getDeliveryReadiness,
  loadDeliveryConfig,
  deliverLaunchNotifications,
  metaCloudSendTemplate,
  LaunchConfigError,
} from '@/lib/launch/delivery';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/launch-notify?retryOnly=false&limit=50
 *
 * Admin-only: Preview readiness for the exact delivery scope.
 * Accepts scope params (retryOnly, limit) so the preview represents
 * exactly what Confirm & Send will execute.
 * Creates a DB-backed confirmation token bound to admin + campaign + scope.
 * Preview NEVER sends.
 */
export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const supabase = createServiceClient();

  let config;
  try {
    config = await loadDeliveryConfig(supabase);
  } catch (err) {
    if (err instanceof LaunchConfigError) {
      return NextResponse.json({ error: err.message, configError: true }, { status: 422 });
    }
    throw err;
  }

  // Read intended scope from query params
  const { searchParams } = new URL(request.url);
  const retryOnly = searchParams.get('retryOnly') === 'true';
  const sendLimit = Math.min(Number(searchParams.get('limit')) || 50, 200);

  const readiness = await getDeliveryReadiness(supabase, config.campaignVersion);

  // Create DB-backed confirmation token bound to full scope
  const { data: confirmRow, error: insertError } = await supabase
    .from('launch_delivery_confirmations')
    .insert({
      admin_id: admin.userId,
      campaign_version: config.campaignVersion,
      eligible_count: readiness.eligible,
      pending_count: readiness.pending,
      retry_only: retryOnly,
      send_limit: sendLimit,
    })
    .select('token')
    .single();

  if (insertError || !confirmRow) {
    return NextResponse.json({ error: 'Failed to create confirmation token' }, { status: 500 });
  }

  return NextResponse.json({
    config: {
      templateName: config.templateName,
      templateLanguage: config.templateLanguage,
      campaignVersion: config.campaignVersion,
    },
    scope: {
      retryOnly,
      sendLimit,
    },
    readiness: {
      eligible: readiness.eligible,
      pending: readiness.pending,
      sent: readiness.sent,
      failed: readiness.failed,
      skipped: readiness.skipped,
      opted_out: readiness.opted_out,
    },
    confirmToken: confirmRow.token,
  });
}

/**
 * POST /api/admin/launch-notify
 *
 * Admin-only: Step 2 — execute delivery with a valid confirmation token.
 * The token is atomically consumed with full scope verification:
 * admin, campaign, retryOnly, sendLimit must ALL match the preview.
 * Delivery scope comes from the consumed token, NOT from the request body.
 *
 * Body: { confirmToken: string }
 */
export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const body = await request.json().catch(() => ({}));

  const confirmToken = body.confirmToken as string | undefined;
  if (!confirmToken) {
    return NextResponse.json(
      { error: 'Missing confirmToken. Use the Preview button first, then Confirm & Send.' },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // Load config — fail closed
  let config;
  try {
    config = await loadDeliveryConfig(supabase);
  } catch (err) {
    if (err instanceof LaunchConfigError) {
      return NextResponse.json({ error: err.message, configError: true }, { status: 422 });
    }
    throw err;
  }

  // Read the scope the caller claims — must match what was previewed
  const retryOnly = body.retryOnly === true;
  const sendLimit = Math.min(Number(body.limit) || 50, 200);

  // Atomically consume with full scope verification
  const { data: consumeResult, error: consumeError } = await supabase.rpc(
    'consume_launch_confirmation',
    {
      p_token: confirmToken,
      p_admin_id: admin.userId,
      p_campaign_version: config.campaignVersion,
      p_retry_only: retryOnly,
      p_send_limit: sendLimit,
    },
  );

  if (consumeError) {
    return NextResponse.json({ error: 'Confirmation check failed' }, { status: 500 });
  }

  const consume = consumeResult as { consumed: boolean; reason?: string; retry_only?: boolean; send_limit?: number };
  if (!consume?.consumed) {
    const reasons: Record<string, string> = {
      not_found: 'Confirmation token not found. Preview again.',
      already_consumed: 'This confirmation was already used. Preview again for a fresh token.',
      wrong_admin: 'This confirmation belongs to a different admin.',
      campaign_mismatch: 'Campaign version changed since preview. Preview again.',
      scope_mismatch: 'Delivery scope (retryOnly/limit) does not match preview. Preview again with the intended scope.',
      expired: 'Confirmation expired (5 min). Preview again.',
    };
    return NextResponse.json(
      { error: reasons[consume?.reason || ''] || 'Invalid confirmation token.' },
      { status: 403 },
    );
  }

  // Delivery scope comes from the consumed confirmation
  const summary = await deliverLaunchNotifications(
    supabase,
    config,
    metaCloudSendTemplate,
    { retryOnly, limit: sendLimit },
  );

  return NextResponse.json({
    success: true,
    summary: {
      total: summary.total,
      sent: summary.sent,
      failed: summary.failed,
      skipped: summary.skipped,
    },
    campaignVersion: config.campaignVersion,
  });
}
