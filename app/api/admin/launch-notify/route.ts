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
 * GET /api/admin/launch-notify
 *
 * Admin-only: Preview readiness counts and create a DB-backed confirmation token.
 * This is step 1 of the two-step flow. Preview NEVER sends.
 * The returned confirmToken must be passed to POST to authorize delivery.
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

  const readiness = await getDeliveryReadiness(supabase, config.campaignVersion);

  // Create DB-backed confirmation token (survives Vercel instance boundaries)
  const { data: confirmRow, error: insertError } = await supabase
    .from('launch_delivery_confirmations')
    .insert({
      admin_id: admin.userId,
      campaign_version: config.campaignVersion,
      eligible_count: readiness.eligible,
      pending_count: readiness.pending,
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
 * Admin-only: Step 2 — execute delivery ONLY with a valid confirmation token.
 * The token is atomically consumed (single-use, replay-protected, expiry-checked,
 * admin-bound, campaign-bound) via the consume_launch_confirmation RPC.
 *
 * Body: { confirmToken: string, retryOnly?: boolean, limit?: number }
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

  // Load config first — fail closed
  let config;
  try {
    config = await loadDeliveryConfig(supabase);
  } catch (err) {
    if (err instanceof LaunchConfigError) {
      return NextResponse.json({ error: err.message, configError: true }, { status: 422 });
    }
    throw err;
  }

  // Atomically consume the confirmation token via DB RPC
  const { data: consumeResult, error: consumeError } = await supabase.rpc(
    'consume_launch_confirmation',
    {
      p_token: confirmToken,
      p_admin_id: admin.userId,
      p_campaign_version: config.campaignVersion,
    },
  );

  if (consumeError) {
    return NextResponse.json({ error: 'Confirmation check failed' }, { status: 500 });
  }

  const consume = consumeResult as { consumed: boolean; reason?: string };
  if (!consume?.consumed) {
    const reasons: Record<string, string> = {
      not_found: 'Confirmation token not found. Preview again.',
      already_consumed: 'This confirmation was already used. Preview again for a fresh token.',
      wrong_admin: 'This confirmation belongs to a different admin.',
      campaign_mismatch: 'Campaign version changed since preview. Preview again.',
      expired: 'Confirmation expired (5 min). Preview again.',
    };
    return NextResponse.json(
      { error: reasons[consume?.reason || ''] || 'Invalid confirmation token.' },
      { status: 403 },
    );
  }

  // Confirmation consumed — proceed with delivery
  const retryOnly = body.retryOnly === true;
  const limit = Math.min(Number(body.limit) || 50, 200);

  const summary = await deliverLaunchNotifications(
    supabase,
    config,
    metaCloudSendTemplate,
    { retryOnly, limit },
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
