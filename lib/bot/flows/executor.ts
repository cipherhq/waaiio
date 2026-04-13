import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { StandaloneService } from '@/lib/bot/standalone.service';
import type { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import type { FlowContext, PromptMessage } from './types';
import type { FlowType, BusinessCategoryKey, CountryCode } from '@/lib/constants';
import { getFlowDefinition, getFlowStep, getFlowStepAcrossFlows, getExtendedFlowDefinition } from './registry';
import type { CapabilityId } from '@/lib/capabilities/types';
import { loadOverrides, evaluateBranchConditions, type StepOverride } from '@/lib/bot/step-overrides';

export class FlowExecutor {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly sender: MessageSender,
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
    // Determine which flow to use: active_capability takes priority
    const activeCap = session.session_data.active_capability as CapabilityId | undefined;
    const flowType = activeCap
      ? this.capabilityToFlowType(activeCap)
      : (business?.flow_type || 'scheduling');
    const stepId = session.current_step;

    // Try the primary flow first, then search across all flows
    let step = getFlowStep(flowType as FlowType, stepId);
    let resolvedFlowType: string = flowType;

    if (!step) {
      // Cross-flow lookup (handles capability-selection → flow handoff)
      const crossResult = getFlowStepAcrossFlows(stepId);
      if (crossResult) {
        step = crossResult.step;
        resolvedFlowType = crossResult.flowType;
      }
    }

    if (!step) {
      await this.sendText(from, 'Something went wrong. Send "Hi" to start again.');
      await this.deactivateSession(session.id);
      return;
    }

    const ctx: FlowContext = {
      supabase: this.supabase,
      sender: this.sender,
      standalone: this.standalone,
      intelligence: this.intelligence,
      from,
      session,
      business,
    };

    // ── Step overrides: load business-level overrides ──
    let override: StepOverride | undefined;
    if (business) {
      try {
        const overrides = await loadOverrides(this.supabase, business.id, resolvedFlowType);
        override = overrides.get(stepId);
      } catch { /* non-fatal */ }
    }

    // Check if step should be skipped (override or programmatic)
    const shouldSkip = override?.action === 'skip'
      || (override?.action !== 'require' && step.skipIf && await step.skipIf(ctx));

    if (shouldSkip) {
      const nextStepId = await step.next(ctx);
      if (nextStepId) {
        await this.advanceToStep(session, nextStepId, from, ctx);
      } else {
        await this.deactivateSession(session.id);
      }
      return;
    }

    // No input = show prompt (possibly customized)
    if (!input) {
      if (override?.action === 'custom' && override.customPrompt) {
        // Send custom prompt text instead of the step's default
        await this.sendText(from, override.customPrompt);
      } else {
        const messages = await step.prompt(ctx);
        await this.sendMessages(from, messages);
      }
      return;
    }

    // Global escape hatch: cancel / start over at any step
    const lowerInput = input.toLowerCase().trim();
    if (lowerInput === 'cancel' || lowerInput === 'stop' || lowerInput === 'quit') {
      await this.deactivateSession(session.id);
      await this.sendText(from, 'Cancelled. Send *Hi* to start again.');
      return;
    }
    if (lowerInput === 'start over' || lowerInput === 'restart' || lowerInput === 'reset') {
      await this.deactivateSession(session.id);
      await this.sendText(from, 'No problem! Send *Hi* to start fresh.');
      return;
    }

    // Global escalation escape hatch: "talk to human" works at any step
    const escalationPattern = /\b(talk|speak|chat)\s+(to|with)\s+(a\s+)?(human|agent|person|staff|someone)\b|\b(live\s+(agent|chat|support))\b|\b(customer\s+service)\b|\b(i\s+need\s+(a\s+)?(human|agent|help))\b/i;
    if (escalationPattern.test(lowerInput) && business) {
      const { getEnabledCapabilities } = await import('@/lib/capabilities/service');
      const caps = await getEnabledCapabilities(this.supabase, business.id);
      if (caps.includes('chat')) {
        const { escalateToHuman } = await import('@/lib/bot/handoff.service');
        // Get customer name
        const phoneP = from.startsWith('+') ? from : `+${from}`;
        const phoneN = from.startsWith('+') ? from.slice(1) : from;
        let customerName: string | null = null;
        const { data: profile } = await this.supabase
          .from('profiles')
          .select('first_name, last_name')
          .or(`phone.eq.${phoneP},phone.eq.${phoneN}`)
          .limit(1)
          .maybeSingle();
        if (profile?.first_name) {
          customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
        }
        await escalateToHuman({
          supabase: this.supabase,
          sender: this.sender,
          from,
          businessId: business.id,
          businessName: business.name,
          sessionId: session.id,
          sessionData: session.session_data,
          currentStep: session.current_step,
          customerName,
        });
        return;
      }
    }

    // Validate input
    const result = await step.validate(input, ctx);

    if (!result.valid) {
      if (result.errorMessage) {
        await this.sendText(from, `${result.errorMessage}\n\n_Type *cancel* to exit or *start over* to restart._`);
      }
      // Re-send interactive prompts (buttons/list) so user gets fresh clickable options
      // WhatsApp buttons are single-use — once tapped, they gray out
      const retryMessages = await step.prompt(ctx);
      if (retryMessages.some(m => m.type === 'buttons' || m.type === 'list')) {
        await this.sendMessages(from, retryMessages);
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

    // ── Branch conditions: check override-based branching before default next() ──
    let nextStepId: string | null = null;
    if (override?.branchConditions && override.branchConditions.length > 0) {
      nextStepId = evaluateBranchConditions(override.branchConditions, session.session_data);
    }
    // Fall through to default next() if no branch matched
    if (!nextStepId) {
      nextStepId = await step.next(ctx);
    }

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
      .update({
        current_step: nextStepId,
        session_data: session.session_data,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq('id', session.id);

    // Try primary flow, then cross-flow lookup
    const activeCap = session.session_data.active_capability as CapabilityId | undefined;
    const primaryFlowType = activeCap
      ? this.capabilityToFlowType(activeCap)
      : (ctx.business?.flow_type || 'scheduling');
    const flow = getFlowDefinition(primaryFlowType as FlowType);
    let nextStep = flow?.steps.find(s => s.id === nextStepId) || null;

    if (!nextStep) {
      const crossResult = getFlowStepAcrossFlows(nextStepId);
      nextStep = crossResult?.step || null;
    }

    if (!nextStep) {
      await this.deactivateSession(session.id);
      return;
    }

    // ── Step overrides for the next step ──
    let nextOverride: StepOverride | undefined;
    if (ctx.business) {
      try {
        const overrides = await loadOverrides(this.supabase, ctx.business.id, primaryFlowType);
        nextOverride = overrides.get(nextStepId);
      } catch { /* non-fatal */ }
    }

    // Check skip (override or programmatic)
    const shouldSkipNext = nextOverride?.action === 'skip'
      || (nextOverride?.action !== 'require' && nextStep.skipIf && await nextStep.skipIf(ctx));

    if (shouldSkipNext) {
      const afterNext = await nextStep.next(ctx);
      if (afterNext) {
        await this.advanceToStep(session, afterNext, from, ctx);
      } else {
        await this.deactivateSession(session.id);
      }
      return;
    }

    // Show next step's prompt (possibly customized)
    if (nextOverride?.action === 'custom' && nextOverride.customPrompt) {
      await this.sendText(from, nextOverride.customPrompt);
    } else {
      const messages = await nextStep.prompt(ctx);
      await this.sendMessages(from, messages);
    }
  }

  private async sendMessages(to: string, messages: PromptMessage[]): Promise<void> {
    for (const msg of messages) {
      switch (msg.type) {
        case 'text':
          await this.sender.sendText({ to, text: msg.text });
          break;
        case 'list':
          await this.sender.sendList({ to, title: msg.title, body: msg.body, buttonLabel: msg.buttonLabel, items: msg.items });
          break;
        case 'buttons':
          await this.sender.sendButtons({ to, body: msg.body, buttons: msg.buttons });
          break;
        case 'image':
          await this.sender.sendImage({ to, imageUrl: msg.imageUrl, caption: msg.caption });
          break;
        case 'document':
          await this.sender.sendDocument({ to, documentUrl: msg.url, filename: msg.filename, caption: msg.caption });
          break;
      }
    }
  }

  private async sendText(to: string, text: string): Promise<void> {
    await this.sender.sendText({ to, text });
  }

  private async deactivateSession(sessionId: string): Promise<void> {
    await this.supabase
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('id', sessionId);
  }

  /** Map a capability to its corresponding FlowType */
  private capabilityToFlowType(cap: CapabilityId): FlowType {
    switch (cap) {
      case 'scheduling': return 'scheduling';
      case 'payment': return 'payment';
      case 'ordering': return 'ordering';
      case 'ticketing': return 'ticketing';
      case 'reservation': return 'reservation';
      case 'whatsapp_sign': return 'scheduling'; // no bot flow — dashboard only
      case 'crowdfunding': return 'payment'; // crowdfunding uses payment infrastructure
      case 'reports': return 'scheduling'; // reports don't have their own flow
      case 'queue': return 'scheduling'; // queue uses its own extended flow
      case 'feedback': return 'scheduling'; // feedback uses its own extended flow
      case 'loyalty': return 'scheduling'; // loyalty is post-completion, no dedicated flow
      case 'chat': return 'scheduling'; // chat is handled in bot.service
      case 'waitlist': return 'scheduling'; // waitlist uses its own extended flow
      case 'referral': return 'scheduling'; // referral is post-completion
      case 'staff': return 'scheduling'; // staff enhances scheduling
      default: return 'scheduling';
    }
  }
}
