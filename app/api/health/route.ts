import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, 'ok' | 'error'> = {};

  // Check Supabase connectivity
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from('platform_settings').select('key').limit(1);
    checks.database = error ? 'error' : 'ok';
  } catch {
    checks.database = 'error';
  }

  // Check env vars
  checks.meta_token = process.env.META_CLOUD_ACCESS_TOKEN ? 'ok' : 'error';
  checks.supabase_url = process.env.NEXT_PUBLIC_SUPABASE_URL ? 'ok' : 'error';

  const allOk = Object.values(checks).every(v => v === 'ok');

  return NextResponse.json({
    status: allOk ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  }, { status: allOk ? 200 : 503 });
}
