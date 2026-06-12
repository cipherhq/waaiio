import { NextResponse, type NextRequest } from 'next/server';
import { provisionTemplates } from '@/lib/channels/provision-templates';
import { verifyCronAuth } from '@/lib/cron-auth';

/**
 * GET /api/admin/provision-templates
 * One-off: provision all WhatsApp message templates on the shared WABA.
 * Protected by cron auth (CRON_SECRET header).
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

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
