import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { initializePayment } from './shared/payment';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';

// ── Invoice List ──
const invoiceListStep: FlowStepConfig = {
  id: 'invoice_list',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;
    const businessId = ctx.session.business_id || ctx.session.session_data.invoice_business_id as string;

    if (!businessId) {
      return [{ type: 'text', text: 'You\u2019re all caught up \u2014 no outstanding invoices! \u2705' }];
    }

    const { data: invoices } = await ctx.supabase
      .from('invoices')
      .select('id, invoice_number, total_amount, due_date, status, businesses!inner(name, country_code)')
      .or(`customer_phone.eq.${phone},customer_phone.eq.${phoneN}`)
      .eq('business_id', businessId)
      .in('status', ['sent', 'viewed', 'overdue'])
      .order('due_date', { ascending: true })
      .limit(10);

    if (!invoices || invoices.length === 0) {
      return [{ type: 'text', text: 'You\u2019re all caught up \u2014 no outstanding invoices! \u2705' }];
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
      const emoji = num <= 9 ? `${num}\uFE0F\u20E3` : `${num}.`;
      const dueDateStr = inv.due_date
        ? new Date(inv.due_date).toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { month: 'short', day: 'numeric' })
        : 'No due date';
      const statusTag = inv.status === 'overdue' ? ' \u26A0\uFE0F OVERDUE' : '';
      return `${emoji} ${inv.invoice_number} \u2022 ${formatCurrency(inv.total_amount, cc)} \u2022 Due ${dueDateStr}${statusTag}`;
    });

    return [{
      type: 'text',
      text: `\uD83D\uDCC4 *Your Invoices*\n\n${lines.join('\n')}\n\nReply with a number to view or pay.`,
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const list = (ctx.session.session_data._invoice_list as string[]) || [];
    const num = parseInt(input.trim(), 10);

    if (isNaN(num) || num < 1 || num > list.length) {
      return { valid: false, errorMessage: `Please reply with a number between 1 and ${list.length}.` };
    }

    return { valid: true, data: { _selected_invoice_id: list[num - 1] } };
  },

  async next() {
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
    const statusTag = invoice.status === 'overdue' ? ' \u26A0\uFE0F OVERDUE' : '';

    const itemLines = (items || []).map(item =>
      `  \u2022 ${item.description} x${item.quantity} \u2014 ${formatCurrency(item.total, cc)}`
    );

    const summary = [
      `\uD83D\uDCC4 *Invoice ${invoice.invoice_number}*`,
      '',
      `From: ${biz?.name || 'Business'}`,
      `Date: ${createdDate}`,
      `Due: ${dueDate}${statusTag}`,
      '',
      `\uD83D\uDCCB Items:`,
      ...itemLines,
      '',
      `\uD83D\uDCB0 Total: *${formatCurrency(invoice.total_amount, cc)}*`,
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
        .or(`phone.eq.${phone},phone.eq.${phoneN}`)
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

      // End session
      await ctx.supabase.from('bot_sessions').update({
        current_step: 'complete',
        is_active: false,
      }).eq('id', ctx.session.id);

      return [{
        type: 'text',
        text: `\uD83D\uDCB3 Pay ${formatCurrency(invoice.total_amount, cc)} for Invoice ${invoice.invoice_number}\n\nTap the link below to pay securely:\n${result.url}\n\n💡 *What you can do:*\n• Type *my invoices* to check your invoices\n• Type *receipt* to get your payment receipt`,
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
