import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { BOOKING_DEFAULTS, generateTimeSlots, formatCurrency, getLocale, getMaxQuantity, type CountryCode } from '@/lib/constants';
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
          .select('id, name, price, duration_minutes, billing_type, recurring_interval')
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
          ctx.session.session_data.service_billing_type = services[0].billing_type || 'one_time';
          ctx.session.session_data.service_recurring_interval = services[0].recurring_interval || null;
          ctx.session.session_data.skip_service = true;
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
            return { title: s.name, description: desc, postbackText: s.id };
          }),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: service } = await ctx.supabase
          .from('services')
          .select('id, name, price, duration_minutes, deposit_amount, billing_type, recurring_interval')
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
            service_billing_type: service.billing_type || 'one_time',
            service_recurring_interval: service.recurring_interval || null,
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
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const dateRange = (meta.date_range_days as number) || 7;
        const dates: Array<{ title: string; postbackText: string }> = [];
        // WhatsApp list max 10 items
        const daysToShow = Math.min(dateRange, 10);
        for (let i = 1; i <= daysToShow; i++) {
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

        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const maxAdvanceDays = (meta.max_advance_days as number) || BOOKING_DEFAULTS.maxAdvanceDays;
        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + maxAdvanceDays);
        if (selected > maxDate) return { valid: false, errorMessage: `Bookings can only be made up to ${maxAdvanceDays} days in advance.` };

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

        // Read business operating hours for this day of week
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const selectedDay = dayNames[new Date(dateStr + 'T00:00').getDay()];
        const opHours = (ctx.business?.operating_hours || {}) as Record<string, { open?: string; close?: string; closed?: boolean }>;
        const dayHours = opHours[selectedDay];
        const openTime = (dayHours && !dayHours.closed && dayHours.open) ? dayHours.open : '08:00';
        const closeTime = (dayHours && !dayHours.closed && dayHours.close) ? dayHours.close : '22:00';

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

        const prefLabel = pref ? ` ${pref}` : '';
        // WhatsApp list messages support max 10 items per section
        const displaySlots = allSlots.slice(0, 10);
        return [{
          type: 'list',
          title: 'Select Time',
          body: `Available${prefLabel} times for ${dateLabel}:`,
          buttonLabel: 'Choose Time',
          items: displaySlots.map(t => ({ title: t, postbackText: t })),
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
          body: '\uD83C\uDF81 Got a referral code from a friend?',
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
        // Skip if business doesn't have referral capability
        const caps = await getEnabledCapabilities(ctx.supabase, ctx.business.id, ctx.business.category);
        if (!caps.includes('referral')) return true;
        // Skip if user already has a converted referral for this business
        if (ctx.session.user_id) {
          const { data: existing } = await ctx.supabase
            .from('referrals')
            .select('id')
            .eq('business_id', ctx.business.id)
            .eq('referred_user_id', ctx.session.user_id)
            .eq('status', 'converted')
            .limit(1)
            .maybeSingle();
          if (existing) return true;
        }
        return false;
      },
    },

    // ── Enter Referral Code ──
    {
      id: 'enter_referral_code',
      async prompt(): Promise<PromptMessage[]> {
        return [{ type: 'text', text: '\uD83C\uDF81 Enter your referral code below.\n\nType *skip* if you changed your mind.' }];
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
                  `📅 ${dateLabel}`,
                  `🕐 ${d.time as string}`,
                  `👥 ${partySize} ${labels.quantityLabel}`,
                  `🔑 Ref: *${booking.reference_code}*`,
                  '',
                  `\ud83d\udcb3 *${isPrepay ? 'Payment' : 'Deposit'} Required: ${formatCurrency(totalDeposit, (ctx.business?.country_code || 'NG') as CountryCode)}*`,
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
            { type: 'text', text: 'Sorry, we couldn\'t set up payment right now. Your booking has been saved but is pending payment. Please try again or contact the business directly.' },
            {
              type: 'buttons',
              body: 'What would you like to do?',
              buttons: [
                { id: 'retry_payment', title: 'Try Again' },
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
        return { valid: true };
      },
      async next(ctx: FlowContext) {
        // After accepting/cancelling terms, re-enter this step to proceed
        if (ctx.session.session_data._terms_accepted || ctx.session.session_data._terms_cancelled) {
          return 'create_booking';
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
            currency: ctx.business?.country_code === 'NG' ? 'NGN' : ctx.business?.country_code === 'GH' ? 'GHS' : 'USD',
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
        if (d._saved_card_paid) return 'post_payment'; // Skip payment step
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
