import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, getCurrencySymbol, getCurrencyCode, type CountryCode } from '@/lib/constants';
import { getCategoryLabels } from '@/lib/categoryConfig';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { getPaymentReceiptMessage } from './shared/templates';
import { handlePostCompletion } from './shared/post-completion';
import { getTermsPrompt } from './shared/terms';
import { notifyOwnerNewPayment } from './shared/notify-owner';
import { createNotification } from './shared/notifications';
import type { SubscriptionTier } from '@/lib/constants';
import { getAuthorization, createPlan as createPaystackPlan, createSubscription as createPaystackSubscription } from '@/lib/payments/paystack-recurring';
import { createRecurringCheckout } from '@/lib/payments/stripe-recurring';
import { getCardToken, createPlan as createFlutterwavePlan, createSubscription as createFlutterwaveSubscription } from '@/lib/payments/flutterwave-recurring';
import { randomBytes } from 'crypto';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { analyzeReceipt, receiptMatchesExpected } from '@/lib/bot/receipt-ocr';
import { createServiceClient } from '@/lib/supabase/service';
import { getPlatformFees } from '@/lib/getPlatformFees';

export const paymentFlow: FlowDefinition = {
  type: 'payment',
  steps: [
    // ── Select Category (Tithe, Offering, etc.) ──
    {
      id: 'select_category',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

        // Filter by service_type: giving capability → giving services, payment → all non-giving
        const isGiving = ctx.session.session_data.active_capability === 'giving';
        let query = ctx.supabase
          .from('services')
          .select('id, name, billing_type, recurring_interval, price')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true);
        if (isGiving) {
          query = query.eq('service_type', 'giving');
        } else {
          query = query.neq('service_type', 'giving');
        }
        const { data: services } = await query.order('sort_order');

        if (!services || services.length === 0) {
          return [{ type: 'text', text: isGiving ? `No giving categories are set up yet. Please contact ${ctx.business?.name || 'the business'}.` : `No payment categories are set up yet. Please contact ${ctx.business?.name || 'the business'}.` }];
        }

        const cc = (ctx.business.country_code || 'NG') as CountryCode;
        const title = isGiving ? 'Select Giving Category' : 'Select Payment Type';
        const body = isGiving ? 'What would you like to give towards?' : 'What would you like to pay for?';
        return [{
          type: 'list',
          title,
          body,
          buttonLabel: 'Choose',
          items: services.map(s => {
            let title = s.name;
            if (s.billing_type === 'recurring' && s.recurring_interval && s.price > 0) {
              const suffix = s.recurring_interval === 'weekly' ? '/week' : '/month';
              title = `${s.name} — ${formatCurrency(s.price, cc)}${suffix}`;
            }
            return { title, postbackText: s.id };
          }),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: service } = await ctx.supabase
          .from('services')
          .select('id, name, billing_type, recurring_interval, price')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .single();

        if (!service) return { valid: false, errorMessage: 'That option is not available. Tap one of the choices above.' };

        return {
          valid: true,
          data: {
            service_id: service.id,
            service_name: service.name,
            service_billing_type: service.billing_type || 'one_time',
            service_recurring_interval: service.recurring_interval || null,
            service_price: service.price || 0,
          },
        };
      },
      async next() { return 'enter_amount'; },
    },

    // ── Enter Amount ──
    {
      id: 'enter_amount',
      async skipIf(ctx: FlowContext): Promise<boolean> {
        // Skip if service has a fixed price
        const price = ctx.session.session_data.service_price as number;
        if (price && price > 0) {
          ctx.session.session_data.amount = price;
          return true;
        }
        // Skip if smart intent pre-filled an amount (e.g., "pay tithe 5000")
        const preAmount = ctx.session.session_data.amount as number;
        if (preAmount && preAmount >= 1) {
          return true;
        }
        return false;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const isGiving = ctx.session.session_data.active_capability === 'giving';
        const verb = isGiving ? 'give towards' : 'pay for';
        return [{
          type: 'text',
          text: `How much would you like to ${verb} *${ctx.session.session_data.service_name}*?\n\nType the amount (e.g. 5000):`,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const cleaned = input.replace(/[\u20a6\u00a3$,\s]/g, '');
        const amount = parseFloat(cleaned);
        if (isNaN(amount) || amount < 1) {
          return { valid: false, errorMessage: 'Please enter a valid amount.' };
        }
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const maxPaymentAmount = (meta.max_payment_amount as number) || 10_000_000;
        if (amount > maxPaymentAmount) {
          return { valid: false, errorMessage: `Maximum amount is ${formatCurrency(maxPaymentAmount, (ctx.business?.country_code || 'NG') as CountryCode)}.` };
        }
        return { valid: true, data: { amount: Math.round(amount * 100) / 100 } };
      },
      async next() { return 'confirm_amount'; },
    },

    // ── Confirm Amount ──
    {
      id: 'confirm_amount',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const isGiving = d.active_capability === 'giving';
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const summaryTitle = isGiving ? 'Giving Summary' : 'Payment Summary';

        return [
          {
            type: 'text',
            text: [
              `📋 *${summaryTitle}*`,
              '',
              `${isGiving ? '🙏' : '🏢'} ${ctx.business?.name}`,
              `📌 ${d.service_name as string}`,
              `💰 ${formatCurrency(d.amount as number, cc)}`,
            ].join('\n'),
          },
          {
            type: 'buttons',
            body: 'Confirm this payment?',
            buttons: [
              { id: 'confirm', title: 'Confirm ✓' },
              { id: 'go_back', title: 'Cancel' },
            ],
          },
        ];
      },
      async validate(input: string): Promise<ValidationResult> {
        const response = input.toLowerCase();
        if ((response === 'cancel' || response === 'go_back') || response === 'no') {
          return { valid: true, data: { _action: 'cancel' } };
        }
        if (response === 'confirm' || response === 'yes') {
          return { valid: true, data: { _action: 'confirm' } };
        }
        return { valid: false, errorMessage: 'Please tap *Confirm* or *Cancel*.' };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._action === 'cancel') {
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('Payment cancelled. No charges were made. Send *Hi* to start over.') });
          return null;
        }
        return 'collect_name';
      },
    },

    // ── Collect Name ──
    {
      id: 'collect_name',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: 'Please type your *full name*:' }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const parts = input.trim().split(/\s+/);
        if (!parts[0] || parts[0].length < 2) {
          return { valid: false, errorMessage: 'Please enter a valid name.' };
        }
        return { valid: true, data: { first_name: parts[0], last_name: parts.slice(1).join(' ') || '' } };
      },
      async next() { return 'process_payment'; },
      async skipIf(ctx: FlowContext) {
        if (ctx.session.user_id) {
          const user = await findUserByPhone(ctx.supabase, ctx.from);
          if (user?.first_name) {
            ctx.session.session_data.first_name = user.first_name;
            ctx.session.session_data.last_name = user.last_name;
            return true;
          }
        }
        return false;
      },
    },

    // ── Process Payment ──
    {
      id: 'process_payment',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const amount = d.amount as number;

        // ── T&C cancel check (before gate) ──
        if (d._terms_cancelled) {
          return [{ type: 'text', text: 'No problem! Payment cancelled. No charges were made. Send *Hi* to start over.' }];
        }

        // ── T&C gate ──
        if (!d._terms_accepted && amount > 0 && ctx.business?.metadata?.require_terms_before_payment !== false) {
          await ctx.supabase.from('bot_sessions')
            .update({ session_data: d })
            .eq('id', ctx.session.id);
          { const meta = (ctx.business?.metadata || {}) as Record<string, unknown>; return getTermsPrompt(ctx.business?.name || 'Business', meta.terms_text as string | undefined, ctx.business?.slug, meta.terms_url as string | undefined); }
        }

        // Ensure user exists
        let userId = ctx.session.user_id;
        if (!userId) {
          userId = await createWhatsAppUser(
            ctx.supabase,
            ctx.from,
            (d.first_name as string) || '',
            (d.last_name as string) || '',
          );
          if (userId) {
            ctx.session.user_id = userId;
            await ctx.supabase
              .from('bot_sessions')
              .update({ user_id: userId })
              .eq('id', ctx.session.id);
          }
        }

        if (!userId) {
          return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];
        }

        // Create a booking record for payment tracking
        const { data: booking, error } = await ctx.supabase
          .from('bookings')
          .insert({
            business_id: ctx.business!.id,
            user_id: userId,
            service_id: (d.service_id as string) || null,
            date: new Date().toISOString().split('T')[0],
            time: new Date().toTimeString().split(' ')[0].slice(0, 5),
            party_size: 1,
            flow_type: 'payment',
            channel: 'whatsapp',
            deposit_amount: amount,
            deposit_status: 'pending',
            status: 'pending',
            total_amount: amount,
            quantity: 1,
            guest_name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
            guest_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
            notes: `${d.service_name} payment`,
          })
          .select('id, reference_code')
          .single();

        if (error || !booking) {
          return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];
        }

        d.booking_id = booking.id;
        d.reference_code = booking.reference_code;

        // Platform fee is recorded AFTER payment verification in await_payment.validate()

        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const paymentResult = await initializePayment(ctx.supabase, {
          bookingId: booking.id,
          userId,
          amount,
          referenceCode: booking.reference_code,
          businessName: ctx.business?.name || 'Business',
          phone: ctx.from,
          countryCode: cc,
          gatewayOverride: ctx.business?.payment_gateway || null,
          businessId: ctx.business?.id,
        });

        if (paymentResult) {
          d.payment_reference = paymentResult.reference;

          // Check if business qualifies for direct bank transfer option
          // Requires: NG/GH country, growth/business tier, active default bank account, amount >= 10,000 base currency
          let bankAccount: { bank_name: string; account_number: string; account_name: string } | null = null;
          const tier = ctx.business?.subscription_tier || 'free';
          const qualifiesForBankTransfer =
            (cc === 'NG' || cc === 'GH') &&
            (tier === 'growth' || tier === 'business');

          if (qualifiesForBankTransfer) {
            const { data: ba } = await ctx.supabase
              .from('business_bank_accounts')
              .select('bank_name, account_number, account_name')
              .eq('business_id', ctx.business!.id)
              .eq('is_active', true)
              .eq('is_default', true)
              .maybeSingle();
            bankAccount = ba;
          }

          if (bankAccount) {
            // Generate unique transfer reference
            const transferRef = 'WA-' + randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
            d.bank_transfer_reference = transferRef;
            d.bank_transfer_offered = true;
            d.bank_transfer_amount = amount; // Store in main currency unit for OCR comparison

            // Insert pending_transfer record (expected_amount in smallest unit — kobo)
            await ctx.supabase.from('pending_transfers').insert({
              business_id: ctx.business!.id,
              booking_id: booking.id,
              customer_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
              customer_name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
              expected_amount: Math.round(amount * 100),
              currency: getCurrencyCode(cc),
              reference_code: transferRef,
              status: 'pending',
              expires_at: new Date(Date.now() + (await loadPlatformSettings({ useServiceClient: true })).transfer_expiry_hours * 60 * 60 * 1000).toISOString(),
            });

            await ctx.supabase
              .from('bot_sessions')
              .update({ session_data: d, current_step: 'await_payment' })
              .eq('id', ctx.session.id);

            // Dual-option payment message: online + bank transfer
            const paymentLines = [
              `💳 *Payment Options*`,
              '',
              `${getCategoryLabels(ctx.business?.category || 'church').confirmationEmoji} ${ctx.business?.name}`,
              `📌 ${d.service_name as string}`,
              `💰 ${formatCurrency(amount, cc)}`,
              `🔑 Ref: *${booking.reference_code}*`,
              '',
              `*Option 1 — Pay Online* 👇`,
              paymentResult.url,
              '',
              `*Option 2 — Bank Transfer* 🏦`,
              `Bank: ${bankAccount.bank_name}`,
              `Account: ${bankAccount.account_number}`,
              `Name: ${bankAccount.account_name}`,
              `Amount: ${formatCurrency(amount, cc)}`,
              `Reference/Narration: *${transferRef}*`,
              '',
              `⚠️ Use reference *${transferRef}* as your transfer narration.`,
              `After transferring, tap "I've Sent It" or send your receipt screenshot.`,
            ];

            return [
              {
                type: 'text',
                text: paymentLines.join('\n'),
              },
              {
                type: 'buttons',
                body: 'Tap below after paying:',
                buttons: [
                  { id: 'i_paid_online', title: "I've Paid Online" },
                  { id: 'sent_transfer', title: "I've Sent Transfer" },
                  { id: 'go_back', title: 'Cancel' },
                ],
              },
            ];
          }

          // Standard payment flow (no bank transfer option)
          await ctx.supabase
            .from('bot_sessions')
            .update({ session_data: d, current_step: 'await_payment' })
            .eq('id', ctx.session.id);

          // Build payment message — include bank transfer hint for Nigerian businesses
          const paymentLines = [
            `💳 *Payment Link Ready*`,
            '',
            `${getCategoryLabels(ctx.business?.category || 'church').confirmationEmoji} ${ctx.business?.name}`,
            `📌 ${d.service_name as string}`,
            `💰 ${formatCurrency(amount, cc)}`,
            `🔑 Ref: *${booking.reference_code}*`,
            '',
            `Pay here 👇`,
            paymentResult.url,
          ];

          if (cc === 'NG' || cc === 'GH') {
            paymentLines.push('');
            paymentLines.push('💡 _You can pay with card, bank transfer, or USSD on the payment page._');
          }

          paymentLines.push('');
          paymentLines.push('⚠️ Your confirmation will arrive automatically after payment.');

          return [
            {
              type: 'text',
              text: paymentLines.join('\n'),
            },
            {
              type: 'buttons',
              body: "Your confirmation will arrive automatically after payment. If it doesn't, tap below:",
              buttons: [
                { id: 'i_paid', title: "I've Paid" },
                { id: 'go_back', title: 'Cancel' },
              ],
            },
          ];
        }

        return [{ type: 'text', text: "We couldn't set up your payment right now. Send *Hi* to start over." }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input === 'accept_terms') {
          return { valid: true, data: { _terms_accepted: true } };
        }
        if (input === 'cancel_terms') {
          return { valid: true, data: { _terms_cancelled: true } };
        }
        return { valid: true };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._terms_accepted || ctx.session.session_data._terms_cancelled) {
          return 'process_payment';
        }
        return null;
      },
    },

    // ── Await Payment ──
    {
      id: 'await_payment',
      acceptsMedia: true, // Allow image uploads as payment proof for bank transfers
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        if (d.bank_transfer_offered) {
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
          body: "Complete your payment using the link above.\n\nYour confirmation will arrive automatically after payment. If it doesn't, tap below:",
          buttons: [
            { id: 'i_paid', title: "I've Paid" },
            { id: 'retry_payment', title: 'Get New Link' },
            { id: 'go_back', title: 'Cancel' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input === 'retry_payment') {
          return { valid: true, data: { _action: 'retry_payment' } };
        }
        const text = input.toLowerCase();
        const d = ctx.session.session_data;

        if ((text === 'cancel' || text === 'go_back')) {
          const bookingId = d.booking_id as string;
          if (bookingId) {
            await ctx.supabase
              .from('bookings')
              .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
              .eq('id', bookingId);
          }
          // Also cancel the pending_transfer if one exists
          if (d.bank_transfer_reference) {
            await ctx.supabase
              .from('pending_transfers')
              .update({ status: 'cancelled' })
              .eq('reference_code', d.bank_transfer_reference as string);
          }
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(`Payment to *${ctx.business?.name || 'business'}* cancelled. Send *Hi* to start over.`) });
          return { valid: true, data: { _action: 'cancel' } };
        }

        // ── Bank transfer proof: image uploaded — OCR pre-verification ──
        if (ctx.mediaType === 'image' && ctx.mediaUrl && d.bank_transfer_reference) {
          const transferRef = d.bank_transfer_reference as string;
          const expectedAmount = d.bank_transfer_amount as number;
          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const currency = getCurrencyCode(cc);

          // Run OCR on the receipt
          const ocr = await analyzeReceipt(ctx.mediaUrl, expectedAmount, transferRef, currency);
          const ocrMatches = receiptMatchesExpected(ocr, expectedAmount, transferRef);

          // Store proof image + OCR results on the pending_transfer
          await ctx.supabase
            .from('pending_transfers')
            .update({
              proof_type: 'screenshot',
              proof_image_url: ctx.mediaUrl,
              verified_by_ocr: ocrMatches,
              ocr_result: ocrMatches ? {
                amount: ocr.amount,
                reference: ocr.reference,
                sender_name: ocr.senderName,
                bank_name: ocr.bankName,
                confidence: ocr.confidence,
              } : null,
            })
            .eq('reference_code', transferRef)
            .eq('status', 'pending');

          // Notify business owner about the transfer proof
          if (ctx.business) {
            const custName = `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Customer';
            const ocrStatus = ocrMatches
              ? `✅ AI verified: amount ${formatCurrency(expectedAmount, cc)} and ref *${transferRef}* match the receipt.`
              : `⚠️ AI could not verify — please check the receipt manually.`;

            notifyOwnerNewPayment({
              supabase: ctx.supabase,
              sender: ctx.sender,
              businessId: ctx.business.id,
              businessName: ctx.business.name,
              countryCode: cc,
              referenceCode: transferRef,
              customerName: custName,
              amount: expectedAmount,
              categoryName: `${d.service_name as string} (Bank Transfer)`,
            }).catch(err => console.error('[PAYMENT] Transfer notify error:', err));

            createNotification(ctx.supabase, {
              businessId: ctx.business.id,
              bookingId: d.booking_id as string,
              type: 'transfer_proof_received',
              channel: 'whatsapp',
              body: `Transfer proof received from ${custName} for ${formatCurrency(expectedAmount, cc)}. Ref: ${transferRef}. ${ocrStatus}\n\nConfirm in Dashboard → Pending Transfers.`,
            }).catch(err => console.error('[PAYMENT] Transfer notification error:', err));
          }

          const ocrHint = ocrMatches
            ? `\n\n🤖 _Our AI verified your receipt — amount and reference match. The business will confirm shortly._`
            : '';

          await ctx.sender.sendText({
            to: ctx.from,
            text: await ctx.t(`✅ Payment proof received. *${ctx.business?.name || 'The business'}* will review and confirm shortly.\n\nRef: *${transferRef}*${ocrHint}\n\nYou'll get a confirmation message once verified. Send *Hi* to continue using other services.`),
          });
          return { valid: true, data: { _action: 'transfer_proof_sent' } };
        }

        // ── "I've Sent Transfer" button ──
        if (text === 'sent_transfer' || text === "i've sent transfer" || text === 'i_sent_transfer') {
          if (!d.bank_transfer_reference) {
            return { valid: false, errorMessage: 'No bank transfer reference found. Please use the online payment link instead.' };
          }
          d._awaiting_transfer_proof = true;
          await ctx.supabase
            .from('bot_sessions')
            .update({ session_data: d })
            .eq('id', ctx.session.id);

          await ctx.sender.sendText({
            to: ctx.from,
            text: await ctx.t(`Please send a *screenshot* of your transfer receipt, or type the bank *transaction reference* so we can verify your payment.\n\nRef: *${d.bank_transfer_reference}*`),
          });
          return { valid: false, errorMessage: '' }; // Keep at this step, wait for proof
        }

        // ── Text proof after tapping "I've Sent Transfer" ──
        if (d._awaiting_transfer_proof && text && !['i_paid', 'i_paid_online', 'paid', 'done', 'check'].includes(text)) {
          await ctx.supabase
            .from('pending_transfers')
            .update({
              proof_type: 'text',
              proof_text: input.trim(),
            })
            .eq('reference_code', d.bank_transfer_reference as string)
            .eq('status', 'pending');

          await ctx.sender.sendText({
            to: ctx.from,
            text: await ctx.t(`✅ Transfer reference received. *${ctx.business?.name || 'The business'}* will review and confirm shortly.\n\nRef: *${d.bank_transfer_reference}*\n\nYou'll get a confirmation message once verified. Send *Hi* to continue using other services.`),
          });
          return { valid: true, data: { _action: 'transfer_proof_sent' } };
        }

        if (text === 'i_paid' || text === 'i_paid_online' || text === 'paid' || text === 'done' || text === 'check') {
          const ref = ctx.session.session_data.payment_reference as string;
          if (!ref) return { valid: true, data: { _action: 'cancel' } };

          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const verified = await verifyPayment(ctx.supabase, ref, cc);
          if (verified) {
            const d = ctx.session.session_data;

            // Check if webhook already confirmed this booking (avoid double-processing)
            const { data: currentBooking } = await ctx.supabase
              .from('bookings')
              .select('status, deposit_status')
              .eq('id', d.booking_id as string)
              .single();

            if (currentBooking?.deposit_status === 'paid') {
              const labels = getCategoryLabels(ctx.business?.category || 'church');
              const isGivingFlow = d.active_capability === 'giving';
              const dedupTips = isGivingFlow
                ? `\n\n💡 *What you can do:*\n• Type *my giving* to see your giving history\n• Type *receipt* to get your payment receipt\n• Type *Hi* to make another payment`
                : `\n\n💡 *What you can do:*\n• Type *my bookings* to view your bookings\n• Type *receipt* to get your payment receipt\n• Type *Hi* to make another payment`;
              await ctx.sender.sendText({
                to: ctx.from,
                text: await ctx.t(getPaymentReceiptMessage({
                  emoji: labels.confirmationEmoji,
                  businessName: ctx.business?.name || 'Business',
                  categoryName: d.service_name as string,
                  amount: d.amount as number,
                  referenceCode: d.reference_code as string,
                  countryCode: cc,
                  subscriptionTier: ctx.business?.subscription_tier,
                }) + dedupTips),
              });
              return { valid: true, data: { _action: 'already_confirmed' } };
            }

            // Upsert customer_profiles so the member appears in the dashboard
            if (ctx.business?.id) {
              const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
              const name = `${d.first_name || ''} ${d.last_name || ''}`.trim() || null;
              const amount = d.amount as number;
              const now = new Date().toISOString();

              const { data: existing } = await ctx.supabase
                .from('customer_profiles')
                .select('id, total_visits, total_spent')
                .eq('business_id', ctx.business.id)
                .eq('phone', phone)
                .maybeSingle();

              if (existing) {
                await ctx.supabase
                  .from('customer_profiles')
                  .update({
                    name: name || undefined,
                    total_visits: (existing.total_visits || 0) + 1,
                    total_spent: (existing.total_spent || 0) + amount,
                    last_seen_at: now,
                  })
                  .eq('id', existing.id);
              } else {
                await ctx.supabase
                  .from('customer_profiles')
                  .insert({
                    business_id: ctx.business.id,
                    phone,
                    name,
                    total_visits: 1,
                    total_spent: amount,
                    first_seen_at: now,
                    last_seen_at: now,
                  });
              }
            }

            // Record platform fee now that payment is verified
            if (ctx.business) {
              const isInTrial = (ctx.business.subscription_tier === 'free') && new Date(ctx.business.trial_ends_at) > new Date();
              recordPlatformFee(ctx.supabase, {
                businessId: ctx.business.id,
                bookingId: d.booking_id as string,
                transactionAmount: d.amount as number,
                tier: ctx.business.subscription_tier as SubscriptionTier,
                isInTrial,
              }).catch(err => console.error('[PAYMENT] recordPlatformFee error:', err));
            }

            const labels = getCategoryLabels(ctx.business?.category || 'church');
            const isGivingFlow = d.active_capability === 'giving';
            const tipsText = isGivingFlow
              ? `\n\n💡 *What you can do:*\n• Type *my giving* to see your giving history\n• Type *receipt* to get your payment receipt\n• Type *Hi* to make another payment`
              : `\n\n💡 *What you can do:*\n• Type *my bookings* to view your bookings\n• Type *receipt* to get your payment receipt\n• Type *Hi* to make another payment`;

            await ctx.sender.sendText({
              to: ctx.from,
              text: await ctx.t(getPaymentReceiptMessage({
                emoji: labels.confirmationEmoji,
                businessName: ctx.business?.name || 'Business',
                categoryName: d.service_name as string,
                amount: d.amount as number,
                referenceCode: d.reference_code as string,
                countryCode: cc,
                subscriptionTier: ctx.business?.subscription_tier,
              }) + tipsText),
            });

            // Post-completion: auto-receipt, loyalty, feedback, referral
            if (ctx.business) {
              const custName = `${d.first_name || ''} ${d.last_name || ''}`.trim() || null;
              const isGiving = ctx.session.session_data.active_capability === 'giving';
              handlePostCompletion({
                supabase: ctx.supabase,
                businessId: ctx.business.id,
                customerPhone: ctx.from,
                customerName: custName,
                serviceType: 'payment',
                referenceId: d.booking_id as string,
                sender: ctx.sender,
                amountPaid: d.amount as number,
                serviceName: d.service_name as string,
                referenceCode: d.reference_code as string,
                skipLoyalty: isGiving,
              }).catch(err => console.error('[PAYMENT] Post-completion error:', err));

              // Notify owner: email + WhatsApp
              notifyOwnerNewPayment({
                supabase: ctx.supabase,
                sender: ctx.sender,
                businessId: ctx.business.id,
                businessName: ctx.business.name,
                countryCode: cc,
                referenceCode: d.reference_code as string,
                customerName: custName || 'Customer',
                amount: d.amount as number,
                categoryName: d.service_name as string,
              }).catch(err => console.error('[PAYMENT] Notify error:', err));

              // In-app notification
              createNotification(ctx.supabase, {
                businessId: ctx.business.id,
                bookingId: d.booking_id as string,
                type: 'payment_received',
                channel: 'whatsapp',
                body: `New payment of ${formatCurrency(d.amount as number, cc)} for ${d.service_name} from ${custName || 'Customer'}. Ref: ${d.reference_code}`,
              }).catch(err => console.error('[PAYMENT] Notification error:', err));
            }

            return { valid: true, data: { _action: 'payment_confirmed' } };
          }

          return { valid: false, errorMessage: "Payment not yet received. The link may have expired — tap *Get New Link* for a fresh one." };
        }

        if (d.bank_transfer_offered) {
          return { valid: false, errorMessage: "Tap *I've Paid Online*, *I've Sent Transfer*, or *Cancel*." };
        }
        return { valid: false, errorMessage: "Tap *I've Paid* or *Cancel*." };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._action === 'cancel') return null;
        if (ctx.session.session_data._action === 'transfer_proof_sent') return null; // Session ends — business confirms manually
        if (ctx.session.session_data._action === 'retry_payment') {
          delete ctx.session.session_data._action;
          return 'process_payment'; // regenerate payment link
        }
        if (ctx.session.session_data._action === 'payment_confirmed') {
          // If the service itself is recurring, skip the offer step and go straight to consent
          if (ctx.session.session_data.service_billing_type === 'recurring') {
            ctx.session.session_data.recurring_frequency = ctx.session.session_data.service_recurring_interval as string;
            return 'confirm_recurring';
          }
          return 'offer_recurring';
        }
        return null;
      },
    },

    // ── Offer Recurring ──
    {
      id: 'offer_recurring',
      async skipIf(ctx: FlowContext): Promise<boolean> {
        if (!ctx.business) return true;

        // If this service is already recurring, it was handled by await_payment routing
        if (ctx.session.session_data.service_billing_type === 'recurring') return true;

        // Check if business has ANY recurring services (otherwise no point offering)
        const { data: recurringServices } = await ctx.supabase
          .from('services')
          .select('id')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .eq('billing_type', 'recurring')
          .limit(1);

        if (!recurringServices || recurringServices.length === 0) {
          // Fallback: also check legacy business-level toggle
          const { data: biz } = await ctx.supabase
            .from('businesses')
            .select('recurring_enabled')
            .eq('id', ctx.business.id)
            .single();

          if (!biz?.recurring_enabled) return true;
        }

        // Check if customer already has active sub for this service
        const userId = ctx.session.user_id;
        const serviceId = ctx.session.session_data.service_id as string;
        if (userId && serviceId) {
          const { data: existing } = await ctx.supabase
            .from('customer_subscriptions')
            .select('id')
            .eq('user_id', userId)
            .eq('business_id', ctx.business.id)
            .eq('service_id', serviceId)
            .eq('status', 'active')
            .maybeSingle();

          if (existing) return true;
        }

        return false;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        return [{
          type: 'buttons',
          body: `Would you like to set up automatic *${d.service_name as string}* payments of *${formatCurrency(d.amount as number, cc)}*?`,
          buttons: [
            { id: 'monthly', title: 'Monthly ✓' },
            { id: 'weekly', title: 'Weekly ✓' },
            { id: 'no_thanks', title: 'No thanks' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.toLowerCase();
        if (text === 'monthly') return { valid: true, data: { recurring_frequency: 'monthly' } };
        if (text === 'weekly') return { valid: true, data: { recurring_frequency: 'weekly' } };
        if (text === 'no_thanks' || text === 'no') return { valid: true, data: { recurring_frequency: 'none' } };
        return { valid: false, errorMessage: 'Please choose *Monthly*, *Weekly*, or *No thanks*.' };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data.recurring_frequency === 'none') return 'payment_thank_you';
        return 'confirm_recurring';
      },
    },

    // ── Confirm Recurring (consent) ──
    {
      id: 'confirm_recurring',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const frequency = d.recurring_frequency as string;
        const label = frequency === 'weekly' ? 'every week' : 'every month';

        return [{
          type: 'buttons',
          body: [
            `Please review and accept the recurring payment terms:`,
            '',
            `*${d.service_name as string}* — *${formatCurrency(d.amount as number, cc)}* ${label}`,
            `Business: ${ctx.business?.name || 'N/A'}`,
            '',
            `By accepting, you authorize *${ctx.business?.name}* to automatically charge *${formatCurrency(d.amount as number, cc)}* ${label} using your payment method on file.`,
            '',
            `You can cancel anytime by typing *subscriptions*.`,
          ].join('\n'),
          buttons: [
            { id: 'i_accept', title: 'I Accept' },
            { id: 'decline', title: 'Decline' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.toLowerCase();
        if (text === 'i_accept' || text === 'accept' || text === 'yes') return { valid: true, data: { recurring_accepted: true } };
        if (text === 'decline' || text === 'no' || (text === 'cancel' || text === 'go_back')) return { valid: true, data: { recurring_accepted: false } };
        return { valid: false, errorMessage: 'Please tap *I Accept* or *Decline*.' };
      },
      async next(ctx: FlowContext) {
        if (!ctx.session.session_data.recurring_accepted) return 'payment_thank_you';
        return 'setup_recurring';
      },
    },

    // ── Setup Recurring ──
    {
      id: 'setup_recurring',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const frequency = d.recurring_frequency as 'weekly' | 'monthly';
        const amount = d.amount as number;
        const ref = d.payment_reference as string;
        const serviceName = d.service_name as string;
        const userId = ctx.session.user_id;

        if (!ctx.business || !userId) {
          return [{ type: 'text', text: 'Something went wrong on our end setting up recurring payments. Send *Hi* to start over.' }];
        }

        // Check for existing active subscription for same service + user
        const serviceId = (d.service_id as string) || null;
        if (serviceId) {
          const { data: existingSub } = await ctx.supabase
            .from('customer_subscriptions')
            .select('id')
            .eq('business_id', ctx.business.id)
            .eq('user_id', userId)
            .eq('service_id', serviceId)
            .in('status', ['active', 'pending'])
            .limit(1)
            .maybeSingle();

          if (existingSub) {
            return [{
              type: 'text',
              text: `You already have an active recurring payment for *${serviceName}*. To manage it, type *subscriptions*.`,
            }];
          }
        }

        // Determine gateway: business override > country default
        // Gateway follows business — businesses.payment_gateway overrides country default
        const businessGateway = ctx.business.payment_gateway as string | null;
        const resolvedGateway: 'paystack' | 'flutterwave' | 'stripe' =
          businessGateway === 'flutterwave' ? 'flutterwave' :
          businessGateway === 'stripe' ? 'stripe' :
          businessGateway === 'paystack' ? 'paystack' :
          ['NG', 'GH'].includes(cc) ? 'paystack' : 'stripe';

        let subscriptionCode = '';
        let planCode = '';
        let customerCode = '';
        let authCode = '';
        let cardLast4 = '';
        let cardBrand = '';
        let cardToken = '';
        const gatewayName = resolvedGateway;

        if (resolvedGateway === 'paystack') {
          // Extract authorization from the payment just made
          const authData = await getAuthorization(ref);
          if (!authData) {
            return [{ type: 'text', text: 'Unable to set up automatic payments with this payment method. You can still pay manually each time.' }];
          }

          authCode = authData.authorizationCode;
          cardLast4 = authData.last4;
          cardBrand = authData.brand;
          customerCode = authData.customerCode;

          // Create plan
          const plan = await createPaystackPlan({
            name: `${ctx.business.name} - ${serviceName} (${frequency})`,
            interval: frequency,
            amount,
          });
          if (!plan) {
            return [{ type: 'text', text: 'Failed to set up recurring plan. Please try again later.' }];
          }
          planCode = plan.planCode;

          // Create subscription
          const sub = await createPaystackSubscription({
            customer: authData.email || authData.customerCode,
            planCode: plan.planCode,
            authorizationCode: authCode,
          });
          if (!sub) {
            return [{ type: 'text', text: 'Failed to activate recurring payments. Please try again later.' }];
          }
          subscriptionCode = sub.subscriptionCode;
          d._recurring_email_token = sub.emailToken;
        } else if (resolvedGateway === 'flutterwave') {
          // Flutterwave: extract card token from the payment just made, then create plan + subscription
          const tokenData = await getCardToken(ref);
          if (!tokenData) {
            return [{ type: 'text', text: 'Unable to set up automatic payments with this payment method. You can still pay manually each time.' }];
          }

          cardToken = tokenData.token;
          cardLast4 = tokenData.last4;
          cardBrand = tokenData.brand;

          // Create Flutterwave payment plan
          const plan = await createFlutterwavePlan(
            `${ctx.business.name} - ${serviceName} (${frequency})`,
            amount,
            frequency,
          );
          if (!plan) {
            return [{ type: 'text', text: 'Failed to set up recurring plan. Please try again later.' }];
          }
          planCode = plan.planId;

          // Subscribe customer to the plan using their card token
          const sub = await createFlutterwaveSubscription(
            plan.planId,
            tokenData.email,
            cardToken,
          );
          if (!sub) {
            return [{ type: 'text', text: 'Failed to activate recurring payments. Please try again later.' }];
          }
          subscriptionCode = sub.subscriptionId;
        } else {
          // Stripe: create subscription checkout
          const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
          const email = (d.customer_email as string) || `${phone.replace('+', '')}@${process.env.FALLBACK_EMAIL_DOMAIN || 'whatsapp.waaiio.com'}`;

          const checkout = await createRecurringCheckout({
            businessName: ctx.business.name,
            serviceName,
            amount,
            currency: getCurrencyCode(cc),
            interval: frequency === 'weekly' ? 'week' : 'month',
            customerEmail: email,
            metadata: {
              business_id: ctx.business.id,
              user_id: userId,
              service_id: (d.service_id as string) || '',
              type: 'customer_recurring',
            },
          });

          if (!checkout) {
            return [{ type: 'text', text: 'Failed to set up recurring payments. Please try again later.' }];
          }

          subscriptionCode = checkout.sessionId;

          // For Stripe, send shortened checkout link
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
          const shortRef = checkout.sessionId.slice(-12);
          const shortUrl = `${appUrl}/api/pay?ref=${shortRef}`;

          // Save session ID in payments table so /api/pay can resolve it
          await ctx.supabase.from('payments').insert({
            business_id: ctx.business.id,
            booking_id: (d.booking_id as string) || null,
            amount,
            currency: getCurrencyCode(cc),
            gateway: 'stripe',
            gateway_reference: checkout.sessionId,
            status: 'pending',
            metadata: { stripe_session_id: checkout.sessionId, type: 'recurring_setup' },
          });

          await ctx.sender.sendText({
            to: ctx.from,
            text: await ctx.t(`Complete your recurring payment setup here:\n${shortUrl}\n\n⚠️ After completing setup, *return to WhatsApp*.`),
          });
        }

        // Calculate next charge date
        const nextCharge = new Date();
        if (frequency === 'weekly') {
          nextCharge.setDate(nextCharge.getDate() + 7);
        } else {
          nextCharge.setMonth(nextCharge.getMonth() + 1);
        }

        // Paystack & Flutterwave: active immediately (card token captured).
        // Stripe: pending until checkout is completed.
        const subStatus = resolvedGateway === 'stripe' ? 'pending' : 'active';

        await ctx.supabase.from('customer_subscriptions').insert({
          business_id: ctx.business.id,
          user_id: userId,
          service_id: (d.service_id as string) || null,
          amount,
          currency: getCurrencyCode(cc),
          frequency,
          status: subStatus,
          gateway: gatewayName,
          gateway_subscription_code: subscriptionCode,
          gateway_plan_code: planCode || null,
          gateway_customer_code: customerCode || null,
          authorization_code: authCode || cardToken || null,
          card_last_four: cardLast4 || null,
          card_brand: cardBrand || null,
          next_charge_at: nextCharge.toISOString(),
          last_charged_at: new Date().toISOString(),
          charge_count: 1,
          total_charged: amount,
          customer_name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
          customer_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
          customer_email: (d.customer_email as string) || null,
          setup_channel: 'whatsapp',
        });

        const label = frequency === 'weekly' ? 'weekly' : 'monthly';
        if (resolvedGateway === 'stripe') {
          // Stripe: subscription is pending until checkout is completed
          return [{
            type: 'text',
            text: [
              `Your ${label} payment of *${formatCurrency(amount, cc)}* for *${serviceName}* will be active once you complete the setup above.`,
              '',
              `To manage your recurring payments, type *subscriptions* anytime.`,
              '',
              `_Powered by *Waaiio*_`,
            ].join('\n'),
          }];
        }
        // Paystack & Flutterwave: active immediately
        return [{
          type: 'text',
          text: [
            `✅ *Recurring Payment Set Up!*`,
            '',
            `Your ${label} payment of *${formatCurrency(amount, cc)}* for *${serviceName}* is now active.`,
            `Next charge: ${nextCharge.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
            '',
            `💡 *What you can do:*`,
            `• Type *subscriptions* to manage your payments`,
            `• Type *receipt* to get your payment receipt`,
            `• Type *Hi* to start a new conversation`,
          ].join('\n'),
        }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },

    // ── Payment Thank You (terminal) ──
    {
      id: 'payment_thank_you',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const labels = getCategoryLabels(ctx.business?.category || 'church');

        const isGivingFlow = d.active_capability === 'giving';
        const tips = isGivingFlow
          ? [
              `💡 *What you can do:*`,
              `• Type *my giving* to see your giving history`,
              `• Type *receipt* to get your payment receipt`,
              `• Type *Hi* to make another payment`,
            ]
          : [
              `💡 *What you can do:*`,
              `• Type *my bookings* to view your bookings`,
              `• Type *receipt* to get your payment receipt`,
              `• Type *Hi* to make another payment`,
            ];

        return [{
          type: 'text',
          text: [
            `${labels.confirmationEmoji} *Thank you for your ${labels.actionVerb.toLowerCase()}!*`,
            '',
            `${labels.confirmationEmoji} ${ctx.business?.name || 'Business'}`,
            `📋 ${d.service_name as string}`,
            `💰 ${formatCurrency(d.amount as number, cc)}`,
            `🔑 Ref: *${d.reference_code as string}*`,
            '',
            `We appreciate your support. 🙏`,
            '',
            ...tips,
            '',
            `_Powered by *Waaiio*_`,
          ].join('\n'),
        }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },
  ],
};
