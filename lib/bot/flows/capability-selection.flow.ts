import type { FlowDefinition, FlowStepConfig, FlowContext } from './types';
import type { CapabilityId } from '@/lib/capabilities/types';

/** Generic labels for capability selection buttons */
export function getCapabilityLabel(cap: CapabilityId, category: string): string {
  switch (cap) {
    case 'scheduling': {
      const bookingLabels: Record<string, string> = {
        restaurant: 'Book a Table',
        hotel: 'Book a Stay',
        shortlet: 'Book a Stay',
        event_services: 'Book a Service',
        photographer: 'Book a Session',
        gym: 'Book a Session',
        tutor: 'Book a Session',
        coworking: 'Book a Space',
        car_wash: 'Book a Wash',
        laundry: 'Book Pickup',
      };
      return bookingLabels[category] || 'Book Appointment';
    }
    case 'giving':
      return 'Give';
    case 'payment':
      return 'Make Payment';
    case 'ordering':
      return 'Place an Order';
    case 'ticketing':
      return 'Buy Tickets';
    case 'reservation':
      return 'Book a Stay';
    case 'crowdfunding':
      return 'Support a Campaign';
    case 'reminders':
      return 'My Reminders';
    case 'chat':
      return 'Chat with Us';
    case 'waitlist':
      return 'Join Waitlist';
    case 'queue':
      return 'Check In';
    case 'loyalty':
      return 'My Rewards';
    case 'invoice':
      return 'My Invoices';
    default:
      return cap;
  }
}

/** Map capability to the first step of its corresponding flow */
function getFirstStepForCapability(cap: CapabilityId): string {
  switch (cap) {
    case 'scheduling': return 'select_service';
    case 'giving': return 'select_category'; // giving uses the payment flow
    case 'payment': return 'select_category';
    case 'ordering': return 'browse_catalog';
    case 'ticketing': return 'select_event';
    case 'reservation': return 'select_apartment';
    case 'crowdfunding': return 'select_campaign';
    case 'chat': return 'chat_start';
    case 'waitlist': return 'waitlist_join';
    case 'queue': return 'queue_start';
    case 'loyalty': return 'loyalty_menu';
    case 'invoice': return 'invoice_list';
    default: return 'select_service';
  }
}

