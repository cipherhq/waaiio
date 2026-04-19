import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { logger } from '@/lib/logger';

// ── Loyalty Menu ──
const loyaltyMenuStep: FlowStepConfig = {
  id: 'loyalty_menu',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;

    // Find loyalty record for this customer + business
    const businessId = ctx.session.business_id || ctx.session.session_data.loyalty_business_id as string;
    if (!businessId) {
      return [{ type: 'text', text: "You don't have any loyalty points yet. Make your first visit to start earning rewards! \u2B50" }];
    }

    const { data: loyalty } = await ctx.supabase
      .from('loyalty_points')
      .select('id, points_balance, total_earned, total_redeemed, visit_count')
      .eq('business_id', businessId)
      .or(`customer_phone.eq.${phone},customer_phone.eq.${phoneN}`)
      .maybeSingle();

    if (!loyalty) {
      return [{ type: 'text', text: "You don't have any loyalty points yet. Make your first visit to start earning rewards! \u2B50" }];
    }

    // Store loyalty ID for later steps
    ctx.session.session_data.loyalty_id = loyalty.id;
    ctx.session.session_data.loyalty_balance = loyalty.points_balance;
    await ctx.supabase.from('bot_sessions').update({
      session_data: ctx.session.session_data,
    }).eq('id', ctx.session.id);

    // Get reward threshold from business metadata
    const meta = ctx.business?.metadata || {};
    const threshold = (meta.loyalty_reward_threshold as number) || 500;

    return [
      {
        type: 'text',
        text: [
          `\u2B50 *Your Loyalty Status*`,
          '',
          `\uD83D\uDCB0 Points: *${loyalty.points_balance}*`,
          `\uD83C\uDFC6 Visits: *${loyalty.visit_count || 0}*`,
          `\uD83C\uDF81 Reward at: *${threshold} points*`,
        ].join('\n'),
      },
      {
        type: 'buttons',
        body: 'What would you like to do?',
        buttons: [
          { id: 'view_history', title: 'View History' },
          { id: 'redeem', title: 'Redeem Reward' },
        ],
      },
    ];
  },

  async validate(input: string): Promise<ValidationResult> {
    if (input === 'view_history') return { valid: true, data: { _loyalty_action: 'history' } };
    if (input === 'redeem') return { valid: true, data: { _loyalty_action: 'redeem' } };
    return { valid: false, errorMessage: 'Please select an option.' };
  },

  async next(ctx: FlowContext) {
    const action = ctx.session.session_data._loyalty_action;
    if (action === 'history') return 'loyalty_history';
    if (action === 'redeem') return 'loyalty_redeem';
    return null;
  },
};

// ── Loyalty History ──
const loyaltyHistoryStep: FlowStepConfig = {
  id: 'loyalty_history',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const loyaltyId = ctx.session.session_data.loyalty_id as string;
    if (!loyaltyId) {
      return [{ type: 'text', text: 'No loyalty record found. Send *Hi* to start over.' }];
    }

    const { data: transactions } = await ctx.supabase
      .from('loyalty_transactions')
      .select('points_change, reason, created_at')
      .eq('loyalty_id', loyaltyId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!transactions || transactions.length === 0) {
      return [
        { type: 'text', text: 'No points activity yet. You\u2019ll see your points history here as you earn and redeem!' },
        {
          type: 'buttons',
          body: 'Anything else?',
          buttons: [{ id: 'back_menu', title: 'Back to Menu' }],
        },
      ];
    }

    const lines = transactions.map(t => {
      const sign = t.points_change >= 0 ? '+' : '';
      const dateStr = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const reason = (t.reason as string) || 'Activity';
      const reasonLabel = reason.charAt(0).toUpperCase() + reason.slice(1);
      return `${sign}${t.points_change} \u2022 ${reasonLabel} (${dateStr})`;
    });

    return [
      {
        type: 'text',
        text: `\uD83D\uDCCB *Recent Points Activity*\n\n${lines.join('\n')}`,
      },
      {
        type: 'buttons',
        body: 'Anything else?',
        buttons: [{ id: 'back_menu', title: 'Back to Menu' }],
      },
    ];
  },

  async validate(input: string): Promise<ValidationResult> {
    if (input === 'back_menu') return { valid: true, data: { _loyalty_nav: 'menu' } };
    // Any text → treat as back to menu
    return { valid: true, data: { _loyalty_nav: 'menu' } };
  },

  async next(ctx: FlowContext) {
    return 'loyalty_menu';
  },
};

