import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { BOOKING_DEFAULTS, CATEGORY_LABELS, generateTimeSlots, formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { createNotification } from './shared/notifications';
import { getConfirmationMessage } from './shared/templates';
import { handlePostCompletion } from './shared/post-completion';
import type { SubscriptionTier } from '@/lib/constants';
import { getEnabledCapabilities } from '@/lib/capabilities/service';

export const schedulingFlow: FlowDefinition = {
  type: 'scheduling',
  steps: [
    // ── Select Service ──
    {
      id: 'select_service',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

        const { data: services } = await ctx.supabase
          .from('services')
          .select('id, name, price, duration_minutes')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .order('sort_order');

        if (!services || services.length === 0) {
          // No services — skip to date
          ctx.session.session_data.skip_service = true;
          return [];
        }

        if (services.length === 1) {
          // Auto-select single service
          ctx.session.session_data.service_id = services[0].id;
          ctx.session.session_data.service_name = services[0].name;
          ctx.session.session_data.service_price = services[0].price;
          ctx.session.session_data.service_duration = services[0].duration_minutes;
          ctx.session.session_data.skip_service = true;
          return [];
        }

        const labels = CATEGORY_LABELS[ctx.business.category];
        return [{
          type: 'list',
          title: 'Select Service',
          body: `What would you like to ${labels.actionVerb.toLowerCase()}?`,
          buttonLabel: 'Choose',
          items: services.map(s => {
            const cc = (ctx.business?.country_code || 'NG') as CountryCode;
            return {
              title: s.name,
              description: s.price > 0 ? `${formatCurrency(s.price, cc)}${s.duration_minutes ? ` \u2022 ${s.duration_minutes}min` : ''}` : (s.duration_minutes ? `${s.duration_minutes}min` : ''),
              postbackText: s.id,
            };
          }),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: service } = await ctx.supabase
          .from('services')
          .select('id, name, price, duration_minutes, deposit_amount')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .single();

        if (!service) return { valid: false, errorMessage: 'Please select a valid service.' };

        return {
          valid: true,
          data: {
            service_id: service.id,
            service_name: service.name,
            service_price: service.price,
            service_duration: service.duration_minutes,
            service_deposit: service.deposit_amount,
          },
        };
      },
      async next() { return 'select_staff'; },
      async skipIf(ctx: FlowContext) { return !!ctx.session.session_data.skip_service; },
    },

    // ── Select Staff ──
    {
      id: 'select_staff',
      async skipIf(ctx: FlowContext) {
        if (!ctx.business) return true;
        // Skip if staff capability not enabled
        const caps = await getEnabledCapabilities(ctx.supabase, ctx.business.id);
        if (!caps.includes('staff')) return true;

        // Get active staff for this service
        const serviceId = ctx.session.session_data.service_id as string | undefined;
        let query = ctx.supabase
          .from('business_staff')
          .select('id, name')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true);

        const { data: staff } = await query;
        if (!staff || staff.length === 0) return true;

        // If service selected, filter to staff who handle that service
        let filtered = staff;
        if (serviceId) {
          const { data: serviceData } = await ctx.supabase
            .from('services')
            .select('name')
            .eq('id', serviceId)
            .single();
          if (serviceData) {
            filtered = staff.filter(s => {
              const services = (s as unknown as { services: string[] }).services;
              return !services || services.length === 0 || services.includes(serviceData.name);
            });
          }
        }

        // Skip if 0 or 1 staff
        if (filtered.length <= 1) {
          if (filtered.length === 1) {
            ctx.session.session_data.staff_id = filtered[0].id;
            ctx.session.session_data.staff_name = filtered[0].name;
          }
          return true;
        }

        ctx.session.session_data._available_staff = filtered.map(s => ({ id: s.id, name: s.name }));
        return false;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const staff = ctx.session.session_data._available_staff as Array<{ id: string; name: string }>;
        const buttons = staff.slice(0, 2).map(s => ({
          id: `staff_${s.id}`,
          title: s.name,
        }));
        buttons.push({ id: 'staff_any', title: 'Any available' });

        return [{
          type: 'buttons',
          body: 'Who would you like to see?',
          buttons,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input === 'staff_any') {
          return { valid: true };
        }
        const match = input.match(/^staff_(.+)$/);
        if (match) {
          const staffId = match[1];
          const staff = ctx.session.session_data._available_staff as Array<{ id: string; name: string }>;
          const found = staff?.find(s => s.id === staffId);
          if (found) {
            return { valid: true, data: { staff_id: found.id, staff_name: found.name } };
          }
        }
        return { valid: false, errorMessage: 'Please select a staff member or tap *Any available*.' };
      },
      async next() { return 'select_date'; },
    },

    // ── Select Date ──
    {
      id: 'select_date',
      async skipIf(ctx: FlowContext) {
        // Skip if smart intent already extracted a date
        return !!ctx.session.session_data.date;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const dates: Array<{ title: string; postbackText: string }> = [];
        for (let i = 1; i <= 7; i++) {
          const d = new Date();
          d.setDate(d.getDate() + i);
          const label = d.toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { weekday: 'short', day: 'numeric', month: 'short' });
          dates.push({ title: label, postbackText: d.toISOString().split('T')[0] });
        }
        return [{
          type: 'list',
          title: 'Select Date',
          body: 'When would you like to come?',
          buttonLabel: 'Choose Date',
          items: dates,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        let dateStr = input;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
          const parsed = new Date(input);
          if (isNaN(parsed.getTime())) {
            const abuse = ctx.intelligence.recordGibberish(ctx.from);
            return { valid: false, errorMessage: abuse.warn ? abuse.message : "Please tap one of the date options." };
          }
          dateStr = parsed.toISOString().split('T')[0];
        }

        const selected = new Date(dateStr + 'T00:00');
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        if (selected < tomorrow) return { valid: false, errorMessage: 'Please select a future date.' };

        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + BOOKING_DEFAULTS.maxAdvanceDays);
        if (selected > maxDate) return { valid: false, errorMessage: `Bookings can only be made up to ${BOOKING_DEFAULTS.maxAdvanceDays} days in advance.` };

        ctx.intelligence.resetAbuse(ctx.from);
        return { valid: true, data: { date: dateStr } };
      },
      async next() { return 'select_time'; },
    },

    // ── Select Time ──
    {
      id: 'select_time',
      async skipIf(ctx: FlowContext) {
        // Skip if smart intent already extracted a specific time
        return !!ctx.session.session_data.time;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const dateStr = ctx.session.session_data.date as string;
        const dateLabel = new Date(dateStr + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { weekday: 'long', day: 'numeric', month: 'short' });
        let allSlots = generateTimeSlots('08:00', '22:00', 60);

        // Filter by time preference if smart intent set one
        const pref = ctx.session.session_data._time_preference as string | undefined;
        if (pref === 'morning') {
          allSlots = generateTimeSlots('08:00', '11:00', 60);
        } else if (pref === 'afternoon') {
          allSlots = generateTimeSlots('12:00', '16:00', 60);
        } else if (pref === 'evening') {
          allSlots = generateTimeSlots('17:00', '22:00', 60);
        }

        const prefLabel = pref ? ` ${pref}` : '';
        return [{
          type: 'list',
          title: 'Select Time',
          body: `Available${prefLabel} times for ${dateLabel}:`,
          buttonLabel: 'Choose Time',
          items: allSlots.map(t => ({ title: t, postbackText: t })),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(input);
        if (!timeMatch) {
          const abuse = ctx.intelligence.recordGibberish(ctx.from);
          return { valid: false, errorMessage: abuse.warn ? abuse.message : "Please tap one of the time options." };
        }
        ctx.intelligence.resetAbuse(ctx.from);
        return { valid: true, data: { time: input } };
      },
      async next() { return 'select_quantity'; },
    },

    // ── Select Quantity ──
    {
      id: 'select_quantity',
      async skipIf(ctx: FlowContext) {
        // Skip if smart intent already extracted quantity
        return !!ctx.session.session_data.party_size;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const labels = CATEGORY_LABELS[ctx.business?.category || 'restaurant'];
        return [
          {
            type: 'buttons',
            body: `How many ${labels.quantityLabel}?`,
            buttons: [
              { id: '1', title: `1 ${labels.quantityLabel === 'guests' ? 'guest' : ''}`.trim() },
              { id: '2', title: `2 ${labels.quantityLabel}` },
              { id: '4', title: `4 ${labels.quantityLabel}` },
            ],
          },
          { type: 'text', text: `Or type a number (1-${BOOKING_DEFAULTS.maxPartySize}).` },
        ];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const size = parseInt(input, 10);
        if (isNaN(size) || size < 1 || size > BOOKING_DEFAULTS.maxPartySize) {
          return { valid: false, errorMessage: `Please enter a number between 1 and ${BOOKING_DEFAULTS.maxPartySize}.` };
        }
        ctx.intelligence.resetAbuse(ctx.from);
        return { valid: true, data: { party_size: size } };
      },
      async next() { return 'special_requests'; },
    },

    // ── Special Requests ──
    {
      id: 'special_requests',
      async prompt(): Promise<PromptMessage[]> {
        return [
          {
            type: 'buttons',
            body: 'Any special requests?',
            buttons: [
              { id: 'req_none', title: "No, I'm good" },
              { id: 'req_birthday', title: 'Birthday 🎂' },
              { id: 'req_window', title: 'Window seat' },
            ],
          },
          { type: 'text', text: 'Or type your own request:' },
        ];
      },
      async validate(input: string): Promise<ValidationResult> {
        const response = input.toLowerCase();
        let request: string | undefined;
        if (response === 'req_birthday') request = 'Birthday celebration 🎂';
        else if (response === 'req_window') request = 'Window seat preferred';
        else if (response !== 'req_none') request = input;

        return { valid: true, data: { special_requests: request || '' } };
      },
      async next() { return 'book_for_other'; },
    },

    // ── Book For Other ──
    {
      id: 'book_for_other',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: 'Who is this booking for?',
          buttons: [
            { id: 'for_myself', title: 'Myself' },
            { id: 'for_other', title: 'Someone else' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input.toLowerCase() === 'for_myself') {
          return { valid: true, data: { book_for_other: false } };
        }
        if (input.toLowerCase() === 'for_other') {
          return { valid: true, data: { book_for_other: true } };
        }
        return { valid: false, errorMessage: 'Please tap *Myself* or *Someone else*.' };
      },
      async next(ctx: FlowContext) {
        return ctx.session.session_data.book_for_other ? 'collect_other_name' : 'confirmation';
      },
    },

    // ── Collect Other Name ──
    {
      id: 'collect_other_name',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: "What's the guest's name?" }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (!input.trim() || input.trim().length < 2) {
          return { valid: false, errorMessage: 'Please enter a valid name.' };
        }
        return { valid: true, data: { other_name: input.trim() } };
      },
      async next() { return 'confirmation'; },
    },

    // ── Confirmation ──
    {
      id: 'confirmation',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const d = ctx.session.session_data;
        const labels = CATEGORY_LABELS[ctx.business?.category || 'restaurant'];
        const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        });

        const lines = [
          `📋 *${labels.receiptTitle} Summary*`,
          '',
          `${labels.confirmationEmoji} ${ctx.business?.name || 'Business'}`,
        ];
        if (d.service_name) lines.push(`📌 ${d.service_name as string}`);
        lines.push(`📅 ${dateLabel}`);
        lines.push(`🕐 ${d.time as string}`);
        lines.push(`👥 ${d.party_size as number} ${labels.quantityLabel}`);
        if (d.special_requests) lines.push(`📝 ${d.special_requests as string}`);
        if (d.book_for_other && d.other_name) lines.push(`👤 For: ${d.other_name as string}`);

        return [
          { type: 'text', text: lines.join('\n') },
          {
            type: 'buttons',
            body: 'Confirm this booking?',
            buttons: [
              { id: 'confirm', title: 'Confirm ✓' },
              { id: 'cancel', title: 'Cancel' },
            ],
          },
        ];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
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
        return [{ type: 'text', text: 'To complete your booking, I need your name.\n\nPlease type your *full name* (e.g. Ade Johnson):' }];
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
        // Skip if user already exists
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

    // ── Collect Email ──
    {
      id: 'collect_email',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        return [
          { type: 'text', text: `Thanks, ${ctx.session.session_data.first_name}! 📧 What's your email address?\n\nType your email or *skip*:` },
        ];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input.toLowerCase() === 'skip' || input.toLowerCase() === 'skip_email') {
          return { valid: true };
        }
        const email = input.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return { valid: false, errorMessage: "That doesn't look like a valid email. Try again or type *skip*:" };
        }
        return { valid: true, data: { email } };
      },
      async next() { return 'create_booking'; },
      async skipIf(ctx: FlowContext) {
        return !!ctx.session.user_id;
      },
    },

    // ── Create Booking (processing step) ──
    {
      id: 'create_booking',
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

        // Get deposit info
        const serviceDeposit = (d.service_deposit as number) || 0;
        const partySize = (d.party_size as number) || 1;

        // For restaurants: check business deposit_per_guest
        let depositPerGuest = 0;
        if (ctx.business) {
          const { data: biz } = await ctx.supabase
            .from('businesses')
            .select('deposit_per_guest')
            .eq('id', ctx.business.id)
            .single();
          depositPerGuest = biz?.deposit_per_guest || 0;
        }

        const totalDeposit = serviceDeposit > 0 ? serviceDeposit : (depositPerGuest * partySize);

        const insertPayload: Record<string, unknown> = {
          business_id: ctx.business!.id,
          user_id: userId,
          service_id: (d.service_id as string) || null,
          date: d.date as string,
          time: d.time as string,
          party_size: partySize,
          flow_type: 'scheduling',
          channel: 'whatsapp',
          deposit_amount: totalDeposit,
          deposit_status: totalDeposit > 0 ? 'pending' : 'none',
          status: totalDeposit > 0 ? 'pending' : 'confirmed',
          special_requests: (d.special_requests as string) || null,
          guest_name: d.book_for_other ? (d.other_name as string) : `${d.first_name || ''} ${d.last_name || ''}`.trim(),
          guest_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
          guest_email: (d.email as string) || null,
          total_amount: totalDeposit,
          quantity: partySize,
        };

        const { data: booking, error: insertError } = await ctx.supabase
          .from('bookings')
          .insert(insertPayload)
          .select('id, reference_code')
          .single();

        if (insertError || !booking) {
          console.error('Failed to create booking', insertError);
          return [{ type: 'text', text: 'Sorry, something went wrong. Send "Hi" to try again.' }];
        }

        d.booking_id = booking.id;
        d.reference_code = booking.reference_code;
        d.deposit_amount = totalDeposit;

        // Reserve booking slot (overbooking prevention)
        if (ctx.business) {
          await ctx.supabase.rpc('reserve_booking_slot', {
            p_business_id: ctx.business.id,
            p_date: d.date as string,
            p_start_time: d.time as string,
            p_end_time: d.time as string, // end_time is auto-calculated
            p_staff_id: (d.staff_id as string) || null,
          });
        }

        // Upsert customer profile
        await ctx.supabase.rpc('upsert_customer_profile', {
          p_business_id: ctx.business!.id,
          p_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
          p_name: insertPayload.guest_name as string || null,
          p_booking_amount: totalDeposit,
          p_is_booking: true,
        });

        await ctx.supabase
          .from('bot_sessions')
          .update({ session_data: d })
          .eq('id', ctx.session.id);

        const labels = CATEGORY_LABELS[ctx.business?.category || 'restaurant'];
        const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
          weekday: 'long', day: 'numeric', month: 'long',
        });

        // Record platform fee
        if (totalDeposit > 0 && ctx.business) {
          const isInTrial = new Date(ctx.business.trial_ends_at) > new Date();
          await recordPlatformFee(ctx.supabase, {
            businessId: ctx.business.id,
            bookingId: booking.id,
            transactionAmount: totalDeposit,
            tier: ctx.business.subscription_tier as SubscriptionTier,
            isInTrial,
          });
        }

        if (totalDeposit > 0) {
          // Need payment
          const paymentResult = await initializePayment(ctx.supabase, {
            bookingId: booking.id,
            userId,
            amount: totalDeposit,
            referenceCode: booking.reference_code,
            businessName: ctx.business?.name || 'Business',
            phone: ctx.from,
            userEmail: (d.email as string) || undefined,
            countryCode: (ctx.business?.country_code || 'NG') as CountryCode,
            businessId: ctx.business?.id,
          });

          if (paymentResult) {
            d.payment_reference = paymentResult.reference;
            await ctx.supabase
              .from('bot_sessions')
              .update({ session_data: d, current_step: 'payment' })
              .eq('id', ctx.session.id);

            return [
              {
                type: 'text',
                text: [
                  `📋 *Booking Created!*`,
                  '',
                  `${labels.confirmationEmoji} ${ctx.business?.name}`,
                  `📅 ${dateLabel}`,
                  `🕐 ${d.time as string}`,
                  `👥 ${partySize} ${labels.quantityLabel}`,
                  `🔑 Ref: *${booking.reference_code}*`,
                  '',
                  `\ud83d\udcb3 *Deposit Required: ${formatCurrency(totalDeposit, (ctx.business?.country_code || 'NG') as CountryCode)}*`,
                  '',
                  `Pay here 👇`,
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
        }

        // No deposit — booking confirmed
        await ctx.supabase
          .from('bot_sessions')
          .update({ current_step: 'complete', is_active: false })
          .eq('id', ctx.session.id);

        // Custom template for standalone bots
        let message: string;
        if (ctx.session.business_id) {
          const templates = await ctx.standalone.getBotTemplates(ctx.session.business_id);
          const tierInfo = await ctx.standalone.checkTierLimits(ctx.session.business_id);
          message = ctx.standalone.fillTemplate(templates.confirmation, {
            restaurant_name: ctx.business?.name || '',
            business_name: ctx.business?.name || '',
            date: dateLabel,
            time: (d.time as string) || '',
            party_size: partySize,
            quantity: partySize,
            reference_code: booking.reference_code,
          });
          if (!tierInfo.isWhitelabel) {
            message += '\n\n_Powered by Waaiio_';
          }
        } else {
          message = getConfirmationMessage({
            emoji: labels.confirmationEmoji,
            businessName: ctx.business?.name || 'Business',
            dateLabel,
            time: (d.time as string) || '',
            quantity: partySize,
            quantityLabel: labels.quantityLabel,
            referenceCode: booking.reference_code,
          });
        }

        // Create notification
        if (ctx.business) {
          await createNotification(ctx.supabase, {
            businessId: ctx.business.id,
            bookingId: booking.id,
            type: 'booking_confirmation',
            channel: 'whatsapp',
            body: `Booking at ${ctx.business.name} on ${dateLabel} at ${d.time} confirmed. Ref: ${booking.reference_code}`,
          });

          // Post-completion: loyalty, feedback, referral
          handlePostCompletion({
            supabase: ctx.supabase,
            businessId: ctx.business.id,
            customerPhone: ctx.from,
            customerName: d.book_for_other ? (d.other_name as string) : `${d.first_name || ''} ${d.last_name || ''}`.trim() || null,
            serviceType: 'booking',
            referenceId: booking.id,
            sender: ctx.sender,
          }).catch(err => console.error('[SCHEDULING] Post-completion error:', err));
        }

        return [{ type: 'text', text: message }];
      },
      async validate(): Promise<ValidationResult> {
        return { valid: true };
      },
      async next() { return null; },
    },

    // ── Payment Check ──
    {
      id: 'payment',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: "Please complete your deposit payment using the link sent above.\n\nTap *I've Paid* after paying, or *Cancel* to cancel.",
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
              .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'diner' })
              .eq('id', bookingId);
          }
          return { valid: true, data: { _action: 'cancel' } };
        }

        if (text === 'check' || text === 'done' || text === 'paid' || text === 'i_paid' || text === "i've paid") {
          const ref = ctx.session.session_data.payment_reference as string;
          if (!ref) return { valid: true, data: { _action: 'cancel' } };

          const verified = await verifyPayment(ctx.supabase, ref, (ctx.business?.country_code || 'NG') as CountryCode);
          if (verified) {
            const d = ctx.session.session_data;
            const labels = CATEGORY_LABELS[ctx.business?.category || 'restaurant'];
            const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
              weekday: 'long', day: 'numeric', month: 'long',
            });

            await ctx.sender.sendText({
              to: ctx.from,
              text: [
                `✅ *Payment Confirmed!*`,
                '',
                `Your ${labels.entityName} at *${ctx.business?.name}* is fully confirmed.`,
                `📅 ${dateLabel} at ${d.time as string}`,
                `👥 ${d.party_size as number} ${labels.quantityLabel}`,
                `🔑 Ref: *${d.reference_code as string}*`,
                '',
                'See you there! 🎉',
              ].join('\n'),
            });

            // Post-completion: loyalty, feedback, referral
            if (ctx.business) {
              handlePostCompletion({
                supabase: ctx.supabase,
                businessId: ctx.business.id,
                customerPhone: ctx.from,
                customerName: d.book_for_other ? (d.other_name as string) : `${d.first_name || ''} ${d.last_name || ''}`.trim() || null,
                serviceType: 'booking',
                referenceId: d.booking_id as string,
                sender: ctx.sender,
              }).catch(err => console.error('[SCHEDULING] Post-completion error:', err));
            }

            return { valid: true, data: { _action: 'payment_confirmed' } };
          }

          return { valid: false, errorMessage: "Payment not yet received. Please complete payment using the link sent earlier." };
        }

        return { valid: false, errorMessage: "Tap *I've Paid* after completing payment, or *Cancel* to cancel." };
      },
      async next(ctx: FlowContext) {
        return null; // All paths end the flow
      },
    },
  ],
};
