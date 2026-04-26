import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { getCapabilityLabel } from './capability-selection.flow';
import type { CapabilityId } from '@/lib/capabilities/types';

const feedbackRatingStep: FlowStepConfig = {
  id: 'feedback_rating',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const businessName = ctx.business?.name || 'us';
    return [{
      type: 'buttons',
      body: `How was your experience at ${businessName}? Rate us:`,
      buttons: [
        { id: 'rate_5', title: '5 - Excellent' },
        { id: 'rate_4', title: '4 - Good' },
        { id: 'rate_3', title: '3 - Average' },
      ],
    }, {
      type: 'buttons',
      body: 'Or:',
      buttons: [
        { id: 'rate_2', title: '2 - Poor' },
        { id: 'rate_1', title: '1 - Terrible' },
      ],
    }];
  },

  async validate(input: string): Promise<ValidationResult> {
    const match = input.match(/^rate_(\d)$/);
    if (match) {
      const rating = parseInt(match[1], 10);
      if (rating >= 1 && rating <= 5) {
        return { valid: true, data: { feedback_rating: rating } };
      }
    }
    // Also accept plain number
    const num = parseInt(input, 10);
    if (num >= 1 && num <= 5) {
      return { valid: true, data: { feedback_rating: num } };
    }
    return { valid: false, errorMessage: 'Please select a rating from 1 to 5.' };
  },

  async next(ctx: FlowContext) {
    const rating = ctx.session.session_data.feedback_rating as number;
    // Only ask for comment if rating is 3 or below
    if (rating <= 3) return 'feedback_comment';
    return 'feedback_thanks';
  },
};

const feedbackCommentStep: FlowStepConfig = {
  id: 'feedback_comment',

  async prompt(): Promise<PromptMessage[]> {
    return [{
      type: 'text',
      text: "We're sorry to hear that. What could we improve? Type your feedback or send *skip* to skip:",
    }];
  },

  async validate(input: string): Promise<ValidationResult> {
    const text = input.trim();
    if (text.toLowerCase() === 'skip') {
      return { valid: true };
    }
    return { valid: true, data: { feedback_comment: text } };
  },

  async next() {
    return 'feedback_thanks';
  },
};

const feedbackThanksStep: FlowStepConfig = {
  id: 'feedback_thanks',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const d = ctx.session.session_data;
    const rating = d.feedback_rating as number;
    const comment = (d.feedback_comment as string) || null;

    // Get customer name from session data
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    let customerName = (d.customer_name as string) || null;
    if (!customerName) {
      const { data: profile } = await ctx.supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('phone', phone)
        .maybeSingle();
      if (profile?.first_name) {
        customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
      }
    }

    // Insert feedback
    if (ctx.business) {
      await ctx.supabase.from('customer_feedback').insert({
        business_id: ctx.business.id,
        customer_phone: ctx.from,
        customer_name: customerName,
        booking_id: (d.booking_id as string) || null,
        order_id: (d.order_id as string) || null,
        queue_entry_id: (d.queue_entry_id as string) || null,
        rating,
        comment,
        service_type: (d.service_type as string) || null,
      });
    }

    const stars = '\u2B50'.repeat(rating);
    const thanks = rating >= 4
      ? `Thank you for the ${stars} rating! We appreciate your feedback.`
      : `Thank you for your feedback ${stars}. We'll work to improve your experience.`;

    const messages: PromptMessage[] = [{ type: 'text', text: thanks }];

    // Prompt for Google review after positive feedback (4-5 stars)
    if (rating >= 4 && ctx.business) {
      const { data: biz } = await ctx.supabase
        .from('businesses')
        .select('google_place_id')
        .eq('id', ctx.business.id)
        .single();

      if (biz?.google_place_id) {
        const reviewUrl = `https://search.google.com/local/writereview?placeid=${biz.google_place_id}`;
        messages.push({
          type: 'text',
          text: `We'd love it if you could share your experience on Google too! It really helps us grow.\n\n${reviewUrl}`,
        });
      }
    }

    // Show capability buttons so user can continue without hitting the greeting again
    if (ctx.business) {
      try {
        const { getEnabledCapabilities } = await import('@/lib/capabilities/service');
        const capabilities = await getEnabledCapabilities(ctx.supabase, ctx.business.id, ctx.business.category);
        const userFacing = capabilities.filter(
          (c: string) => !['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff'].includes(c),
        );

        if (userFacing.length > 0) {
          // Store capabilities and advance session to select_capability
          delete d.active_capability;
          d.capabilities = capabilities;
          await ctx.supabase
            .from('bot_sessions')
            .update({ session_data: d, current_step: 'select_capability' })
            .eq('id', ctx.session.id);

          const category = ctx.business.category || 'other';
          const buttons = userFacing.slice(0, 3).map((cap: string) => ({
            id: `cap_${cap}`,
            title: getCapabilityLabel(cap as CapabilityId, category),
          }));

          messages.push({
            type: 'buttons',
            body: 'Is there anything else I can help with?',
            buttons,
          });

          return messages;
        }
      } catch (err) {
        console.error('[FEEDBACK] Capabilities fetch error:', err);
      }
    }

    return messages;
  },

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  },

  async next() {
    return null; // Flow complete (only reached if no capabilities available)
  },
};

export const feedbackFlow: FlowDefinition = {
  type: 'scheduling' as const, // pseudo-flow
  steps: [
    feedbackRatingStep,
    feedbackCommentStep,
    feedbackThanksStep,
  ],
};