// ── Loyalty Redeem ──
const loyaltyRedeemStep: FlowStepConfig = {
  id: 'loyalty_redeem',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const balance = (ctx.session.session_data.loyalty_balance as number) || 0;
    const meta = ctx.business?.metadata || {};
    const threshold = (meta.loyalty_reward_threshold as number) || 500;
    const rewardDesc = (meta.loyalty_reward_description as string) || 'a free reward';

    if (balance < threshold) {
      const needed = threshold - balance;
      return [
        {
          type: 'text',
          text: `You need *${needed}* more points to redeem. Keep earning!`,
        },
        {
          type: 'buttons',
          body: 'Anything else?',
          buttons: [{ id: 'cancel', title: 'Back to Menu' }],
        },
      ];
    }

    return [{
      type: 'buttons',
      body: `\uD83C\uDF81 You have enough points to redeem: *${rewardDesc}*\n\nThis will use ${threshold} points from your balance of ${balance}.`,
      buttons: [
        { id: 'confirm', title: 'Redeem Now' },
        { id: 'cancel', title: 'Cancel' },
      ],
    }];
  },

  async validate(input: string): Promise<ValidationResult> {
    if (input === 'confirm') return { valid: true, data: { _redeem_action: 'confirm' } };
    if (input === 'cancel') return { valid: true, data: { _redeem_action: 'cancel' } };
    return { valid: false, errorMessage: 'Tap one of the buttons above to continue.' };
  },

  async next(ctx: FlowContext) {
    const action = ctx.session.session_data._redeem_action;
    if (action === 'cancel') return 'loyalty_menu';

    // Process redemption
    const loyaltyId = ctx.session.session_data.loyalty_id as string;
    const businessId = ctx.session.business_id || ctx.session.session_data.loyalty_business_id as string;
    const meta = ctx.business?.metadata || {};
    const threshold = (meta.loyalty_reward_threshold as number) || 500;

    try {
      // Insert redemption transaction
      await ctx.supabase.from('loyalty_transactions').insert({
        loyalty_id: loyaltyId,
        business_id: businessId,
        points_change: -threshold,
        reason: 'redemption',
      });

      // Update balance and total_redeemed
      const balance = (ctx.session.session_data.loyalty_balance as number) || 0;
      const { data: currentRecord } = await ctx.supabase
        .from('loyalty_points')
        .select('total_redeemed')
        .eq('id', loyaltyId)
        .single();

      await ctx.supabase
        .from('loyalty_points')
        .update({
          points_balance: balance - threshold,
          total_redeemed: ((currentRecord?.total_redeemed as number) || 0) + threshold,
        })
        .eq('id', loyaltyId);

      const rewardDesc = (meta.loyalty_reward_description as string) || 'a free reward';
      await ctx.sender.sendText({
        to: ctx.from,
        text: `\u2705 *Reward Redeemed!*\n\nYou've redeemed *${rewardDesc}*.\n\n${threshold} points have been deducted. Your new balance is *${balance - threshold}* points.\n\nScreenshot this message and show it at your next visit to claim your reward!`,
      });
    } catch (err) {
      logger.error('[LOYALTY] Redemption error:', err);
      await ctx.sender.sendText({
        to: ctx.from,
        text: 'Oops, something went wrong. Please try again in a few minutes, or send *Hi* to start over.',
      });
    }

    // End session
    await ctx.supabase.from('bot_sessions').update({
      current_step: 'complete',
      is_active: false,
    }).eq('id', ctx.session.id);

    return null;
  },
};

export const loyaltyFlow: FlowDefinition = {
  type: 'scheduling', // placeholder — pseudo-flow
  steps: [loyaltyMenuStep, loyaltyHistoryStep, loyaltyRedeemStep],
};
