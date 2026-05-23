import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, 'ok' | 'error'> = { db: 'error' };

  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from('platform_settings').select('key').limit(1);
    checks.db = error ? 'error' : 'ok';
  } catch {
    checks.db = 'error';
  }

  const allOk = Object.values(checks).every(v => v === 'ok');

  return NextResponse.json({
    status: allOk ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  }, { status: allOk ? 200 : 503 });
}
