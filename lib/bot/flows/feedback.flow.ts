import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';

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

    const stars = '⭐'.repeat(rating);
    const thanks = rating >= 4
      ? `Thank you for the ${stars} rating! We appreciate your feedback.`
      : `Thank you for your feedback ${stars}. We'll work to improve your experience.`;

    return [{ type: 'text', text: thanks }];
  },

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  },

  async next() {
    return null; // Flow complete
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
