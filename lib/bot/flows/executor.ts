import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import type { MessageSender } from '@/lib/channels/message-sender';
import { translateBotResponse } from '@/lib/bot/translate';
import type { StandaloneService } from '@/lib/bot/standalone.service';
import type { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import type { FlowContext, PromptMessage } from './types';
import type { FlowType, BusinessCategoryKey, CountryCode } from '@/lib/constants';
import { getFlowDefinition, getFlowStep, getFlowStepAcrossFlows, getExtendedFlowDefinition } from './registry';
import type { CapabilityId } from '@/lib/capabilities/types';
import { checkConversationLimit, trackOutboundMessage, getConversationLimitMessage } from '@/lib/bot/conversation-guard';
import { loadOverrides, evaluateBranchConditions, type StepOverride } from '@/lib/bot/step-overrides';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

export class FlowExecutor {
  private currentBusinessId: string | null = null;

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
      conversation_log?: Array<{ role: 'bot' | 'user'; content: string; timestamp: string }>;
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
      payment_gateway?: string | null;
    } | null,
    mediaUrl?: string,
    mediaType?: string,
  ): Promise<void> {
    // Determine which flow to use: active_capability takes priority
    const activeCap = session.session_data.active_capability as CapabilityId | undefined;
    const flowType = activeCap
      ? this.capabilityToFlowType(activeCap)
      : (business?.flow_type || 'scheduling');
    const stepId = session.current_step;

    // Store business ID for outbound tracking
    this.currentBusinessId = business?.id || session.business_id || null;

    // Update last_active_at so returning-customer routing picks the most recently used business
    await this.supabase
      .from('bot_sessions')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', session.id);

    // Check conversation limit before processing
    if (this.currentBusinessId) {
      const limit = await checkConversationLimit(this.supabase, this.currentBusinessId);
      if (!limit.allowed) {
        await this.sendText(from, getConversationLimitMessage());
        return;
      }
    }

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
      Sentry.captureMessage('Flow step not found', { level: 'warning', extra: { stepId, flowType, sessionId: session.id } });
      let errMsg = 'Something went wrong on our end. Send *Hi* to start over.';
      errMsg = await this.maybeTranslate(errMsg, session);
      if (!session.conversation_log) session.conversation_log = [];
      session.conversation_log.push({ role: 'bot', content: errMsg, timestamp: new Date().toISOString() });
      await this.persistConversationLog(session.id, session.conversation_log);
      await this.sendText(from, errMsg);
      await this.deactivateSession(session.id);
      return;
    }

    const lang = (session.session_data._lang as string) || '';
    const ctx: FlowContext = {
      supabase: this.supabase,
      sender: this.sender,
      standalone: this.standalone,
      intelligence: this.intelligence,
      from,
      session,
      business,
      mediaUrl,
      mediaType,
      t: (text: string) => translateBotResponse(text, lang),
    };

    // ── Step overrides: load business-level overrides ──
    let override: StepOverride | undefined;
    if (business) {
      try {
        const overrides = await loadOverrides(this.supabase, business.id, resolvedFlowType);
        override = overrides.get(stepId);
      } catch (err) { logger.warn('[EXECUTOR] loadOverrides failed:', err); }
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
      if (!session.conversation_log) session.conversation_log = [];
      if (override?.action === 'custom' && override.customPrompt) {
        this.trackStepHistory(session, stepId);
        session.conversation_log.push({ role: 'bot', content: override.customPrompt, timestamp: new Date().toISOString() });
        await this.persistConversationLog(session.id, session.conversation_log);
        await this.sendText(from, override.customPrompt);
      } else {
        const messages = await step.prompt(ctx);
        if (messages.length > 0) {
          this.trackStepHistory(session, stepId);
        }
        this.logPromptMessages(session, messages);
        // Persist session_data after prompt — flows may store state (e.g., item lists for validation)
        await this.supabase
          .from('bot_sessions')
          .update({ session_data: session.session_data, conversation_log: session.conversation_log })
          .eq('id', session.id);
        await this.sendMessages(from, messages, session);
      }
      return;
    }

    // Log user input to conversation_log (cap at 100 entries to prevent JSONB bloat)
    if (!session.conversation_log) session.conversation_log = [];
    session.conversation_log.push({ role: 'user', content: input, timestamp: new Date().toISOString() });
    if (session.conversation_log.length > 100) {
      session.conversation_log = session.conversation_log.slice(-100);
    }

    // ── Navigation: "back" command ──
    // Only intercept on non-free-text steps so users can literally type "back" as input
    const FREE_TEXT_STEPS = ['collect_name', 'collect_other_name', 'collect_email', 'special_requests', 'review_text', 'enter_amount', 'collect_address', 'queue_collect_name', 'select_business_suggestion', 'enter_referral_code', 'collect_pickup_address', 'collect_dropoff_address', 'collect_package_description', 'collect_venue', 'enter_promo_code', 'save_card_pin', 'verify_card_pin', 'chat_handoff', 'chat_start'];
    const BACK_WORDS = ['back', 'go back', 'previous', 'cancel'];
    const lowerInputTrimmed = input.toLowerCase().trim();
    if (BACK_WORDS.includes(lowerInputTrimmed) && !FREE_TEXT_STEPS.includes(stepId)) {
      const history = (session.session_data._step_history as string[]) || [];
      if (history.length >= 2) {
        // Pop current step, get previous
        history.pop();
        const prevStep = history[history.length - 1];
        session.session_data._step_history = history;
        session.current_step = prevStep;
        await this.supabase.from('bot_sessions').update({
          current_step: prevStep,
          session_data: session.session_data,
          conversation_log: session.conversation_log,
        }).eq('id', session.id);
        // Re-prompt the previous step
        const prevStepDef = getFlowStep(resolvedFlowType as FlowType, prevStep)
          || getFlowStepAcrossFlows(prevStep)?.step || null;
        if (prevStepDef) {
          const prevMessages = await prevStepDef.prompt(ctx);
          this.logPromptMessages(session, prevMessages);
          await this.persistConversationLog(session.id, session.conversation_log);
          await this.sendMessages(from, prevMessages, session);
        }
        return;
      } else {
        const noBackMsg = await this.maybeTranslate('You\'re at the beginning. Type *menu* to see the main menu.', session);
        session.conversation_log.push({ role: 'bot', content: noBackMsg, timestamp: new Date().toISOString() });
        await this.persistConversationLog(session.id, session.conversation_log);
        await this.sendText(from, noBackMsg);
        return;
      }
    }

    // Global escape hatch: cancel / start over at any step
    // Supports English + Pidgin + Yoruba + French + Hausa + Twi
    const lowerInput = input.toLowerCase().trim();
    const CANCEL_WORDS = ['stop', 'quit', 'exit', 'end', 'annuler', 'arreter', 'dake', 'dawó', 'gyae'];
    const RESTART_WORDS = ['start over', 'restart', 'reset', 'recommencer', 'tun bẹrẹ', 'start again'];
    if (CANCEL_WORDS.includes(lowerInput)) {
      // Clean up any pending bank transfers before killing session
      const transferRef = session.session_data?.bank_transfer_reference;
      if (transferRef) {
        await this.supabase
          .from('pending_transfers')
          .update({ status: 'cancelled' })
          .eq('reference_code', transferRef as string)
          .eq('status', 'pending');
      }
      const cancelMsg = await this.maybeTranslate('Cancelled. Send *Hi* to start over.', session);
      session.conversation_log.push({ role: 'bot', content: cancelMsg, timestamp: new Date().toISOString() });
      await this.persistConversationLog(session.id, session.conversation_log);
      await this.deactivateSession(session.id);
      await this.sendText(from, cancelMsg);
      return;
    }
    if (RESTART_WORDS.includes(lowerInput)) {
      // Clean up any pending bank transfers before killing session
      const transferRef = session.session_data?.bank_transfer_reference;
      if (transferRef) {
        await this.supabase
          .from('pending_transfers')
          .update({ status: 'cancelled' })
          .eq('reference_code', transferRef as string)
          .eq('status', 'pending');
      }
      const restartMsg = await this.maybeTranslate('No problem! Send *Hi* to start over.', session);
      session.conversation_log.push({ role: 'bot', content: restartMsg, timestamp: new Date().toISOString() });
      await this.persistConversationLog(session.id, session.conversation_log);
      await this.deactivateSession(session.id);
      await this.sendText(from, restartMsg);
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
          .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
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
        await this.persistConversationLog(session.id, session.conversation_log || []);
        return;
      }
    }

    // Check for media messages at text-only steps
    // If mediaType is set (image, audio, video, sticker, document) and the input is empty
    // or looks like a media URL, prompt user to reply with text instead
    // Steps with acceptsMedia=true can handle media directly (e.g. payment proof screenshots)
    const isMediaMessage = mediaType && ['image', 'audio', 'video', 'sticker', 'voice', 'document'].includes(mediaType);
    const isEmptyOrMediaOnly = !input.trim() || (isMediaMessage && !input.trim());
    if (isMediaMessage && isEmptyOrMediaOnly && !step.acceptsMedia) {
      const mediaHint = await this.maybeTranslate(
        'Please reply with text. Photos and voice notes aren\'t supported at this step.',
        session,
      );
      const cancelHint = await this.maybeTranslate('Type *back* to go back, *menu* to restart, or *exit* to leave.', session);
      const errText = `${mediaHint}\n\n_${cancelHint}_`;
      session.conversation_log.push({ role: 'bot', content: errText, timestamp: new Date().toISOString() });
      await this.sendText(from, errText);
      // Re-send interactive prompts so user gets fresh clickable options
      const retryMessages = await step.prompt(ctx);
      if (retryMessages.some(m => m.type === 'buttons' || m.type === 'list')) {
        this.logPromptMessages(session, retryMessages);
        await this.sendMessages(from, retryMessages);
      }
      await this.persistConversationLog(session.id, session.conversation_log);
      return;
    }

    // ── Mid-flow entity extraction: pre-fill future steps from rich text ──
    const INTENT_FILLABLE_STEPS = new Set([
      'select_date', 'select_time', 'select_service', 'select_staff',
      'select_party_size', 'select_quantity', 'select_location',
      'select_capability',
    ]);

    // Map of which field each step "owns" — don't inject into the current step's field
    const STEP_OWNS_FIELD: Record<string, string> = {
      'select_date': 'date',
      'select_time': 'time',
      'select_party_size': 'party_size',
      'select_quantity': 'party_size',
    };

    let pendingEntities: Record<string, unknown> = {};
    if (INTENT_FILLABLE_STEPS.has(stepId) && input.split(/\s+/).length >= 2) {
      const { extractEntitiesOnly } = await import('@/lib/bot/smart-intent');
      const entities = extractEntitiesOnly(input);
      const ownedField = STEP_OWNS_FIELD[stepId];
      const activeCap = session.session_data.active_capability as string | undefined;

      if (entities.date && !session.session_data.date && ownedField !== 'date') {
        pendingEntities.date = entities.date;
      }
      if (entities.specificTime && !session.session_data.time && ownedField !== 'time') {
        pendingEntities.time = entities.specificTime;
      }
      if (entities.timePreference && !session.session_data._time_preference) {
        pendingEntities._time_preference = entities.timePreference;
      }
      if (entities.quantity && !session.session_data.party_size && ownedField !== 'party_size') {
        // Only inject party_size for booking-related capabilities
        if (['scheduling', 'appointment', 'table_reservation', 'reservation'].includes(activeCap || '')) {
          pendingEntities.party_size = entities.quantity;
        }
      }
      if (entities.amount && !session.session_data.amount) {
        // Only inject amount for payment-related capabilities
        if (['payment', 'giving', 'invoice', 'crowdfunding'].includes(activeCap || '')) {
          pendingEntities.amount = entities.amount;
        }
      }
    }

    // Validate input
    const result = await step.validate(input, ctx);

    if (!result.valid) {
      if (result.errorMessage) {
        const translatedError = await this.maybeTranslate(result.errorMessage, session);
        const cancelHint = await this.maybeTranslate('Type *back* to go back, *menu* to restart, or *exit* to leave.', session);
        const errText = `${translatedError}\n\n_${cancelHint}_`;
        session.conversation_log.push({ role: 'bot', content: errText, timestamp: new Date().toISOString() });
        await this.sendText(from, errText);
      }
      // Re-send interactive prompts (buttons/list) so user gets fresh clickable options
      // WhatsApp buttons are single-use — once tapped, they gray out
      const retryMessages = await step.prompt(ctx);
      if (retryMessages.some(m => m.type === 'buttons' || m.type === 'list')) {
        this.logPromptMessages(session, retryMessages);
        await this.sendMessages(from, retryMessages);
      }
      await this.persistConversationLog(session.id, session.conversation_log);
      return;
    }

    // Merge data into session
    if (result.data) {
      Object.assign(session.session_data, result.data);
    }
    // After validate succeeds, merge pending entities into session_data
    if (Object.keys(pendingEntities).length > 0) {
      Object.assign(session.session_data, pendingEntities);
    }
    await this.supabase
      .from('bot_sessions')
      .update({ session_data: session.session_data, conversation_log: session.conversation_log })
      .eq('id', session.id);

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
      // Flow complete — persist log before deactivating
      await this.persistConversationLog(session.id, session.conversation_log || []);

      // Check if successful completion (not cancellation) — show "What's next?" menu
      const sd = session.session_data;
      const isCancellation = sd._action === 'cancel' || sd._action === 'cancelled'
        || sd.cancelled === true || sd._action === 'cart_empty';

      if (!isCancellation && session.business_id) {
        await this.showPostCompletionMenu(from, session, ctx);
      } else {
        await this.deactivateSession(session.id);
      }
    }
  }

  private async advanceToStep(
    session: { id: string; session_data: Record<string, unknown>; user_id: string | null; business_id: string | null; current_step: string; conversation_log?: Array<{ role: 'bot' | 'user'; content: string; timestamp: string }> },
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
        conversation_log: session.conversation_log || [],
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
      } catch (err) { logger.warn('[EXECUTOR] loadOverrides failed:', err); }
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
      if (!session.conversation_log) session.conversation_log = [];
      this.trackStepHistory(session, nextStepId);
      const translatedCustom = await this.maybeTranslate(nextOverride.customPrompt, session);
      session.conversation_log.push({ role: 'bot', content: translatedCustom, timestamp: new Date().toISOString() });
      await this.persistConversationLog(session.id, session.conversation_log);
      await this.sendText(from, translatedCustom);
    } else {
      const messages = await nextStep.prompt(ctx);
      if (messages.length > 0) {
        this.trackStepHistory(session, nextStepId);
      }
      this.logPromptMessages(session, messages);
      await this.persistConversationLog(session.id, session.conversation_log || []);
      await this.sendMessages(from, messages);
    }
  }

  /** Track which steps the user has actually seen (not auto-skipped) for "back" navigation */
  private trackStepHistory(
    session: { session_data: Record<string, unknown> },
    stepId: string,
  ): void {
    const history = (session.session_data._step_history as string[]) || [];
    if (history[history.length - 1] !== stepId) {
      history.push(stepId);
      // Keep last 10 steps max to prevent session bloat
      if (history.length > 10) history.shift();
      session.session_data._step_history = history;
    }
  }

  private async sendMessages(to: string, messages: PromptMessage[], session?: { session_data: Record<string, unknown> }): Promise<void> {
    if (messages.length === 0) return;

    // Inject navigation footer on interactive messages (buttons/list) if not already set
    // Footer: 40 chars — within WhatsApp's 60-char limit
    const NAV_FOOTER = 'Type: back, menu (restart), or exit (leave)';
    for (const msg of messages) {
      if ((msg.type === 'buttons' || msg.type === 'list') && !msg.footer) {
        msg.footer = NAV_FOOTER;
      }
    }

    // Translate all messages if session has a non-English language
    const lang = session?.session_data?._detected_language as string | undefined;
    const shouldTranslate = lang && lang !== 'en';

    for (let i = 0; i < messages.length; i++) {
      try {
        const msg = shouldTranslate ? await this.translateMessage(messages[i], lang!) : messages[i];
        await this.sendSingleMessage(to, msg);
        if (i < messages.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (err) {
        logger.error('[EXECUTOR] Failed to send message', i + 1, 'of', messages.length, 'to', to, ':', err);
      }
    }
    if (this.currentBusinessId) {
      trackOutboundMessage(this.supabase, this.currentBusinessId).catch(() => {});
    }
  }

  /** Translate a single prompt message — text, body, button labels, list items */
  private async translateMessage(msg: PromptMessage, lang: string): Promise<PromptMessage> {
    switch (msg.type) {
      case 'text':
        return { ...msg, text: await translateBotResponse(msg.text, lang) };
      case 'buttons':
        return {
          ...msg,
          body: await translateBotResponse(msg.body, lang),
          footer: msg.footer, // Don't translate — commands are English-only
          buttons: await Promise.all(msg.buttons.map(async b => ({
            ...b,
            title: await translateBotResponse(b.title, lang),
          }))),
        };
      case 'list':
        return {
          ...msg,
          body: await translateBotResponse(msg.body, lang),
          footer: msg.footer, // Don't translate — commands are English-only
          items: await Promise.all(msg.items.map(async item => ({
            ...item,
            description: item.description ? await translateBotResponse(item.description, lang) : item.description,
            // Keep title as-is for service/product names — business entered them
          }))),
        };
      case 'image':
        return {
          ...msg,
          caption: msg.caption ? await translateBotResponse(msg.caption, lang) : msg.caption,
        };
      default:
        return msg;
    }
  }

  private async sendSingleMessage(to: string, msg: PromptMessage): Promise<void> {
    switch (msg.type) {
      case 'text':
        await this.sender.sendText({ to, text: msg.text });
        break;
      case 'list':
        await this.sender.sendList({ to, title: msg.title, body: msg.body, buttonLabel: msg.buttonLabel, items: msg.items, sections: msg.sections, footer: msg.footer });
        break;
      case 'buttons':
        await this.sender.sendButtons({ to, body: msg.body, buttons: msg.buttons, footer: msg.footer });
        break;
      case 'image': {
        // WhatsApp doesn't support WebP — convert via our API proxy
        let imageUrl = msg.imageUrl;
        if (imageUrl.toLowerCase().endsWith('.webp')) {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
          imageUrl = `${appUrl}/api/images/convert?url=${encodeURIComponent(imageUrl)}`;
        }
        await this.sender.sendImage({ to, imageUrl, caption: msg.caption });
        break;
      }
      case 'document':
        await this.sender.sendDocument({ to, documentUrl: msg.url, filename: msg.filename, caption: msg.caption });
        break;
    }
  }

  private async sendText(to: string, text: string): Promise<void> {
    await this.sender.sendText({ to, text });
  }

  /** Translate text if session has a detected non-English language */
  private async maybeTranslate(
    text: string,
    session: { session_data: Record<string, unknown> },
  ): Promise<string> {
    const lang = session.session_data._detected_language as string | undefined;
    if (!lang || lang === 'en') return text;
    return translateBotResponse(text, lang);
  }

  /** Extract text from prompt messages and append to session's conversation_log */
  private logPromptMessages(
    session: { conversation_log?: Array<{ role: 'bot' | 'user'; content: string; timestamp: string }> },
    messages: PromptMessage[],
  ): void {
    if (!session.conversation_log) session.conversation_log = [];
    const ts = new Date().toISOString();
    for (const msg of messages) {
      let text = '';
      switch (msg.type) {
        case 'text': text = msg.text; break;
        case 'buttons': text = msg.body; break;
        case 'list': text = msg.body; break;
        case 'image': text = msg.caption || '[Image]'; break;
        case 'document': text = msg.caption || msg.filename || '[Document]'; break;
      }
      if (text) {
        session.conversation_log.push({ role: 'bot', content: text, timestamp: ts });
      }
    }
  }

  /** Persist conversation_log to the database */
  private async persistConversationLog(
    sessionId: string,
    log: Array<{ role: 'bot' | 'user'; content: string; timestamp: string }>,
  ): Promise<void> {
    await this.supabase
      .from('bot_sessions')
      .update({ conversation_log: log })
      .eq('id', sessionId);
  }

  private async deactivateSession(sessionId: string): Promise<void> {
    await this.supabase
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('id', sessionId);
  }

  /**
   * After a successful transaction, show contextual "What's next?" buttons
   * instead of silently ending the session.
   */
  private async showPostCompletionMenu(
    from: string,
    session: { id: string; session_data: Record<string, unknown>; business_id: string | null },
    ctx: FlowContext,
  ): Promise<void> {
    const cap = (session.session_data.active_capability as string) || '';
    const flowType = ctx.business?.flow_type || 'scheduling';
    const lang = (session.session_data._lang as string) || '';

    // Contextual buttons based on what the customer just did
    let buttons: Array<{ id: string; title: string }>;

    if (cap === 'giving' || cap === 'crowdfunding') {
      buttons = [
        { id: 'pc_again', title: 'Give Again' },
        { id: 'pc_history', title: 'My Giving' },
        { id: 'pc_options', title: 'View Options' },
      ];
    } else if (cap === 'ticketing') {
      buttons = [
        { id: 'pc_again', title: 'Buy More Tickets' },
        { id: 'pc_history', title: 'My Tickets' },
        { id: 'pc_options', title: 'View Options' },
      ];
    } else if (cap === 'ordering') {
      buttons = [
        { id: 'pc_again', title: 'Order Again' },
        { id: 'pc_history', title: 'My Orders' },
        { id: 'pc_options', title: 'View Options' },
      ];
    } else if (cap === 'reservation') {
      buttons = [
        { id: 'pc_again', title: 'Book Again' },
        { id: 'pc_history', title: 'My Bookings' },
        { id: 'pc_options', title: 'View Options' },
      ];
    } else {
      // scheduling, appointment, payment, default
      buttons = [
        { id: 'pc_again', title: 'Book Again' },
        { id: 'pc_history', title: 'My Bookings' },
        { id: 'pc_options', title: 'View Options' },
      ];
    }

    const body = lang
      ? await translateBotResponse('What would you like to do next?', lang)
      : 'What would you like to do next?';

    // Keep session alive on post_completion step so buttons work
    await this.supabase.from('bot_sessions').update({
      current_step: 'post_completion',
      session_data: { ...session.session_data, _post_completion_cap: cap },
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min timeout
    }).eq('id', session.id);

    await this.sender.sendButtons({ to: from, body, buttons });
  }

  /** Map a capability to its corresponding FlowType */
  private capabilityToFlowType(cap: CapabilityId): FlowType {
    switch (cap) {
      case 'scheduling': return 'scheduling';
      case 'payment': return 'payment';
      case 'ordering': return 'ordering';
      case 'appointment': return 'scheduling'; // appointments use scheduling infrastructure
      case 'ticketing': return 'ticketing';
      case 'reservation': return 'reservation';
      case 'whatsapp_sign': return 'scheduling'; // no bot flow — dashboard only
      case 'giving': return 'payment'; // giving uses payment infrastructure
      case 'crowdfunding': return 'payment'; // crowdfunding uses payment infrastructure
      case 'reports': return 'scheduling'; // reports don't have their own flow
      case 'queue': return 'queue';
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
