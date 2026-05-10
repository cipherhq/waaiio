import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { verifyCronAuth } from '@/lib/cron-auth';

/**
 * GET /api/cron/payout-nudge
 *
 * Runs daily. Finds businesses with accumulated payments but no payout account.
 * Sends email + WhatsApp reminders to connect their bank account.
 *
 * Nudge schedule:
 * - After 1st payment: "You have money waiting! Set up payouts."
 * - After 5 payments: "₦X is accumulating. Connect your bank to get paid."
 * - After 14 days with balance: "Don't leave money on the table."
 * - Weekly reminder after that until they connect.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

  try {
    // Find businesses with no active payout account
    const { data: businesses } = await supabase
      .from('businesses')
      .select('id, name, owner_id, country_code, created_at')
      .eq('status', 'active')
      .eq('payout_mode', 'platform_managed');

    if (!businesses?.length) {
      return NextResponse.json({ message: 'No businesses to nudge', sent: 0 });
    }

    // Get businesses that already have payout accounts
    const { data: payoutAccounts } = await supabase
      .from('payout_accounts')
      .select('business_id')
      .eq('is_active', true);

    const hasPayoutAccount = new Set((payoutAccounts || []).map(p => p.business_id));

    // Get recent nudge history to avoid spamming
    const { data: recentNudges } = await supabase
      .from('notifications')
      .select('business_id, created_at')
      .eq('type', 'payout_nudge')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    const lastNudge = new Map<string, Date>();
    for (const n of (recentNudges || [])) {
      const existing = lastNudge.get(n.business_id);
      const date = new Date(n.created_at);
      if (!existing || date > existing) lastNudge.set(n.business_id, date);
    }

    let nudgesSent = 0;
    const MAX_NUDGES_PER_RUN = 50; // Cap platform-initiated messages per cron run

    for (const biz of businesses) {
      // Cap total nudges per run to control costs
      if (nudgesSent >= MAX_NUDGES_PER_RUN) break;

      // Skip if already has payout account
      if (hasPayoutAccount.has(biz.id)) continue;

      // Skip if nudged in the last 7 days
      const lastNudgeDate = lastNudge.get(biz.id);
      if (lastNudgeDate && (Date.now() - lastNudgeDate.getTime()) < 7 * 24 * 60 * 60 * 1000) continue;

      // Check if they have accumulated payments
      const { data: fees } = await supabase
        .from('platform_fees')
        .select('transaction_amount, fee_total')
        .eq('business_id', biz.id)
        .is('refunded_at', null);

      const totalGross = (fees || []).reduce((s, f) => s + Number(f.transaction_amount || 0), 0);
      const totalFees = (fees || []).reduce((s, f) => s + Number(f.fee_total || 0), 0);
      const balance = totalGross - totalFees;
      const paymentCount = (fees || []).length;

      // Only nudge if they have actual money waiting
      if (balance <= 0 || paymentCount === 0) continue;

      const cc = (biz.country_code || 'NG') as CountryCode;
      const formattedBalance = formatCurrency(balance, cc);

      // Get owner email
      const { data: profile } = await supabase
        .from('profiles')
        .select('email, phone')
        .eq('id', biz.owner_id)
        .single();

      if (!profile?.email) continue;

      // Determine urgency
      let subject: string;
      let message: string;

      if (paymentCount === 1) {
        subject = `${biz.name}: You have ${formattedBalance} waiting!`;
        message = `Congratulations! You just received your first payment through Waaiio.\n\n${formattedBalance} is waiting for you. Connect your bank account to receive your money.\n\nGo to your dashboard → Payouts → Set up your bank details.\n\n${appUrl}/dashboard/payouts`;
      } else if (paymentCount <= 5) {
        subject = `${biz.name}: ${formattedBalance} is accumulating — set up payouts`;
        message = `You've received ${paymentCount} payments totaling ${formattedBalance} through Waaiio.\n\nThis money is waiting for you! Connect your bank account to get paid automatically every week.\n\nIt takes less than 30 seconds:\n${appUrl}/dashboard/payouts`;
      } else {
        subject = `${biz.name}: Don't leave ${formattedBalance} on the table`;
        message = `You have ${formattedBalance} from ${paymentCount} payments sitting in your Waaiio account.\n\nConnect your bank details now and we'll send your money automatically every Monday.\n\nSet up now (30 seconds):\n${appUrl}/dashboard/payouts`;
      }

      // Send email
      try {
        await sendEmail({
          to: profile.email,
          subject,
          html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto">
            <h2 style="color:#6C2BD9">${subject}</h2>
            <p style="color:#374151;line-height:1.6">${message.replace(/\n/g, '<br>')}</p>
            <a href="${appUrl}/dashboard/payouts" style="display:inline-block;background:#6C2BD9;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:16px">Set Up Payouts →</a>
            <p style="color:#9CA3AF;font-size:12px;margin-top:24px">You're receiving this because you have unclaimed payments on Waaiio.</p>
          </div>`,
        });
      } catch (err) {
        logger.error(`[PAYOUT-NUDGE] Email failed for ${biz.name}:`, err);
      }

      // Send WhatsApp notification to business owner (if they have a phone)
      if (profile.phone) {
        try {
          const waToken = process.env.META_CLOUD_ACCESS_TOKEN || '';
          const waPhoneId = process.env.META_CLOUD_PHONE_NUMBER_ID || '';
          if (waToken && waPhoneId) {
            await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v22.0'}/${waPhoneId}/messages`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${waToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: profile.phone.replace('+', ''),
                type: 'text',
                text: { body: `💰 ${biz.name}: You have ${formattedBalance} from ${paymentCount} payments waiting!\n\nSet up your bank account to get paid automatically:\n${appUrl}/dashboard/payouts` },
              }),
            });
          }
        } catch (err) {
          logger.error(`[PAYOUT-NUDGE] WhatsApp failed for ${biz.name}:`, err);
        }
      }

      // Record the nudge to avoid spamming
      await supabase.from('notifications').insert({
        business_id: biz.id,
        type: 'payout_nudge',
        channel: 'email',
        body: subject,
      });

      nudgesSent++;
      logger.debug(`[PAYOUT-NUDGE] Nudged ${biz.name}: ${formattedBalance} (${paymentCount} payments)`);
    }

    return NextResponse.json({ message: 'Payout nudges sent', sent: nudgesSent });
  } catch (error) {
    logger.error('[PAYOUT-NUDGE] Error:', error);
    return NextResponse.json({ error: 'Nudge failed' }, { status: 500 });
  }
}
