import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { initializePayment, verifyPayment } from './shared/payment';
import { notifyOwnerNewInvoicePayment } from './shared/notify-owner';
import { createNotification } from './shared/notifications';
import { formatCurrency, getLocale, getCurrencyCode, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { getPoweredByFooter } from '@/lib/whitelabel';
import { analyzeReceipt, receiptMatchesExpected } from '@/lib/bot/receipt-ocr';
import { randomBytes } from 'crypto';
import { loadPlatformSettings } from '@/lib/platformSettings';

// ── Invoice List ──
const invoiceListStep: FlowStepConfig = {
  id: 'invoice_list',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;
    const businessId = ctx.session.business_id || ctx.session.session_data.invoice_business_id as string;

    if (!businessId) {
      ctx.session.session_data._invoice_empty = true;
      return [{
        type: 'buttons',
        body: await ctx.t('You\'re all caught up — no outstanding invoices! ✅'),
        buttons: [{ id: 'back_to_account', title: '← Back' }],
      }];
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
      return [{
        type: 'buttons',
        body: await ctx.t('You\'re all caught up — no outstanding invoices! ✅'),
        buttons: [{ id: 'back_to_account', title: '← Back' }],
      }];
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
      const emoji = num <= 9 ? `${num}️⃣` : `${num}.`;
      const dueDateStr = inv.due_date
        ? new Date(inv.due_date).toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { month: 'short', day: 'numeric' })
        : 'No due date';
      const statusTag = inv.status === 'overdue' ? ' ⚠️ OVERDUE' : '';
      return `${emoji} ${inv.invoice_number} • ${formatCurrency(inv.total_amount, cc)} • Due ${dueDateStr}${statusTag}`;
    });

    return [
      {
        type: 'text',
        text: await ctx.t(`📄 *Your Invoices*\n\n${lines.join('\n')}\n\nReply with a number to view or pay.`),
      },
      {
        type: 'buttons',
        body: ' ',
        buttons: [{ id: 'back_to_account', title: '← Back' }],
      },
    ];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    // Handle back to account
    if (input === 'back_to_account') {
      return { valid: true, data: { _invoice_action: 'back_to_account' } };
    }

    // If no invoices were found, any input just routes back
    if (ctx.session.session_data._invoice_empty) {
      return { valid: true, data: { _invoice_action: 'back_to_account' } };
    }

    const list = (ctx.session.session_data._invoice_list as string[]) || [];
    const num = parseInt(input.trim(), 10);

    if (isNaN(num) || num < 1 || num > list.length) {
      return { valid: false, errorMessage: `Please reply with a number between 1 and ${list.length}.` };
    }

    return { valid: true, data: { _selected_invoice_id: list[num - 1] } };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._invoice_action === 'back_to_account') return 'my_account_menu';
    if (ctx.session.session_data._invoice_empty) return null; // End session cleanly when no invoices
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
      return [{ type: 'text', text: await ctx.t('Invoice not found. Reply *my invoices* to refresh the list.') }];
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
      `  • ${item.description} x${item.quantity} — ${formatCurrency(item.total, cc)}`
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
      { type: 'text', text: await ctx.t(summary.join('\n')) },
      {
        type: 'buttons',
        body: await ctx.t('Ready to pay, or go back?'),
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
      return [{ type: 'text', text: await ctx.t('Invoice not found. Reply *my invoices* to refresh the list.') }];
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
      ctx.session.session_data._invoice_no_user = true;
      return [{
        type: 'buttons',
        body: await ctx.t("We couldn't match your number to an account. Please contact the business directly for help."),
        buttons: [
          { id: 'done', title: 'OK' },
        ],
      }];
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
        return [{ type: 'buttons', body: await ctx.t('We couldn\'t generate a payment link right now.'), buttons: [{ id: 'cap_invoice', title: 'Try Again' }, { id: 'cap_chat', title: 'Chat with Business' }] }];
      }

      // Update invoice status to viewed
      await ctx.supabase
        .from('invoices')
        .update({ status: 'viewed' })
        .eq('id', invoiceId)
        .in('status', ['sent']); // Only update if still 'sent'

      // Notify owner that invoice payment link was sent (non-blocking)
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

      // Store payment reference and customer info for await step
      const sd = ctx.session.session_data;
      sd.payment_reference = result.reference;
      sd._invoice_id = invoice.id;
      sd._invoice_number = invoice.invoice_number;
      sd._invoice_amount = invoice.total_amount;
      sd._invoice_business_id = invoice.business_id;
      sd._invoice_customer_name = custName;

      // Check if business qualifies for direct bank transfer
      const tier = biz?.subscription_tier || 'free';
      let bankAccount: { bank_name: string; account_number: string; account_name: string } | null = null;

      if ((cc === 'NG' || cc === 'GH') && (tier === 'growth' || tier === 'business')) {
        const { data: ba } = await ctx.supabase
          .from('business_bank_accounts')
          .select('bank_name, account_number, account_name')
          .eq('business_id', invoice.business_id)
          .eq('is_active', true)
          .eq('is_default', true)
          .maybeSingle();
        bankAccount = ba;
      }

      if (bankAccount) {
        // Dual-option: online + bank transfer
        const transferRef = 'WA-' + randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
        sd.bank_transfer_reference = transferRef;
        sd.bank_transfer_offered = true;
        sd.bank_transfer_amount = invoice.total_amount;

        await ctx.supabase.from('pending_transfers').insert({
          business_id: invoice.business_id,
          invoice_id: invoice.id,
          customer_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
          customer_name: custName,
          expected_amount: Math.round(invoice.total_amount * 100),
          currency: getCurrencyCode(cc),
          reference_code: transferRef,
          status: 'pending',
          expires_at: new Date(Date.now() + (await loadPlatformSettings({ useServiceClient: true })).transfer_expiry_hours * 60 * 60 * 1000).toISOString(),
        });

        await ctx.supabase
          .from('bot_sessions')
          .update({ session_data: sd, current_step: 'await_invoice_payment' })
          .eq('id', ctx.session.id);

        return [
          {
            type: 'text',
            text: await ctx.t([
              `💳 Pay ${formatCurrency(invoice.total_amount, cc)} for Invoice ${invoice.invoice_number}`,
              '',
              `*Option 1 — Pay Online* 👇`,
              result.url,
              '',
              `*Option 2 — Bank Transfer* 🏦`,
              `Bank: ${bankAccount.bank_name}`,
              `Account: ${bankAccount.account_number}`,
              `Name: ${bankAccount.account_name}`,
              `Amount: ${formatCurrency(invoice.total_amount, cc)}`,
              `Reference: *${transferRef}*`,
              '',
              `⚠️ Use reference *${transferRef}* as your transfer narration.`,
            ].join('\n')),
          },
          {
            type: 'buttons',
            body: "After paying, tap below:",
            buttons: [
              { id: 'i_paid_online', title: "I've Paid Online" },
              { id: 'sent_transfer', title: "I've Sent Transfer" },
              { id: 'go_back', title: 'Cancel' },
            ],
          },
        ];
      }

      // Standard online-only flow — end session
      await ctx.supabase.from('bot_sessions').update({
        current_step: 'complete',
        is_active: false,
        last_active_at: new Date().toISOString(),
      }).eq('id', ctx.session.id);

      return [{
        type: 'text',
        text: await ctx.t(`💳 Pay ${formatCurrency(invoice.total_amount, cc)} for Invoice ${invoice.invoice_number}\n\nTap the link below to pay securely:\n${result.url}\n\n💡 *What you can do:*\n• Type *my invoices* to check your invoices\n• Type *receipt* to get your payment receipt${getPoweredByFooter(biz.subscription_tier)}`),
      }];
    } catch (err) {
      logger.error('[INVOICE] Payment initialization error:', err);
      return [{ type: 'buttons', body: await ctx.t('We couldn\'t generate a payment link right now.'), buttons: [{ id: 'cap_invoice', title: 'Try Again' }, { id: 'cap_chat', title: 'Chat with Business' }] }];
    }
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    if (input === 'done' && ctx.session.session_data._invoice_no_user) {
      return { valid: true, data: { _invoice_action: 'done' } };
    }
    if (input === 'cap_invoice') {
      return { valid: true, data: { _invoice_action: 'retry' } };
    }
    if (input === 'cap_chat') {
      return { valid: true, data: { _invoice_action: 'chat' } };
    }
    if (input === 'done') {
      return { valid: true, data: { _invoice_action: 'done' } };
    }
    return { valid: true };
  },

  async next(ctx: FlowContext) {
    const action = ctx.session.session_data._invoice_action;
    if (action === 'retry') return 'invoice_pay'; // re-prompt (retry payment)
    if (action === 'chat') return 'chat_start'; // route to live chat
    if (ctx.session.session_data.bank_transfer_offered) return 'await_invoice_payment';
    return null; // done — end session
  },
};

