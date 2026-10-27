import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import { buildListItem } from '../utils/truncate';

/**
 * Table Reservation flow: seating-based bookings for restaurants/lounges.
 *
 * Only the resource selection step is unique — it queries the `seating_resources`
 * table instead of `services` or `appointments`.
 * After selection, it routes into the scheduling flow's shared steps
 * (select_date, select_time, select_quantity, collect_name, confirm_booking)
 * via cross-flow lookup.
 *
 * The `_is_table_reservation` flag tells the confirm_booking step to call
 * `book_table_atomic` instead of `book_slot_atomic`.
 */

interface SeatingResource {
  id: string;
  name: string;
  resource_type: string;
  capacity: number;
  min_party_size: number;
  section: string | null;
  deposit_amount: number;
  reservation_duration_minutes: number;
  description: string | null;
  available_days: string[] | null;
  available_from: string | null;
  available_to: string | null;
}

/** Build validate() return data for a seating resource */
function buildSelectionData(r: SeatingResource): Record<string, unknown> {
  return {
    seating_resource_id: r.id,
    seating_resource_name: r.name,
    _seating_capacity: r.capacity,
    _seating_min_party: r.min_party_size,
    _seating_deposit: r.deposit_amount,
    _seating_duration: r.reservation_duration_minutes,
    _seating_available_days: r.available_days,
    _seating_available_from: r.available_from,
    _seating_available_to: r.available_to,
    _service_available_days: r.available_days,
    _service_available_from: r.available_from,
    _service_available_to: r.available_to,
    service_deposit: r.deposit_amount,
    service_duration: r.reservation_duration_minutes,
    service_price: r.deposit_amount,
    _service_price_is_variable: true,
    _service_max_capacity: r.capacity,
    _is_table_reservation: true,
  };
}

/** Set session data for a selected seating resource — shared by skipIf */
function setSeatingSessionData(ctx: FlowContext, r: SeatingResource) {
  ctx.session.session_data.seating_resource_id = r.id;
  ctx.session.session_data.seating_resource_name = r.name;
  ctx.session.session_data._seating_capacity = r.capacity;
  ctx.session.session_data._seating_min_party = r.min_party_size;
  ctx.session.session_data._seating_deposit = r.deposit_amount;
  ctx.session.session_data._seating_duration = r.reservation_duration_minutes;
  ctx.session.session_data._seating_available_days = r.available_days;
  ctx.session.session_data._seating_available_from = r.available_from;
  ctx.session.session_data._seating_available_to = r.available_to;
  // Bridge to scheduling's time-slot filter fields
  ctx.session.session_data._service_available_days = r.available_days;
  ctx.session.session_data._service_available_from = r.available_from;
  ctx.session.session_data._service_available_to = r.available_to;
  ctx.session.session_data.service_deposit = r.deposit_amount;
  ctx.session.session_data.service_duration = r.reservation_duration_minutes;
  ctx.session.session_data.service_price = r.deposit_amount;
  ctx.session.session_data._service_price_is_variable = true;
  ctx.session.session_data._service_max_capacity = r.capacity;
  ctx.session.session_data._is_table_reservation = true;
}

const selectTableStep: FlowStepConfig = {
  id: 'select_table',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

    const { data: resources } = await ctx.supabase
      .from('seating_resources')
      .select('id, name, resource_type, capacity, min_party_size, section, deposit_amount, reservation_duration_minutes, description, available_days, available_from, available_to')
      .eq('business_id', ctx.business.id)
      .eq('is_active', true)
      .order('sort_order');

    if (!resources || resources.length === 0) {
      return [{
        type: 'buttons',
        body: 'No tables or seating areas are available for reservation right now.',
        buttons: [
          { id: 'recovery_other_options', title: 'Other Options' },
          { id: 'recovery_exit', title: 'Exit' },
        ],
      }];
    }

    const cc = (ctx.business.country_code || 'NG') as CountryCode;

    // Group by section if sections exist
    const hasSections = resources.some((r: SeatingResource) => r.section);

    const items = (resources as SeatingResource[]).map(r => {
      const capacityLabel = r.min_party_size === r.capacity
        ? `${r.capacity} guests`
        : `${r.min_party_size}-${r.capacity} guests`;
      const depositLabel = r.deposit_amount > 0
        ? `Deposit: ${formatCurrency(r.deposit_amount, cc)}`
        : '';
      const sectionLabel = hasSections && r.section ? `${r.section} · ` : '';
      const desc = [sectionLabel + capacityLabel, depositLabel].filter(Boolean).join(' · ');

      const name = r.name || 'Table';
      if (name.length <= 24) {
        return { title: name, description: desc.slice(0, 72), postbackText: r.id };
      }
      return { title: name.slice(0, 23) + '\u2026', description: [name, desc].join(' \u00b7 ').slice(0, 72), postbackText: r.id };
    });

    return [{
      type: 'list',
      title: 'Reserve a Table',
      body: `Where would you like to sit at ${ctx.business.name}?`,
      buttonLabel: 'View Options',
      items,
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    // Recovery buttons from no-resources prompt
    if (input === 'recovery_other_options') {
      return { valid: true, data: { _recovery_action: 'other_options' } };
    }
    if (input === 'recovery_exit') {
      return { valid: true, data: { _action: 'cancel' } };
    }

    const selectFields = 'id, name, resource_type, capacity, min_party_size, section, deposit_amount, reservation_duration_minutes, description, available_days, available_from, available_to';

    // Try exact ID match first
    const { data: resource } = await ctx.supabase
      .from('seating_resources')
      .select(selectFields)
      .eq('id', input)
      .eq('business_id', ctx.business!.id)
      .eq('is_active', true)
      .maybeSingle();

    if (resource) {
      return { valid: true, data: buildSelectionData(resource as SeatingResource) };
    }

    // Fuzzy match by name
    const { data: all } = await ctx.supabase
      .from('seating_resources')
      .select(selectFields)
      .eq('business_id', ctx.business!.id)
      .eq('is_active', true);

    if (all) {
      const lower = input.toLowerCase();
      const match = (all as SeatingResource[]).find(r => r.name.toLowerCase().includes(lower));
      if (match) {
        return { valid: true, data: buildSelectionData(match) };
      }
    }

    return { valid: false, errorMessage: 'That option is not available. Tap one of the choices above.' };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._recovery_action === 'other_options') {
      delete ctx.session.session_data._recovery_action;
      return 'select_capability';
    }
    if (ctx.session.session_data._action === 'cancel') {
      return null;
    }
    // Route into the scheduling flow's shared date/time/quantity steps
    return 'select_date';
  },

  async skipIf(ctx: FlowContext) {
    if (ctx.session.session_data.skip_service) return true;
    if (!ctx.business) return false;

    // Auto-select if only one active resource (runs BEFORE prompt)
    const { data: resources } = await ctx.supabase
      .from('seating_resources')
      .select('id, name, resource_type, capacity, min_party_size, section, deposit_amount, reservation_duration_minutes, description, available_days, available_from, available_to')
      .eq('business_id', ctx.business.id)
      .eq('is_active', true)
      .order('sort_order');

    if (resources && resources.length === 1) {
      const r = resources[0] as SeatingResource;
      setSeatingSessionData(ctx, r);
      return true;
    }

    return false;
  },
};

export const tableReservationFlow: FlowDefinition = {
  type: 'table_reservation',
  steps: [selectTableStep],
};
