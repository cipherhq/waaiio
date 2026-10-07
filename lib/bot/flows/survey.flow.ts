import type { FlowDefinition, FlowStepConfig, FlowContext, PromptMessage, ValidationResult } from './types';
import { getFlowCopy } from './flow-localization';
import { getCapabilityLabel } from './capability-selection.flow';
import type { CapabilityId } from '@/lib/capabilities/types';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { truncTitle } from '../utils/truncate';
import { getPoweredByFooter, getPoweredByHtml } from '@/lib/whitelabel';

/**
 * Survey Flow
 *
 * Walks a customer through a multi-question survey via WhatsApp.
 * Questions are stored in session_data.survey_questions (JSONB array).
 * Each question has: { id, type, text, options?, required? }
 *
 * Steps: survey_intro → survey_question (loops) → survey_complete
 */

interface SurveyQuestion {
  id: string;
  type: 'choice' | 'rating' | 'text' | 'yes_no';
  text: string;
  options?: string[];
  required?: boolean;
}

// ── Step 1: Intro ──

const surveyIntroStep: FlowStepConfig = {
  id: 'survey_intro',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const d = ctx.session.session_data;
    const title = (d.survey_title as string) || 'Quick Survey';
    const description = (d.survey_description as string) || '';
    const questions = (d.survey_questions as SurveyQuestion[]) || [];

    let body = `📊 *${title}*`;
    if (description) body += `\n${description}`;
    body += `\n\n${questions.length} question${questions.length === 1 ? '' : 's'} — takes about a minute.`;

    return [{
      type: 'buttons',
      body,
      buttons: [
        { id: 'survey_start', title: getFlowCopy(ctx.copyLang, 'survey.start') },
        { id: 'survey_skip', title: getFlowCopy(ctx.copyLang, 'survey.not_now') },
      ],
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const lower = input.toLowerCase().trim();
    if (lower === 'survey_start' || lower === 'start' || lower === 'yes') {
      return { valid: true, data: { survey_accepted: true, survey_q_index: 0, survey_answers: {} } };
    }
    if (lower === 'survey_skip' || lower === 'not now' || lower === 'no' || lower === 'skip') {
      return { valid: true, data: { survey_accepted: false } };
    }
    return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'survey.start_hint') };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data.survey_accepted) return 'survey_question';
    return 'survey_complete';
  },
};

// ── Step 2: Dynamic Question (loops for each question) ──

