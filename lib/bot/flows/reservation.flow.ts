import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, getLocale, getMaxQuantity, type CountryCode } from '@/lib/constants';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { createNotification } from './shared/notifications';
import { getReservationConfirmationMessage } from './shared/templates';
import { handlePostCompletion } from './shared/post-completion';
import { getTermsPrompt } from './shared/terms';
import type { SubscriptionTier } from '@/lib/constants';

export const reservationFlow: FlowDefinition = {
  type: 'reservation',
  steps: [
    // ── Step 1: Select Property ──
    {
      id: 'select_apartment',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

        // Query properties table (new) with fallback to services (legacy)
        let listings: Array<{ id: string; name: string; price: number; deposit_amount: number; max_guests?: number }> = [];
        const { data: properties } = await ctx.supabase
          .from('properties')
          .select('id, name, price, deposit_amount, max_guests')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .order('sort_order');

        if (properties && properties.length > 0) {
          listings = properties;
        } else {
          // Fallback: legacy services for businesses not yet migrated
          const { data: services } = await ctx.supabase
            .from('services')
            .select('id, name, price, deposit_amount')
            .eq('business_id', ctx.business.id)
            .eq('is_active', true)
            .order('sort_order');
          listings = (services || []).map(s => ({ ...s, deposit_amount: s.deposit_amount || 0 }));
        }

        if (listings.length === 0) {
          return [{ type: 'text', text: 'No options are currently available. Please try again later.' }];
        }

        if (listings.length === 1) {
          ctx.session.session_data.property_id = listings[0].id;
          ctx.session.session_data.service_name = listings[0].name;
          ctx.session.session_data.nightly_rate = listings[0].price;
          ctx.session.session_data.service_deposit = listings[0].deposit_amount || 0;
          ctx.session.session_data.skip_apartment = true;
          return [];
        }

        const cc = (ctx.business.country_code || 'NG') as CountryCode;
        return [{
          type: 'list',
          title: 'Select Option',
          body: 'What would you like to book?',
          buttonLabel: 'Choose',
          items: listings.map(p => ({
            title: p.name,
            description: p.price > 0 ? `${formatCurrency(p.price, cc)}/night${p.max_guests ? ` • up to ${p.max_guests} guests` : ''}` : '',
            postbackText: p.id,
          })),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        // Try properties first, fall back to services
        let match: { id: string; name: string; price: number; deposit_amount: number } | null = null;

        const { data: property } = await ctx.supabase
          .from('properties')
          .select('id, name, price, deposit_amount')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .maybeSingle();

        if (property) {
          match = { ...property, deposit_amount: property.deposit_amount || 0 };
        } else {
          const { data: service } = await ctx.supabase
            .from('services')
            .select('id, name, price, deposit_amount')
            .eq('id', input)
            .eq('business_id', ctx.business!.id)
            .maybeSingle();
          if (service) match = { ...service, deposit_amount: service.deposit_amount || 0 };
        }

        if (!match) return { valid: false, errorMessage: 'Please select a valid option.' };

        return {
          valid: true,
          data: {
            property_id: match.id,
            service_name: match.name,
            nightly_rate: match.price,
            service_deposit: match.deposit_amount,
          },
        };
      },
      async next() { return 'select_checkin'; },
      async skipIf(ctx: FlowContext) { return !!ctx.session.session_data.skip_apartment; },
    },

    // ── Step 2: Select Check-in Date ──
    {
      id: 'select_checkin',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const dates: Array<{ title: string; postbackText: string }> = [];
        for (let i = 1; i <= 30 && dates.length < 10; i++) {
          const d = new Date();
          d.setDate(d.getDate() + i);
          const label = d.toLocaleDateString(getLocale(cc), { weekday: 'short', day: 'numeric', month: 'short' });
          dates.push({ title: label, postbackText: d.toISOString().split('T')[0] });
        }
        return [{
          type: 'list',
          title: 'Check-in Date',
          body: 'When would you like to check in?',
          buttonLabel: 'Choose Date',
          items: dates,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        let dateStr = input;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
          const parsed = new Date(input);
          if (isNaN(parsed.getTime())) {
            return { valid: false, errorMessage: 'Please tap one of the date options.' };
          }
          dateStr = parsed.toISOString().split('T')[0];
        }

        const selected = new Date(dateStr + 'T00:00');
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        if (selected < tomorrow) return { valid: false, errorMessage: 'Check-in must be a future date.' };

        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + 90);
        if (selected > maxDate) return { valid: false, errorMessage: 'Bookings can only be made up to 90 days in advance.' };

        return { valid: true, data: { check_in: dateStr } };
      },
      async next() { return 'select_checkout'; },
    },

    // ── Step 3: Select Check-out Date ──
    {
      id: 'select_checkout',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const checkInStr = ctx.session.session_data.check_in as string;
        const checkInDate = new Date(checkInStr + 'T00:00');
        const dates: Array<{ title: string; description: string; postbackText: string }> = [];
        for (let i = 1; i <= 30 && dates.length < 10; i++) {
          const d = new Date(checkInDate);
          d.setDate(d.getDate() + i);
          const label = d.toLocaleDateString(getLocale(cc), { weekday: 'short', day: 'numeric', month: 'short' });
          dates.push({
            title: label,
            description: `${i} night${i > 1 ? 's' : ''}`,
            postbackText: d.toISOString().split('T')[0],
          });
        }
        return [{
          type: 'list',
          title: 'Check-out Date',
          body: 'When would you like to check out?',
          buttonLabel: 'Choose Date',
          items: dates,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        let dateStr = input;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
          const parsed = new Date(input);
          if (isNaN(parsed.getTime())) {
            return { valid: false, errorMessage: 'Please tap one of the date options.' };
          }
          dateStr = parsed.toISOString().split('T')[0];
        }

        const checkInStr = ctx.session.session_data.check_in as string;
        const checkIn = new Date(checkInStr + 'T00:00');
        const checkOut = new Date(dateStr + 'T00:00');

        if (checkOut <= checkIn) {
          return { valid: false, errorMessage: 'Check-out must be after your check-in date.' };
        }

        const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
        return { valid: true, data: { check_out: dateStr, nights } };
      },
      async next() { return 'select_guests'; },
    },

    // ── Step 4: Select Guests ──
    {
      id: 'select_guests',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        return [
          {
            type: 'buttons',
            body: 'How many guests?',
            buttons: [
              { id: '1', title: '1 guest' },
              { id: '2', title: '2 guests' },
              { id: '4', title: '4 guests' },
            ],
          },
          { type: 'text', text: 'Or type a number (1-10).' },
        ];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const maxQty = getMaxQuantity(ctx.business?.category || 'shortlet');
        const size = parseInt(input, 10);
        if (isNaN(size) || size < 1 || size > maxQty) {
          return { valid: false, errorMessage: `Please enter a number between 1 and ${maxQty}.` };
        }
        return { valid: true, data: { guests: size } };
      },
      async next() { return 'special_requests'; },
    },

    // ── Step 5: Special Requests ──
    {
      id: 'special_requests',
      async prompt(): Promise<PromptMessage[]> {
        return [
          {
            type: 'buttons',
            body: 'Any special requests?',
            buttons: [
              { id: 'req_none', title: "No, I'm good" },
              { id: 'req_airport', title: 'Airport pickup' },
              { id: 'req_early', title: 'Early check-in' },
            ],
          },
          { type: 'text', text: 'Or type your own request:' },
        ];
      },
      async validate(input: string): Promise<ValidationResult> {
        const requestMap: Record<string, string> = {
          req_airport: 'Airport pickup requested',
          req_early: 'Early check-in requested',
        };
        let request: string | undefined;
        if (requestMap[input]) {
          request = requestMap[input];
        } else if (input !== 'req_none') {
          request = input;
        }
        return { valid: true, data: { special_requests: request || '' } };
      },
      async next() { return 'reservation_confirmation'; },
    },

    // ── Step 6: Confirmation ──
    {
      id: 'reservation_confirmation',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const nights = d.nights as number;
        const nightlyRate = d.nightly_rate as number;
        const totalAmount = nights * nightlyRate;
        const depositAmount = (d.service_deposit as number) || 0;

        const checkInLabel = new Date((d.check_in as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
          weekday: 'short', day: 'numeric', month: 'short',
        });
        const checkOutLabel = new Date((d.check_out as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
          weekday: 'short', day: 'numeric', month: 'short',
        });

        const summary = getReservationConfirmationMessage({
          businessName: ctx.business?.name || 'Business',
          apartmentName: (d.service_name as string) || 'Apartment',
          checkInLabel,
          checkOutLabel,
          nights,
          nightlyRate,
          guests: (d.guests as number) || 1,
          totalAmount,
          depositAmount,
          referenceCode: '(pending)',
          countryCode: cc,
        });

        // Send summary first, then buttons — so customer reads details before acting
        await ctx.sender.sendText({ to: ctx.from, text: summary });
        return [
          {
            type: 'buttons',
            body: 'Confirm this reservation?',
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

    // ── Step 7: Collect Name ──
    {
      id: 'collect_name',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: 'To complete your reservation, I need your name.\n\nPlease type your *full name*:' }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const parts = input.trim().split(/\s+/);
        if (!parts[0] || parts[0].length < 2) {
          return { valid: false, errorMessage: 'Please enter a valid name (first and last name):' };
        }
        return {
          valid: true,
          data: { first_name: parts[0], last_name: parts.slice(1).join(' ') || '' },
        };
      },
      async next() { return 'collect_email'; },
      async skipIf(ctx: FlowContext) {
        if (ctx.session.user_id) {
          const user = await findUserByPhone(ctx.supabase, ctx.from);
          if (user?.first_name) {
            ctx.session.session_data.first_name = user.first_name;
            ctx.session.session_data.last_name = user.last_name;
            ctx.session.session_data.email = user.email || '';
            return true;
          }
        }
        return false;
      },
    },

    // ── Step 8: Collect Email ──
    {
      id: 'collect_email',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        return [{
          type: 'text',
          text: `Thanks, ${ctx.session.session_data.first_name}! 📧 What's your email address?\n\nType your email or *skip*:`,
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input.toLowerCase() === 'skip') {
          return { valid: true };
        }
        const email = input.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return { valid: false, errorMessage: "That doesn't look like a valid email. Try again or type *skip*:" };
        }
        return { valid: true, data: { email } };
      },
      async next() { return 'create_reservation'; },
      async skipIf(ctx: FlowContext) {
        return !!ctx.session.user_id;
      },
    },

    // ── Step 9: Create Reservation ──
    {
      id: 'create_reservation',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        // Ensure user exists
        let userId = ctx.session.user_id;
        if (!userId) {
          userId = await createWhatsAppUser(
            ctx.supabase,
            ctx.from,
            (d.first_name as string) || '',
            (d.last_name as string) || '',
            (d.email as string) || undefined,
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
          return [{ type: 'text', text: "Something went wrong creating your account. Send *Hi* to try again." }];
        }

        const nights = d.nights as number;
        const nightlyRate = d.nightly_rate as number;
        const totalAmount = nights * nightlyRate;
        const depositAmount = (d.service_deposit as number) || 0;
        const payableAmount = depositAmount > 0 ? depositAmount : totalAmount;

        // ── T&C gate ──
        if (!d._terms_accepted && payableAmount > 0 && ctx.business?.metadata?.require_terms_before_payment !== false) {
          await ctx.supabase.from('bot_sessions')
            .update({ session_data: d })
            .eq('id', ctx.session.id);
          return getTermsPrompt(ctx.business?.name || 'Business', (ctx.business?.metadata as Record<string, unknown>)?.terms_text as string | undefined);
        }
        if (d._terms_cancelled) {
          await ctx.supabase.from('bot_sessions')
            .update({ current_step: 'complete', is_active: false })
            .eq('id', ctx.session.id);
          return [{ type: 'text', text: 'No problem! Your reservation has been cancelled. Send *Hi* to start over.' }];
        }

        // Check availability — prevent double-booking same property on overlapping dates
        const propertyId = (d.property_id as string) || null;
        if (propertyId) {
          const { data: overlapping } = await ctx.supabase
            .from('reservations')
            .select('id')
            .eq('business_id', ctx.business!.id)
            .or(`property_id.eq.${propertyId},service_id.eq.${propertyId}`)
            .in('status', ['pending', 'confirmed'])
            .lt('check_in', d.check_out as string)
            .gt('check_out', d.check_in as string)
            .limit(1);

          if (overlapping && overlapping.length > 0) {
            return [{
              type: 'text',
              text: 'Sorry, this property is not available for the selected dates. Please try different dates or another option. Send *Hi* to start over.',
            }];
          }
        }

        const insertPayload: Record<string, unknown> = {
          business_id: ctx.business!.id,
          user_id: userId,
          property_id: propertyId,
          check_in: d.check_in as string,
          check_out: d.check_out as string,
          guests: (d.guests as number) || 1,
          nightly_rate: nightlyRate,
          total_amount: totalAmount,
          deposit_amount: depositAmount,
          deposit_status: payableAmount > 0 ? 'pending' : 'none',
          status: payableAmount > 0 ? 'pending' : 'confirmed',
          special_requests: (d.special_requests as string) || null,
          guest_name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
          guest_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
          guest_email: (d.email as string) || null,
          channel: 'whatsapp',
        };

        const { data: reservation, error: insertError } = await ctx.supabase
          .from('reservations')
          .insert(insertPayload)
          .select('id, reference_code')
          .single();

        if (insertError || !reservation) {
          console.error('Failed to create reservation', insertError);
          return [{ type: 'text', text: 'Sorry, something went wrong. Send "Hi" to try again.' }];
        }

        d.reservation_id = reservation.id;
        d.reference_code = reservation.reference_code;
        d.total_amount = totalAmount;
        d.payable_amount = payableAmount;

        // Upsert customer profile
        await ctx.supabase.rpc('upsert_customer_profile', {
          p_business_id: ctx.business!.id,
          p_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
          p_name: insertPayload.guest_name as string || null,
          p_booking_amount: payableAmount,
          p_is_booking: true,
        });

        await ctx.supabase
          .from('bot_sessions')
          .update({ session_data: d })
          .eq('id', ctx.session.id);

        const checkInLabel = new Date((d.check_in as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
          weekday: 'short', day: 'numeric', month: 'short',
        });
        const checkOutLabel = new Date((d.check_out as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
          weekday: 'short', day: 'numeric', month: 'short',
        });

        // Record platform fee
        if (payableAmount > 0 && ctx.business) {
          const isInTrial = new Date(ctx.business.trial_ends_at) > new Date();
          await recordPlatformFee(ctx.supabase, {
            businessId: ctx.business.id,
            reservationId: reservation.id,
            transactionAmount: payableAmount,
            tier: ctx.business.subscription_tier as SubscriptionTier,
            isInTrial,
          });
        }

        if (payableAmount > 0) {
          const paymentResult = await initializePayment(ctx.supabase, {
            reservationId: reservation.id,
            userId,
            amount: payableAmount,
            referenceCode: reservation.reference_code,
            businessName: ctx.business?.name || 'Business',
            phone: ctx.from,
            userEmail: (d.email as string) || undefined,
            countryCode: cc,
            businessId: ctx.business?.id,
          });

          if (paymentResult) {
            d.payment_reference = paymentResult.reference;
            await ctx.supabase
              .from('bot_sessions')
              .update({ session_data: d, current_step: 'reservation_payment' })
              .eq('id', ctx.session.id);

            const summary = getReservationConfirmationMessage({
              businessName: ctx.business?.name || 'Business',
              apartmentName: (d.service_name as string) || 'Apartment',
              checkInLabel,
              checkOutLabel,
              nights,
              nightlyRate,
              guests: (d.guests as number) || 1,
              totalAmount,
              depositAmount,
              referenceCode: reservation.reference_code,
              countryCode: cc,
            });

            return [
              {
                type: 'text',
                text: [
                  summary,
                  '',
                  `💳 *${depositAmount > 0 ? 'Deposit' : 'Payment'} Required: ${formatCurrency(payableAmount, cc)}*`,
                  '',
                  `Pay here 👇`,
                  paymentResult.url,
                  '',
                  `⚠️ After paying, *return to WhatsApp* and tap *I've Paid* to confirm.`,
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
        }

        // No payment needed — reservation confirmed
        await ctx.supabase
          .from('bot_sessions')
          .update({ current_step: 'complete', is_active: false })
          .eq('id', ctx.session.id);

        // Create notification
        if (ctx.business) {
          await createNotification(ctx.supabase, {
            businessId: ctx.business.id,
            bookingId: reservation.id,
            type: 'booking_confirmation',
            channel: 'whatsapp',
            body: `Reservation at ${ctx.business.name}: ${d.service_name} from ${checkInLabel} to ${checkOutLabel} (${nights} nights). Ref: ${reservation.reference_code}`,
          });

          handlePostCompletion({
            supabase: ctx.supabase,
            businessId: ctx.business.id,
            customerPhone: ctx.from,
            customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim() || null,
            serviceType: 'booking',
            referenceId: reservation.id,
            sender: ctx.sender,
          }).catch(err => console.error('[RESERVATION] Post-completion error:', err));
        }

        return [{
          type: 'text',
          text: [
            `✅ *Reservation Confirmed!*`,
            '',
            `🏠 ${d.service_name}`,
            `📅 ${checkInLabel} → ${checkOutLabel}`,
            `🌙 ${nights} nights`,
            `👥 ${d.guests} guest${(d.guests as number) > 1 ? 's' : ''}`,
            `🔑 Ref: *${reservation.reference_code}*`,
            '',
            'See you soon! 🎉',
          ].join('\n'),
        }];
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
          return 'create_reservation';
        }
        return null;
      },
    },

    // ── Step 10: Payment Check ──
    {
      id: 'reservation_payment',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: "Please complete your payment using the link sent above.\n\nAfter paying, *return to WhatsApp* and tap *I've Paid* to confirm, or *Cancel* to cancel.",
          buttons: [
            { id: 'i_paid', title: "I've Paid" },
            { id: 'cancel', title: 'Cancel' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const text = input.toLowerCase();

        if (text === 'cancel') {
          const reservationId = ctx.session.session_data.reservation_id as string;
          if (reservationId) {
            await ctx.supabase
              .from('reservations')
              .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'guest' })
              .eq('id', reservationId);
          }
          return { valid: true, data: { _action: 'cancel' } };
        }

        if (text === 'check' || text === 'done' || text === 'paid' || text === 'i_paid' || text === "i've paid") {
          const ref = ctx.session.session_data.payment_reference as string;
          if (!ref) return { valid: true, data: { _action: 'cancel' } };

          const verified = await verifyPayment(ctx.supabase, ref, (ctx.business?.country_code || 'NG') as CountryCode);
          if (verified) {
            const d = ctx.session.session_data;
            const cc = (ctx.business?.country_code || 'NG') as CountryCode;
            const checkInLabel = new Date((d.check_in as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
              weekday: 'short', day: 'numeric', month: 'short',
            });
            const checkOutLabel = new Date((d.check_out as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
              weekday: 'short', day: 'numeric', month: 'short',
            });

            await ctx.sender.sendText({
              to: ctx.from,
              text: [
                `✅ *Payment Confirmed!*`,
                '',
                `Your reservation at *${ctx.business?.name}* is fully confirmed.`,
                `🏠 ${d.service_name}`,
                `📅 ${checkInLabel} → ${checkOutLabel}`,
                `🌙 ${d.nights} nights`,
                `👥 ${d.guests} guest${(d.guests as number) > 1 ? 's' : ''}`,
                `🔑 Ref: *${d.reference_code as string}*`,
                '',
                'See you soon! 🎉',
              ].join('\n'),
            });

            if (ctx.business) {
              handlePostCompletion({
                supabase: ctx.supabase,
                businessId: ctx.business.id,
                customerPhone: ctx.from,
                customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim() || null,
                serviceType: 'booking',
                referenceId: d.reservation_id as string,
                sender: ctx.sender,
              }).catch(err => console.error('[RESERVATION] Post-completion error:', err));
            }

            return { valid: true, data: { _action: 'payment_confirmed' } };
          }

          return { valid: false, errorMessage: "Payment not yet received. Please complete payment using the link sent earlier." };
        }

        return { valid: false, errorMessage: "Tap *I've Paid* after completing payment, or *Cancel* to cancel." };
      },
      async next() {
        return null;
      },
    },
  ],
};