const selectCapabilityStep: FlowStepConfig = {
  id: 'select_capability',

  async skipIf(ctx: FlowContext) {
    if (!ctx.business) return false;
    const capabilities = (ctx.session.session_data.capabilities as CapabilityId[]) || [];
    const businessId = ctx.business.id;

    // Filter out non-user-facing capabilities
    const nonUserFacing = new Set(['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'whatsapp_sign', 'survey', 'poll']);
    if (capabilities.includes('scheduling')) { nonUserFacing.add('payment'); nonUserFacing.add('invoice'); }
    let userFacing = capabilities.filter(c => !nonUserFacing.has(c));

    // Only keep capabilities that have backing data
    const checks = await Promise.all(userFacing.map(async (cap): Promise<[CapabilityId, boolean]> => {
      switch (cap) {
        case 'ordering': {
          const { count } = await ctx.supabase.from('products').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true).is('deleted_at', null);
          return [cap, (count || 0) > 0];
        }
        case 'giving': {
          const { count } = await ctx.supabase.from('services').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true).eq('service_type', 'giving').is('deleted_at', null);
          return [cap, (count || 0) > 0];
        }
        case 'scheduling': {
          const { count } = await ctx.supabase.from('services').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true).neq('service_type', 'giving').is('deleted_at', null);
          return [cap, (count || 0) > 0];
        }
        case 'ticketing': {
          const { count } = await ctx.supabase.from('events').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true);
          return [cap, (count || 0) > 0];
        }
        case 'crowdfunding': {
          const { count } = await ctx.supabase.from('campaigns').select('id', { count: 'exact', head: true })
            .eq('business_id', businessId).eq('is_active', true);
          return [cap, (count || 0) > 0];
        }
        default:
          return [cap, true]; // chat, waitlist, queue — always available
      }
    }));
    userFacing = checks.filter(([, hasData]) => hasData).map(([cap]) => cap);

    // Store filtered list for prompt to use
    ctx.session.session_data._filtered_capabilities = userFacing;

    // If 0 or 1 capability with data, auto-select and skip the menu
    if (userFacing.length <= 1) {
      const cap = userFacing[0] || capabilities[0] || 'scheduling';
      ctx.session.session_data.active_capability = cap;
      return true;
    }
    return false;
  },

  async prompt(ctx: FlowContext) {
    const userFacing = (ctx.session.session_data._filtered_capabilities as CapabilityId[]) || [];
    const category = ctx.business?.category || 'other';

    // WhatsApp buttons max 3 — use a list for more options
    if (userFacing.length <= 3) {
      const buttons = userFacing.map(cap => ({
        id: `cap_${cap}`,
        title: getCapabilityLabel(cap, category),
      }));
      return [{
        type: 'buttons' as const,
        body: 'What would you like to do?',
        buttons,
      }];
    }

    // List message for 4+ capabilities
    const items = userFacing.map(cap => ({
      title: getCapabilityLabel(cap, category),
      postbackText: `cap_${cap}`,
    }));
    return [{
      type: 'list' as const,
      title: 'Services',
      body: 'What would you like to do?',
      buttonLabel: 'View Options',
      items,
    }];
  },

  async validate(input: string, ctx: FlowContext) {
    const capabilities = (ctx.session.session_data.capabilities as CapabilityId[]) || [];
    const category = ctx.business?.category || 'other';
    const nonUF = new Set(['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'whatsapp_sign', 'survey', 'poll']);
    if (capabilities.includes('scheduling')) { nonUF.add('payment'); nonUF.add('invoice'); }
    const userFacing = capabilities.filter(c => !nonUF.has(c));

    let capId: CapabilityId | null = null;

    if (input.startsWith('cap_')) {
      capId = input.replace('cap_', '') as CapabilityId;
    } else {
      // Numeric selection: "1", "2", etc.
      const num = parseInt(input, 10);
      if (num >= 1 && num <= userFacing.length) {
        capId = userFacing[num - 1];
      }
      // Label match: "buy tickets", "give", etc.
      if (!capId) {
        const lower = input.toLowerCase();
        // Exact label match
        capId = userFacing.find(c => getCapabilityLabel(c, category).toLowerCase() === lower) || null;
        // Partial match: input contains label or label contains input
        if (!capId) {
          capId = userFacing.find(c => {
            const label = getCapabilityLabel(c, category).toLowerCase();
            return lower.includes(label) || label.includes(lower);
          }) || null;
        }
        // Keyword-based intent matching
        if (!capId) {
          if (/\b(book|appoint|schedule|reserv)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'scheduling' || c === 'reservation') || null;
          } else if (/\b(give|tith|offer|donat|sadaqah|zakat)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'giving' || c === 'payment') || null;
          } else if (/\b(order|buy|shop|menu|food)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'ordering') || null;
          } else if (/\b(ticket|event|show|concert)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'ticketing') || null;
          } else if (/\b(chat|talk|speak|help|support)\b/i.test(input)) {
            capId = userFacing.find(c => c === 'chat') || null;
          }
        }
      }
    }

    if (!capId || !capabilities.includes(capId)) {
      return { valid: false, errorMessage: 'Please select an option from the menu.' };
    }

    return {
      valid: true,
      data: { active_capability: capId },
    };
  },

  async next(ctx: FlowContext) {
    const cap = ctx.session.session_data.active_capability as CapabilityId;
    return getFirstStepForCapability(cap);
  },
};

export const capabilitySelectionFlow: FlowDefinition = {
  type: 'scheduling', // placeholder — this is a pseudo-flow
  steps: [selectCapabilityStep],
};

export { getFirstStepForCapability };
