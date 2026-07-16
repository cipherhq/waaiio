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
        // Generate reference code
        const refCode = `BW-I${Date.now().toString(36).toUpperCase().slice(-4)}`;

        // Create the new invoice
        const { data: newInvoice } = await supabase.from('invoices').insert({
          business_id: template.business_id,
          customer_profile_id: template.customer_profile_id,
          reference_code: refCode,
          customer_name: template.customer_name,
          customer_phone: template.customer_phone,
          customer_email: template.customer_email,
          customer_address: template.customer_address,
          status: 'draft',
          subtotal: template.subtotal,
          tax_rate: template.tax_rate,
          tax_amount: template.tax_amount,
          discount_type: template.discount_type,
          discount_value: template.discount_value,
          discount_amount: template.discount_amount,
          total_amount: template.total_amount,
          currency: template.currency,
          issue_date: today,
          due_date: calculateDueDate(today, 30),
          notes: template.notes,
          terms: template.terms,
          recurring_parent_id: template.id,
          metadata: { ...template.metadata, auto_generated: true, source_invoice: template.id },
        }).select('id').single();

        if (!newInvoice) continue;

        // Copy line items
        const { data: lineItems } = await supabase
          .from('invoice_items')
          .select('*')
          .eq('invoice_id', template.id);

        if (lineItems && lineItems.length > 0) {
          await supabase.from('invoice_items').insert(
            lineItems.map(item => ({
              invoice_id: newInvoice.id,
              description: item.description,
              quantity: item.quantity,
              unit_price: item.unit_price,
              amount: item.amount,
              sort_order: item.sort_order || 0,
            }))
          );
        }

        // Calculate next recurring date
        const nextDate = calculateNextDate(template.recurring_next_date, template.recurring_frequency);

        await supabase.from('invoices').update({
          recurring_next_date: nextDate,
          recurring_count: (template.recurring_count || 0) + 1,
        }).eq('id', template.id);

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
              body: JSON.stringify({ invoice_id: newInvoice.id }),
            });
          } catch (sendErr) {
            logger.error('[RECURRING-INVOICE] Send failed:', sendErr);
          }
        }

        generated++;
        logger.debug(`[RECURRING-INVOICE] Generated invoice ${refCode} from template ${template.reference_code}`);
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

function calculateNextDate(currentDate: string, frequency: string): string {
  const date = new Date(currentDate);
  switch (frequency) {
    case 'weekly': date.setDate(date.getDate() + 7); break;
    case 'biweekly': date.setDate(date.getDate() + 14); break;
    case 'monthly': date.setMonth(date.getMonth() + 1); break;
    case 'quarterly': date.setMonth(date.getMonth() + 3); break;
    case 'yearly': date.setFullYear(date.getFullYear() + 1); break;
    default: date.setMonth(date.getMonth() + 1);
  }
  return date.toISOString().split('T')[0];
}

function calculateDueDate(issueDate: string, daysUntilDue: number): string {
  const date = new Date(issueDate);
  date.setDate(date.getDate() + daysUntilDue);
  return date.toISOString().split('T')[0];
}
