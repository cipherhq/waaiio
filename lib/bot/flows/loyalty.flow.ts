import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { getLocale, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { getPoweredByFooter } from '@/lib/whitelabel';

function generateRedemptionCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'RW-';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

// ── Loyalty Menu ──
const loyaltyMenuStep: FlowStepConfig = {
  id: 'loyalty_menu',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const phoneN = ctx.from.startsWith('+') ? ctx.from.slice(1) : ctx.from;

    // Find loyalty record for this customer + business
    const businessId = ctx.session.business_id || ctx.session.session_data.loyalty_business_id as string;
    if (!businessId) {
      ctx.session.session_data._loyalty_empty = true;
      return [{
        type: 'buttons',
        body: await ctx.t("You don't have any loyalty points yet. Start using our services to earn rewards!"),
        buttons: [{ id: 'back_to_account', title: '← Back' }],
      }];
    }

    const { data: loyalty } = await ctx.supabase
      .from('loyalty_points')
      .select('id, points_balance, total_earned, total_redeemed, visit_count')
      .eq('business_id', businessId)
      .or(`customer_phone.eq.${sanitizeFilterValue(phone)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .maybeSingle();

    if (!loyalty) {
      ctx.session.session_data._loyalty_empty = true;
      return [{
        type: 'buttons',
        body: await ctx.t("You don't have any loyalty points yet. Start using our services to earn rewards!"),
        buttons: [{ id: 'back_to_account', title: '← Back' }],
      }];
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
        text: await ctx.t([
          `⭐ *Your Loyalty Status*`,
          '',
          `💰 Points: *${loyalty.points_balance}*`,
          `🏆 Visits: *${loyalty.visit_count || 0}*`,
          `🎁 Reward at: *${threshold} points*`,
        ].join('\n')),
      },
      {
        type: 'buttons',
        body: await ctx.t('What would you like to do?'),
        buttons: [
          { id: 'view_history', title: 'View History' },
          { id: 'redeem', title: 'Redeem Reward' },
          { id: 'back_to_account', title: '← Back' },
        ],
      },
    ];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    if (input === 'back_to_account') return { valid: true, data: { _loyalty_action: 'back_to_account' } };
    if (input === 'view_history') return { valid: true, data: { _loyalty_action: 'history' } };
    if (input === 'redeem') return { valid: true, data: { _loyalty_action: 'redeem' } };
    // If no loyalty record, any input routes back to my account
    if (ctx.session.session_data._loyalty_empty) return { valid: true, data: { _loyalty_action: 'back_to_account' } };
    return { valid: false, errorMessage: 'Please select an option.' };
  },

  async next(ctx: FlowContext) {
    const action = ctx.session.session_data._loyalty_action;
    if (action === 'back_to_account') return 'my_account_menu';
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
      return [{ type: 'text', text: await ctx.t('No loyalty record found. Send *Hi* to start over.') }];
    }

    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    const { data: transactions } = await ctx.supabase
      .from('loyalty_transactions')
      .select('points_change, reason, created_at')
      .eq('business_id', ctx.business!.id)
      .eq('customer_phone', phone)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!transactions || transactions.length === 0) {
      return [
        { type: 'text', text: await ctx.t('No points activity yet. You\'ll see your points history here as you earn and redeem!') },
        {
          type: 'buttons',
          body: 'Anything else?',
          buttons: [{ id: 'back_menu', title: 'Back to Menu' }, { id: 'back_to_account', title: '← Back' }],
        },
      ];
    }

    const lines = transactions.map(t => {
      const sign = t.points_change >= 0 ? '+' : '';
      const dateStr = new Date(t.created_at).toLocaleDateString(getLocale((ctx.business?.country_code || 'NG') as CountryCode), { month: 'short', day: 'numeric' });
      const reason = (t.reason as string) || 'Activity';
      const reasonLabel = reason.charAt(0).toUpperCase() + reason.slice(1);
      return `${sign}${t.points_change} • ${reasonLabel} (${dateStr})`;
    });

    return [
      {
        type: 'text',
        text: await ctx.t(`📋 *Recent Points Activity*\n\n${lines.join('\n')}`),
      },
      {
        type: 'buttons',
        body: 'Anything else?',
        buttons: [{ id: 'back_menu', title: 'Back to Menu' }],
      },
    ];
  },

  async validate(input: string): Promise<ValidationResult> {
    if (input === 'back_to_account') return { valid: true, data: { _loyalty_nav: 'account' } };
    if (input === 'back_menu') return { valid: true, data: { _loyalty_nav: 'menu' } };
    // Any text → treat as back to menu
    return { valid: true, data: { _loyalty_nav: 'menu' } };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._loyalty_nav === 'account') return 'my_account_menu';
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
          text: await ctx.t(`You need *${needed}* more points to redeem. Keep earning!`),
        },
        {
          type: 'buttons',
          body: 'Anything else?',
          buttons: [{ id: 'go_back', title: 'Back to Menu' }],
        },
      ];
    }

    return [{
      type: 'buttons',
      body: await ctx.t(`You have enough points to redeem: *${rewardDesc}*\n\nThis will use ${threshold} points from your balance of ${balance}.`),
      buttons: [
        { id: 'confirm_redeem', title: 'Redeem Now' },
        { id: 'skip_redeem', title: 'Not Now' },
      ],
    }];
  },

  async validate(input: string): Promise<ValidationResult> {
    if (input === 'confirm_redeem') return { valid: true, data: { _redeem_action: 'confirm' } };
    if (input === 'skip_redeem') return { valid: true, data: { _redeem_action: 'skip' } };
    return { valid: false, errorMessage: 'Tap one of the buttons above to continue.' };
  },

  async next(ctx: FlowContext) {
    const action = ctx.session.session_data._redeem_action;
    if (action === 'skip') return 'loyalty_menu';

    // Process redemption
    const loyaltyId = ctx.session.session_data.loyalty_id as string;
    const businessId = ctx.session.business_id || ctx.session.session_data.loyalty_business_id as string;
    const meta = ctx.business?.metadata || {};
    const threshold = (meta.loyalty_reward_threshold as number) || 500;

    try {
      const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;

      // Atomically update balance and total_redeemed via RPC FIRST
      const { error: redeemErr } = await ctx.supabase.rpc('redeem_loyalty_points', {
        p_loyalty_id: loyaltyId,
        p_points: threshold,
      });
      if (redeemErr) {
        logger.error('[LOYALTY] redeem_loyalty_points RPC failed:', redeemErr);
        throw new Error('Redemption failed');
      }

      // Insert redemption transaction only after RPC succeeds
      await ctx.supabase.from('loyalty_transactions').insert({
        business_id: businessId,
        customer_phone: phone,
        points_change: -threshold,
        reason: 'redemption',
        reference_id: loyaltyId,
        reference_type: 'loyalty_points',
      });

      const balance = (ctx.session.session_data.loyalty_balance as number) || 0;

      const rewardDesc = (meta.loyalty_reward_description as string) || 'a free reward';
      const redemptionCode = generateRedemptionCode();

      // Store redemption code in the transaction for staff verification
      await ctx.supabase.from('loyalty_transactions')
        .update({ reference_type: `code:${redemptionCode}` })
        .eq('business_id', businessId)
        .eq('customer_phone', phone)
        .eq('reason', 'redemption')
        .order('created_at', { ascending: false })
        .limit(1);

      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t([
          `*Reward Redeemed!*`,
          '',
          `You've redeemed *${rewardDesc}*.`,
          '',
          `Redemption code: *${redemptionCode}*`,
          `Points used: ${threshold}`,
          `New balance: *${balance - threshold}* points`,
          '',
          `Show this code to staff to claim your reward.`,
          '',
          `Type *my points* to check your balance`,
          `Type *Hi* to book or order`,
          ...(getPoweredByFooter(ctx.business?.subscription_tier) ? ['', '_Powered by Waaiio_'] : []),
        ].join('\n')),
      });

      // Notify business owner about redemption
      if (ctx.business) {
        const ownerNotifyMsg = `Loyalty reward redeemed by ${ctx.session.session_data.loyalty_customer_name || phone}.\n\nCode: *${redemptionCode}*\nReward: ${rewardDesc}`;
        // Non-blocking — notify via alerts table
        ctx.supabase.from('alerts').insert({
          business_id: businessId,
          type: 'loyalty_redemption',
          severity: 'info',
          title: `Loyalty reward redeemed: ${redemptionCode}`,
          message: ownerNotifyMsg,
          metadata: { redemption_code: redemptionCode, customer_phone: phone },
        }).then(() => {});
      }
    } catch (err) {
      logger.error('[LOYALTY] Redemption error:', err);
      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t('Something went wrong on our end. Please try again in a few minutes, or send *Hi* to start over.'),
      });
    }

    // End session
    await ctx.supabase.from('bot_sessions').update({
      current_step: 'complete',
      is_active: false,
      last_active_at: new Date().toISOString(),
    }).eq('id', ctx.session.id);

    return null;
  },
};

export const loyaltyFlow: FlowDefinition = {
  type: 'scheduling', // placeholder — pseudo-flow
  steps: [loyaltyMenuStep, loyaltyHistoryStep, loyaltyRedeemStep],
};
