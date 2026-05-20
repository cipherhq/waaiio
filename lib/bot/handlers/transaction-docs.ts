import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { MessageSender } from '@/lib/channels/message-sender';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

/**
 * Handle a transaction document request (history, receipt, or annual statement).
 */
export async function handleTransactionDocument(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  userId: string,
  type: 'history' | 'receipt' | 'annual',
): Promise<void> {
  const labelMap = { history: 'transaction history', receipt: 'receipt', annual: 'annual statement' };
  const label = labelMap[type];
  await sendText(from, `Generating your ${label}... 📄`);

  try {
    // Try PDF first, fall back to text receipt
    let pdfSent = false;
    try {
      const { generateDocumentDirect } = await import('@/lib/receipts/generate-direct');
      const result = await generateDocumentDirect(userId, type, from);
      if (result) {
        await messageSender.sendDocument({
          to: from,
          documentUrl: result.url,
          filename: result.filename,
          caption: type === 'history' ? 'Your transaction history' : type === 'annual' ? 'Your annual statement' : 'Your latest receipt',
        });
        pdfSent = true;
      }
    } catch (pdfErr) {
      logger.error('[BOT] PDF receipt failed, falling back to text:', pdfErr);
    }

    // Fallback: send a text receipt with recent transaction details
    if (!pdfSent) {
      const textReceipt = await buildTextReceipt(supabase, userId, from, type);
      if (textReceipt) {
        await sendText(from, textReceipt);
      } else {
        await sendText(from, `No transactions found. Make a booking first, then come back for your ${label}!`);
      }
    }
  } catch (err) {
    logger.error('[BOT] handleTransactionDocument error:', err);
    await sendText(from, `Sorry, I couldn't generate your ${label} right now. Please try again later.`);
  }
}

/**
 * Build a text-based receipt when PDF generation fails.
 */
export async function buildTextReceipt(supabase: SupabaseClient, userId: string, phone: string, type: string): Promise<string | null> {
  const phoneP = phone.startsWith('+') ? phone : `+${phone}`;
  const phoneN = phone.startsWith('+') ? phone.slice(1) : phone;

  // Fetch recent transactions from multiple sources
  const [{ data: bookings }, { data: payments }, { data: invoices }, { data: donations }] = await Promise.all([
    supabase.from('bookings')
      .select('reference_code, date, total_amount, status, created_at, services(name), businesses(name, country_code)')
      .eq('user_id', userId)
      .in('status', ['completed', 'confirmed', 'pending'])
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('payments')
      .select('gateway_reference, amount, status, created_at, businesses:business_id(name, country_code)')
      .eq('user_id', userId).eq('status', 'success')
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('invoices')
      .select('invoice_number, total_amount, status, paid_at, businesses:business_id(name, country_code)')
      .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .eq('status', 'paid')
      .order('paid_at', { ascending: false }).limit(3),
    supabase.from('campaign_donations')
      .select('amount, reference_code, created_at, campaigns:campaign_id(name), businesses:business_id(name, country_code)')
      .or(`donor_phone.eq.${sanitizeFilterValue(phoneP)},donor_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .eq('status', 'success')
      .order('created_at', { ascending: false }).limit(3),
  ]);

  const lines: string[] = [];

  if (bookings && bookings.length > 0) {
    const b = bookings[0];
    const biz = b.businesses as unknown as { name: string; country_code?: string } | null;
    const svc = b.services as unknown as { name: string } | null;
    const cc = biz?.country_code as CountryCode || 'NG';
    const dateStr = new Date(b.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

    lines.push(
      '*Receipt*',
      '',
      `Business: *${biz?.name || 'Business'}*`,
      `Service: ${svc?.name || b.reference_code || 'Service'}`,
      `Date: ${dateStr}`,
      `Amount: ${formatCurrency(b.total_amount || 0, cc)}`,
      `Ref: *${b.reference_code}*`,
      `Status: ${b.status}`,
    );
  } else if (payments && payments.length > 0) {
    const p = payments[0];
    const biz = p.businesses as unknown as { name: string; country_code?: string } | null;
    const cc = biz?.country_code as CountryCode || 'NG';
    const dateStr = new Date(p.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

    lines.push(
      '*Receipt*',
      '',
      `Business: *${biz?.name || 'Business'}*`,
      `Date: ${dateStr}`,
      `Amount: ${formatCurrency(p.amount || 0, cc)}`,
      `Ref: *${p.gateway_reference}*`,
      `Status: Paid`,
    );
  } else if (donations && donations.length > 0) {
    const d = donations[0];
    const biz = d.businesses as unknown as { name: string; country_code?: string } | null;
    const campaign = d.campaigns as unknown as { name: string } | null;
    const cc = (biz?.country_code as CountryCode) || 'NG';
    const dateStr = new Date(d.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

    lines.push(
      '*Donation Receipt*',
      '',
      `Organization: *${biz?.name || 'Organization'}*`,
      `Campaign: ${campaign?.name || 'Donation'}`,
      `Date: ${dateStr}`,
      `Amount: ${formatCurrency(Number(d.amount), cc)}`,
      `Ref: *${d.reference_code}*`,
    );
  } else if (invoices && invoices.length > 0) {
    const inv = invoices[0];
    const biz = inv.businesses as unknown as { name: string; country_code?: string } | null;
    const cc = (biz?.country_code as CountryCode) || 'NG';
    const dateStr = inv.paid_at ? new Date(inv.paid_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

    lines.push(
      '*Invoice Receipt*',
      '',
      `Business: *${biz?.name || 'Business'}*`,
      `Invoice: ${inv.invoice_number}`,
      `Paid: ${dateStr}`,
      `Amount: ${formatCurrency(Number(inv.total_amount), cc)}`,
    );
  }

  if (lines.length === 0) return null;

  lines.push('', 'Type *Hi* to continue');
  return lines.join('\n');
}
