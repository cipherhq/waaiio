import type { FlowDefinition, FlowContext, PromptMessage, ValidationResult } from './types';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { cancelSubscription as cancelPaystackSub, enableSubscription as enablePaystackSub } from '@/lib/payments/paystack-recurring';
import { cancelSubscription as cancelStripeSub, pauseSubscription as pauseStripeSub, resumeSubscription as resumeStripeSub } from '@/lib/payments/stripe-recurring';

export const recurringManageFlow: FlowDefinition = {
  type: 'payment', // runs within payment flow type context
  steps: [
    // ── List Subscriptions ──
    {
      id: 'list_subscriptions',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        if (!ctx.business) {
          return [{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }];
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
          ctx.session.session_data._recurring_empty = true;
          return [{
            type: 'buttons',
            body: 'You have no active recurring payments.',
            buttons: [{ id: 'back_to_account', title: '← Back' }],
          }];
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

        const listItems = subs.map((s, i) => ({
          title: `${serviceMap.get(s.service_id) || 'Payment'}`,
          description: `${formatCurrency(s.amount, cc)}/${s.frequency} - ${s.status}${s.card_last_four ? ` (*${s.card_last_four})` : ''}`,
          postbackText: s.id,
        }));
        listItems.push({ title: '← Back to My Account', description: 'Return to account menu', postbackText: 'back_to_account' });

        return [{
          type: 'list',
          title: 'Your Recurring Payments',
          body: `You have ${subs.length} recurring payment(s):`,
          buttonLabel: 'Select',
          items: listItems,
        }];
      },
      async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
        // Handle back to account
        if (input === 'back_to_account') {
          return { valid: true, data: { _recurring_action: 'back_to_account' } };
        }

        // If no subscriptions found, any input routes back
        if (ctx.session.session_data._recurring_empty) {
          return { valid: true, data: { _recurring_action: 'back_to_account' } };
        }

        const subs = ctx.session.session_data._recurring_subs as Array<{ id: string; label: string }>;
        const selected = subs?.find(s => s.id === input);
        if (!selected) return { valid: false, errorMessage: 'Please select a recurring payment from the list.' };
        return { valid: true, data: { _selected_sub_id: selected.id, _selected_sub_label: selected.label } };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._recurring_action === 'back_to_account') return 'my_account_menu';
        if (ctx.session.session_data._recurring_empty) return null; // End session cleanly when no recurring payments
        return 'select_action';
      },
    },

    // ── Select Action ──
    {
      id: 'select_action',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const label = ctx.session.session_data._selected_sub_label as string;
        const subId = ctx.session.session_data._selected_sub_id as string;

        // Check current subscription status to show appropriate pause/resume option
        const { data: sub } = await ctx.supabase
          .from('customer_subscriptions')
          .select('status')
          .eq('id', subId)
          .single();

        const isPaused = sub?.status === 'paused';
        ctx.session.session_data._sub_is_paused = isPaused;

        const buttons: Array<{ id: string; title: string }> = [];
        if (isPaused) {
          buttons.push({ id: 'resume_sub', title: 'Resume' });
        } else {
          buttons.push({ id: 'pause_sub', title: 'Pause' });
        }
        buttons.push({ id: 'cancel_sub', title: 'Cancel' });
        buttons.push({ id: 'view_details', title: 'View Details' });

        return [{
          type: 'buttons',
          body: `*${label}*${isPaused ? ' (Paused)' : ''}\n\nWhat would you like to do?`,
          buttons,
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.toLowerCase();
        if (text === 'cancel_sub') return { valid: true, data: { _sub_action: 'cancel' } };
        if (text === 'pause_sub') return { valid: true, data: { _sub_action: 'pause' } };
        if (text === 'resume_sub') return { valid: true, data: { _sub_action: 'resume' } };
        if (text === 'view_details') return { valid: true, data: { _sub_action: 'details' } };
        return { valid: false, errorMessage: 'Please choose an option from the buttons.' };
      },
      async next(ctx: FlowContext) {
        if (ctx.session.session_data._sub_action === 'cancel') return 'confirm_cancel';
        if (ctx.session.session_data._sub_action === 'pause') return 'confirm_pause';
        if (ctx.session.session_data._sub_action === 'resume') return 'process_resume';
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
            text: await ctx.t([
              `📋 *Subscription Details*`,
              '',
              `Amount: ${formatCurrency(sub.amount, cc)}`,
              `Frequency: ${sub.frequency}`,
              `Status: ${sub.status}`,
              `Total Charged: ${formatCurrency(sub.total_charged || 0, cc)}`,
              `Charges: ${sub.charge_count}`,
              sub.next_charge_at ? `Next Charge: ${new Date(sub.next_charge_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : '',
              sub.card_last_four ? `Card: *${sub.card_last_four} (${sub.card_brand || 'card'})` : '',
            ].filter(Boolean).join('\n')
            + `\n\n💡 *What you can do:*\n• Type *subscriptions* to manage payments\n• Type *Hi* to start a new conversation`),
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
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('Your recurring payment is still active.') });
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
          return [{ type: 'text', text: 'Subscription not found. Send *Hi* to start over.' }];
        }

        // Cancel on gateway
        let cancelled = false;
        try {
          if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
            const emailToken = (ctx.session.session_data._recurring_email_token as string) || '';
            cancelled = await cancelPaystackSub(sub.gateway_subscription_code, emailToken);
          } else if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
            cancelled = await cancelStripeSub(sub.gateway_subscription_code);
          } else {
            cancelled = true; // No gateway subscription to cancel
          }
        } catch (err) {
          console.error('[RECURRING] Gateway cancel error (continuing with DB cancel):', err);
          cancelled = false;
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
          text: (cancelled
            ? '✅ Your recurring payment has been cancelled. You will no longer be charged automatically.'
            : '✅ Your recurring payment has been cancelled in our system. If you see any unexpected charges, please contact support.')
            + `\n\n💡 *What you can do:*\n• Type *subscriptions* to manage payments\n• Type *Hi* to start a new conversation`,
        }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },

    // ── Confirm Pause ──
    {
      id: 'confirm_pause',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const label = ctx.session.session_data._selected_sub_label as string;
        return [{
          type: 'buttons',
          body: `Are you sure you want to pause *${label}*? You can resume anytime.`,
          buttons: [
            { id: 'yes_pause', title: 'Yes, Pause' },
            { id: 'keep_active', title: 'No, Keep Active' },
          ],
        }];
      },
      async validate(input: string): Promise<ValidationResult> {
        const text = input.toLowerCase();
        if (text === 'yes_pause' || text === 'yes') return { valid: true, data: { _confirm_pause: true } };
        if (text === 'keep_active' || text === 'no') return { valid: true, data: { _confirm_pause: false } };
        return { valid: false, errorMessage: 'Please choose *Yes, Pause* or *No, Keep Active*.' };
      },
      async next(ctx: FlowContext) {
        if (!ctx.session.session_data._confirm_pause) {
          await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('Your recurring payment is still active.') });
          return null;
        }
        return 'process_pause';
      },
    },

    // ── Process Pause ──
    {
      id: 'process_pause',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const subId = ctx.session.session_data._selected_sub_id as string;

        const { data: sub } = await ctx.supabase
          .from('customer_subscriptions')
          .select('*')
          .eq('id', subId)
          .single();

        if (!sub) {
          return [{ type: 'text', text: 'Subscription not found. Send *Hi* to start over.' }];
        }

        // Pause on gateway
        let paused = false;
        try {
          if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
            paused = await pauseStripeSub(sub.gateway_subscription_code);
          } else {
            // Paystack doesn't have native pause — we just update DB status
            // Webhook handler will skip charges for paused subscriptions
            paused = true;
          }
        } catch (err) {
          console.error('[RECURRING] Gateway pause error:', err);
          paused = false;
        }

        if (!paused) {
          return [{
            type: 'text',
            text: 'Something went wrong on our end. Please try again later or type *subscriptions* to retry.',
          }];
        }

        // Update DB
        await ctx.supabase
          .from('customer_subscriptions')
          .update({
            status: 'paused',
            paused_at: new Date().toISOString(),
          })
          .eq('id', subId);

        // Load service name for confirmation
        const { data: service } = sub.service_id
          ? await ctx.supabase.from('services').select('name').eq('id', sub.service_id).single()
          : { data: null };
        const serviceName = service?.name || 'Payment';

        return [{
          type: 'text',
          text: `✅ Your *${serviceName}* recurring payment has been paused. Type *subscriptions* to resume anytime.`
            + `\n\n💡 *What you can do:*\n• Type *subscriptions* to manage payments\n• Type *Hi* to start a new conversation`,
        }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },

    // ── Process Resume ──
    {
      id: 'process_resume',
      async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
        const subId = ctx.session.session_data._selected_sub_id as string;

        const { data: sub } = await ctx.supabase
          .from('customer_subscriptions')
          .select('*')
          .eq('id', subId)
          .single();

        if (!sub) {
          return [{ type: 'text', text: 'Subscription not found. Send *Hi* to start over.' }];
        }

        // Resume on gateway
        let resumed = false;
        try {
          if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
            resumed = await resumeStripeSub(sub.gateway_subscription_code);
          } else if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
            // Re-enable the Paystack subscription
            const metadata = (sub.metadata as Record<string, string>) || {};
            const emailToken = (ctx.session.session_data._recurring_email_token as string) || metadata.email_token || '';
            resumed = await enablePaystackSub(sub.gateway_subscription_code, emailToken);
          } else {
            // No gateway subscription — just update status
            resumed = true;
          }
        } catch (err) {
          console.error('[RECURRING] Gateway resume error:', err);
          resumed = false;
        }

        if (!resumed) {
          return [{
            type: 'text',
            text: 'Something went wrong on our end. Please try again later or type *subscriptions* to retry.',
          }];
        }

        // Update DB
        await ctx.supabase
          .from('customer_subscriptions')
          .update({
            status: 'active',
            paused_at: null,
          })
          .eq('id', subId);

        // Load service name and next charge for confirmation
        const { data: service } = sub.service_id
          ? await ctx.supabase.from('services').select('name').eq('id', sub.service_id).single()
          : { data: null };
        const serviceName = service?.name || 'Payment';

        const nextCharge = sub.next_charge_at
          ? new Date(sub.next_charge_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          : 'soon';

        return [{
          type: 'text',
          text: `✅ Your *${serviceName}* recurring payment has been resumed. Next charge: ${nextCharge}.`
            + `\n\n💡 *What you can do:*\n• Type *subscriptions* to manage payments\n• Type *Hi* to start a new conversation`,
        }];
      },
      async validate(): Promise<ValidationResult> { return { valid: true }; },
      async next() { return null; },
    },
  ],
};
