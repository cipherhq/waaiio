import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, 'ok' | 'error'> = {
    db: 'error',
    email: process.env.RESEND_API_KEY ? 'ok' : 'error',
    whatsapp: process.env.META_CLOUD_ACCESS_TOKEN ? 'ok' : 'error',
    payments: (process.env.PAYSTACK_SECRET_KEY || process.env.STRIPE_SECRET_KEY) ? 'ok' : 'error',
  };

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
