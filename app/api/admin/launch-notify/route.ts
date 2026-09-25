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

// In-memory confirmation tokens — expire after 5 minutes.
// Admin must GET (preview) before POST (send). Token is single-use.
const pendingConfirmations = new Map<string, { expiresAt: number; adminId: string; campaignVersion: string }>();

function cleanExpired() {
  const now = Date.now();
  for (const [k, v] of pendingConfirmations) {
    if (v.expiresAt < now) pendingConfirmations.delete(k);
  }
}

/**
 * GET /api/admin/launch-notify
 * Admin-only: readiness preview with confirmation token.
 * Admin MUST call this before POST to receive a confirmToken.
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

  // Store confirmation token for POST validation
  cleanExpired();
  const confirmToken = readiness.confirmToken;
  pendingConfirmations.set(confirmToken, {
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    adminId: admin.userId,
    campaignVersion: config.campaignVersion,
  });

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
    confirmToken,
  });
}

/**
 * POST /api/admin/launch-notify
 * Admin-only: trigger launch notification delivery.
 *
 * REQUIRES confirmToken from a prior GET call (preview-first flow).
 * Body: { confirmToken: string, retryOnly?: boolean, limit?: number }
 */
export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const body = await request.json().catch(() => ({}));

  // Require confirmation token from prior GET
  const confirmToken = body.confirmToken as string | undefined;
  if (!confirmToken) {
    return NextResponse.json(
      { error: 'Missing confirmToken. Call GET first to preview readiness and obtain a token.' },
      { status: 400 },
    );
  }

  cleanExpired();
  const confirmation = pendingConfirmations.get(confirmToken);
  if (!confirmation) {
    return NextResponse.json(
      { error: 'Invalid or expired confirmToken. Call GET again to get a fresh token.' },
      { status: 403 },
    );
  }

  // Verify same admin
  if (confirmation.adminId !== admin.userId) {
    return NextResponse.json(
      { error: 'confirmToken was issued to a different admin.' },
      { status: 403 },
    );
  }

  // Single-use: consume the token
  pendingConfirmations.delete(confirmToken);

  const retryOnly = body.retryOnly === true;
  const limit = Math.min(Number(body.limit) || 50, 200);

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

  // Verify campaign version hasn't changed since preview
  if (config.campaignVersion !== confirmation.campaignVersion) {
    return NextResponse.json(
      { error: `Campaign version changed since preview (was ${confirmation.campaignVersion}, now ${config.campaignVersion}). Call GET again.` },
      { status: 409 },
    );
  }

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
