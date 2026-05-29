import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { trialExpiringEmail, trialEndedEmail } from '@/lib/email/templates';
import { verifyCronAuth } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const now = new Date();
  let emailsSent = 0;

  // ── 1. Businesses whose trial ends in 2 days (warning email) ──
  const twoDaysFromNow = new Date(now);
  twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);
  const twoDaysStart = twoDaysFromNow.toISOString().split('T')[0] + 'T00:00:00Z';
  const twoDaysEnd = twoDaysFromNow.toISOString().split('T')[0] + 'T23:59:59Z';

  const { data: expiringSoon } = await supabase
    .from('businesses')
    .select('id, name, owner_id, trial_ends_at')
    .gte('trial_ends_at', twoDaysStart)
    .lte('trial_ends_at', twoDaysEnd)
    .eq('status', 'active');

  for (const biz of expiringSoon || []) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', biz.owner_id)
      .single();

    if (profile?.email) {
      const daysLeft = Math.ceil(
        (new Date(biz.trial_ends_at).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const { subject, html } = trialExpiringEmail(biz.name, Math.max(1, daysLeft));
      await sendEmail({ to: profile.email, subject, html });
      emailsSent++;
    }
  }

  // ── 2. Businesses whose trial ended today (trial ended email) ──
  const yesterdayStart = new Date(now);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const yStart = yesterdayStart.toISOString().split('T')[0] + 'T00:00:00Z';
  const yEnd = yesterdayStart.toISOString().split('T')[0] + 'T23:59:59Z';

  const { data: justExpired } = await supabase
    .from('businesses')
    .select('id, name, owner_id, trial_ends_at')
    .gte('trial_ends_at', yStart)
    .lte('trial_ends_at', yEnd)
    .eq('status', 'active');

  for (const biz of justExpired || []) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', biz.owner_id)
      .single();

    if (profile?.email) {
      const { subject, html } = trialEndedEmail(biz.name);
      await sendEmail({ to: profile.email, subject, html });
      emailsSent++;
    }
  }

  return NextResponse.json({
    ok: true,
    emailsSent,
    expiringSoon: expiringSoon?.length || 0,
    justExpired: justExpired?.length || 0,
  });
}
