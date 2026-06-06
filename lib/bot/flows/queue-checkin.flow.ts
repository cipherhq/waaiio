import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage } from './types';
import { notifyOwnerNewQueueCheckin } from './shared/notify-owner';
import { createNotification } from './shared/notifications';

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
    if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

    // Check if queue is paused
    const { paused, avgMinutes } = await getQueueConfig(ctx);
    if (paused) {
      return [{
        type: 'buttons',
        body: 'The queue is currently closed. Would you like to be notified when it reopens?',
        buttons: [
          { id: 'notify_reopen', title: 'Notify Me' },
          { id: 'no_thanks', title: 'No Thanks' },
        ],
      }];
    }

    // Check if user already has an active queue entry (waiting or serving)
    const today = new Date().toISOString().split('T')[0];
    const phoneP = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const { data: existingEntry } = await ctx.supabase
      .from('queue_entries')
      .select('queue_number, status')
      .eq('business_id', ctx.business.id)
      .eq('customer_phone', phoneP)
      .eq('queue_date', today)
      .in('status', ['waiting', 'serving'])
      .order('queue_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingEntry) {
      // User is already in the queue — show their position instead of offering to join
      if (existingEntry.status === 'serving') {
        return [{
          type: 'text',
          text: "You're already in the queue and it's your turn! Please proceed to the counter.",
        }];
      }

      // Count how many are ahead
      const { count } = await ctx.supabase
        .from('queue_entries')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', ctx.business.id)
        .eq('queue_date', today)
        .eq('status', 'waiting')
        .lt('queue_number', existingEntry.queue_number);

      const ahead = count || 0;
      const estimatedWait = ahead * avgMinutes;
      const waitText = estimatedWait > 0
        ? `Estimated wait: ~${estimatedWait} minutes.`
        : 'You should be served shortly!';

      // Mark that we showed existing position (so validate/next can end the flow)
      ctx.session.session_data._queue_already_joined = true;

      return [{
        type: 'text',
        text: `You're already in the queue! You're *#${existingEntry.queue_number}*.\n\n${ahead} ${ahead === 1 ? 'person' : 'people'} ahead of you. ${waitText}\n\nWe'll message you when it's your turn!`,
      }];
    }

    return [{
      type: 'buttons',
      body: `Welcome to ${ctx.business.name}! Would you like to join the queue or check your position?`,
      buttons: [
        { id: 'queue_checkin', title: 'Join Queue' },
        { id: 'queue_status', title: 'My Position' },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext) {
    // If user is already in the queue, accept any input and end flow
    if (ctx.session.session_data._queue_already_joined) {
      return { valid: true };
    }

    // If paused, handle notification opt-in
    const { paused } = await getQueueConfig(ctx);
    if (paused) {
      const normalized = input.toLowerCase().trim();
      if (normalized === 'notify_reopen') {
        // Save the customer's phone for reopen notification
        if (ctx.business) {
          await ctx.supabase
            .from('waitlist_entries')
            .insert({
              business_id: ctx.business.id,
              customer_phone: ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`,
              type: 'queue_reopen_notify',
              status: 'waiting',
            })
            .then(({ error }) => {
              if (error) console.error('[QUEUE] Waitlist notify insert error:', error);
            });
        }
        await ctx.sender.sendText({
          to: ctx.from,
          text: "We'll notify you when the queue reopens. Send *Hi* to do something else.",
        });
      } else if (normalized === 'no_thanks') {
        await ctx.sender.sendText({
          to: ctx.from,
          text: "No problem! You can check back later. Send *Hi* to start over.",
        });
      }
      return { valid: true };
    }

    const normalized = input.toLowerCase().trim();
    if (normalized === 'queue_checkin' || normalized === 'check in') {
      return { valid: true, data: { queue_action: 'checkin' } };
    }
    if (normalized === 'queue_status' || normalized === 'queue status') {
      return { valid: true, data: { queue_action: 'status' } };
    }
    return { valid: false, errorMessage: 'Please tap *Join Queue* or *My Position*.' };
  },

  async next(ctx: FlowContext) {
    // If user is already in the queue, end flow
    if (ctx.session.session_data._queue_already_joined) return null;

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
    if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

    const customerName = ctx.session.session_data.queue_customer_name as string;
    const { avgMinutes } = await getQueueConfig(ctx);

    // Get next queue number (preview only — actual insert happens in validate)
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

    // Store preview values for use in validate
    ctx.session.session_data._queue_preview_number = queueNumber;
    ctx.session.session_data._queue_preview_wait = estimatedWait;

    const waitText = estimatedWait > 0
      ? `Estimated wait: ~${estimatedWait} minutes.`
      : 'You should be served shortly!';

    return [{
      type: 'buttons',
      body: `Ready to join the queue, ${customerName}?\n\nYou'll be *#${queueNumber}* in line. ${waitText}`,
      buttons: [
        { id: 'confirm_checkin', title: 'Join Queue ✓' },
        { id: 'cancel_checkin', title: 'Cancel' },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext) {
    const text = input.toLowerCase().trim();
    if (text === 'cancel_checkin' || text === 'cancel') {
      return { valid: true, data: { _queue_cancelled: true } };
    }

    if (text !== 'confirm_checkin' && text !== 'confirm') {
      return { valid: false, errorMessage: 'Please tap *Join Queue* to confirm or *Cancel* to go back.' };
    }

    if (!ctx.business) return { valid: false, errorMessage: 'Something went wrong on our end. Send *Hi* to start over.' };

    const customerName = ctx.session.session_data.queue_customer_name as string;
    const queueNumber = ctx.session.session_data._queue_preview_number as number ?? 1;
    const estimatedWait = ctx.session.session_data._queue_preview_wait as number ?? 0;
    const phoneP = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const today = new Date().toISOString().split('T')[0];

    // Defense in depth: check for existing active entry before INSERT
    const { data: existingEntry } = await ctx.supabase
      .from('queue_entries')
      .select('queue_number, status')
      .eq('business_id', ctx.business.id)
      .eq('customer_phone', phoneP)
      .eq('queue_date', today)
      .in('status', ['waiting', 'serving'])
      .limit(1)
      .maybeSingle();

    if (existingEntry) {
      // User is already in the queue — show their position instead of erroring
      const posText = existingEntry.status === 'serving'
        ? "It's your turn! Please proceed to the counter."
        : `You're already *#${existingEntry.queue_number}* in the queue.`;

      await ctx.sender.sendText({
        to: ctx.from,
        text: `${posText}\n\nWe'll message you when it's your turn!`,
      });
      return { valid: true };
    }

    // Insert queue entry now that user confirmed
    const { error } = await ctx.supabase
      .from('queue_entries')
      .insert({
        business_id: ctx.business.id,
        customer_phone: phoneP,
        customer_name: customerName,
        queue_number: queueNumber,
        estimated_wait_minutes: estimatedWait,
        channel: 'whatsapp',
        priority_level: 'normal',
      });

    if (error) {
      console.error('[QUEUE] Insert error:', error);
      return { valid: false, errorMessage: 'Sorry, there was an error joining the queue. Please try again.' };
    }

    // Notify owner: email + WhatsApp
    notifyOwnerNewQueueCheckin({
      supabase: ctx.supabase,
      sender: ctx.sender,
      businessId: ctx.business.id,
      businessName: ctx.business.name,
      customerName,
      queueNumber,
    }).catch(err => console.error('[QUEUE] Notify error:', err));

    // In-app notification
    createNotification(ctx.supabase, {
      businessId: ctx.business.id,
      type: 'queue_checkin',
      channel: 'whatsapp',
      body: `${customerName} joined the queue (#${queueNumber}).`,
    }).catch(err => console.error('[QUEUE] Notification error:', err));

    const waitText = estimatedWait > 0
      ? `Estimated wait: ~${estimatedWait} minutes.`
      : 'You should be served shortly!';

    await ctx.sender.sendText({
      to: ctx.from,
      text: `✅ You're in the queue, ${customerName}!\n\nYou're *#${queueNumber}* in line. ${waitText}\n\nWe'll message you when it's your turn! 🔔\n\n💡 Type *my position* to check your status`,
    });

    return { valid: true };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._queue_cancelled) return null;
    return null; // Flow complete after checkin confirmation sent in validate
  },
};

const queueCheckStatusStep: FlowStepConfig = {
  id: 'queue_check_status',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];

    const today = new Date().toISOString().split('T')[0];
    const { avgMinutes } = await getQueueConfig(ctx);

    // Find customer's active queue entry
    const phoneP = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const { data: entry } = await ctx.supabase
      .from('queue_entries')
      .select('queue_number, status, checked_in_at, estimated_wait_minutes')
      .eq('business_id', ctx.business.id)
      .eq('customer_phone', phoneP)
      .eq('queue_date', today)
      .in('status', ['waiting', 'serving'])
      .order('queue_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!entry) {
      return [{
        type: 'buttons',
        body: "You don't have an active queue entry for today. Would you like to join the queue?",
        buttons: [{ id: 'queue_checkin', title: 'Join Queue' }],
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
