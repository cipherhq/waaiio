import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { cancelSubscription as cancelPaystackSub } from '@/lib/payments/paystack-recurring';
import { cancelSubscription as cancelStripeSub } from '@/lib/payments/stripe-recurring';

export const recurringManageFlow: FlowDefinition = {
  type: 'payment', // runs within payment flow type context
  steps: [
    // ── List Subscriptions ──
    {
      id: 'list_subscriptions',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) {
          return [{ type: 'text', text: 'Business not found.' }];
        }

        const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;

        const { data: subs } = await ctx.supabase
          .from('customer_subscriptions')
          .select('id, amount, currency, frequency, status, service_id, next_charge_at, card_last_four')
          .eq('business_id', ctx.business.id)
          .eq('customer_phone', phone)
          .in('status', ['active', 'paused', 'past_due'])
          .order('created_at', { ascending: false });

        if (!subs || subs.length === 0) {
          return [{ type: 'text', text: 'You have no active recurring payments. Send *Hi* to start a new payment.' }];
        }

        // Load service names
        const serviceIds = [...new Set(subs.map(s => s.service_id).filter(Boolean))];
        const { data: services } = serviceIds.length > 0
          ? await ctx.supabase.from('services').select('id, name').in('id', serviceIds)
          : { data: [] };
        const serviceMap = new Map((services || []).map(s => [s.id, s.name]));

        const cc = (ctx.business.country_code || 'NG') as CountryCode;

        // Store subs in session for selection
        ctx.session.session_data._recurring_subs = subs.map(s => ({
          id: s.id,
          label: `${serviceMap.get(s.service_id) || 'Payment'} - ${formatCurrency(s.amount, cc)}/${s.frequency}`,
        }));

        return [{
          type: 'list',
          title: 'Your Recurring Payments',
          body: `You have ${subs.length} recurring payment(s):`,
          buttonLabel: 'Select',
          items: subs.map((s, i) => ({
            title: `${serviceMap.get(s.service_id) || 'Payment'}`,
            description: `${formatCurrency(s.amount, cc)}/${s.frequency} - ${s.status}${s.card_last_four ? ` (*${s.card_last_four})` : ''}`,
            postbackText: s.id,
          })),
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        const subs = ctx.session.session_data._recurring_subs as Array<{ id: string; label: string }>;
        const selected = subs?.find(s => s.id === input);
        if (!selected) return { valid: false, errorMessage: 'Please select a recurring payment from the list.' };
        return { valid: true, data: { _selected_sub_id: selected.id, _selected_sub_label: selected.label } };
      },
      async next() { return 'select_action'; },
    },

    // ── Select Action ──
    {
      id: 'select_action',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const label = ctx.session.session_data._selected_sub_label as string;
        return [{
          type: 'buttons',
          body: `*${label}*\n\nWhat would you like to do?`,
          buttons: [
            { id: 'cancel_sub', title: 'Cancel' },
            { id: 'view_details', title: 'View Details' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.toLowerCase();
        if (text === 'cancel_sub') return { valid: true, data: { _sub_action: 'cancel' } };
        if (text === 'view_details') return { valid: true, data: { _sub_action: 'details' } };
        return { valid: false, errorMessage: 'Please choose *Cancel* or *View Details*.' };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._sub_action === 'cancel') return 'confirm_cancel';
        // View details: show info and end
        const subId = ctx.session.session_data._selected_sub_id as string;
        const { data: sub } = await ctx.supabase
          .from('customer_subscriptions')
          .select('*')
          .eq('id', subId)
          .single();

        if (sub) {
          const cc = (ctx.business?.country_code || 'NG') as CountryCode;
          await ctx.sender.sendText({
            to: ctx.from,
            text: [
              `📋 *Subscription Details*`,
              '',
              `Amount: ${formatCurrency(sub.amount, cc)}`,
              `Frequency: ${sub.frequency}`,
              `Status: ${sub.status}`,
              `Total Charged: ${formatCurrency(sub.total_charged || 0, cc)}`,
              `Charges: ${sub.charge_count}`,
              sub.next_charge_at ? `Next Charge: ${new Date(sub.next_charge_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : '',
              sub.card_last_four ? `Card: *${sub.card_last_four} (${sub.card_brand || 'card'})` : '',
            ].filter(Boolean).join('\n'),
          });
        }
        return null;
      },
    },

    // ── Confirm Cancel ──
    {
      id: 'confirm_cancel',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        return [{
          type: 'buttons',
          body: 'Are you sure you want to cancel this recurring payment? You can always set it up again later.',
          buttons: [
            { id: 'yes_cancel', title: 'Yes, Cancel' },
            { id: 'keep', title: 'Keep It' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.toLowerCase();
        if (text === 'yes_cancel' || text === 'yes') return { valid: true, data: { _confirm_cancel: true } };
        if (text === 'keep' || text === 'no') return { valid: true, data: { _confirm_cancel: false } };
        return { valid: false, errorMessage: 'Please choose *Yes, Cancel* or *Keep It*.' };
      },
      async next(ctx: FlowContext) {
        if (!ctx.session.session_data._confirm_cancel) {
          await ctx.sender.sendText({ to: ctx.from, text: 'Your recurring payment is still active.' });
          return null;
        }
        return 'process_cancel';
      },
    },

    // ── Process Cancel ──
    {
      id: 'process_cancel',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const subId = ctx.session.session_data._selected_sub_id as string;

        const { data: sub } = await ctx.supabase
          .from('customer_subscriptions')
          .select('*')
          .eq('id', subId)
          .single();

        if (!sub) {
          return [{ type: 'text', text: 'Subscription not found. Send *Hi* to start again.' }];
        }

        // Cancel on gateway
        let cancelled = false;
        if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
          const emailToken = (ctx.session.session_data._recurring_email_token as string) || '';
          cancelled = await cancelPaystackSub(sub.gateway_subscription_code, emailToken);
        } else if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
          cancelled = await cancelStripeSub(sub.gateway_subscription_code);
        } else {
          cancelled = true; // No gateway subscription to cancel
        }

        // Update DB regardless
        await ctx.supabase
          .from('customer_subscriptions')
          .update({
            status: 'cancelled',
            cancelled_at: new Date().toISOString(),
          })
          .eq('id', subId);

        return [{
          type: 'text',
          text: cancelled
            ? '✅ Your recurring payment has been cancelled. You will no longer be charged automatically.'
            : '✅ Your recurring payment has been cancelled in our system. If you see any unexpected charges, please contact support.',
        }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },
  ],
};
