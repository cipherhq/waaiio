import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';

const waitlistJoinStep: FlowStepConfig = {
  id: 'waitlist_join',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];
    return [{
      type: 'buttons',
      body: `We're currently fully booked at ${ctx.business.name}. Would you like to join the waitlist? We'll notify you when a spot opens up.`,
      buttons: [
        { id: 'wl_yes', title: 'Join Waitlist' },
        { id: 'wl_no', title: 'No Thanks' },
      ],
    }];
  },

  async validate(input: string): Promise<ValidationResult> {
    const text = input.toLowerCase();
    if (text === 'wl_yes' || text === 'yes' || text === 'join') {
      return { valid: true, data: { waitlist_action: 'join' } };
    }
    if (text === 'wl_no' || text === 'no') {
      return { valid: true, data: { waitlist_action: 'decline' } };
    }
    return { valid: false, errorMessage: 'Please tap *Join Waitlist* or *No Thanks*.' };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data.waitlist_action === 'decline') return null;
    return 'waitlist_collect_name';
  },
};

const waitlistCollectNameStep: FlowStepConfig = {
  id: 'waitlist_collect_name',

  async skipIf(ctx: FlowContext) {
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const { data: profile } = await ctx.supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('phone', phone)
      .maybeSingle();

    if (profile?.first_name) {
      ctx.session.session_data.waitlist_name = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
      return true;
    }
    return false;
  },

  async prompt(): Promise<PromptMessage[]> {
    return [{ type: 'text', text: 'What name should we use for the waitlist?' }];
  },

  async validate(input: string): Promise<ValidationResult> {
    const name = input.trim();
    if (name.length < 2 || name.length > 50) {
      return { valid: false, errorMessage: 'Please enter a valid name (2-50 characters).' };
    }
    return { valid: true, data: { waitlist_name: name } };
  },

  async next() {
    return 'waitlist_confirm';
  },
};

const waitlistConfirmStep: FlowStepConfig = {
  id: 'waitlist_confirm',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

    const d = ctx.session.session_data;
    const customerName = d.waitlist_name as string;

    // Normalize phone + prevent duplicates
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const serviceId = (d.service_id as string) || null;

    // Check for existing waiting entry
    const { data: existing } = await ctx.supabase
      .from('waitlist_entries')
      .select('id')
      .eq('business_id', ctx.business.id)
      .eq('customer_phone', phone)
      .eq('status', 'waiting')
      .maybeSingle();

    if (existing) {
      return [{ type: 'text', text: `You're already on the waitlist, ${customerName}! We'll notify you when a spot opens up.\n\n💡 *What you can do:*\n• Type *my bookings* to check your bookings\n• Send *Hi* to start over` }];
    }

    // Insert waitlist entry
    const { error } = await ctx.supabase
      .from('waitlist_entries')
      .insert({
        business_id: ctx.business.id,
        customer_phone: phone,
        customer_name: customerName,
        service_id: serviceId,
        event_id: (d.event_id as string) || null,
        preferred_date: (d.date as string) || null,
        status: 'waiting',
      });

    if (error) {
      console.error('[WAITLIST] Insert error:', error);
      return [{ type: 'text', text: 'Sorry, there was an error joining the waitlist. Please try again.' }];
    }

    return [{
      type: 'text',
      text: `You're on the waitlist, ${customerName}! We'll send you a message when a spot opens up.\n\n💡 *What you can do:*\n• Type *my bookings* to check your bookings\n• Send *Hi* to start over`,
    }];
  },

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  },

  async next() {
    return null; // Flow complete
  },
};

export const waitlistFlow: FlowDefinition = {
  type: 'scheduling' as const, // pseudo-flow
  steps: [
    waitlistJoinStep,
    waitlistCollectNameStep,
    waitlistConfirmStep,
  ],
};
