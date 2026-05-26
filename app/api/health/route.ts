import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

export async function GET() {
  let dbOk = false;

  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from('platform_settings').select('key').limit(1);
    dbOk = !error;
  } catch {
    dbOk = false;
  }

  const allOk = dbOk
    && !!process.env.RESEND_API_KEY
    && !!process.env.META_CLOUD_ACCESS_TOKEN
    && !!(process.env.PAYSTACK_SECRET_KEY || process.env.STRIPE_SECRET_KEY);

  // Only expose status — not which services are configured (information disclosure)
  return NextResponse.json({
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
  }, { status: allOk ? 200 : 503 });
}
