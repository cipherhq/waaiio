import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { BOOKING_DEFAULTS, generateTimeSlots, formatCurrency, getLocale, getMaxQuantity, getCurrencyCode, type CountryCode } from '@/lib/constants';
import { getCategoryLabels } from '@/lib/categoryConfig';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { createWhatsAppUser, findUserByPhone } from './shared/user';
import { initializePayment, verifyPayment, recordPlatformFee } from './shared/payment';
import { truncTitle } from '../utils/truncate';
import { getSavedPaymentMethod, chargeSavedCard } from '@/lib/payments/charge-saved';
import { createNotification } from './shared/notifications';
import { getConfirmationMessage } from './shared/templates';
import { handlePostCompletion } from './shared/post-completion';
import { getTermsPrompt } from './shared/terms';
import { notifyOwnerNewBooking, notifyOwnerNewPayment } from './shared/notify-owner';
import { analyzeReceipt, receiptMatchesExpected } from '@/lib/bot/receipt-ocr';
import { checkBankTransferEligibility, createPendingTransfer, formatBankTransferBlock, BANK_ONLY_BUTTONS, DUAL_OPTION_BUTTONS } from './shared/bank-transfer';
import { evaluateRules } from '@/lib/bot/automation/rules-engine';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { triggerSequences } from '@/lib/bot/automation/sequence-service';
import type { SubscriptionTier } from '@/lib/constants';
import { checkTierLimit } from '@/lib/tier-limits';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import { getCalendarLinksText } from '@/lib/calendar/generate-links';

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Format time for display — 12hr or 24hr based on business preference */
function formatTime(time: string, use12hr: boolean): string {
  if (!use12hr) return time;
  const [h, m] = time.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}
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

/** Special request options are now fully business-driven via metadata.special_request_options */
// Removed hardcoded category defaults — businesses configure their own options in dashboard

