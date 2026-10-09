import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { getFlowCopy } from './flow-localization';
import { getLocale, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { getPoweredByFooter } from '@/lib/whitelabel';

function generateRedemptionCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = 'RW-';
  for (const byte of bytes) code += chars[byte % chars.length];
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
          { id: 'view_history', title: getFlowCopy(ctx.copyLang, 'loyalty.view_history') },
          { id: 'redeem', title: getFlowCopy(ctx.copyLang, 'loyalty.redeem_reward') },
          { id: 'back_to_account', title: getFlowCopy(ctx.copyLang, 'nav.back') },
        ],
      },
    ];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const lower = input.toLowerCase().trim();
    if (lower === 'back_to_account' || lower === 'back') return { valid: true, data: { _loyalty_action: 'back_to_account' } };
    if (lower === 'view_history' || lower === 'history' || lower === 'points') return { valid: true, data: { _loyalty_action: 'history' } };
    if (lower === 'redeem' || lower === 'redeem reward') return { valid: true, data: { _loyalty_action: 'redeem' } };
    // If no loyalty record, any input routes back to my account
    if (ctx.session.session_data._loyalty_empty) return { valid: true, data: { _loyalty_action: 'back_to_account' } };
    return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'loyalty.loyalty_hint') };
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
          body: getFlowCopy(ctx.copyLang, 'loyalty.anything_else'),
          buttons: [{ id: 'back_menu', title: getFlowCopy(ctx.copyLang, 'nav.back_to_menu') }, { id: 'back_to_account', title: getFlowCopy(ctx.copyLang, 'nav.back') }],
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
        body: getFlowCopy(ctx.copyLang, 'loyalty.anything_else'),
        buttons: [{ id: 'back_menu', title: getFlowCopy(ctx.copyLang, 'nav.back_to_menu') }],
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
          body: getFlowCopy(ctx.copyLang, 'loyalty.anything_else'),
          buttons: [{ id: 'go_back', title: getFlowCopy(ctx.copyLang, 'nav.back_to_menu') }],
        },
      ];
    }

    return [{
      type: 'buttons',
      body: await ctx.t(`You have enough points to redeem: *${rewardDesc}*\n\nThis will use ${threshold} points from your balance of ${balance}.`),
      buttons: [
        { id: 'confirm_redeem', title: getFlowCopy(ctx.copyLang, 'loyalty.redeem_now') },
        { id: 'skip_redeem', title: getFlowCopy(ctx.copyLang, 'loyalty.not_now') },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    if (input === 'confirm_redeem') return { valid: true, data: { _redeem_action: 'confirm' } };
    if (input === 'skip_redeem') return { valid: true, data: { _redeem_action: 'skip' } };
    // Bug fix: handle go_back button from low-balance path
    if (input === 'go_back') return { valid: true, data: { _redeem_action: 'skip' } };
    return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'loyalty.redeem_hint') };
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

      // M434: deduction and durable receipt/code are ONE database transaction.
      // Replaying the same bot session returns the original receipt without new debit.
      const proposedCode = generateRedemptionCode();
      const { data: redeemed, error: redeemErr } = await ctx.supabase.rpc('redeem_loyalty_reward_once', {
        p_loyalty_id: loyaltyId,
        p_business_id: businessId,
        p_customer_phone: phone,
        p_points: threshold,
        p_redemption_key: `bot:${ctx.session.id}`,
        p_redemption_code: proposedCode,
      });
      if (redeemErr || redeemed?.success !== true
        || typeof redeemed.code !== 'string' || !/^RW-[A-Z2-9]{6}$/.test(redeemed.code)
        || !Number.isSafeInteger(redeemed.points_balance)) {
        logger.error('[LOYALTY] Atomic reward receipt denied or failed:', redeemErr || redeemed?.reason || 'bad_receipt');
        throw new Error('Redemption was not confirmed');
      }
      const rewardDesc = (meta.loyalty_reward_description as string) || 'a free reward';
      const redemptionCode = redeemed.code as string;
      const newBalance = redeemed.points_balance as number;

      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t([
          `*Reward Redeemed!*`,
          '',
          `You've redeemed *${rewardDesc}*.`,
          '',
          `Redemption code: *${redemptionCode}*`,
          `Points used: ${threshold}`,
          `New balance: *${newBalance}* points`,
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