const surveyQuestionStep: FlowStepConfig = {
  id: 'survey_question',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const d = ctx.session.session_data;
    const questions = (d.survey_questions as SurveyQuestion[]) || [];
    const index = (d.survey_q_index as number) || 0;
    const q = questions[index];

    if (!q) return [{ type: 'text', text: 'Survey complete!' }];

    const prefix = `*Q${index + 1}/${questions.length}:* `;

    if (q.type === 'yes_no') {
      return [{
        type: 'buttons',
        body: prefix + q.text,
        buttons: [
          { id: 'survey_yes', title: getFlowCopy(ctx.copyLang, 'survey.yes') },
          { id: 'survey_no', title: getFlowCopy(ctx.copyLang, 'survey.no') },
        ],
      }];
    }

    if (q.type === 'rating') {
      return [{
        type: 'buttons',
        body: prefix + q.text,
        buttons: [
          { id: 'survey_rate_5', title: getFlowCopy(ctx.copyLang, 'rating.excellent') },
          { id: 'survey_rate_4', title: getFlowCopy(ctx.copyLang, 'rating.good') },
          { id: 'survey_rate_3', title: getFlowCopy(ctx.copyLang, 'rating.average') },
        ],
      }, {
        type: 'buttons',
        body: getFlowCopy(ctx.copyLang, 'rating.or'),
        buttons: [
          { id: 'survey_rate_2', title: getFlowCopy(ctx.copyLang, 'rating.poor') },
          { id: 'survey_rate_1', title: getFlowCopy(ctx.copyLang, 'rating.terrible') },
        ],
      }];
    }

    if (q.type === 'choice' && q.options) {
      if (q.options.length <= 3) {
        return [{
          type: 'buttons',
          body: prefix + q.text,
          buttons: q.options.map((opt, i) => ({
            id: `survey_opt_${i}`,
            title: truncTitle(opt), // WhatsApp button title max 20 chars
          })),
        }];
      }
      // 4+ options → list message
      return [{
        type: 'list',
        title: getFlowCopy(ctx.copyLang, 'survey.title'),
        body: prefix + q.text,
        buttonLabel: getFlowCopy(ctx.copyLang, 'nav.choose'),
        items: q.options.map((opt, i) => ({
          title: truncTitle(opt, 24),
          postbackText: `survey_opt_${i}`,
        })),
      }];
    }

    // Text question
    const skipHint = q.required === false ? ' (or type *skip*)' : '';
    return [{
      type: 'text',
      text: `${prefix}${q.text}${skipHint}\n\n_Type *cancel* to skip the survey._`,
    }];
  },

  async validate(input: string, ctx: FlowContext): Promise<ValidationResult> {
    const d = ctx.session.session_data;
    const questions = (d.survey_questions as SurveyQuestion[]) || [];
    const index = (d.survey_q_index as number) || 0;
    const q = questions[index];

    if (!q) return { valid: true };

    // Escape hatch: allow user to cancel the survey mid-flow
    const lower = input.toLowerCase().trim();
    if (lower === 'cancel_survey' || lower === 'cancel' || lower === 'stop' || lower === 'exit') {
      return { valid: true, data: { _survey_cancelled: true } };
    }

    const answers = (d.survey_answers as Record<string, unknown>) || {};
    const trimmed = input.trim();

    if (q.type === 'yes_no') {
      const lower = trimmed.toLowerCase();
      if (lower === 'survey_yes' || lower === 'yes') {
        answers[q.id] = 'Yes';
        return { valid: true, data: { survey_answers: answers, survey_q_index: index + 1 } };
      }
      if (lower === 'survey_no' || lower === 'no') {
        answers[q.id] = 'No';
        return { valid: true, data: { survey_answers: answers, survey_q_index: index + 1 } };
      }
      return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'survey.yes_no_hint') };
    }

    if (q.type === 'rating') {
      const match = trimmed.match(/survey_rate_(\d)/);
      const num = match ? parseInt(match[1], 10) : parseInt(trimmed, 10);
      if (num >= 1 && num <= 5) {
        answers[q.id] = num;
        return { valid: true, data: { survey_answers: answers, survey_q_index: index + 1 } };
      }
      return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'survey.select_rating') };
    }

    if (q.type === 'choice' && q.options) {
      // Match by button/list id
      const optMatch = trimmed.match(/survey_opt_(\d+)/);
      if (optMatch) {
        const optIndex = parseInt(optMatch[1], 10);
        if (optIndex >= 0 && optIndex < q.options.length) {
          answers[q.id] = q.options[optIndex];
          return { valid: true, data: { survey_answers: answers, survey_q_index: index + 1 } };
        }
      }
      // Match by exact option text
      const found = q.options.find(o => o.toLowerCase() === trimmed.toLowerCase());
      if (found) {
        answers[q.id] = found;
        return { valid: true, data: { survey_answers: answers, survey_q_index: index + 1 } };
      }
      return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'survey.select_option') };
    }

    // Text
    if (q.required !== false && !trimmed) {
      return { valid: false, errorMessage: getFlowCopy(ctx.copyLang, 'survey.type_answer') };
    }
    if (trimmed.toLowerCase() === 'skip' && q.required === false) {
      answers[q.id] = null;
    } else {
      answers[q.id] = trimmed;
    }
    return { valid: true, data: { survey_answers: answers, survey_q_index: index + 1 } };
  },

  async next(ctx: FlowContext) {
    if (ctx.session.session_data._survey_cancelled) {
      return 'survey_complete';
    }
    const d = ctx.session.session_data;
    const questions = (d.survey_questions as SurveyQuestion[]) || [];
    const index = (d.survey_q_index as number) || 0;

    if (index < questions.length) return 'survey_question'; // loop
    return 'survey_complete';
  },
};

