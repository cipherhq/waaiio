import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { getCapabilityLabel } from './capability-selection.flow';
import type { CapabilityId } from '@/lib/capabilities/types';
import { truncTitle } from '../utils/truncate';

/**
 * Poll Flow
 *
 * Presents a poll question to the customer, records their vote,
 * and shows results. Supports change-vote and result visibility settings.
 *
 * Session data expected:
 *   poll_id, poll_question, poll_options (string[]),
 *   poll_allow_change, poll_show_results
 */

function formatResults(options: string[], votes: Record<number, number>, total: number): string {
  return options.map((opt, i) => {
    const count = votes[i] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const filled = Math.min(10, Math.max(0, Math.round(pct / 10)));
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    return `${opt}\n${bar} ${pct}% (${count})`;
  }).join('\n\n');
}

// ── Step 1: Show Poll ──

const pollQuestionStep: FlowStepConfig = {
  id: 'poll_question',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const d = ctx.session.session_data;
    const question = d.poll_question as string;
    const options = (d.poll_options as string[]) || [];
    const showResults = d.poll_show_results as string;

    // Check if poll has expired
    const closesAt = d.poll_closes_at as string | undefined;
    if (closesAt && new Date(closesAt) < new Date()) {
      return [{ type: 'text', text: 'This poll has closed. Thank you for your interest!' }];
    }

    // Check if already voted
    if (d._poll_already_voted && !d.poll_allow_change) {
      const optionIndex = d._poll_voted_index as number;
      const votedFor = options[optionIndex] || 'Unknown';

      let msg = `You already voted for *${votedFor}*!`;

      if (showResults === 'always' || showResults === 'after_vote') {
        const pollId = d.poll_id as string;
        const { data: allVotes } = await ctx.supabase
          .from('poll_votes')
          .select('option_index')
          .eq('poll_id', pollId);

        const voteCounts: Record<number, number> = {};
        for (const v of allVotes || []) {
          voteCounts[v.option_index] = (voteCounts[v.option_index] || 0) + 1;
        }
        const total = (allVotes || []).length;
        msg += '\n\n📊 *Current Results:*\n\n' + formatResults(options, voteCounts, total);
      }

      return [{ type: 'text', text: msg }];
    }

    // Show poll question with options
    const body = `📊 *${question}*\n\nTap your choice:`;

    if (options.length <= 3) {
      return [{
        type: 'buttons',
        body,
        buttons: options.map((opt, i) => ({
          id: `poll_vote_${i}`,
          title: truncTitle(opt),
        })),
      }];
    }

    return [{
      type: 'list',
      title: 'Poll',
      body,
      buttonLabel: 'Vote',
      items: options.map((opt, i) => ({
        title: truncTitle(opt, 24),
        postbackText: `poll_vote_${i}`,
      })),
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const d = ctx.session.session_data;
    const options = (d.poll_options as string[]) || [];
    const pollId = d.poll_id as string;
    const allowChange = d.poll_allow_change as boolean;

    // Already voted and can't change
    if (d._poll_already_voted && !allowChange) {
      return { valid: true };
    }

    // Escape hatch: allow user to cancel/skip the poll
    const lower = input.toLowerCase().trim();
    if (lower === 'cancel' || lower === 'skip' || lower === 'exit' || lower === 'no thanks') {
      return { valid: true, data: { _poll_cancelled: true } };
    }

    // Parse vote
    const match = input.match(/poll_vote_(\d+)/);
    const optIndex = match ? parseInt(match[1], 10) : -1;

    // Also try matching by option text
    let resolvedIndex = optIndex;
    if (resolvedIndex < 0) {
      const lower = input.toLowerCase().trim();
      resolvedIndex = options.findIndex(o => o.toLowerCase() === lower);
    }

    if (resolvedIndex < 0 || resolvedIndex >= options.length) {
      return { valid: false, errorMessage: 'Please select one of the options.' };
    }

    // Check expiration
    const closesAt = d.poll_closes_at as string | undefined;
    if (closesAt && new Date(closesAt) < new Date()) {
      return { valid: true, data: { _poll_expired: true } };
    }

    // Check if already voted
    const { data: existing } = await ctx.supabase
      .from('poll_votes')
      .select('id, option_index')
      .eq('poll_id', pollId)
      .eq('customer_phone', ctx.from)
      .maybeSingle();

    if (existing && !allowChange) {
      return { valid: true, data: { _poll_already_voted: true, _poll_voted_index: existing.option_index } };
    }

    // Get customer name
    const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
    let customerName: string | null = null;
    const { data: profile } = await ctx.supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('phone', phone)
      .maybeSingle();
    if (profile?.first_name) {
      customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
    }

    if (existing && allowChange) {
      // Update existing vote
      await ctx.supabase
        .from('poll_votes')
        .update({ option_index: resolvedIndex, voted_at: new Date().toISOString() })
        .eq('id', existing.id);
    } else {
      // Insert new vote
      await ctx.supabase.from('poll_votes').insert({
        poll_id: pollId,
        business_id: ctx.business!.id,
        customer_phone: ctx.from,
        customer_name: customerName,
        option_index: resolvedIndex,
      });

      // Update total_votes from actual count (prevents drift)
      const { count } = await ctx.supabase
        .from('poll_votes')
        .select('id', { count: 'exact', head: true })
        .eq('poll_id', pollId);
      await ctx.supabase
        .from('polls')
        .update({ total_votes: count || 0 })
        .eq('id', pollId);

      // Notify owner about new poll response (email + WhatsApp)
      if (ctx.business) {
        const pollTitle = (d.poll_question as string) || 'your poll';
        const displayName = customerName || ctx.from;
        const { notifyOwnerGeneric } = await import('./shared/notify-owner');
        notifyOwnerGeneric({
          supabase: ctx.supabase,
          sender: ctx.sender,
          businessId: ctx.business.id,
          subject: `New poll response: ${pollTitle}`,
          emailHtml: `<p>${displayName} voted in "${pollTitle}". View results in your dashboard.</p><p style="color:#999;font-size:12px">Powered by Waaiio</p>`,
          whatsappText: `📊 *Poll Vote*\n\n${displayName} voted in "${pollTitle}".\n\nView results in your dashboard.\n\n_Powered by Waaiio_`,
        }).catch(() => {});
      }
    }

    return {
      valid: true,
      data: {
        _poll_voted: true,
        _poll_voted_index: resolvedIndex,
        _poll_changed: !!existing,
      },
    };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._poll_cancelled) {
      await ctx.sender.sendText({ to: ctx.from, text: await ctx.t('No problem! Type *Hi* to explore more.') });
      return null;
    }
    if (ctx.session.session_data._poll_already_voted) return null;
    if (ctx.session.session_data._poll_voted) return 'poll_results';
    return null;
  },
};

