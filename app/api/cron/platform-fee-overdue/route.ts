import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { sendEmail } from '@/lib/email/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { createAlert } from '@/lib/alerts/create-alert';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/cron/platform-fee-overdue
 *
 * Runs daily. Marks overdue invoices and sends reminders.
 * After 7 days overdue with no payment → disables direct transfer feature.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  let markedOverdue = 0;
  let remindersSent = 0;
  let disabled = 0;

  try {
    // 1. Mark pending invoices past due date as overdue
    const { data: newlyOverdue } = await supabase
      .from('platform_fee_invoices')
      .update({ status: 'overdue', updated_at: now.toISOString() })
      .eq('status', 'pending')
      .lt('due_date', today)
      .select('id, business_id, invoice_number, total_fee_amount, due_date');

    markedOverdue = newlyOverdue?.length || 0;

    // 2. Send overdue reminders (once per invoice)
    const { data: overdueInvoices } = await supabase
      .from('platform_fee_invoices')
      .select('id, business_id, invoice_number, total_fee_amount, due_date, overdue_notice_sent_at')
      .eq('status', 'overdue')
      .is('overdue_notice_sent_at', null);

    for (const invoice of overdueInvoices || []) {
      try {
        const { data: biz } = await supabase
          .from('businesses')
          .select('name, country_code, owner_id, profiles:owner_id (email)')
          .eq('id', invoice.business_id)
          .single();

        if (biz) {
          const cc = (biz.country_code || 'NG') as CountryCode;
          const ownerEmail = Array.isArray(biz.profiles) ? biz.profiles[0]?.email : (biz.profiles as { email: string } | null)?.email;
          const formattedFee = formatCurrency(invoice.total_fee_amount / 100, cc);
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

          if (ownerEmail) {
            await sendEmail({
              to: ownerEmail,
              subject: `⚠️ Overdue: Platform Fee Invoice ${invoice.invoice_number} — ${formattedFee}`,
              html: `
                <h2>⚠️ Overdue Platform Fee</h2>
                <p>Hi ${biz.name} team,</p>
                <p>Your platform fee invoice <strong>${invoice.invoice_number}</strong> for <strong>${formattedFee}</strong> was due on <strong>${invoice.due_date}</strong> and remains unpaid.</p>
                <p>Please pay within 7 days to avoid losing access to the direct bank transfer feature.</p>
                <p><a href="${appUrl}/dashboard/billing" style="background:#6C2BD9;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Pay Now</a></p>
                <p style="color:#6b7280;font-size:14px">If you believe this is an error, please contact support.</p>
              `,
            });
            remindersSent++;
          }
        }

        await supabase
          .from('platform_fee_invoices')
          .update({ overdue_notice_sent_at: now.toISOString() })
          .eq('id', invoice.id);
      } catch (err) {
        logger.error(`[PLATFORM_FEE_OVERDUE] Reminder error for invoice ${invoice.id}:`, err);
      }
    }

    // 3. Disable direct transfers for businesses with invoices overdue > 7 days
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];

    const { data: longOverdue } = await supabase
      .from('platform_fee_invoices')
      .select('business_id, invoice_number, total_fee_amount')
      .eq('status', 'overdue')
      .lt('due_date', sevenDaysAgoStr);

    for (const invoice of longOverdue || []) {
      // Deactivate all bank accounts for this business
      const { data: deactivated } = await supabase
        .from('business_bank_accounts')
        .update({ is_active: false })
        .eq('business_id', invoice.business_id)
        .eq('is_active', true)
        .select('id');

      if (deactivated && deactivated.length > 0) {
        disabled++;
        // Create admin alert
        await createAlert(supabase, {
          type: 'fee_collection',
          severity: 'warning',
          title: `Direct transfers disabled for overdue fees`,
          message: `Business ${invoice.business_id} has overdue invoice ${invoice.invoice_number} (${invoice.total_fee_amount} kobo). Bank accounts deactivated.`,
          businessId: invoice.business_id,
        }).catch(() => {});

        logger.warn(`[PLATFORM_FEE_OVERDUE] Disabled direct transfers for business ${invoice.business_id} — overdue invoice ${invoice.invoice_number}`);
      }
    }

    const summary = `Overdue: ${markedOverdue} marked, ${remindersSent} reminders sent, ${disabled} businesses disabled`;
    logger.info(`[PLATFORM_FEE_OVERDUE] ${summary}`);
    return NextResponse.json({ message: summary, markedOverdue, remindersSent, disabled });
  } catch (err) {
    logger.error('[PLATFORM_FEE_OVERDUE] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
