import type { SupabaseClient } from '@supabase/supabase-js';
import type { GupshupService } from '@/lib/channels/gupshup';
import type { StandaloneService } from '@/lib/bot/standalone.service';
import type { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import type { FlowContext, PromptMessage } from './types';
import type { FlowType, BusinessCategoryKey, CountryCode } from '@/lib/constants';
import { getFlowDefinition, getFlowStep } from './registry';

export class FlowExecutor {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly gupshup: GupshupService,
    private readonly standalone: StandaloneService,
    private readonly intelligence: BotIntelligenceService,
  ) {}

  /**
   * Execute a flow step for the given session.
   * If input is empty, sends the step's prompt.
   * If input is provided, validates and advances.
   */
  async execute(
    from: string,
    input: string,
    session: {
      id: string;
      user_id: string | null;
      business_id: string | null;
      current_step: string;
      session_data: Record<string, unknown>;
    },
    business: {
      id: string;
      name: string;
      slug: string;
      category: BusinessCategoryKey;
      flow_type: FlowType;
      subscription_tier: string;
      trial_ends_at: string;
      metadata: Record<string, unknown>;
      country_code?: CountryCode;
    } | null,
  ): Promise<void> {
    const flowType = business?.flow_type || 'scheduling';
    const flow = getFlowDefinition(flowType);
    const stepId = session.current_step;
    const step = getFlowStep(flowType, stepId);

    if (!step) {
      await this.sendText(from, 'Something went wrong. Send "Hi" to start again.');
      await this.deactivateSession(session.id);
      return;
    }

    const ctx: FlowContext = {
      supabase: this.supabase,
      gupshup: this.gupshup,
      standalone: this.standalone,
      intelligence: this.intelligence,
      from,
      session,
      business,
    };

    // Check if step should be skipped
    if (step.skipIf && await step.skipIf(ctx)) {
      const nextStepId = await step.next(ctx);
      if (nextStepId) {
        await this.advanceToStep(session, nextStepId, from, ctx);
      } else {
        await this.deactivateSession(session.id);
      }
      return;
    }

    // No input = show prompt
    if (!input) {
      const messages = await step.prompt(ctx);
      await this.sendMessages(from, messages);
      return;
    }

    // Validate input
    const result = await step.validate(input, ctx);

    if (!result.valid) {
      if (result.errorMessage) {
        await this.sendText(from, result.errorMessage);
      }
      return;
    }

    // Merge data into session
    if (result.data) {
      Object.assign(session.session_data, result.data);
      await this.supabase
        .from('bot_sessions')
        .update({ session_data: session.session_data })
        .eq('id', session.id);
    }

    // Advance to next step
    const nextStepId = await step.next(ctx);
    if (nextStepId) {
      await this.advanceToStep(session, nextStepId, from, ctx);
    } else {
      // Flow complete
      await this.deactivateSession(session.id);
    }
  }

  private async advanceToStep(
    session: { id: string; session_data: Record<string, unknown>; user_id: string | null; business_id: string | null; current_step: string },
    nextStepId: string,
    from: string,
    ctx: FlowContext,
  ): Promise<void> {
    session.current_step = nextStepId;
    await this.supabase
      .from('bot_sessions')
      .update({ current_step: nextStepId, session_data: session.session_data })
      .eq('id', session.id);

    const flow = getFlowDefinition(ctx.business?.flow_type || 'scheduling');
    const nextStep = flow.steps.find(s => s.id === nextStepId);

    if (!nextStep) {
      await this.deactivateSession(session.id);
      return;
    }

    // Check skip
    if (nextStep.skipIf && await nextStep.skipIf(ctx)) {
      const afterNext = await nextStep.next(ctx);
      if (afterNext) {
        await this.advanceToStep(session, afterNext, from, ctx);
      } else {
        await this.deactivateSession(session.id);
      }
      return;
    }

    // Show next step's prompt
    const messages = await nextStep.prompt(ctx);
    await this.sendMessages(from, messages);
  }

  private async sendMessages(to: string, messages: PromptMessage[]): Promise<void> {
    for (const msg of messages) {
      switch (msg.type) {
        case 'text':
          await this.gupshup.sendText({ to, text: msg.text });
          break;
        case 'list':
          await this.gupshup.sendList({ to, title: msg.title, body: msg.body, buttonLabel: msg.buttonLabel, items: msg.items });
          break;
        case 'buttons':
          await this.gupshup.sendButtons({ to, body: msg.body, buttons: msg.buttons });
          break;
        case 'image':
          await this.gupshup.sendImage({ to, imageUrl: msg.imageUrl, caption: msg.caption });
          break;
      }
    }
  }

  private async sendText(to: string, text: string): Promise<void> {
    await this.gupshup.sendText({ to, text });
  }

  private async deactivateSession(sessionId: string): Promise<void> {
    await this.supabase
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('id', sessionId);
  }
}