// ── Step 2: Show Results ──

const pollResultsStep: FlowStepConfig = {
  id: 'poll_results',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const d = ctx.session.session_data;
    const options = (d.poll_options as string[]) || [];
    const votedIndex = d._poll_voted_index as number;
    const changed = d._poll_changed as boolean;
    const showResults = d.poll_show_results as string;
    const pollId = d.poll_id as string;

    const votedFor = options[votedIndex] || 'Unknown';
    let msg = changed
      ? `Vote changed to *${votedFor}*! ✅`
      : `Thanks for voting for *${votedFor}*! ✅`;

    if (showResults === 'after_vote' || showResults === 'always') {
      const { data: allVotes } = await ctx.supabase
        .from('poll_votes')
        .select('option_index')
        .eq('poll_id', pollId);

      const voteCounts: Record<number, number> = {};
      for (const v of allVotes || []) {
        voteCounts[v.option_index] = (voteCounts[v.option_index] || 0) + 1;
      }
      const total = (allVotes || []).length;

      msg += '\n\n📊 *Results so far:*\n\n' + formatResults(options, voteCounts, total);
    } else if (showResults === 'after_close') {
      msg += '\n\nResults will be shared when the poll closes.';
    }

    const messages: PromptMessage[] = [{ type: 'text', text: msg }];

    // Show capability menu
    if (ctx.business) {
      try {
        const { getEnabledCapabilities } = await import('@/lib/capabilities/service');
        const capabilities = await getEnabledCapabilities(ctx.supabase, ctx.business.id, ctx.business.category);
        const userFacing = capabilities.filter(
          (c: string) => !['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'survey', 'poll', 'broadcast', 'recurring', 'auto_reply', 'membership', 'whatsapp_sign'].includes(c),
        );

        if (userFacing.length > 0) {
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
            body: 'Anything else?',
            buttons,
          });
          return messages;
        }
      } catch (err) {
        console.error('[POLL] Capabilities fetch error:', err);
      }
    }

    return messages;
  },

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  },

  async next() {
    return null;
  },
};

export const pollFlow: FlowDefinition = {
  type: 'scheduling' as const, // pseudo-flow
  steps: [
    pollQuestionStep,
    pollResultsStep,
  ],
};
