import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import {
  getDeliveryReadiness,
  loadDeliveryConfig,
  deliverLaunchNotifications,
  metaCloudSendTemplate,
} from '@/lib/launch/delivery';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/launch-notify
 * Admin-only: readiness counts for launch notification delivery.
 */
export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const supabase = createServiceClient();
  const config = await loadDeliveryConfig(supabase);
  const readiness = await getDeliveryReadiness(supabase, config.campaignVersion);

  return NextResponse.json({
    config: {
      templateName: config.templateName,
      templateLanguage: config.templateLanguage,
      campaignVersion: config.campaignVersion,
    },
    readiness,
  });
}

/**
 * POST /api/admin/launch-notify
 * Admin-only: trigger launch notification delivery.
 *
 * Body: { retryOnly?: boolean, limit?: number, dryRun?: boolean }
 *
 * dryRun=true returns readiness counts without sending.
 * retryOnly=true only retries failed/pending for the current campaign.
 */
export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const retryOnly = body.retryOnly === true;
  const limit = Math.min(Number(body.limit) || 50, 200);
  const dryRun = body.dryRun === true;

  const supabase = createServiceClient();
  const config = await loadDeliveryConfig(supabase);

  if (dryRun) {
    const readiness = await getDeliveryReadiness(supabase, config.campaignVersion);
    return NextResponse.json({ dryRun: true, readiness, config: { campaignVersion: config.campaignVersion } });
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
