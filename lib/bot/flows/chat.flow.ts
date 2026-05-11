import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

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
            .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
            .limit(1)
            .maybeSingle();
          if (profile?.first_name) {
            customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
          }

          // Upsert conversation and get its ID in one step
          await ctx.supabase.from('chat_conversations').upsert({
            business_id: businessId,
            customer_phone: phone,
            customer_name: customerName,
            status: 'open',
            last_message_at: new Date().toISOString(),
          }, { onConflict: 'business_id,customer_phone' });

          const { data: conv } = await ctx.supabase
            .from('chat_conversations')
            .select('id')
            .eq('business_id', businessId)
            .eq('customer_phone', phone)
            .single();

          // Store the first message
          await ctx.supabase.from('chat_messages').insert({
            business_id: businessId,
            customer_phone: phone,
            customer_name: customerName,
            direction: 'inbound',
            message_text: input.trim(),
            is_read: false,
            conversation_id: conv?.id ?? null,
          });

          // Forward to business owner immediately
          if (ctx.sender) {
            const { data: biz } = await ctx.supabase
              .from('businesses')
              .select('owner_id')
              .eq('id', businessId)
              .single();
            if (biz?.owner_id) {
              const { data: ownerProfile } = await ctx.supabase
                .from('profiles')
                .select('phone')
                .eq('id', biz.owner_id)
                .single();
              if (ownerProfile?.phone) {
                const ownerPhone = ownerProfile.phone.startsWith('+')
                  ? ownerProfile.phone.slice(1)
                  : ownerProfile.phone;
                const displayName = customerName || phone;
                await ctx.sender.sendText({
                  to: ownerPhone,
                  text: `💬 *${displayName}*:\n${input.trim()}\n\n_Reply from your dashboard → Chat_`,
                });
              }
            }
          }

          // Mark that we already stored+forwarded this message
          ctx.session.session_data.first_message_handled = true;
        }

        return { valid: true };
      },
      async next() {
        return 'chat_handoff';
      },
    },
  ],
};
