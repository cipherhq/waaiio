import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';

/**
 * Chat flow: Welcomes the user and transitions to chat_handoff.
 * The first message is stored and forwarded so it's not lost in the transition.
 */
export const chatFlow: FlowDefinition = {
  type: 'scheduling', // placeholder — pseudo-flow
  steps: [
    {
      id: 'chat_start',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const businessName = ctx.business?.name || 'us';
        return [{
          type: 'text',
          text: `You're now chatting with *${businessName}*. Type your message and a team member will respond shortly.\n\nSend *restart* anytime to go back to the menu.`,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        if (!input?.trim()) return { valid: true };

        // Store and forward the first message so it's not lost during step transition
        const businessId = ctx.session.business_id;
        if (businessId) {
          const phone = ctx.from;
          const phoneP = phone.startsWith('+') ? phone : `+${phone}`;
          const phoneN = phone.startsWith('+') ? phone.slice(1) : phone;

          // Get customer name
          let customerName: string | null = null;
          const { data: profile } = await ctx.supabase
            .from('profiles')
            .select('first_name, last_name')
            .or(`phone.eq.${phoneP},phone.eq.${phoneN}`)
            .limit(1)
            .maybeSingle();
          if (profile?.first_name) {
            customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
          }

          // Upsert conversation
          await ctx.supabase.from('chat_conversations').upsert({
            business_id: businessId,
            customer_phone: phone,
            customer_name: customerName,
            status: 'open',
            last_message_at: new Date().toISOString(),
          }, { onConflict: 'business_id,customer_phone' });

          // Get conversation id
          const { data: conv } = await ctx.supabase
            .from('chat_conversations')
            .select('id')
            .eq('business_id', businessId)
            .eq('customer_phone', phone)
            .maybeSingle();

          // Store the message
          await ctx.supabase.from('chat_messages').insert({
            business_id: businessId,
            customer_phone: phone,
            customer_name: customerName,
            direction: 'inbound',
            message_text: input.trim(),
            is_read: false,
            conversation_id: conv?.id || null,
          });
        }

        return { valid: true };
      },
      async next() {
        return 'chat_handoff';
      },
    },
  ],
};
