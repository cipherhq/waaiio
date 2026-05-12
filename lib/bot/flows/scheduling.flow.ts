import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { BOOKING_DEFAULTS, generateTimeSlots, formatCurrency, getLocale, getMaxQuantity, getCurrencyCode, type CountryCode } from '@/lib/constants';
import { getCategoryLabels } from '@/lib/categoryConfig';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { getSavedPaymentMethod, chargeSavedCard } from '@/lib/payments/charge-saved';
import { createNotification } from './shared/notifications';
import { getConfirmationMessage } from './shared/templates';
import { handlePostCompletion } from './shared/post-completion';
import { getTermsPrompt } from './shared/terms';
import { notifyOwnerNewBooking } from './shared/notify-owner';
import { evaluateRules } from '@/lib/bot/automation/rules-engine';
import { triggerSequences } from '@/lib/bot/automation/sequence-service';
import type { SubscriptionTier } from '@/lib/constants';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import type { BusinessCategoryKey } from '@/lib/constants';

/** Category-aware date prompt */
function getDatePrompt(category: string): string {
  switch (category) {
    case 'event_services':
    case 'photographer':
    case 'catering':
      return 'When is your event?';
    case 'restaurant':
      return 'When would you like to dine?';
    case 'hotel':
    case 'shortlet':
      return 'When would you like to check in?';
    case 'laundry':
      return 'When should we pick up?';
    case 'car_wash':
    case 'car_park':
      return 'When would you like to come in?';
    case 'church':
    case 'mosque':
      return 'When would you like your appointment?';
    default:
      return 'When would you like to book?';
  }
}

/** Category-aware staff prompt */
function getStaffPrompt(category: string): string {
  switch (category) {
    case 'barber':
    case 'salon':
    case 'spa':
    case 'tattoo':
      return 'Who would you like to see?';
    case 'clinic':
    case 'dental':
    case 'veterinary':
      return 'Which doctor/specialist?';
    case 'gym':
    case 'tutor':
      return 'Which instructor?';
    default:
      return 'Which staff member do you prefer?';
  }
}

