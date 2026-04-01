import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { CATEGORY_LABELS, formatCurrency, type CountryCode } from '@/lib/constants';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { getPaymentReceiptMessage } from './shared/templates';
import type { SubscriptionTier } from '@/lib/constants';

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
          .select('id, name')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .order('sort_order');

        if (!services || services.length === 0) {
          return [{ type: 'text', text: 'No payment categories are set up yet. Please contact the administrator.' }];
        }

        const labels = CATEGORY_LABELS[ctx.business.category];
        return [{
          type: 'list',
          title: `Select ${labels.entityName} Type`,
          body: `What would you like to ${labels.actionVerb.toLowerCase()}?`,
          buttonLabel: 'Choose',
          items: services.map(s => ({
            title: s.name,
            postbackText: s.id,
          })),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: service } = await ctx.supabase
          .from('services')
          .select('id, name')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .single();

        if (!service) return { valid: false, errorMessage: 'Please select a valid option.' };

        return {
          valid: true,
          data: { service_id: service.id, service_name: service.name },
        };
      },
      async next() { return 'enter_amount'; },
    },

    // ── Enter Amount ──
    {
      id: 'enter_amount',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const symbol = cc === 'NG' ? '\u20a6' : cc === 'GH' ? 'GH\u20b5' : cc === 'GB' ? '\u00a3' : '$';
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
        if (amount > 10_000_000) {
          return { valid: false, errorMessage: 'Maximum amount exceeded.' };
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
        const labels = CATEGORY_LABELS[ctx.business?.category || 'church'];
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

        const amount = d.amount as number;

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
                `${CATEGORY_LABELS[ctx.business?.category || 'church'].confirmationEmoji} ${ctx.business?.name}`,
                `\ud83d\udccc ${d.service_name as string}`,
                `\ud83d\udcb0 ${formatCurrency(amount, cc)}`,
                `\ud83d\udd11 Ref: *${booking.reference_code}*`,
                '',
                `Pay here \ud83d\udc47`,
                paymentResult.url,
              ].join('\n'),
            },
            {
              type: 'buttons',
              body: "Tap *I've Paid* after completing payment:",
              buttons: [
                { id: 'i_paid', title: "I've Paid" },
                { id: 'cancel', title: 'Cancel' },
              ],
            },
          ];
        }

        return [{ type: 'text', text: 'Payment initialization failed. Please try again later.' }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },

    // ── Await Payment ──
    {
      id: 'await_payment',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: "Complete your payment using the link above.\n\nTap *I've Paid* after paying:",
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
          await ctx.gupshup.sendText({ to: ctx.from, text: 'Payment cancelled. Send *Hi* to start again.' });
          return { valid: true, data: { _action: 'cancel' } };
        }

        if (text === 'i_paid' || text === 'paid' || text === 'done' || text === 'check') {
          const ref = ctx.session.session_data.payment_reference as string;
          if (!ref) return { valid: true, data: { _action: 'cancel' } };

          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const verified = await verifyPayment(ctx.supabase, ref, cc);
          if (verified) {
            const d = ctx.session.session_data;
            const labels = CATEGORY_LABELS[ctx.business?.category || 'church'];
            await ctx.gupshup.sendText({
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
            return { valid: true, data: { _action: 'payment_confirmed' } };
          }

          return { valid: false, errorMessage: "Payment not yet received. Please complete payment using the link." };
        }

        return { valid: false, errorMessage: "Tap *I've Paid* or *Cancel*." };
      },
      async next() { return null; },
    },
  ],
};
