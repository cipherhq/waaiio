import { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { logger } from '@/lib/logger';
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

// ── Escape hatches: always hardcoded, never overridable ──
const ESCAPE_HATCH_PATTERNS = [
  /^cancel$/i,
  /^exit$/i,
  /^quit$/i,
  /^stop$/i,
  /^restart$/i,
  /^start\s*over$/i,
];

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

    // Detect "my orders" / tracking keywords — must check BEFORE bookings so "orders" routes correctly
    // "Order" alone is ambiguous — only treat as past-orders query if it says "my order(s)" or has tracking keywords
    const isOrdersQuery = /^my\s+orders?$/i.test(text)
      || /^(check|view|show|list|see)\s+(my\s+)?orders?$/i.test(text)
      || /^(order\s+status|track\s+(my\s+)?order|where'?s?\s+(is\s+)?(my\s+)?order|delivery\s+status|order\s+history)$/i.test(text)
      || /^track\s+my\s+order$/i.test(text)
      || /^where\s+is\s+my\s+(order|delivery|package)$/i.test(text);

    // Detect reference code pattern (e.g. BW-O1234, AB-1234)
    const referenceCodeMatch = text.match(/^([A-Z]{2,}-[A-Z]?\d{3,})$/i);

    // Detect "my bookings" keyword — covers industry-specific terminology (orders removed — handled above)
    const isBookingsQuery = /^(my\s+)?(bookings?|reservations?|appointments?|appts?|sessions?|upcoming|schedule)$/i.test(text)
      || /^(check|view|show|list|see)\s+(my\s+)?(bookings?|reservations?|appointments?|appts?|schedule)$/i.test(text);

    // Detect reschedule intent — shortcut to my_bookings flow
    const isRescheduleQuery = /^(reschedule|change\s+(my\s+)?(time|date|appointment|booking)|move\s+(my\s+)?(appointment|booking))$/i.test(text);

    // Detect location/address queries
    const isLocationQuery = /^(where|location|address|directions?|how\s+to\s+get|find\s+you|map)$/i.test(text)
      || /^(where\s+(are|is)\s+(you|the|your))/i.test(text);

    const isHistoryQuery = /^(my\s+)?(transaction\s*|payment\s*)?history$/i.test(text)
      || /^(show\s+)?(my\s+)?transaction\s*history$/i.test(text)
      || /^(all|past)\s+(transactions?|payments?)$/i.test(text);

    const isReceiptQuery = /^(my\s+)?receipt$/i.test(text)
      || /^(last|latest|recent)\s+(receipt|transaction|payment)$/i.test(text)
      || /^send\s+(my\s+)?receipt$/i.test(text);

    const isAnnualQuery = /annual\s+statement/i.test(text)
      || /yearly\s+summary/i.test(text)
      || /tax\s+receipt/i.test(text)
      || /donation\s+(receipt|summary)/i.test(text)
      || /year[\s-]*end\s+statement/i.test(text)
      || /yearly\s+statement/i.test(text);

    const isSubscriptionsQuery = /^(my\s+)?subscriptions?$/i.test(text)
      || /^(my\s+)?recurring(\s+payments?)?$/i.test(text)
      || /^(manage|view|show|check)\s+(my\s+)?(subscriptions?|recurring)$/i.test(text);

    const isLoyaltyQuery = /^(my\s+)?(loyalty|points|rewards?|stars?)$/i.test(text)
      || /^(check|view|show)\s+(my\s+)?(loyalty|points|rewards?|balance)$/i.test(text);

    const isInvoiceQuery = /^(my\s+)?(invoices?|bills?)$/i.test(text)
      || /^(check|view|show|pay)\s+(my\s+)?(invoices?|bills?)$/i.test(text);

    const isGivingQuery = /^(my\s+)?(giving|donations?|tithes?|offerings?)(\s+history)?$/i.test(text)
      || /^(check|view|show)\s+(my\s+)?(giving|donations?|tithes?|offerings?)$/i.test(text)
      || /^(giving|donation)\s+history$/i.test(text);

    const isContractQuery = /^(my\s+)?(contracts?|signatures?|documents?\s+to\s+sign)$/i.test(text)
      || /^(check|view|show)\s+(my\s+)?(contracts?|signatures?)$/i.test(text);

    const isQuoteQuery = /^(my\s+)?(quotes?|price\s+requests?)$/i.test(text)
      || /^(check|view|show)\s+(my\s+)?(quotes?|price\s+requests?)$/i.test(text);

    const isMyAccountQuery = /^(my\s+)?account$/i.test(text)
      || /^(manage|my\s+stuff)$/i.test(text);

    const isQueueQuery = /^(join\s+)?queue$/i.test(text)
      || /^check\s*in$/i.test(text)
      || /^(join|enter)\s+(the\s+)?(queue|line|waiting\s*list)$/i.test(text);

    const isSaveCardQuery = /^save\s+card$/i.test(text) || /^save\s+my\s+card$/i.test(text);
    const isRemoveCardQuery = /^remove\s+card$/i.test(text) || /^delete\s+card$/i.test(text) || /^remove\s+my\s+card$/i.test(text);
    const isReorderQuery = /^(reorder|re-order|same\s+again|order\s+(the\s+)?same(\s+thing)?|repeat\s+order|last\s+order)$/i.test(text);

    let session = await this.getActiveSession(from);

    // Handle location query — send business address/location
    if (isLocationQuery && session?.business_id) {
      const { data: biz } = await this.supabase
        .from('businesses')
        .select('name, address, metadata')
        .eq('id', session.business_id)
        .single();
      if (biz?.address) {
        // Try to send location pin if coordinates available, otherwise text
        const meta = biz.metadata as Record<string, unknown> | null;
        const lat = meta?.latitude as number | undefined;
        const lng = meta?.longitude as number | undefined;
        if (lat && lng && this.messageSender.sendLocation) {
          try {
            await this.messageSender.sendLocation({ to: from, latitude: lat, longitude: lng, name: biz.name, address: biz.address });
          } catch {
            await this.sendText(from, `📍 *${biz.name}*\n${biz.address}`);
          }
        } else {
          await this.sendText(from, `📍 *${biz.name}*\n${biz.address}`);
        }
      } else {
        await this.sendText(from, 'Sorry, no address is available for this business.');
      }
      return;
    }

    // ── My Orders / Order Tracking ──
    if (isOrdersQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
        return;
      }
      await this.supabase.from('bot_sessions')
        .delete()
        .eq('whatsapp_number', from)
        .is('business_id', null)
        .eq('is_active', false);
      const { data: newSession } = await this.supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: null,
        current_step: 'my_orders', session_data: {}, is_active: true,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }).select().single();
      if (!newSession) { await this.sendText(from, 'Something went wrong. Try again.'); return; }
      session = newSession as BotSession;
      await this.handleMyOrders(session, from, '');
      return;
    }

    // ── Reference code lookup (e.g. BW-O1234) ──
    if (referenceCodeMatch && !session?.business_id) {
      const refCode = referenceCodeMatch[1].toUpperCase();
      const profile = await getProfile();
      if (profile?.id) {
        const { data: order } = await this.supabase
          .from('orders')
          .select('id, reference_code, status, total_amount, created_at, businesses (name, country_code)')
          .eq('reference_code', refCode)
          .eq('user_id', profile.id)
          .maybeSingle();
        if (order) {
          if (session) {
            await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
          }
          await this.supabase.from('bot_sessions')
            .delete()
            .eq('whatsapp_number', from)
            .is('business_id', null)
            .eq('is_active', false);
          const { data: newSession } = await this.supabase.from('bot_sessions').insert({
            whatsapp_number: from, user_id: profile.id, business_id: null,
            current_step: 'order_detail', session_data: { selected_order_id: order.id }, is_active: true,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          }).select().single();
          if (newSession) {
            await this.handleOrderDetail(newSession as BotSession, from, order.id);
            return;
          }
        }
        // Try bookings
        const { data: booking } = await this.supabase
          .from('bookings')
          .select('id')
          .eq('reference_code', refCode)
          .eq('user_id', profile.id)
          .maybeSingle();
        if (booking) {
          // Route to bookings
          if (session) {
            await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
          }
          await this.supabase.from('bot_sessions')
            .delete()
            .eq('whatsapp_number', from)
            .is('business_id', null)
            .eq('is_active', false);
          const { data: newSession } = await this.supabase.from('bot_sessions').insert({
            whatsapp_number: from, user_id: profile.id, business_id: null,
            current_step: 'my_bookings', session_data: { selected_booking_id: booking.id }, is_active: true,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          }).select().single();
          if (newSession) {
            session = newSession as BotSession;
            await this.handleMyBookings(session, from, `booking_${booking.id}`);
            return;
          }
        }
        // Not found — fall through to normal flow (don't interrupt)
      }
    }

    if (isBookingsQuery || isRescheduleQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
        return;
      }
      // Remove old inactive sessions for this phone (null business) to avoid unique constraint violation
      await this.supabase.from('bot_sessions')
        .delete()
        .eq('whatsapp_number', from)
        .is('business_id', null)
        .eq('is_active', false);
      const { data: newSession } = await this.supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: null,
        current_step: 'my_bookings', session_data: {}, is_active: true,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }).select().single();
      if (!newSession) { await this.sendText(from, 'Something went wrong. Try again.'); return; }
      session = newSession as BotSession;
      await this.handleMyBookings(session, from, '');
      return;
    }

    if (isHistoryQuery || isReceiptQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
        return;
      }
      await this.handleTransactionDocument(from, profile.id, isHistoryQuery ? 'history' : 'receipt');
      return;
    }

    if (isAnnualQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
        return;
      }
      await this.handleTransactionDocument(from, profile.id, 'annual');
      return;
    }

    // ── Save Card (consent-based) ──
    if (isSaveCardQuery) {
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;

      // Find the most recent paid booking for this phone, then get its payment
      const { data: recentBooking } = await this.supabase
        .from('bookings')
        .select('id, business_id')
        .or(`guest_phone.eq.${sanitizeFilterValue(phoneP)},guest_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .eq('deposit_status', 'paid')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let payment: { id: string; business_id: string | null; metadata: unknown; gateway: string } | null = null;

      if (recentBooking) {
        const { data: bookingPayment } = await this.supabase
          .from('payments')
          .select('id, business_id, metadata, gateway')
          .eq('booking_id', recentBooking.id)
          .eq('status', 'success')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (bookingPayment) {
          payment = {
            ...bookingPayment,
            business_id: bookingPayment.business_id || recentBooking.business_id,
          };
        }
      }

      // Also try direct payment lookup by user_id
      if (!payment) {
        const profile = await getProfile();
        if (profile?.id) {
          const { data: userPayment } = await this.supabase
            .from('payments')
            .select('id, business_id, metadata, gateway')
            .eq('user_id', profile.id)
            .eq('status', 'success')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (userPayment) payment = userPayment;
        }
      }

      if (!payment) {
        await this.sendText(from, 'No recent payment found. Make a payment first, then type *save card*.');
        return;
      }

      const meta = (payment.metadata || {}) as Record<string, unknown>;
      const auth = meta._card_authorization as Record<string, unknown> | undefined;

      if (!auth?.authorization_code) {
        const gateway = payment.gateway || 'unknown';
        if (gateway === 'stripe' || gateway === 'square' || gateway === 'paypal') {
          await this.sendText(from, `Card saving is currently available for Paystack payments only. ${gateway.charAt(0).toUpperCase() + gateway.slice(1)} support is coming soon.`);
        } else {
          await this.sendText(from, 'Your last payment method cannot be saved. Try again after your next payment.');
        }
        return;
      }

      const businessId = payment.business_id || session?.business_id;
      if (!businessId) {
        await this.sendText(from, 'Could not determine the business. Try again from within a business session.');
        return;
      }

      const { data: existing } = await this.supabase
        .from('saved_payment_methods')
        .select('id')
        .eq('business_id', businessId)
        .eq('customer_phone', phoneP)
        .eq('is_active', true)
        .maybeSingle();

      if (existing) {
        await this.sendText(from, 'You already have a saved card for this business. Type *remove card* to remove it first.');
        return;
      }

      // Store card data in session and ask for PIN
      const saveData = {
        _save_card_pending: true,
        _save_card_business_id: businessId,
        _save_card_gateway: payment.gateway || 'paystack',
        _save_card_auth: auth,
      };

      if (session) {
        await this.supabase.from('bot_sessions')
          .update({ current_step: 'save_card_pin', session_data: { ...session.session_data, ...saveData } })
          .eq('id', session.id);
      } else {
        await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from, user_id: null, business_id: businessId,
          current_step: 'save_card_pin', session_data: saveData, is_active: true,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });
      }

      const cardLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;
      await this.sendText(from, `💳 Saving *${cardLabel}*\n\nCreate a *4-digit PIN* to secure this card.\nYou'll need this PIN every time you use the saved card.\n\nType your 4-digit PIN now:`);
      return;
    }

    // ── Remove Card ──
    if (isRemoveCardQuery) {
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const businessId = session?.business_id;

      // If in a business session, remove card for that business
      // Otherwise, remove all saved cards for this phone
      if (businessId) {
        const { data: deleted } = await this.supabase
          .from('saved_payment_methods')
          .delete()
          .eq('business_id', businessId)
          .eq('customer_phone', phoneP)
          .eq('is_active', true)
          .select('card_last4, card_brand');

        if (deleted && deleted.length > 0) {
          const card = deleted[0];
          await this.sendText(from, `Card removed: ${((card.card_brand as string) || 'Card').toUpperCase()} ****${(card.card_last4 as string) || '****'}\n\nYou'll need to enter card details for future payments.`);
        } else {
          await this.sendText(from, 'No saved card found for this business.');
        }
      } else {
        const { data: deleted } = await this.supabase
          .from('saved_payment_methods')
          .delete()
          .eq('customer_phone', phoneP)
          .eq('is_active', true)
          .select('card_last4');

        if (deleted && deleted.length > 0) {
          await this.sendText(from, `Removed ${deleted.length} saved card${deleted.length > 1 ? 's' : ''}. You'll need to enter card details for future payments.`);
        } else {
          await this.sendText(from, 'No saved cards found.');
        }
      }
      return;
    }

    // ── Reorder: repeat last order ──
    if (isReorderQuery && session?.business_id) {
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;

      // Find last completed order for this business
      const { data: lastOrder } = await this.supabase
        .from('orders')
        .select('id, reference_code, total_amount')
        .eq('business_id', session.business_id)
        .or(`delivery_phone.eq.${sanitizeFilterValue(phoneP)},delivery_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .in('status', ['confirmed', 'delivered', 'ready'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!lastOrder) {
        await this.sendText(from, "No previous orders found for this business. Type *order* to browse the menu.");
        return;
      }

      // Get order items
      const { data: items } = await this.supabase
        .from('order_items')
        .select('product_id, product_name, quantity, unit_price, variant_label')
        .eq('order_id', lastOrder.id);

      if (!items || items.length === 0) {
        await this.sendText(from, "Couldn't load your last order. Type *order* to browse the menu.");
        return;
      }

      // Pre-fill cart with last order items
      const cart = items.map(i => ({
        product_id: i.product_id,
        name: i.product_name,
        price: i.unit_price,
        quantity: i.quantity,
        variant: null,
        variant_label: i.variant_label || null,
      }));

      const itemList = items.map(i => `• ${i.quantity}x ${i.product_name}${i.variant_label ? ` (${i.variant_label})` : ''}`).join('\n');

      // Start ordering flow with pre-filled cart
      await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);

      const { data: biz } = await this.supabase
        .from('businesses')
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
        .eq('id', session.business_id)
        .single();

      const profile = await getProfile();
      const caps = await getEnabledCapabilities(this.supabase, session.business_id);

      const { data: newSession } = await this.supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile?.id || null, business_id: session.business_id,
        current_step: 'continue_or_checkout',
        session_data: { active_capability: 'ordering', capabilities: caps, cart, _reorder: true },
        is_active: true,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }).select().single();

      if (!newSession) {
        await this.sendText(from, 'Something went wrong. Try again.');
        return;
      }

      await this.sendText(from, `Reordering from your last order (${lastOrder.reference_code}):\n\n${itemList}\n\nReady to checkout?`);
      await this.flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
      return;
    }

    if (isSubscriptionsQuery) {
      // Need business context — use the current session's business, or find from recent payments
      const businessId = session?.business_id || null;
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }

      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
        return;
      }

      // If no business from session, find the most recent business they have subscriptions with
      let resolvedBusinessId = businessId;
      if (!resolvedBusinessId) {
        const { data: recentSub } = await this.supabase
          .from('customer_subscriptions')
          .select('business_id')
          .eq('customer_phone', phoneP)
          .in('status', ['active', 'paused', 'past_due'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        resolvedBusinessId = recentSub?.business_id || null;
      }

      if (!resolvedBusinessId) {
        await this.sendText(from, "You don't have any recurring payments set up. Send *Hi* to make a payment!");
        return;
      }

      // Clean up old inactive sessions to avoid unique constraint
      await this.supabase.from('bot_sessions')
        .delete()
        .eq('whatsapp_number', from)
        .eq('is_active', false);

      const { data: newSession } = await this.supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: resolvedBusinessId,
        current_step: 'list_subscriptions', session_data: {}, is_active: true,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }).select().single();

      if (!newSession) { await this.sendText(from, 'Something went wrong. Try again.'); return; }

      // Load business for the executor
      const { data: biz } = await this.supabase
        .from('businesses')
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
        .eq('id', resolvedBusinessId)
        .single();

      await this.flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
      return;
    }

    if (isLoyaltyQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
        return;
      }

      // Find most recent loyalty_points entry to get business_id
      const { data: loyaltyEntry } = await this.supabase
        .from('loyalty_points')
        .select('business_id')
        .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const resolvedBusinessId = session?.business_id || loyaltyEntry?.business_id || null;
      if (!resolvedBusinessId) {
        await this.sendText(from, "You don't have any loyalty points yet. Visit a business to start earning!");
        return;
      }

      const caps = await getEnabledCapabilities(this.supabase, resolvedBusinessId);
      if (!caps.includes('loyalty')) {
        await this.sendText(from, "This business doesn't have a loyalty program. Send *Hi* to start over.");
        return;
      }

      await this.supabase.from('bot_sessions').delete()
        .eq('whatsapp_number', from).eq('is_active', false);

      const { data: newSession } = await this.supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: resolvedBusinessId,
        current_step: 'loyalty_menu', session_data: { loyalty_business_id: resolvedBusinessId }, is_active: true,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }).select().single();

      if (!newSession) { await this.sendText(from, 'Something went wrong. Try again.'); return; }

      const { data: biz } = await this.supabase
        .from('businesses')
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
        .eq('id', resolvedBusinessId)
        .single();

      await this.flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
      return;
    }

    if (isInvoiceQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
        return;
      }

      // Find most recent unpaid invoice to get business_id
      const { data: invoiceEntry } = await this.supabase
        .from('invoices')
        .select('business_id')
        .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .in('status', ['sent', 'viewed', 'overdue'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const resolvedBusinessId = session?.business_id || invoiceEntry?.business_id || null;
      if (!resolvedBusinessId) {
        await this.sendText(from, "You don't have any outstanding invoices.");
        return;
      }

      await this.supabase.from('bot_sessions').delete()
        .eq('whatsapp_number', from).eq('is_active', false);

      const { data: newSession } = await this.supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: resolvedBusinessId,
        current_step: 'invoice_list', session_data: { invoice_business_id: resolvedBusinessId }, is_active: true,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }).select().single();

      if (!newSession) { await this.sendText(from, 'Something went wrong. Try again.'); return; }

      const { data: biz } = await this.supabase
        .from('businesses')
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
        .eq('id', resolvedBusinessId)
        .single();

      await this.flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
      return;
    }

    // ── My Giving / Donation History ──
    if (isGivingQuery) {
      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
        return;
      }

      const businessId = session?.business_id || null;

      // Fetch giving history: bookings linked to services with service_type='giving' + campaign donations
      const phoneN = from.startsWith('+') ? from.slice(1) : from;
      const [{ data: givingBookings }, { data: donations }] = await Promise.all([
        this.supabase.from('bookings')
          .select('total_amount, created_at, services:service_id(name, service_type), businesses:business_id(name)')
          .or(`guest_phone.eq.${sanitizeFilterValue(phoneP)},guest_phone.eq.${sanitizeFilterValue(phoneN)}`)
          .eq('deposit_status', 'paid')
          .order('created_at', { ascending: false }).limit(100),
        this.supabase.from('campaign_donations')
          .select('amount, status, campaign_id, created_at, reference_code')
          .or(`donor_phone.eq.${sanitizeFilterValue(phoneP)},donor_phone.eq.${sanitizeFilterValue(phoneN)}`)
          .eq('status', 'success')
          .order('created_at', { ascending: false }).limit(10),
      ]);

      // Combine and show
      const allGiving: Array<{ amount: number; date: string; label: string; _ts: number }> = [];

      if (givingBookings) {
        for (const b of givingBookings) {
          const svc = b.services as unknown as { name: string; service_type?: string } | null;
          if (svc?.service_type !== 'giving') continue;
          const biz = b.businesses as unknown as { name: string } | null;
          allGiving.push({
            amount: Number(b.total_amount || 0),
            date: new Date(b.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            label: svc.name || biz?.name || 'Offering',
            _ts: new Date(b.created_at).getTime(),
          });
        }
      }

      if (donations) {
        for (const d of donations) {
          allGiving.push({
            amount: Number(d.amount),
            date: new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            label: `Campaign (${d.reference_code})`,
            _ts: new Date(d.created_at).getTime(),
          });
        }
      }

      // Sort by date descending (using raw timestamp, not formatted string)
      allGiving.sort((a, b) => b._ts - a._ts);

      if (allGiving.length === 0) {
        await this.sendText(from, "You don't have any giving history yet. Send *Hi* to start over.");
        return;
      }

      const total = allGiving.reduce((sum, g) => sum + g.amount, 0);
      const lines = [
        `🙏 *Your Giving History*`,
        '',
        ...allGiving.slice(0, 10).map(g =>
          `📅 ${g.date} — *${g.label}* — ${g.amount.toLocaleString()}`
        ),
        '',
        `💰 *Total Given: ${total.toLocaleString()}*`,
        `📊 ${allGiving.length} contribution${allGiving.length !== 1 ? 's' : ''}`,
        '',
        'Type *receipt* to get your giving receipt',
        'Type *Hi* to give again',
      ];
      await this.sendText(from, lines.join('\n'));
      return;
    }

    // ── My Contracts / E-Signatures ──
    if (isContractQuery) {
      // Query single-signer and multi-signer contracts in parallel (independent tables)
      const [{ data: singleContracts }, { data: multiSignerEntries }] = await Promise.all([
        this.supabase
          .from('contracts')
          .select('id, title, status, signed_at, created_at, token, signing_mode, businesses:business_id(name)')
          .or(`signer_phone.eq.${sanitizeFilterValue(phoneP)},signer_phone.eq.${sanitizeFilterValue(phoneN)}`)
          .order('created_at', { ascending: false })
          .limit(10),
        this.supabase
          .from('contract_signers')
          .select('id, token, status, signed_at, created_at, contracts:contract_id(id, title, signing_mode, businesses:business_id(name))')
          .or(`signer_phone.eq.${sanitizeFilterValue(phoneP)},signer_phone.eq.${sanitizeFilterValue(phoneN)}`)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      // Normalize into a unified list
      const allContracts: Array<{
        title: string; status: string; signed_at: string | null;
        created_at: string; token: string; bizName: string;
      }> = [];

      if (singleContracts) {
        for (const c of singleContracts) {
          if (c.signing_mode !== 'single' && c.signing_mode !== null) continue; // skip multi-signer (handled below)
          const biz = c.businesses as any;
          allContracts.push({
            title: c.title, status: c.status, signed_at: c.signed_at,
            created_at: c.created_at, token: c.token, bizName: biz?.name || 'Business',
          });
        }
      }

      if (multiSignerEntries) {
        for (const s of multiSignerEntries) {
          const contract = s.contracts as any;
          if (!contract) continue;
          const biz = contract.businesses as any;
          allContracts.push({
            title: contract.title, status: s.status, signed_at: s.signed_at,
            created_at: s.created_at, token: s.token, bizName: biz?.name || 'Business',
          });
        }
      }

      // Deduplicate by token
      const seen = new Set<string>();
      const unique = allContracts.filter(c => {
        if (seen.has(c.token)) return false;
        seen.add(c.token);
        return true;
      });

      if (unique.length === 0) {
        await this.sendText(from, "You don't have any contracts. Send *Hi* to start over.");
        return;
      }

      const pending = unique.filter(c => c.status === 'pending' || c.status === 'waiting');
      const signed = unique.filter(c => c.status === 'signed');
      const other = unique.filter(c => c.status !== 'pending' && c.status !== 'waiting' && c.status !== 'signed');

      const cLines = ['📋 *Your Contracts*', ''];

      if (pending.length > 0) {
        cLines.push('⏳ *Pending Signature:*');
        for (const c of pending) {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
          cLines.push(`• ${c.title} from ${c.bizName}`);
          cLines.push(`  Sign here: ${appUrl}/sign/${c.token}`);
        }
        cLines.push('');
      }

      if (signed.length > 0) {
        cLines.push('✅ *Signed:*');
        for (const c of signed) {
          const signedDate = c.signed_at ? new Date(c.signed_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
          cLines.push(`• ${c.title} from ${c.bizName} — signed ${signedDate}`);
        }
        cLines.push('');
      }

      if (other.length > 0) {
        const statusEmoji: Record<string, string> = { expired: '⌛', revoked: '🚫', declined: '❌' };
        for (const c of other) {
          const emoji = statusEmoji[c.status] || '📋';
          cLines.push(`${emoji} ${c.title} from ${c.bizName} — ${c.status}`);
        }
        cLines.push('');
      }

      cLines.push('💡 *What you can do:*');
      cLines.push('• Tap a signing link above to sign pending contracts');
      cLines.push('• Type *Hi* to start a new conversation');

      await this.sendText(from, cLines.join('\n'));
      return;
    }

    // ── My Quotes / Price Requests ──
    if (isQuoteQuery) {
      const { data: quotes } = await this.supabase
        .from('quote_requests')
        .select('id, status, estimated_subtotal, quoted_amount, created_at, businesses:business_id(name)')
        .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .order('created_at', { ascending: false })
        .limit(10);

      if (!quotes || quotes.length === 0) {
        await this.sendText(from, "You don't have any price requests. Send *Hi* to start over.");
        return;
      }

      const statusEmoji: Record<string, string> = {
        pending: '⏳', quoted: '💰', accepted: '✅',
        rejected: '❌', expired: '⌛', cancelled: '🚫',
      };

      const qLines = ['📋 *Your Price Requests*', ''];

      for (const q of quotes) {
        const biz = q.businesses as any;
        const emoji = statusEmoji[q.status] || '📋';
        const date = new Date(q.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        let detail = `${emoji} ${biz?.name || 'Business'} — ${date}`;
        if (q.status === 'quoted' && q.quoted_amount) {
          detail += ` — Quoted: ${q.quoted_amount.toLocaleString()}`;
        } else if (q.status === 'pending') {
          detail += ' — Awaiting response';
        } else {
          detail += ` — ${q.status}`;
        }
        qLines.push(detail);
      }

      qLines.push('');
      qLines.push('💡 *What you can do:*');
      qLines.push('• Type *Hi* to make a new request');

      await this.sendText(from, qLines.join('\n'));
      return;
    }

    // ── My Account — global shortcut from any step ──
    if (isMyAccountQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
        return;
      }

      // Find most recent business the customer interacted with
      const resolvedBusinessId = session?.business_id || null;

      await this.supabase.from('bot_sessions').delete()
        .eq('whatsapp_number', from).eq('is_active', false);

      const { data: newSession } = await this.supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: resolvedBusinessId,
        current_step: 'my_account_menu', session_data: { active_capability: 'my_account' }, is_active: true,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }).select().single();

      if (!newSession) { await this.sendText(from, 'Something went wrong. Try again.'); return; }

      // Load business for flow context (may be null for cross-business account view)
      let biz = null;
      if (resolvedBusinessId) {
        const { data } = await this.supabase
          .from('businesses')
          .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
          .eq('id', resolvedBusinessId)
          .single();
        biz = data;
      }

      await this.flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
      return;
    }

    // ── Queue check-in — global shortcut ──
    if (isQueueQuery && session?.business_id) {
      // Check if queue capability is enabled for this business
      const { getEnabledCapabilities } = await import('@/lib/capabilities/service');
      const caps = await getEnabledCapabilities(this.supabase, session.business_id);
      if (caps.includes('queue')) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
        const profile = await getProfile();

        await this.supabase.from('bot_sessions').delete()
          .eq('whatsapp_number', from).eq('is_active', false);

        const { data: newSession } = await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from, user_id: profile?.id || null, business_id: session.business_id,
          current_step: 'queue_start', session_data: { active_capability: 'queue', capabilities: caps }, is_active: true,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }).select().single();

        if (newSession) {
          const { data: biz } = await this.supabase
            .from('businesses')
            .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
            .eq('id', session.business_id).single();

          await this.flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
          return;
        }
      }
    }

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
              title: s.name.slice(0, 20),
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
      || (/\b(order|buy)\b/i.test(normalizedForRestart) && normalizedForRestart.split(/\s+/).length >= 2 && !isOrdersQuery);
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
    );

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
        // Confirmed restart — proceed below
        delete session.session_data._restart_pending;
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
                title: s.name.slice(0, 20),
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
        // Check if phone is blocked by admin
        if (biz) {
          const meta = ((biz as Record<string, unknown>).metadata || {}) as Record<string, unknown>;
          const blockedPhones = Array.isArray(meta.blocked_phones) ? meta.blocked_phones as string[] : [];
          if (blockedPhones.includes(from) || blockedPhones.includes('+' + from)) {
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
              favoriteServiceId: custHistory.favoriteServiceId,
              favoriteServiceName: custHistory.favoriteServiceName,
            };

            // Use pre-fetched profile name for personalized greeting
            const customerName = (fullProfile as { first_name?: string } | null)?.first_name || null;

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
              title: btn.label.slice(0, 20),
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
            title: s.name.slice(0, 20),
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
    const isChatMode = step === 'chat_handoff' || step === 'chat_start';
    const isBookingMgmt = step === 'my_bookings' || step === 'modify_booking' || step === 'my_orders' || step === 'order_detail';
    const isEscapeHatch = ESCAPE_HATCH_PATTERNS.some(p => p.test(text.trim()));
    if (isEscapeHatch && (session.business_id || isBookingMgmt) && !isChatMode) {
      this.intelligence.resetAbuse(from);
      await this.deactivateSession(session.id);
      await this.sendText(from, 'Action cancelled. Send *Hi* to start over. 🙏');
      return;
    }

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
    if (step === 'save_card_pin') {
      const pin = text.trim();

      if (pin === 'cancel' || pin === 'exit') {
        const updatedData = { ...session.session_data };
        delete updatedData._save_card_pending;
        delete updatedData._save_card_business_id;
        delete updatedData._save_card_gateway;
        delete updatedData._save_card_auth;
        await this.supabase.from('bot_sessions')
          .update({ current_step: 'select_capability', session_data: updatedData })
          .eq('id', session.id);
        await this.sendText(from, 'Card save cancelled.');
        return;
      }

      if (!/^\d{4}$/.test(pin)) {
        await this.sendText(from, 'Please enter exactly *4 digits* for your PIN (e.g. 1234):');
        return;
      }

      const d = session.session_data;
      const auth = d._save_card_auth as Record<string, unknown>;
      const businessId = d._save_card_business_id as string;
      const gateway = d._save_card_gateway as string;
      const phoneP = from.startsWith('+') ? from : `+${from}`;

      if (!auth?.authorization_code || !businessId) {
        await this.sendText(from, 'Something went wrong. Please type *save card* again.');
        await this.supabase.from('bot_sessions').update({ current_step: 'select_capability', session_data: {} }).eq('id', session.id);
        return;
      }

      // Hash the PIN with SHA-256 + phone as salt (not reversible)
      const { createHash } = await import('crypto');
      const pinHash = createHash('sha256').update(`${pin}:${phoneP}`).digest('hex');

      await this.supabase.from('saved_payment_methods').insert({
        business_id: businessId,
        customer_phone: phoneP,
        gateway,
        authorization_code: auth.authorization_code as string,
        customer_code: (auth.customer_code as string) || null,
        card_last4: (auth.last4 as string) || null,
        card_brand: (auth.brand as string) || null,
        card_exp_month: auth.exp_month ? Number(auth.exp_month) : null,
        card_exp_year: auth.exp_year ? Number(auth.exp_year) : null,
        card_type: (auth.card_type as string) || null,
        bank_name: (auth.bank as string) || null,
        is_active: true,
        pin_hash: pinHash,
        pin_attempts: 0,
        last_used_at: new Date().toISOString(),
      });

      const cardLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;

      // Clear save data from session
      const cleanData = { ...session.session_data };
      delete cleanData._save_card_pending;
      delete cleanData._save_card_business_id;
      delete cleanData._save_card_gateway;
      delete cleanData._save_card_auth;
      await this.supabase.from('bot_sessions')
        .update({ current_step: 'select_capability', session_data: cleanData })
        .eq('id', session.id);

      await this.sendText(from, `💳 Card saved! *${cardLabel}*\n\n🔒 PIN set successfully. You'll need this PIN when using your saved card.\n\nType *remove card* anytime to delete it.`);
      return;
    }

    // Handle "Did you mean?" business selection
    if (step === 'select_business_suggestion') {
      const suggestions = (session.session_data.suggestions || []) as { id: string; name: string; bot_code: string }[];
      let selectedBiz: { id: string; name: string; bot_code: string } | null = null;

      // Check for "No" / rejection
      const isNo = /^(biz_no|no|nah|nope|wrong|not|cancel)$/i.test(text);
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

    // Chat handoff: bot is paused, route messages to human agent
    if (session.business_id && step === 'chat_handoff') {
      const restartMatch = /^(restart|start\s*over|end\s*chat|exit\s*chat|close\s*chat|stop\s*chat)$/i.test(text);
      if (restartMatch) {
        await this.deactivateSession(session.id);
        // Also resolve the conversation so the dashboard shows it as resolved
        try {
          await this.supabase.from('chat_conversations').update({
            status: 'resolved',
            resolved_at: new Date().toISOString(),
          })
            .eq('business_id', session.business_id)
            .eq('customer_phone', from)
            .eq('status', 'open');
        } catch { /* non-critical */ }
        // Re-enter the bot from scratch so they get the menu
        return this.handleMessage(from, text, messageType, destinationPhone, session.business_id);
      }

      // Allow bot capability selections (button payloads) during live chat
      if (text.startsWith('cap_')) {
        await this.deactivateSession(session.id);
        return this.handleMessage(from, text, messageType, destinationPhone, session.business_id);
      }

      // Store message for human agent, update conversation
      const chatPhoneP = from.startsWith('+') ? from : `+${from}`;
      const chatPhoneN = from.startsWith('+') ? from.slice(1) : from;
      let handoffName: string | null = null;
      const { data: hProfile } = await this.supabase
        .from('profiles')
        .select('first_name, last_name')
        .or(`phone.eq.${sanitizeFilterValue(chatPhoneP)},phone.eq.${sanitizeFilterValue(chatPhoneN)}`)
        .limit(1)
        .maybeSingle();
      if (hProfile?.first_name) {
        handoffName = `${hProfile.first_name}${hProfile.last_name ? ' ' + hProfile.last_name : ''}`;
      }

      // Get conversation_id
      const { data: conv } = await this.supabase
        .from('chat_conversations')
        .select('id')
        .eq('business_id', session.business_id)
        .eq('customer_phone', from)
        .maybeSingle();

      await this.supabase.from('chat_messages').insert({
        business_id: session.business_id,
        customer_phone: from,
        customer_name: handoffName,
        direction: 'inbound',
        message_text: text,
        is_read: false,
        conversation_id: conv?.id || null,
        media_url: mediaUrl || null,
        media_type: mediaUrl ? (messageType || 'image') : null,
      });

      // Update last_message_at on conversation
      if (conv?.id) {
        await this.supabase.from('chat_conversations').update({
          last_message_at: new Date().toISOString(),
        }).eq('id', conv.id);
      }

      // ── Inactivity warning: notify customer if business hasn't replied in 10+ min ──
      if (conv?.id && !session.session_data._inactivity_warned) {
        try {
          const { data: lastOutbound } = await this.supabase
            .from('chat_messages')
            .select('created_at')
            .eq('conversation_id', conv.id)
            .eq('direction', 'outbound')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          const lastReplyAt = lastOutbound ? new Date(lastOutbound.created_at).getTime() : 0;
          if (lastReplyAt > 0 && Date.now() - lastReplyAt > 10 * 60 * 1000) {
            await this.sendText(from, "The team hasn't responded yet. You can keep waiting or type *end chat* to go back to the menu.");
            session.session_data._inactivity_warned = true;
            await this.supabase.from('bot_sessions').update({
              session_data: session.session_data,
            }).eq('id', session.id);
          }
        } catch { /* non-critical */ }
      }

      // ── Email notification for new chat (rate-limited: max 1 per 30 min per conversation) ──
      try {
        const lastEmailAt = session.session_data._last_chat_email_at as number || 0;
        const now = Date.now();
        if (now - lastEmailAt > 30 * 60 * 1000) {
          const { data: biz } = await this.supabase
            .from('businesses')
            .select('name, profiles:owner_id (email)')
            .eq('id', session.business_id)
            .single();
          const ownerEmail = (biz?.profiles as any)?.email;
          if (ownerEmail && biz) {
            const displayName = handoffName || from;
            const { sendEmail } = await import('@/lib/email/client');
            sendEmail({
              to: ownerEmail,
              subject: `New chat message from ${displayName} — ${biz.name}`,
              html: `<p><strong>${displayName}</strong> sent you a message:</p>
                     <blockquote style="border-left: 3px solid #6C2BD9; padding-left: 12px; color: #333;">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</blockquote>
                     <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/dashboard/chat" style="color: #6C2BD9; font-weight: bold;">Reply in your dashboard</a></p>
                     <p style="color: #999; font-size: 12px;">Powered by Waaiio</p>`,
            }).catch(() => {});
            session.session_data._last_chat_email_at = now;
            await this.supabase.from('bot_sessions').update({
              session_data: session.session_data,
            }).eq('id', session.id);
          }
        }
      } catch { /* non-critical */ }

      // Forward message to business owner's phone
      await this.forwardToBusinessOwner(session.business_id, from, handoffName, text);
      return;
    }

    // Chat fallback: if message doesn't match any flow step and chat is enabled,
    // store as inbound chat message
    if (session.business_id && step === 'chat_start') {
      // Allow user to exit chat_start mode
      const chatExitMatch = /^(restart|start\s*over|end\s*chat|exit\s*chat|close\s*chat|stop\s*chat|hi|hello|menu)$/i.test(text);
      if (chatExitMatch) {
        await this.deactivateSession(session.id);
        try {
          await this.supabase.from('chat_conversations').update({
            status: 'resolved',
            resolved_at: new Date().toISOString(),
          })
            .eq('business_id', session.business_id)
            .eq('customer_phone', from)
            .eq('status', 'open');
        } catch { /* non-critical */ }
        return this.handleMessage(from, text, messageType, destinationPhone, session.business_id);
      }

      // Allow bot capability selections during chat
      if (text.startsWith('cap_')) {
        await this.deactivateSession(session.id);
        return this.handleMessage(from, text, messageType, destinationPhone, session.business_id);
      }

      // This is a chat session — store message and acknowledge
      // Skip if the chat flow validate() already handled this message
      const alreadyHandled = session.session_data?.first_message_handled;
      const caps = (session.session_data?.capabilities as CapabilityId[]) || await getEnabledCapabilities(this.supabase, session.business_id);
      if (caps.includes('chat') && !alreadyHandled) {
        // Get customer name
        const chatPhoneP = from.startsWith('+') ? from : `+${from}`;
        const chatPhoneN = from.startsWith('+') ? from.slice(1) : from;
        let customerName: string | null = null;
        const { data: profile } = await this.supabase
          .from('profiles')
          .select('first_name, last_name')
          .or(`phone.eq.${sanitizeFilterValue(chatPhoneP)},phone.eq.${sanitizeFilterValue(chatPhoneN)}`)
          .limit(1)
          .maybeSingle();
        if (profile?.first_name) {
          customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
        }

        // Check existing conversation to determine if this is a new 24h window
        const { data: existingConv } = await this.supabase
          .from('chat_conversations')
          .select('id, last_message_at')
          .eq('business_id', session.business_id)
          .eq('customer_phone', from)
          .maybeSingle();

        const isNewConversation = !existingConv || !existingConv.last_message_at ||
          (Date.now() - new Date(existingConv.last_message_at).getTime()) > 24 * 60 * 60 * 1000;

        // Upsert conversation record
        await this.supabase.from('chat_conversations').upsert({
          business_id: session.business_id,
          customer_phone: from,
          customer_name: customerName,
          status: 'open',
          last_message_at: new Date().toISOString(),
        }, { onConflict: 'business_id,customer_phone' });

        const { data: chatConv } = await this.supabase
          .from('chat_conversations')
          .select('id')
          .eq('business_id', session.business_id)
          .eq('customer_phone', from)
          .single();

        await this.supabase.from('chat_messages').insert({
          business_id: session.business_id,
          customer_phone: from,
          customer_name: customerName,
          direction: 'inbound',
          message_text: text,
          is_read: false,
          conversation_id: chatConv?.id ?? null,
          media_url: mediaUrl || null,
          media_type: mediaUrl ? (messageType || 'image') : null,
        });

        // Track conversation usage (non-blocking)
        Promise.resolve(
          this.supabase.rpc('increment_message_usage', {
            p_business_id: session.business_id,
            p_direction: 'inbound',
            p_is_new_conversation: isNewConversation,
          })
        ).catch((err) => logger.error('[BOT] Usage tracking failed:', err));

        // Try FAQ auto-response first
        if (text && session.business_id) {
          try {
            const { tryFaqResponse } = await import('@/lib/bot/faq-responder');
            const { data: biz } = await this.supabase
              .from('businesses')
              .select('name, address, phone, operating_hours, metadata')
              .eq('id', session.business_id)
              .single();

            if (biz) {
              const faqAnswer = await tryFaqResponse(this.supabase, session.business_id, biz, text);
              if (faqAnswer) {
                await this.sendText(from, faqAnswer);
                return;
              }
            }
          } catch { /* FAQ lookup failed, fall through to human chat */ }
        }

        // ── Email notification for new chat (rate-limited: max 1 per 30 min per conversation) ──
        try {
          const lastEmailAt = session.session_data._last_chat_email_at as number || 0;
          const nowMs = Date.now();
          if (nowMs - lastEmailAt > 30 * 60 * 1000) {
            const { data: bizForEmail } = await this.supabase
              .from('businesses')
              .select('name, profiles:owner_id (email)')
              .eq('id', session.business_id)
              .single();
            const ownerEmailAddr = (bizForEmail?.profiles as any)?.email;
            if (ownerEmailAddr && bizForEmail) {
              const displayName = customerName || from;
              const { sendEmail } = await import('@/lib/email/client');
              sendEmail({
                to: ownerEmailAddr,
                subject: `New chat message from ${displayName} — ${bizForEmail.name}`,
                html: `<p><strong>${displayName}</strong> sent you a message:</p>
                       <blockquote style="border-left: 3px solid #6C2BD9; padding-left: 12px; color: #333;">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</blockquote>
                       <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/dashboard/chat" style="color: #6C2BD9; font-weight: bold;">Reply in your dashboard</a></p>
                       <p style="color: #999; font-size: 12px;">Powered by Waaiio</p>`,
              }).catch(() => {});
              session.session_data._last_chat_email_at = nowMs;
              await this.supabase.from('bot_sessions').update({
                session_data: session.session_data,
              }).eq('id', session.id);
            }
          }
        } catch { /* non-critical */ }

        // Forward message to business owner's phone
        await this.forwardToBusinessOwner(session.business_id, from, customerName, text);
      }

      // Send acknowledgment on the first message in this chat session
      if (!session.session_data.chat_ack_sent) {
        await this.sendText(from, "Thanks for your message! A team member will respond shortly.\n\nType *end chat* anytime to return to the menu.");
        await this.supabase.from('bot_sessions').update({
          session_data: { ...session.session_data, chat_ack_sent: true },
        }).eq('id', session.id);
      }
      return;
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

  private async forwardToBusinessOwner(
    businessId: string,
    customerPhone: string,
    customerName: string | null,
    messageText: string,
  ): Promise<void> {
    return _forwardToBusinessOwner(this.ctx, businessId, customerPhone, customerName, messageText);
  }
}
