import { NextResponse, type NextRequest } from 'next/server';
import { provisionTemplates } from '@/lib/channels/provision-templates';
import { verifyCronAuth, hasBearerSecret } from '@/lib/cron-auth';
import { requirePlatformAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/provision-templates
 * One-off: provision all WhatsApp message templates on the shared WABA.
 * Protected by cron auth OR admin session.
 */
export async function GET(request: NextRequest) {
  // Auth: internal token (Authorization header only) OR cron secret OR admin session
  const hasInternalAuth = hasBearerSecret(request, process.env.INTERNAL_API_TOKEN);

  if (!hasInternalAuth) {
    const cronAuth = verifyCronAuth(request);
    if (cronAuth) {
      // Cron auth failed — try admin session as fallback
      const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
      if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }
  }

  const wabaId = process.env.META_CLOUD_WABA_ID;
  const accessToken = process.env.META_CLOUD_ACCESS_TOKEN;

  if (!wabaId || !accessToken) {
    return NextResponse.json({ error: 'META_CLOUD_WABA_ID or META_CLOUD_ACCESS_TOKEN not set' }, { status: 500 });
  }

  const result = await provisionTemplates(wabaId, accessToken);

  return NextResponse.json({
    message: 'Template provisioning complete',
    ...result,
  });
}