// ── Await Invoice Payment (bank transfer) ──
const awaitInvoicePaymentStep: FlowStepConfig = {
  id: 'await_invoice_payment',
  acceptsMedia: true,

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const sd = ctx.session.session_data;
    if (sd.bank_transfer_offered) {
      return [{
        type: 'buttons',
        body: "Complete your payment using the link or bank transfer above.\n\nTap below after paying:",
        buttons: [
          { id: 'i_paid_online', title: "I've Paid Online" },
          { id: 'sent_transfer', title: "I've Sent Transfer" },
          { id: 'go_back', title: 'Cancel' },
        ],
      }];
    }
    return [{
      type: 'buttons',
      body: "Complete payment using the link above.\n\nPaid already? Tap below to confirm:",
      buttons: [
        { id: 'i_paid', title: "I've Paid" },
        { id: 'go_back', title: 'Cancel' },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const text = input.toLowerCase();
    const sd = ctx.session.session_data;

    if ((text === 'cancel' || text === 'go_back')) {
      if (sd.bank_transfer_reference) {
        await ctx.supabase
          .from('pending_transfers')
          .update({ status: 'cancelled' })
          .eq('reference_code', sd.bank_transfer_reference as string);
      }
      await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('Invoice payment cancelled. Send *Hi* to start over.') });
      return { valid: true, data: { _action: 'cancel' } };
    }

    // ── Bank transfer proof: image uploaded ──
    if (ctx.mediaType === 'image' && ctx.mediaUrl && sd.bank_transfer_reference) {
      const transferRef = sd.bank_transfer_reference as string;
      const expectedAmount = sd.bank_transfer_amount as number;
      const cc = (ctx.business?.country_code || 'NG') as CountryCode;
      const currency = getCurrencyCode(cc);

      const ocr = await analyzeReceipt(ctx.mediaUrl, expectedAmount, transferRef, currency);
      const ocrMatches = receiptMatchesExpected(ocr, expectedAmount, transferRef);

      await ctx.supabase
        .from('pending_transfers')
        .update({
          proof_type: 'screenshot',
          proof_image_url: ctx.mediaUrl,
          verified_by_ocr: ocrMatches,
          ocr_result: ocrMatches ? { amount: ocr.amount, reference: ocr.reference, sender_name: ocr.senderName, bank_name: ocr.bankName, confidence: ocr.confidence } : null,
        })
        .eq('reference_code', transferRef)
        .eq('status', 'pending');

      if (ctx.business) {
        const custName = (sd._invoice_customer_name as string) || 'Customer';
        notifyOwnerNewInvoicePayment({
          supabase: ctx.supabase,
          sender: ctx.sender,
          businessId: sd._invoice_business_id as string,
          businessName: ctx.business.name,
          countryCode: cc,
          referenceCode: transferRef,
          customerName: custName,
          amount: expectedAmount,
          invoiceNumber: `${sd._invoice_number as string} (Bank Transfer)`,
        }).catch(err => logger.error('[INVOICE] Transfer notify error:', err));

        createNotification(ctx.supabase, {
          businessId: sd._invoice_business_id as string,
          type: 'transfer_proof_received',
          channel: 'whatsapp',
          body: `Transfer proof received from ${custName} for ${formatCurrency(expectedAmount, cc)} invoice payment. Ref: ${transferRef}. Confirm in Dashboard → Pending Transfers.`,
        }).catch(err => logger.error('[INVOICE] Transfer notification error:', err));
      }

      const ocrHint = ocrMatches ? `\n\n🤖 _Our AI verified your receipt — amount and reference match._` : '';
      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t(`✅ Payment proof received. *${ctx.business?.name || 'The business'}* will review and confirm your invoice payment shortly.\n\nRef: *${transferRef}*${ocrHint}\n\nSend *Hi* to continue.`),
      });
      return { valid: true, data: { _action: 'transfer_proof_sent' } };
    }

    // ── "I've Sent Transfer" button ──
    if (text === 'sent_transfer' || text === "i've sent transfer" || text === 'i_sent_transfer') {
      if (!sd.bank_transfer_reference) {
        return { valid: false, errorMessage: 'No bank transfer reference found. Please use the online payment link instead.' };
      }
      sd._awaiting_transfer_proof = true;
      await ctx.supabase.from('bot_sessions').update({ session_data: sd }).eq('id', ctx.session.id);
      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t(`Please send a *screenshot* of your transfer receipt, or type the bank *transaction reference* so we can verify your payment.\n\nRef: *${sd.bank_transfer_reference}*`),
      });
      return { valid: false, errorMessage: '' };
    }

    // ── Text proof after tapping "I've Sent Transfer" ──
    if (sd._awaiting_transfer_proof && text && !['i_paid', 'i_paid_online', 'paid', 'done', 'check'].includes(text)) {
      await ctx.supabase
        .from('pending_transfers')
        .update({ proof_type: 'text', proof_text: input.trim() })
        .eq('reference_code', sd.bank_transfer_reference as string)
        .eq('status', 'pending');

      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t(`✅ Transfer reference received. *${ctx.business?.name || 'The business'}* will review and confirm your invoice payment shortly.\n\nRef: *${sd.bank_transfer_reference}*\n\nSend *Hi* to continue.`),
      });
      return { valid: true, data: { _action: 'transfer_proof_sent' } };
    }

    if (text === 'i_paid' || text === 'i_paid_online' || text === 'paid' || text === 'done' || text === 'check') {
      const ref = sd.payment_reference as string;
      if (!ref) return { valid: true, data: { _action: 'cancel' } };

      const cc = (ctx.business?.country_code || 'NG') as CountryCode;
      const verified = await verifyPayment(ctx.supabase, ref, cc);

      if (verified) {
        const invoiceNum = sd._invoice_number as string;
        const amount = sd._invoice_amount as number;

        await ctx.sender.sendText({
          to: ctx.from,
          text: await ctx.t([
            `✅ *Payment Confirmed!*`,
            '',
            `Invoice ${invoiceNum} has been paid.`,
            `💰 Amount: ${formatCurrency(amount, cc)}`,
            '',
            '💡 *What you can do:*',
            '• Type *my invoices* to check your invoices',
            '• Type *receipt* to get your payment receipt',
            '• Type *Hi* to start over',
            ...(getPoweredByFooter(ctx.business?.subscription_tier) ? ['', '_Powered by Waaiio_'] : []),
          ].join('\n')),
        });

        return { valid: true, data: { _action: 'payment_confirmed' } };
      }

      return { valid: false, errorMessage: "Payment not yet received. The link may have expired — please try again or send your transfer proof." };
    }

    return { valid: false, errorMessage: "Tap *I've Paid Online*, *I've Sent Transfer*, or *Cancel*." };
  },

  async next() {
    return null; // Flow complete after confirmation, proof, or cancel
  },
};

export const invoiceFlow: FlowDefinition = {
  type: 'scheduling', // placeholder — pseudo-flow
  steps: [invoiceListStep, invoiceDetailStep, invoicePayStep, awaitInvoicePaymentStep],
};
