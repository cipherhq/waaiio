import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { verifyCronAuth } from '@/lib/cron-auth';

/**
 * GET /api/cron/recurring-invoices
 *
 * Run daily via cron. Finds recurring invoices due today or overdue,
 * generates new invoice copies, and sends them via WhatsApp.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let generated = 0;

  try {
    const today = new Date().toISOString().split('T')[0];

    // Find recurring invoices due today or earlier
    const { data: dueInvoices } = await supabase
      .from('invoices')
      .select('*')
      .eq('is_recurring', true)
      .lte('recurring_next_date', today)
      .neq('status', 'cancelled')
      .is('recurring_parent_id', null); // Only template invoices, not generated ones

    if (!dueInvoices || dueInvoices.length === 0) {
      return NextResponse.json({ message: 'No recurring invoices due', generated: 0 });
    }

    for (const template of dueInvoices) {
      // Check if end date passed
      if (template.recurring_end_date && template.recurring_end_date < today) {
        continue;
      }

      try {
        const { data: newInvoice, error: cloneError } = await supabase.rpc('clone_recurring_invoice_tax_980', {
          p_template_id: template.id, p_period: template.recurring_next_date, p_issue_date: today,
        });
        if (cloneError || !newInvoice) throw new Error('Unable to clone recurring invoice terms');
        if (newInvoice.replayed) continue;

        // Auto-send via WhatsApp if customer has phone
        if (template.customer_phone) {
          try {
            const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
            await fetch(`${appUrl}/api/invoices/send`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-internal-token': process.env.INTERNAL_API_TOKEN || '',
              },
              body: JSON.stringify({ invoice_id: newInvoice.id, expected_tax_snapshot: newInvoice.tax_snapshot ?? null }),
            });
          } catch (sendErr) {
            logger.error('[RECURRING-INVOICE] Send failed:', sendErr);
          }
        }

        generated++;
        logger.debug(`[RECURRING-INVOICE] Generated invoice ${newInvoice.reference_code} from template ${template.reference_code}`);
      } catch (err) {
        logger.error(`[RECURRING-INVOICE] Failed for template ${template.id}:`, err);
      }
    }

    return NextResponse.json({ message: 'Recurring invoices processed', generated, checked: dueInvoices.length });
  } catch (error) {
    logger.error('[RECURRING-INVOICE] Error:', error);
    Sentry.captureException(error, { tags: { cron: 'recurring-invoices' } });
    return NextResponse.json({ error: 'Failed to process recurring invoices' }, { status: 500 });
  }
}
