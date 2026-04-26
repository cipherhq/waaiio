import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, getCurrencySymbol, getCurrencyCode, type CountryCode } from '@/lib/constants';
import { getCategoryLabels } from '@/lib/categoryConfig';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { getPaymentReceiptMessage } from './shared/templates';
import { handlePostCompletion } from './shared/post-completion';
import { getTermsPrompt } from './shared/terms';
import type { SubscriptionTier } from '@/lib/constants';
import { getAuthorization, createPlan, createSubscription } from '@/lib/payments/paystack-recurring';
import { createRecurringCheckout } from '@/lib/payments/stripe-recurring';

export const paymentFlow: FlowDefinition = {
  type: 'payment',
  steps: [
    // ── Select Category (Tithe, Offering, etc.) ──
    {
      id: 'select_category',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

        const { data: services } = await ctx.supabase
          .from('services')
          .select('id, name, billing_type, recurring_interval, price')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .order('sort_order');

        if (!services || services.length === 0) {
          return [{ type: 'text', text: 'No payment categories are set up yet. Please contact the administrator.' }];
        }

        const cc = (ctx.business.country_code || 'NG') as CountryCode;
        const labels = getCategoryLabels(ctx.business.category);
        return [{
          type: 'list',
          title: `Select ${labels.entityName} Type`,
          body: `What would you like to ${labels.actionVerb.toLowerCase()}?`,
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
          .select('id, name, billing_type, recurring_interval')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .single();

        if (!service) return { valid: false, errorMessage: 'Please select a valid option.' };

        return {
          valid: true,
          data: {
            service_id: service.id,
            service_name: service.name,
            service_billing_type: service.billing_type || 'one_time',
            service_recurring_interval: service.recurring_interval || null,
          },
        };
      },
      async next() { return 'enter_amount'; },
    },

    // ── Enter Amount ──
    {
      id: 'enter_amount',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const symbol = getCurrencySymbol(cc);
        return [{
          type: 'text',
          text: `How much would you like to pay for *${ctx.session.session_data.service_name}*?\n\nType the amount (e.g. 5000):`,
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
        const labels = getCategoryLabels(ctx.business?.category || 'church');
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        return [
          {
            type: 'text',
            text: [
              `\ud83d\udccb *${labels.receiptTitle} Summary*`,
              '',
              `${labels.confirmationEmoji} ${ctx.business?.name}`,
              `\ud83d\udccc ${d.service_name as string}`,
              `\ud83d\udcb0 ${formatCurrency(d.amount as number, cc)}`,
            ].join('\n'),
          },
          {
            type: 'buttons',
            body: 'Confirm this payment?',
            buttons: [
              { id: 'confirm', title: 'Confirm ✓' },
              { id: 'cancel', title: 'Cancel' },
            ],
          },
        ];
      },
      async validate(input: string): Promise<ValidationResult> {
        const response = input.toLowerCase();
        if (response === 'cancel' || response === 'no') {
          return { valid: true, data: { _action: 'cancel' } };
        }
        if (response === 'confirm' || response === 'yes') {
          return { valid: true, data: { _action: 'confirm' } };
        }
        return { valid: false, errorMessage: 'Please tap *Confirm* or *Cancel*.' };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._action === 'cancel') return null;
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

        // ── T&C gate ──
        if (!d._terms_accepted && amount > 0 && ctx.business?.metadata?.require_terms_before_payment !== false) {
          await ctx.supabase.from('bot_sessions')
            .update({ session_data: d })
            .eq('id', ctx.session.id);
          return getTermsPrompt(ctx.business?.name || 'Business', (ctx.business?.metadata as Record<string, unknown>)?.terms_text as string | undefined);
        }
        if (d._terms_cancelled) {
          await ctx.supabase.from('bot_sessions')
            .update({ current_step: 'complete', is_active: false })
            .eq('id', ctx.session.id);
          return [{ type: 'text', text: 'No problem! Payment cancelled. Send *Hi* to start over.' }];
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
          return [{ type: 'text', text: 'Something went wrong. Send *Hi* to try again.' }];
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
          return [{ type: 'text', text: 'Something went wrong. Send *Hi* to try again.' }];
        }

        d.booking_id = booking.id;
        d.reference_code = booking.reference_code;

        // Record platform fee
        if (ctx.business) {
          const isInTrial = new Date(ctx.business.trial_ends_at) > new Date();
          await recordPlatformFee(ctx.supabase, {
            businessId: ctx.business.id,
            bookingId: booking.id,
            transactionAmount: amount,
            tier: ctx.business.subscription_tier as SubscriptionTier,
            isInTrial,
          });
        }

        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const paymentResult = await initializePayment(ctx.supabase, {
          bookingId: booking.id,
          userId,
          amount,
          referenceCode: booking.reference_code,
          businessName: ctx.business?.name || 'Business',
          phone: ctx.from,
          countryCode: cc,
          businessId: ctx.business?.id,
        });

        if (paymentResult) {
          d.payment_reference = paymentResult.reference;
          await ctx.supabase
            .from('bot_sessions')
            .update({ session_data: d, current_step: 'await_payment' })
            .eq('id', ctx.session.id);

          return [
            {
              type: 'text',
              text: [
                `\ud83d\udcb3 *Payment Link Ready*`,
                '',
                `${getCategoryLabels(ctx.business?.category || 'church').confirmationEmoji} ${ctx.business?.name}`,
                `\ud83d\udccc ${d.service_name as string}`,
                `\ud83d\udcb0 ${formatCurrency(amount, cc)}`,
                `\ud83d\udd11 Ref: *${booking.reference_code}*`,
                '',
                `Pay here \ud83d\udc47`,
                paymentResult.url,
                '',
                `\u26a0\ufe0f After paying, *return to WhatsApp* and tap *I've Paid* to confirm.`,
              ].join('\n'),
            },
            {
              type: 'buttons',
              body: "After paying, return here and tap *I've Paid* to confirm:",
              buttons: [
                { id: 'i_paid', title: "I've Paid" },
                { id: 'cancel', title: 'Cancel' },
              ],
            },
          ];
        }

        return [{ type: 'text', text: 'Payment initialization failed. Please try again later.' }];
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
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: "Complete your payment using the link above.\n\nAfter paying, *return to WhatsApp* and tap *I've Paid* to confirm:",
          buttons: [
            { id: 'i_paid', title: "I've Paid" },
            { id: 'cancel', title: 'Cancel' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const text = input.toLowerCase();

        if (text === 'cancel') {
          const bookingId = ctx.session.session_data.booking_id as string;
          if (bookingId) {
            await ctx.supabase
              .from('bookings')
              .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
              .eq('id', bookingId);
          }
          await ctx.sender.sendText({ to: ctx.from, text: 'Payment cancelled. Send *Hi* to start again.' });
          return { valid: true, data: { _action: 'cancel' } };
        }

        if (text === 'i_paid' || text === 'paid' || text === 'done' || text === 'check') {
          const ref = ctx.session.session_data.payment_reference as string;
          if (!ref) return { valid: true, data: { _action: 'cancel' } };

          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const verified = await verifyPayment(ctx.supabase, ref, cc);
          if (verified) {
            const d = ctx.session.session_data;

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

            const labels = getCategoryLabels(ctx.business?.category || 'church');
            await ctx.sender.sendText({
              to: ctx.from,
              text: getPaymentReceiptMessage({
                emoji: labels.confirmationEmoji,
                businessName: ctx.business?.name || 'Business',
                categoryName: d.service_name as string,
                amount: d.amount as number,
                referenceCode: d.reference_code as string,
                countryCode: cc,
              }),
            });

            // Post-completion: auto-receipt, loyalty, feedback, referral
            if (ctx.business) {
              const custName = `${d.first_name || ''} ${d.last_name || ''}`.trim() || null;
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
              }).catch(err => console.error('[PAYMENT] Post-completion error:', err));
            }

            return { valid: true, data: { _action: 'payment_confirmed' } };
          }

          return { valid: false, errorMessage: "Payment not yet received. Please complete payment using the link." };
        }

        return { valid: false, errorMessage: "Tap *I've Paid* or *Cancel*." };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._action === 'cancel') return null;
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
            { id: 'monthly', title: 'Monthly \u2713' },
            { id: 'weekly', title: 'Weekly \u2713' },
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
        if (text === 'decline' || text === 'no' || text === 'cancel') return { valid: true, data: { recurring_accepted: false } };
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
          return [{ type: 'text', text: 'Something went wrong setting up recurring payments. Send *Hi* to try again.' }];
        }

        // Determine gateway based on country
        const isPaystack = ['NG', 'GH'].includes(cc);

        let subscriptionCode = '';
        let planCode = '';
        let customerCode = '';
        let authCode = '';
        let cardLast4 = '';
        let cardBrand = '';
        let gatewayName: 'paystack' | 'stripe' = isPaystack ? 'paystack' : 'stripe';

        if (isPaystack) {
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
          const plan = await createPlan({
            name: `${ctx.business.name} - ${serviceName} (${frequency})`,
            interval: frequency,
            amount,
          });
          if (!plan) {
            return [{ type: 'text', text: 'Failed to set up recurring plan. Please try again later.' }];
          }
          planCode = plan.planCode;

          // Create subscription
          const sub = await createSubscription({
            customer: authData.email || authData.customerCode,
            planCode: plan.planCode,
            authorizationCode: authCode,
          });
          if (!sub) {
            return [{ type: 'text', text: 'Failed to activate recurring payments. Please try again later.' }];
          }
          subscriptionCode = sub.subscriptionCode;
          d._recurring_email_token = sub.emailToken;
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

          // For Stripe, send the checkout link and save subscription as pending
          await ctx.sender.sendText({
            to: ctx.from,
            text: `Complete your recurring payment setup here:\n${checkout.url}\n\n⚠️ After completing setup, *return to WhatsApp*.`,
          });
        }

        // Calculate next charge date
        const nextCharge = new Date();
        if (frequency === 'weekly') {
          nextCharge.setDate(nextCharge.getDate() + 7);
        } else {
          nextCharge.setMonth(nextCharge.getMonth() + 1);
        }

        // Save customer subscription
        await ctx.supabase.from('customer_subscriptions').insert({
          business_id: ctx.business.id,
          user_id: userId,
          service_id: (d.service_id as string) || null,
          amount,
          currency: getCurrencyCode(cc),
          frequency,
          status: 'active',
          gateway: gatewayName,
          gateway_subscription_code: subscriptionCode,
          gateway_plan_code: planCode || null,
          gateway_customer_code: customerCode || null,
          authorization_code: authCode || null,
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
        return [{
          type: 'text',
          text: [
            `\u2705 *Recurring Payment Set Up!*`,
            '',
            `Your ${label} payment of *${formatCurrency(amount, cc)}* for *${serviceName}* is now active.`,
            '',
            `You'll be charged automatically. To manage your recurring payments, type *subscriptions* anytime.`,
            '',
            `_Powered by *Waaiio*_`,
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
            `_Powered by *Waaiio*_`,
          ].join('\n'),
        }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },
  ],
};
