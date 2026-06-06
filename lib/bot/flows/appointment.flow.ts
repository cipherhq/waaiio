import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';

/**
 * Appointment flow: calendar-based bookings with date, time, and staff.
 *
 * Only the service selection step is different from the scheduling flow —
 * it queries the `appointments` table instead of `services`.
 * After selection, it routes into the scheduling flow's shared steps
 * (select_date, select_time, select_staff, etc.) via cross-flow lookup.
 */

const selectAppointmentStep: FlowStepConfig = {
  id: 'select_appointment',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

    const { data: appointments } = await ctx.supabase
      .from('appointments')
      .select('id, name, price, deposit_amount, duration_minutes, max_capacity, auto_approve, requires_staff, staff_ids, allow_staff_selection, available_days, available_from, available_to')
      .eq('business_id', ctx.business.id)
      .eq('is_active', true)
      .order('sort_order');

    if (!appointments || appointments.length === 0) {
      return [{ type: 'text', text: 'No appointments are available right now. Please check back later!' }];
    }

    // Auto-select if only one appointment type
    if (appointments.length === 1) {
      const a = appointments[0];
      ctx.session.session_data.service_id = a.id;
      ctx.session.session_data.service_name = a.name;
      ctx.session.session_data.service_price = a.price;
      ctx.session.session_data.service_deposit = a.deposit_amount || 0;
      ctx.session.session_data.service_duration = a.duration_minutes;
      ctx.session.session_data._service_requires_staff = a.requires_staff;
      ctx.session.session_data._service_staff_ids = a.staff_ids;
      ctx.session.session_data._service_allow_staff_selection = a.allow_staff_selection;
      ctx.session.session_data._service_available_days = a.available_days;
      ctx.session.session_data._service_available_from = a.available_from;
      ctx.session.session_data._service_available_to = a.available_to;
      ctx.session.session_data._service_max_capacity = a.max_capacity || 1;
      ctx.session.session_data._auto_approve = a.auto_approve !== false;
      ctx.session.session_data._is_appointment = true;
      ctx.session.session_data.skip_service = true;
      return [];
    }

    const cc = (ctx.business.country_code || 'NG') as CountryCode;
    return [{
      type: 'list',
      title: 'Book Appointment',
      body: `What would you like to book at ${ctx.business.name}?`,
      buttonLabel: 'View Options',
      items: appointments.map(a => {
        const priceLabel = a.price > 0 ? formatCurrency(a.price, cc) : 'Free';
        const durationLabel = a.duration_minutes ? `${a.duration_minutes}min` : '';
        // If name fits in 24 chars, use as-is. Otherwise shorten title and put full name in description.
        const name = a.name || 'Appointment';
        if (name.length <= 24) {
          return { title: name, description: [priceLabel, durationLabel].filter(Boolean).join(' · '), postbackText: a.id };
        }
        return { title: name.slice(0, 23) + '…', description: [name, priceLabel, durationLabel].filter(Boolean).join(' · ').slice(0, 72), postbackText: a.id };
      }),
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    // Try exact ID match first
    const { data: appointment } = await ctx.supabase
      .from('appointments')
      .select('id, name, price, deposit_amount, duration_minutes, max_capacity, auto_approve, requires_staff, staff_ids, allow_staff_selection, available_days, available_from, available_to')
      .eq('id', input)
      .eq('business_id', ctx.business!.id)
      .eq('is_active', true)
      .maybeSingle();

    if (appointment) {
      return {
        valid: true,
        data: {
          service_id: appointment.id,
          service_name: appointment.name,
          service_price: appointment.price,
          service_deposit: appointment.deposit_amount || 0,
          service_duration: appointment.duration_minutes,
          _service_requires_staff: appointment.requires_staff,
          _service_staff_ids: appointment.staff_ids,
          _service_allow_staff_selection: appointment.allow_staff_selection,
          _service_available_days: appointment.available_days,
          _service_available_from: appointment.available_from,
          _service_available_to: appointment.available_to,
          _service_max_capacity: appointment.max_capacity || 1,
          _auto_approve: appointment.auto_approve !== false,
          _is_appointment: true,
        },
      };
    }

    // Fuzzy match by name
    const { data: all } = await ctx.supabase
      .from('appointments')
      .select('id, name, price, deposit_amount, duration_minutes, max_capacity, auto_approve, requires_staff, staff_ids, allow_staff_selection, available_days, available_from, available_to')
      .eq('business_id', ctx.business!.id)
      .eq('is_active', true);

    if (all) {
      const lower = input.toLowerCase();
      const match = all.find(a => a.name.toLowerCase().includes(lower));
      if (match) {
        return {
          valid: true,
          data: {
            service_id: match.id,
            service_name: match.name,
            service_price: match.price,
            service_deposit: match.deposit_amount || 0,
            service_duration: match.duration_minutes,
            _service_requires_staff: match.requires_staff,
            _service_staff_ids: match.staff_ids,
            _service_allow_staff_selection: match.allow_staff_selection,
            _service_available_days: match.available_days,
            _service_available_from: match.available_from,
            _service_available_to: match.available_to,
            _service_max_capacity: match.max_capacity || 1,
            _auto_approve: match.auto_approve !== false,
            _is_appointment: true,
          },
        };
      }
    }

    return { valid: false, errorMessage: 'That option is not available. Tap one of the choices above.' };
  },

  async next() {
    // Route into the scheduling flow's shared steps
    // Order: date → staff → time → confirm → payment
    return 'select_date';
  },

  async skipIf(ctx: FlowContext) {
    return !!ctx.session.session_data.skip_service;
  },
};

export const appointmentFlow: FlowDefinition = {
  type: 'scheduling', // Uses scheduling infrastructure (date/time/staff/payment)
  steps: [selectAppointmentStep],
};
