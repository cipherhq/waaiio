import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { sendEmail } from '@/lib/email/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/cron/platform-fee-invoices
 *
 * Runs monthly (1st of each month). Generates invoices for platform fees
 * on direct bank transfers from the previous month.
 *
 * Only Growth/Business tier businesses with direct transfer fees are invoiced.
 * Due date: 5th of the current month (5 days to pay).
 * After due date: overdue-reminder cron sends follow-up.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let generated = 0;
  let skipped = 0;

  try {
    const now = new Date();
    // Invoice for the PREVIOUS month
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), 0); // last day of prev month
    const periodStart = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1); // 1st of prev month
    const dueDate = new Date(now.getFullYear(), now.getMonth(), 5); // 5th of current month

    const periodStartStr = periodStart.toISOString().split('T')[0];
    const periodEndStr = periodEnd.toISOString().split('T')[0];
    const dueDateStr = dueDate.toISOString().split('T')[0];

    // Fetch all uninvoiced direct transfer platform fees from the previous month
    const { data: fees, error: feeErr } = await supabase
      .from('platform_fees')
      .select('id, business_id, transaction_amount, fee_total, fee_percentage, fee_flat, tier, created_at')
      .eq('is_direct_transfer', true)
      .is('invoiced_at', null)
      .is('refunded_at', null)
      .gte('created_at', periodStart.toISOString())
      .lte('created_at', periodEnd.toISOString() + 'T23:59:59.999Z');

    if (feeErr) {
      logger.error('[PLATFORM_FEE_INVOICES] Failed to fetch fees:', feeErr.message);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    if (!fees || fees.length === 0) {
      return NextResponse.json({ message: 'No direct transfer fees to invoice', generated: 0, skipped: 0 });
    }

    // Group fees by business_id
    const feesByBusiness = new Map<string, typeof fees>();
    for (const fee of fees) {
      const existing = feesByBusiness.get(fee.business_id) || [];
      existing.push(fee);
      feesByBusiness.set(fee.business_id, existing);
    }

    // Generate sequential invoice numbers for this batch
    const monthKey = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, '0')}`;
    let invoiceSeq = 1;

    for (const [businessId, bizFees] of feesByBusiness) {
      // Check for duplicate invoice
      const { count } = await supabase
        .from('platform_fee_invoices')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('period_start', periodStartStr)
        .eq('period_end', periodEndStr);

      if ((count ?? 0) > 0) {
        skipped++;
        continue;
      }

      const totalTransactionAmount = bizFees.reduce((s, f) => s + Number(f.transaction_amount || 0), 0);
      const totalFeeAmount = bizFees.reduce((s, f) => s + Number(f.fee_total || 0), 0);

      // Skip if fee is zero (e.g., all waived or trial)
      if (totalFeeAmount <= 0) {
        skipped++;
        continue;
      }

      const invoiceNumber = `PFI-${monthKey}-${String(invoiceSeq++).padStart(3, '0')}`;

      // Build line items for breakdown
      const lineItems = bizFees.map(f => ({
        fee_id: f.id,
        date: f.created_at,
        transaction_amount: f.transaction_amount,
        fee_percentage: f.fee_percentage,
        fee_flat: f.fee_flat,
        fee_total: f.fee_total,
        tier: f.tier,
      }));

      // Create the invoice
      const { data: invoice, error: insertErr } = await supabase
        .from('platform_fee_invoices')
        .insert({
          business_id: businessId,
          invoice_number: invoiceNumber,
          period_start: periodStartStr,
          period_end: periodEndStr,
          total_transaction_amount: totalTransactionAmount,
          total_fee_amount: totalFeeAmount,
          transaction_count: bizFees.length,
          currency: 'NGN', // Direct transfers are NG/GH only
          status: 'pending',
          due_date: dueDateStr,
          line_items: lineItems,
        })
        .select('id')
        .single();

      if (insertErr) {
        logger.error(`[PLATFORM_FEE_INVOICES] Failed to create invoice for business ${businessId}:`, insertErr.message);
        continue;
      }

      // Mark all fees as invoiced
      const feeIds = bizFees.map(f => f.id);
      await supabase
        .from('platform_fees')
        .update({ invoiced_at: now.toISOString(), invoice_id: invoice.id })
        .in('id', feeIds);

      // Send email notification to business owner
      try {
        const { data: biz } = await supabase
          .from('businesses')
          .select('name, country_code, owner_id, profiles:owner_id (email)')
          .eq('id', businessId)
          .single();

        if (biz) {
          const cc = (biz.country_code || 'NG') as CountryCode;
          const ownerEmail = Array.isArray(biz.profiles) ? biz.profiles[0]?.email : (biz.profiles as { email: string } | null)?.email;
          const formattedFee = formatCurrency(totalFeeAmount / 100, cc);
          const formattedVolume = formatCurrency(totalTransactionAmount / 100, cc);
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

          if (ownerEmail) {
            await sendEmail({
              to: ownerEmail,
              subject: `Platform Fee Invoice ${invoiceNumber} — ${formattedFee} due by ${dueDateStr}`,
              html: `
                <h2>Monthly Platform Fee Invoice</h2>
                <p>Hi ${biz.name} team,</p>
                <p>Here's your platform fee invoice for direct bank transfers processed in <strong>${periodStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong>.</p>
                <table style="border-collapse:collapse;width:100%;margin:16px 0">
                  <tr style="background:#f3f4f6"><td style="padding:8px;border:1px solid #e5e7eb"><strong>Invoice #</strong></td><td style="padding:8px;border:1px solid #e5e7eb">${invoiceNumber}</td></tr>
                  <tr><td style="padding:8px;border:1px solid #e5e7eb"><strong>Period</strong></td><td style="padding:8px;border:1px solid #e5e7eb">${periodStartStr} to ${periodEndStr}</td></tr>
                  <tr style="background:#f3f4f6"><td style="padding:8px;border:1px solid #e5e7eb"><strong>Transfers</strong></td><td style="padding:8px;border:1px solid #e5e7eb">${bizFees.length} transactions totaling ${formattedVolume}</td></tr>
                  <tr><td style="padding:8px;border:1px solid #e5e7eb"><strong>Platform Fee</strong></td><td style="padding:8px;border:1px solid #e5e7eb"><strong>${formattedFee}</strong></td></tr>
                  <tr style="background:#f3f4f6"><td style="padding:8px;border:1px solid #e5e7eb"><strong>Due Date</strong></td><td style="padding:8px;border:1px solid #e5e7eb">${dueDateStr}</td></tr>
                </table>
                <p>View and pay this invoice in your <a href="${appUrl}/dashboard/billing" style="color:#6C2BD9;text-decoration:underline">Dashboard → Billing</a>.</p>
                <p style="color:#6b7280;font-size:14px">This fee covers Waaiio's platform services on your direct bank transfer payments. No gateway fees were charged on these transactions.</p>
                <p>Thank you for using Waaiio!</p>
              `,
            });
          }
        }
      } catch (emailErr) {
        logger.error(`[PLATFORM_FEE_INVOICES] Email error for business ${businessId}:`, emailErr);
      }

      generated++;
    }

    const summary = `Generated ${generated} invoices, skipped ${skipped}`;
    logger.info(`[PLATFORM_FEE_INVOICES] ${summary}`);
    return NextResponse.json({ message: summary, generated, skipped });
  } catch (err) {
    logger.error('[PLATFORM_FEE_INVOICES] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
