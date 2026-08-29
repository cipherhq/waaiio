import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { initializePayment } from './shared/payment';
import { notifyOwnerNewInvoicePayment } from './shared/notify-owner';
import { createNotification } from './shared/notifications';
import { formatCurrency, getLocale, getCurrencyCode, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { getPoweredByFooter } from '@/lib/whitelabel';
import { analyzeReceipt, receiptMatchesExpected } from '@/lib/bot/receipt-ocr';
import { parseIvePaidInput, isIvePaidInput } from '@/lib/bot/flows/shared/ive-paid-input';
import { checkBankTransferEligibility, createPendingTransfer, formatBankTransferBlock, BANK_ONLY_BUTTONS } from './shared/bank-transfer';

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
      .select('id, reference_code, total_amount, due_date, status, businesses!inner(name, country_code)')
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
      return `${emoji} ${inv.reference_code} • ${formatCurrency(inv.total_amount, cc)} • Due ${dueDateStr}${statusTag}`;
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
      .select('id, reference_code, total_amount, due_date, status, created_at, businesses!inner(name, country_code)')
      .eq('id', invoiceId)
      .single();

    if (!invoice) {
      return [{ type: 'text', text: await ctx.t('Invoice not found. Reply *my invoices* to refresh the list.') }];
    }

    const { data: items } = await ctx.supabase
      .from('invoice_items')
      .select('description, quantity, unit_price, amount')
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
      `  • ${item.description} x${item.quantity} — ${formatCurrency(item.amount, cc)}`
    );

    const summary = [
      `📄 *Invoice ${invoice.reference_code}*`,
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

    const { data: invoice, error: invoiceError } = await ctx.supabase
      .from('invoices')
      .select('id, reference_code, total_amount, amount_paid, status, business_id, businesses!inner(name, country_code, payment_gateway, subscription_tier)')
      .eq('id', invoiceId)
      .single();

    if (invoiceError || !invoice) {
      logger.error('[INVOICE] Pay step fetch failed', invoiceError ? { op: 'invoice-pay-fetch' } : undefined);
      return [{ type: 'text', text: await ctx.t('Invoice not found. Reply *my invoices* to refresh the list.') }];
    }

    // Revalidate status — invoice may have changed since the list was shown
    const NON_PAYABLE = ['paid', 'cancelled', 'draft'];
    if (NON_PAYABLE.includes(invoice.status)) {
      const label = invoice.status === 'paid' ? 'already been paid' : invoice.status === 'cancelled' ? 'been cancelled' : 'not yet been sent';
      return [{
        type: 'buttons',
        body: await ctx.t(`This invoice has ${label}. No payment is needed.`),
        buttons: [{ id: 'cap_invoice', title: 'My Invoices' }],
      }];
    }

    // Compute outstanding balance — never charge more than what's owed
    const totalAmount = Number(invoice.total_amount) || 0;
    const amountPaid = Number(invoice.amount_paid) || 0;
    const remainingAmount = Math.max(0, totalAmount - amountPaid);

    if (remainingAmount <= 0) {
      return [{
        type: 'buttons',
        body: await ctx.t('This invoice has already been fully paid. ✅'),
        buttons: [{ id: 'cap_invoice', title: 'My Invoices' }],
      }];
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
        amount: remainingAmount,
        referenceCode: invoice.reference_code,
        businessName: biz?.name || 'Business',
        phone: ctx.from,
        countryCode: cc as CountryCode,
        gatewayOverride: biz?.payment_gateway || null,
        businessId: invoice.business_id,
        inboundChannelId: ctx.session.session_data._inbound_channel_id as string | undefined,
        confirmationOrigin: 'whatsapp' as const,
      });

      // Check if business qualifies for direct bank transfer
      const { qualifies: _btQualifies, bankAccount, platformSettings: ps } = await checkBankTransferEligibility(ctx.supabase, {
        businessId: invoice.business_id,
        countryCode: cc,
        subscriptionTier: biz?.subscription_tier || 'free',
        amount: remainingAmount,
      });

      // Notify owner that invoice payment link was sent (non-blocking)
      const { data: customerProfile } = await ctx.supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', userId!)
        .maybeSingle();
      const custName = customerProfile
        ? `${customerProfile.first_name || ''} ${customerProfile.last_name || ''}`.trim() || 'Customer'
        : 'Customer';

      if (!result) {
        // Payment gateway failed — but bank transfer may still be available
        if (bankAccount) {
          const sd = ctx.session.session_data;
          sd._invoice_id = invoice.id;
          sd._invoice_ref = invoice.reference_code;
          sd._invoice_amount = remainingAmount;
          sd._invoice_business_id = invoice.business_id;
          sd._invoice_customer_name = custName;

          const transferRef = await createPendingTransfer(ctx.supabase, {
            businessId: invoice.business_id,
            entityId: { invoice_id: invoice.id },
            customerPhone: ctx.from,
            customerName: custName,
            amount: remainingAmount,
            countryCode: cc,
            transferExpiryHours: ps.transfer_expiry_hours,
          });
          sd.bank_transfer_reference = transferRef;
          sd.bank_transfer_offered = true;
          sd.bank_transfer_amount = remainingAmount;

          await ctx.supabase
            .from('bot_sessions')
            .update({ session_data: sd, current_step: 'await_invoice_payment' })
            .eq('id', ctx.session.id);

          return [
            {
              type: 'text',
              text: await ctx.t([
                `🏦 *Bank Transfer Payment*`,
                '',
                `💳 Invoice ${invoice.reference_code}`,
                `💰 ${formatCurrency(remainingAmount, cc)}`,
                '',
                `Transfer to:`,
                formatBankTransferBlock(bankAccount, formatCurrency(remainingAmount, cc), transferRef),
              ].join('\n')),
            },
            {
              type: 'buttons',
              body: 'Tap below after transferring:',
              buttons: [...BANK_ONLY_BUTTONS],
            },
          ];
        }

        return [{ type: 'buttons', body: await ctx.t('We couldn\'t generate a payment link right now.'), buttons: [{ id: 'cap_invoice', title: 'Try Again' }, { id: 'cap_chat', title: 'Chat with Business' }] }];
      }

      // Update invoice status to viewed
      await ctx.supabase
        .from('invoices')
        .update({ status: 'viewed' })
        .eq('id', invoiceId)
        .in('status', ['sent']); // Only update if still 'sent'

      notifyOwnerNewInvoicePayment({
        supabase: ctx.supabase,
        sender: ctx.sender,
        businessId: invoice.business_id,
        businessName: biz?.name || 'Business',
        countryCode: cc,
        referenceCode: invoice.reference_code,
        customerName: custName,
        amount: remainingAmount,
        invoiceNumber: invoice.reference_code,
      }).catch(err => logger.error('[INVOICE] Notify error:', err));

      // In-app notification
      createNotification(ctx.supabase, {
        businessId: invoice.business_id,
        type: 'invoice_payment',
        channel: 'whatsapp',
        body: `${custName} opened payment link for Invoice ${invoice.reference_code} (${formatCurrency(remainingAmount, cc)}).`,
      }).catch(err => logger.error('[INVOICE] Notification error:', err));

      // Store payment reference and customer info for await step
      const sd = ctx.session.session_data;
      sd.payment_reference = result.reference;
      sd._invoice_id = invoice.id;
      sd._invoice_ref = invoice.reference_code;
      sd._invoice_amount = remainingAmount;
      sd._invoice_business_id = invoice.business_id;
      sd._invoice_customer_name = custName;

      if (bankAccount) {
        // Dual-option: online + bank transfer
        const transferRef = await createPendingTransfer(ctx.supabase, {
          businessId: invoice.business_id,
          entityId: { invoice_id: invoice.id },
          customerPhone: ctx.from,
          customerName: custName,
          amount: remainingAmount,
          countryCode: cc,
          transferExpiryHours: ps.transfer_expiry_hours,
        });
        sd.bank_transfer_reference = transferRef;
        sd.bank_transfer_offered = true;
        sd.bank_transfer_amount = remainingAmount;

        await ctx.supabase
          .from('bot_sessions')
          .update({ session_data: sd, current_step: 'await_invoice_payment' })
          .eq('id', ctx.session.id);

        return [
          {
            type: 'text',
            text: await ctx.t([
              `💳 Pay ${formatCurrency(remainingAmount, cc)} for Invoice ${invoice.reference_code}`,
              '',
              `*Option 1 — Pay Online* 👇`,
              result.url,
              '',
              `*Option 2 — Bank Transfer* 🏦`,
              formatBankTransferBlock(bankAccount, formatCurrency(remainingAmount, cc), transferRef),
            ].join('\n')),
          },
          {
            type: 'buttons',
            body: "After paying, tap below:",
            buttons: [
              { id: sd.payment_reference ? `i_paid_ref:${sd.payment_reference}` : 'i_paid_online', title: "I've Paid Online" },
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
        text: await ctx.t(`💳 Pay ${formatCurrency(remainingAmount, cc)} for Invoice ${invoice.reference_code}\n\nTap the link below to pay securely:\n${result.url}\n\n💡 *What you can do:*\n• Type *my invoices* to check your invoices\n• Type *receipt* to get your payment receipt${getPoweredByFooter(biz.subscription_tier)}`),
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
    const pRef = sd.payment_reference as string | undefined;
    if (sd.bank_transfer_offered) {
      return [{
        type: 'buttons',
        body: "Complete your payment using the link or bank transfer above.\n\nTap below after paying:",
        buttons: [
          { id: pRef ? `i_paid_ref:${pRef}` : 'i_paid_online', title: "I've Paid Online" },
          { id: 'sent_transfer', title: "I've Sent Transfer" },
          { id: 'go_back', title: 'Cancel' },
        ],
      }];
    }
    return [{
      type: 'buttons',
      body: "Complete payment using the link above.\n\nPaid already? Tap below to confirm:",
      buttons: [
        { id: pRef ? `i_paid_ref:${pRef}` : 'i_paid', title: "I've Paid" },
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
          invoiceNumber: `${sd._invoice_ref as string} (Bank Transfer)`,
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
    if (sd._awaiting_transfer_proof && text && !isIvePaidInput(text)) {
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

    const ivePaidResult = parseIvePaidInput(text);
    if (ivePaidResult.recognized) {
      const ref = sd.payment_reference as string;

      // #219: If locator doesn't match active session reference, route through
      // recoverByPaymentReference — do NOT substitute the active session's reference.
      if (ivePaidResult.paymentRef && ref && ivePaidResult.paymentRef !== ref) {
        const { recoverByPaymentReference } = await import('@/lib/payments/stale-payment-recovery');
        const { data: recBiz } = await ctx.supabase.from('businesses')
          .select('country_code').eq('id', ctx.session.business_id).single();
        const cc = (recBiz?.country_code || 'NG') as import('@/lib/constants').CountryCode;
        const recoveryResult = await recoverByPaymentReference(
          { supabase: ctx.supabase, businessId: ctx.session.business_id!, userId: ctx.session.user_id || null, phone: ctx.from, countryCode: cc },
          ivePaidResult.paymentRef,
        );
        await ctx.sender.sendText({ to: ctx.from, text: recoveryResult.message });
        // #219: Keep active session at current step — do not end Payment B because of old Payment A button
        return { valid: false };
      }

      if (!ref) return { valid: false, errorMessage: "We couldn't verify your payment. If you've already paid, please contact the business." };

      // Converge through canonical Payment Authority (#173)
      const { verifyAndReconcilePayment } = await import('@/lib/payments/bot-recovery');
      const recovery = await verifyAndReconcilePayment(ctx.supabase, ref);

      if (recovery.outcome === 'completed' || recovery.outcome === 'not_deliverable') {
        const invoiceNum = sd._invoice_ref as string;
        await ctx.sender.sendText({
          to: ctx.from,
          text: await ctx.t(`✅ *Payment Confirmed!*\n\nInvoice ${invoiceNum} has been paid.\n\n💡 Type *my invoices* to check your invoices, or *receipt* for your payment receipt.`),
        });
        return { valid: true, data: { _action: 'already_confirmed' } };
      }

      if (recovery.outcome === 'processing' || recovery.outcome === 'retryable') {
        await ctx.sender.sendText({
          to: ctx.from,
          text: await ctx.t('✅ Payment received! Your invoice payment is being processed.\n\nYou\'ll get a confirmation shortly. If not, tap *I\'ve Paid* again.'),
        });
        return { valid: true, data: { _action: 'payment_processing' } };
      }

      if (recovery.outcome === 'not_paid') {
        return { valid: false, errorMessage: "Payment not yet received. The link may have expired — please try again or send your transfer proof." };
      }

      if (recovery.outcome === 'provider_error') {
        return { valid: false, errorMessage: "We couldn't verify your payment right now. If you've already paid, tap *I've Paid* again in a moment." };
      }

      return { valid: false, errorMessage: 'Something went wrong. Please try again.' };
    }

    return { valid: false, errorMessage: "Tap *I've Paid Online*, *I've Sent Transfer*, or *Cancel*." };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._action === 'payment_processing') {
      return 'await_invoice_payment';
    }
    return null;
  },
};

export const invoiceFlow: FlowDefinition = {
  type: 'scheduling', // placeholder — pseudo-flow
  steps: [invoiceListStep, invoiceDetailStep, invoicePayStep, awaitInvoicePaymentStep],
};
