import { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { logger } from '@/lib/logger';
import type { MessageSender } from '@/lib/channels/message-sender';
import { StandaloneService } from './standalone.service';
import { BotIntelligenceService } from './bot-intelligence';
import { FlowExecutor } from './flows/executor';
import { getLocale, formatCurrency, type BusinessCategoryKey, type FlowType, type CountryCode } from '@/lib/constants';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import type { CapabilityId } from '@/lib/capabilities/types';
import { parseSmartIntent, parseSmartIntentHybrid, matchServiceFromKeywords, buildAcknowledgment } from './smart-intent';
import { translateBotResponse, detectLanguage, getLanguageName, setTranslationContext } from './translate';
import { checkAIFeature, isLanguageAllowed } from './ai-tier-guard';
import { getCustomerHistory, buildReturnGreeting } from './customer-intelligence';
import { levenshtein, isCloseMatch, matchScore, phoneticMatch, isAcronymOf, phoneToCountry, detectCategoryIntent } from './fuzzy-match';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { loadBotCustomConfig, matchQuickReply, loadUnifiedKeywords, matchUnifiedKeyword, parseKeywordPayload } from './keyword-service';
import type { UnifiedKeyword } from './keyword-service';
import { evaluateRules } from './automation/rules-engine';
import { isWithinBusinessHours, type BusinessHours } from './business-hours';

// ── Escape hatches: always hardcoded, never overridable ──
const ESCAPE_HATCH_PATTERNS = [
  /^cancel$/i,
  /^exit$/i,
  /^quit$/i,
  /^stop$/i,
  /^restart$/i,
  /^start\s*over$/i,
];

interface BotSession {
  id: string;
  whatsapp_number: string;
  user_id: string | null;
  business_id: string | null;
  current_step: string;
  session_data: Record<string, unknown>;
  conversation_log?: Array<{ role: 'bot' | 'user'; content: string; timestamp: string }>;
  is_active: boolean;
  expires_at: string;
}

interface BusinessRecord {
  id: string;
  name: string;
  slug: string;
  category: BusinessCategoryKey;
  flow_type: FlowType;
  subscription_tier: string;
  trial_ends_at: string;
  metadata: Record<string, unknown>;
  country_code?: CountryCode;
  is_whitelabel?: boolean;
}

export class BotService {
  private readonly flowExecutor: FlowExecutor;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly messageSender: MessageSender,
    private readonly standaloneService: StandaloneService,
    private readonly intelligence: BotIntelligenceService,
  ) {
    this.flowExecutor = new FlowExecutor(supabase, messageSender, standaloneService, intelligence);
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

    // Pre-check 1: Timeout
    const timeoutCheck = this.intelligence.isTimedOut(from);
    if (timeoutCheck.timedOut) {
      await this.sendText(from, `You can message again in ${timeoutCheck.remaining} minute${timeoutCheck.remaining !== 1 ? 's' : ''}. 🙏`);
      return;
    }

    // Pre-check 2: Profanity
    if (this.intelligence.containsProfanity(text)) {
      const abuse = this.intelligence.recordProfanity(from);
      if (abuse.timeout) {
        const existingSession = await this.getActiveSession(from);
        if (existingSession) await this.deactivateSession(existingSession.id);
      }
      await this.sendText(from, abuse.message);
      return;
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
    const isWaitlistReply = /^(yes|no|yep|nah|nope|yeah)$/i.test(text);
    if (isWaitlistReply) {
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
    const isOrdersQuery = /^(my\s+)?orders?$/i.test(text)
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
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to get started!");
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
            current_step: 'my_orders', session_data: { selected_order_id: order.id }, is_active: true,
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
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to get started!");
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
        await this.sendText(from, "I don't have an account for this number. Send *Hi* to get started!");
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
        await this.sendText(from, "I don't have an account for this number. Send *Hi* to get started!");
        return;
      }
      await this.handleTransactionDocument(from, profile.id, 'annual');
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
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to get started!");
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
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code')
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
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to get started!");
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
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code')
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
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to get started!");
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
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code')
        .eq('id', resolvedBusinessId)
        .single();

      await this.flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
      return;
    }

    // ── My Giving / Donation History ──
    if (isGivingQuery) {
      const profile = await getProfile();
      if (!profile?.id) {
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to get started!");
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
      const allGiving: Array<{ amount: number; date: string; label: string }> = [];

      if (givingBookings) {
        for (const b of givingBookings) {
          const svc = b.services as unknown as { name: string; service_type?: string } | null;
          if (svc?.service_type !== 'giving') continue;
          const biz = b.businesses as unknown as { name: string } | null;
          allGiving.push({
            amount: Number(b.total_amount || 0),
            date: new Date(b.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            label: svc.name || biz?.name || 'Offering',
          });
        }
      }

      if (donations) {
        for (const d of donations) {
          allGiving.push({
            amount: Number(d.amount),
            date: new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            label: `Campaign (${d.reference_code})`,
          });
        }
      }

      // Sort by date descending
      allGiving.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      if (allGiving.length === 0) {
        await this.sendText(from, "You don't have any giving history yet. Send *Hi* to get started!");
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
        await this.sendText(from, "You don't have any contracts. Send *Hi* to get started!");
        return;
      }

      const pending = unique.filter(c => c.status === 'pending' || c.status === 'waiting');
      const signed = unique.filter(c => c.status === 'signed');
      const other = unique.filter(c => c.status !== 'pending' && c.status !== 'waiting' && c.status !== 'signed');

      const cLines = ['📋 *Your Contracts*', ''];

      if (pending.length > 0) {
        cLines.push('⏳ *Pending Signature:*');
        for (const c of pending) {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
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
        await this.sendText(from, "You don't have any price requests. Send *Hi* to get started!");
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
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to get started!");
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
          .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code')
          .eq('id', resolvedBusinessId)
          .single();
        biz = data;
      }

      await this.flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
      return;
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
    const isMidFlow = !!session?.business_id && !!currentStep && currentStep !== 'greeting' && currentStep !== 'select_capability';
    const isRestart = !isFreeTextStep && (
      /^(start|restart)$/i.test(text) ||
      isGreetingText ||
      (!isMidFlow && isBookingText) ||
      isBotCodeRestart
    );

    if (!session || isRestart) {
      logger.debug('[BOT] New/restart session. hasSession:', !!session, 'isRestart:', isRestart);
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }

      // Determine standalone business
      let businessId: string | null = preResolvedBusinessId || null;
      logger.debug('[BOT] preResolvedBusinessId:', preResolvedBusinessId);

      // Fallback: lookup by destination phone
      if (!businessId && destinationPhone) {
        const { data: biz } = await this.supabase
          .from('businesses')
          .select('id')
          .eq('whatsapp_phone_number_id', destinationPhone)
          .single();
        businessId = biz?.id || null;
        logger.debug('[BOT] destPhone lookup:', destinationPhone, '→', businessId);
      }

      // Bot code routing + profile lookup in parallel (independent queries)
      let pendingSuggestions: { id: string; name: string; bot_code: string }[] | undefined;
      let isCategoryMatch = false;
      const detectionPromise = !businessId
        ? this.detectBotCodeWithSuggestions(text, from)
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
      if (!businessId) {
        businessId = await this.findReturningCustomerBusiness(from, profile?.id || null);
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
          .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, is_whitelabel')
          .eq('id', businessId)
          .single();
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

      // Auto-reply: if enabled and outside business hours, send away message and stop
      if (business && waConfig?.auto_reply_enabled && waConfig.business_hours) {
        const isOpen = isWithinBusinessHours(
          waConfig.business_hours as BusinessHours,
          (waConfig.business_hours as BusinessHours).timezone,
        );
        if (!isOpen) {
          await this.sendText(
            from,
            waConfig.away_message || 'Thanks for your message! We\'re currently closed. We\'ll get back to you during business hours.',
          );
          return;
        }
      }

      const firstStep = business
        ? this.getFirstStepFromCapabilities(capabilities, business.flow_type)
        : 'greeting';

      const sessionData: Record<string, unknown> = businessId && business
        ? { business_id: businessId, business_name: business.name, business_category: business.category, capabilities }
        : {};

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
        detectLanguage(text).then(async (lang) => {
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
        }).catch(() => {});
      }

      session = newSession as BotSession;

      if (business && waConfig && tierInfo) {
        // Standalone bot greeting — use pre-fetched config (no extra queries)
        let greeting: string;
        if (waConfig.alias) {
          greeting = this.intelligence.getPersonaGreeting(waConfig.alias, business.name);
        } else {
          greeting = this.standaloneService.fillTemplate(waConfig.templates.greeting, {
            restaurant_name: business.name,
            business_name: business.name,
          });
        }

        if (!tierInfo.isWhitelabel) greeting += '\n\n_Powered by Waaiio_';

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

        await this.sendText(from, greeting);

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
      const recentBusinesses = await this.findReturningCustomerBusinesses(from, profile?.id || null);

      if (profile) {
        const { data: returningProfile } = await this.supabase
          .from('profiles')
          .select('first_name')
          .eq('id', profile.id)
          .single();
        if (returningProfile?.first_name) {
          await this.sendText(from, `Welcome back, ${returningProfile.first_name}! 👋`);
        } else {
          await this.sendText(from, 'Welcome to Waaiio! 👋');
        }
      } else {
        await this.sendText(from, 'Welcome to Waaiio! 👋\n\nAutomate bookings, payments, orders & more via WhatsApp.');
      }

      // Quick-pick for returning users with 2+ businesses
      if (recentBusinesses.length >= 2) {
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
          body: `Which business would you like to visit?`,
          buttons: quickPick.map((s, i) => ({
            id: `biz_${i}`,
            title: s.name.slice(0, 20),
          })),
        });
        return;
      }

      // Smart retry: different message if user typed something specific vs just "Hi"
      const isGreeting = /^(hi|hello|hey|yo|start)$/i.test(text.trim());
      if (isGreeting) {
        await this.sendText(from, 'Send a *business code* to connect to a business.\n\nOr type *switch* followed by a name, e.g.:\n_switch Bukka Hut_\n_switch spa_');
      } else {
        await this.sendText(from, `I couldn't find a business matching "${text.trim().slice(0, 30)}". 🤔\n\nTry sending the exact *business code*, or type *switch* followed by a name.\n\nType *help* for more options.`);
      }
      return;
    }

    // Check session expiry — clean up and let user start fresh
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      await this.sendText(from, 'Your previous session has expired. Send *Hi* to start again. 🙏');
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

    // ── Escape hatches (hardcoded, never overridable) ──
    const step = session.current_step;
    const isChatMode = step === 'chat_handoff' || step === 'chat_start';
    const isBookingMgmt = step === 'my_bookings' || step === 'modify_booking';
    const isEscapeHatch = ESCAPE_HATCH_PATTERNS.some(p => p.test(text.trim()));
    if (isEscapeHatch && (session.business_id || isBookingMgmt) && !isChatMode) {
      this.intelligence.resetAbuse(from);
      await this.deactivateSession(session.id);
      await this.sendText(from, 'Action cancelled. Send *Hi* to start fresh. 🙏');
      return;
    }

    // ── Unified keyword matching (replaces detectIntent + old keyword + quick reply checks) ──
    // Only fire on non-free-text steps
    const isFreeTextStepForKeywords = isChatMode || ['collect_name', 'collect_other_name', 'collect_email', 'special_requests', 'review_text', 'enter_amount', 'collect_address', 'queue_collect_name', 'select_business_suggestion', 'enter_referral_code', 'collect_pickup_address', 'collect_dropoff_address', 'collect_package_description', 'collect_venue', 'enter_promo_code'].includes(step);

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
              .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, is_whitelabel')
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
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code')
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
      const restartMatch = /^(restart|start\s*over|end\s*chat|exit\s*chat|close\s*chat|stop\s*chat|hi|hello|menu)$/i.test(text);
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
                     <blockquote style="border-left: 3px solid #6C2BD9; padding-left: 12px; color: #333;">${text}</blockquote>
                     <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'}/dashboard/chat" style="color: #6C2BD9; font-weight: bold;">Reply in your dashboard</a></p>
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
                       <blockquote style="border-left: 3px solid #6C2BD9; padding-left: 12px; color: #333;">${text}</blockquote>
                       <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'}/dashboard/chat" style="color: #6C2BD9; font-weight: bold;">Reply in your dashboard</a></p>
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

  // ── Bot code detection ────────────────────────────────

  private async detectBotCode(text: string): Promise<string | null> {
    const result = await this.detectBotCodeWithSuggestions(text);
    return result.businessId;
  }

  /**
   * Enhanced bot code detection with multiple matching strategies:
   * 1. Exact match (case-insensitive)
   * 2. Spaces-to-hyphens ("citadel of grace" → "citadel-of-grace")
   * 3. Hyphenated token extraction
   * 4. Filler/pidgin word stripping
   * 5. Acronym detection ("COG" → "Citadel-Of-Grace")
   * 6. Typo tolerance (Levenshtein distance)
   * 7. Phonetic matching (Soundex — "sitadel" → "citadel")
   * 8. Partial name/code search with popularity ranking
   * 9. Category browsing ("I need a salon")
   *
   * Returns { businessId } for confident matches, or { suggestions } for fuzzy/partial matches.
   * suggestions include `confidence: 'fuzzy'` to trigger confirmation UI.
   */
  private async detectBotCodeWithSuggestions(text: string, callerPhone?: string): Promise<{
    businessId: string | null;
    suggestions?: { id: string; name: string; bot_code: string }[];
    isCategory?: boolean;
  }> {
    const normalizedText = text.toLowerCase().trim();

    const FILLER_WORDS = new Set([
      // English greetings & pleasantries
      'hi', 'hello', 'hey', 'yo', 'sup', 'hiya', 'howdy',
      'good', 'morning', 'afternoon', 'evening', 'night',
      'please', 'pls', 'plz', 'thanks', 'thank', 'you',
      // English action words
      'book', 'booking', 'reserve', 'reservation', 'table', 'order',
      'i', 'want', 'need', 'would', 'like', 'to', 'a', 'an', 'at', 'the', 'for',
      'can', 'me', 'my', 'get', 'make', 'help', 'pay', 'buy', 'ticket',
      'do', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
      'this', 'that', 'it', 'its', 'with', 'from', 'of', 'on', 'in', 'or', 'and',
      // Nigerian pidgin / informal
      'wan', 'go', 'dey', 'na', 'abeg', 'oga', 'bro', 'sis', 'bros',
      'madam', 'sir', 'dis', 'dat', 'wetin', 'where', 'how', 'una',
      'e', 'o', 'sha', 'sef', 'joor', 'jare', 'abi', 'shey', 'ehen',
      'no', 'nor', 'don', 'just', 'come', 'give', 'take', 'put',
      'find', 'show', 'look', 'see', 'know', 'tell',
      'one', 'some', 'any', 'which', 'what',
      'im', 'dem', 'we', 'us', 'them', 'they', 'he', 'she',
      'pls', 'biko', 'ejoor', 'mehn', 'guy', 'babe',
    ]);

    // ── 1-4. Batch bot code matching (exact, spaces-to-hyphens, tokens, filler-stripped) in ONE query ──
    const spacesToHyphens = normalizedText.replace(/\s+/g, '-');
    const tokens = normalizedText.split(/\s+/);
    const hyphenated = tokens.filter(t => t.includes('-') && /^[a-z0-9-]{2,30}$/.test(t));
    const meaningful = tokens.filter(t => !FILLER_WORDS.has(t) && t.length > 0);

    const codeCandidates = new Set<string>();
    if (/^[a-z0-9-]{2,30}$/.test(normalizedText)) codeCandidates.add(normalizedText);
    if (/^[a-z0-9-]{2,30}$/.test(spacesToHyphens)) codeCandidates.add(spacesToHyphens);
    for (const t of hyphenated) codeCandidates.add(t);
    if (meaningful.length > 0 && meaningful.length <= 6) {
      const joined = meaningful.join('-').replace(/-+/g, '-').slice(0, 30);
      if (/^[a-z0-9-]{2,30}$/.test(joined)) codeCandidates.add(joined);
    }

    if (codeCandidates.size > 0) {
      const orFilter = Array.from(codeCandidates).map(c => `bot_code.ilike.${c}`).join(',');
      const { data } = await this.supabase
        .from('businesses')
        .select('id')
        .eq('status', 'active')
        .or(orFilter)
        .maybeSingle();
      if (data) return { businessId: data.id };
    }

    // Skip advanced matching if the input is just common greetings/filler
    const allFiller = tokens.every(t => FILLER_WORDS.has(t));
    if (allFiller) return { businessId: null };

    // ── Fetch candidate businesses for advanced matching (5-8) ──
    // Grab a broader set of active businesses for local matching algorithms
    const searchWords = meaningful.length > 0 ? meaningful : tokens;
    const nameFilters = searchWords.map(w => `name.ilike.%${sanitizeFilterValue(w)}%`).join(',');
    const codeFilters = searchWords.map(w => `bot_code.ilike.%${sanitizeFilterValue(w)}%`).join(',');

    const { data: candidatePool } = await this.supabase
      .from('businesses')
      .select('id, name, bot_code, country_code, total_bookings, rating_avg')
      .eq('status', 'active')
      .not('bot_code', 'is', null)
      .or(`${nameFilters},${codeFilters}`)
      .limit(20);

    // ── 5. Acronym detection — "COG" → "Citadel-Of-Grace" ──
    if (/^[a-z]{2,6}$/i.test(normalizedText)) {
      // Check against the broader pool first, then a targeted query
      const acronymMatches = (candidatePool || []).filter(b =>
        b.bot_code && isAcronymOf(normalizedText, b.bot_code)
      );
      if (acronymMatches.length === 0) {
        // Wider search — acronym might not match name/code ilike filters
        const { data: allActive } = await this.supabase
          .from('businesses')
          .select('id, name, bot_code, country_code, total_bookings, rating_avg')
          .eq('status', 'active')
          .not('bot_code', 'is', null)
          .limit(100);

        const wideAcronyms = (allActive || []).filter(b =>
          b.bot_code && isAcronymOf(normalizedText, b.bot_code)
        );

        if (wideAcronyms.length === 1) {
          return { businessId: wideAcronyms[0].id };
        }
        if (wideAcronyms.length > 1) {
          return {
            businessId: null,
            suggestions: this.rankSuggestions(wideAcronyms, callerPhone).slice(0, 3),
          };
        }
      } else if (acronymMatches.length === 1) {
        return { businessId: acronymMatches[0].id };
      } else {
        return {
          businessId: null,
          suggestions: this.rankSuggestions(acronymMatches, callerPhone).slice(0, 3),
        };
      }
    }

    // ── 6 & 7. Typo tolerance (Levenshtein) + Phonetic matching (Soundex) ──
    // Compare input against all candidates using edit distance and phonetic matching
    if (candidatePool && candidatePool.length > 0) {
      const inputHyphenated = searchWords.join('-');

      type ScoredMatch = { id: string; name: string; bot_code: string; country_code: string | null; total_bookings: number; rating_avg: number; score: number };
      const scored: ScoredMatch[] = [];

      for (const biz of candidatePool) {
        if (!biz.bot_code) continue;
        const code = biz.bot_code.toLowerCase();

        // Levenshtein against bot_code
        const editDist = matchScore(inputHyphenated, code);

        // Levenshtein against name (hyphenated form)
        const nameHyphenated = biz.name.toLowerCase().replace(/\s+/g, '-');
        const nameDist = matchScore(inputHyphenated, nameHyphenated);

        // Phonetic match against bot_code segments
        const isPhonetic = phoneticMatch(inputHyphenated, code);

        // Phonetic match against name
        const isPhoneticName = phoneticMatch(searchWords.join(' '), biz.name);

        const bestDist = Math.min(editDist, nameDist);

        if (bestDist < Infinity || isPhonetic || isPhoneticName) {
          scored.push({
            ...biz,
            bot_code: biz.bot_code,
            score: bestDist < Infinity ? bestDist : 0.5, // phonetic matches get 0.5 score
          });
        }
      }

      if (scored.length > 0) {
        scored.sort((a, b) => a.score - b.score);
        // If the best match has score 0, it's a direct partial match — auto-route
        if (scored.length === 1 || (scored[0].score <= 1 && scored.length > 1 && scored[1].score > scored[0].score + 1)) {
          // Very confident single best match
          return { businessId: scored[0].id };
        }
        // Return top matches as suggestions
        return {
          businessId: null,
          suggestions: this.rankSuggestions(scored, callerPhone).slice(0, 3),
        };
      }
    }

    // ── 8. Wider partial name/code search (if narrower filters found nothing) ──
    if (!candidatePool || candidatePool.length === 0) {
      // Try each word individually
      for (const word of searchWords) {
        if (word.length < 3) continue;
        const { data: singleWordMatches } = await this.supabase
          .from('businesses')
          .select('id, name, bot_code, country_code, total_bookings, rating_avg')
          .eq('status', 'active')
          .not('bot_code', 'is', null)
          .or(`name.ilike.%${sanitizeFilterValue(word)}%,bot_code.ilike.%${sanitizeFilterValue(word)}%`)
          .limit(5);

        if (singleWordMatches && singleWordMatches.length > 0) {
          if (singleWordMatches.length === 1) {
            return { businessId: singleWordMatches[0].id };
          }
          return {
            businessId: null,
            suggestions: this.rankSuggestions(singleWordMatches, callerPhone).slice(0, 3),
          };
        }
      }

      // ── 6b & 7b. Levenshtein + Soundex against ALL businesses (expensive fallback) ──
      if (searchWords.length <= 4) {
        const { data: allActive } = await this.supabase
          .from('businesses')
          .select('id, name, bot_code, country_code, total_bookings, rating_avg')
          .eq('status', 'active')
          .not('bot_code', 'is', null)
          .limit(100);

        if (allActive && allActive.length > 0) {
          const inputHyphenated = searchWords.join('-');
          const fuzzyHits: { id: string; name: string; bot_code: string; country_code: string | null; total_bookings: number; rating_avg: number; score: number }[] = [];

          for (const biz of allActive) {
            if (!biz.bot_code) continue;
            const code = biz.bot_code.toLowerCase();
            const editDist = matchScore(inputHyphenated, code);
            const nameHyphenated = biz.name.toLowerCase().replace(/\s+/g, '-');
            const nameDist = matchScore(inputHyphenated, nameHyphenated);
            const isPhonetic = phoneticMatch(inputHyphenated, code);
            const isPhoneticName = phoneticMatch(searchWords.join(' '), biz.name);

            const bestDist = Math.min(editDist, nameDist);
            if (bestDist < Infinity || isPhonetic || isPhoneticName) {
              fuzzyHits.push({ ...biz, bot_code: biz.bot_code!, score: bestDist < Infinity ? bestDist : 0.5 });
            }
          }

          if (fuzzyHits.length > 0) {
            fuzzyHits.sort((a, b) => a.score - b.score);
            return {
              businessId: null,
              suggestions: this.rankSuggestions(fuzzyHits, callerPhone).slice(0, 3),
            };
          }
        }
      }
    }

    // ── 9. Category browsing — "I need a salon near me" ──
    const categories = detectCategoryIntent(normalizedText);
    if (categories.length > 0) {
      const catFilter = categories.map(c => `category.eq.${c}`).join(',');
      const { data: catMatches } = await this.supabase
        .from('businesses')
        .select('id, name, bot_code, country_code, total_bookings, rating_avg')
        .eq('status', 'active')
        .not('bot_code', 'is', null)
        .or(catFilter)
        .order('total_bookings', { ascending: false })
        .limit(5);

      if (catMatches && catMatches.length > 0) {
        return {
          businessId: null,
          suggestions: this.rankSuggestions(catMatches, callerPhone).slice(0, 3),
          isCategory: true,
        };
      }
    }

    return { businessId: null };
  }

  /**
   * Rank suggestion results by:
   * 1. Country match (caller's country = business country → boost)
   * 2. Popularity (total_bookings + rating)
   */
  private rankSuggestions(
    businesses: { id: string; name: string; bot_code: string; country_code?: string | null; total_bookings?: number; rating_avg?: number; score?: number }[],
    callerPhone?: string,
  ): { id: string; name: string; bot_code: string }[] {
    const callerCountry = callerPhone ? phoneToCountry(callerPhone) : null;

    const scored = businesses.map(b => {
      let rank = 0;
      // Country match bonus (big boost)
      if (callerCountry && b.country_code && b.country_code.toUpperCase() === callerCountry) {
        rank += 1000;
      }
      // Popularity score
      rank += (b.total_bookings || 0) * 2 + (b.rating_avg || 0) * 50;
      // If there's an existing match score, invert it (lower distance = better)
      if (typeof b.score === 'number' && b.score < Infinity) {
        rank -= b.score * 100;
      }
      return { ...b, rank };
    });

    scored.sort((a, b) => b.rank - a.rank);
    return scored.map(({ id, name, bot_code }) => ({ id, name, bot_code }));
  }

  /**
   * Look up a returning customer's most recent business from past sessions, bookings, and orders.
   * If they've only interacted with one business, auto-route there.
   * If multiple, return the most recent one (they can always "switch" to another).
   */
  private async findReturningCustomerBusiness(phone: string, userId: string | null): Promise<string | null> {
    const result = await this.findReturningCustomerBusinesses(phone, userId);
    // Auto-route to single business or most recent
    if (result.length > 0) return result[0].id;
    return null;
  }

  /**
   * Returns ALL recent businesses for a returning customer, ordered by recency.
   * Used for quick-pick lists when customer has multiple past businesses.
   */
  private async findReturningCustomerBusinesses(phone: string, userId: string | null): Promise<{ id: string; name: string; bot_code: string }[]> {
    // Parallel: past sessions + bookings lookup (independent queries)
    const [{ data: pastSessions }, bookingsResult] = await Promise.all([
      this.supabase
        .from('bot_sessions')
        .select('business_id')
        .eq('whatsapp_number', phone)
        .not('business_id', 'is', null)
        .order('last_active_at', { ascending: false })
        .limit(10),
      userId
        ? this.supabase
            .from('bookings')
            .select('business_id')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(5)
        : Promise.resolve({ data: null }),
    ]);

    const seen = new Set<string>();
    const uniqueBusinessIds: string[] = [];

    if (pastSessions) {
      for (const s of pastSessions) {
        if (s.business_id && !seen.has(s.business_id)) {
          seen.add(s.business_id);
          uniqueBusinessIds.push(s.business_id);
        }
      }
    }

    if (bookingsResult.data) {
      for (const b of bookingsResult.data) {
        if (b.business_id && !seen.has(b.business_id)) {
          seen.add(b.business_id);
          uniqueBusinessIds.push(b.business_id);
        }
      }
    }

    if (uniqueBusinessIds.length === 0) return [];

    // Fetch business details for all unique IDs
    const { data: businesses } = await this.supabase
      .from('businesses')
      .select('id, name, bot_code')
      .in('id', uniqueBusinessIds)
      .eq('status', 'active')
      .not('bot_code', 'is', null);

    if (!businesses || businesses.length === 0) return [];

    // Preserve recency order from uniqueBusinessIds
    const bizMap = new Map(businesses.map(b => [b.id, b]));
    return uniqueBusinessIds
      .map(id => bizMap.get(id))
      .filter((b): b is { id: string; name: string; bot_code: string } => !!b && !!b.bot_code);
  }

  private getFirstStep(flowType: FlowType): string {
    switch (flowType) {
      case 'scheduling': return 'select_service';
      case 'payment': return 'select_category';
      case 'ordering': return 'browse_catalog';
      case 'ticketing': return 'select_event';
      case 'queue': return 'queue_start';
      case 'reservation': return 'select_service';
      default: return 'select_service';
    }
  }

  /**
   * Determine the first step based on capabilities.
   * - Single capability → go directly to that flow's first step
   * - Multiple capabilities → show capability selection menu
   * - Fallback to flow_type if no capabilities loaded
   */
  private getFirstStepFromCapabilities(capabilities: CapabilityId[], flowType: FlowType): string {
    if (capabilities.length === 0) {
      return this.getFirstStep(flowType);
    }

    // Filter to user-facing capabilities only (same filter as select_capability prompt)
    const nonUserFacing = new Set(['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'whatsapp_sign', 'survey', 'poll', 'broadcast', 'recurring', 'auto_reply', 'membership']);
    // If scheduling is present, payment/invoice happen within the booking flow — don't show as separate options
    if (capabilities.includes('scheduling')) {
      nonUserFacing.add('payment');
      nonUserFacing.add('invoice');
    }
    const userFacing = capabilities.filter(c => !nonUserFacing.has(c));

    if (userFacing.length <= 1) {
      return this.capabilityToFirstStep(userFacing[0] || capabilities[0]);
    }

    // Multiple user-facing capabilities — route to capability selection
    return 'select_capability';
  }

  private capabilityToFirstStep(cap: CapabilityId): string {
    switch (cap) {
      case 'appointment': return 'select_appointment';
      case 'scheduling': return 'select_service';
      case 'giving': return 'select_category';
      case 'payment': return 'select_category';
      case 'ordering': return 'browse_catalog';
      case 'ticketing': return 'select_event';
      case 'crowdfunding': return 'select_campaign';
      case 'reminders': return 'select_service'; // reminders piggyback on scheduling
      case 'queue': return 'queue_start';
      case 'reports': return 'select_service'; // reports are dashboard-only, no bot flow
      case 'chat': return 'chat_start';
      case 'waitlist': return 'waitlist_join';
      case 'feedback': return 'select_service'; // feedback is post-completion
      case 'loyalty': return 'loyalty_menu';
      case 'referral': return 'select_service'; // referral is post-completion
      case 'staff': return 'select_service'; // staff enhances scheduling
      default: return 'select_service';
    }
  }

  // ── My Bookings ──────────────────────────────────────

  private async handleMyBookings(session: BotSession, from: string, input: string): Promise<void> {
    if (!input) {
      // Fetch upcoming bookings
      const { data: upcoming } = await this.supabase
        .from('bookings')
        .select('id, date, time, party_size, reference_code, businesses (name)')
        .eq('user_id', session.user_id!)
        .in('status', ['confirmed', 'pending'])
        .gte('date', new Date().toISOString().split('T')[0])
        .order('date', { ascending: true })
        .limit(5);

      // Fetch event tickets (match both +234... and 234... phone formats)
      const phoneWithPlus = from.startsWith('+') ? from : `+${from}`;
      const phoneWithoutPlus = from.startsWith('+') ? from.slice(1) : from;
      const { data: tickets } = await this.supabase
        .from('event_tickets')
        .select('id, ticket_code, guest_name, status, created_at, event:events!event_id(name, date, time, venue)')
        .or(`guest_phone.eq.${sanitizeFilterValue(phoneWithPlus)},guest_phone.eq.${sanitizeFilterValue(phoneWithoutPlus)}`)
        .eq('status', 'valid')
        .order('created_at', { ascending: false })
        .limit(5);

      // Fetch upcoming reservations (stays)
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;
      const { data: reservations } = await this.supabase
        .from('reservations')
        .select('id, check_in, check_out, reference_code, guest_name, status, property_id, businesses:business_id(name)')
        .or(`guest_phone.eq.${sanitizeFilterValue(phoneP)},guest_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .in('status', ['confirmed', 'pending', 'checked_in'])
        .gte('check_out', new Date().toISOString().split('T')[0])
        .order('check_in', { ascending: true })
        .limit(5);

      const items: { title: string; description: string; postbackText: string }[] = [];

      if (upcoming) {
        for (const r of upcoming) {
          const biz = r.businesses as unknown as { name: string } | null;
          const dateLabel = new Date(r.date + 'T00:00').toLocaleDateString('en-US', {
            weekday: 'short', day: 'numeric', month: 'short',
          });
          items.push({
            title: biz?.name || 'Business',
            description: `${dateLabel} at ${r.time} • ${r.party_size} guests`,
            postbackText: `booking_${r.id}`,
          });
        }
      }

      if (tickets) {
        for (const t of tickets) {
          const evt = t.event as unknown as { name: string; date: string; time?: string; venue?: string } | null;
          const dateLabel = evt?.date
            ? new Date(evt.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
            : '';
          items.push({
            title: evt?.name || 'Event',
            description: `${dateLabel} • Ticket: ${t.ticket_code}`,
            postbackText: `ticket_${t.id}`,
          });
        }
      }

      if (reservations && reservations.length > 0) {
        for (const r of reservations) {
          const biz = r.businesses as unknown as { name: string } | null;
          const checkIn = new Date(r.check_in + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
          const checkOut = new Date(r.check_out + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
          items.push({
            title: biz?.name || 'Stay',
            description: `${checkIn} → ${checkOut} • Ref: ${r.reference_code}`,
            postbackText: `reservation_${r.id}`,
          });
        }
      }

      if (items.length === 0) {
        await this.sendText(from, "You don't have any upcoming bookings, tickets, or stays. Send *Hi* to get started!");
        await this.deactivateSession(session.id);
        return;
      }

      await this.messageSender.sendList({
        to: from,
        title: 'Your Bookings & Tickets',
        body: 'Select a booking, ticket, or stay to view:',
        buttonLabel: 'View All',
        items,
      });
      return;
    }

    if (input.startsWith('booking_')) {
      const bookingId = input.replace('booking_', '');
      session.session_data.selected_booking_id = bookingId;
      await this.supabase.from('bot_sessions').update({
        current_step: 'modify_booking',
        session_data: session.session_data,
      }).eq('id', session.id);
      await this.handleModifyBooking(session, from, '');
      return;
    }

    if (input.startsWith('ticket_')) {
      const ticketId = input.replace('ticket_', '');
      await this.handleViewTicket(session, from, ticketId);
      return;
    }

    if (input.startsWith('reservation_')) {
      const reservationId = input.replace('reservation_', '');
      await this.handleViewReservation(session, from, reservationId);
      return;
    }

    // Back button from detail views — re-show bookings list
    if (input === 'back_bookings') {
      await this.handleMyBookings(session, from, '');
      return;
    }

    // Receipt button from detail views
    if (input === 'get_receipt') {
      await this.handleTransactionDocument(from, session.user_id!, 'receipt');
      return;
    }
  }

  private async handleViewTicket(session: BotSession, from: string, ticketId: string): Promise<void> {
    const { data: ticket } = await this.supabase
      .from('event_tickets')
      .select('id, ticket_code, guest_name, status, scanned_at, created_at, event:events!event_id(name, date, time, venue)')
      .eq('id', ticketId)
      .single();

    if (!ticket) {
      await this.sendText(from, 'Ticket not found. Send *my bookings* to try again.');
      return;
    }

    const evt = ticket.event as unknown as { name: string; date: string; time?: string; venue?: string } | null;
    const dateLabel = evt?.date
      ? new Date(evt.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })
      : 'TBD';

    const statusLabel = ticket.status === 'used' ? 'Used' : ticket.status === 'cancelled' ? 'Cancelled' : 'Valid';

    await this.sendText(from, [
      `*Event Ticket*`,
      '',
      `*${evt?.name || 'Event'}*`,
      `${dateLabel}${evt?.time ? ` at ${evt.time}` : ''}`,
      evt?.venue ? `${evt.venue}` : '',
      `Ticket: *${ticket.ticket_code}*`,
      `${ticket.guest_name || 'Guest'}`,
      `Status: ${statusLabel}`,
    ].filter(Boolean).join('\n'));

    await this.messageSender.sendButtons({
      to: from,
      body: 'What would you like to do?',
      buttons: [
        { id: 'back_bookings', title: 'Back to Bookings' },
        { id: 'get_receipt', title: 'Get Receipt' },
      ],
    });
  }

  private async handleViewReservation(_session: BotSession, from: string, reservationId: string): Promise<void> {
    const { data: reservation } = await this.supabase
      .from('reservations')
      .select('id, check_in, check_out, reference_code, guest_name, guests, total_amount, status, businesses:business_id(name, country_code)')
      .eq('id', reservationId)
      .single();

    if (!reservation) {
      await this.sendText(from, 'Reservation not found. Send *my bookings* to try again.');
      return;
    }

    const biz = reservation.businesses as unknown as { name: string; country_code?: string } | null;
    const checkIn = new Date(reservation.check_in + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
    const checkOut = new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
    const statusMap: Record<string, string> = {
      confirmed: '✅ Confirmed',
      pending: '⏳ Pending',
      checked_in: '🏠 Checked In',
      checked_out: '✅ Checked Out',
      cancelled: '❌ Cancelled',
    };
    const statusLabel = statusMap[reservation.status] || reservation.status;

    const currencySymbol = biz?.country_code === 'US' ? '$' : biz?.country_code === 'GB' ? '£' : '₦';

    await this.sendText(from, [
      `*Reservation Details*`,
      '',
      `*${biz?.name || 'Property'}*`,
      `Check-in: ${checkIn}`,
      `Check-out: ${checkOut}`,
      reservation.guests ? `${reservation.guests} guest(s)` : '',
      reservation.total_amount ? `${currencySymbol}${Number(reservation.total_amount).toLocaleString()}` : '',
      `${reservation.guest_name || 'Guest'}`,
      `Ref: *${reservation.reference_code}*`,
      `Status: ${statusLabel}`,
    ].filter(Boolean).join('\n'));

    await this.messageSender.sendButtons({
      to: from,
      body: 'What would you like to do?',
      buttons: [
        { id: 'back_bookings', title: 'Back to Bookings' },
        { id: 'get_receipt', title: 'Get Receipt' },
      ],
    });
  }

  private async handleModifyBooking(session: BotSession, from: string, input: string): Promise<void> {
    const bookingId = session.session_data.selected_booking_id as string;

    if (!bookingId) {
      await this.sendText(from, 'Something went wrong. Send *my bookings* to try again.');
      await this.deactivateSession(session.id);
      return;
    }

    if (!input) {
      const { data: booking } = await this.supabase
        .from('bookings')
        .select('id, date, time, party_size, reference_code, business_id, businesses (name)')
        .eq('id', bookingId)
        .single();

      if (!booking) {
        await this.sendText(from, 'Booking not found. Send *my bookings* to try again.');
        await this.deactivateSession(session.id);
        return;
      }

      const biz = booking.businesses as unknown as { name: string } | null;
      const dateLabel = new Date(booking.date + 'T00:00').toLocaleDateString('en-US', {
        weekday: 'long', day: 'numeric', month: 'long',
      });

      await this.sendText(from, [
        `📋 *${biz?.name || 'Business'}*`,
        `📅 ${dateLabel} at ${booking.time}`,
        `👥 ${booking.party_size} guests`,
        `🔑 Ref: *${booking.reference_code}*`,
      ].join('\n'));

      await this.messageSender.sendButtons({
        to: from,
        body: 'What would you like to do?',
        buttons: [
          { id: 'reschedule_booking', title: 'Reschedule' },
          { id: 'cancel_booking', title: 'Cancel Booking' },
          { id: 'back_bookings', title: 'Back' },
        ],
      });
      return;
    }

    const response = input.toLowerCase();

    if (response === 'cancel' || response === 'exit' || response === 'quit') {
      await this.sendText(from, 'Action cancelled. Send *Hi* to start fresh. 🙏');
      await this.deactivateSession(session.id);
      return;
    }

    if (response === 'back_bookings') {
      await this.supabase.from('bot_sessions').update({ current_step: 'my_bookings' }).eq('id', session.id);
      await this.handleMyBookings(session, from, '');
      return;
    }

    if (response === 'cancel_booking') {
      // Fetch booking details before cancelling (for staff notification)
      const { data: cancelledBooking } = await this.supabase
        .from('bookings')
        .select('id, staff_id, guest_name, date, time, reference_code, business_id, service_id, services:service_id(name)')
        .eq('id', bookingId)
        .single();

      await this.supabase
        .from('bookings')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'diner' })
        .eq('id', bookingId);

      // Notify assigned staff member about cancellation
      if (cancelledBooking?.staff_id && cancelledBooking.business_id) {
        import('./flows/shared/notify-staff').then(({ notifyStaffBookingCancelled }) => {
          const dateLabel = new Date(cancelledBooking.date + 'T00:00').toLocaleDateString('en-US', {
            weekday: 'long', day: 'numeric', month: 'long',
          });
          notifyStaffBookingCancelled({
            supabase: this.supabase,
            sender: this.messageSender,
            businessId: cancelledBooking.business_id,
            staffId: cancelledBooking.staff_id!,
            customerName: cancelledBooking.guest_name || 'Customer',
            serviceName: ((cancelledBooking as any).services as { name: string } | null)?.name || '',
            date: dateLabel,
            time: cancelledBooking.time || '',
            referenceCode: cancelledBooking.reference_code || '',
          }).catch(err => console.error('[BOT] Staff cancel notify error:', err));
        }).catch(() => {});
      }

      await this.sendText(from, '✓ Cancelled.\n\nSend *Hi* to start fresh or *my bookings* to manage others.');
      await this.deactivateSession(session.id);
      return;
    }

    if (response === 'reschedule_booking') {
      // Fetch booking details to populate session for rescheduling
      const { data: booking } = await this.supabase
        .from('bookings')
        .select('id, business_id, service_id, party_size, services (id, name, price, deposit_amount)')
        .eq('id', bookingId)
        .single();

      if (!booking || !booking.business_id) {
        await this.sendText(from, 'Could not load booking details. Send *my bookings* to try again.');
        await this.deactivateSession(session.id);
        return;
      }

      const { data: biz } = await this.supabase
        .from('businesses')
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code')
        .eq('id', booking.business_id)
        .single();

      if (!biz) {
        await this.sendText(from, 'Business not found. Send *Hi* to start over.');
        await this.deactivateSession(session.id);
        return;
      }

      const svc = booking.services as unknown as { id: string; name: string; price: number; deposit_amount: number } | null;

      // Update session to restart scheduling from date selection
      const sessionData: Record<string, unknown> = {
        ...session.session_data,
        _reschedule_booking_id: bookingId,
        active_capability: 'scheduling',
        party_size: booking.party_size || 1,
      };
      if (svc) {
        sessionData.service_id = svc.id;
        sessionData.service_name = svc.name;
        sessionData.service_price = svc.price || 0;
        sessionData.service_deposit = svc.deposit_amount || 0;
        sessionData.skip_service = true;
      }

      await this.supabase.from('bot_sessions').update({
        current_step: 'select_date',
        session_data: sessionData,
        business_id: biz.id,
      }).eq('id', session.id);

      session.session_data = sessionData;
      session.current_step = 'select_date';
      session.business_id = biz.id;

      await this.sendText(from, "Let's pick a new date and time for your booking.");
      await this.flowExecutor.execute(from, '', session as unknown as BotSession, biz as BusinessRecord | null);
      return;
    }

    await this.sendText(from, 'Please tap one of the options above.');
  }

  // ── My Orders ──────────────────────────────────────

  private formatOrderStatus(status: string): { emoji: string; label: string } {
    const map: Record<string, { emoji: string; label: string }> = {
      pending: { emoji: '🕐', label: 'Pending' },
      confirmed: { emoji: '✅', label: 'Confirmed' },
      processing: { emoji: '🔄', label: 'Processing' },
      ready: { emoji: '📦', label: 'Ready for pickup' },
      shipped: { emoji: '🚚', label: 'Shipped' },
      delivered: { emoji: '✅', label: 'Delivered' },
      cancelled: { emoji: '❌', label: 'Cancelled' },
    };
    return map[status] || { emoji: '📋', label: status };
  }

  private buildOrderProgressBar(status: string): string {
    const stages = ['confirmed', 'processing', 'ready', 'delivered'];
    const stageLabels: Record<string, string> = {
      confirmed: 'Confirmed',
      processing: 'Processing',
      ready: 'Ready for pickup',
      delivered: 'Delivered',
    };
    const stageEmojis: Record<string, { done: string; current: string; pending: string }> = {
      confirmed: { done: '✅', current: '✅', pending: '⬜' },
      processing: { done: '✅', current: '🔄', pending: '⬜' },
      ready: { done: '✅', current: '📦', pending: '⬜' },
      delivered: { done: '✅', current: '✅', pending: '⬜' },
    };

    // If pending, nothing is done yet
    const normalizedStatus = status === 'pending' ? 'pending' : status;
    const currentIndex = stages.indexOf(normalizedStatus);

    const lines: string[] = [];
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const emojis = stageEmojis[stage];
      let icon: string;
      let marker = '';
      if (currentIndex < 0) {
        // pending — nothing started
        icon = emojis.pending;
      } else if (i < currentIndex) {
        icon = emojis.done;
      } else if (i === currentIndex) {
        icon = emojis.current;
        marker = '  ← You are here';
      } else {
        icon = emojis.pending;
      }
      lines.push(`${icon} ${stageLabels[stage]}${marker}`);
    }
    return lines.join('\n');
  }

  private async handleMyOrders(session: BotSession, from: string, input: string): Promise<void> {
    if (!input) {
      const { data: orders } = await this.supabase
        .from('orders')
        .select('id, reference_code, status, total_amount, created_at, businesses (name, country_code)')
        .eq('user_id', session.user_id!)
        .in('status', ['pending', 'confirmed', 'processing', 'ready', 'shipped'])
        .order('created_at', { ascending: false })
        .limit(10);

      if (!orders || orders.length === 0) {
        await this.sendText(from, "You don't have any active orders. Send *Hi* to place an order!");
        await this.deactivateSession(session.id);
        return;
      }

      if (orders.length <= 3) {
        // Show as buttons
        const firstOrder = orders[0];
        const biz = firstOrder.businesses as unknown as { name: string; country_code?: CountryCode } | null;
        const cc = (biz?.country_code as CountryCode) || 'NG';
        const { emoji } = this.formatOrderStatus(firstOrder.status);

        const lines = orders.map((o) => {
          const b = o.businesses as unknown as { name: string; country_code?: CountryCode } | null;
          const occ = (b?.country_code as CountryCode) || 'NG';
          const { emoji: e, label } = this.formatOrderStatus(o.status);
          const dateLabel = new Date(o.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
          return `${e} *${o.reference_code}* — ${label}\n   ${b?.name || 'Order'} • ${dateLabel} • ${formatCurrency(o.total_amount || 0, occ)}`;
        });

        await this.sendText(from, `📦 *Your Orders*\n\n${lines.join('\n\n')}`);

        await this.messageSender.sendButtons({
          to: from,
          body: 'Select an order to view details:',
          buttons: orders.slice(0, 3).map((o, i) => ({
            id: `order_${o.id}`,
            title: `${o.reference_code}`.slice(0, 20),
          })),
        });
      } else {
        // Show as list
        const items = orders.map((o) => {
          const b = o.businesses as unknown as { name: string; country_code?: CountryCode } | null;
          const occ = (b?.country_code as CountryCode) || 'NG';
          const { label } = this.formatOrderStatus(o.status);
          const dateLabel = new Date(o.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
          return {
            title: `${o.reference_code}`.slice(0, 24),
            description: `${label} • ${b?.name || 'Order'} • ${formatCurrency(o.total_amount || 0, occ)}`.slice(0, 72),
            postbackText: `order_${o.id}`,
          };
        });

        await this.messageSender.sendList({
          to: from,
          title: 'Your Orders',
          body: '📦 Select an order to view details:',
          buttonLabel: 'View Orders',
          items,
        });
      }
      return;
    }

    // Handle order selection
    if (input.startsWith('order_')) {
      const orderId = input.replace('order_', '');
      session.session_data.selected_order_id = orderId;
      await this.supabase.from('bot_sessions').update({
        current_step: 'order_detail',
        session_data: session.session_data,
      }).eq('id', session.id);
      await this.handleOrderDetail(session, from, orderId);
      return;
    }

    // Handle "track_my_order" postback from ordering flow
    if (input === 'track_my_order') {
      // Re-show the orders list
      await this.handleMyOrders(session, from, '');
      return;
    }
  }

  private async handleOrderDetail(session: BotSession, from: string, orderId: string): Promise<void> {
    const { data: order } = await this.supabase
      .from('orders')
      .select('id, reference_code, status, total_amount, created_at, shipping_cost, delivery_address, tracking_number, carrier, updated_at, businesses (name, country_code)')
      .eq('id', orderId)
      .single();

    if (!order) {
      await this.sendText(from, 'Order not found. Type *my orders* to see your orders.');
      await this.deactivateSession(session.id);
      return;
    }

    const biz = order.businesses as unknown as { name: string; country_code?: CountryCode } | null;
    const cc = (biz?.country_code as CountryCode) || 'NG';
    const { emoji, label } = this.formatOrderStatus(order.status);
    const dateLabel = new Date(order.created_at).toLocaleDateString('en-US', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

    const progressBar = this.buildOrderProgressBar(order.status);

    const lines: string[] = [
      `📦 *Order #${order.reference_code}*`,
      `🏪 ${biz?.name || 'Business'}`,
      `📅 ${dateLabel}`,
      '',
      `Status: ${emoji} *${label}*`,
      '━━━━━━━━━━━━━━━━━',
      progressBar,
      '',
      `Total: ${formatCurrency(order.total_amount || 0, cc)}`,
    ];

    if (order.delivery_address) {
      lines.push(`📍 ${order.delivery_address}`);
    }

    // Show tracking info if available
    if (order.tracking_number || order.carrier) {
      lines.push('');
      lines.push('🚚 *Tracking Info*');
      if (order.carrier) lines.push(`Carrier: ${order.carrier}`);
      if (order.tracking_number) lines.push(`Tracking #: ${order.tracking_number}`);
    }

    if (order.updated_at) {
      const updatedLabel = new Date(order.updated_at).toLocaleDateString('en-US', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      });
      lines.push(`\n_Last updated: ${updatedLabel}_`);
    }

    await this.sendText(from, lines.join('\n'));

    const buttons: Array<{ id: string; title: string }> = [];
    if (['pending', 'confirmed', 'processing', 'ready', 'shipped'].includes(order.status)) {
      buttons.push({ id: 'refresh_order', title: 'Refresh Status' });
    }
    buttons.push({ id: 'back_orders', title: 'Back to Orders' });

    await this.messageSender.sendButtons({
      to: from,
      body: 'What would you like to do?',
      buttons,
    });
  }

  private async handleOrderDetailAction(session: BotSession, from: string, input: string): Promise<void> {
    const orderId = session.session_data.selected_order_id as string;

    if (!orderId) {
      await this.sendText(from, 'Something went wrong. Type *my orders* to try again.');
      await this.deactivateSession(session.id);
      return;
    }

    const response = input.toLowerCase();

    if (response === 'cancel' || response === 'exit' || response === 'quit') {
      await this.sendText(from, 'Action cancelled. Send *Hi* to start fresh. 🙏');
      await this.deactivateSession(session.id);
      return;
    }

    if (response === 'back_orders') {
      await this.supabase.from('bot_sessions').update({ current_step: 'my_orders' }).eq('id', session.id);
      await this.handleMyOrders(session, from, '');
      return;
    }

    if (response === 'refresh_order') {
      await this.handleOrderDetail(session, from, orderId);
      return;
    }

    await this.sendText(from, 'Please tap one of the options above.');
  }

  // ── Transaction Document Handler ──────────────────────────

  private async handleTransactionDocument(from: string, userId: string, type: 'history' | 'receipt' | 'annual'): Promise<void> {
    const labelMap = { history: 'transaction history', receipt: 'receipt', annual: 'annual statement' };
    const label = labelMap[type];
    await this.sendText(from, `Generating your ${label}... 📄`);

    try {
      // Try PDF first, fall back to text receipt
      let pdfSent = false;
      try {
        const { generateDocumentDirect } = await import('@/lib/receipts/generate-direct');
        const result = await generateDocumentDirect(userId, type, from);
        if (result) {
          await this.messageSender.sendDocument({
            to: from,
            documentUrl: result.url,
            filename: result.filename,
            caption: type === 'history' ? 'Your transaction history' : type === 'annual' ? 'Your annual statement' : 'Your latest receipt',
          });
          pdfSent = true;
        }
      } catch (pdfErr) {
        logger.error('[BOT] PDF receipt failed, falling back to text:', pdfErr);
      }

      // Fallback: send a text receipt with recent transaction details
      if (!pdfSent) {
        const textReceipt = await this.buildTextReceipt(userId, from, type);
        if (textReceipt) {
          await this.sendText(from, textReceipt);
        } else {
          await this.sendText(from, `No transactions found. Make a booking first, then come back for your ${label}!`);
        }
      }
    } catch (err) {
      logger.error('[BOT] handleTransactionDocument error:', err);
      await this.sendText(from, `Sorry, I couldn't generate your ${label} right now. Please try again later.`);
    }
  }

  // ── Text Receipt Builder (fallback when PDF fails) ──────
  private async buildTextReceipt(userId: string, phone: string, type: string): Promise<string | null> {
    const phoneP = phone.startsWith('+') ? phone : `+${phone}`;
    const phoneN = phone.startsWith('+') ? phone.slice(1) : phone;

    // Fetch recent transactions from multiple sources
    const [{ data: bookings }, { data: payments }, { data: invoices }, { data: donations }] = await Promise.all([
      this.supabase.from('bookings')
        .select('reference_code, date, total_amount, status, created_at, services(name), businesses(name, country_code)')
        .eq('user_id', userId)
        .in('status', ['completed', 'confirmed', 'pending'])
        .order('created_at', { ascending: false }).limit(5),
      this.supabase.from('payments')
        .select('gateway_reference, amount, status, created_at, businesses:business_id(name, country_code)')
        .eq('user_id', userId).eq('status', 'success')
        .order('created_at', { ascending: false }).limit(5),
      this.supabase.from('invoices')
        .select('invoice_number, total_amount, status, paid_at, businesses:business_id(name)')
        .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .eq('status', 'paid')
        .order('paid_at', { ascending: false }).limit(3),
      this.supabase.from('campaign_donations')
        .select('amount, reference_code, created_at, campaigns:campaign_id(name), businesses:business_id(name)')
        .or(`donor_phone.eq.${sanitizeFilterValue(phoneP)},donor_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .eq('status', 'success')
        .order('created_at', { ascending: false }).limit(3),
    ]);

    const lines: string[] = [];

    if (bookings && bookings.length > 0) {
      const b = bookings[0];
      const biz = b.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = b.services as unknown as { name: string } | null;
      const cc = biz?.country_code as CountryCode || 'NG';
      const dateStr = new Date(b.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

      lines.push(
        '*Receipt*',
        '',
        `Business: *${biz?.name || 'Business'}*`,
        `Service: ${svc?.name || b.reference_code || 'Service'}`,
        `Date: ${dateStr}`,
        `Amount: ${formatCurrency(b.total_amount || 0, cc)}`,
        `Ref: *${b.reference_code}*`,
        `Status: ${b.status}`,
      );
    } else if (payments && payments.length > 0) {
      const p = payments[0];
      const biz = p.businesses as unknown as { name: string; country_code?: string } | null;
      const cc = biz?.country_code as CountryCode || 'NG';
      const dateStr = new Date(p.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

      lines.push(
        '*Receipt*',
        '',
        `Business: *${biz?.name || 'Business'}*`,
        `Date: ${dateStr}`,
        `Amount: ${formatCurrency(p.amount || 0, cc)}`,
        `Ref: *${p.gateway_reference}*`,
        `Status: Paid`,
      );
    } else if (donations && donations.length > 0) {
      const d = donations[0];
      const biz = d.businesses as unknown as { name: string } | null;
      const campaign = d.campaigns as unknown as { name: string } | null;
      const dateStr = new Date(d.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

      lines.push(
        '*Donation Receipt*',
        '',
        `Organization: *${biz?.name || 'Organization'}*`,
        `Campaign: ${campaign?.name || 'Donation'}`,
        `Date: ${dateStr}`,
        `Amount: ${Number(d.amount).toLocaleString()}`,
        `Ref: *${d.reference_code}*`,
      );
    } else if (invoices && invoices.length > 0) {
      const inv = invoices[0];
      const biz = inv.businesses as unknown as { name: string } | null;
      const dateStr = inv.paid_at ? new Date(inv.paid_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

      lines.push(
        '*Invoice Receipt*',
        '',
        `Business: *${biz?.name || 'Business'}*`,
        `Invoice: ${inv.invoice_number}`,
        `Paid: ${dateStr}`,
        `Amount: ${Number(inv.total_amount).toLocaleString()}`,
      );
    }

    if (lines.length === 0) return null;

    lines.push('', 'Type *Hi* to continue');
    return lines.join('\n');
  }

  // ── Quote Response Handler ──────────────────────────────

  private async handleQuoteResponse(from: string, quoteId: string, action: 'accept' | 'reject'): Promise<void> {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

      if (!baseUrl) {
        await this.sendText(from, 'Sorry, something went wrong. Please try again.');
        return;
      }

      const response = await fetch(`${baseUrl}/api/orders/quote-accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quote_id: quoteId, action }),
      });

      const result = await response.json();

      if (!response.ok) {
        await this.sendText(from, result.error || 'Something went wrong. Please try again.');
        return;
      }

      if (action === 'reject') {
        await this.sendText(from, 'Price declined. Thank you for considering!');
      }
      // Accept case: payment link is sent by the API route itself
    } catch (err) {
      logger.error('[BOT] Quote response error:', err);
      await this.sendText(from, 'Sorry, something went wrong. Please try again.');
    }
  }

  // ── Ticket Check-in via WhatsApp ──────────────────────

  private async handleTicketCheckin(from: string, ticketCode: string): Promise<void> {
    try {
      const { data: ticket } = await this.supabase
        .from('event_tickets')
        .select('id, status, scanned_at, scanned_by, guest_name, guest_phone, event:events!event_id(name, date, time, self_checkin_enabled, business_id)')
        .eq('ticket_code', ticketCode)
        .single();

      if (!ticket) {
        await this.sendText(from, `❌ Ticket *${ticketCode}* not found. Please check the code and try again.`);
        return;
      }

      const event = ticket.event as any;

      // Check self check-in is enabled
      if (!event?.self_checkin_enabled) {
        await this.sendText(from, `🎟️ Ticket *${ticketCode}* for *${event?.name || 'event'}* is valid.\n\nSelf check-in is not enabled for this event. Please check in at the entrance.`);
        return;
      }

      // Already used
      if (ticket.status === 'used') {
        const scannedTime = ticket.scanned_at
          ? new Date(ticket.scanned_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          : '';
        await this.sendText(from, `⚠️ Ticket *${ticketCode}* was already checked in${scannedTime ? ` at ${scannedTime}` : ''}${ticket.scanned_by && ticket.scanned_by !== 'self' ? ` by ${ticket.scanned_by}` : ''}.`);
        return;
      }

      if (ticket.status === 'cancelled') {
        await this.sendText(from, `❌ Ticket *${ticketCode}* has been cancelled.`);
        return;
      }

      // Event day check
      if (event?.date) {
        const eventDate = new Date(event.date + 'T00:00:00');
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const eventDay = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
        const bufferMs = 60 * 60 * 1000;

        let earliestCheckin = eventDay;
        if (event.time) {
          const [h, m] = event.time.split(':').map(Number);
          earliestCheckin = new Date(eventDay.getTime() + h * 3600000 + m * 60000 - bufferMs);
        }

        const latestCheckin = new Date(eventDay.getTime() + 24 * 60 * 60 * 1000);

        if (now < earliestCheckin) {
          await this.sendText(from, `⏰ Check-in for *${event.name}* is not open yet.\n\nIt opens on ${eventDate.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}.`);
          return;
        }

        if (now > latestCheckin) {
          await this.sendText(from, `⏰ Check-in for *${event.name}* has closed.`);
          return;
        }
      }

      // Verify phone matches ticket owner (fraud prevention)
      const phone = from.startsWith('+') ? from : `+${from}`;
      const ticketPhone = ticket.guest_phone || '';
      if (ticketPhone && !ticketPhone.includes(from) && !phone.includes(ticketPhone.replace('+', ''))) {
        // Phone doesn't match — still allow but mark as different phone
        await this.supabase.from('event_tickets').update({
          status: 'used',
          scanned_at: new Date().toISOString(),
          scanned_by: `whatsapp:${from}`,
        }).eq('id', ticket.id);
      } else {
        await this.supabase.from('event_tickets').update({
          status: 'used',
          scanned_at: new Date().toISOString(),
          scanned_by: 'self',
        }).eq('id', ticket.id);
      }

      await this.sendText(from, [
        `✅ *Checked In!*`,
        '',
        `🎪 ${event?.name || 'Event'}`,
        `🎟️ Ticket: *${ticketCode}*`,
        `👤 ${ticket.guest_name || 'Guest'}`,
        '',
        `Welcome! Enjoy the event.`,
      ].join('\n'));
    } catch (err) {
      logger.error('[BOT] Ticket check-in error:', err);
      await this.sendText(from, 'Sorry, something went wrong verifying your ticket. Please try again or check in at the entrance.');
    }
  }

  // ── Unified Keyword Action Executor ──────────────────────

  /**
   * Execute the action from a unified keyword match.
   * Returns true if the action was handled, false to continue to flow executor.
   */
  private async executeKeywordAction(
    from: string,
    session: BotSession,
    kw: UnifiedKeyword,
  ): Promise<boolean> {
    const payload = parseKeywordPayload(kw.payload);
    const step = session.current_step;

    try {
      switch (kw.action_type) {
        case 'reply': {
          const message = (payload.message as string) || kw.payload;
          await this.sendText(from, message);
          return true;
        }

        case 'acknowledge': {
          const message = (payload.message as string) || "You're welcome! Is there anything else I can help with?";
          this.intelligence.resetAbuse(from);
          await this.sendText(from, message);
          return true;
        }

        case 'show_menu': {
          const menuType = payload.message as string;
          if (menuType === 'greeting') {
            // Treat as restart — deactivate and re-greet
            await this.deactivateSession(session.id);
            return false; // Let the restart logic handle it
          }
          // Generic menu — show help
          const isStandalone = !!session.business_id;
          const businessName = session.session_data.business_name as string | undefined;
          let alias: string | null = null;
          if (isStandalone && session.business_id) {
            alias = await this.standaloneService.getBotAlias(session.business_id);
          }
          await this.sendText(from, this.intelligence.getHelpText(isStandalone, businessName, alias || undefined));
          return true;
        }

        case 'navigate_step': {
          const action = payload.action as string;
          this.intelligence.resetAbuse(from);

          if (action === 'show_status' || action === 'show_history') {
            // Bookings / history
            await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
            const phoneP = from.startsWith('+') ? from : `+${from}`;
            const phoneN = from.startsWith('+') ? from.slice(1) : from;
            const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`).limit(1).maybeSingle();
            if (!profile?.id) {
              await this.sendText(from, "I don't have an account for this number. Send *Hi* to get started!");
              return true;
            }
            if (action === 'show_history') {
              await this.handleTransactionDocument(from, profile.id, 'history');
              return true;
            }
            // show_status → my_bookings
            const { data: newSession } = await this.supabase.from('bot_sessions').insert({
              whatsapp_number: from, user_id: profile.id, business_id: null,
              current_step: 'my_bookings', session_data: {}, is_active: true,
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            }).select().single();
            if (!newSession) { await this.sendText(from, 'Something went wrong.'); return true; }
            await this.handleMyBookings(newSession as BotSession, from, '');
            return true;
          }

          if (action === 'show_receipt') {
            await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
            const phoneP = from.startsWith('+') ? from : `+${from}`;
            const phoneN = from.startsWith('+') ? from.slice(1) : from;
            const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`).limit(1).maybeSingle();
            if (!profile?.id) {
              await this.sendText(from, "I don't have an account for this number. Send *Hi* to get started!");
              return true;
            }
            await this.handleTransactionDocument(from, profile.id, 'receipt');
            return true;
          }

          if (action === 'show_pricing') {
            await this.sendText(from, 'Pricing varies by service. Start a booking to see current prices!');
            const nudge = this.intelligence.getContextualHelp(step);
            await this.sendText(from, nudge);
            return true;
          }

          if (action === 'escalate') {
            if (session.business_id) {
              const caps = (session.session_data?.capabilities as CapabilityId[]) || await getEnabledCapabilities(this.supabase, session.business_id);
              if (caps.includes('chat')) {
                const escPhoneP = from.startsWith('+') ? from : `+${from}`;
                const escPhoneN = from.startsWith('+') ? from.slice(1) : from;
                let escCustomerName: string | null = null;
                const { data: escProfile } = await this.supabase
                  .from('profiles')
                  .select('first_name, last_name')
                  .or(`phone.eq.${sanitizeFilterValue(escPhoneP)},phone.eq.${sanitizeFilterValue(escPhoneN)}`)
                  .limit(1)
                  .maybeSingle();
                if (escProfile?.first_name) {
                  escCustomerName = `${escProfile.first_name}${escProfile.last_name ? ' ' + escProfile.last_name : ''}`;
                }
                const businessName = (session.session_data.business_name as string) || 'the business';
                const { escalateToHuman } = await import('@/lib/bot/handoff.service');
                await escalateToHuman({
                  supabase: this.supabase,
                  sender: this.messageSender,
                  from,
                  businessId: session.business_id,
                  businessName,
                  sessionId: session.id,
                  sessionData: session.session_data,
                  currentStep: step,
                  customerName: escCustomerName,
                });
                return true;
              }
            }
            await this.sendText(from, "Live chat isn't available for this business. Type *help* for other options.");
            return true;
          }

          if (action === 'checkin') {
            if (session.business_id) {
              const caps = (session.session_data?.capabilities as CapabilityId[]) || await getEnabledCapabilities(this.supabase, session.business_id);
              if (caps.includes('queue')) {
                await this.supabase.from('bot_sessions').update({
                  current_step: 'queue_start',
                  session_data: { ...session.session_data, active_capability: 'queue' },
                }).eq('id', session.id);
                session.current_step = 'queue_start';
                session.session_data.active_capability = 'queue';
                const { data: biz } = await this.supabase
                  .from('businesses')
                  .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code')
                  .eq('id', session.business_id)
                  .single();
                await this.flowExecutor.execute(from, '', session as unknown as BotSession, biz as BusinessRecord | null);
                return true;
              }
            }
            await this.sendText(from, "This business doesn't have queue check-in enabled.");
            return true;
          }

          // Unknown navigate_step action
          return false;
        }

        case 'url': {
          const message = (payload.message as string) || kw.payload;
          await this.sendText(from, message);
          return true;
        }

        case 'start_flow': {
          await this.deactivateSession(session.id);
          await this.handleMessage(from, 'Hi', 'text', undefined, session.business_id || undefined);
          return true;
        }

        case 'start_capability': {
          const capability = (payload.capability as string) || kw.payload;
          if (session.business_id) {
            session.session_data.active_capability = capability;
            const capFirstStep = this.capabilityToFirstStep(capability as CapabilityId);
            await this.supabase.from('bot_sessions').update({
              current_step: capFirstStep,
              session_data: session.session_data,
            }).eq('id', session.id);
            session.current_step = capFirstStep;
            const { data: biz } = await this.supabase
              .from('businesses')
              .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code')
              .eq('id', session.business_id)
              .single();
            await this.flowExecutor.execute(from, '', session as unknown as BotSession, biz as BusinessRecord | null);
            return true;
          }
          return false;
        }

        default:
          return false;
      }
    } catch (err) {
      logger.error('[BOT] executeKeywordAction error (non-fatal):', err);
      return false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  private async getActiveSession(phone: string): Promise<BotSession | null> {
    const now = new Date().toISOString();
    const { data } = await this.supabase
      .from('bot_sessions')
      .select('*')
      .eq('whatsapp_number', phone)
      .eq('is_active', true)
      .gte('expires_at', now) // Only return non-expired sessions
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!data) {
      // Clean up any expired sessions for this phone
      await this.supabase
        .from('bot_sessions')
        .update({ is_active: false })
        .eq('whatsapp_number', phone)
        .eq('is_active', true)
        .lt('expires_at', now);
      return null;
    }

    return (data as BotSession) || null;
  }

  private async deactivateSession(sessionId: string): Promise<void> {
    await this.supabase
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('id', sessionId);
  }

  private async sendText(to: string, text: string): Promise<void> {
    try {
      logger.debug('[BOT] sendText to:', to, 'text:', text.slice(0, 100));
      const result = await this.messageSender.sendText({ to, text });
      logger.debug('[BOT] sendText result:', JSON.stringify(result));
    } catch (err) {
      logger.error('[BOT] sendText FAILED to:', to, 'error:', err);
    }
  }

  /**
   * Forward an inbound chat message to the business owner's phone via WhatsApp.
   * Checks: forwarding toggle is ON + business is on a paid tier.
   * Tracks usage per month for billing.
   * Non-critical — failures are silently ignored.
   */
  private async forwardToBusinessOwner(
    businessId: string,
    customerPhone: string,
    customerName: string | null,
    messageText: string,
  ): Promise<void> {
    try {
      // Check if forwarding is enabled for this business
      const { data: waConfig } = await this.supabase
        .from('whatsapp_config')
        .select('forward_chat_to_phone')
        .eq('business_id', businessId)
        .maybeSingle();

      if (!waConfig?.forward_chat_to_phone) return;

      // Check paid tier (free tier cannot use forwarding)
      const { data: biz } = await this.supabase
        .from('businesses')
        .select('phone, name, subscription_tier')
        .eq('id', businessId)
        .single();

      if (!biz?.phone) return;
      if (biz.subscription_tier === 'free') return;

      const ownerPhone = biz.phone.startsWith('+') ? biz.phone.slice(1) : biz.phone;
      // Don't forward to the customer's own number
      const normalizedCustomer = customerPhone.replace(/^\+/, '');
      if (ownerPhone === normalizedCustomer) return;

      const displayName = customerName || customerPhone;
      await this.messageSender.sendText({
        to: ownerPhone,
        text: `💬 *${displayName}*:\n${messageText}\n\n_Reply from your dashboard → Chat_`,
      });

      // Track usage for billing
      await this.supabase.rpc('increment_chat_forwards', { p_business_id: businessId });
    } catch {
      // Non-critical — don't break the flow
    }
  }
}
