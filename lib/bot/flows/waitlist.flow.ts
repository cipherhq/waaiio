import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { getFlowCopy, fillFlowCopy } from './flow-localization';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

const waitlistJoinStep: FlowStepConfig = {
  id: 'waitlist_join',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    if (!ctx.business) return [{ type: 'text', text: getFlowCopy(ctx.copyLang, 'error.generic') }];
    return [{
      type: 'buttons',
      body: fillFlowCopy(ctx.copyLang, 'waitlist.fully_booked', { businessName: ctx.business.name }),
      buttons: [
        { id: 'wl_yes', title: getFlowCopy(ctx.copyLang, 'booking.join_waitlist') },
        { id: 'wl_no', title: getFlowCopy(ctx.copyLang, 'nav.no_thanks') },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const text = input.toLowerCase();
    if (text === 'wl_yes' || text === 'yes' || text === 'join') {
      return { valid: true, data: { waitlist_action: 'join' } };
    }
    if (text === 'wl_no' || text === 'no') {
      return { valid: true, data: { waitlist_action: 'decline' } };
    }
    return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'waitlist.tap_hint') };
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

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    return [{ type: 'text', text: getFlowCopy(ctx.copyLang, 'waitlist.name_ask') }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const name = input.trim();
    if (name.length < 2 || name.length > 50) {
      return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'waitlist.name_invalid') };
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
    if (!ctx.business) return [{ type: 'text', text: getFlowCopy(ctx.copyLang, 'error.generic') }];

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

    // CAP-001 Point C: Verify CURRENT capability before CREATE_NEW waitlist entry
    {
      const { requireCurrentCapability } = await import('./shared/capability-guard');
      const capGuard = await requireCurrentCapability(ctx.supabase, {
            session: { id: ctx.session.id, version: ctx.session.version, session_data: ctx.session.session_data },
        businessId: ctx.business.id,
        capability: 'waitlist',
        action: 'create_new',
      });
      if (!capGuard.allowed) { if (capGuard.recoveryStatus === 'stale') return [];
        return [{ type: 'text' as const, text: capGuard.customerMessage }];
      }
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
      logger.withContext({ op: 'waitlist.insert', ...safeLogErrorContext(error) }).error('[WAITLIST] Insert error');
      return [{ type: 'text', text: getFlowCopy(ctx.copyLang, 'error.generic') }];
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
