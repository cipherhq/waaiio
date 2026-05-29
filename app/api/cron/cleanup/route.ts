import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();

  // ── 1. Expire stale pending bookings older than 48 hours ──
  const staleDate = new Date();
  staleDate.setHours(staleDate.getHours() - 48);

  const { data: expiredBookings } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('status', 'pending')
    .lt('created_at', staleDate.toISOString())
    .select('id');

  // ── 2. Clean up old processed webhook events (older than 30 days) ──
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: deletedEvents } = await supabase
    .from('processed_webhook_events')
    .delete()
    .lt('processed_at', thirtyDaysAgo.toISOString())
    .select('id');

  // ── 3. Clean up expired sessions/conversation states older than 7 days ──
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data: deletedSessions } = await supabase
    .from('conversation_states')
    .delete()
    .lt('updated_at', sevenDaysAgo.toISOString())
    .select('id');

  return NextResponse.json({
    ok: true,
    expiredBookings: expiredBookings?.length || 0,
    deletedWebhookEvents: deletedEvents?.length || 0,
    deletedStaleSessions: deletedSessions?.length || 0,
  });
}