export const schedulingFlow: FlowDefinition = {
  type: 'scheduling',
  steps: [
    // ── Select Location (multi-location businesses) ──
    {
      id: 'select_location',
      async skipIf(ctx: FlowContext) {
        if (!ctx.business) return true;
        // Already selected via NL or previous step
        if (ctx.session.session_data.location_id) return true;
        const { count } = await ctx.supabase
          .from('business_locations')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', ctx.business.id)
          .eq('is_active', true);
        if (!count || count <= 1) {
          // If exactly 1 location, auto-select it
          if (count === 1) {
            const { data: loc } = await ctx.supabase
              .from('business_locations')
              .select('id, name')
              .eq('business_id', ctx.business.id)
              .eq('is_active', true)
              .single();
            if (loc) {
              ctx.session.session_data.location_id = loc.id;
              ctx.session.session_data._location_name = loc.name;
            }
          }
          return true;
        }
        return false;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const { data: locations } = await ctx.supabase
          .from('business_locations')
          .select('id, name, address')
          .eq('business_id', ctx.business!.id)
          .eq('is_active', true)
          .order('is_primary', { ascending: false });

        if (!locations || locations.length === 0) {
          return [{ type: 'text', text: 'No locations are currently available. Please try again later or type *cancel* to exit.' }];
        }

        return [{
          type: 'list',
          title: 'Locations',
          body: 'Which location would you like to visit?',
          buttonLabel: 'Choose Location',
          items: locations.map(l => ({
            title: truncTitle(l.name, 24),
            description: (l.address || '').slice(0, 72),
            postbackText: l.id,
          })),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        // First try exact ID match (list postback)
        const { data: location } = await ctx.supabase
          .from('business_locations')
          .select('id, name')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .eq('is_active', true)
          .maybeSingle();

        if (location) {
          return {
            valid: true,
            data: { location_id: location.id, _location_name: location.name },
          };
        }

        // Fuzzy fallback: match by name (exact, substring) or numbered selection
        const { data: allLocations } = await ctx.supabase
          .from('business_locations')
          .select('id, name')
          .eq('business_id', ctx.business!.id)
          .eq('is_active', true)
          .order('is_primary', { ascending: false });

        if (allLocations && allLocations.length > 0) {
          const lower = input.trim().toLowerCase();
          // Numbered selection (1, 2, 3…)
          const numIdx = parseInt(input.trim(), 10) - 1;
          if (!isNaN(numIdx) && numIdx >= 0 && numIdx < allLocations.length) {
            const matched = allLocations[numIdx];
            return { valid: true, data: { location_id: matched.id, _location_name: matched.name } };
          }
          // Exact name match (case-insensitive)
          let matched = allLocations.find(l => l.name.toLowerCase() === lower);
          // Substring match
          if (!matched) matched = allLocations.find(l => l.name.toLowerCase().includes(lower) || lower.includes(l.name.toLowerCase()));
          if (matched) {
            return { valid: true, data: { location_id: matched.id, _location_name: matched.name } };
          }
        }

        return { valid: false, errorMessage: 'I didn\'t find that location. Please tap one from the list, or type the location name.' };
      },
      async next() { return 'select_service'; },
    },

    // ── Select Service ──
    {
      id: 'select_service',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

        let query = ctx.supabase
          .from('services')
          .select('id, name, price, duration_minutes, buffer_minutes, max_capacity, auto_approve, billing_type, recurring_interval, available_days, available_from, available_to, requires_staff, staff_ids, allow_staff_selection, metadata, is_class, class_schedule')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .neq('service_type', 'giving')
          .is('deleted_at', null)
          .order('sort_order');

        // If smart intent matched multiple services, only show those
        const matchedIds = ctx.session.session_data._matched_service_ids as string[] | undefined;
        if (matchedIds && matchedIds.length > 0) {
          query = query.in('id', matchedIds);
        }

        const { data: services } = await query;

        if (!services || services.length === 0) {
          return [{ type: 'text' as const, text: `This business hasn't added any services yet. Please check back later or type *cancel* to go back.` }];
        }

        if (services.length === 1) {
          // Single service — skipIf handles auto-selection, prompt is a no-op
          return [];
        }

        // Pre-fetch upcoming booking counts for class services to show spots left
        const classServices = services.filter(s => (s as Record<string, unknown>).is_class && s.max_capacity && s.max_capacity > 1);
        const spotsMap = new Map<string, number>();
        if (classServices.length > 0) {
          const todayStr = new Date().toISOString().split('T')[0];
          const futureDate = new Date();
          futureDate.setDate(futureDate.getDate() + 14);
          const futureDateStr = futureDate.toISOString().split('T')[0];
          for (const cs of classServices) {
            const { count } = await ctx.supabase
              .from('bookings')
              .select('id', { count: 'exact', head: true })
              .eq('business_id', ctx.business.id)
              .eq('service_id', cs.id)
              .in('status', ['confirmed', 'pending', 'in_progress'])
              .gte('date', todayStr)
              .lte('date', futureDateStr);
            spotsMap.set(cs.id, Math.max(0, (cs.max_capacity || 1) - (count || 0)));
          }
        }

        const labels = getCategoryLabels(ctx.business.category);
        return [{
          type: 'list',
          title: 'Select Service',
          body: `What would you like to ${labels.actionVerb.toLowerCase()}?`,
          buttonLabel: 'Choose',
          items: services.map(s => {
            const cc = (ctx.business?.country_code || 'NG') as CountryCode;
            const sAny = s as Record<string, unknown>;
            const isClass = sAny.is_class === true;
            const classSchedule = (sAny.class_schedule as Array<{ day: string; time: string }>) || [];
            let desc = '';

            // For classes, show schedule + spots left
            if (isClass && classSchedule.length > 0) {
              const days = classSchedule.map(cs => cs.day.slice(0, 3).charAt(0).toUpperCase() + cs.day.slice(1, 3)).join('/');
              const time = classSchedule[0]?.time || '';
              const timeDisplay = time ? formatTime(time, true) : '';
              const spots = spotsMap.get(s.id);
              desc = `${days} ${timeDisplay}`;
              if (spots !== undefined) desc += ` • ${spots} spot${spots !== 1 ? 's' : ''} left`;
              if (s.price > 0) desc = `${formatCurrency(s.price, cc)} • ${desc}`;
            } else if (s.price > 0) {
              const priceStr = formatCurrency(s.price, cc);
              if (s.billing_type === 'recurring' && s.recurring_interval) {
                const suffix = s.recurring_interval === 'weekly' ? '/week' : '/month';
                desc = `${priceStr}${suffix}`;
              } else {
                desc = priceStr;
              }
              const meta = (s as Record<string, unknown>).metadata as Record<string, unknown> | null;
              const turnaround = meta?.turnaround_days as number | undefined;
              if (turnaround) {
                desc += ` • ${turnaround} day${turnaround > 1 ? 's' : ''}`;
              } else if (s.duration_minutes) {
                desc += s.duration_minutes >= 60
                  ? ` • ${Math.floor(s.duration_minutes / 60)}hr${s.duration_minutes % 60 ? ` ${s.duration_minutes % 60}min` : ''}`
                  : ` • ${s.duration_minutes}min`;
              }
            } else {
              const meta = (s as Record<string, unknown>).metadata as Record<string, unknown> | null;
              const turnaround = meta?.turnaround_days as number | undefined;
              if (turnaround) {
                desc = `${turnaround} day${turnaround > 1 ? 's' : ''}`;
              } else if (s.duration_minutes) {
                desc = s.duration_minutes >= 60
                  ? `${Math.floor(s.duration_minutes / 60)}hr${s.duration_minutes % 60 ? ` ${s.duration_minutes % 60}min` : ''}`
                  : `${s.duration_minutes}min`;
              }
            }
            const sTitle = s.name.length <= 24 ? s.name : s.name.slice(0, 23) + '…';
            const sDesc = s.name.length > 24 ? [s.name, desc].filter(Boolean).join(' · ').slice(0, 72) : desc;
            return { title: sTitle, description: sDesc, postbackText: s.id };
          }),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        // Try exact ID match first (from list postback)
        const { data: service } = await ctx.supabase
          .from('services')
          .select('id, name, price, duration_minutes, buffer_minutes, max_capacity, deposit_amount, billing_type, recurring_interval, available_days, available_from, available_to, requires_staff, staff_ids, allow_staff_selection, metadata, is_class, class_schedule')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .maybeSingle();

        // Fallback: fuzzy match by name (user typed service name or partial match)
        let matched = service;
        if (!matched) {
          const { data: allServices } = await ctx.supabase
            .from('services')
            .select('id, name, price, duration_minutes, buffer_minutes, max_capacity, deposit_amount, billing_type, recurring_interval, available_days, available_from, available_to, requires_staff, staff_ids, allow_staff_selection, metadata, is_class, class_schedule')
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

        if (!matched) return { valid: false, errorMessage: 'I didn\'t find that service. Try typing the name (e.g. *haircut*) or tap an option from the list.' };

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
            _service_buffer_minutes: (matched as Record<string, unknown>).buffer_minutes || 0,
            _service_metadata: (matched as Record<string, unknown>).metadata || null,
            _auto_approve: (matched as Record<string, unknown>).auto_approve !== false,
            _service_requires_staff: (matched as Record<string, unknown>).requires_staff || false,
            _service_staff_ids: (matched as Record<string, unknown>).staff_ids || [],
            _service_allow_staff_selection: (matched as Record<string, unknown>).allow_staff_selection || false,
            _service_is_class: (matched as Record<string, unknown>).is_class || false,
            _service_class_schedule: (matched as Record<string, unknown>).class_schedule || [],
          },
        };
      },
      async next() { return 'select_date'; },
      async skipIf(ctx: FlowContext) {
        if (ctx.session.session_data.skip_service) return true;
        if (!ctx.business) return true;

        const { data: services } = await ctx.supabase
          .from('services')
          .select('id, name, price, duration_minutes, buffer_minutes, max_capacity, auto_approve, deposit_amount, billing_type, recurring_interval, available_days, available_from, available_to, requires_staff, staff_ids, allow_staff_selection, metadata, is_class, class_schedule')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .neq('service_type', 'giving')
          .is('deleted_at', null)
          .order('sort_order');

        if (!services || services.length === 0) {
          // Set default values so downstream steps don't crash on null service data
          ctx.session.session_data.service_id = null;
          ctx.session.session_data.service_name = 'General';
          ctx.session.session_data.service_price = 0;
          ctx.session.session_data.service_duration = 30;
          ctx.session.session_data.service_deposit = null;
          ctx.session.session_data.service_billing_type = 'one_time';
          ctx.session.session_data.service_recurring_interval = null;
          ctx.session.session_data._service_available_days = [];
          ctx.session.session_data._service_available_from = null;
          ctx.session.session_data._service_available_to = null;
          ctx.session.session_data._service_max_capacity = 1;
          ctx.session.session_data._service_buffer_minutes = 0;
          ctx.session.session_data._service_metadata = null;
          ctx.session.session_data._auto_approve = true;
          ctx.session.session_data._service_requires_staff = false;
          ctx.session.session_data._service_staff_ids = [];
          ctx.session.session_data._service_allow_staff_selection = false;
          ctx.session.session_data._service_is_class = false;
          ctx.session.session_data._service_class_schedule = [];
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
          ctx.session.session_data._service_buffer_minutes = s.buffer_minutes || 0;
          ctx.session.session_data._service_metadata = s.metadata || null;
          ctx.session.session_data._auto_approve = s.auto_approve !== false;
          ctx.session.session_data._service_requires_staff = s.requires_staff || false;
          ctx.session.session_data._service_staff_ids = s.staff_ids || [];
          ctx.session.session_data._service_allow_staff_selection = s.allow_staff_selection || false;
          ctx.session.session_data._service_is_class = (s as Record<string, unknown>).is_class || false;
          ctx.session.session_data._service_class_schedule = (s as Record<string, unknown>).class_schedule || [];
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
        const promptBody = getStaffPrompt(ctx.business?.category || 'other');

        // Use a list message for 3+ staff members; buttons for 1-2
        if (staff.length >= 3) {
          const items = staff.map(s => ({
            title: truncTitle(s.name, 24),
            description: '',
            postbackText: `staff_${s.id}`,
          }));
          items.push({ title: 'Any available', description: '', postbackText: 'staff_any' });
          return [{
            type: 'list',
            title: 'Select Staff',
            body: promptBody,
            buttonLabel: 'Choose',
            items,
          }];
        }

        const buttons = staff.slice(0, 2).map(s => ({
          id: `staff_${s.id}`,
          title: truncTitle(s.name),
        }));
        buttons.push({ id: 'staff_any', title: 'Any available' });

        return [{
          type: 'buttons',
          body: promptBody,
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
        // Fuzzy match by typed name (e.g., "Mike" matches "Mike Johnson")
        if (input.toLowerCase() === 'any' || input.toLowerCase() === 'anyone') {
          return { valid: true };
        }
        const staff = ctx.session.session_data._available_staff as Array<{ id: string; name: string }>;
        if (staff) {
          const lower = input.toLowerCase().trim();
          const nameMatch = staff.find(s =>
            s.name.toLowerCase() === lower ||
            s.name.toLowerCase().includes(lower) ||
            lower.includes(s.name.toLowerCase().split(' ')[0])
          );
          if (nameMatch) {
            return { valid: true, data: { staff_id: nameMatch.id, staff_name: nameMatch.name } };
          }
        }
        return { valid: false, errorMessage: 'Try typing a name like *Mike*, or tap an option above.' };
      },
      async next() { return 'select_time'; },
    },

    // ── Select Date ──
    {
      id: 'select_date',
      async skipIf(ctx: FlowContext) {
        // Drop-off services (wig revamp, styling) don't need date/time
        const svcMeta = ctx.session.session_data._service_metadata as Record<string, unknown> | undefined;
        if (svcMeta?.is_dropoff) {
          ctx.session.session_data.date = new Date().toISOString().split('T')[0];
          return true;
        }

        const preDate = ctx.session.session_data.date as string | undefined;
        if (!preDate) return false;

        // Validate: must be in the future, business must be open, not fully booked
        const selected = new Date(preDate + 'T00:00');
        const today = new Date(); today.setHours(0, 0, 0, 0);
        if (selected < today) { delete ctx.session.session_data.date; return false; }

        // Check business is open on this day
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const dayName = dayNames[selected.getDay()];
        const opHours = (ctx.business?.operating_hours || {}) as Record<string, { closed?: boolean }>;
        if (opHours[dayName]?.closed) { delete ctx.session.session_data.date; return false; }

        // Check available days for this service
        const availDays = (ctx.session.session_data._service_available_days as string[]) || [];
        if (availDays.length > 0 && !availDays.includes(dayName)) { delete ctx.session.session_data.date; return false; }

        return true;
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

        const maxCapacity = (ctx.session.session_data._service_max_capacity as number) || 1;
        const opHours = (ctx.business?.operating_hours || {}) as Record<string, { open?: string; close?: string; closed?: boolean }>;
        const staffId = ctx.session.session_data.staff_id as string | null;
        const durationMin = (ctx.session.session_data._service_duration as number) || 30;
        const slotInterval = (meta.slot_interval_minutes as number) || durationMin;

        // Pre-fetch all bookings for the next maxAdvanceDays to filter fully-booked dates
        const todayStr = new Date().toISOString().split('T')[0];
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + maxAdvanceDays);
        const futureDateStr = futureDate.toISOString().split('T')[0];

        let bookingsQuery = ctx.supabase
          .from('bookings')
          .select('date, time')
          .eq('business_id', ctx.business!.id)
          .in('status', ['confirmed', 'pending', 'in_progress'])
          .gte('date', todayStr)
          .lte('date', futureDateStr);

        if (staffId) bookingsQuery = bookingsQuery.eq('staff_id', staffId);
        const { data: allBookings } = await bookingsQuery.limit(2000);

        // Count bookings per date+time
        const bookingsByDate = new Map<string, number>();
        for (const b of allBookings || []) {
          if (b.date) {
            const key = b.date;
            bookingsByDate.set(key, (bookingsByDate.get(key) || 0) + 1);
          }
        }

        // Scan up to maxAdvanceDays but collect max 10 matching dates
        for (let i = 1; i <= maxAdvanceDays && dates.length < 10; i++) {
          const d = new Date();
          d.setDate(d.getDate() + i);
          const dayOfWeek = dayNames[d.getDay()];

          // Filter by service available days
          if (availableDays.length > 0 && !availableDays.includes(dayOfWeek)) continue;

          // Filter by business operating hours (skip closed days)
          if (opHours[dayOfWeek]?.closed) continue;

          // Filter fully-booked dates: count available slots vs bookings
          const dateStr = d.toISOString().split('T')[0];
          const openTime = opHours[dayOfWeek]?.open || '08:00';
          const closeTime = opHours[dayOfWeek]?.close || '18:00';
          // Handle midnight-crossing hours (e.g., 22:00-06:00)
          let openMin = timeToMinutes(openTime);
          let closeMin = timeToMinutes(closeTime);
          if (closeMin <= openMin) closeMin += 24 * 60;
          const totalSlots = Math.max(1, Math.floor(
            (closeMin - openMin) / slotInterval
          ));
          const bookedCount = bookingsByDate.get(dateStr) || 0;
          const maxBookingsForDate = totalSlots * maxCapacity;
          if (bookedCount >= maxBookingsForDate) continue; // fully booked

          const label = d.toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { weekday: 'short', day: 'numeric', month: 'short' });
          dates.push({ title: label, postbackText: dateStr });
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

        // ── Quick date shortcuts: show "Tomorrow" / "This Saturday" / "Pick a Date" as buttons ──
        // Only show shortcuts on first prompt (not after "Pick a Date" was tapped)
        if (!ctx.session.session_data._show_full_date_list) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowStr = tomorrow.toISOString().split('T')[0];
          const tomorrowDay = dayNames[tomorrow.getDay()];
          const tomorrowOpen = !opHours[tomorrowDay]?.closed && (availableDays.length === 0 || availableDays.includes(tomorrowDay));
          const tomorrowAvailable = dates.some(d => d.postbackText === tomorrowStr);

          // Find next Saturday
          const nextSat = new Date();
          nextSat.setDate(nextSat.getDate() + ((6 - nextSat.getDay() + 7) % 7 || 7));
          const nextSatStr = nextSat.toISOString().split('T')[0];
          const satOpen = !opHours['saturday']?.closed && (availableDays.length === 0 || availableDays.includes('saturday'));
          const satAvailable = dates.some(d => d.postbackText === nextSatStr);

          const quickButtons: Array<{ id: string; title: string }> = [];
          if (tomorrowAvailable && tomorrowOpen) {
            const dayLabel = tomorrowDay.charAt(0).toUpperCase() + tomorrowDay.slice(1, 3);
            quickButtons.push({ id: `date_${tomorrowStr}`, title: `Tomorrow (${dayLabel})` });
          }
          if (satAvailable && satOpen && nextSatStr !== tomorrowStr) {
            quickButtons.push({ id: `date_${nextSatStr}`, title: 'This Saturday' });
          }

          // Show quick buttons if we have at least 1 shortcut + "Pick a Date"
          if (quickButtons.length > 0) {
            quickButtons.push({ id: 'pick_date', title: 'Pick a Date' });
            messages.push({
              type: 'buttons' as const,
              body: getDatePrompt(ctx.business?.category || 'other'),
              buttons: quickButtons.slice(0, 3),
            });
            return messages;
          }
        }

        // Full date list (default fallback or after "Pick a Date" tapped)
        // Reset the flag so next time we show shortcuts again
        if (ctx.session.session_data._show_full_date_list) {
          delete ctx.session.session_data._show_full_date_list;
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

        // Handle "Pick a Date" button — show full date list on re-prompt
        if (input === 'pick_date') {
          ctx.session.session_data._show_full_date_list = true;
          await ctx.supabase.from('bot_sessions').update({ session_data: ctx.session.session_data }).eq('id', ctx.session.id);
          return { valid: false, errorMessage: undefined };
        }

        // Handle quick date shortcut buttons (date_YYYY-MM-DD)
        let dateStr = input;
        const quickDateMatch = /^date_(\d{4}-\d{2}-\d{2})$/.exec(input);
        if (quickDateMatch) {
          dateStr = quickDateMatch[1];
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
          // Natural language date parsing — tolerant of surrounding text (e.g., "tomorrow at 6pm")
          const lower = input.toLowerCase().trim();
          const now = new Date();
          if (/\b(today|2day|todey)\b/.test(lower)) {
            dateStr = now.toISOString().split('T')[0];
          } else if (/\b(tomorrow|2moro|2morrow|tmrw|tmr|2mr|2mrw)\b/.test(lower)) {
            const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
            dateStr = tmr.toISOString().split('T')[0];
          } else if (/\bnext\s*week\b/.test(lower)) {
            const nw = new Date(now); nw.setDate(nw.getDate() + 7);
            dateStr = nw.toISOString().split('T')[0];
          } else if (/^(mon|tue|wed|thu|fri|sat|sun)/i.test(lower) || /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lower)) {
            const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
            const dayMatch = lower.match(/\b(sun|mon|tue|wed|thu|fri|sat)\w*/i);
            if (dayMatch) {
              const target = dayMap[dayMatch[1].slice(0, 3).toLowerCase()];
              if (target !== undefined) {
                const d = new Date(now);
                const diff = (target - d.getDay() + 7) % 7 || 7;
                d.setDate(d.getDate() + diff);
                dateStr = d.toISOString().split('T')[0];
              }
            }
          } else {
            const parsed = new Date(input);
            if (isNaN(parsed.getTime())) {
              return { valid: false, errorMessage: 'Try typing *tomorrow*, a day like *Saturday*, or tap a date option.' };
            }
            dateStr = parsed.toISOString().split('T')[0];
          }
        }

        const selected = new Date(dateStr + 'T00:00');
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        if (selected < tomorrow) return { valid: false, errorMessage: 'That date has passed. Try *tomorrow* or pick a future date.' };

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
        if (ctx.session.session_data._action === 'cancel') {
          delete ctx.session.session_data._action;
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('No problem! Send *Hi* to explore other options.') });
          return null; // end session cleanly
        }
        return 'select_staff';
      },
    },

    // ── Select Time ──
    {
      id: 'select_time',
      async skipIf(ctx: FlowContext) {
        // Drop-off services don't need time selection
        const svcMeta = ctx.session.session_data._service_metadata as Record<string, unknown> | undefined;
        if (svcMeta?.is_dropoff) {
          ctx.session.session_data.time = '00:00'; // valid time for DB; display handled separately
          return true;
        }

        const preTime = ctx.session.session_data.time as string | undefined;
        const dateStr = ctx.session.session_data.date as string | undefined;
        if (!preTime || !dateStr) return false;

        // Validate: time must be within business operating hours for this day
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const selectedDay = dayNames[new Date(dateStr + 'T00:00').getDay()];
        const opHours = (ctx.business?.operating_hours || {}) as Record<string, { open?: string; close?: string; closed?: boolean }>;
        const dayHours = opHours[selectedDay];

        const openTime = (dayHours && !dayHours.closed && dayHours.open) ? dayHours.open : '08:00';
        const closeTime = (dayHours && !dayHours.closed && dayHours.close) ? dayHours.close : '22:00';

        const preMinutes = timeToMinutes(preTime);
        const openMinutes = timeToMinutes(openTime);
        let closeMinutes = timeToMinutes(closeTime);

        // Handle midnight-crossing hours (e.g., 22:00-06:00)
        const crossesMidnight = closeMinutes <= openMinutes;
        if (crossesMidnight) closeMinutes += 24 * 60;

        // Normalize preMinutes for comparison when hours cross midnight
        const adjustedPreMinutes = (crossesMidnight && preMinutes < openMinutes)
          ? preMinutes + 24 * 60
          : preMinutes;

        // If time is outside operating hours, clear it and show the picker
        if (adjustedPreMinutes < openMinutes || adjustedPreMinutes >= closeMinutes) {
          delete ctx.session.session_data.time;
          return false;
        }

        // If time is in the past (today), clear it
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        if (dateStr === todayStr) {
          const nowMinutes = now.getHours() * 60 + now.getMinutes();
          if (preMinutes <= nowMinutes) { delete ctx.session.session_data.time; return false; }
        }

        return true;
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

        // Fetch existing bookings for this date (include duration + buffer for overlap detection)
        let bookingsQuery = ctx.supabase
          .from('bookings')
          .select('time, staff_id, services(duration_minutes, buffer_minutes)')
          .eq('business_id', ctx.business!.id)
          .eq('date', dateStr)
          .in('status', ['confirmed', 'pending', 'in_progress']);

        if (staffId) {
          bookingsQuery = bookingsQuery.eq('staff_id', staffId);
        }

        const { data: existingBookings } = await bookingsQuery;

        // Count bookings per time slot — accounting for service duration + buffer overlap
        // A 60-min booking with 10-min buffer at 8:00 blocks 8:00, 8:30, 9:00 (70 min total)
        const slotCounts = new Map<string, number>();
        for (const b of existingBookings || []) {
          if (b.time) {
            const bookingStart = timeToMinutes(b.time.slice(0, 5));
            const svc = b.services as unknown as { duration_minutes?: number; buffer_minutes?: number } | null;
            const fallbackDuration = (ctx.session.session_data.service_duration as number) || 30;
            const bookingDuration = (svc?.duration_minutes || fallbackDuration) + (svc?.buffer_minutes || 0);

            // Block all slots that overlap with this booking's time range (duration + buffer)
            for (const slot of allSlots) {
              const slotStart = timeToMinutes(slot);
              if (slotStart >= bookingStart && slotStart < bookingStart + bookingDuration) {
                slotCounts.set(slot, (slotCounts.get(slot) || 0) + 1);
              }
            }
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
          // All slots fully booked — show buttons to pick new date or cancel
          return [{
            type: 'buttons',
            body: `All time slots on ${dateLabel} are fully booked.`,
            buttons: [
              { id: 'pick_another_date', title: 'Pick Another Date' },
              { id: 'cancel_booking', title: 'Cancel' },
            ],
          }];
        }

        const prefLabel = pref ? ` ${pref}` : '';
        // WhatsApp list messages support max 10 items per section
        const displaySlots = availableSlots.slice(0, 10);
        const bizMeta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const use12hr = bizMeta.time_format !== '24hr'; // default to 12hr

        const items = displaySlots.map(s => ({
          title: formatTime(s.time, use12hr),
          description: maxCapacity > 1 ? `${s.remaining} spot${s.remaining !== 1 ? 's' : ''} left` : undefined,
          postbackText: s.time, // always send 24hr format as postback value
        }));
        // Add "Change Date" navigation option at the end
        items.push({ title: '← Change Date', description: 'Pick a different date', postbackText: 'change_date' });

        return [{
          type: 'list',
          title: 'Select Time',
          body: `Pick a${prefLabel} time on ${dateLabel}:`,
          buttonLabel: 'Choose Time',
          items,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        // Handle "Change Date" navigation
        if (input === 'change_date' || input === 'pick_another_date') {
          return { valid: true, data: { _time_action: 'change_date' } };
        }
        // Handle cancel from fully-booked prompt
        if (input === 'cancel_booking') {
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('No problem! Send *Hi* to explore other options.') });
          return { valid: true, data: { _time_action: 'cancel' } };
        }

        // Extract time from rich text (e.g., "6pm for 5 people" → "6pm")
        let timeInput = input.trim();
        if (!/^\d{2}:\d{2}$/.test(timeInput) && !/^time_/.test(timeInput)) {
          // Not a postback — try to extract time from natural text
          const richTimeMatch = timeInput.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
          const rich24Match = timeInput.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
          const richByMatch = timeInput.match(/\b(?:by|at|around)\s+(\d{1,2})(?:\s*o'?clock)?\b(?!\s*(?:people|person|guest|pax|am|pm))/i);
          if (richTimeMatch) {
            let hours = parseInt(richTimeMatch[1]);
            const minutes = richTimeMatch[2] || '00';
            const period = richTimeMatch[3].replace(/\./g, '').toLowerCase();
            if (period === 'pm' && hours < 12) hours += 12;
            if (period === 'am' && hours === 12) hours = 0;
            timeInput = `${hours.toString().padStart(2, '0')}:${minutes}`;
          } else if (rich24Match) {
            timeInput = `${rich24Match[1].padStart(2, '0')}:${rich24Match[2]}`;
          } else if (richByMatch) {
            let h = parseInt(richByMatch[1]);
            if (h >= 1 && h <= 7) h += 12;
            if (h >= 8 && h <= 23) timeInput = `${h.toString().padStart(2, '0')}:00`;
          }
        }

        // Accept HH:MM, HH:MM AM/PM, "10am", "2pm", "2:30pm"
        let normalizedTime = timeInput;
        const ampmMatch = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(normalizedTime);
        if (ampmMatch) {
          let h = parseInt(ampmMatch[1], 10);
          const m = ampmMatch[2] || '00';
          const period = ampmMatch[3].toLowerCase();
          if (period === 'pm' && h < 12) h += 12;
          if (period === 'am' && h === 12) h = 0;
          normalizedTime = `${String(h).padStart(2, '0')}:${m}`;
        }
        const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(normalizedTime);
        if (!timeMatch) {
          return { valid: false, errorMessage: 'Try typing a time like *10am*, *2:30pm*, or tap an option.' };
        }
        input = normalizedTime;

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
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        if (d._time_action === 'change_date') {
          delete d.date;
          delete d._time_action;
          return 'select_date';
        }
        if (d._time_action === 'cancel') {
          delete d._time_action;
          return null; // end session cleanly
        }
        return 'select_addons';
      },
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
          .or(serviceId ? `service_id.eq.${sanitizeFilterValue(serviceId)},service_id.is.null` : 'service_id.is.null')
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
          title: truncTitle(`${a.name} — ${formatCurrency(a.price, cc)}`, 24),
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
        // Skip if service is free
        const price = ctx.session.session_data.service_price as number || 0;
        if (price <= 0) return true;
        // Skip if no active promo codes apply to this service
        const { data: promos } = await ctx.supabase
          .from('promo_codes')
          .select('id, applicable_services, applicable_flow_types')
          .eq('business_id', ctx.business.id)
          .eq('is_active', true)
          .limit(20);

        if (!promos || promos.length === 0) return true;

        const serviceId = ctx.session.session_data.service_id as string;
        const hasApplicablePromo = promos.some(p => {
          const services = (p.applicable_services as string[]) || [];
          const flows = (p.applicable_flow_types as string[]) || [];
          if (services.length === 0 && flows.length === 0) return true;
          if (flows.length > 0 && !flows.includes('scheduling')) return false;
          if (services.length > 0 && serviceId && !services.includes(serviceId)) return false;
          return true;
        });
        return !hasApplicablePromo;
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

        if (!promo) return { valid: false, errorMessage: 'Invalid promo code. Check the spelling and try again, or type *skip*.' };
        if (promo.max_uses && promo.current_uses >= promo.max_uses) return { valid: false, errorMessage: 'This promo code has reached its usage limit.' };
        if (promo.valid_until && new Date(promo.valid_until) < new Date()) return { valid: false, errorMessage: 'This promo code has expired.' };

        // Check if this customer already used this promo code
        const promoPhone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
        const { count: priorPromoUses } = await ctx.supabase
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', ctx.business!.id)
          .eq('guest_phone', promoPhone)
          .not('status', 'eq', 'cancelled')
          .eq('promo_code_id', promo.id);
        if ((priorPromoUses || 0) > 0) {
          return { valid: false, errorMessage: 'You have already used this promo code.' };
        }

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
        // Confirm promo applied
        if (ctx.session.session_data._promo_code) {
          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const discount = ctx.session.session_data._promo_discount as number;
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(`Promo code *${ctx.session.session_data._promo_code}* verified! ${formatCurrency(discount, cc)} discount will be applied at checkout.`) });
        }
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

        // Check if this customer already used this promo code
        const promoPhone2 = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
        const { count: priorPromoUses2 } = await ctx.supabase
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', ctx.business!.id)
          .eq('guest_phone', promoPhone2)
          .not('status', 'eq', 'cancelled')
          .eq('promo_code_id', promo.id);
        if ((priorPromoUses2 || 0) > 0) {
          return { valid: false, errorMessage: 'You have already used this promo code.' };
        }

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
        // Confirm promo applied
        if (ctx.session.session_data._promo_code) {
          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const discount = ctx.session.session_data._promo_discount as number;
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(`Promo code *${ctx.session.session_data._promo_code}* verified! ${formatCurrency(discount, cc)} discount will be applied at checkout.`) });
        }
        return 'select_quantity';
      },
      async skipIf(ctx: FlowContext) {
        return !!ctx.session.session_data._promo_code;
      },
    },

    // ── Select Quantity ──
    {
      id: 'select_quantity',
      async skipIf(ctx: FlowContext) {
        // Skip if smart intent already extracted quantity
        if (ctx.session.session_data.party_size) return true;

        // Skip for drop-off services (always 1)
        const svcMeta = ctx.session.session_data._service_metadata as Record<string, unknown> | undefined;
        if (svcMeta?.is_dropoff) {
          ctx.session.session_data.party_size = 1;
          return true;
        }

        // Skip if service has "ask quantity" disabled
        if (svcMeta?.skip_quantity === true) {
          ctx.session.session_data.party_size = 1;
          return true;
        }

        // Skip if business disabled quantity selection globally
        const bizMeta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        if (bizMeta.skip_quantity === true) {
          ctx.session.session_data.party_size = 1;
          return true;
        }

        // Skip if max capacity is 1 or not set (single-person service)
        const maxCap = ctx.session.session_data._service_max_capacity as number | null | undefined;
        if (!maxCap || maxCap <= 1) {
          ctx.session.session_data.party_size = 1;
          return true;
        }

        return false;
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
        let size = parseInt(input, 10);
        // Try natural language extraction if bare parseInt failed ("for 3 guests", "table for 4", "we are 5")
        if (isNaN(size) && !/^\d+$/.test(input.trim())) {
          const { extractEntitiesOnly } = await import('@/lib/bot/smart-intent');
          const entities = extractEntitiesOnly(input);
          if (entities.quantity) size = entities.quantity;
        }
        if (isNaN(size) || size < 1 || size > maxQty) {
          return { valid: false, errorMessage: `Please enter a number between 1 and ${maxQty}.` };
        }
        ctx.intelligence.resetAbuse(ctx.from);
        return { valid: true, data: { party_size: size } };
      },
      async next() { return 'collect_guest_names'; },
    },

    // ── Collect Guest Names (group bookings) ──
    {
      id: 'collect_guest_names',
      async skipIf(ctx: FlowContext) {
        const partySize = ctx.session.session_data.party_size as number;
        if (!partySize || partySize <= 1) return true;
        return false;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const partySize = ctx.session.session_data.party_size as number;
        const category = ctx.business?.category || 'restaurant';
        const labels = getCategoryLabels(category);
        return [{
          type: 'buttons',
          body: `Please enter the names of all ${partySize} ${labels.quantityLabel}, separated by commas.\n\nExample: John, Mary, Sarah`,
          buttons: [{ id: 'skip', title: 'Skip Names' }],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const text = input.trim();

        // Allow skip via button or text
        if (/^skip$/i.test(text)) {
          return { valid: true, data: { guest_list: [] } };
        }

        // Parse names from multiple formats (WhatsApp users type all kinds of lists)
        let names: string[];
        if (text.includes('\n')) {
          // Newline separated
          names = text.split('\n').map(n => n.trim()).filter(Boolean);
        } else if (text.includes(',')) {
          // Comma separated: "John, Mary, Sarah"
          names = text.split(',').map(n => n.trim()).filter(Boolean);
        } else if (/\d+[.)]\s/.test(text)) {
          // Numbered list: "1. John 2. Mary" or "1) John 2) Mary"
          names = text.split(/\d+[.)]\s*/).map(n => n.trim()).filter(Boolean);
        } else if (text.toLowerCase().includes(' and ')) {
          // "John and Mary and Sarah"
          names = text.split(/\s+and\s+/i).map(n => n.trim()).filter(Boolean);
        } else if (text.includes(' - ') || text.startsWith('-')) {
          // "- John - Mary" or "John - Mary - Sarah"
          names = text.split(/\s*-\s*/).map(n => n.trim()).filter(Boolean);
        } else {
          // Single name
          names = [text];
        }

        // Remove empty entries
        names = names.filter(n => n.length > 0);

        if (names.length === 0) {
          return { valid: false, errorMessage: 'Please enter the guest names, separated by commas: "John, Mary, Sarah"' };
        }

        // Accept whatever count the user provides — don't block on mismatch
        const guestList = names.map(name => ({ name }));
        return { valid: true, data: { guest_list: guestList } };
      },
      async next() { return 'special_requests'; },
    },

    // ── Special Requests ──
    {
      id: 'special_requests',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const customOptions = (meta.special_request_options as Array<{ id: string; title: string }>) || [];

        if (customOptions.length > 0) {
          // Business has configured their own options — show as buttons
          return [{
            type: 'buttons',
            body: 'Any special requests?',
            buttons: [
              { id: 'req_none', title: "No, I'm good" },
              ...customOptions.slice(0, 2).map(o => ({ id: `req_${o.id}`, title: truncTitle(o.title) })),
            ],
          }];
        }

        // No custom options — just ask as free text
        return [{
          type: 'buttons',
          body: 'Any special requests or notes for your booking?',
          buttons: [
            { id: 'req_none', title: "No, I'm good" },
          ],
        }];
      },
      async skipIf(ctx: FlowContext) {
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        // Skip if business explicitly disabled special requests
        if (meta.special_requests_enabled === false) {
          ctx.session.session_data.special_requests = '';
          return true;
        }
        // Skip by default — business must opt-in via require_special_requests: true
        // This reduces unnecessary steps for most bookings
        if (meta.require_special_requests !== true && meta.special_requests_enabled !== true) {
          ctx.session.session_data.special_requests = '';
          return true;
        }
        return false;
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input === 'req_none') {
          return { valid: true, data: { special_requests: '' } };
        }

        // Check if input matches a custom option button ID
        const meta = (ctx.business?.metadata || {}) as Record<string, unknown>;
        const customOptions = (meta.special_request_options as Array<{ id: string; title: string }>) || [];
        const matched = customOptions.find(o => input === `req_${o.id}`);
        if (matched) {
          return { valid: true, data: { special_requests: matched.title } };
        }

        // Free text input
        return { valid: true, data: { special_requests: input } };
      },
      async next() { return 'pre_booking_questions'; },
    },

    // ── Pre-Booking Questions (business-defined, self-looping) ──
    {
      id: 'pre_booking_questions',
      async skipIf(ctx: FlowContext) {
        const questions = (ctx.business?.metadata as Record<string, unknown>)?.pre_booking_questions as Array<{ id: string; question: string; required?: boolean }> | undefined;
        if (!questions || questions.length === 0) return true;
        // Skip if all questions already answered
        const idx = (ctx.session.session_data._pbq_index as number) || 0;
        return idx >= questions.length;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const questions = (ctx.business?.metadata as Record<string, unknown>)?.pre_booking_questions as Array<{ id: string; question: string; required?: boolean }>;
        const idx = (ctx.session.session_data._pbq_index as number) || 0;
        if (!questions || idx >= questions.length) return [];
        const q = questions[idx];
        const progress = questions.length > 1 ? ` (${idx + 1}/${questions.length})` : '';
        return [{
          type: 'text',
          text: `📋 ${q.question}${progress}${q.required === false ? '\n\n_Type *skip* to skip this question_' : ''}`,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const questions = (ctx.business?.metadata as Record<string, unknown>)?.pre_booking_questions as Array<{ id: string; question: string; required?: boolean }>;
        const idx = (ctx.session.session_data._pbq_index as number) || 0;
        if (!questions || idx >= questions.length) return { valid: true, data: {} };
        const q = questions[idx];
        const answer = input.trim();
        if (!answer && q.required !== false) {
          return { valid: false, errorMessage: 'Please answer this question to continue.' };
        }
        // Store answer
        const answers = (ctx.session.session_data._pbq_answers as Record<string, string>) || {};
        if (answer.toLowerCase() !== 'skip') {
          answers[q.id] = answer;
        }
        return { valid: true, data: { _pbq_answers: answers, _pbq_index: idx + 1 } };
      },
      async next(ctx: FlowContext) {
        const questions = (ctx.business?.metadata as Record<string, unknown>)?.pre_booking_questions as Array<{ id: string; question: string }>;
        const idx = (ctx.session.session_data._pbq_index as number) || 0;
        // More questions? Loop back to same step
        if (questions && idx < questions.length) return 'pre_booking_questions';
        return 'select_delivery';
      },
    },

    // ── Select Delivery/Pickup for drop-off services ──
    {
      id: 'select_delivery',
      async skipIf(ctx: FlowContext) {
        const svcMeta = ctx.session.session_data._service_metadata as Record<string, unknown> | undefined;
        if (!svcMeta?.is_dropoff) return true; // only for drop-off services

        // Check if business has delivery zones
        const { data: zones } = await ctx.supabase
          .from('delivery_zones')
          .select('id')
          .eq('business_id', ctx.business!.id)
          .eq('is_active', true)
          .limit(1);

        if (!zones || zones.length === 0) return true; // no zones configured
        return false;
      },
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const { data: zones } = await ctx.supabase
          .from('delivery_zones')
          .select('id, name, price, is_pickup')
          .eq('business_id', ctx.business!.id)
          .eq('is_active', true)
          .order('sort_order');

        if (!zones || zones.length === 0) return [];

        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        return [{
          type: 'list',
          title: 'Pickup or Drop-off',
          body: 'How would you like to get your item to us?',
          buttonLabel: 'Choose Option',
          items: zones.map(z => ({
            title: truncTitle(z.name, 24),
            description: z.price > 0 ? `${formatCurrency(z.price, cc)} pickup fee` : 'Free',
            postbackText: z.id,
          })),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const { data: zone } = await ctx.supabase
          .from('delivery_zones')
          .select('id, name, price')
          .eq('id', input)
          .eq('business_id', ctx.business!.id)
          .maybeSingle();

        if (!zone) return { valid: false, errorMessage: 'Please select an option.' };

        return {
          valid: true,
          data: {
            _delivery_zone_id: zone.id,
            _delivery_zone_name: zone.name,
            _delivery_zone_price: zone.price,
          },
        };
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
        return [{ type: 'text', text: '📍 What is your address?\n\nPlease type the *full address*:' }];
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
        if (d._location_name) lines.push(`📍 Location: ${d._location_name as string}`);
        if (d.staff_name) lines.push(`👤 With: ${d.staff_name as string}`);

        const svcMeta = d._service_metadata as Record<string, unknown> | undefined;
        const isDropoff = svcMeta?.is_dropoff === true;

        if (isDropoff) {
          // Drop-off service: show turnaround, not date/time
          const turnaround = svcMeta?.turnaround_days as number | undefined;
          if (turnaround) {
            lines.push(`⏱️ Ready in ${turnaround} day${turnaround > 1 ? 's' : ''}`);
          }
        } else {
          // Regular appointment: show date and time
          const endDateStr = d.end_date as string | undefined;
          if (endDateStr) {
            const endLabel = new Date(endDateStr + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { weekday: 'short', day: 'numeric', month: 'short' });
            lines.push(`📅 ${dateLabel} — ${endLabel}`);
          } else {
            lines.push(`📅 ${dateLabel}`);
          }
          const confirmBizMeta = (ctx.business?.metadata || {}) as Record<string, unknown>;
          const confirmUse12hr = confirmBizMeta.time_format !== '24hr';
          lines.push(`🕐 ${formatTime(d.time as string, confirmUse12hr)}`);
        }

        // Only show quantity if > 1 or not a drop-off
        if (!isDropoff || (d.party_size as number) > 1) {
          lines.push(`👥 ${d.party_size as number} ${labels.quantityLabel}`);
        }

        // Show guest list if provided
        const guestList = d.guest_list as Array<{ name: string }> | undefined;
        if (guestList && guestList.length > 0) {
          lines.push('👥 Guests:');
          for (const g of guestList) {
            lines.push(`  • ${g.name}`);
          }
        }

        // Show delivery/pickup option
        const deliveryName = d._delivery_zone_name as string | undefined;
        const deliveryPrice = (d._delivery_zone_price as number) || 0;
        if (deliveryName) {
          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          lines.push(`🚚 ${deliveryName}${deliveryPrice > 0 ? ` (${formatCurrency(deliveryPrice, cc)})` : ' (Free)'}`);
        }

        // Show price in confirmation
        const cc = (ctx.business?.country_code || 'NG') as CountryCode;
        const servicePrice = (d.service_price as number || 0) + deliveryPrice;
        const deposit = d.service_deposit as number || 0;
        if (servicePrice > 0) {
          if (deposit > 0 && deposit < servicePrice) {
            lines.push(`💰 Total: ${formatCurrency(servicePrice, cc)} (Deposit: ${formatCurrency(deposit, cc)})`);
          } else {
            lines.push(`💰 ${formatCurrency(servicePrice, cc)}`);
          }
        }
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
              { id: 'go_back', title: 'Cancel' },
            ],
          },
        ];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
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
        if (ctx.session.session_data._action === 'cancel') return 'select_capability';
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

    // ── Ask Referral Code (skipIf checks referral capability below) ──
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
          return { valid: false, errorMessage: 'Hmm, that code didn\'t work. Double-check it and try again, or type *skip* to continue without one.' };
        }

        // Prevent self-referral
        const normalizedFrom = ctx.from.startsWith('+') ? ctx.from : '+' + ctx.from;
        if (referral.referrer_phone === normalizedFrom || referral.referrer_phone === ctx.from) {
          return { valid: false, errorMessage: 'You cannot use your own referral code.' };
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
          { type: 'text', text: '📧 We\'ll send your booking confirmation to your email. Type your email or *skip* to skip:' },
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
          const { data: originalBooking, error: origError } = await ctx.supabase
            .from('bookings')
            .select('date, time')
            .eq('id', rescheduleId)
            .single();

          if (origError || !originalBooking) {
            logger.withContext({ op: 'scheduling.reschedule-fetch', ...safeLogErrorContext(origError) }).error('[SCHEDULING] Failed to fetch original booking for reschedule');
            return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];
          }

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
            logger.withContext({ op: 'scheduling.reschedule-update', ...safeLogErrorContext(rescheduleError) }).error('[SCHEDULING] Failed to reschedule booking');
            return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];
          }

          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale(cc), {
            weekday: 'long', day: 'numeric', month: 'long',
          });

          const labels = getCategoryLabels(ctx.business?.category || 'restaurant');
          const partyCount = (d.party_size as number) || 1;
          return [{
            type: 'text',
            text: `✅ *Booking Rescheduled!*\n\n📅 ${dateLabel} at ${d.time as string}\n👥 ${partyCount} ${labels.quantityLabel}\n\nSee you then!`,
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
          return [{ type: 'text', text: "We couldn't create your account. Send *Hi* to start over." }];
        }

        // Get payment amount
        const serviceDeposit = (d.service_deposit as number) || 0;
        const servicePrice = (d.service_price as number) || 0;
        const partySize = (d.party_size as number) || 1;

        // Apply promo discount to the service price before calculating deposit
        const promoDiscount = (d._promo_discount as number) || 0;
        const finalServicePrice = Math.max(0, servicePrice - promoDiscount);

        // For restaurants: check business deposit_per_guest
        let depositPerGuest = 0;
        if (ctx.business) {
          const { data: biz, error: bizDepositErr } = await ctx.supabase
            .from('businesses')
            .select('deposit_per_guest')
            .eq('id', ctx.business.id)
            .single();
          if (bizDepositErr) {
            logger.withContext({ op: 'scheduling.deposit-per-guest', ...safeLogErrorContext(bizDepositErr) }).error('[SCHEDULING] Failed to fetch deposit_per_guest');
          }
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
          // Explicit deposit set on the service (not discounted — deposit is a fixed amount)
          totalDeposit = serviceDeposit;
        } else if (depositPerGuest > 0) {
          // Per-guest deposit (restaurants)
          totalDeposit = depositPerGuest * partySize;
        } else if (isPrepay && finalServicePrice > 0) {
          // Service-based businesses: charge full service price (after promo discount)
          totalDeposit = finalServicePrice * partySize;
        } else {
          totalDeposit = 0;
        }

        // ── T&C cancel check (before gate) ──
        if (d._terms_cancelled) {
          return [{ type: 'text', text: 'No problem! Your booking has been cancelled. Send *Hi* to start over.' }];
        }

        // ── T&C gate (before creating record) ──
        if (!d._terms_accepted && totalDeposit > 0 && ctx.business?.metadata?.require_terms_before_payment !== false) {
          d._pending_deposit = totalDeposit;
          await ctx.supabase.from('bot_sessions')
            .update({ session_data: d })
            .eq('id', ctx.session.id);
          { const meta = (ctx.business?.metadata || {}) as Record<string, unknown>; return getTermsPrompt(ctx.business?.name || 'Business', meta.terms_text as string | undefined, ctx.business?.slug, meta.terms_url as string | undefined); }
        }

        // ── Tier limit check for bookings ──
        if (ctx.business && !(d.booking_id && d.reference_code)) {
          const tierResult = await checkTierLimit(
            ctx.supabase,
            ctx.business.id,
            'bookings',
            ctx.business.subscription_tier,
          );
          if (!tierResult.allowed) {
            return [{ type: 'text', text: await ctx.t('This account has reached its monthly limit. Please contact the business owner.') }];
          }
          if (tierResult.softBlock) {
            createNotification(ctx.supabase, {
              businessId: ctx.business.id,
              type: 'tier_limit_warning',
              channel: 'in_app',
              subject: 'Booking limit approaching',
              body: `You've used ${tierResult.current}/${tierResult.limit} bookings this month. Upgrade for more.`,
            }).catch(err => logger.withContext({ op: 'scheduling.tier-limit-notify', ...safeLogErrorContext(err) }).error('[SCHEDULING] Failed to create tier limit notification'));
          }
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
          location_id: (d.location_id as string) || null,
        };

        // If booking already exists (e.g. retry_payment), skip the RPC and reuse existing booking
        const isNewBooking = !(d.booking_id && d.reference_code);
        let booking: { id: string; reference_code: string };
        if (!isNewBooking) {
          // Reuse existing booking — just proceed to payment initiation
          booking = { id: d.booking_id as string, reference_code: d.reference_code as string };
        } else {
          // Use atomic booking function to prevent double-booking race condition
          const svcMetaBooking = d._service_metadata as Record<string, unknown> | undefined;
          const maxCapacity = svcMetaBooking?.is_dropoff ? 9999 : ((d._service_max_capacity as number) || 1);
          const isAppointment = d._is_appointment === true;
          const { data: slotResult, error: slotError } = await ctx.supabase
            .rpc('book_slot_atomic' as string, {
              p_business_id: ctx.business!.id,
              p_user_id: userId,
              p_service_id: isAppointment ? null : ((d.service_id as string) || null),
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
              p_location_id: (d.location_id as string) || null,
              p_appointment_id: isAppointment ? ((d.service_id as string) || null) : null,
              p_buffer_minutes: (d._service_buffer_minutes as number) || 0,
              p_duration: (d.service_duration as number) || 30,
            })
            .single() as { data: { booking_id: string; reference_code: string; slot_available: boolean } | null; error: unknown };

          if (slotError || !slotResult) {
            logger.withContext({ op: 'scheduling.create-booking', ...safeLogErrorContext(slotError) }).error('[SCHEDULING] Failed to create booking');
            return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];
          }

          if (!slotResult.slot_available) {
            // For classes, offer waitlist if capability enabled
            const isClassBooking = d._service_is_class === true;
            if (isClassBooking) {
              const caps = await getEnabledCapabilities(ctx.supabase, ctx.business!.id);
              if (caps.includes('waitlist')) {
                return [{
                  type: 'buttons',
                  body: 'This class is full! Would you like to join the waitlist? We\'ll notify you if a spot opens up.',
                  buttons: [
                    { id: 'wl_join', title: 'Join Waitlist' },
                    { id: 'go_back', title: 'No Thanks' },
                  ],
                }];
              }
              return [{ type: 'text', text: 'Sorry, this class is full. Send *Hi* to try a different class or time.' }];
            }
            return [{ type: 'text', text: 'Sorry, that slot was just taken by another customer. Send *Hi* to pick a different time.' }];
          }

          booking = { id: slotResult.booking_id, reference_code: slotResult.reference_code };

          // Save pre-booking question answers if any
          const pbqAnswers = d._pbq_answers as Record<string, string> | undefined;
          if (pbqAnswers && Object.keys(pbqAnswers).length > 0) {
            await ctx.supabase
              .from('bookings')
              .update({ metadata: { custom_answers: pbqAnswers } })
              .eq('id', slotResult.booking_id);
          }
        }

        if (isNewBooking) {
          // Increment promo code usage atomically
          if (d._promo_id) {
            await ctx.supabase.rpc('increment_promo_usage', { p_code_id: d._promo_id as string });
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
        }

        d.booking_id = booking.id;
        d.reference_code = booking.reference_code;
        d.deposit_amount = totalDeposit;
        // Store full service total for platform fee calculation (fee is on full price, not deposit)
        d.total_amount = finalServicePrice * partySize;

        // Store guest list if provided (group bookings)
        if (isNewBooking && Array.isArray(d.guest_list) && (d.guest_list as Array<{name: string}>).length > 0) {
          await ctx.supabase
            .from('bookings')
            .update({ guest_list: d.guest_list })
            .eq('id', booking.id);
        }

        if (isNewBooking) {
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
              .catch(err => logger.withContext({ op: 'scheduling.booking-rule', ...safeLogErrorContext(err) }).error('[SCHEDULING] booking_created rule error'));
            triggerSequences(ctx.supabase, ctx.business.id, 'after_booking', ctx.from, ruleCtx)
              .catch(err => logger.withContext({ op: 'scheduling.after-booking-sequence', ...safeLogErrorContext(err) }).error('[SCHEDULING] after_booking sequence error'));
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
              logger.withContext({ op: 'scheduling.reserve-slot', ...safeLogErrorContext(err) }).error('[SCHEDULING] reserve_booking_slot error (non-fatal)');
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
        }

        await ctx.supabase
          .from('bot_sessions')
          .update({ session_data: d })
          .eq('id', ctx.session.id);

        const labels = getCategoryLabels(ctx.business?.category || 'restaurant');
        const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
          weekday: 'long', day: 'numeric', month: 'long',
        });

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
                  { id: 'go_back', title: 'Cancel' },
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
            gatewayOverride: ctx.business?.payment_gateway || null,
            businessId: ctx.business?.id,
          });

          // Check if business qualifies for direct bank transfer option
          const cc2 = (ctx.business?.country_code || 'NG') as CountryCode;
          const { qualifies: _btQualifies, bankAccount, platformSettings: ps } = await checkBankTransferEligibility(ctx.supabase, {
            businessId: ctx.business!.id,
            countryCode: cc2,
            subscriptionTier: ctx.business?.subscription_tier || 'free',
            amount: totalDeposit,
          });

          if (paymentResult) {
            d.payment_reference = paymentResult.reference;

            if (bankAccount) {
              const transferRef = await createPendingTransfer(ctx.supabase, {
                businessId: ctx.business!.id,
                entityId: { booking_id: booking.id },
                customerPhone: ctx.from,
                customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
                amount: totalDeposit,
                countryCode: cc2,
                transferExpiryHours: ps.transfer_expiry_hours,
              });
              d.bank_transfer_reference = transferRef;
              d.bank_transfer_offered = true;
              d.bank_transfer_amount = totalDeposit;

              await ctx.supabase
                .from('bot_sessions')
                .update({ session_data: d, current_step: 'payment' })
                .eq('id', ctx.session.id);

              // Dual-option payment message: online + bank transfer
              const dualPaymentLines = [
                `📋 *${labels.receiptTitle}!*`,
                '',
                `${labels.confirmationEmoji} ${ctx.business?.name}`,
                d._location_name ? `📍 ${d._location_name as string}` : '',
                d.staff_name ? `👤 With: ${d.staff_name as string}` : '',
                `📅 ${dateLabel}`,
                `🕐 ${d.time as string}`,
                `👥 ${partySize} ${labels.quantityLabel}`,
                `🔑 Ref: *${booking.reference_code}*`,
                '',
                `💳 *${isPrepay ? 'Payment' : 'Deposit'} Required: ${formatCurrency(totalDeposit, cc2)}*`,
                '',
                `*Option 1 — Pay Online* 👇`,
                paymentResult.url,
                '',
                `*Option 2 — Bank Transfer* 🏦`,
                formatBankTransferBlock(bankAccount, formatCurrency(totalDeposit, cc2), transferRef),
              ].filter(Boolean);

              return [
                {
                  type: 'text',
                  text: dualPaymentLines.join('\n'),
                },
                {
                  type: 'buttons',
                  body: 'Tap below after paying:',
                  buttons: [...DUAL_OPTION_BUTTONS],
                },
              ];
            }

            // Standard payment flow (no bank transfer option)
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
                  d._location_name ? `📍 ${d._location_name as string}` : '',
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
                  `⚠️ Your confirmation will arrive automatically after payment.`,
                ].join('\n'),
              },
              {
                type: 'buttons',
                body: "Your confirmation will arrive automatically after payment. If it doesn't, tap below:",
                buttons: [
                  { id: 'i_paid', title: "I've Paid" },
                  { id: 'retry_payment', title: 'Get New Link' },
                  { id: 'go_back', title: 'Cancel' },
                ],
              },
            ];
          }

          // Payment gateway failed — but bank transfer may still be available
          if (bankAccount) {
            const transferRef = await createPendingTransfer(ctx.supabase, {
              businessId: ctx.business!.id,
              entityId: { booking_id: booking.id },
              customerPhone: ctx.from,
              customerName: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
              amount: totalDeposit,
              countryCode: cc2,
              transferExpiryHours: ps.transfer_expiry_hours,
            });
            d.bank_transfer_reference = transferRef;
            d.bank_transfer_offered = true;
            d.bank_transfer_amount = totalDeposit;

            await ctx.supabase
              .from('bot_sessions')
              .update({ session_data: d, current_step: 'payment' })
              .eq('id', ctx.session.id);

            const bankOnlyLines = [
              `🏦 *Bank Transfer Payment*`,
              '',
              `${labels.confirmationEmoji} ${ctx.business?.name}`,
              d._location_name ? `📍 ${d._location_name as string}` : '',
              d.staff_name ? `👤 With: ${d.staff_name as string}` : '',
              `📅 ${dateLabel}`,
              `🕐 ${d.time as string}`,
              `👥 ${partySize} ${labels.quantityLabel}`,
              `💰 ${formatCurrency(totalDeposit, cc2)}`,
              `🔑 Ref: *${booking.reference_code}*`,
              '',
              `Transfer to:`,
              formatBankTransferBlock(bankAccount, formatCurrency(totalDeposit, cc2), transferRef),
            ].filter(Boolean);

            return [
              {
                type: 'text',
                text: bankOnlyLines.join('\n'),
              },
              {
                type: 'buttons',
                body: 'Tap below after transferring:',
                buttons: [...BANK_ONLY_BUTTONS],
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
                { id: 'cancel_booking', title: 'Cancel Booking' },
              ],
            },
          ];
        }

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
            subscriptionTier: ctx.business?.subscription_tier,
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
          }).catch(err => logger.withContext({ op: 'scheduling.owner-notify', ...safeLogErrorContext(err) }).error('[SCHEDULING] Owner notification error'));

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
              }).catch(err => logger.withContext({ op: 'scheduling.staff-notify', ...safeLogErrorContext(err) }).error('[SCHEDULING] Staff notify error'));
            }).catch(err => logger.withContext({ op: 'scheduling.staff-notify-import', ...safeLogErrorContext(err) }).error('[SCHEDULING] Staff notify import error'));
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
          }).catch(err => logger.withContext({ op: 'scheduling.post-completion', ...safeLogErrorContext(err) }).error('[SCHEDULING] Post-completion error'));
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
          } catch (err) { logger.withContext({ op: 'scheduling.capabilities-tips', ...safeLogErrorContext(err) }).warn('[SCHEDULING] Failed to load capabilities for tips'); }
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
              duration_minutes: d.service_duration as number | undefined,
              reference_code: booking.reference_code,
            }).catch(err => logger.withContext({ op: 'scheduling.calendar-sync', ...safeLogErrorContext(err) }).error('[SCHEDULING] Calendar sync error'));
          }).catch(err => logger.withContext({ op: 'scheduling.google-calendar-import', ...safeLogErrorContext(err) }).error('[SCHEDULING] Failed to import google-calendar module'));
        }

        // Add calendar links for date+time bookings (not drop-off services)
        const svcMeta = d._service_metadata as Record<string, unknown> | undefined;
        const isDropoff = svcMeta?.is_dropoff === true;
        const calendarLinks = (!isDropoff && d.date && d.time) ? getCalendarLinksText({
          businessName: ctx.business?.name || 'Business',
          businessAddress: undefined,
          serviceName: (d.service_name as string) || undefined,
          referenceCode: booking.reference_code,
          date: d.date as string,
          time: d.time as string,
          durationMinutes: (d.service_duration as number) || 60,
        }) : '';

        return [{ type: 'text', text: message + calendarLinks + helpText }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
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
        if (input === 'cancel_booking' || input === 'go_back') {
          // Cancel the pending booking if one was created
          const d = ctx.session.session_data;
          if (d.booking_id) {
            await ctx.supabase.from('bookings').update({ status: 'cancelled' }).eq('id', d.booking_id as string);
          }
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('Booking cancelled. Send *Hi* to start over.') });
          return { valid: true, data: { _action: 'cancel' } };
        }
        return { valid: true };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        // Cancelled booking — end flow
        if (d._action === 'cancel') return 'select_capability';
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
          // Check if saved card has a PIN — require verification
          const savedMethod = await getSavedPaymentMethod(ctx.supabase, ctx.business!.id, ctx.from);
          if (!savedMethod) {
            return { valid: true, data: { _skip_saved_card: true } };
          }

          // Check if card has a PIN set
          const { data: cardWithPin } = await ctx.supabase
            .from('saved_payment_methods')
            .select('pin_hash, pin_attempts, pin_locked_until')
            .eq('id', savedMethod.id)
            .single();

          if (cardWithPin?.pin_hash) {
            // Card has a PIN — ask for verification
            if (cardWithPin.pin_locked_until && new Date(cardWithPin.pin_locked_until) > new Date()) {
              await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('🔒 This card is locked due to too many wrong PIN attempts. Type *remove card* to delete it and save again.') });
              return { valid: true, data: { _skip_saved_card: true } };
            }
            // Move to PIN verification step
            await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('🔒 Enter your *4-digit card PIN* to confirm payment:') });
            return { valid: true, data: { _awaiting_card_pin: true, _saved_method_id: savedMethod.id } };
          }

          // No PIN (legacy saved card) — charge directly
          const amount = d._pending_deposit as number;
          const bookingId = d.booking_id as string;
          const refCode = d.reference_code as string;
          const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
          const email = (d.email as string) || `${phone.replace('+', '')}@${process.env.FALLBACK_EMAIL_DOMAIN || 'whatsapp.waaiio.com'}`;

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
          return { valid: true, data: { _skip_saved_card: true, _saved_card_error: result.message } };
        }

        // Handle PIN verification for saved card
        if (d._awaiting_card_pin && /^\d{4}$/.test(action)) {
          const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
          const { createHash } = await import('crypto');
          const pinHash = createHash('sha256').update(`${action}:${phone}`).digest('hex');

          const { data: card } = await ctx.supabase
            .from('saved_payment_methods')
            .select('id, pin_hash, pin_attempts')
            .eq('id', d._saved_method_id as string)
            .single();

          if (!card || card.pin_hash !== pinHash) {
            const attempts = (card?.pin_attempts || 0) + 1;
            if (card) {
              const lockUntil = attempts >= 3 ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;
              await ctx.supabase.from('saved_payment_methods')
                .update({ pin_attempts: attempts, ...(lockUntil ? { pin_locked_until: lockUntil } : {}) })
                .eq('id', card.id);
            }
            if (attempts >= 3) {
              await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('🔒 Too many wrong attempts. Card locked for 30 minutes. Type *remove card* to delete and re-save.') });
              return { valid: true, data: { _skip_saved_card: true, _awaiting_card_pin: false } };
            }
            await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(`Wrong PIN. ${3 - attempts} attempt${3 - attempts !== 1 ? 's' : ''} remaining. Try again:`) });
            return { valid: false };
          }

          // PIN correct — reset attempts and charge
          await ctx.supabase.from('saved_payment_methods').update({ pin_attempts: 0 }).eq('id', card.id);

          const savedMethod = await getSavedPaymentMethod(ctx.supabase, ctx.business!.id, ctx.from);
          if (!savedMethod) return { valid: true, data: { _skip_saved_card: true, _awaiting_card_pin: false } };

          const amount = d._pending_deposit as number;
          const bookingId = d.booking_id as string;
          const refCode = d.reference_code as string;
          const email = (d.email as string) || `${phone.replace('+', '')}@${process.env.FALLBACK_EMAIL_DOMAIN || 'whatsapp.waaiio.com'}`;

          const result = await chargeSavedCard(ctx.supabase, {
            savedMethod, amount,
            currency: getCurrencyCode((ctx.business?.country_code || 'NG') as CountryCode),
            email, reference: `${refCode}-saved`,
            businessId: ctx.business!.id, bookingId,
          });

          if (result.success) {
            return { valid: true, data: { _saved_card_paid: true, _action: 'payment_confirmed', _awaiting_card_pin: false } };
          }
          return { valid: true, data: { _skip_saved_card: true, _saved_card_error: result.message, _awaiting_card_pin: false } };
        }

        // If awaiting PIN but input isn't 4 digits
        if (d._awaiting_card_pin) {
          if (action === 'cancel' || action === 'go_back') {
            return { valid: true, data: { _skip_saved_card: true, _awaiting_card_pin: false } };
          }
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('Please enter your *4-digit PIN* or type *cancel*:') });
          return { valid: false };
        }

        if (action === 'pay_new') {
          return { valid: true, data: { _skip_saved_card: true } };
        }

        if (action === 'cancel' || action === 'cancel_booking' || action === 'go_back') {
          return { valid: true, data: { _action: 'cancel' } };
        }

        return { valid: false, errorMessage: 'Please select a payment option.' };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        if (d._action === 'cancel') return 'select_capability';
        if (d._saved_card_paid) {
          // Update booking status to confirmed
          if (d.booking_id) {
            await ctx.supabase
              .from('bookings')
              .update({ status: 'confirmed', deposit_status: 'paid' })
              .eq('id', d.booking_id as string);
          }

          // Record platform fee now that payment is confirmed (fee on full service total, not deposit)
          if (ctx.business && d.total_amount) {
            const feeAmount = (d.total_amount as number) || 0;
            if (feeAmount > 0) {
              const isInTrial = (ctx.business.subscription_tier === 'free') && new Date(ctx.business.trial_ends_at) > new Date();
              recordPlatformFee(ctx.supabase, {
                businessId: ctx.business.id,
                bookingId: d.booking_id as string,
                transactionAmount: feeAmount,
                tier: ctx.business.subscription_tier as SubscriptionTier,
                isInTrial,
              }).catch(err => logger.withContext({ op: 'scheduling.saved-card-platform-fee', ...safeLogErrorContext(err) }).error('[SCHEDULING] saved card recordPlatformFee error'));
            }
          }

          // Notify owner and run post-completion
          if (ctx.business) {
            const labels = getCategoryLabels(ctx.business.category || 'restaurant');
            const paidCC = (ctx.business.country_code || 'NG') as CountryCode;
            const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale(paidCC), {
              weekday: 'long', day: 'numeric', month: 'long',
            });
            const custName = d.book_for_other
              ? (d.other_name as string)
              : `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Customer';
            const paidAmount = (d.deposit_amount as number) || 0;

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
              quantity: (d.party_size as number) || 1,
              quantityLabel: labels.quantityLabel,
              amount: paidAmount || undefined,
            }).catch(err => logger.withContext({ op: 'scheduling.saved-card-owner-notify', ...safeLogErrorContext(err) }).error('[SCHEDULING] saved card owner notification error'));

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
            }).catch(err => logger.withContext({ op: 'scheduling.saved-card-post-completion', ...safeLogErrorContext(err) }).error('[SCHEDULING] saved card post-completion error'));
          }

          return null; // Payment complete, end flow
        }
        // Saved card failed or user chose new card — go to regular payment
        return 'create_booking'; // Re-enter create_booking which will skip saved card this time
      },
    },

    // ── Payment Check ──
    {
      id: 'payment',
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
          body: "Your confirmation will arrive automatically after payment. If it doesn't, tap below:",
          buttons: [
            { id: 'i_paid', title: "I've Paid" },
            { id: 'retry_payment', title: 'Get New Link' },
            { id: 'go_back', title: 'Cancel' },
          ],
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (input === 'retry_payment') {
          return { valid: true, data: { _retry_payment: true } };
        }
        const text = input.toLowerCase();
        const d = ctx.session.session_data;

        if ((text === 'cancel' || text === 'go_back')) {
          const bookingId = d.booking_id as string;
          if (bookingId) {
            await ctx.supabase
              .from('bookings')
              .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'diner' })
              .eq('id', bookingId);
          }
          // Also cancel the pending_transfer if one exists
          if (d.bank_transfer_reference) {
            await ctx.supabase
              .from('pending_transfers')
              .update({ status: 'cancelled' })
              .eq('reference_code', d.bank_transfer_reference as string);
          }
          await ctx.sender.sendText({
            to: ctx.from,
            text: await ctx.t(`Booking at *${ctx.business?.name || 'business'}* has been cancelled. No payment was taken.\n\nSend *Hi* to start over.`),
          });
          return { valid: true, data: { _action: 'cancel' } };
        }

        // ── Bank transfer proof: image uploaded — OCR pre-verification ──
        if (ctx.mediaType === 'image' && ctx.mediaUrl && d.bank_transfer_reference) {
          const transferRef = d.bank_transfer_reference as string;
          const expectedAmount = d.bank_transfer_amount as number;
          const btCC = (ctx.business?.country_code || 'NG') as CountryCode;
          const currency = getCurrencyCode(btCC);

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
              ? `✅ AI verified: amount ${formatCurrency(expectedAmount, btCC)} and ref *${transferRef}* match the receipt.`
              : `⚠️ AI could not verify — please check the receipt manually.`;

            notifyOwnerNewPayment({
              supabase: ctx.supabase,
              sender: ctx.sender,
              businessId: ctx.business.id,
              businessName: ctx.business.name,
              countryCode: btCC,
              referenceCode: transferRef,
              customerName: custName,
              amount: expectedAmount,
              categoryName: `${d.service_name as string} (Bank Transfer)`,
            }).catch(err => logger.withContext({ op: 'scheduling.transfer-notify', ...safeLogErrorContext(err) }).error('[SCHEDULING] Transfer notify error'));

            createNotification(ctx.supabase, {
              businessId: ctx.business.id,
              bookingId: d.booking_id as string,
              type: 'transfer_proof_received',
              channel: 'whatsapp',
              body: `Transfer proof received from ${custName} for ${formatCurrency(expectedAmount, btCC)}. Ref: ${transferRef}. ${ocrStatus}\n\nConfirm in Dashboard → Pending Transfers.`,
            }).catch(err => logger.withContext({ op: 'scheduling.transfer-notification', ...safeLogErrorContext(err) }).error('[SCHEDULING] Transfer notification error'));
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

        if (text === 'i_paid' || text === 'i_paid_online' || text === 'paid' || text === 'done' || text === 'check' || text === "i've paid") {
          const ref = ctx.session.session_data.payment_reference as string;
          if (!ref) return { valid: true, data: { _action: 'cancel' } };

          const verified = await verifyPayment(ctx.supabase, ref, (ctx.business?.country_code || 'NG') as CountryCode);
          if (verified) {
            const d = ctx.session.session_data;

            // Check if webhook already confirmed this booking (avoid double-processing)
            const { data: currentBooking } = await ctx.supabase
              .from('bookings')
              .select('status, deposit_status')
              .eq('id', d.booking_id as string)
              .single();

            if (currentBooking?.deposit_status === 'paid') {
              // Webhook already handled DB + post-completion — just show full confirmation to user
              const labels2 = getCategoryLabels(ctx.business?.category || 'restaurant');
              const dateLabel2 = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { weekday: 'long', day: 'numeric', month: 'long' });
              const paidCC2 = (ctx.business?.country_code || 'NG') as CountryCode;
              const calLinks2 = (d.date && d.time) ? getCalendarLinksText({
                businessName: ctx.business?.name || 'Business',
                businessAddress: undefined,
                serviceName: (d.service_name as string) || undefined,
                referenceCode: d.reference_code as string,
                date: d.date as string,
                time: d.time as string,
                durationMinutes: (d.service_duration as number) || 60,
              }) : '';
              const confirmLines2 = [
                `✅ *Payment Confirmed!*`,
                '',
                `Your ${labels2.entityName} at *${ctx.business?.name}* is fully confirmed.`,
                d.service_name ? `📋 ${d.service_name as string}` : null,
                `📅 ${dateLabel2} at ${d.time as string}`,
                `👥 ${d.party_size as number} ${labels2.quantityLabel}`,
                (d.deposit_amount as number) > 0 ? `💰 ${formatCurrency(d.deposit_amount as number, paidCC2)}` : null,
                `🔑 Ref: *${d.reference_code as string}*`,
                '',
                'See you there!',
                calLinks2 ? calLinks2 : null,
                '',
                '💡 *What you can do:*',
                '• Type *my bookings* to view your appointments',
                '• Type *reschedule* to change the date/time',
                '• Type *receipt* to get your payment receipt',
              ].filter(Boolean);
              await ctx.sender.sendText({ to: ctx.from, text: await ctx.t(confirmLines2.join('\n')) });
              return { valid: true, data: { _action: 'already_confirmed' } };
            }

            // Update booking status to confirmed
            await ctx.supabase
              .from('bookings')
              .update({ status: 'confirmed', deposit_status: 'paid' })
              .eq('id', d.booking_id as string);

            // Record platform fee now that payment is confirmed (fee on full service total, not deposit)
            if (ctx.business) {
              const feeAmount = (d.total_amount as number) || 0;
              if (feeAmount > 0) {
                const isInTrial = (ctx.business.subscription_tier === 'free') && new Date(ctx.business.trial_ends_at) > new Date();
                recordPlatformFee(ctx.supabase, {
                  businessId: ctx.business.id,
                  bookingId: d.booking_id as string,
                  transactionAmount: feeAmount,
                  tier: ctx.business.subscription_tier as SubscriptionTier,
                  isInTrial,
                }).catch(err => logger.withContext({ op: 'scheduling.platform-fee', ...safeLogErrorContext(err) }).error('[SCHEDULING] recordPlatformFee error'));
              }
            }

            const labels = getCategoryLabels(ctx.business?.category || 'restaurant');
            const dateLabel = new Date((d.date as string) + 'T00:00').toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), {
              weekday: 'long', day: 'numeric', month: 'long',
            });

            const paidAmount = (d.deposit_amount as number) || 0;
            const paidCC = (ctx.business?.country_code || 'NG') as CountryCode;
            const calLinksPayment = (d.date && d.time) ? getCalendarLinksText({
              businessName: ctx.business?.name || 'Business',
              businessAddress: undefined,
              serviceName: (d.service_name as string) || undefined,
              referenceCode: d.reference_code as string,
              date: d.date as string,
              time: d.time as string,
              durationMinutes: (d.service_duration as number) || 60,
            }) : '';
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
              'See you there!',
              calLinksPayment ? calLinksPayment : null,
            ].filter(Boolean);

            const payTips = '\n\n💡 *What you can do:*\n• Type *my bookings* to view your appointments\n• Type *reschedule* to change the date/time\n• Type *cancel* to cancel\n• Type *receipt* to get your payment receipt';

            await ctx.sender.sendText({
              to: ctx.from,
              text: await ctx.t(confirmLines.join('\n') + payTips),
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
              }).catch(err => logger.withContext({ op: 'scheduling.payment-owner-notify', ...safeLogErrorContext(err) }).error('[SCHEDULING] Owner notification error'));

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
                  }).catch(err => logger.withContext({ op: 'scheduling.payment-staff-notify', ...safeLogErrorContext(err) }).error('[SCHEDULING] Staff notify error'));
                }).catch(err => logger.withContext({ op: 'scheduling.payment-staff-notify-import', ...safeLogErrorContext(err) }).error('[SCHEDULING] Staff notify import error'));
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
              }).catch(err => logger.withContext({ op: 'scheduling.payment-post-completion', ...safeLogErrorContext(err) }).error('[SCHEDULING] Post-completion error'));

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
              }, pmtSendMsg).catch(err => logger.withContext({ op: 'scheduling.payment-received-rule', ...safeLogErrorContext(err) }).error('[SCHEDULING] payment_received rule error'));
            }

            return { valid: true, data: { _action: 'payment_confirmed' } };
          }

          return { valid: false, errorMessage: "Payment not yet received. The link may have expired — tap *Get New Link* for a fresh one." };
        }

        return { valid: false, errorMessage: "Tap *I've Paid* after completing payment, or *Cancel* to cancel." };
      },
      async next(ctx: FlowContext) {
        const d = ctx.session.session_data;
        if (d._retry_payment) {
          delete d._retry_payment;
          return 'create_booking';
        }
        return null; // All paths end the flow
      },
    },
  ],
};