/** Category-specific quick-reply buttons for special requests */
function getSpecialRequestButtons(category: string): Array<{ id: string; title: string }> {
  switch (category as BusinessCategoryKey) {
    case 'restaurant':
      return [
        { id: 'req_birthday', title: 'Birthday 🎂' },
        { id: 'req_window', title: 'Window seat' },
      ];
    case 'barber':
      return [
        { id: 'req_fade', title: 'Fade / Taper' },
        { id: 'req_lineup', title: 'Line-up' },
      ];
    case 'spa':
      return [
        { id: 'req_deep_tissue', title: 'Deep tissue' },
        { id: 'req_aroma', title: 'Aromatherapy' },
      ];
    case 'salon':
      return [
        { id: 'req_gentle', title: 'Sensitive scalp' },
        { id: 'req_kids', title: 'Kids haircut' },
      ];
    case 'clinic':
    case 'veterinary':
      return [
        { id: 'req_morning', title: 'Morning slot' },
        { id: 'req_followup', title: 'Follow-up visit' },
      ];
    case 'gym':
      return [
        { id: 'req_morning', title: 'Morning slot' },
        { id: 'req_quiet', title: 'Quiet area' },
      ];
    case 'hotel':
      return [
        { id: 'req_quiet', title: 'Quiet room' },
        { id: 'req_highchair', title: 'High chair' },
      ];
    case 'tattoo':
      return [
        { id: 'req_gentle', title: 'First timer' },
        { id: 'req_followup', title: 'Touch-up' },
      ];
    default:
      return [
        { id: 'req_birthday', title: 'Birthday 🎂' },
        { id: 'req_urgent', title: 'Urgent' },
      ];
  }
}

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
          .select('id, name, price, duration_minutes, max_capacity, auto_approve, billing_type, recurring_interval, available_days, available_from, available_to, requires_staff, staff_ids, allow_staff_selection')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .neq('service_type', 'giving')
          .is('deleted_at', null)
          .order('sort_order');

        if (!services || services.length === 0) {
          return [];
        }

        if (services.length === 1) {
          return [];
        }

        const labels = getCategoryLabels(ctx.business.category);
        return [{
          type: 'list',
          title: 'Select Service',
          body: `What would you like to ${labels.actionVerb.toLowerCase()}?`,
          buttonLabel: 'Choose',
          items: services.map(s => {
            const cc = (ctx.business?.country_code || 'NG') as CountryCode;
            let desc = '';
            if (s.price > 0) {
              const priceStr = formatCurrency(s.price, cc);
              if (s.billing_type === 'recurring' && s.recurring_interval) {
                const suffix = s.recurring_interval === 'weekly' ? '/week' : '/month';
                desc = `${priceStr}${suffix}`;
              } else {
                desc = priceStr;
              }
              if (s.duration_minutes) desc += ` \u2022 ${s.duration_minutes}min`;
            } else if (s.duration_minutes) {
              desc = `${s.duration_minutes}min`;
            }
            return { title: s.name.slice(0, 24), description: desc, postbackText: s.id };
          }),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        // Try exact ID match first (from list postback)
        const { data: service } = await ctx.supabase
          .from('services')
          .select('id, name, price, duration_minutes, deposit_amount, billing_type, recurring_interval, available_days, available_from, available_to, requires_staff, staff_ids, allow_staff_selection')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .maybeSingle();

        // Fallback: fuzzy match by name (user typed service name or partial match)
        let matched = service;
        if (!matched) {
          const { data: allServices } = await ctx.supabase
            .from('services')
            .select('id, name, price, duration_minutes, deposit_amount, billing_type, recurring_interval, available_days, available_from, available_to, requires_staff, staff_ids, allow_staff_selection')
            .eq('business_id', ctx.business!.id)
            .eq('is_active', true)
            .neq('service_type', 'giving')
            .is('deleted_at', null);

          if (allServices && allServices.length > 0) {
            const norm = input.toLowerCase().trim();
            // Exact name match
            matched = allServices.find(s => s.name.toLowerCase() === norm) || null;
            // Partial match (input contains service name or vice versa)
            if (!matched) {
              matched = allServices.find(s =>
                norm.includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(norm)
              ) || null;
            }
            // Numbered selection (user types "1", "2", etc.)
            if (!matched && /^\d+$/.test(norm)) {
              const idx = parseInt(norm, 10) - 1;
              if (idx >= 0 && idx < allServices.length) matched = allServices[idx];
            }
          }
        }

        if (!matched) return { valid: false, errorMessage: 'Please select a valid service from the list.' };

        return {
          valid: true,
          data: {
            service_id: matched.id,
            service_name: matched.name,
            service_price: matched.price,
            service_duration: matched.duration_minutes,
            service_deposit: matched.deposit_amount,
            service_billing_type: matched.billing_type || 'one_time',
            service_recurring_interval: matched.recurring_interval || null,
            _service_available_days: (matched as Record<string, unknown>).available_days || [],
            _service_available_from: (matched as Record<string, unknown>).available_from || null,
            _service_available_to: (matched as Record<string, unknown>).available_to || null,
            _service_max_capacity: (matched as Record<string, unknown>).max_capacity || 1,
            _auto_approve: (matched as Record<string, unknown>).auto_approve !== false,
            _service_requires_staff: (matched as Record<string, unknown>).requires_staff || false,
            _service_staff_ids: (matched as Record<string, unknown>).staff_ids || [],
            _service_allow_staff_selection: (matched as Record<string, unknown>).allow_staff_selection || false,
          },
        };
      },
      async next() { return 'select_date'; },
      async skipIf(ctx: FlowContext) {
        if (ctx.session.session_data.skip_service) return true;
        if (!ctx.business) return true;

        const { data: services } = await ctx.supabase
          .from('services')
          .select('id, name, price, duration_minutes, max_capacity, auto_approve, deposit_amount, billing_type, recurring_interval, available_days, available_from, available_to, requires_staff, staff_ids, allow_staff_selection')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .neq('service_type', 'giving')
          .is('deleted_at', null)
          .order('sort_order');

        if (!services || services.length === 0) {
          ctx.session.session_data.skip_service = true;
          return true;
        }

        if (services.length === 1) {
          const s = services[0];
          ctx.session.session_data.service_id = s.id;
          ctx.session.session_data.service_name = s.name;
          ctx.session.session_data.service_price = s.price;
          ctx.session.session_data.service_duration = s.duration_minutes;
          ctx.session.session_data.service_deposit = s.deposit_amount;
          ctx.session.session_data.service_billing_type = s.billing_type || 'one_time';
          ctx.session.session_data.service_recurring_interval = s.recurring_interval || null;
          ctx.session.session_data._service_available_days = s.available_days || [];
          ctx.session.session_data._service_available_from = s.available_from || null;
          ctx.session.session_data._service_available_to = s.available_to || null;
          ctx.session.session_data._service_max_capacity = s.max_capacity || 1;
          ctx.session.session_data._auto_approve = s.auto_approve !== false;
          ctx.session.session_data._service_requires_staff = s.requires_staff || false;
          ctx.session.session_data._service_staff_ids = s.staff_ids || [];
          ctx.session.session_data._service_allow_staff_selection = s.allow_staff_selection || false;
          ctx.session.session_data.skip_service = true;
          return true;
        }

        return false;
      },
    },

    // ── Select Staff ──
    {
      id: 'select_staff',
      async skipIf(ctx: FlowContext) {
        if (!ctx.business) return true;
        const d = ctx.session.session_data;

        // If service explicitly says no staff needed, skip
        if (d._service_requires_staff === false) return true;

        // Skip if staff capability not enabled and service doesn't require staff
        const caps = await getEnabledCapabilities(ctx.supabase, ctx.business.id);
        if (!caps.includes('staff') && !d._service_requires_staff) return true;

        // Get staff — prefer service-level staff_ids, fall back to all active staff
        const serviceStaffIds = d._service_staff_ids as string[] | undefined;
        let staff: Array<{ id: string; name: string; schedule: Record<string, unknown> }>;

        if (serviceStaffIds && serviceStaffIds.length > 0) {
          const { data } = await ctx.supabase
            .from('business_staff')
            .select('id, name, schedule')
            .in('id', serviceStaffIds)
            .eq('is_active', true);
          staff = data || [];
        } else {
          const { data } = await ctx.supabase
            .from('business_staff')
            .select('id, name, schedule, services')
            .eq('business_id', ctx.business.id)
            .eq('is_active', true);
          // Filter by service name match (legacy behavior)
          let all = data || [];
          const serviceName = d.service_name as string | undefined;
          if (serviceName && all.length > 0) {
            const matched = all.filter(s => {
              const svcs = (s as unknown as { services: string[] }).services;
              return !svcs || svcs.length === 0 || svcs.includes(serviceName);
            });
            if (matched.length > 0) all = matched;
          }
          staff = all;
        }

        if (staff.length === 0) return true;

        // Filter by staff schedule — only show staff who work on the selected date
        const selectedDate = d.date as string | undefined;
        if (selectedDate) {
          const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
          const dayOfWeek = dayNames[new Date(selectedDate + 'T00:00').getDay()];
          staff = staff.filter(s => {
            if (!s.schedule || Object.keys(s.schedule).length === 0) return true; // No schedule = always available
            const daySchedule = s.schedule[dayOfWeek] as { start?: string; end?: string } | undefined;
            return daySchedule && daySchedule.start; // Has a start time for this day
          });
        }

        if (staff.length === 0) return true;

        // Auto-assign if only 1 staff or customer selection disabled
        const allowSelection = d._service_allow_staff_selection as boolean | undefined;
        if (staff.length === 1 || allowSelection === false) {
          let assigned = staff[0];
          // Pick least-busy staff (fewest bookings today)
          if (staff.length > 1) {
            const selectedDate = d.date as string;
            const counts = await Promise.all(staff.map(async s => {
              const { count } = await ctx.supabase
                .from('bookings')
                .select('id', { count: 'exact', head: true })
                .eq('business_id', ctx.business!.id)
                .eq('staff_id', s.id)
                .eq('date', selectedDate)
                .in('status', ['confirmed', 'pending', 'in_progress']);
              return { staff: s, bookings: count || 0 };
            }));
            counts.sort((a, b) => a.bookings - b.bookings);
            assigned = counts[0].staff;
          }
          ctx.session.session_data.staff_id = assigned.id;
          ctx.session.session_data.staff_name = assigned.name;
          return true;
        }

        ctx.session.session_data._available_staff = staff.map(s => ({ id: s.id, name: s.name }));
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
          body: getStaffPrompt(ctx.business?.category || 'other'),
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
      async next() { return 'select_time'; },
    },

    // ── Select Date ──
    {
      id: 'select_date',
      async skipIf(ctx: FlowContext) {
        // Skip if smart intent already extracted a date
        return !!ctx.session.session_data.date;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const messages: PromptMessage[] = [];

        // Send gallery images (max 3) if not already sent
        if (!ctx.session.session_data._gallery_sent) {
          const serviceId = ctx.session.session_data.service_id as string | undefined;
          if (serviceId) {
            const { data: svc } = await ctx.supabase
              .from('services')
              .select('gallery_urls')
              .eq('id', serviceId)
              .maybeSingle();
            const urls = (svc?.gallery_urls as string[]) || [];
            for (const url of urls.slice(0, 3)) {
              messages.push({ type: 'image' as const, imageUrl: url, caption: undefined });
            }
            ctx.session.session_data._gallery_sent = true;
          }
        }

        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const dateRange = (meta.date_range_days as number) || 7;
        const maxAdvanceDays = (meta.max_advance_days as number) || 30;
        const availableDays = (ctx.session.session_data._service_available_days as string[]) || [];
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const dates: Array<{ title: string; postbackText: string }> = [];

        // Scan up to maxAdvanceDays but collect max 10 matching dates
        for (let i = 1; i <= maxAdvanceDays && dates.length < 10; i++) {
          const d = new Date();
          d.setDate(d.getDate() + i);
          const dayOfWeek = dayNames[d.getDay()];

          // Filter by service available days
          if (availableDays.length > 0 && !availableDays.includes(dayOfWeek)) continue;

          // Filter by business operating hours (skip closed days)
          const opHours = (ctx.business?.operating_hours || {}) as Record<string, { closed?: boolean }>;
          if (opHours[dayOfWeek]?.closed) continue;

          const label = d.toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { weekday: 'short', day: 'numeric', month: 'short' });
          dates.push({ title: label, postbackText: d.toISOString().split('T')[0] });
        }

        if (dates.length === 0) {
          // Offer waitlist if capability enabled
          const caps = (ctx.session.session_data.capabilities as string[]) || [];
          if (caps.includes('waitlist')) {
            return [...messages, {
              type: 'buttons' as const,
              body: 'Sorry, there are no available dates right now. Would you like to join the waitlist? We\'ll notify you when a spot opens up.',
              buttons: [
                { id: 'wl_join', title: 'Join Waitlist' },
                { id: 'wl_skip', title: 'No Thanks' },
              ],
            }];
          }
          return [...messages, { type: 'text', text: 'Sorry, there are no available dates for this service right now. Please try again later or send *cancel* to exit.' }];
        }

        messages.push({
          type: 'list',
          title: 'Select Date',
          body: getDatePrompt(ctx.business?.category || 'other'),
          buttonLabel: 'Choose Date',
          items: dates,
        });
        return messages;
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        // Handle waitlist join from "no dates" prompt
        if (input === 'wl_join') {
          return { valid: true, data: { _join_waitlist: true } };
        }
        if (input === 'wl_skip') {
          return { valid: true, data: { _action: 'cancel' } };
        }

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

        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const maxAdvanceDays = (meta.max_advance_days as number) || BOOKING_DEFAULTS.maxAdvanceDays;
        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + maxAdvanceDays);
        if (selected > maxDate) return { valid: false, errorMessage: `Bookings can only be made up to ${maxAdvanceDays} days in advance.` };

        ctx.intelligence.resetAbuse(ctx.from);
        return { valid: true, data: { date: dateStr } };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._join_waitlist) return 'waitlist_join';
        if (ctx.session.session_data._action === 'cancel') return null;
        return 'select_staff';
      },
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

        // Read hours: service-level override > staff schedule > business operating hours
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const selectedDay = dayNames[new Date(dateStr + 'T00:00').getDay()];
        const opHours = (ctx.business?.operating_hours || {}) as Record<string, { open?: string; close?: string; closed?: boolean }>;
        const dayHours = opHours[selectedDay];

        const serviceFrom = ctx.session.session_data._service_available_from as string | null;
        const serviceTo = ctx.session.session_data._service_available_to as string | null;

        const openTime = serviceFrom || (dayHours && !dayHours.closed && dayHours.open ? dayHours.open : '08:00');
        const closeTime = serviceTo || (dayHours && !dayHours.closed && dayHours.close ? dayHours.close : '22:00');

        // Use service duration or business metadata for slot interval (default 60)
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const serviceDuration = ctx.session.session_data.service_duration as number | undefined;
        const slotInterval = (meta.slot_interval_minutes as number) || serviceDuration || 60;

        let allSlots = generateTimeSlots(openTime, closeTime, slotInterval);

        // Filter by time preference if smart intent set one
        const pref = ctx.session.session_data._time_preference as string | undefined;
        if (pref === 'morning') {
          allSlots = generateTimeSlots(openTime, '12:00', slotInterval);
        } else if (pref === 'afternoon') {
          allSlots = generateTimeSlots('12:00', '17:00', slotInterval);
        } else if (pref === 'evening') {
          allSlots = generateTimeSlots('17:00', closeTime, slotInterval);
        }

        // ── Availability check: remove fully booked slots ──
        const staffId = ctx.session.session_data.staff_id as string | null;
        const maxCapacity = (ctx.session.session_data._service_max_capacity as number) || 1;

        // Fetch existing bookings for this date
        let bookingsQuery = ctx.supabase
          .from('bookings')
          .select('time, staff_id')
          .eq('business_id', ctx.business!.id)
          .eq('date', dateStr)
          .in('status', ['confirmed', 'pending', 'in_progress']);

        if (staffId) {
          bookingsQuery = bookingsQuery.eq('staff_id', staffId);
        }

        const { data: existingBookings } = await bookingsQuery;

        // Count bookings per time slot
        const slotCounts = new Map<string, number>();
        for (const b of existingBookings || []) {
          if (b.time) {
            const t = b.time.slice(0, 5); // normalize to HH:MM
            slotCounts.set(t, (slotCounts.get(t) || 0) + 1);
          }
        }

        // Filter out fully booked slots and add availability info
        const availableSlots = allSlots
          .map(t => {
            const booked = slotCounts.get(t) || 0;
            const remaining = maxCapacity - booked;
            return { time: t, remaining };
          })
          .filter(s => s.remaining > 0);

        if (availableSlots.length === 0) {
          return [{
            type: 'text',
            text: `Sorry, all time slots for ${dateLabel} are fully booked. Please go back and choose a different date.\n\nSend *Hi* to start over.`,
          }];
        }

        const prefLabel = pref ? ` ${pref}` : '';
        // WhatsApp list messages support max 10 items per section
        const displaySlots = availableSlots.slice(0, 10);
        return [{
          type: 'list',
          title: 'Select Time',
          body: `Available${prefLabel} times for ${dateLabel}:`,
          buttonLabel: 'Choose Time',
          items: displaySlots.map(s => ({
            title: s.time,
            description: maxCapacity > 1 ? `${s.remaining} spot${s.remaining !== 1 ? 's' : ''} left` : undefined,
            postbackText: s.time,
          })),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(input);
        if (!timeMatch) {
          const abuse = ctx.intelligence.recordGibberish(ctx.from);
          return { valid: false, errorMessage: abuse.warn ? abuse.message : "Please tap one of the time options." };
        }

        // Double-check slot availability (prevent race condition)
        const dateStr = ctx.session.session_data.date as string;
        const staffId = ctx.session.session_data.staff_id as string | null;
        const maxCapacity = (ctx.session.session_data._service_max_capacity as number) || 1;

        let checkQuery = ctx.supabase
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', ctx.business!.id)
          .eq('date', dateStr)
          .eq('time', input)
          .in('status', ['confirmed', 'pending', 'in_progress']);

        if (staffId) checkQuery = checkQuery.eq('staff_id', staffId);

        const { count } = await checkQuery;
        if ((count || 0) >= maxCapacity) {
          return { valid: false, errorMessage: 'Sorry, this time slot just got booked. Please choose another time.' };
        }

        ctx.intelligence.resetAbuse(ctx.from);
        return { valid: true, data: { time: input } };
      },
      async next() { return 'select_addons'; },
    },

    // ── Select Add-ons ──
    {
      id: 'select_addons',
      async skipIf(ctx: FlowContext) {
        if (!ctx.business) return true;
        const serviceId = ctx.session.session_data.service_id as string | undefined;
        const { data: addons } = await ctx.supabase
          .from('service_addons')
          .select('id, name, price, is_required')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .or(serviceId ? `service_id.eq.${serviceId},service_id.is.null` : 'service_id.is.null')
          .order('sort_order');
        if (!addons || addons.length === 0) return true;
        ctx.session.session_data._available_addons = addons;
        // Auto-select required add-ons
        const required = addons.filter(a => a.is_required);
        if (required.length > 0) {
          ctx.session.session_data._selected_addons = required.map(a => ({ id: a.id, name: a.name, price: a.price }));
        }
        // If all are required, skip the step
        if (required.length === addons.length) return true;
        return false;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const addons = ctx.session.session_data._available_addons as Array<{ id: string; name: string; price: number; is_required: boolean }>;
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const optional = addons.filter(a => !a.is_required);
        const items = optional.map(a => ({
          title: `${a.name} — ${formatCurrency(a.price, cc)}`,
          postbackText: a.id,
        }));
        items.push({ title: 'No add-ons', postbackText: 'skip_addons' });
        return [{
          type: 'list',
          title: 'Add-ons',
          body: 'Would you like to add any extras?',
          buttonLabel: 'View Add-ons',
          items,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input === 'skip_addons') return { valid: true };
        const addons = ctx.session.session_data._available_addons as Array<{ id: string; name: string; price: number }>;
        const found = addons?.find(a => a.id === input);
        if (!found) return { valid: false, errorMessage: 'Please select an add-on or tap *No add-ons*.' };
        const existing = (ctx.session.session_data._selected_addons as Array<{ id: string; name: string; price: number }>) || [];
        if (!existing.find(a => a.id === found.id)) {
          ctx.session.session_data._selected_addons = [...existing, { id: found.id, name: found.name, price: found.price }];
        }
        return { valid: true };
      },
      async next() { return 'apply_promo'; },
    },

    // ── Apply Promo Code ──
    {
      id: 'apply_promo',
      async skipIf(ctx: FlowContext) {
        if (!ctx.business) return true;
        // Skip if service is free (no point asking for promo code)
        const price = ctx.session.session_data.service_price as number || 0;
        if (price <= 0) return true;
        // Skip if no active promo codes exist for this business
        const { count } = await ctx.supabase
          .from('promo_codes')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', ctx.business.id)
          .eq('is_active', true);
        return (count || 0) === 0;
      },
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: 'Do you have a promo code?',
          buttons: [
            { id: 'promo_yes', title: 'Yes, enter code' },
            { id: 'promo_no', title: 'No' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input === 'promo_no' || input.toLowerCase() === 'no' || input.toLowerCase() === 'skip') {
          return { valid: true };
        }
        if (input === 'promo_yes') {
          return { valid: true, data: { _promo_entering: true } };
        }
        // User typed a code directly
        const code = input.toUpperCase().trim();
        if (code.length < 3) return { valid: false, errorMessage: 'Please enter a valid promo code (min 3 characters).' };

        const { data: promo } = await ctx.supabase
          .from('promo_codes')
          .select('*')
          .eq('business_id', ctx.business!.id)
          .eq('code', code)
          .eq('is_active', true)
          .maybeSingle();

        if (!promo) return { valid: false, errorMessage: 'Invalid promo code.' };
        if (promo.max_uses && promo.current_uses >= promo.max_uses) return { valid: false, errorMessage: 'This promo code has reached its usage limit.' };
        if (promo.valid_until && new Date(promo.valid_until) < new Date()) return { valid: false, errorMessage: 'This promo code has expired.' };

        const servicePrice = (ctx.session.session_data.service_price as number) || 0;
        if (promo.min_order_amount && servicePrice < promo.min_order_amount) {
          return { valid: false, errorMessage: `Minimum amount for this code is ${formatCurrency(promo.min_order_amount, (ctx.business?.country_code || 'NG') as CountryCode)}.` };
        }

        const discount = promo.discount_type === 'percentage'
          ? Math.round(servicePrice * promo.discount_value / 100)
          : Math.min(promo.discount_value, servicePrice);

        return { valid: true, data: { _promo_code: code, _promo_id: promo.id, _promo_discount: discount } };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._promo_entering) return 'enter_promo_code';
        return 'select_quantity';
      },
    },

    // ── Enter Promo Code (text input) ──
    {
      id: 'enter_promo_code',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: 'Please type your promo code:' }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const code = input.toUpperCase().trim();
        if (code.length < 3) return { valid: false, errorMessage: 'Please enter a valid promo code.' };

        const { data: promo } = await ctx.supabase
          .from('promo_codes')
          .select('*')
          .eq('business_id', ctx.business!.id)
          .eq('code', code)
          .eq('is_active', true)
          .maybeSingle();

        if (!promo) return { valid: false, errorMessage: 'Invalid promo code. Try again or type *skip*.' };
        if (promo.max_uses && promo.current_uses >= promo.max_uses) return { valid: false, errorMessage: 'This promo code has reached its usage limit.' };
        if (promo.valid_until && new Date(promo.valid_until) < new Date()) return { valid: false, errorMessage: 'This promo code has expired.' };

        const servicePrice = (ctx.session.session_data.service_price as number) || 0;
        if (promo.min_order_amount && servicePrice < promo.min_order_amount) {
          return { valid: false, errorMessage: `Minimum amount for this code is ${formatCurrency(promo.min_order_amount, (ctx.business?.country_code || 'NG') as CountryCode)}.` };
        }

        const discount = promo.discount_type === 'percentage'
          ? Math.round(servicePrice * promo.discount_value / 100)
          : Math.min(promo.discount_value, servicePrice);

        return { valid: true, data: { _promo_code: code, _promo_id: promo.id, _promo_discount: discount } };
      },
      async next() { return 'select_quantity'; },
      async skipIf(ctx: FlowContext) {
        // Skip if user already entered a code in the previous step
        return !!ctx.session.session_data._promo_code;
      },
    },

    // ── Select Quantity ──
    {
      id: 'select_quantity',
      async skipIf(ctx: FlowContext) {
        // Skip if smart intent already extracted quantity
        return !!ctx.session.session_data.party_size;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const category = ctx.business?.category || 'restaurant';
        const labels = getCategoryLabels(category);
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const maxQty = (meta.max_party_size as number) || getMaxQuantity(category);
        // Adapt button options to sensible values per category
        const singularLabel = labels.quantityLabel === 'guests' ? 'guest' : '';
        const buttons = maxQty <= 3
          ? [
              { id: '1', title: `1 ${singularLabel}`.trim() },
              { id: '2', title: `2 ${labels.quantityLabel}` },
            ]
          : [
              { id: '1', title: `1 ${singularLabel}`.trim() },
              { id: '2', title: `2 ${labels.quantityLabel}` },
              { id: '4', title: `4 ${labels.quantityLabel}` },
            ];
        return [
          {
            type: 'buttons',
            body: `How many ${labels.quantityLabel}?`,
            buttons,
          },
          { type: 'text', text: `Or type a number (1-${maxQty}).` },
        ];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const maxQty = (meta.max_party_size as number) || getMaxQuantity(ctx.business?.category || 'restaurant');
        const size = parseInt(input, 10);
        if (isNaN(size) || size < 1 || size > maxQty) {
          return { valid: false, errorMessage: `Please enter a number between 1 and ${maxQty}.` };
        }
        ctx.intelligence.resetAbuse(ctx.from);
        return { valid: true, data: { party_size: size } };
      },
      async next() { return 'special_requests'; },
    },

    // ── Special Requests ──
    {
      id: 'special_requests',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const category = ctx.business?.category || 'restaurant';
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        // Use business-configured special requests if available, else category defaults
        const customOptions = meta.special_request_options as Array<{ id: string; title: string }> | undefined;
        const quickReplies = customOptions && customOptions.length > 0
          ? customOptions.slice(0, 2)
          : getSpecialRequestButtons(category);
        return [
          {
            type: 'buttons',
            body: 'Any special requests?',
            buttons: [
              { id: 'req_none', title: "No, I'm good" },
              ...quickReplies,
            ],
          },
          { type: 'text', text: 'Or type your own request:' },
        ];
      },
      async skipIf(ctx: FlowContext) {
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        // If business explicitly disabled special requests
        if (meta.special_requests_enabled === false) {
          ctx.session.session_data.special_requests = '';
          return true;
        }
        // If business has custom options, always show
        if ((meta.special_request_options as unknown[])?.length > 0) return false;
        // Fall back to category-based logic
        const categoriesWithRequests = new Set([
          'restaurant', 'barber', 'spa', 'salon', 'clinic', 'veterinary', 'gym', 'hotel', 'tattoo',
        ]);
        if (!categoriesWithRequests.has(ctx.business?.category || '')) {
          ctx.session.session_data.special_requests = '';
          return true;
        }
        return false;
      },
      async validate(input: string): Promise<ValidationResult> {
        const response = input.toLowerCase();
        let request: string | undefined;
        // Map all quick-reply IDs to human-readable text
        const requestMap: Record<string, string> = {
          req_birthday: 'Birthday celebration 🎂',
          req_window: 'Window seat preferred',
          req_outdoor: 'Outdoor seating preferred',
          req_fade: 'Fade / taper requested',
          req_lineup: 'Line-up / edge-up requested',
          req_hot_towel: 'Hot towel service',
          req_deep_tissue: 'Deep tissue preferred',
          req_aroma: 'Aromatherapy add-on',
          req_gentle: 'Gentle / sensitive treatment',
          req_morning: 'Morning slot preferred',
          req_urgent: 'Urgent / same-day if possible',
          req_followup: 'Follow-up visit',
          req_wheelchair: 'Wheelchair accessible',
          req_highchair: 'High chair needed',
          req_quiet: 'Quiet area preferred',
          req_kids: 'Kids haircut',
        };
        if (requestMap[response]) {
          request = requestMap[response];
        } else if (response !== 'req_none') {
          request = input;
        }

        return { valid: true, data: { special_requests: request || '' } };
      },
      async next() { return 'collect_venue'; },
    },

    // ── Collect Venue (per-service toggle) ──
    {
      id: 'collect_venue',
      async skipIf(ctx: FlowContext) {
        // Only show if service has collect_venue enabled in metadata
        const serviceId = ctx.session.session_data.service_id as string | undefined;
        if (!serviceId || !ctx.business) return true;
        const { data: svc } = await ctx.supabase
          .from('services')
          .select('metadata')
          .eq('id', serviceId)
          .maybeSingle();
        const meta = (svc?.metadata || {}) as Record<string, unknown>;
        return !meta.collect_venue;
      },
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: '📍 Where is the event/appointment?\n\nPlease type the *venue name and address*:' }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input.trim().length < 5) return { valid: false, errorMessage: 'Please enter a valid address (at least 5 characters).' };
        return { valid: true, data: { venue_address: input.trim() } };
      },
      async next() { return 'select_end_date'; },
    },

    // ── Select End Date (multi-day bookings) ──
    {
      id: 'select_end_date',
      async skipIf(ctx: FlowContext) {
        const serviceId = ctx.session.session_data.service_id as string | undefined;
        if (!serviceId || !ctx.business) return true;
        const { data: svc } = await ctx.supabase
          .from('services')
          .select('metadata')
          .eq('id', serviceId)
          .maybeSingle();
        const meta = (svc?.metadata || {}) as Record<string, unknown>;
        return !meta.multi_day;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const startDate = ctx.session.session_data.date as string;
        const locale = getLocale((ctx.business?.country_code || 'NG') as CountryCode);
        const dates: Array<{ title: string; postbackText: string }> = [];
        // Show up to 7 days after start date
        for (let i = 1; i <= 7; i++) {
          const d = new Date(startDate + 'T00:00');
          d.setDate(d.getDate() + i);
          const label = d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
          dates.push({ title: label, postbackText: d.toISOString().split('T')[0] });
        }
        dates.push({ title: 'Single day only', postbackText: 'single_day' });
        return [{
          type: 'list',
          title: 'End Date',
          body: 'When does the booking end?',
          buttonLabel: 'Choose End Date',
          items: dates,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input === 'single_day') return { valid: true };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return { valid: false, errorMessage: 'Please select an end date.' };
        const startDate = new Date((ctx.session.session_data.date as string) + 'T00:00');
        const endDate = new Date(input + 'T00:00');
        if (endDate <= startDate) return { valid: false, errorMessage: 'End date must be after start date.' };
        return { valid: true, data: { end_date: input } };
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
      async skipIf(ctx: FlowContext) {
        // Skip unless business explicitly enables book-for-other
        return !ctx.business?.metadata?.booking_allow_book_for_other;
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
        const labels = getCategoryLabels(ctx.business?.category || 'restaurant');
        const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        });

        const lines = [
          `📋 *${labels.receiptTitle} Summary*`,
          '',
          `${labels.confirmationEmoji} ${ctx.business?.name || 'Business'}`,
        ];
        if (d.service_name) lines.push(`📌 ${d.service_name as string}`);
        if (d.staff_name) lines.push(`👤 With: ${d.staff_name as string}`);
        const endDateStr = d.end_date as string | undefined;
        if (endDateStr) {
          const endLabel = new Date(endDateStr + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { weekday: 'short', day: 'numeric', month: 'short' });
          lines.push(`📅 ${dateLabel} — ${endLabel}`);
        } else {
          lines.push(`📅 ${dateLabel}`);
        }
        lines.push(`🕐 ${d.time as string}`);
        lines.push(`👥 ${d.party_size as number} ${labels.quantityLabel}`);
        // Show add-ons
        const selectedAddons = d._selected_addons as Array<{ name: string; price: number }> | undefined;
        if (selectedAddons && selectedAddons.length > 0) {
          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          lines.push(`➕ Add-ons: ${selectedAddons.map(a => `${a.name} (${formatCurrency(a.price, cc)})`).join(', ')}`);
        }
        if (d._promo_discount && d._promo_code) {
          const cc2 = (ctx.business?.country_code || 'NG') as CountryCode;
          lines.push(`🎟️ Promo (${d._promo_code}): -${formatCurrency(d._promo_discount as number, cc2)}`);
        }
        if (d.venue_address) lines.push(`📍 ${d.venue_address as string}`);
        if (d.special_requests) lines.push(`📝 ${d.special_requests as string}`);
        if (d.book_for_other && d.other_name) lines.push(`👤 For: ${d.other_name as string}`);

        // Combine summary + buttons in one message to prevent WhatsApp reordering
        return [
          {
            type: 'buttons',
            body: lines.join('\n') + '\n\nConfirm this booking?',
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
      async next() { return 'ask_referral_code'; },
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

    // ── Ask Referral Code ──
    {
      id: 'ask_referral_code',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: '🎁 Got a referral code from a friend?',
          buttons: [
            { id: 'enter_code', title: 'Enter Code' },
            { id: 'skip', title: 'Skip' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input === 'enter_code') return { valid: true, data: { _referral_action: 'enter' } };
        if (input === 'skip' || input.toLowerCase() === 'skip') return { valid: true, data: { _referral_action: 'skip' } };
        return { valid: false, errorMessage: 'Tap one of the buttons above to continue.' };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._referral_action === 'enter') return 'enter_referral_code';
        return 'collect_email';
      },
      async skipIf(ctx: FlowContext) {
        if (!ctx.business) return true;
        // Skip if service/appointment is free
        const price = ctx.session.session_data.service_price as number || 0;
        if (price <= 0) return true;
        // Skip if business doesn't have referral capability
        const caps = await getEnabledCapabilities(ctx.supabase, ctx.business.id, ctx.business.category);
        if (!caps.includes('referral')) return true;
        // Skip if user already has a converted referral for this business
        const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
        const { data: existing } = await ctx.supabase
          .from('referrals')
          .select('id')
          .eq('business_id', ctx.business.id)
          .eq('referee_phone', phone)
          .eq('status', 'converted')
          .limit(1)
          .maybeSingle();
        if (existing) return true;
        return false;
      },
    },

    // ── Enter Referral Code ──
    {
      id: 'enter_referral_code',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: '🎁 Enter your referral code below.\n\nType *skip* if you changed your mind.' }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const code = input.trim();
        if (code.toLowerCase() === 'skip') {
          return { valid: true };
        }
        if (!ctx.business) return { valid: true };

        const { data: referral } = await ctx.supabase
          .from('referrals')
          .select('id, referrer_phone')
          .eq('business_id', ctx.business.id)
          .eq('referral_code', code)
          .eq('status', 'pending')
          .maybeSingle();

        if (!referral) {
          return { valid: false, errorMessage: 'Hmm, that code didn\u2019t work. Double-check it and try again, or type *skip* to continue without one.' };
        }

        return {
          valid: true,
          data: { referral_id: referral.id, referrer_phone: referral.referrer_phone },
        };
      },
      async next() { return 'collect_email'; },
    },

    // ── Collect Email ──
    {
      id: 'collect_email',
      async prompt(): Promise<PromptMessage[]> {
        return [
          { type: 'text', text: '📧 Email for confirmation? (type *skip* to skip)' },
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

        // ── Reschedule existing booking ──
        if (d._reschedule_booking_id) {
          const rescheduleId = d._reschedule_booking_id as string;

          // Fetch current booking to preserve original date/time
          const { data: originalBooking } = await ctx.supabase
            .from('bookings')
            .select('date, time')
            .eq('id', rescheduleId)
            .single();

          const { error: rescheduleError } = await ctx.supabase
            .from('bookings')
            .update({
              date: d.date as string,
              time: d.time as string,
              party_size: (d.party_size as number) || 1,
              original_date: originalBooking?.date ?? null,
              original_time: originalBooking?.time ?? null,
              rescheduled_at: new Date().toISOString(),
            })
            .eq('id', rescheduleId);

          if (rescheduleError) {
            console.error('Failed to reschedule booking', rescheduleError);
            return [{ type: 'text', text: 'Sorry, something went wrong rescheduling. Send *my bookings* to try again.' }];
          }

          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
            weekday: 'long', day: 'numeric', month: 'long',
          });

          await ctx.supabase
            .from('bot_sessions')
            .update({ current_step: 'complete', is_active: false })
            .eq('id', ctx.session.id);

          return [{
            type: 'text',
            text: `✅ *Booking Rescheduled!*\n\n📅 ${dateLabel} at ${d.time as string}\n👥 ${(d.party_size as number) || 1} guest${((d.party_size as number) || 1) > 1 ? 's' : ''}\n\nSee you then! 🎉`,
          }];
        }

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

        // Get payment amount
        const serviceDeposit = (d.service_deposit as number) || 0;
        const servicePrice = (d.service_price as number) || 0;
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

        // Determine prepay mode: 'full' = charge full price, 'deposit_only' = only explicit deposits, 'free' = no upfront charge, 'auto' = category-based
        const bizMeta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const prepayMode = (bizMeta.prepay_mode as string) || 'auto';

        // Category-based fallback for auto mode
        const prepayCategories = new Set([
          'barber', 'spa', 'salon', 'tattoo', 'gym', 'clinic', 'dental',
          'veterinary', 'consultant', 'tutor', 'photographer', 'car_wash',
          'laundry', 'coworking',
        ]);
        const isPrepay = prepayMode === 'full' || (prepayMode === 'auto' && prepayCategories.has(ctx.business?.category || ''));

        let totalDeposit: number;
        if (prepayMode === 'free') {
          totalDeposit = 0;
        } else if (serviceDeposit > 0) {
          // Explicit deposit set on the service
          totalDeposit = serviceDeposit;
        } else if (depositPerGuest > 0) {
          // Per-guest deposit (restaurants)
          totalDeposit = depositPerGuest * partySize;
        } else if (isPrepay && servicePrice > 0) {
          // Service-based businesses: charge full service price
          totalDeposit = servicePrice * partySize;
        } else {
          totalDeposit = 0;
        }

        // ── T&C gate (before creating record) ──
        if (!d._terms_accepted && totalDeposit > 0 && ctx.business?.metadata?.require_terms_before_payment !== false) {
          d._pending_deposit = totalDeposit;
          await ctx.supabase.from('bot_sessions')
            .update({ session_data: d })
            .eq('id', ctx.session.id);
          return getTermsPrompt(ctx.business?.name || 'Business', (ctx.business?.metadata as Record<string, unknown>)?.terms_text as string | undefined);
        }
        if (d._terms_cancelled) {
          await ctx.supabase.from('bot_sessions')
            .update({ current_step: 'complete', is_active: false })
            .eq('id', ctx.session.id);
          return [{ type: 'text', text: 'No problem! Your booking has been cancelled. Send *Hi* to start over.' }];
        }

        const insertPayload: Record<string, unknown> = {
          business_id: ctx.business!.id,
          user_id: userId,
          service_id: (d.service_id as string) || null,
          staff_id: (d.staff_id as string) || null,
          staff_name: (d.staff_name as string) || null,
          date: d.date as string,
          time: d.time as string,
          party_size: partySize,
          flow_type: 'scheduling',
          channel: 'whatsapp',
          deposit_amount: totalDeposit,
          deposit_status: totalDeposit > 0 ? 'pending' : 'none',
          status: totalDeposit > 0 ? 'pending' : (d._auto_approve !== false ? 'confirmed' : 'pending'),
          special_requests: (d.special_requests as string) || null,
          venue_address: (d.venue_address as string) || null,
          end_date: (d.end_date as string) || null,
          addons_snapshot: d._selected_addons || null,
          promo_code_id: (d._promo_id as string) || null,
          guest_name: d.book_for_other ? (d.other_name as string) : `${d.first_name || ''} ${d.last_name || ''}`.trim(),
          guest_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
          guest_email: (d.email as string) || null,
          total_amount: totalDeposit,
          quantity: partySize,
        };

        // Use atomic booking function to prevent double-booking race condition
        const maxCapacity = (d._service_max_capacity as number) || 1;
        const { data: slotResult, error: slotError } = await ctx.supabase
          .rpc('book_slot_atomic' as string, {
            p_business_id: ctx.business!.id,
            p_user_id: userId,
            p_service_id: (d.service_id as string) || null,
            p_staff_id: (d.staff_id as string) || null,
            p_date: d.date as string,
            p_time: d.time as string,
            p_party_size: partySize,
            p_max_capacity: maxCapacity,
            p_flow_type: 'scheduling',
            p_deposit_amount: totalDeposit,
            p_deposit_status: totalDeposit > 0 ? 'pending' : 'none',
            p_status: totalDeposit > 0 ? 'pending' : (d._auto_approve !== false ? 'confirmed' : 'pending'),
            p_guest_name: d.book_for_other ? (d.other_name as string) : `${d.first_name || ''} ${d.last_name || ''}`.trim(),
            p_guest_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
            p_guest_email: (d.email as string) || null,
            p_special_requests: (d.special_requests as string) || null,
            p_venue_address: (d.venue_address as string) || null,
            p_end_date: (d.end_date as string) || null,
            p_addons_snapshot: d._selected_addons || null,
            p_promo_code_id: (d._promo_id as string) || null,
            p_total_amount: totalDeposit,
            p_staff_name: (d.staff_name as string) || null,
          })
          .single() as { data: { booking_id: string; reference_code: string; slot_available: boolean } | null; error: unknown };

        if (slotError || !slotResult) {
          console.error('Failed to create booking', slotError);
          return [{ type: 'text', text: 'Sorry, something went wrong. Send "Hi" to try again.' }];
        }

        if (!slotResult.slot_available) {
          return [{ type: 'text', text: 'Sorry, that slot was just taken by another customer. Send *Hi* to pick a different time.' }];
        }

        const booking = { id: slotResult.booking_id, reference_code: slotResult.reference_code };

        // Increment promo code usage if applied
        if (d._promo_id) {
          const { data: promoData } = await ctx.supabase
            .from('promo_codes')
            .select('current_uses')
            .eq('id', d._promo_id as string)
            .single();
          if (promoData) {
            await ctx.supabase
              .from('promo_codes')
              .update({ current_uses: (promoData.current_uses || 0) + 1 })
              .eq('id', d._promo_id as string);
          }
        }

        // Convert referral if applied
        if (d.referral_id) {
          const refPhone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
          await ctx.supabase
            .from('referrals')
            .update({
              status: 'converted',
              referee_phone: refPhone,
              updated_at: new Date().toISOString(),
            })
            .eq('id', d.referral_id as string);
        }

        d.booking_id = booking.id;
        d.reference_code = booking.reference_code;
        d.deposit_amount = totalDeposit;

        // ── Fire booking_created rules + sequences (non-blocking) ──
        if (ctx.business) {
          const ruleCtx = {
            customer_phone: ctx.from,
            customer_name: `${d.first_name || ''} ${d.last_name || ''}`.trim() || undefined,
            business_name: ctx.business.name,
            service_name: (d.service_name as string) || undefined,
            reference_code: booking.reference_code,
            reference_id: booking.id,
            total_amount: totalDeposit,
            date: d.date as string,
            time: d.time as string,
            party_size: d.party_size as number,
          };
          const sendMsg = async (to: string, txt: string) => {
            await ctx.sender.sendText({ to, text: txt });
          };
          evaluateRules(ctx.supabase, ctx.business.id, 'booking_created', ruleCtx, sendMsg)
            .catch(err => console.error('[SCHEDULING] booking_created rule error:', err));
          triggerSequences(ctx.supabase, ctx.business.id, 'after_booking', ctx.from, ruleCtx)
            .catch(err => console.error('[SCHEDULING] after_booking sequence error:', err));
        }

        // Reserve booking slot (overbooking prevention)
        if (ctx.business) {
          try {
            await ctx.supabase.rpc('reserve_booking_slot', {
              p_business_id: ctx.business.id,
              p_date: d.date as string,
              p_start_time: d.time as string,
              p_end_time: d.time as string, // end_time is auto-calculated
              p_staff_id: (d.staff_id as string) || null,
            });
          } catch (err) {
            console.error('[SCHEDULING] reserve_booking_slot error (non-fatal):', err);
          }
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

        const labels = getCategoryLabels(ctx.business?.category || 'restaurant');
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
          // Check for saved payment method — one-tap payment
          const savedMethod = ctx.business ? await getSavedPaymentMethod(ctx.supabase, ctx.business.id, ctx.from) : null;

          if (savedMethod && !d._skip_saved_card) {
            // Offer one-tap payment with saved card
            d._saved_method_id = savedMethod.id;
            d._pending_deposit = totalDeposit;
            d.booking_id = booking.id;
            d.reference_code = booking.reference_code;
            await ctx.supabase.from('bot_sessions')
              .update({ session_data: d, current_step: 'saved_card_prompt' })
              .eq('id', ctx.session.id);

            const cardLabel = `${(savedMethod.card_brand || 'Card').toUpperCase()} ****${savedMethod.card_last4 || '????'}`;
            return [
              {
                type: 'buttons',
                body: `💳 Pay ${formatCurrency(totalDeposit, (ctx.business?.country_code || 'NG') as CountryCode)} with your saved card?\n\n${cardLabel}`,
                buttons: [
                  { id: 'pay_saved', title: `Pay with ${savedMethod.card_last4 || 'card'}` },
                  { id: 'pay_new', title: 'Use different card' },
                  { id: 'cancel', title: 'Cancel' },
                ],
              },
            ];
          }

          // No saved card — standard payment link
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
                  `📋 *${labels.receiptTitle}!*`,
                  '',
                  `${labels.confirmationEmoji} ${ctx.business?.name}`,
                  d.staff_name ? `👤 With: ${d.staff_name as string}` : '',
                  `📅 ${dateLabel}`,
                  `🕐 ${d.time as string}`,
                  `👥 ${partySize} ${labels.quantityLabel}`,
                  `🔑 Ref: *${booking.reference_code}*`,
                  '',
                  `💳 *${isPrepay ? 'Payment' : 'Deposit'} Required: ${formatCurrency(totalDeposit, (ctx.business?.country_code || 'NG') as CountryCode)}*`,
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

          // Payment initialization failed — don't confirm without payment
          return [
            {
              type: 'buttons',
              body: 'Sorry, we couldn\'t set up payment right now. Your booking has been saved but is pending payment.',
              buttons: [
                { id: 'retry_payment', title: 'Try Again' },
                { id: 'chat_with_biz', title: 'Chat with Business' },
                { id: 'cancel', title: 'Cancel Booking' },
              ],
            },
          ];
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
          const customerName = d.book_for_other
            ? (d.other_name as string)
            : `${d.first_name || ''} ${d.last_name || ''}`.trim() || '';
          message = ctx.standalone.fillTemplate(templates.confirmation, {
            restaurant_name: ctx.business?.name || '',
            business_name: ctx.business?.name || '',
            customer_name: customerName,
            staff_name: (d.staff_name as string) || '',
            date: dateLabel,
            time: (d.time as string) || '',
            party_size: partySize,
            quantity: partySize,
            reference_code: booking.reference_code,
            service_name: (d.service_name as string) || '',
          });
          // Add staff info if not in template but staff was assigned
          if (d.staff_name && !message.includes(d.staff_name as string)) {
            message = message.replace(/(\n.*Ref:)/, `\n👤 With: ${d.staff_name as string}$1`);
          }
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

          // Notify business owner (email always, WhatsApp for dedicated numbers)
          const customerName = d.book_for_other
            ? (d.other_name as string)
            : `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Customer';
          notifyOwnerNewBooking({
            supabase: ctx.supabase,
            sender: ctx.sender,
            businessId: ctx.business.id,
            businessName: ctx.business.name,
            countryCode: (ctx.business.country_code || 'NG') as CountryCode,
            referenceCode: booking.reference_code,
            customerName,
            date: dateLabel,
            time: (d.time as string) || '',
            quantity: partySize,
            quantityLabel: labels.quantityLabel,
            amount: totalDeposit > 0 ? totalDeposit : undefined,
          }).catch(err => console.error('[SCHEDULING] Owner notification error:', err));

          // Notify assigned staff member
          if (d.staff_id) {
            import('./shared/notify-staff').then(({ notifyStaffNewBooking }) => {
              notifyStaffNewBooking({
                supabase: ctx.supabase,
                sender: ctx.sender,
                businessId: ctx.business!.id,
                businessName: ctx.business!.name,
                staffId: d.staff_id as string,
                customerName,
                serviceName: (d.service_name as string) || '',
                date: dateLabel,
                time: (d.time as string) || '',
                referenceCode: booking.reference_code,
                countryCode: (ctx.business!.country_code || 'NG') as CountryCode,
                amount: totalDeposit > 0 ? totalDeposit : undefined,
              }).catch(err => console.error('[SCHEDULING] Staff notify error:', err));
            }).catch(err => console.error('[SCHEDULING] Staff notify import error:', err));
          }

          // Post-completion: loyalty, feedback, referral, auto-receipt
          handlePostCompletion({
            supabase: ctx.supabase,
            businessId: ctx.business.id,
            customerPhone: ctx.from,
            customerName: d.book_for_other ? (d.other_name as string) : `${d.first_name || ''} ${d.last_name || ''}`.trim() || null,
            serviceType: 'booking',
            referenceId: booking.id,
            sender: ctx.sender,
            amountPaid: totalDeposit,
            serviceName: d.service_name as string,
            referenceCode: booking.reference_code,
          }).catch(err => console.error('[SCHEDULING] Post-completion error:', err));
        }

        // Add helpful tips about what customer can do next
        const tips = [
          'Type *my bookings* to view your appointments',
          'Type *reschedule* to change the date/time',
          'Type *cancel* to cancel this booking',
        ];
        if (ctx.business) {
          try {
            const { getEnabledCapabilities } = await import('@/lib/capabilities/service');
            const caps = await getEnabledCapabilities(ctx.supabase, ctx.business.id, ctx.business.category);
            if (caps.includes('loyalty')) tips.push('Type *my points* to check your loyalty balance');
            if (caps.includes('referral')) tips.push('Type *refer* to invite friends and earn rewards');
            if (caps.includes('ordering')) tips.push('Type *order* to place an order');
          } catch {}
        }
        const helpText = `\n\n💡 *What you can do:*\n${tips.map(t => `• ${t}`).join('\n')}`;

        // Sync to Google Calendar (non-blocking)
        if (ctx.business) {
          import('@/lib/integrations/google-calendar').then(({ syncBookingToCalendar }) => {
            syncBookingToCalendar(ctx.supabase, ctx.business!.id, {
              id: booking.id,
              service_name: (d.service_name as string) || 'Appointment',
              customer_name: d.book_for_other ? (d.other_name as string) : `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Customer',
              customer_phone: ctx.from,
              booking_date: (d.date as string) || '',
              booking_time: (d.time as string) || '',
              duration_minutes: d.duration_minutes as number | undefined,
              reference_code: booking.reference_code,
            }).catch(err => console.error('[SCHEDULING] Calendar sync error:', err));
          }).catch(() => {});
        }

        return [{ type: 'text', text: message + helpText }];
      },
      async validate(input: string): Promise<ValidationResult> {
        if (input === 'accept_terms') {
          return { valid: true, data: { _terms_accepted: true } };
        }
        if (input === 'cancel_terms') {
          return { valid: true, data: { _terms_cancelled: true } };
        }
        if (input === 'retry_payment') {
          return { valid: true, data: { _retry_payment: true } };
        }
        if (input === 'chat_with_biz') {
          return { valid: true, data: { _chat_with_biz: true } };
        }
        return { valid: true };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        // After accepting/cancelling terms, re-enter this step to proceed
        if (d._terms_accepted || d._terms_cancelled) {
          return 'create_booking';
        }
        // Retry payment — re-enter create_booking
        if (d._retry_payment) {
          delete d._retry_payment;
          return 'create_booking';
        }
        // Chat with business — hand off to chat flow
        if (d._chat_with_biz) {
          await ctx.supabase.from('bot_sessions')
            .update({ current_step: 'chat_start', session_data: { ...d, active_capability: 'chat' } })
            .eq('id', ctx.session.id);
          return 'chat_start';
        }
        return null;
      },
    },

    // ── Saved Card Prompt ──
    {
      id: 'saved_card_prompt',
      async prompt(): Promise<PromptMessage[]> {
        // Prompt already sent during create_booking step
        return [];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const d = ctx.session.session_data;
        const action = input.toLowerCase().trim();

        if (action === 'pay_saved') {
          // Charge the saved card immediately
          const savedMethod = await getSavedPaymentMethod(ctx.supabase, ctx.business!.id, ctx.from);
          if (!savedMethod) {
            return { valid: true, data: { _skip_saved_card: true } };
          }

          const amount = d._pending_deposit as number;
          const bookingId = d.booking_id as string;
          const refCode = d.reference_code as string;
          const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
          const email = (d.email as string) || `${phone.replace('+', '')}@whatsapp.waaiio.com`;

          const result = await chargeSavedCard(ctx.supabase, {
            savedMethod,
            amount,
            currency: getCurrencyCode((ctx.business?.country_code || 'NG') as CountryCode),
            email,
            reference: `${refCode}-saved`,
            businessId: ctx.business!.id,
            bookingId,
          });

          if (result.success) {
            return { valid: true, data: { _saved_card_paid: true, _action: 'payment_confirmed' } };
          }
          // Card failed — fall through to regular payment
          return { valid: true, data: { _skip_saved_card: true, _saved_card_error: result.message } };
        }

        if (action === 'pay_new') {
          return { valid: true, data: { _skip_saved_card: true } };
        }

        if (action === 'cancel') {
          return { valid: true, data: { _action: 'cancel' } };
        }

        return { valid: false, errorMessage: 'Please select a payment option.' };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        if (d._action === 'cancel') return null;
        if (d._saved_card_paid) return null; // Payment complete, end flow
        // Saved card failed or user chose new card — go to regular payment
        return 'create_booking'; // Re-enter create_booking which will skip saved card this time
      },
    },

    // ── Payment Check ──
    {
      id: 'payment',
      async prompt(): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: "Please complete your deposit payment using the link sent above.\n\nAfter paying, *return to WhatsApp* and tap *I've Paid* to confirm, or *Cancel* to cancel.",
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
            const labels = getCategoryLabels(ctx.business?.category || 'restaurant');
            const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
              weekday: 'long', day: 'numeric', month: 'long',
            });

            const paidAmount = (d.deposit_amount as number) || 0;
            const paidCC = (ctx.business?.country_code || 'NG') as CountryCode;
            const confirmLines = [
              `✅ *Payment Confirmed!*`,
              '',
              `Your ${labels.entityName} at *${ctx.business?.name}* is fully confirmed.`,
              d.service_name ? `📋 ${d.service_name as string}` : null,
              `📅 ${dateLabel} at ${d.time as string}`,
              `👥 ${d.party_size as number} ${labels.quantityLabel}`,
              paidAmount > 0 ? `💰 ${formatCurrency(paidAmount, paidCC)}` : null,
              `🔑 Ref: *${d.reference_code as string}*`,
              '',
              'See you there! 🎉',
            ].filter(Boolean);

            const payTips = '\n\n💡 *What you can do:*\n• Type *my bookings* to view your appointments\n• Type *reschedule* to change the date/time\n• Type *cancel* to cancel\n• Type *receipt* to get your payment receipt';

            await ctx.sender.sendText({
              to: ctx.from,
              text: confirmLines.join('\n') + payTips,
            });

            // Notify business owner (email always, WhatsApp for dedicated numbers)
            if (ctx.business) {
              const custName = d.book_for_other
                ? (d.other_name as string)
                : `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Customer';
              notifyOwnerNewBooking({
                supabase: ctx.supabase,
                sender: ctx.sender,
                businessId: ctx.business.id,
                businessName: ctx.business.name,
                countryCode: paidCC,
                referenceCode: d.reference_code as string,
                customerName: custName,
                date: dateLabel,
                time: (d.time as string) || '',
                quantity: d.party_size as number,
                quantityLabel: labels.quantityLabel,
                amount: paidAmount || undefined,
              }).catch(err => console.error('[SCHEDULING] Owner notification error:', err));

              // Notify assigned staff member
              if (d.staff_id) {
                import('./shared/notify-staff').then(({ notifyStaffNewBooking }) => {
                  notifyStaffNewBooking({
                    supabase: ctx.supabase,
                    sender: ctx.sender,
                    businessId: ctx.business!.id,
                    businessName: ctx.business!.name,
                    staffId: d.staff_id as string,
                    customerName: custName,
                    serviceName: (d.service_name as string) || '',
                    date: dateLabel,
                    time: (d.time as string) || '',
                    referenceCode: d.reference_code as string,
                    countryCode: (ctx.business!.country_code || 'NG') as CountryCode,
                    amount: paidAmount || undefined,
                  }).catch(err => console.error('[SCHEDULING] Staff notify error:', err));
                }).catch(err => console.error('[SCHEDULING] Staff notify import error:', err));
              }

              // Post-completion: loyalty, feedback, referral, auto-receipt
              handlePostCompletion({
                supabase: ctx.supabase,
                businessId: ctx.business.id,
                customerPhone: ctx.from,
                customerName: d.book_for_other ? (d.other_name as string) : `${d.first_name || ''} ${d.last_name || ''}`.trim() || null,
                serviceType: 'booking',
                referenceId: d.booking_id as string,
                sender: ctx.sender,
                amountPaid: paidAmount,
                serviceName: d.service_name as string,
                referenceCode: d.reference_code as string,
              }).catch(err => console.error('[SCHEDULING] Post-completion error:', err));

              // Fire payment_received rule (non-blocking)
              const pmtSendMsg = async (to: string, txt: string) => {
                await ctx.sender.sendText({ to, text: txt });
              };
              evaluateRules(ctx.supabase, ctx.business.id, 'payment_received', {
                customer_phone: ctx.from,
                customer_name: custName,
                business_name: ctx.business.name,
                reference_code: d.reference_code as string,
                reference_id: d.booking_id as string,
                total_amount: d.deposit_amount as number || 0,
                service_type: 'booking',
              }, pmtSendMsg).catch(err => console.error('[SCHEDULING] payment_received rule error:', err));
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
