import type { FlowDefinition, FlowStepConfig, FlowContext } from './types';
import type { CapabilityId } from '@/lib/capabilities/types';

/** Generic labels for capability selection buttons */
export function getCapabilityLabel(cap: CapabilityId, category: string): string {
  switch (cap) {
    case 'scheduling':
      return 'Book Appointment';
    case 'payment':
      if (category === 'church' || category === 'mosque') return 'Give';
      return 'Make Payment';
    case 'ordering':
      return 'Place an Order';
    case 'ticketing':
      return 'Buy Tickets';
    case 'crowdfunding':
      return 'Give';
    case 'reminders':
      return 'My Reminders';
    case 'chat':
      return 'Chat with Us';
    case 'waitlist':
      return 'Join Waitlist';
    case 'queue':
      return 'Check In';
    default:
      return cap;
  }
}

/** Map capability to the first step of its corresponding flow */
function getFirstStepForCapability(cap: CapabilityId): string {
  switch (cap) {
    case 'scheduling': return 'select_service';
    case 'payment': return 'select_category';
    case 'ordering': return 'browse_catalog';
    case 'ticketing': return 'select_event';
    case 'crowdfunding': return 'select_campaign';
    case 'chat': return 'chat_start';
    case 'waitlist': return 'waitlist_join';
    case 'queue': return 'queue_start';
    default: return 'select_service';
  }
}

const selectCapabilityStep: FlowStepConfig = {
  id: 'select_capability',

  async prompt(ctx: FlowContext) {
    const capabilities = (ctx.session.session_data.capabilities as CapabilityId[]) || [];
    const category = ctx.business?.category || 'other';

    // Filter out non-user-facing capabilities (background or dashboard-only)
    const userFacing = capabilities.filter(c => !['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff'].includes(c));

    const buttons = userFacing.slice(0, 3).map(cap => ({
      id: `cap_${cap}`,
      title: getCapabilityLabel(cap, category),
    }));

    return [{
      type: 'buttons' as const,
      body: 'What would you like to do?',
      buttons,
    }];
  },

  async validate(input: string, ctx: FlowContext) {
    if (!input.startsWith('cap_')) {
      return { valid: false, errorMessage: 'Please select an option.' };
    }

    const capId = input.replace('cap_', '') as CapabilityId;
    const capabilities = (ctx.session.session_data.capabilities as CapabilityId[]) || [];

    if (!capabilities.includes(capId)) {
      return { valid: false, errorMessage: 'Invalid option. Please try again.' };
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
