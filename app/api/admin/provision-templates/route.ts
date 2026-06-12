import { NextResponse, type NextRequest } from 'next/server';
import { provisionTemplates } from '@/lib/channels/provision-templates';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/admin/provision-templates
 * One-off: provision all WhatsApp message templates on the shared WABA.
 * Protected by cron auth OR admin session.
 */
export async function GET(request: NextRequest) {
  const cronAuth = verifyCronAuth(request);
  if (cronAuth) {
    // Cron auth failed — try admin session as fallback
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return cronAuth;
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (!profile || profile.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
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
