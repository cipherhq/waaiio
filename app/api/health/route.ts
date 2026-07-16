import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  const failures: string[] = [];

  // 1. Database check — query platform_settings
  let dbOk = false;
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from('platform_settings').select('key').limit(1);
    dbOk = !error;
    if (error) failures.push(`db: ${error.message}`);
  } catch (err) {
    dbOk = false;
    failures.push(`db: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 2. Redis check — ping Upstash if configured
  let redisOk = true; // true if not configured (optional dependency)
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) {
    try {
      const { Redis } = await import('@upstash/redis');
      const redis = new Redis({ url: redisUrl, token: redisToken });
      const pong = await redis.ping();
      redisOk = pong === 'PONG';
      if (!redisOk) failures.push('redis: unexpected ping response');
    } catch (err) {
      redisOk = false;
      failures.push(`redis: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // 3. WhatsApp check — verify at least one active channel exists
  let whatsappOk = false;
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('whatsapp_channels')
      .select('id')
      .eq('is_active', true)
      .limit(1);
    whatsappOk = !error && Array.isArray(data) && data.length > 0;
    if (error) failures.push(`whatsapp: ${error.message}`);
    else if (!whatsappOk) failures.push('whatsapp: no active channels');
  } catch (err) {
    whatsappOk = false;
    failures.push(`whatsapp: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 4. Payments check — at least one gateway key is set
  const paymentsOk = !!(process.env.PAYSTACK_SECRET_KEY || process.env.STRIPE_SECRET_KEY);
  if (!paymentsOk) failures.push('payments: no gateway keys configured');

  // 5. Email check — Resend key present
  const emailOk = !!process.env.RESEND_API_KEY;
  if (!emailOk) failures.push('email: RESEND_API_KEY not set');

  // 6. WhatsApp API check — Meta token present
  const metaOk = !!process.env.META_CLOUD_ACCESS_TOKEN;
  if (!metaOk) failures.push('meta: META_CLOUD_ACCESS_TOKEN not set');

  const allOk = dbOk && redisOk && whatsappOk && paymentsOk && emailOk && metaOk;
  // Critical services: DB and payments. If either is down, return 503.
  const criticalDown = !dbOk || !paymentsOk;

  // Log failures internally — never expose to response
  if (failures.length > 0) {
    logger.warn(`[HEALTH] Degraded — ${failures.join('; ')}`);
  }

  // Only expose status — not which services are configured (information disclosure)
  const status = criticalDown ? 'critical' : allOk ? 'ok' : 'degraded';
  const httpStatus = criticalDown ? 503 : 200;

  return NextResponse.json({
    status,
    timestamp: new Date().toISOString(),
  }, { status: httpStatus });
}