// ── Step 3: Complete ──

const surveyCompleteStep: FlowStepConfig = {
  id: 'survey_complete',

  async prompt(ctx: FlowContext): Promise<PromptMessage[]> {
    const d = ctx.session.session_data;
    const accepted = d.survey_accepted as boolean;

    if (d._survey_cancelled) {
      return [{ type: 'text', text: getFlowCopy(ctx.copyLang, 'survey.cancelled') }];
    }

    if (!accepted) {
      return [{ type: 'text', text: getFlowCopy(ctx.copyLang, 'survey.skip_later') }];
    }

    const surveyId = d.survey_id as string;
    const answers = (d.survey_answers as Record<string, unknown>) || {};

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

    // Upsert response (unique on survey_id + customer_phone)
    if (surveyId && ctx.business) {
      await ctx.supabase.from('survey_responses').upsert({
        survey_id: surveyId,
        business_id: ctx.business.id,
        customer_phone: ctx.from,
        customer_name: customerName,
        answers,
        completed: true,
        completed_at: new Date().toISOString(),
      }, { onConflict: 'survey_id,customer_phone' });

      // Update total_responses from actual count
      const { count } = await ctx.supabase
        .from('survey_responses')
        .select('id', { count: 'exact', head: true })
        .eq('survey_id', surveyId)
        .eq('completed', true);
      await ctx.supabase.from('surveys')
        .update({ total_responses: count || 0 })
        .eq('id', surveyId);

      // Notify owner about survey completion (email + WhatsApp)
      {
        const surveyTitle = (d.survey_title as string) || 'Quick Survey';
        const displayName = customerName || ctx.from;
        const { notifyOwnerGeneric } = await import('./shared/notify-owner');
        notifyOwnerGeneric({
          supabase: ctx.supabase,
          sender: ctx.sender,
          businessId: ctx.business.id,
          subject: `Survey completed: ${surveyTitle}`,
          emailHtml: `<p>${displayName} completed your survey "${surveyTitle}". View responses in your dashboard.</p>${getPoweredByHtml(ctx.business.subscription_tier)}`,
          whatsappText: `📋 *Survey Response*\n\n${displayName} completed your survey "${surveyTitle}".\n\nView responses in your dashboard.${getPoweredByFooter(ctx.business.subscription_tier)}`,
        }).catch(err => logger.withContext({ op: 'survey.owner-notify', ...safeLogErrorContext(err) }).error('[SURVEY] Failed to notify owner of survey completion'));
      }
    }

    const messages: PromptMessage[] = [
      { type: 'text', text: getFlowCopy(ctx.copyLang, 'survey.complete') },
    ];

    // Show capability buttons so user can continue
    if (ctx.business) {
      try {
        const { getEnabledCapabilities } = await import('@/lib/capabilities/service');
        const capabilities = await getEnabledCapabilities(ctx.supabase, ctx.business.id, ctx.business.category);
        const userFacing = capabilities.filter(
          (c: string) => !['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'survey', 'broadcast', 'recurring', 'auto_reply', 'membership', 'whatsapp_sign', 'poll'].includes(c),
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
            body: getFlowCopy(ctx.copyLang, 'feedback.anything_else'),
            buttons,
          });
          return messages;
        }
      } catch (err) {
        logger.withContext({ op: 'survey.capabilities-fetch', ...safeLogErrorContext(err) }).error('[SURVEY] Capabilities fetch error');
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

export const surveyFlow: FlowDefinition = {
  type: 'scheduling' as const, // pseudo-flow
  steps: [
    surveyIntroStep,
    surveyQuestionStep,
    surveyCompleteStep,
  ],
};
