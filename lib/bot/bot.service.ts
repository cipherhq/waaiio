import { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { logger } from '@/lib/logger';
import { truncTitle } from './utils/truncate';
import { checkRateLimitAsync } from '@/lib/rate-limit';
import type { MessageSender } from '@/lib/channels/message-sender';
import { StandaloneService } from './standalone.service';
import { BotIntelligenceService } from './bot-intelligence';
import { FlowExecutor } from './flows/executor';
import { getLocale, formatCurrency, type BusinessCategoryKey, type FlowType, type CountryCode } from '@/lib/constants';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import { getCategoryLabels } from '@/lib/categoryConfig';
import type { CapabilityId } from '@/lib/capabilities/types';
import { parseSmartIntent, parseSmartIntentHybrid, matchServiceFromKeywords, buildAcknowledgment } from './smart-intent';
import { translateBotResponse, detectLanguage, getLanguageName, setTranslationContext } from './translate';
import { checkAIFeature, isLanguageAllowed } from './ai-tier-guard';
import { getCustomerHistory, buildReturnGreeting } from './customer-intelligence';
// fuzzy-match utils moved to handlers/bot-code-detection.ts
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { loadBotCustomConfig, matchQuickReply, loadUnifiedKeywords, matchUnifiedKeyword } from './keyword-service';
import type { UnifiedKeyword } from './keyword-service';
import { evaluateRules } from './automation/rules-engine';
import { isWithinBusinessHours, type BusinessHours } from './business-hours';
import type { BotSession, BusinessRecord, BotContext } from './bot-types';
import { getActiveSession as _getActiveSession, deactivateSession as _deactivateSession, sendBotText, forwardToBusinessOwner as _forwardToBusinessOwner } from './bot-helpers';
import { getFirstStep as _getFirstStep, getFirstStepFromCapabilities as _getFirstStepFromCapabilities, capabilityToFirstStep as _capabilityToFirstStep } from './handlers/flow-routing';
import { handleQuoteResponse as _handleQuoteResponse } from './handlers/quote-response';
import { handleTicketCheckin as _handleTicketCheckin } from './handlers/ticket-checkin';
import { handleTransactionDocument as _handleTransactionDocument } from './handlers/transaction-docs';
import { handleMyOrders as _handleMyOrders, handleOrderDetail as _handleOrderDetail, handleOrderDetailAction as _handleOrderDetailAction } from './handlers/my-orders';
import { routeToMyAccountMenu as _routeToMyAccountMenu } from './handlers/my-account-menu';
import { handleMyBookings as _handleMyBookings, handleViewTicket as _handleViewTicket, handleViewReservation as _handleViewReservation, handleModifyBooking as _handleModifyBooking } from './handlers/my-bookings';
import { detectBotCode as _detectBotCode, detectBotCodeWithSuggestions as _detectBotCodeWithSuggestions, rankSuggestions as _rankSuggestions, findReturningCustomerBusiness as _findReturningCustomerBusiness, findReturningCustomerBusinesses as _findReturningCustomerBusinesses } from './handlers/bot-code-detection';
import { executeKeywordAction as _executeKeywordAction } from './handlers/keyword-actions';
import { handleChatHandoff as _handleChatHandoff, handleChatStart as _handleChatStart } from './handlers/chat-handoff';
import { handleCardPinStep as _handleCardPinStep } from './handlers/saved-cards';

import { HOME_PATTERN, handleEscapeHatch as _handleEscapeHatch } from './handlers/escape-hatches';
import { handleGlobalQuery, isOrdersQuery } from './handlers/global-queries';

export class BotService {
  private readonly flowExecutor: FlowExecutor;
  private readonly ctx: BotContext;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly messageSender: MessageSender,
    private readonly standaloneService: StandaloneService,
    private readonly intelligence: BotIntelligenceService,
  ) {
    this.flowExecutor = new FlowExecutor(supabase, messageSender, standaloneService, intelligence);
    this.ctx = { supabase, messageSender, standaloneService, intelligence, flowExecutor: this.flowExecutor };
  }

  async handleMessage(
    from: string,
    messageText: string,
    messageType: string,
    destinationPhone?: string,
    preResolvedBusinessId?: string,
    mediaUrl?: string,
  ): Promise<void> {
    try {
    const text = messageText.trim();
    logger.debug('[BOT] handleMessage from:', from, 'text:', text, 'type:', messageType, 'dest:', destinationPhone);

    // Pre-check 0: Per-phone rate limit (prevents bot spam burning AI/WhatsApp credits)
    const phoneRateLimit = await checkRateLimitAsync(`bot:${from}`, 20, 60_000); // 20 messages per minute per phone
    if (!phoneRateLimit.allowed) {
      logger.warn(`[BOT] Rate limited phone ${from} — ${phoneRateLimit.remaining} remaining`);
      return; // Silently drop — don't even send a response (saves WhatsApp outbound cost)
    }

    // Pre-check 0b: Maintenance mode
    try {
      const { data: maint } = await this.supabase
        .from('platform_settings')
        .select('value')
        .eq('key', 'maintenance_mode')
        .single();
      if (maint?.value === true) {
        await this.sendText(from, "We're currently undergoing maintenance and will be back shortly. Please try again in a few minutes. 🙏");
        return;
      }
    } catch {} // fail open

    // Pre-check 1: Timeout
    const timeoutCheck = this.intelligence.isTimedOut(from);
    if (timeoutCheck.timedOut) {
      await this.sendText(from, `You can message again in ${timeoutCheck.remaining} minute${timeoutCheck.remaining !== 1 ? 's' : ''}. 🙏`);
      return;
    }

    // Pre-check 2b: Handle post-exit buttons (session was already deactivated)
    if (text === 'go_back_biz') {
      // Find the last business this user interacted with
      const { data: lastSession } = await this.supabase
        .from('bot_sessions')
        .select('business_id')
        .eq('whatsapp_number', from)
        .eq('is_active', false)
        .not('business_id', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastSession?.business_id) {
        return this.handleMessage(from, 'Hi', messageType, destinationPhone, lastSession.business_id);
      }
      // Fallback — no previous business found
      return this.handleMessage(from, 'Hi', messageType, destinationPhone);
    }

    if (text === 'switch_biz') {
      // Show business picker
      const recentBiz = await this.findReturningCustomerBusinesses(from, null, null);
      if (recentBiz.length > 1) {
        const quickPick = recentBiz.slice(0, 3);
        // Clean up old inactive sessions
        await this.supabase.from('bot_sessions').delete()
          .eq('whatsapp_number', from).eq('is_active', false).is('business_id', null);
        await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from,
          user_id: null,
          business_id: null,
          current_step: 'select_business_suggestion',
          session_data: { suggestions: quickPick },
          is_active: true,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        await this.messageSender.sendButtons({
          to: from,
          body: 'Which business would you like to visit?',
          buttons: quickPick.map((s, i) => ({ id: `biz_${i}`, title: truncTitle(s.name) })),
        });
      } else {
        await this.sendText(from, 'Type the name or code of the business you\'d like to visit.');
      }
      return;
    }

    // ── "home" command — return to Waaiio marketplace / business picker ──
    if (HOME_PATTERN.test(text.trim())) {
      const activeSession = await this.getActiveSession(from);
      if (activeSession) await this.deactivateSession(activeSession.id);
      // Show marketplace greeting by finding returning businesses
      const recentBiz = await this.findReturningCustomerBusinesses(from, null, null);
      if (recentBiz.length > 0) {
        const quickPick = recentBiz.slice(0, 3);
        await this.supabase.from('bot_sessions').delete()
          .eq('whatsapp_number', from).eq('is_active', false).is('business_id', null);
        await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from,
          user_id: null,
          business_id: null,
          current_step: 'select_business_suggestion',
          session_data: { suggestions: quickPick },
          is_active: true,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        await this.messageSender.sendButtons({
          to: from,
          body: 'Welcome to Waaiio! Which business would you like to visit?',
          buttons: quickPick.map((s, i) => ({ id: `biz_${i}`, title: truncTitle(s.name) })),
        });
      } else {
        await this.sendText(from, 'Welcome to Waaiio! Send a *business code* to get started, or visit waaiio.com/directory to find a business.');
      }
      return;
    }

    // Pre-check 2: Profanity (only block on repeated offenses)
    if (this.intelligence.containsProfanity(text)) {
      const abuse = this.intelligence.recordProfanity(from);
      if (abuse.timeout) {
        const existingSession = await this.getActiveSession(from);
        if (existingSession) await this.deactivateSession(existingSession.id);
        await this.sendText(from, abuse.message);
        return;
      }
      if (abuse.warn && abuse.message) {
        await this.sendText(from, abuse.message);
        return;
      }
      // First 1-2 offenses: let the message through (could be false positive on free-text input)
    }

    // Handle quote response button postbacks (accept_quote_{id} / reject_quote_{id})
    const quoteResponseMatch = text.match(/^(accept|reject)_quote_([0-9a-f-]{36})$/i);
    if (quoteResponseMatch) {
      const qAction = quoteResponseMatch[1].toLowerCase() as 'accept' | 'reject';
      const quoteId = quoteResponseMatch[2];
      const existingSession = await this.getActiveSession(from);
      if (existingSession) await this.deactivateSession(existingSession.id);
      await this.handleQuoteResponse(from, quoteId, qAction);
      return;
    }

    // Handle ticket check-in (TK-XXXXXX code sent via WhatsApp)
    const ticketMatch = text.match(/^TK-([A-Z0-9]{6})$/i);
    if (ticketMatch) {
      const ticketCode = `TK-${ticketMatch[1].toUpperCase()}`;
      await this.handleTicketCheckin(from, ticketCode);
      return;
    }

    // Handle RSVP button taps from invite messages
    const rsvpButtonMatch = text.match(/^rsvp_(yes|maybe|no)_([a-f0-9-]+)$/i);
    if (rsvpButtonMatch) {
      const rsvpChoice = rsvpButtonMatch[1] as 'yes' | 'maybe' | 'no';
      const rsvpStatus = rsvpChoice === 'yes' ? 'accepted' : rsvpChoice === 'maybe' ? 'maybe' : 'declined';
      const inviteId = rsvpButtonMatch[2];
      const defaultEmoji: Record<string, string> = { accepted: '✅', maybe: '🤔', declined: '❌' };
      const defaultLabel: Record<string, string> = { accepted: "You're coming!", maybe: "Noted as maybe!", declined: "Sorry you can't make it!" };

      await this.supabase
        .from('event_invites')
        .update({ status: rsvpStatus, responded_at: new Date().toISOString() })
        .eq('id', inviteId);

      // Check for custom response messages from the party
      let responseMsg = `${defaultEmoji[rsvpStatus]} ${defaultLabel[rsvpStatus]}`;
      try {
        const { data: inv } = await this.supabase
          .from('event_invites')
          .select('party_id')
          .eq('id', inviteId)
          .single();
        if (inv?.party_id) {
          const { data: party } = await this.supabase
            .from('parties')
            .select('rsvp_yes_message, rsvp_maybe_message, rsvp_no_message')
            .eq('id', inv.party_id)
            .single();
          const customMsg = rsvpChoice === 'yes' ? party?.rsvp_yes_message
            : rsvpChoice === 'maybe' ? party?.rsvp_maybe_message
            : party?.rsvp_no_message;
          if (customMsg) responseMsg = customMsg;
        }
      } catch { /* use default */ }

      await this.sendText(from, responseMsg);
      return;
    }

    // Handle RSVP keyword or token — check for pending invites
    const isRsvpKeyword = /^(rsvp|invite|yes\s*i'?m?\s*coming|i'?ll?\s*be\s*there)$/i.test(text);
    const rsvpTokenMatch = text.match(/^rsvp\s+([a-f0-9]{24})$/i);
    if (isRsvpKeyword || rsvpTokenMatch) {
      const phoneP2 = from.startsWith('+') ? from : `+${from}`;
      const phoneN2 = from.startsWith('+') ? from.slice(1) : from;

      // Try event-linked invites first, then party-linked invites
      let pendingInvite: Record<string, unknown> | null = null;
      let inviteSource: 'event' | 'party' = 'event';

      // Query for event-linked invites
      let eventInviteQuery = this.supabase
        .from('event_invites')
        .select('id, event_id, party_id, guest_name, invite_token, status, events!inner(id, name, date, time, venue, invite_message, allow_plus_ones, max_plus_ones, ask_dietary, business_id, businesses!inner(id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, country_code))')
        .or(`guest_phone.eq.${sanitizeFilterValue(phoneP2)},guest_phone.eq.${sanitizeFilterValue(phoneN2)}`)
        .not('event_id', 'is', null)
        .in('status', ['pending', 'maybe']);

      if (rsvpTokenMatch) {
        eventInviteQuery = eventInviteQuery.eq('invite_token', rsvpTokenMatch[1]);
      }

      const { data: eventInvite } = await eventInviteQuery
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (eventInvite) {
        pendingInvite = eventInvite as unknown as Record<string, unknown>;
        inviteSource = 'event';
      } else {
        // Try party-linked invites
        let partyInviteQuery = this.supabase
          .from('event_invites')
          .select('id, event_id, party_id, guest_name, invite_token, status, parties!inner(id, name, date, time, venue, invite_message, allow_plus_ones, max_plus_ones, ask_dietary, dress_code, business_id, businesses!inner(id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, country_code))')
          .or(`guest_phone.eq.${sanitizeFilterValue(phoneP2)},guest_phone.eq.${sanitizeFilterValue(phoneN2)}`)
          .not('party_id', 'is', null)
          .in('status', ['pending', 'maybe']);

        if (rsvpTokenMatch) {
          partyInviteQuery = partyInviteQuery.eq('invite_token', rsvpTokenMatch[1]);
        }

        const { data: partyInvite } = await partyInviteQuery
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (partyInvite) {
          pendingInvite = partyInvite as unknown as Record<string, unknown>;
          inviteSource = 'party';
        }
      }

      if (pendingInvite) {
        // Deactivate any existing session
        const existingSession2 = await this.getActiveSession(from);
        if (existingSession2) await this.deactivateSession(existingSession2.id);

        const sourceData = inviteSource === 'event' ? pendingInvite.events : pendingInvite.parties;
        const ev = (Array.isArray(sourceData) ? (sourceData as unknown[])[0] : sourceData) as unknown as Record<string, unknown>;
        const biz = (Array.isArray(ev.businesses) ? (ev.businesses as unknown[])[0] : ev.businesses) as Record<string, unknown>;

        // Build session data — use party_ prefix for party invites, event_ prefix for event invites
        const sessionData: Record<string, unknown> = {
          rsvp_invite_id: pendingInvite.id,
          rsvp_invite_message: ev.invite_message,
          rsvp_allow_plus_ones: ev.allow_plus_ones,
          rsvp_max_plus_ones: ev.max_plus_ones,
          rsvp_ask_dietary: ev.ask_dietary,
        };

        if (inviteSource === 'party') {
          sessionData.rsvp_party_id = pendingInvite.party_id;
          sessionData.rsvp_party_name = ev.name;
          sessionData.rsvp_party_date = ev.date;
          sessionData.rsvp_party_time = ev.time;
          sessionData.rsvp_party_venue = ev.venue;
          sessionData.rsvp_dress_code = ev.dress_code;
        } else {
          sessionData.rsvp_event_id = pendingInvite.event_id;
          sessionData.rsvp_event_name = ev.name;
          sessionData.rsvp_event_date = ev.date;
          sessionData.rsvp_event_time = ev.time;
          sessionData.rsvp_event_venue = ev.venue;
        }

        // Create a new session with the rsvp flow
        const { data: newSession } = await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from,
          user_id: null,
          business_id: biz.id as string,
          current_step: 'rsvp_welcome',
          session_data: sessionData,
          is_active: true,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }).select().single();

        if (newSession) {
          // Build the business context and execute the rsvp flow prompt
          await this.flowExecutor.execute(
            from,
            '', // empty input = send prompt
            {
              id: newSession.id,
              user_id: null,
              business_id: biz.id as string,
              current_step: 'rsvp_welcome',
              session_data: newSession.session_data as Record<string, unknown>,
            },
            {
              id: biz.id as string,
              name: biz.name as string,
              slug: biz.slug as string,
              category: biz.category as BusinessCategoryKey,
              flow_type: biz.flow_type as FlowType,
              subscription_tier: biz.subscription_tier as string,
              trial_ends_at: biz.trial_ends_at as string,
              metadata: (biz.metadata || {}) as Record<string, unknown>,
              country_code: biz.country_code as CountryCode | undefined,
            },
          );
          return;
        }
      }
    }

    // Handle waitlist notification responses (yes/no after "a spot has opened up")
    // ONLY check if user is NOT in an active mid-flow session — never hijack an active booking
    const isWaitlistReply = /^(yes|no|yep|nah|nope|yeah)$/i.test(text);
    if (isWaitlistReply) {
      const activeFlowSession = await this.getActiveSession(from);
      const isInActiveFlow = activeFlowSession?.business_id && activeFlowSession.is_active
        && activeFlowSession.current_step !== 'select_capability' && activeFlowSession.current_step !== 'greeting';
      if (isInActiveFlow) {
        // User is mid-flow — don't hijack. Let the message reach the flow executor.
      } else {
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;
      const { data: notifiedEntry } = await this.supabase
        .from('waitlist_entries')
        .select('id, business_id, customer_name, service_id')
        .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .eq('status', 'notified')
        .order('notified_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (notifiedEntry) {
        const accepted = /^(yes|yep|yeah)$/i.test(text);
        if (accepted) {
          // Confirm waitlist entry, fetch business name, and find any active session — all in parallel
          const [, { data: biz }, existingSession] = await Promise.all([
            this.supabase
              .from('waitlist_entries')
              .update({ status: 'confirmed' })
              .eq('id', notifiedEntry.id),
            this.supabase
              .from('businesses')
              .select('name')
              .eq('id', notifiedEntry.business_id)
              .single(),
            this.getActiveSession(from),
          ]);

          await this.sendText(from, `Great! Let's get you booked at *${biz?.name || 'the business'}*.`);

          // Deactivate any existing session and start a new booking flow
          if (existingSession) await this.deactivateSession(existingSession.id);
          return this.handleMessage(from, 'Hi', messageType, destinationPhone, notifiedEntry.business_id);
        } else {
          // Declined — mark as expired so next person can be notified
          await this.supabase
            .from('waitlist_entries')
            .update({ status: 'expired' })
            .eq('id', notifiedEntry.id);

          await this.sendText(from, "No problem! We've released the spot. Send *Hi* if you'd like to do anything else.");
          return;
        }
      }
      } // end isInActiveFlow else
    }

    // ── Early profile lookup (cached for reuse across all query paths) ──
    const phoneP = from.startsWith('+') ? from : `+${from}`;
    const phoneN = from.startsWith('+') ? from.slice(1) : from;
    let _cachedProfile: { id: string } | null | undefined = undefined; // undefined = not fetched yet
    const getProfile = async () => {
      if (_cachedProfile !== undefined) return _cachedProfile;
      const { data } = await this.supabase.from('profiles').select('id').or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`).limit(1).maybeSingle();
      _cachedProfile = data;
      return _cachedProfile;
    };

    let session = await this.getActiveSession(from);

    // ── Global "my X" query handlers (location, orders, bookings, receipts, etc.) ──
    const globalResult = await handleGlobalQuery({
      supabase: this.supabase,
      messageSender: this.messageSender,
      flowExecutor: this.flowExecutor,
      sendText: this.sendText.bind(this),
      from,
      session,
      text,
      messageType,
      destinationPhone,
      getProfile,
      handleMessage: this.handleMessage.bind(this),
    });
    if (globalResult.handled) {
      return;
    }
    // Update session in case handleGlobalQuery modified it (e.g. reference code fall-through)
    session = globalResult.session;

    // Check for "switch <keyword>" command — lets users swap between businesses
    const switchMatch = text.match(/^switch\s+(.+)$/i);
    if (switchMatch) {
      const keyword = switchMatch[1].trim().toLowerCase();
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }

      // Use the full fuzzy matching engine (same as bot code detection)
      const detection = await this.detectBotCodeWithSuggestions(keyword, from);

      if (detection.businessId) {
        // Exact/confident match — route directly
        const { data: biz } = await this.supabase
          .from('businesses')
          .select('id, bot_code')
          .eq('id', detection.businessId)
          .single();
        if (biz) {
          await this.handleMessage(from, biz.bot_code || 'Hi', messageType, destinationPhone, biz.id);
          return;
        }
      }

      if (detection.suggestions && detection.suggestions.length > 0) {
        // Show suggestions as buttons
        if (detection.suggestions.length <= 3) {
          await this.messageSender.sendButtons({
            to: from,
            body: `Which business did you mean?`,
            buttons: detection.suggestions.map((s, i) => ({
              id: `biz_${i}`,
              title: truncTitle(s.name),
            })),
          });
        } else {
          const list = detection.suggestions.map((s, i) => `${i + 1}. *${s.name}*`).join('\n');
          await this.sendText(from, `Which business did you mean?\n\n${list}\n\nReply with the number to select.`);
        }

        // Create suggestion session so the reply gets handled
        await this.supabase.from('bot_sessions').delete()
          .eq('whatsapp_number', from).eq('is_active', false).is('business_id', null);
        await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from,
          user_id: null,
          business_id: null,
          current_step: 'select_business_suggestion',
          session_data: { suggestions: detection.suggestions },
          is_active: true,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        return;
      }

      await this.sendText(from, `No business found matching "${keyword}". Try: switch restaurant, switch spa, switch church, switch shop, etc.`);
      return;
    }

    // Check for restart keywords (skip on free-text steps)
    const currentStep = session?.current_step || '';
    const isChatStep = currentStep === 'chat_handoff' || currentStep === 'chat_start';
    const isFreeTextStep = isChatStep || ['collect_name', 'collect_other_name', 'collect_email', 'special_requests', 'review_text', 'enter_amount', 'collect_address', 'select_business_suggestion', 'enter_referral_code', 'collect_pickup_address', 'collect_dropoff_address', 'collect_package_description', 'collect_venue', 'enter_promo_code'].includes(currentStep);

    // Detect greetings and booking intent for restart detection (without detectIntent)
    const normalizedForRestart = text.toLowerCase().trim();
    const isGreetingText = /^(hello|hi|hey|yo|howdy|hiya|sup|how\s*far|howfar|wetin\s*dey|e\s*kaaro|e\s*kaasan|sannu|kedu|ndewo|maakye)$/i.test(normalizedForRestart)
      || /^good\s+(morning|afternoon|evening)$/i.test(normalizedForRestart);
    const isBookingText = /\b(book|reserve|table|reservation|appointment|order|buy|ticket|pay|donate)\b/i.test(normalizedForRestart);

    // Also treat bot codes as restarts so users can switch businesses mid-session
    let isBotCodeRestart = false;
    if (!isFreeTextStep && session && /^[a-z0-9-]{2,30}$/i.test(text.trim())) {
      const potentialCode = text.trim().toLowerCase();
      const { data: codeMatch } = await this.supabase
        .from('businesses')
        .select('id')
        .ilike('bot_code', potentialCode)
        .eq('status', 'active')
        .maybeSingle();
      if (codeMatch) isBotCodeRestart = true;
    }

    // Don't treat booking intent as a restart when user is already mid-flow
    // (e.g. typing "Haircut" at select_service step — they're already booking)
    // Also don't restart from select_capability when the text has rich booking intent
    // (e.g. "book appointment for friday at 2pm" should fast-track, not restart)
    const isAtCapabilitySelect = !!session?.business_id && currentStep === 'select_capability';
    const hasRichBookingIntent = isBookingText && /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*(am|pm)|morning|afternoon|evening|next\s+week)\b/i.test(normalizedForRestart);
    const hasRichPaymentIntent = /\b(pay\s*tithe|pay\s*offering|give\s*tithe|give\s*offering|donate|sadaqah|zakat|sow\s*seed)\b/i.test(normalizedForRestart)
      || (/\b(pay|tithe|offering|donate|give|sow)\b/i.test(normalizedForRestart) && /\d{3,}/.test(normalizedForRestart));
    const hasRichOrderIntent = /\b(order|buy)\b/i.test(normalizedForRestart) && /\b(\d+\s+\w|reorder|same\s+again|\w+\s+\w+)\b/i.test(normalizedForRestart)
      || /\b(reorder|same\s+again)\b/i.test(normalizedForRestart)
      || (/\b(order|buy)\b/i.test(normalizedForRestart) && normalizedForRestart.split(/\s+/).length >= 2 && !isOrdersQuery(text));
    const hasRichIntent = hasRichBookingIntent || hasRichPaymentIntent || hasRichOrderIntent;
    const isMidFlow = !!session?.business_id && !!currentStep && currentStep !== 'greeting' && currentStep !== 'select_capability'
      || (isAtCapabilitySelect && hasRichIntent);
    // Bare action words ("pay", "order", "book") should NOT restart — they should route to capability selection
    const isBareActionWord = /^(pay|order|buy|book|ticket|donate|give|reserve)$/i.test(text);
    const isRestart = !isFreeTextStep && (
      /^(start|restart)$/i.test(text) ||
      isGreetingText ||
      (!isMidFlow && isBookingText && !isBareActionWord) ||
      isBotCodeRestart
    )
    // Allow greetings to trigger restart even at free-text steps (not chat) — prevents "Hi" being saved as a name
    || (isFreeTextStep && !isChatStep && isGreetingText);

    // Mid-flow greeting: ask for confirmation before resetting
    if (session && isMidFlow && isRestart && isGreetingText && !isBotCodeRestart) {
      // Check if user already confirmed restart
      if (session.session_data._restart_pending) {
        // They confirmed — fall through to restart logic below
      } else {
        // First time — ask for confirmation
        await this.supabase.from('bot_sessions')
          .update({ session_data: { ...session.session_data, _restart_pending: true } })
          .eq('id', session.id);
        await this.messageSender.sendButtons({
          to: from,
          body: 'You have an active session. Do you want to start over?',
          buttons: [
            { id: 'restart_yes', title: 'Yes, start over' },
            { id: 'restart_no', title: 'No, continue' },
          ],
        });
        return;
      }
    }

    // Handle restart confirmation response
    if (session && session.session_data._restart_pending) {
      if (text === 'restart_no') {
        delete session.session_data._restart_pending;
        await this.supabase.from('bot_sessions')
          .update({ session_data: session.session_data })
          .eq('id', session.id);
        // Re-show the current step prompt with business context
        let biz = null;
        if (session.business_id) {
          const { data } = await this.supabase.from('businesses')
            .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, country_code, is_whitelabel, payment_gateway')
            .eq('id', session.business_id).single();
          biz = data;
        }
        await this.flowExecutor.execute(from, '', session as unknown as BotSession, biz, mediaUrl, messageType);
        return;
      }
      if (text === 'restart_yes') {
        // Confirmed restart — deactivate current session and restart fresh
        delete session.session_data._restart_pending;
        await this.supabase.from('bot_sessions')
          .update({ is_active: false })
          .eq('id', session.id);
        // Restart with the same business context
        const restartBizId = session.business_id || null;
        if (restartBizId) {
          const { data: restartBiz } = await this.supabase
            .from('businesses')
            .select('bot_code')
            .eq('id', restartBizId)
            .single();
          await this.handleMessage(from, restartBiz?.bot_code || 'Hi', messageType, destinationPhone, restartBizId);
        } else {
          await this.handleMessage(from, 'Hi', messageType, destinationPhone);
        }
        return;
      } else {
        // Unrecognized response to restart prompt — clear flag, continue current flow
        delete session.session_data._restart_pending;
        await this.supabase.from('bot_sessions')
          .update({ session_data: session.session_data })
          .eq('id', session.id);
        // Re-execute current step with the user's input
        let biz = null;
        if (session.business_id) {
          const { data } = await this.supabase.from('businesses')
            .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, country_code, is_whitelabel, payment_gateway')
            .eq('id', session.business_id).single();
          biz = data;
        }
        await this.flowExecutor.execute(from, text, session as unknown as BotSession, biz, mediaUrl, messageType);
        return;
      }
    }

    if (!session || isRestart) {
      logger.debug('[BOT] New/restart session. hasSession:', !!session, 'isRestart:', isRestart);
      // Remember the business from the session being restarted — prevents country
      // filter from dropping it (e.g. NG business accessed via US shared number)
      const restartBusinessId = isRestart && session?.business_id ? session.business_id : null;
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }

      // Determine standalone business
      let businessId: string | null = preResolvedBusinessId || restartBusinessId || null;
      logger.debug('[BOT] preResolvedBusinessId:', preResolvedBusinessId);

      // Determine the country of the shared number being messaged (for country scoping)
      let sharedNumberCountry: string | null = null;
      let inboundChannelId: string | null = null;
      if (!businessId && destinationPhone) {
        // Check if this is a dedicated number for a specific business
        const { data: biz } = await this.supabase
          .from('businesses')
          .select('id')
          .eq('whatsapp_phone_number_id', destinationPhone)
          .single();
        businessId = biz?.id || null;
        logger.debug('[BOT] destPhone lookup:', destinationPhone, '→', businessId);

        // If not a dedicated business number, check if it's a shared channel
        if (!businessId) {
          const { data: channel } = await this.supabase
            .from('whatsapp_channels')
            .select('id, country_code, channel_type')
            .eq('phone_number_id', destinationPhone)
            .eq('channel_type', 'shared')
            .eq('is_active', true)
            .maybeSingle();
          if (channel) {
            sharedNumberCountry = channel.country_code;
            inboundChannelId = channel.id;
            logger.debug('[BOT] Shared number country:', sharedNumberCountry, 'channel:', inboundChannelId);
          }
        } else {
          // Dedicated number — find the channel ID
          const { data: dedChannel } = await this.supabase
            .from('whatsapp_channels')
            .select('id')
            .eq('phone_number_id', destinationPhone)
            .eq('is_active', true)
            .maybeSingle();
          if (dedChannel) inboundChannelId = dedChannel.id;
        }
      }

      // Bot code routing + profile lookup in parallel (independent queries)
      let pendingSuggestions: { id: string; name: string; bot_code: string }[] | undefined;
      let isCategoryMatch = false;
      const detectionPromise = !businessId
        ? this.detectBotCodeWithSuggestions(text, from, sharedNumberCountry)
        : Promise.resolve(null);
      const profilePromise = getProfile();

      const [detection, profile] = await Promise.all([detectionPromise, profilePromise]);

      if (detection) {
        businessId = detection.businessId;
        pendingSuggestions = detection.suggestions;
        isCategoryMatch = detection.isCategory || false;
        logger.debug('[BOT] detectBotCode("' + text + '") →', businessId, 'suggestions:', pendingSuggestions?.length || 0, 'category:', isCategoryMatch);
      }

      // Returning customer: check past history if no business resolved yet
      // Scope to the shared number's country to prevent cross-country routing
      if (!businessId) {
        businessId = await this.findReturningCustomerBusiness(from, profile?.id || null, sharedNumberCountry);
        if (businessId) logger.debug('[BOT] returning customer → business:', businessId);
      }

      // "Did you mean?" — fuzzy suggestions / category matches / auto-correct confirmation
      if (!businessId && pendingSuggestions && pendingSuggestions.length > 0) {
        // Clean up old sessions
        await this.supabase.from('bot_sessions').delete()
          .eq('whatsapp_number', from).eq('is_active', false).is('business_id', null);

        // Create a session at the select_business_suggestion step
        const { data: sugSession } = await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from,
          user_id: profile?.id || null,
          business_id: null,
          current_step: 'select_business_suggestion',
          session_data: { suggestions: pendingSuggestions, isCategory: isCategoryMatch },
          is_active: true,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min expiry
        }).select().single();

        if (sugSession) {
          // Choose wording based on match type
          const headerText = isCategoryMatch
            ? `Here are some businesses that might help:`
            : pendingSuggestions.length === 1
              ? `Did you mean *${pendingSuggestions[0].name}*?`
              : `Did you mean one of these businesses?`;

          if (pendingSuggestions.length === 1 && !isCategoryMatch) {
            // Single fuzzy match — confirmation buttons (Yes/No)
            await this.messageSender.sendButtons({
              to: from,
              body: headerText,
              buttons: [
                { id: 'biz_0', title: 'Yes' },
                { id: 'biz_no', title: 'No' },
              ],
            });
          } else if (pendingSuggestions.length <= 3) {
            // Use buttons (WhatsApp supports up to 3)
            await this.messageSender.sendButtons({
              to: from,
              body: headerText,
              buttons: pendingSuggestions.map((s, i) => ({
                id: `biz_${i}`,
                title: truncTitle(s.name),
              })),
            });
          } else {
            // Fallback to numbered list as text
            const list = pendingSuggestions.map((s, i) => `${i + 1}. *${s.name}*`).join('\n');
            await this.sendText(from, `${headerText}\n\n${list}\n\nReply with the number to select.`);
          }
          return;
        }
      }

      // Load business info
      let business: BusinessRecord | null = null;
      if (businessId) {
        const { data: biz } = await this.supabase
          .from('businesses')
          .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway, is_whitelabel, status')
          .eq('id', businessId)
          .single();
        // Reject suspended/deactivated businesses
        if (biz && (biz as Record<string, unknown>).status !== 'active') {
          await this.sendText(from, 'This business is currently unavailable. Please try again later.');
          return;
        }
        // Check if phone is blocked by admin (table-based + legacy metadata fallback)
        if (biz) {
          const bizId = (biz as Record<string, unknown>).id as string;
          const safeFrom = sanitizeFilterValue(from);
          const { count: blockedCount } = await this.supabase
            .from('blocked_phones')
            .select('id', { count: 'exact', head: true })
            .eq('business_id', bizId)
            .or(`phone.eq.${safeFrom},phone.eq.+${safeFrom}`);
          if ((blockedCount || 0) > 0) {
            return; // Silently drop — blocked users get no response
          }
          // Legacy fallback: check metadata.blocked_phones for businesses not yet migrated
          const meta = ((biz as Record<string, unknown>).metadata || {}) as Record<string, unknown>;
          const legacyBlocked = Array.isArray(meta.blocked_phones) ? meta.blocked_phones as string[] : [];
          if (legacyBlocked.includes(from) || legacyBlocked.includes('+' + from)) {
            return; // Silently drop — blocked users get no response
          }
        }
        business = biz as BusinessRecord | null;
      }

      // Load capabilities + WhatsApp config + tier limits in parallel (all only need businessId)
      let capabilities: CapabilityId[] = [];
      let waConfig: import('./standalone.service').WhatsAppConfigBundle | null = null;
      let tierInfo: import('./standalone.service').TierCheckResult | null = null;
      if (business) {
        const [caps, config, tier] = await Promise.all([
          getEnabledCapabilities(this.supabase, business.id, business.category),
          this.standaloneService.loadWhatsAppConfigBundle(business.id),
          this.standaloneService.checkTierLimitsFromBusiness(business.id, business.subscription_tier, business.is_whitelabel),
        ]);
        capabilities = caps;
        waConfig = config;
        tierInfo = tier;
      }

      // Outside business hours: send a note but DON'T block the bot
      // Customers must be able to book, order, and browse 24/7
      if (business && waConfig?.auto_reply_enabled && waConfig.business_hours) {
        const isOpen = isWithinBusinessHours(
          waConfig.business_hours as BusinessHours,
          (waConfig.business_hours as BusinessHours).timezone,
        );
        if (!isOpen && !session) {
          // Only send away message once (no active session = first message)
          // Then continue the flow — don't return
          await this.sendText(
            from,
            waConfig.away_message || 'We\'re currently outside business hours, but you can still browse, book, and order! 🕐',
          );
        }
      }

      const firstStep = business
        ? this.getFirstStepFromCapabilities(capabilities, business.flow_type)
        : 'greeting';

      const sessionData: Record<string, unknown> = businessId && business
        ? { business_id: businessId, business_name: business.name, business_category: business.category, capabilities, ...(inboundChannelId ? { _inbound_channel_id: inboundChannelId } : {}) }
        : { ...(inboundChannelId ? { _inbound_channel_id: inboundChannelId } : {}) };

      // Remove old inactive sessions for this phone+business to avoid unique constraint violation
      const cleanupQuery = this.supabase.from('bot_sessions')
        .delete()
        .eq('whatsapp_number', from)
        .eq('is_active', false);
      if (businessId) {
        await cleanupQuery.eq('business_id', businessId);
      } else {
        await cleanupQuery.is('business_id', null);
      }

      const { data: newSession, error: sessionError } = await this.supabase
        .from('bot_sessions')
        .insert({
          whatsapp_number: from,
          user_id: profile?.id || null,
          business_id: businessId,
          current_step: firstStep,
          session_data: sessionData,
          is_active: true,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        })
        .select()
        .single();

      if (sessionError || !newSession) {
        logger.error('[BOT] Session insert failed:', sessionError?.message, sessionError?.code, sessionError?.details);
        await this.sendText(from, 'Sorry, something went wrong. Please try again.');
        return;
      }

      // Auto-detect language from first message — tier-gated (Growth+ only)
      const bizTier = business?.subscription_tier || 'free';
      if (text.length >= 3 && isLanguageAllowed(bizTier, 'non-en')) {
        try {
          const lang = await detectLanguage(text);
          if (lang !== 'en') {
            // Store as pending — don't activate until user confirms
            await this.supabase.from('bot_sessions')
              .update({ session_data: { ...sessionData, _pending_language: lang } })
              .eq('id', newSession.id);
            logger.debug('[BOT] Detected language:', lang, 'for', from, '— asking confirmation');

            const langName = getLanguageName(lang);
            try {
              await this.messageSender.sendButtons({
                to: from,
                body: `I noticed you might prefer ${langName}. Would you like me to respond in ${langName}?`,
                buttons: [
                  { id: 'lang_yes', title: `Yes, ${langName}` },
                  { id: 'lang_no', title: 'English is fine' },
                ],
              });
            } catch (err) {
              logger.error('[BOT] Language confirm send error:', err);
            }
          }
        } catch { /* language detection failed — continue in English */ }
      }

      session = newSession as BotSession;

      if (business && waConfig && tierInfo) {
        // Standalone bot greeting — use pre-fetched config (no extra queries)
        let greeting: string;
        const isCustomGreeting = waConfig.templates.greeting !== 'Welcome! How can I help you today?';
        if (isCustomGreeting) {
          // Custom greeting set by business owner — always use it
          greeting = this.standaloneService.fillTemplate(waConfig.templates.greeting, {
            restaurant_name: business.name,
            business_name: business.name,
          });
        } else if (waConfig.alias) {
          const catLabels = getCategoryLabels(business.category);
          greeting = this.intelligence.getPersonaGreeting(waConfig.alias, business.name, catLabels.confirmationEmoji);
        } else {
          greeting = this.standaloneService.fillTemplate(waConfig.templates.greeting, {
            restaurant_name: business.name,
            business_name: business.name,
          });
        }

        if (!tierInfo.isWhitelabel) greeting += '\n\n_Powered by Waaiio_';
        greeting += '\n\n_Type *cancel* anytime to exit._';

        // Store greeting in session for capability selection to merge into one message
        session.session_data._greeting = greeting;

        if (!tierInfo.allowed) {
          await this.messageSender.sendButtons({
            to: from,
            body: `Thank you for contacting ${business.name}! We're currently unavailable on WhatsApp. Please try again later.`,
            buttons: [
              { id: 'cap_chat', title: 'Chat with Us' },
            ],
          });
          await this.deactivateSession(session.id);
          return;
        }

        // Greeting is merged into the capability selection message (stored in _greeting)
        // Only send as separate text if capability selection is skipped (single-capability businesses)

        // ── Returning customer: personalized greeting + repeat suggestion ──
        try {
          // Fetch customer history and profile name in parallel — both are independent of each other
          const profileNamePromise = profile?.id
            ? this.supabase.from('profiles').select('first_name').eq('id', profile.id).maybeSingle()
            : Promise.resolve({ data: null });
          const [custHistory, { data: fullProfile }] = await Promise.all([
            getCustomerHistory(this.supabase, from, business.id),
            profileNamePromise,
          ]);

          if (custHistory.isReturning) {
            session.session_data._customer_history = {
              totalVisits: custHistory.totalVisits,
              lastServiceId: custHistory.lastServiceId,
              lastServiceName: custHistory.lastServiceName,
              lastFlowType: custHistory.lastFlowType,
              favoriteServiceId: custHistory.favoriteServiceId,
              favoriteServiceName: custHistory.favoriteServiceName,
            };

            // Use pre-fetched profile name for personalized greeting
            const customerName = (fullProfile as { first_name?: string } | null)?.first_name || null;

            // Quick rebook: if we know their last/favorite service, show a contextual "again" button
            const rebookServiceName = custHistory.lastServiceName || custHistory.favoriteServiceName;
            const rebookServiceId = custHistory.lastServiceId || custHistory.favoriteServiceId;

            if (rebookServiceName && rebookServiceId) {
              const rebookMsg = customerName
                ? `Welcome back, ${customerName}! 👋`
                : 'Welcome back! 👋';

              // Determine giving vs booking by checking service_type on the actual service
              // This is more reliable than lastFlowType which can be wrong for giving categories
              const catLabels = getCategoryLabels(business.category);
              const GIVING_CATS = ['church', 'mosque', 'school', 'ngo', 'crowdfunding_org'];
              let isGivingRebook = false;
              const { data: svcCheck } = await this.supabase
                .from('services')
                .select('service_type')
                .eq('id', rebookServiceId)
                .single();
              if (svcCheck?.service_type === 'giving') {
                isGivingRebook = true;
              }
              // No fallback — only explicit service_type='giving' triggers giving rebook
              // Churches can have both giving AND scheduling services
              const actionWord = isGivingRebook ? 'Give' : catLabels.actionVerb || 'Book';
              const promptText = isGivingRebook
                ? `${rebookMsg}\n\nGive again?\n🙏 ${rebookServiceName}`
                : `${rebookMsg}\n\n${actionWord} your usual?\n📋 ${rebookServiceName}`;
              // WhatsApp button max 20 chars — use short label if name is long
              const maxNameLen = 20 - actionWord.length - 1; // "Give " = 5 chars
              const buttonLabel = rebookServiceName.length <= maxNameLen
                ? `${actionWord} ${rebookServiceName}`
                : isGivingRebook ? 'Give Again' : `${actionWord} Again`;

              const lang = session.session_data._detected_language as string | undefined;
              const translatedBody = lang ? await translateBotResponse(promptText, lang) : promptText;

              await this.messageSender.sendButtons({
                to: from,
                body: translatedBody,
                buttons: [
                  { id: 'quick_rebook', title: truncTitle(buttonLabel) },
                  { id: 'browse_menu', title: 'View Options' },
                ],
              });

              // Store rebook data in session for handling the button tap
              session.session_data._quick_rebook_service_id = rebookServiceId;
              session.session_data._quick_rebook_service_name = rebookServiceName;
              session.session_data._rebook_flow_type = custHistory.lastFlowType;
              session.session_data._rebook_is_giving = isGivingRebook;
              session.session_data._quick_rebook_sent = true;
              await this.supabase.from('bot_sessions').update({ session_data: session.session_data }).eq('id', session.id);
              // Stop here — don't show the full greeting/menu on top of the rebook prompt
              return;
            } else {
              // No rebookable service — send text greeting as before
              const returnMsg = buildReturnGreeting(
                customerName,
                custHistory,
                business.name,
              );
              if (returnMsg) {
                const lang = session.session_data._detected_language as string | undefined;
                await this.sendText(from, lang ? await translateBotResponse(returnMsg, lang) : returnMsg);
              }
            }
          }
        } catch (err) {
          logger.error('[BOT] Customer history lookup error (non-fatal):', err);
        }

        // ── Welcome Buttons: send interactive menu after greeting ──
        // Show welcome buttons when business goes directly to a flow (no capability selection)
        try {
          const nonUF = new Set(['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'whatsapp_sign', 'survey', 'poll', 'broadcast', 'recurring', 'auto_reply', 'membership']);
          if (capabilities.includes('scheduling')) { nonUF.add('payment'); nonUF.add('invoice'); }
          const ufCount = capabilities.filter(c => !nonUF.has(c)).length;
          if (waConfig.welcome_buttons.length > 0 && ufCount <= 1) {
            const buttons = waConfig.welcome_buttons.slice(0, 3).map((btn, i) => ({
              id: `wb_${i}`,
              title: truncTitle(btn.label),
            }));
            await this.messageSender.sendButtons({
              to: from,
              body: 'How can I help you today?',
              buttons,
            });
          }
        } catch (err) {
          logger.error('[BOT] Welcome buttons error (non-fatal):', err);
        }

        // ── Smart Intent: parse first message for entities ──
        // If user said something rich like "I wan barb tomorrow morning",
        // extract service, date, time, quantity and pre-fill session data
        // so the flow can skip already-answered steps.
        if (text && text.length > 2 && !isRestart) {
          try {
            const parsed = await parseSmartIntentHybrid(text, business?.category || null, this.supabase, business?.id || null);

            // Store detected language as pending — confirmation already sent during session creation
            if ('language' in parsed && parsed.language && parsed.language !== 'en' && !session.session_data._detected_language) {
              session.session_data._pending_language = parsed.language;
            }

            if (parsed.understood && business) {
              // Match service keywords against business services
              if (parsed.serviceKeywords.length > 0) {
                const matched = await matchServiceFromKeywords(this.supabase, business.id, parsed.serviceKeywords);
                if (matched) {
                  session.session_data.service_id = matched.id;
                  session.session_data.service_name = matched.name;
                  session.session_data.service_price = matched.price;
                  session.session_data.service_duration = matched.duration_minutes;
                  session.session_data.service_deposit = matched.deposit_amount || 0;
                  session.session_data.service_billing_type = matched.billing_type || 'one_time';
                  session.session_data.service_recurring_interval = matched.recurring_interval || null;
                  session.session_data.skip_service = true;
                }
              }

              // Pre-fill date
              if (parsed.date) {
                // Validate: must be future, max 90 days
                const selected = new Date(parsed.date + 'T00:00');
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate());
                tomorrow.setHours(0, 0, 0, 0);
                const maxDate = new Date();
                maxDate.setDate(maxDate.getDate() + 90);
                if (selected >= tomorrow && selected <= maxDate) {
                  session.session_data.date = parsed.date;
                }
              }

              // Pre-fill time
              if (parsed.specificTime) {
                session.session_data.time = parsed.specificTime;
              }
              if (parsed.timePreference) {
                session.session_data._time_preference = parsed.timePreference;
              }

              // Pre-fill quantity
              if (parsed.quantity && parsed.quantity >= 1 && parsed.quantity <= 20) {
                session.session_data.party_size = parsed.quantity;
              }

              // If no service matched but customer has a favorite, suggest it
              if (!session.session_data.service_id) {
                const hist = session.session_data._customer_history as { favoriteServiceId?: string; favoriteServiceName?: string } | undefined;
                if (hist?.favoriteServiceId) {
                  const { data: favService } = await this.supabase
                    .from('services')
                    .select('id, name, price, duration_minutes, deposit_amount, billing_type, recurring_interval')
                    .eq('id', hist.favoriteServiceId)
                    .eq('is_active', true)
                    .maybeSingle();
                  if (favService) {
                    session.session_data._suggested_service_id = favService.id;
                    session.session_data._suggested_service_name = favService.name;
                  }
                }
              }

              // Persist pre-filled data
              await this.supabase.from('bot_sessions').update({
                session_data: session.session_data,
              }).eq('id', session.id);

              // Send smart acknowledgment
              const locale = getLocale((business.country_code || 'NG') as CountryCode);
              const ack = buildAcknowledgment(
                parsed,
                session.session_data.service_name as string | null,
                locale,
              );
              if (ack) {
                const lang = session.session_data._detected_language as string | undefined;
                const translatedAck = lang ? await translateBotResponse(ack, lang) : ack;
                await this.sendText(from, translatedAck);
              }
            }
          } catch (err) {
            logger.error('[BOT] Smart intent parse error (non-fatal):', err);
          }
        }

        // Delegate to flow executor for the first step prompt
        await this.flowExecutor.execute(from, '', session as unknown as BotSession, business);
        return;
      }

      // Marketplace greeting — no business found from bot code or past history
      // Check if this is a returning user with past businesses for quick-pick
      const recentBusinesses = await this.findReturningCustomerBusinesses(from, profile?.id || null, sharedNumberCountry);

      // ── Returning user with past businesses — quick-pick ──
      if (recentBusinesses.length >= 1) {
        const { data: returningProfile } = profile ? await this.supabase
          .from('profiles').select('first_name').eq('id', profile.id).single()
          : { data: null };

        const name = (returningProfile as { first_name?: string } | null)?.first_name;
        await this.sendText(from, name ? `Welcome back, ${name}! 👋` : 'Welcome back! 👋');

        // Clean up old sessions
        await this.supabase.from('bot_sessions').delete()
          .eq('whatsapp_number', from).eq('is_active', false).is('business_id', null);

        const quickPick = recentBusinesses.slice(0, 3);
        await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from,
          user_id: profile?.id || null,
          business_id: null,
          current_step: 'select_business_suggestion',
          session_data: { suggestions: quickPick },
          is_active: true,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });

        await this.messageSender.sendButtons({
          to: from,
          body: 'Which business would you like to visit?\n\n_Tip: type *switch <name>* anytime to change business._',
          buttons: quickPick.map((s, i) => ({
            id: `biz_${i}`,
            title: truncTitle(s.name),
          })),
        });
        return;
      }

      // ── Business registration via WhatsApp Flow ──
      const onboardingKeywords = /\b(register|sign\s*up|onboard|create\s*(my\s*)?business|start\s*(my\s*)?business|set\s*up)\b/i;
      if (onboardingKeywords.test(text)) {
        const flowId = process.env.WHATSAPP_ONBOARDING_FLOW_ID;
        if (flowId && this.messageSender.sendFlow) {
          await this.messageSender.sendFlow({
            to: from,
            bodyText: 'Set up your business on Waaiio in 2 minutes! Tap below to get started.',
            flowId,
            flowCta: 'Get Started',
            screen: 'WELCOME',
            flowToken: `onboarding:${from}`,
          });
        } else {
          // Fallback: direct to web registration
          await this.sendText(from, [
            '*Register your business on Waaiio!*',
            '',
            'Set up your business in under 2 minutes:',
            '👉 *https://www.waaiio.com/get-started*',
            '',
            'Once registered, you can manage bookings, payments, and customers — all from WhatsApp.',
          ].join('\n'));
        }
        return;
      }

      // ── First-time user — onboarding message ──
      const isGreeting = /^(hi|hello|hey|yo|start|help)$/i.test(text.trim());
      if (isGreeting) {
        await this.sendText(from, [
          '*Welcome to Waaiio!* 👋',
          '',
          'I help you book appointments, buy tickets, place orders, and make payments — all through WhatsApp.',
          '',
          '*How to get started:*',
          '1️⃣ Send a *business code* (from their website, card, or socials)',
          '2️⃣ Or browse businesses at *waaiio.com/directory*',
          '',
          '*Useful commands:*',
          '• *switch <name>* — visit a different business',
          '• *my account* — view bookings, orders & receipts',
          '• *my bookings* — check upcoming appointments',
          '• *receipt* — get your last receipt',
        ].join('\n'));
      } else {
        await this.sendText(from, [
          `I couldn't find a business matching "${text.trim().slice(0, 30)}". 🤔`,
          '',
          'Try sending the exact *business code*, or type *switch* followed by a business name.',
          '',
          'Browse businesses at *waaiio.com/directory*',
          '',
          '_Example: switch FacesByKoph_',
          '',
          'Type *Hi* for help getting started.',
        ].join('\n'));
      }
      return;
    }

    // Check session expiry — clean up and let user start fresh with context
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      // Personalize the expired message with business name if available
      let expiredMsg = 'Your session has expired.';
      if (session.business_id) {
        const { data: biz } = await this.supabase.from('businesses').select('name').eq('id', session.business_id).single();
        if (biz?.name) expiredMsg = `Your session with *${biz.name}* has expired.`;
      }
      await this.sendText(from, `${expiredMsg} Send *Hi* to start over. 🙏`);
      return;
    }

    // ── Language confirmation handler ──
    const pendingLang = session.session_data._pending_language as string | undefined;
    if (pendingLang && (text === 'lang_yes' || text === 'lang_no')) {
      const updatedData = { ...session.session_data };
      delete updatedData._pending_language;

      if (text === 'lang_yes') {
        updatedData._detected_language = pendingLang;
        const langName = getLanguageName(pendingLang);
        await this.supabase.from('bot_sessions')
          .update({ session_data: updatedData })
          .eq('id', session.id);
        const confirmMsg = await translateBotResponse(`Great! I'll respond in ${langName} from now on.`, pendingLang);
        await this.sendText(from, confirmMsg);
      } else {
        await this.supabase.from('bot_sessions')
          .update({ session_data: updatedData })
          .eq('id', session.id);
        await this.sendText(from, 'No problem! I\'ll keep responding in English.');
      }
      return;
    }

    // ── Help command (works in any session) ──
    if (/^help$/i.test(text.trim())) {
      const bizName = session.business_id
        ? (await this.supabase.from('businesses').select('name').eq('id', session.business_id).single()).data?.name
        : null;

      const helpLines = [
        '*How can I help?* 💡',
        '',
        bizName ? `You're currently with *${bizName}*.` : '',
        '',
        '*Commands you can use:*',
        '• *Hi* — start over',
        '• *my account* — bookings, orders & receipts',
        '• *my bookings* — upcoming appointments',
        '• *receipt* — get your last receipt',
        '• *switch <name>* — visit another business',
        '• *cancel* — cancel current action',
        '',
        '_Need human help? Type *chat* to reach the business owner._',
      ].filter(Boolean);

      await this.sendText(from, helpLines.join('\n'));
      return;
    }

    // ── Escape hatches (hardcoded, never overridable) ──
    const step = session.current_step;

    // Handle "Switch Business" button — deactivate and show business picker
    if (text === 'switch_biz') {
      await this.deactivateSession(session.id);
      // Force business picker by clearing business association and showing suggestions
      const recentBiz = await this.findReturningCustomerBusinesses(from, null, null);
      if (recentBiz.length > 1) {
        const quickPick = recentBiz.slice(0, 3);
        await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from,
          user_id: null,
          business_id: null,
          current_step: 'select_business_suggestion',
          session_data: { suggestions: quickPick },
          is_active: true,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        await this.messageSender.sendButtons({
          to: from,
          body: 'Which business would you like to visit?',
          buttons: quickPick.map((s, i) => ({ id: `biz_${i}`, title: truncTitle(s.name) })),
        });
      } else {
        await this.sendText(from, 'Type the name or code of the business you\'d like to visit.');
      }
      return;
    }

    // Handle "Back to Business" button — restart the current business
    if (text === 'go_back_biz') {
      // Fall through — the session was deactivated, so the bot will create a new one for the same business
    }

    // Handle upgrade button tap from post-onboarding upsell
    if (text === 'upgrade_now') {
      await this.sendText(from, 'Upgrade your plan here 👇\nhttps://www.waaiio.com/dashboard/settings?tab=account');
      return;
    }

    // Handle quick rebook button tap — pre-fill service and jump to date picker
    if (text === 'quick_rebook' && session.session_data._quick_rebook_service_id) {
      const rebookServiceId = session.session_data._quick_rebook_service_id as string;
      session.session_data.service_id = rebookServiceId;
      session.session_data.service_name = session.session_data._quick_rebook_service_name;
      session.session_data.skip_service = true;
      // Determine capability from the pre-resolved flag (set when greeting was shown)
      const isGivingRebook = session.session_data._rebook_is_giving === true;
      session.session_data.active_capability = isGivingRebook ? 'giving' : 'scheduling';

      // Fetch service details to pre-fill duration, price, etc.
      const { data: svc } = await this.supabase
        .from('services')
        .select('price, duration_minutes, deposit_amount, billing_type, recurring_interval, max_capacity, buffer_minutes, available_days, available_from, available_to, requires_staff, staff_ids, allow_staff_selection, metadata, is_class, class_schedule, auto_approve, service_type')
        .eq('id', rebookServiceId)
        .eq('is_active', true)
        .maybeSingle();
      if (svc) {
        session.session_data.service_price = svc.price;
        session.session_data.service_duration = svc.duration_minutes;
        session.session_data.service_deposit = svc.deposit_amount || 0;
        session.session_data.service_billing_type = svc.billing_type || 'one_time';
        session.session_data.service_recurring_interval = svc.recurring_interval || null;
        session.session_data._service_max_capacity = svc.max_capacity || 1;
        session.session_data._service_buffer_minutes = svc.buffer_minutes || 0;
        session.session_data._service_available_days = svc.available_days || [];
        session.session_data._service_available_from = svc.available_from || null;
        session.session_data._service_available_to = svc.available_to || null;
        session.session_data._service_requires_staff = svc.requires_staff || false;
        session.session_data._service_staff_ids = svc.staff_ids || [];
        session.session_data._service_allow_staff_selection = svc.allow_staff_selection || false;
        session.session_data._service_metadata = svc.metadata || null;
        session.session_data._service_is_class = svc.is_class || false;
        session.session_data._service_class_schedule = svc.class_schedule || [];
        session.session_data._auto_approve = svc.auto_approve ?? true;
      }

      // Clean up rebook data
      delete session.session_data._quick_rebook_service_id;
      delete session.session_data._quick_rebook_service_name;
      delete session.session_data._rebook_flow_type;
      delete session.session_data._rebook_is_giving;
      delete session.session_data._quick_rebook_sent;

      // Set the correct first step for the capability (skip capability selection)
      const firstStep = isGivingRebook ? 'enter_amount' : 'select_date';
      session.current_step = firstStep;

      // Initialize step history so "back"/"cancel" works correctly
      session.session_data._step_history = ['select_capability', firstStep];

      await this.supabase.from('bot_sessions').update({
        session_data: session.session_data,
        current_step: firstStep,
      }).eq('id', session.id);

      const business = session.business_id
        ? (await this.supabase.from('businesses').select('*').eq('id', session.business_id).single()).data
        : null;
      if (business) {
        await this.flowExecutor.execute(from, '', session as unknown as BotSession, business);
      }
      return;
    }

    // Handle "Something Else" button — clean up rebook data and continue to normal flow
    if (text === 'browse_menu') {
      delete session.session_data._quick_rebook_service_id;
      delete session.session_data._quick_rebook_service_name;
      delete session.session_data._rebook_flow_type;
      delete session.session_data._rebook_is_giving;
      delete session.session_data._quick_rebook_sent;
      // Store greeting so the capability menu includes it
      if (session.session_data._greeting) {
        // Greeting already stored — will be used by capability selection
      }
      session.current_step = 'select_capability';
      await this.supabase.from('bot_sessions').update({
        session_data: session.session_data,
        current_step: 'select_capability',
      }).eq('id', session.id);
      // Execute the flow to show the capability menu
      const bizForMenu = session.business_id
        ? (await this.supabase.from('businesses').select('*').eq('id', session.business_id).single()).data
        : null;
      if (bizForMenu) {
        await this.flowExecutor.execute(from, '', session as unknown as BotSession, bizForMenu);
      }
      return;
    }

    const isChatMode = step === 'chat_handoff' || step === 'chat_start';

    // ── Escape hatches: back/cancel, menu/restart, exit/quit/stop ──
    const escapeResult = await _handleEscapeHatch(
      this.ctx,
      from,
      session,
      text,
      messageType,
      destinationPhone,
      step,
      this.sendText.bind(this),
      this.deactivateSession.bind(this),
      this.handleMessage.bind(this),
    );
    if (escapeResult.handled) return;

    // ── Unified keyword matching (replaces detectIntent + old keyword + quick reply checks) ──
    // Only fire on non-free-text steps
    const isFreeTextStepForKeywords = isChatMode || ['collect_name', 'collect_other_name', 'collect_email', 'special_requests', 'review_text', 'enter_amount', 'collect_address', 'queue_collect_name', 'select_business_suggestion', 'enter_referral_code', 'collect_pickup_address', 'collect_dropoff_address', 'collect_package_description', 'collect_venue', 'enter_promo_code', 'save_card_pin', 'verify_card_pin'].includes(step);

    if (!isFreeTextStepForKeywords) {
      // Use cached category from session_data (saved during session creation)
      const businessCategory = (session.session_data?.business_category as string) || null;

      const keywords = await loadUnifiedKeywords(this.supabase, session.business_id, businessCategory);
      const kwMatch = matchUnifiedKeyword(text, keywords);

      if (kwMatch) {
        const handled = await this.executeKeywordAction(from, session, kwMatch);
        if (handled) return;
      }
    }

    // Handle save card PIN creation
    if (step === 'save_card_pin' || step === 'verify_card_pin') {
      await _handleCardPinStep(this.supabase, this.sendText.bind(this), from, session, text);
      return;
    }

    // Handle "Did you mean?" business selection
    if (step === 'select_business_suggestion') {
      const suggestions = (session.session_data.suggestions || []) as { id: string; name: string; bot_code: string }[];
      let selectedBiz: { id: string; name: string; bot_code: string } | null = null;

      // Handle navigation commands at suggestion step (no business_id, so escape hatch guard skips these)
      if (/^(menu|back|exit|home|cancel|quit|stop|restart|start\s*over|hi|hello|hey)$/i.test(text)) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
        await this.handleMessage(from, 'Hi', messageType, destinationPhone);
        return;
      }

      // Check for "No" / rejection
      const isNo = /^(biz_no|no|nah|nope|wrong|not)$/i.test(text);
      if (isNo) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
        await this.sendText(from, 'No problem! Send a *business code* to connect to a business.\n\nOr type *switch* followed by a name, e.g.:\n_switch Bukka Hut_');
        return;
      }

      // Check for "Yes" (for single-match confirmation)
      const isYes = /^(yes|yeah|yep|yea|sure|correct|ok|okay|biz_0)$/i.test(text);
      if (isYes && suggestions.length > 0) {
        selectedBiz = suggestions[0];
      }

      if (!selectedBiz) {
        // Match button reply (biz_0, biz_1, biz_2)
        const btnMatch = text.match(/^biz_(\d+)$/i);
        if (btnMatch) {
          const idx = parseInt(btnMatch[1], 10);
          selectedBiz = suggestions[idx] || null;
        }
      }

      if (!selectedBiz) {
        // Match number reply (1, 2, 3)
        const numMatch = text.match(/^(\d+)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1], 10) - 1;
          selectedBiz = suggestions[idx] || null;
        }
      }

      if (!selectedBiz) {
        // Try matching by name (partial, case-insensitive)
        const lower = text.toLowerCase();
        selectedBiz = suggestions.find(s => s.name.toLowerCase().includes(lower)) || null;
      }

      if (selectedBiz) {
        // Deactivate the suggestion session, re-process as if they sent the bot code
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
        return this.handleMessage(from, selectedBiz.bot_code, messageType, destinationPhone);
      } else {
        await this.sendText(from, 'Please select one of the options above, or send a *business code* to connect.');
        return;
      }
    }

    // Handle post-completion menu (after successful transaction)
    if (step === 'post_completion') {
      if (text === 'pc_options' || text === 'pc_done') {
        // View Options — restart at capability menu for same business
        await this.deactivateSession(session.id);
        if (session.business_id) {
          await this.handleMessage(from, 'Hi', messageType, destinationPhone, session.business_id);
        }
        return;
      }
      if (text === 'pc_again') {
        // Start over at the same business
        await this.deactivateSession(session.id);
        if (session.business_id) {
          const { data: biz } = await this.supabase
            .from('businesses').select('bot_code').eq('id', session.business_id).single();
          await this.handleMessage(from, biz?.bot_code || 'Hi', messageType, destinationPhone, session.business_id);
        }
        return;
      }
      if (text === 'pc_history') {
        // Route to the appropriate history view based on capability
        const cap = session.session_data._post_completion_cap as string || '';
        if (cap === 'ordering') {
          session.current_step = 'my_orders';
          await this.supabase.from('bot_sessions').update({ current_step: 'my_orders' }).eq('id', session.id);
          await this.handleMyOrders(session, from, '');
        } else {
          session.current_step = 'my_bookings';
          await this.supabase.from('bot_sessions').update({ current_step: 'my_bookings' }).eq('id', session.id);
          await this.handleMyBookings(session, from, '');
        }
        return;
      }
      // Any other text — treat as starting over (they typed something new)
      await this.deactivateSession(session.id);
      await this.handleMessage(from, text, messageType, destinationPhone);
      return;
    }

    // Handle built-in steps (my_bookings, modify_booking, my_orders, order_detail)
    if (step === 'my_bookings') {
      await this.handleMyBookings(session, from, text);
      return;
    }
    if (step === 'modify_booking') {
      await this.handleModifyBooking(session, from, text);
      return;
    }
    if (step === 'my_orders') {
      await this.handleMyOrders(session, from, text);
      return;
    }
    if (step === 'order_detail') {
      await this.handleOrderDetailAction(session, from, text);
      return;
    }

    // ── Welcome button postback handling ──
    const wbMatch = text.match(/^wb_(\d)$/i);
    if (wbMatch && session.business_id) {
      try {
        const customConfig = await loadBotCustomConfig(this.supabase, session.business_id);
        const idx = parseInt(wbMatch[1], 10);
        const btn = customConfig.welcome_buttons[idx];
        if (btn) {
          if (btn.action === 'quick_reply' && btn.payload) {
            const qrMatch = matchQuickReply(btn.payload, customConfig.quick_replies);
            if (qrMatch) {
              await this.sendText(from, qrMatch.response);
              return;
            }
          }
          if (btn.action === 'url' && btn.payload) {
            await this.sendText(from, btn.payload);
            return;
          }
          if (btn.action === 'start_flow') {
            // Re-execute current step with empty input to show the prompt
            const { data: biz } = await this.supabase
              .from('businesses')
              .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway, is_whitelabel')
              .eq('id', session.business_id)
              .single();
            await this.flowExecutor.execute(from, '', session as unknown as BotSession, biz as BusinessRecord | null);
            return;
          }
        }
      } catch (err) {
        logger.error('[BOT] Welcome button handler error (non-fatal):', err);
      }
    }

    // ── Default reply fallback (unified keywords already matched above) ──
    if (session.business_id && (step === 'select_capability' || step === 'greeting')) {
      try {
        const customConfig = await loadBotCustomConfig(this.supabase, session.business_id);
        if (customConfig.default_reply) {
          await this.sendText(from, customConfig.default_reply);
          return;
        }
      } catch (err) {
        logger.error('[BOT] Default reply error (non-fatal):', err);
      }
    }

    // Delegate to flow executor for all flow steps
    let business: BusinessRecord | null = null;
    if (session.business_id) {
      const { data: biz } = await this.supabase
        .from('businesses')
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
        .eq('id', session.business_id)
        .single();
      business = biz as BusinessRecord | null;
    }

    // ── Fire message_received rule (non-blocking) ──
    if (session.business_id) {
      const sendMsg = async (to: string, txt: string) => {
        await this.messageSender.sendText({ to, text: txt });
      };
      evaluateRules(this.supabase, session.business_id, 'message_received', {
        customer_phone: from,
        message_text: text,
        current_step: step,
        business_name: business?.name || '',
      }, sendMsg).catch(err => logger.error('[BOT] message_received rule error:', err));
    }

    // Chat handoff: bot is paused, route messages to human agent (delegated to handlers/chat-handoff.ts)
    if (session.business_id && step === 'chat_handoff') {
      return _handleChatHandoff(
        this.supabase, this.messageSender, this.sendText.bind(this), from,
        session as { id: string; business_id: string; session_data: Record<string, unknown> },
        text, messageType, mediaUrl, this.deactivateSession.bind(this),
        (f, t, mt, _dp, bid) => this.handleMessage(f, t, mt, destinationPhone, bid),
        this.forwardToBusinessOwner.bind(this),
      );
    }

    // Chat fallback: if message doesn't match any flow step and chat is enabled (delegated to handlers/chat-handoff.ts)
    if (session.business_id && step === 'chat_start') {
      return _handleChatStart(
        this.supabase, this.messageSender, this.sendText.bind(this), from,
        session as { id: string; business_id: string; session_data: Record<string, unknown> },
        text, messageType, mediaUrl, this.deactivateSession.bind(this),
        (f, t, mt, _dp, bid) => this.handleMessage(f, t, mt, destinationPhone, bid),
        this.forwardToBusinessOwner.bind(this),
      );
    }

    // Set translation context for AI usage tracking
    setTranslationContext(session.business_id || null, this.supabase);

    await this.flowExecutor.execute(from, text, session as unknown as BotSession, business, mediaUrl, messageType);
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack?.slice(0, 300)}` : String(err);
      logger.error('[BOT] handleMessage CRASH:', errMsg);
      Sentry.captureException(err);
      try { await this.sendText(from, 'Sorry, something went wrong. Please try again.'); } catch (_) { /* ignore */ }
    }
  }

  // ── Bot code detection (delegated to handlers/bot-code-detection.ts) ──

  private async detectBotCode(text: string): Promise<string | null> {
    return _detectBotCode(this.supabase, text);
  }

  private async detectBotCodeWithSuggestions(text: string, callerPhone?: string, countryFilter?: string | null): Promise<{
    businessId: string | null;
    suggestions?: { id: string; name: string; bot_code: string }[];
    isCategory?: boolean;
  }> {
    return _detectBotCodeWithSuggestions(this.supabase, text, callerPhone, countryFilter);
  }

  private rankSuggestions(
    businesses: { id: string; name: string; bot_code: string; country_code?: string | null; total_bookings?: number; rating_avg?: number; score?: number }[],
    callerPhone?: string,
  ): { id: string; name: string; bot_code: string }[] {
    return _rankSuggestions(businesses, callerPhone);
  }

  private async findReturningCustomerBusiness(phone: string, userId: string | null, countryFilter?: string | null): Promise<string | null> {
    return _findReturningCustomerBusiness(this.supabase, phone, userId, countryFilter);
  }

  private async findReturningCustomerBusinesses(phone: string, userId: string | null, countryFilter?: string | null): Promise<{ id: string; name: string; bot_code: string }[]> {
    return _findReturningCustomerBusinesses(this.supabase, phone, userId, countryFilter);
  }

  private getFirstStep(flowType: FlowType): string {
    return _getFirstStep(flowType);
  }

  private getFirstStepFromCapabilities(capabilities: CapabilityId[], flowType: FlowType): string {
    return _getFirstStepFromCapabilities(capabilities, flowType);
  }

  private capabilityToFirstStep(cap: CapabilityId): string {
    return _capabilityToFirstStep(cap);
  }

  // ── My Bookings (delegated to handlers/my-bookings.ts) ──

  private async handleMyBookings(session: BotSession, from: string, input: string): Promise<void> {
    return _handleMyBookings(this.supabase, this.messageSender, this.sendText.bind(this), this.flowExecutor, session, from, input);
  }

  private async handleViewTicket(session: BotSession, from: string, ticketId: string): Promise<void> {
    return _handleViewTicket(this.supabase, this.messageSender, this.sendText.bind(this), session, from, ticketId);
  }

  private async handleViewReservation(session: BotSession, from: string, reservationId: string): Promise<void> {
    return _handleViewReservation(this.supabase, this.messageSender, this.sendText.bind(this), session, from, reservationId);
  }

  private async handleModifyBooking(session: BotSession, from: string, input: string): Promise<void> {
    return _handleModifyBooking(this.supabase, this.messageSender, this.sendText.bind(this), this.flowExecutor, session, from, input);
  }

  // ── My Orders (delegated to handlers/my-orders.ts) ──

  private async handleMyOrders(session: BotSession, from: string, input: string): Promise<void> {
    return _handleMyOrders(this.supabase, this.messageSender, this.sendText.bind(this), this.routeToMyAccountMenu.bind(this), session, from, input);
  }

  private async handleOrderDetail(session: BotSession, from: string, orderId: string): Promise<void> {
    return _handleOrderDetail(this.supabase, this.messageSender, this.sendText.bind(this), session, from, orderId);
  }

  private async handleOrderDetailAction(session: BotSession, from: string, input: string): Promise<void> {
    return _handleOrderDetailAction(this.supabase, this.messageSender, this.sendText.bind(this), this.routeToMyAccountMenu.bind(this), session, from, input);
  }

  // ── Route to My Account Menu (delegated to handlers/my-account-menu.ts) ──

  private async routeToMyAccountMenu(session: BotSession, from: string): Promise<void> {
    return _routeToMyAccountMenu(this.supabase, this.flowExecutor, session, from);
  }

  // ── Transaction Document Handler ──────────────────────────

  private async handleTransactionDocument(from: string, userId: string, type: 'history' | 'receipt' | 'annual'): Promise<void> {
    return _handleTransactionDocument(this.supabase, this.messageSender, this.sendText.bind(this), from, userId, type);
  }

  // ── Quote Response Handler ──────────────────────────────

  private async handleQuoteResponse(from: string, quoteId: string, action: 'accept' | 'reject'): Promise<void> {
    return _handleQuoteResponse(this.sendText.bind(this), from, quoteId, action);
  }

  // ── Ticket Check-in via WhatsApp ──────────────────────

  private async handleTicketCheckin(from: string, ticketCode: string): Promise<void> {
    return _handleTicketCheckin(this.supabase, this.sendText.bind(this), from, ticketCode);
  }

  // ── Unified Keyword Action Executor (delegated to handlers/keyword-actions.ts) ──

  private async executeKeywordAction(
    from: string,
    session: BotSession,
    kw: UnifiedKeyword,
  ): Promise<boolean> {
    return _executeKeywordAction(this.ctx, from, session, kw, this.handleMessage.bind(this));
  }

  // ── Helpers ──────────────────────────────────────────────

  private async getActiveSession(phone: string): Promise<BotSession | null> {
    return _getActiveSession(this.supabase, phone);
  }

  private async deactivateSession(sessionId: string): Promise<void> {
    return _deactivateSession(this.supabase, sessionId);
  }

  private async sendText(to: string, text: string): Promise<void> {
    return sendBotText(this.messageSender, to, text);
  }

  /** Send text with auto-translation based on session language */
  private async sendLocalizedText(to: string, text: string, session: { session_data: Record<string, unknown> } | null): Promise<void> {
    const lang = (session?.session_data?._lang as string) || '';
    const translated = lang ? await translateBotResponse(text, lang) : text;
    return sendBotText(this.messageSender, to, translated);
  }

  private async forwardToBusinessOwner(
    businessId: string,
    customerPhone: string,
    customerName: string | null,
    messageText: string,
  ): Promise<void> {
    return _forwardToBusinessOwner(this.ctx, businessId, customerPhone, customerName, messageText);
  }
}
