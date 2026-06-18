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

  // ── 1. Delete inactive sessions older than 7 days ──
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data: deletedInactive } = await supabase
    .from('bot_sessions')
    .delete()
    .eq('is_active', false)
    .lt('updated_at', sevenDaysAgo.toISOString())
    .select('id');

  // ── 2. Deactivate and delete expired active sessions ──
  // First deactivate them (set is_active=false)
  const now = new Date().toISOString();

  const { data: expiredSessions } = await supabase
    .from('bot_sessions')
    .update({ is_active: false, current_step: 'expired' })
    .eq('is_active', true)
    .lt('expires_at', now)
    .select('id');

  // Then delete expired sessions that are now inactive (they were just deactivated)
  // We delete them immediately since they are already past expiry
  let deletedExpired = 0;
  if (expiredSessions && expiredSessions.length > 0) {
    const expiredIds = expiredSessions.map(s => s.id);
    const { data: deleted } = await supabase
      .from('bot_sessions')
      .delete()
      .in('id', expiredIds)
      .select('id');
    deletedExpired = deleted?.length || 0;
  }

  const totalCleaned = (deletedInactive?.length || 0) + deletedExpired;

  return NextResponse.json({
    ok: true,
    deletedInactive: deletedInactive?.length || 0,
    deactivatedExpired: expiredSessions?.length || 0,
    deletedExpired,
    totalCleaned,
  });
}
