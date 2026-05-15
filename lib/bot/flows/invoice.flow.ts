import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { initializePayment } from './shared/payment';
import { notifyOwnerNewInvoicePayment } from './shared/notify-owner';
import { createNotification } from './shared/notifications';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

// ── Invoice List ──
const invoiceListStep: FlowStepConfig = {
  id: 'invoice_list',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;
    const businessId = ctx.session.business_id || ctx.session.session_data.invoice_business_id as string;

    if (!businessId) {
      ctx.session.session_data._invoice_empty = true;
      await ctx.sender.sendText({ to: ctx.from, text: 'You\u2019re all caught up \u2014 no outstanding invoices! \u2705' });
      return [];
    }

    const { data: invoices } = await ctx.supabase
      .from('invoices')
      .select('id, invoice_number, total_amount, due_date, status, businesses!inner(name, country_code)')
      .or(`customer_phone.eq.${sanitizeFilterValue(phone)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .eq('business_id', businessId)
      .in('status', ['sent', 'viewed', 'overdue'])
      .order('due_date', { ascending: true })
      .limit(10);

    if (!invoices || invoices.length === 0) {
      ctx.session.session_data._invoice_empty = true;
      await ctx.sender.sendText({ to: ctx.from, text: 'You\u2019re all caught up \u2014 no outstanding invoices! \u2705' });
      return [];
    }

    // Store invoice list for selection
    ctx.session.session_data._invoice_list = invoices.map(inv => inv.id);
    await ctx.supabase.from('bot_sessions').update({
      session_data: ctx.session.session_data,
    }).eq('id', ctx.session.id);

    const biz = invoices[0].businesses as unknown as { name: string; country_code: string } | null;
    const cc = (biz?.country_code || ctx.business?.country_code || 'NG') as CountryCode;

    const lines = invoices.map((inv, i) => {
      const num = i + 1;
      const emoji = num <= 9 ? `${num}️\u20E3` : `${num}.`;
      const dueDateStr = inv.due_date
        ? new Date(inv.due_date).toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { month: 'short', day: 'numeric' })
        : 'No due date';
      const statusTag = inv.status === 'overdue' ? ' ⚠️ OVERDUE' : '';
      return `${emoji} ${inv.invoice_number} \u2022 ${formatCurrency(inv.total_amount, cc)} \u2022 Due ${dueDateStr}${statusTag}`;
    });

    return [{
      type: 'text',
      text: `📄 *Your Invoices*\n\n${lines.join('\n')}\n\nReply with a number to view or pay.`,
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    // If no invoices were found, any input just routes back
    if (ctx.session.session_data._invoice_empty) {
      return { valid: true };
    }

    const list = (ctx.session.session_data._invoice_list as string[]) || [];
    const num = parseInt(input.trim(), 10);

    if (isNaN(num) || num < 1 || num > list.length) {
      return { valid: false, errorMessage: `Please reply with a number between 1 and ${list.length}.` };
    }

    return { valid: true, data: { _selected_invoice_id: list[num - 1] } };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._invoice_empty) return 'my_account_menu';
    return 'invoice_detail';
  },
};

// ── Invoice Detail ──
const invoiceDetailStep: FlowStepConfig = {
  id: 'invoice_detail',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const invoiceId = ctx.session.session_data._selected_invoice_id as string;

    const { data: invoice } = await ctx.supabase
      .from('invoices')
      .select('id, invoice_number, total_amount, due_date, status, created_at, businesses!inner(name, country_code)')
      .eq('id', invoiceId)
      .single();

    if (!invoice) {
      return [{ type: 'text', text: 'Invoice not found. Reply *my invoices* to refresh the list.' }];
    }

    const { data: items } = await ctx.supabase
      .from('invoice_items')
      .select('description, quantity, unit_price, total')
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: true });

    const biz = invoice.businesses as unknown as { name: string; country_code: string };
    const cc = (biz?.country_code || ctx.business?.country_code || 'NG') as CountryCode;

    const createdDate = new Date(invoice.created_at).toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    const dueDate = invoice.due_date
      ? new Date(invoice.due_date).toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { month: 'short', day: 'numeric', year: 'numeric' })
      : 'N/A';
    const statusTag = invoice.status === 'overdue' ? ' ⚠️ OVERDUE' : '';

    const itemLines = (items || []).map(item =>
      `  \u2022 ${item.description} x${item.quantity} \u2014 ${formatCurrency(item.total, cc)}`
    );

    const summary = [
      `📄 *Invoice ${invoice.invoice_number}*`,
      '',
      `From: ${biz?.name || 'Business'}`,
      `Date: ${createdDate}`,
      `Due: ${dueDate}${statusTag}`,
      '',
      `📋 Items:`,
      ...itemLines,
      '',
      `💰 Total: *${formatCurrency(invoice.total_amount, cc)}*`,
    ];

    return [
      { type: 'text', text: summary.join('\n') },
      {
        type: 'buttons',
        body: 'Ready to pay, or go back?',
        buttons: [
          { id: 'pay', title: 'Pay Now' },
          { id: 'back', title: 'Back to List' },
        ],
      },
    ];
  },

  async validate(input: string): Promise<ValidationResult> {
    if (input === 'pay') return { valid: true, data: { _invoice_action: 'pay' } };
    if (input === 'back') return { valid: true, data: { _invoice_action: 'back' } };
    return { valid: false, errorMessage: 'Tap one of the buttons above to continue.' };
  },

  async next(ctx: FlowContext) {
    const action = ctx.session.session_data._invoice_action;
    if (action === 'back') return 'invoice_list';
    return 'invoice_pay';
  },
};

// ── Invoice Pay ──
const invoicePayStep: FlowStepConfig = {
  id: 'invoice_pay',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const invoiceId = ctx.session.session_data._selected_invoice_id as string;

    const { data: invoice } = await ctx.supabase
      .from('invoices')
      .select('id, invoice_number, total_amount, business_id, businesses!inner(name, country_code, payment_gateway, subscription_tier)')
      .eq('id', invoiceId)
      .single();

    if (!invoice) {
      return [{ type: 'text', text: 'Invoice not found. Reply *my invoices* to refresh the list.' }];
    }

    const biz = invoice.businesses as unknown as { name: string; country_code: string; payment_gateway: string | null; subscription_tier: string };
    const cc = (biz?.country_code || 'NG') as CountryCode;

    // Find or create user
    let userId = ctx.session.user_id;
    if (!userId) {
      const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
      const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;
      const { data: profile } = await ctx.supabase
        .from('profiles')
        .select('id')
        .or(`phone.eq.${sanitizeFilterValue(phone)},phone.eq.${sanitizeFilterValue(phoneN)}`)
        .limit(1)
        .maybeSingle();
      userId = profile?.id || null;
    }

    if (!userId) {
      return [{ type: 'text', text: 'We couldn\u2019t match your number to an account. Send *Hi* to set one up, then try again.' }];
    }

    try {
      const result = await initializePayment(ctx.supabase, {
        invoiceId: invoice.id,
        userId,
        amount: invoice.total_amount,
        referenceCode: invoice.invoice_number,
        businessName: biz?.name || 'Business',
        phone: ctx.from,
        countryCode: cc as CountryCode,
        gatewayOverride: biz?.payment_gateway || null,
        businessId: invoice.business_id,
      });

      if (!result) {
        return [{ type: 'buttons', body: 'We couldn\u2019t generate a payment link right now.', buttons: [{ id: 'cap_invoice', title: 'Try Again' }, { id: 'cap_chat', title: 'Chat with Business' }] }];
      }

      // Update invoice status to viewed
      await ctx.supabase
        .from('invoices')
        .update({ status: 'viewed' })
        .eq('id', invoiceId)
        .in('status', ['sent']); // Only update if still 'sent'

      // Notify owner that invoice payment link was sent (non-blocking)
      // The customer name comes from the invoice record
      const { data: customerProfile } = await ctx.supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', userId!)
        .maybeSingle();
      const custName = customerProfile
        ? `${customerProfile.first_name || ''} ${customerProfile.last_name || ''}`.trim() || 'Customer'
        : 'Customer';

      notifyOwnerNewInvoicePayment({
        supabase: ctx.supabase,
        sender: ctx.sender,
        businessId: invoice.business_id,
        businessName: biz?.name || 'Business',
        countryCode: cc,
        referenceCode: invoice.invoice_number,
        customerName: custName,
        amount: invoice.total_amount,
        invoiceNumber: invoice.invoice_number,
      }).catch(err => logger.error('[INVOICE] Notify error:', err));

      // In-app notification
      createNotification(ctx.supabase, {
        businessId: invoice.business_id,
        type: 'invoice_payment',
        channel: 'whatsapp',
        body: `${custName} opened payment link for Invoice ${invoice.invoice_number} (${formatCurrency(invoice.total_amount, cc)}).`,
      }).catch(err => logger.error('[INVOICE] Notification error:', err));

      // End session
      await ctx.supabase.from('bot_sessions').update({
        current_step: 'complete',
        is_active: false,
      }).eq('id', ctx.session.id);

      return [{
        type: 'text',
        text: `💳 Pay ${formatCurrency(invoice.total_amount, cc)} for Invoice ${invoice.invoice_number}\n\nTap the link below to pay securely:\n${result.url}\n\n💡 *What you can do:*\n• Type *my invoices* to check your invoices\n• Type *receipt* to get your payment receipt`,
      }];
    } catch (err) {
      logger.error('[INVOICE] Payment initialization error:', err);
      return [{ type: 'buttons', body: 'We couldn\u2019t generate a payment link right now.', buttons: [{ id: 'cap_invoice', title: 'Try Again' }, { id: 'cap_chat', title: 'Chat with Business' }] }];
    }
  },

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  },

  async next() {
    return null;
  },
};

export const invoiceFlow: FlowDefinition = {
  type: 'scheduling', // placeholder — pseudo-flow
  steps: [invoiceListStep, invoiceDetailStep, invoicePayStep],
};
