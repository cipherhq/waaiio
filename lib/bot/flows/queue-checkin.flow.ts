import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage } from './types';

const DEFAULT_AVG_SERVICE_MINUTES = 10;

async function getQueueConfig(ctx: FlowContext): Promise<{ avgMinutes: number; paused: boolean }> {
  if (!ctx.business) return { avgMinutes: DEFAULT_AVG_SERVICE_MINUTES, paused: false };
  const meta = (ctx.business.metadata || {}) as Record<string, unknown>;
  return {
    avgMinutes: (meta.queue_avg_service_minutes as number) || DEFAULT_AVG_SERVICE_MINUTES,
    paused: (meta.queue_paused as boolean) || false,
  };
}

const queueStartStep: FlowStepConfig = {
  id: 'queue_start',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

    // Check if queue is paused
    const { paused } = await getQueueConfig(ctx);
    if (paused) {
      return [{
        type: 'text',
        text: "Sorry, our queue is temporarily paused. Please try again later or contact us directly.",
      }];
    }

    return [{
      type: 'buttons',
      body: `Welcome to ${ctx.business.name}! Would you like to check in or view your queue status?`,
      buttons: [
        { id: 'queue_checkin', title: 'Check In' },
        { id: 'queue_status', title: 'Queue Status' },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext) {
    // If paused, any input ends the flow
    const { paused } = await getQueueConfig(ctx);
    if (paused) return { valid: true };

    const normalized = input.toLowerCase().trim();
    if (normalized === 'queue_checkin' || normalized === 'check in') {
      return { valid: true, data: { queue_action: 'checkin' } };
    }
    if (normalized === 'queue_status' || normalized === 'queue status') {
      return { valid: true, data: { queue_action: 'status' } };
    }
    return { valid: false, errorMessage: 'Please tap "Check In" or "Queue Status".' };
  },

  async next(ctx: FlowContext) {
    // If paused, end flow
    const { paused } = await getQueueConfig(ctx);
    if (paused) return null;

    const action = ctx.session.session_data.queue_action;
    if (action === 'status') return 'queue_check_status';
    return 'queue_collect_name';
  },
};

const queueCollectNameStep: FlowStepConfig = {
  id: 'queue_collect_name',

  async skipIf(ctx: FlowContext) {
    // Skip if we already have customer name from profile
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const { data: profile } = await ctx.supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('phone', phone)
      .maybeSingle();

    if (profile?.first_name) {
      ctx.session.session_data.queue_customer_name = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
      return true;
    }
    return false;
  },

  async prompt(): Promise<PromptMessage[]> {
    return [{ type: 'text', text: 'What name should we use for your queue entry?' }];
  },

  async validate(input: string) {
    const name = input.trim();
    if (name.length < 2 || name.length > 50) {
      return { valid: false, errorMessage: 'Please enter a valid name (2-50 characters).' };
    }
    return { valid: true, data: { queue_customer_name: name } };
  },

  async next() {
    return 'queue_confirm_checkin';
  },
};

const queueConfirmCheckinStep: FlowStepConfig = {
  id: 'queue_confirm_checkin',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

    const customerName = ctx.session.session_data.queue_customer_name as string;
    const { avgMinutes } = await getQueueConfig(ctx);

    // Get next queue number
    const { data: nextNum } = await ctx.supabase
      .rpc('next_queue_number', { biz_id: ctx.business.id });

    const queueNumber = nextNum ?? 1;

    // Calculate estimated wait based on current waiting count
    const { count } = await ctx.supabase
      .from('queue_entries')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', ctx.business.id)
      .eq('queue_date', new Date().toISOString().split('T')[0])
      .in('status', ['waiting', 'serving']);

    const waitingAhead = (count || 0);
    const estimatedWait = waitingAhead * avgMinutes;

    // Insert queue entry
    const { error } = await ctx.supabase
      .from('queue_entries')
      .insert({
        business_id: ctx.business.id,
        customer_phone: ctx.from,
        customer_name: customerName,
        queue_number: queueNumber,
        estimated_wait_minutes: estimatedWait,
        channel: 'whatsapp',
        priority_level: 'normal',
      });

    if (error) {
      console.error('[QUEUE] Insert error:', error);
      return [{ type: 'text', text: 'Sorry, there was an error checking you in. Please try again.' }];
    }

    const waitText = estimatedWait > 0
      ? `Estimated wait: ~${estimatedWait} minutes.`
      : 'You should be served shortly!';

    return [{
      type: 'text',
      text: `You're checked in, ${customerName}!\n\nYou're *#${queueNumber}* in the queue. ${waitText}\n\nWe'll message you when it's your turn!`,
    }];
  },

  async validate() {
    return { valid: true };
  },

  async next() {
    return null; // Flow complete
  },
};

const queueCheckStatusStep: FlowStepConfig = {
  id: 'queue_check_status',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Business not found.' }];

    const today = new Date().toISOString().split('T')[0];
    const { avgMinutes } = await getQueueConfig(ctx);

    // Find customer's active queue entry
    const { data: entry } = await ctx.supabase
      .from('queue_entries')
      .select('queue_number, status, checked_in_at, estimated_wait_minutes')
      .eq('business_id', ctx.business.id)
      .eq('customer_phone', ctx.from)
      .eq('queue_date', today)
      .in('status', ['waiting', 'serving'])
      .order('queue_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!entry) {
      return [{
        type: 'buttons',
        body: "You don't have an active queue entry for today. Would you like to check in?",
        buttons: [{ id: 'queue_checkin', title: 'Check In' }],
      }];
    }

    if (entry.status === 'serving') {
      return [{ type: 'text', text: "It's your turn! Please proceed to the counter." }];
    }

    // Count how many are ahead
    const { count } = await ctx.supabase
      .from('queue_entries')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', ctx.business.id)
      .eq('queue_date', today)
      .eq('status', 'waiting')
      .lt('queue_number', entry.queue_number);

    const ahead = count || 0;
    const estimatedWait = ahead * avgMinutes;

    return [{
      type: 'text',
      text: `You're *#${entry.queue_number}* in the queue.\n\n${ahead} ${ahead === 1 ? 'person' : 'people'} ahead of you. Estimated wait: ~${estimatedWait} minutes.`,
    }];
  },

  async validate(input: string) {
    // If they tap check in from the "no entry" prompt
    if (input.toLowerCase() === 'queue_checkin') {
      return { valid: true, data: { queue_action: 'checkin' } };
    }
    return { valid: true };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data.queue_action === 'checkin') {
      return 'queue_collect_name';
    }
    return null; // Flow complete
  },
};

export const queueCheckinFlow: FlowDefinition = {
  type: 'queue' as const,
  steps: [
    queueStartStep,
    queueCollectNameStep,
    queueConfirmCheckinStep,
    queueCheckStatusStep,
  ],
};
