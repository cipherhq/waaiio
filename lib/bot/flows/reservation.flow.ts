import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, getLocale, getMaxQuantity, type CountryCode } from '@/lib/constants';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { truncTitle } from '../utils/truncate';
import { createNotification } from './shared/notifications';
import { notifyOwnerNewBooking } from './shared/notify-owner';
import { getReservationConfirmationMessage } from './shared/templates';
import { handlePostCompletion } from './shared/post-completion';
import { getTermsPrompt } from './shared/terms';
import { getCalendarLinksText } from '@/lib/calendar/generate-links';
import type { SubscriptionTier } from '@/lib/constants';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

export const reservationFlow: FlowDefinition = {
  type: 'reservation',
  steps: [
    // ── Step 1: Select Property ──
    {
      id: 'select_apartment',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

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
            .neq('service_type', 'giving')
            .order('sort_order');
          listings = (services || []).map(s => ({ ...s, deposit_amount: s.deposit_amount || 0 }));
        }

        if (listings.length === 0) {
          return [{ type: 'text', text: 'No options are currently available. Please try again later.' }];
        }

        const cc = (ctx.business.country_code || 'NG') as CountryCode;
        return [{
          type: 'list',
          title: 'Select Option',
          body: 'What would you like to book?',
          buttonLabel: 'Choose',
          items: listings.map(p => ({
            title: truncTitle(p.name, 24),
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

        if (!match) return { valid: false, errorMessage: 'That option is not available. Tap one of the choices above.' };

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
      async skipIf(ctx: FlowContext) {
        if (ctx.session.session_data.skip_apartment) return true;
        if (!ctx.business) return false;

        // Auto-select if only one property/listing exists
        const { data: properties } = await ctx.supabase
          .from('properties')
          .select('id, name, price, deposit_amount')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true);

        let listings = properties || [];
        if (listings.length === 0) {
          const { data: services } = await ctx.supabase
            .from('services')
            .select('id, name, price, deposit_amount')
            .eq('business_id', ctx.business.id)
            .eq('is_active', true)
            .neq('service_type', 'giving');
          listings = services || [];
        }

        if (listings.length === 1) {
          ctx.session.session_data.property_id = listings[0].id;
          ctx.session.session_data.service_name = listings[0].name;
          ctx.session.session_data.nightly_rate = listings[0].price;
          ctx.session.session_data.service_deposit = listings[0].deposit_amount || 0;
          ctx.session.session_data.skip_apartment = true;
          return true;
        }
        return false;
      },
    },

    // ── Step 2: Select Check-in Date ──
    {
      id: 'select_checkin',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const messages: PromptMessage[] = [];

        // Send property photos if not already sent
        if (!ctx.session.session_data._photos_sent) {
          const propertyId = ctx.session.session_data.property_id as string | undefined;
          if (propertyId) {
            const { data: prop } = await ctx.supabase
              .from('properties')
              .select('photos, name, description, bedrooms, bathrooms, max_guests, amenities')
              .eq('id', propertyId)
              .maybeSingle();

            if (prop) {
              const photos = (prop.photos as string[]) || [];
              for (const url of photos.slice(0, 3)) {
                messages.push({ type: 'image' as const, imageUrl: url, caption: undefined });
              }

              // Send property details summary
              const details: string[] = [`🏠 *${prop.name}*`];
              if (prop.description) details.push(prop.description);
              const specs: string[] = [];
              if (prop.bedrooms > 0) specs.push(`${prop.bedrooms} bed`);
              if (prop.bathrooms > 0) specs.push(`${prop.bathrooms} bath`);
              if (prop.max_guests > 0) specs.push(`up to ${prop.max_guests} guests`);
              if (specs.length > 0) details.push(specs.join(' · '));
              const amenities = (prop.amenities as string[]) || [];
              if (amenities.length > 0) details.push(`✨ ${amenities.slice(0, 6).join(', ')}`);
              messages.push({ type: 'text', text: details.join('\n') });
            }
          }
          ctx.session.session_data._photos_sent = true;
        }

        const cc = (ctx.business?.country_code || 'NG') as CountryCode;

        // Load blocked dates AND existing reservations for this property
        const propertyId = ctx.session.session_data.property_id as string | undefined;
        let blockedRanges: Array<{ from: string; to: string }> = [];
        if (propertyId) {
          const todayStr = new Date().toISOString().split('T')[0];
          const [{ data: blocked }, { data: booked }] = await Promise.all([
            ctx.supabase.from('property_blocked_dates')
              .select('date_from, date_to')
              .eq('property_id', propertyId)
              .gte('date_to', todayStr),
            // Also block dates with existing confirmed/pending reservations
            ctx.supabase.from('reservations')
              .select('check_in, check_out')
              .eq('business_id', ctx.business!.id)
              .or(`property_id.eq.${sanitizeFilterValue(propertyId)},service_id.eq.${sanitizeFilterValue(propertyId)}`)
              .in('status', ['pending', 'confirmed', 'checked_in'])
              .gte('check_out', todayStr)
              .limit(100),
          ]);
          blockedRanges = [
            ...(blocked || []).map(b => ({ from: b.date_from, to: b.date_to })),
            ...(booked || []).map(r => ({ from: r.check_in, to: r.check_out })),
          ];
        }

        function isBlocked(dateStr: string): boolean {
          return blockedRanges.some(r => dateStr >= r.from && dateStr <= r.to);
        }

        const dates: Array<{ title: string; postbackText: string }> = [];
        for (let i = 1; i <= 60 && dates.length < 10; i++) {
          const d = new Date();
          d.setDate(d.getDate() + i);
          const dateStr = d.toISOString().split('T')[0];
          if (isBlocked(dateStr)) continue;
          const label = d.toLocaleDateString(getLocale(cc), { weekday: 'short', day: 'numeric', month: 'short' });
          dates.push({ title: label, postbackText: dateStr });
        }
        messages.push({
          type: 'list',
          title: 'Check-in Date',
          body: 'When would you like to check in?',
          buttonLabel: 'Choose Date',
          items: dates,
        });
        return messages;
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

        // Check blocked dates
        const propId = ctx.session.session_data.property_id as string | undefined;
        if (propId) {
          const { data: blocked } = await ctx.supabase
            .from('property_blocked_dates')
            .select('id')
            .eq('property_id', propId)
            .lte('date_from', dateStr)
            .gte('date_to', dateStr)
            .limit(1);
          if (blocked && blocked.length > 0) {
            return { valid: false, errorMessage: 'Sorry, this date is not available. Please choose another date.' };
          }
        }

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

        // Load blocked dates AND existing reservations (same pattern as check-in step)
        const propertyId = ctx.session.session_data.property_id as string | undefined;
        let blockedRanges: Array<{ from: string; to: string }> = [];
        if (propertyId) {
          const [{ data: blocked }, { data: booked }] = await Promise.all([
            ctx.supabase.from('property_blocked_dates')
              .select('date_from, date_to')
              .eq('property_id', propertyId)
              .gte('date_to', checkInStr),
            ctx.supabase.from('reservations')
              .select('check_in, check_out')
              .eq('business_id', ctx.business!.id)
              .or(`property_id.eq.${sanitizeFilterValue(propertyId)},service_id.eq.${sanitizeFilterValue(propertyId)}`)
              .in('status', ['pending', 'confirmed', 'checked_in'])
              .gte('check_out', checkInStr)
              .limit(100),
          ]);
          blockedRanges = [
            ...(blocked || []).map(b => ({ from: b.date_from, to: b.date_to })),
            ...(booked || []).map(r => ({ from: r.check_in, to: r.check_out })),
          ];
        }

        function isBlocked(dateStr: string): boolean {
          return blockedRanges.some(r => dateStr >= r.from && dateStr <= r.to);
        }

        const dates: Array<{ title: string; description: string; postbackText: string }> = [];
        for (let i = 1; i <= 60 && dates.length < 10; i++) {
          const d = new Date(checkInDate);
          d.setDate(d.getDate() + i);
          const dateStr = d.toISOString().split('T')[0];
          if (isBlocked(dateStr)) continue;
          const label = d.toLocaleDateString(getLocale(cc), { weekday: 'short', day: 'numeric', month: 'short' });
          dates.push({
            title: label,
            description: `${i} night${i > 1 ? 's' : ''}`,
            postbackText: dateStr,
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
        if (input === 'req_airport') {
          return { valid: true, data: { _request_type: 'airport' } };
        }
        if (input === 'req_early') {
          return { valid: true, data: { special_requests: 'Early check-in requested' } };
        }
        if (input === 'req_none') {
          return { valid: true, data: { special_requests: '' } };
        }
        // Free text request
        return { valid: true, data: { special_requests: input.trim() } };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._request_type === 'airport') return 'airport_pickup_time';
        return 'reservation_confirmation';
      },
    },

    // ── Step 5a: Airport Pickup — Arrival Time ──
    {
      id: 'airport_pickup_time',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: '✈️ *Airport Pickup*\n\nWhat time does your flight arrive?\n\ne.g. *2:30 PM* or *14:30*' }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.trim();
        if (text.length < 3) return { valid: false, errorMessage: 'Please enter your arrival time, e.g. 2:30 PM' };
        return { valid: true, data: { _airport_arrival_time: text } };
      },
      async next() { return 'airport_pickup_passengers'; },
    },

    // ── Step 5b: Airport Pickup — Passengers ──
    {
      id: 'airport_pickup_passengers',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: 'How many passengers need pickup?',
          buttons: [
            { id: '1', title: '1 passenger' },
            { id: '2', title: '2 passengers' },
            { id: '3', title: '3+ passengers' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const num = parseInt(input, 10);
        if (num && num > 0) return { valid: true, data: { _airport_passengers: num } };
        return { valid: false, errorMessage: 'Please select or type the number of passengers.' };
      },
      async next() { return 'airport_pickup_flight'; },
    },

    // ── Step 5c: Airport Pickup — Flight Number (optional) ──
    {
      id: 'airport_pickup_flight',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: 'Do you have a flight number? (helps us track your arrival)',
          buttons: [
            { id: 'flight_skip', title: 'Skip' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const d = ctx.session.session_data;
        const arrivalTime = d._airport_arrival_time as string;
        const passengers = d._airport_passengers as number;

        let flightNumber = '';
        if (input !== 'flight_skip' && input.toLowerCase() !== 'skip') {
          flightNumber = input.trim().toUpperCase();
        }

        // Build structured special request
        const lines = [
          '✈️ AIRPORT PICKUP',
          `Arrival: ${arrivalTime}`,
          `Passengers: ${passengers}`,
        ];
        if (flightNumber) lines.push(`Flight: ${flightNumber}`);

        return { valid: true, data: { special_requests: lines.join('\n'), _airport_flight: flightNumber || null } };
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
        await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(summary) });
        return [
          {
            type: 'buttons',
            body: 'Confirm this reservation?',
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
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('Reservation cancelled. Send *Hi* to start over.') });
          return null;
        }
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
          return [{ type: 'text', text: "We couldn't create your account. Send *Hi* to start over." }];
        }

        const nights = d.nights as number;
        const nightlyRate = d.nightly_rate as number;
        const totalAmount = nights * nightlyRate;
        const depositAmount = (d.service_deposit as number) || 0;
        const payableAmount = depositAmount > 0 ? depositAmount : totalAmount;

        // Check availability FIRST — before T&C, so user doesn't accept terms for unavailable dates
        const propertyId = (d.property_id as string) || null;
        if (propertyId && !d._availability_checked) {
          const { data: overlapping } = await ctx.supabase
            .from('reservations')
            .select('id')
            .eq('business_id', ctx.business!.id)
            .or(`property_id.eq.${sanitizeFilterValue(propertyId)},service_id.eq.${sanitizeFilterValue(propertyId)}`)
            .in('status', ['pending', 'confirmed'])
            .lt('check_in', d.check_out as string)
            .gt('check_out', d.check_in as string)
            .limit(1);

          if (overlapping && overlapping.length > 0) {
            await ctx.supabase.from('bot_sessions')
              .update({ current_step: 'complete', is_active: false })
              .eq('id', ctx.session.id);
            return [{
              type: 'text',
              text: 'Sorry, this property is not available for the selected dates. Send *Hi* to try different dates.',
            }];
          }
          d._availability_checked = true;
        }

        // ── T&C cancel check (before gate) ──
        if (d._terms_cancelled) {
          await ctx.supabase.from('bot_sessions')
            .update({ current_step: 'complete', is_active: false })
            .eq('id', ctx.session.id);
          return [{ type: 'text', text: 'No problem! Your reservation has been cancelled. Send *Hi* to start over.' }];
        }

        // ── T&C gate ──
        if (!d._terms_accepted && payableAmount > 0 && ctx.business?.metadata?.require_terms_before_payment !== false) {
          await ctx.supabase.from('bot_sessions')
            .update({ session_data: d })
            .eq('id', ctx.session.id);
          { const meta = (ctx.business?.metadata || {}) as Record<string, unknown>; return getTermsPrompt(ctx.business?.name || 'Business', meta.terms_text as string | undefined, ctx.business?.slug, meta.terms_url as string | undefined); }
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
          return [{ type: 'text', text: 'Sorry, something went wrong. Send *Hi* to start over.' }];
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
            gatewayOverride: ctx.business?.payment_gateway || null,
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
                  `⚠️ Your confirmation will arrive automatically after payment.`,
                ].join('\n'),
              },
              {
                type: 'buttons',
                body: "Paid already? Tap below to confirm:",
                buttons: [
                  { id: 'i_paid', title: "I've Paid" },
                  { id: 'go_back', title: 'Cancel' },
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

        // Create notification + notify owner via email/WhatsApp
        if (ctx.business) {
          await createNotification(ctx.supabase, {
            businessId: ctx.business.id,
            bookingId: reservation.id,
            type: 'booking_confirmation',
            channel: 'whatsapp',
            body: `Reservation at ${ctx.business.name}: ${d.service_name} from ${checkInLabel} to ${checkOutLabel} (${nights} nights). Ref: ${reservation.reference_code}`,
          });

          notifyOwnerNewBooking({
            supabase: ctx.supabase,
            sender: ctx.sender,
            businessId: ctx.business.id,
            businessName: ctx.business.name,
            countryCode: cc,
            referenceCode: reservation.reference_code,
            customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
            date: checkInLabel,
            time: `→ ${checkOutLabel}`,
            quantity: (d.guests as number) || 1,
            quantityLabel: 'guest(s)',
            amount: payableAmount > 0 ? payableAmount : undefined,
          }).catch(err => console.error('[RESERVATION] Notify error:', err));

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

        const resCalLinks = getCalendarLinksText({
          businessName: ctx.business?.name || 'Business',
          businessAddress: undefined,
          serviceName: (d.service_name as string) || 'Reservation',
          referenceCode: reservation.reference_code,
          date: d.check_in as string,
          time: '14:00', // Default check-in time
          durationMinutes: 120,
        });

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
            'See you soon!',
            resCalLinks ? resCalLinks : null,
            '',
            '💡 *What you can do:*',
            '• Type *my bookings* to view your reservations',
            '• Type *reschedule* to change dates',
            '• Type *cancel* to cancel this reservation',
            '• Type *receipt* to get your receipt',
          ].filter(Boolean).join('\n'),
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
          body: "Please complete your payment using the link sent above.\n\nYour confirmation will arrive automatically after payment.",
          buttons: [
            { id: 'i_paid', title: "I've Paid" },
            { id: 'go_back', title: 'Cancel' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const text = input.toLowerCase();

        if ((text === 'cancel' || text === 'go_back')) {
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

            // Check if webhook already confirmed this reservation (avoid double-processing)
            const { data: currentReservation } = await ctx.supabase
              .from('reservations')
              .select('status, deposit_status')
              .eq('id', d.reservation_id as string)
              .single();

            if (currentReservation?.deposit_status === 'paid') {
              const dedupCheckInLabel = new Date((d.check_in as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
                weekday: 'short', day: 'numeric', month: 'short',
              });
              const dedupCheckOutLabel = new Date((d.check_out as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
                weekday: 'short', day: 'numeric', month: 'short',
              });
              const dedupResCalLinks = getCalendarLinksText({
                businessName: ctx.business?.name || 'Business',
                businessAddress: undefined,
                serviceName: (d.service_name as string) || 'Reservation',
                referenceCode: d.reference_code as string,
                date: d.check_in as string,
                time: '14:00',
                durationMinutes: 120,
              });
              await ctx.sender.sendText({
                to: ctx.from,
                text: await ctx.t([
                  `✅ *Payment Confirmed!*`,
                  '',
                  `Your reservation at *${ctx.business?.name}* is fully confirmed.`,
                  `🏠 ${d.service_name}`,
                  `📅 ${dedupCheckInLabel} → ${dedupCheckOutLabel}`,
                  `🌙 ${d.nights} nights`,
                  `👥 ${d.guests} guest${(d.guests as number) > 1 ? 's' : ''}`,
                  `💰 ${formatCurrency(d.payable_amount as number, cc)}`,
                  `🔑 Ref: *${d.reference_code as string}*`,
                  '',
                  'See you soon!',
                  dedupResCalLinks ? dedupResCalLinks : null,
                  '',
                  '💡 *What you can do:*',
                  '• Type *my bookings* to view your reservation',
                  '• Type *receipt* to get your receipt',
                  '• Type *Hi* to make another booking',
                ].filter(Boolean).join('\n')),
              });
              return { valid: true, data: { _action: 'already_confirmed' } };
            }

            // Record platform fee after confirmed payment (fee on full total, not just deposit)
            if (ctx.business) {
              const isInTrial = (ctx.business.subscription_tier === 'free') && new Date(ctx.business.trial_ends_at) > new Date();
              await recordPlatformFee(ctx.supabase, {
                businessId: ctx.business.id,
                reservationId: d.reservation_id as string,
                transactionAmount: d.total_amount as number,
                tier: ctx.business.subscription_tier as SubscriptionTier,
                isInTrial,
              });
            }
            const checkInLabel = new Date((d.check_in as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
              weekday: 'short', day: 'numeric', month: 'short',
            });
            const checkOutLabel = new Date((d.check_out as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
              weekday: 'short', day: 'numeric', month: 'short',
            });

            const resPayCalLinks = getCalendarLinksText({
              businessName: ctx.business?.name || 'Business',
              businessAddress: undefined,
              serviceName: (d.service_name as string) || 'Reservation',
              referenceCode: d.reference_code as string,
              date: d.check_in as string,
              time: '14:00',
              durationMinutes: 120,
            });

            await ctx.sender.sendText({
              to: ctx.from,
              text: await ctx.t([
                `✅ *Payment Confirmed!*`,
                '',
                `Your reservation at *${ctx.business?.name}* is fully confirmed.`,
                `🏠 ${d.service_name}`,
                `📅 ${checkInLabel} → ${checkOutLabel}`,
                `🌙 ${d.nights} nights`,
                `👥 ${d.guests} guest${(d.guests as number) > 1 ? 's' : ''}`,
                `🔑 Ref: *${d.reference_code as string}*`,
                '',
                'See you soon!',
                resPayCalLinks ? resPayCalLinks : null,
              ].filter(Boolean).join('\n')),
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

              // Notify owner: email + WhatsApp + in-app notification
              notifyOwnerNewBooking({
                supabase: ctx.supabase,
                sender: ctx.sender,
                businessId: ctx.business.id,
                businessName: ctx.business.name,
                countryCode: (ctx.business.country_code || 'NG') as CountryCode,
                referenceCode: d.reference_code as string,
                customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
                date: checkInLabel,
                time: `→ ${checkOutLabel}`,
                quantity: (d.guests as number) || 1,
                quantityLabel: 'guest(s)',
                amount: d.payable_amount as number,
              }).catch(err => console.error('[RESERVATION] Notify error:', err));

              createNotification(ctx.supabase, {
                businessId: ctx.business.id,
                bookingId: d.reservation_id as string,
                type: 'booking_confirmation',
                channel: 'whatsapp',
                body: `Reservation confirmed (paid): ${d.service_name} from ${checkInLabel} to ${checkOutLabel} (${d.nights} nights). Ref: ${d.reference_code}`,
              }).catch(err => console.error('[RESERVATION] Notification error:', err));
            }

            return { valid: true, data: { _action: 'payment_confirmed' } };
          }

          return { valid: false, errorMessage: "Payment not yet received. The link may have expired — tap *Get New Link* for a fresh one." };
        }

        return { valid: false, errorMessage: "Tap *I've Paid* after completing payment, or *Cancel* to cancel." };
      },
      async next() {
        return null;
      },
    },
  ],
};
