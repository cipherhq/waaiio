import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { MessageSender } from '@/lib/channels/message-sender';
import { StandaloneService } from './standalone.service';
import { BotIntelligenceService } from './bot-intelligence';
import { FlowExecutor } from './flows/executor';
import { getLocale, type BusinessCategoryKey, type FlowType, type CountryCode } from '@/lib/constants';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import type { CapabilityId } from '@/lib/capabilities/types';
import { parseSmartIntent, matchServiceFromKeywords, buildAcknowledgment } from './smart-intent';
import { levenshtein, isCloseMatch, matchScore, phoneticMatch, isAcronymOf, phoneToCountry, detectCategoryIntent } from './fuzzy-match';
import { loadBotCustomConfig, matchQuickReply, loadUnifiedKeywords, matchUnifiedKeyword, parseKeywordPayload } from './keyword-service';
import type { UnifiedKeyword } from './keyword-service';
import { evaluateRules } from './automation/rules-engine';

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

    // Detect "my bookings" keyword — covers industry-specific terminology
    const isBookingsQuery = /^(my\s+)?(bookings?|reservations?|appointments?|appts?|orders?|sessions?|upcoming|schedule)$/i.test(text)
      || /^(check|view|show|list|see)\s+(my\s+)?(bookings?|reservations?|appointments?|appts?|orders?|schedule)$/i.test(text);

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

    let session = await this.getActiveSession(from);

    if (isBookingsQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;
      const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${phoneP},phone.eq.${phoneN}`).limit(1).maybeSingle();
      if (!profile?.id) {
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to make your first booking!");
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
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;
      const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${phoneP},phone.eq.${phoneN}`).limit(1).maybeSingle();
      if (!profile?.id) {
        await this.sendText(from, "I don't have an account for this number. Send *Hi* to make your first booking!");
        return;
      }
      await this.handleTransactionDocument(from, profile.id, isHistoryQuery ? 'history' : 'receipt');
      return;
    }

    if (isAnnualQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;
      const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${phoneP},phone.eq.${phoneN}`).limit(1).maybeSingle();
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

      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;
      const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${phoneP},phone.eq.${phoneN}`).limit(1).maybeSingle();
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
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;
      const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${phoneP},phone.eq.${phoneN}`).limit(1).maybeSingle();
      if (!profile?.id) {
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to get started!");
        return;
      }

      // Find most recent loyalty_points entry to get business_id
      const { data: loyaltyEntry } = await this.supabase
        .from('loyalty_points')
        .select('business_id')
        .or(`customer_phone.eq.${phoneP},customer_phone.eq.${phoneN}`)
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
      const phoneP = from.startsWith('+') ? from : `+${from}`;
      const phoneN = from.startsWith('+') ? from.slice(1) : from;
      const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${phoneP},phone.eq.${phoneN}`).limit(1).maybeSingle();
      if (!profile?.id) {
        await this.sendText(from, "I don't have an account for this number yet. Send *Hi* to get started!");
        return;
      }

      // Find most recent unpaid invoice to get business_id
      const { data: invoiceEntry } = await this.supabase
        .from('invoices')
        .select('business_id')
        .or(`customer_phone.eq.${phoneP},customer_phone.eq.${phoneN}`)
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
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });
        return;
      }

      await this.sendText(from, `No business found matching "${keyword}". Try: switch restaurant, switch spa, switch church, switch shop, etc.`);
      return;
    }

    // Check for restart keywords (skip on free-text steps)
    const currentStep = session?.current_step || '';
    const isChatStep = currentStep === 'chat_handoff' || currentStep === 'chat_start';
    const isFreeTextStep = isChatStep || ['collect_name', 'collect_other_name', 'collect_email', 'special_requests', 'review_text', 'enter_amount', 'collect_address', 'select_business_suggestion', 'enter_referral_code', 'collect_pickup_address', 'collect_dropoff_address', 'collect_package_description'].includes(currentStep);

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

      // Bot code routing (with fuzzy suggestions)
      let pendingSuggestions: { id: string; name: string; bot_code: string }[] | undefined;
      let isCategoryMatch = false;
      if (!businessId) {
        const detection = await this.detectBotCodeWithSuggestions(text, from);
        businessId = detection.businessId;
        pendingSuggestions = detection.suggestions;
        isCategoryMatch = detection.isCategory || false;
        logger.debug('[BOT] detectBotCode("' + text + '") →', businessId, 'suggestions:', pendingSuggestions?.length || 0, 'category:', isCategoryMatch);
      }

      // Link to existing user (check both +phone and phone formats)
      const phoneWithPlus = from.startsWith('+') ? from : `+${from}`;
      const phoneWithout = from.startsWith('+') ? from.slice(1) : from;
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('id')
        .or(`phone.eq.${phoneWithPlus},phone.eq.${phoneWithout}`)
        .limit(1)
        .maybeSingle();

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
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min expiry
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
          .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code')
          .eq('id', businessId)
          .single();
        business = biz as BusinessRecord | null;
      }

      // Load capabilities for this business
      let capabilities: CapabilityId[] = [];
      if (business) {
        capabilities = await getEnabledCapabilities(this.supabase, business.id, business.category);
      }

      const firstStep = business
        ? this.getFirstStepFromCapabilities(capabilities, business.flow_type)
        : 'greeting';

      const sessionData: Record<string, unknown> = businessId && business
        ? { business_id: businessId, business_name: business.name, capabilities }
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

      session = newSession as BotSession;

      if (business) {
        // Standalone bot greeting
        const templates = await this.standaloneService.getBotTemplates(business.id);
        const tierInfo = await this.standaloneService.checkTierLimits(business.id);
        const botAlias = await this.standaloneService.getBotAlias(business.id);

        let greeting: string;
        if (botAlias) {
          greeting = this.intelligence.getPersonaGreeting(botAlias, business.name);
        } else {
          greeting = this.standaloneService.fillTemplate(templates.greeting, {
            restaurant_name: business.name,
            business_name: business.name,
          });
        }

        if (!tierInfo.isWhitelabel) greeting += '\n\n_Powered by Waaiio_';

        if (!tierInfo.allowed) {
          await this.sendText(from, `Thank you for contacting ${business.name}! We're currently unable to accept new bookings via WhatsApp. Please contact us directly.`);
          await this.deactivateSession(session.id);
          return;
        }

        await this.sendText(from, greeting);

        // ── Welcome Buttons: send interactive menu after greeting ──
        try {
          const customConfig = await loadBotCustomConfig(this.supabase, business.id);
          if (customConfig.welcome_buttons.length > 0) {
            const buttons = customConfig.welcome_buttons.slice(0, 3).map((btn, i) => ({
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
            const parsed = parseSmartIntent(text);
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
                await this.sendText(from, ack);
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
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
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

    // Check session expiry — auto-restart instead of blocking
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      // Re-process this message as a fresh session instead of asking for "Hi"
      return this.handleMessage(from, messageText, messageType, destinationPhone, preResolvedBusinessId);
    }

    // ── Escape hatches (hardcoded, never overridable) ──
    const step = session.current_step;
    const isChatMode = step === 'chat_handoff' || step === 'chat_start';
    const isEscapeHatch = ESCAPE_HATCH_PATTERNS.some(p => p.test(text.trim()));
    if (isEscapeHatch && session.business_id && !isChatMode) {
      this.intelligence.resetAbuse(from);
      await this.deactivateSession(session.id);
      await this.sendText(from, 'Action cancelled. Send *Hi* to start fresh. 🙏');
      return;
    }

    // ── Unified keyword matching (replaces detectIntent + old keyword + quick reply checks) ──
    // Only fire on non-free-text steps
    const isFreeTextStepForKeywords = isChatMode || ['collect_name', 'collect_other_name', 'collect_email', 'special_requests', 'review_text', 'enter_amount', 'collect_address', 'queue_collect_name', 'select_business_suggestion', 'enter_referral_code', 'collect_pickup_address', 'collect_dropoff_address', 'collect_package_description'].includes(step);

    if (!isFreeTextStepForKeywords) {
      // Load business category for category-scoped keywords
      let businessCategory: string | null = null;
      if (session.business_id) {
        const { data: catBiz } = await this.supabase
          .from('businesses')
          .select('category')
          .eq('id', session.business_id)
          .single();
        businessCategory = catBiz?.category || null;
      }

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

    // Handle built-in steps (my_bookings, modify_booking)
    if (step === 'my_bookings') {
      await this.handleMyBookings(session, from, text);
      return;
    }
    if (step === 'modify_booking') {
      await this.handleModifyBooking(session, from, text);
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
          // 'start_flow' — fall through to normal flow execution
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
        await this.sendText(from, "Chat session ended. ✅\n\nSend *Hi* to continue with bookings, payments, and other services.");
        return;
      }
      // Store message for human agent, update conversation
      const chatPhoneP = from.startsWith('+') ? from : `+${from}`;
      const chatPhoneN = from.startsWith('+') ? from.slice(1) : from;
      let handoffName: string | null = null;
      const { data: hProfile } = await this.supabase
        .from('profiles')
        .select('first_name, last_name')
        .or(`phone.eq.${chatPhoneP},phone.eq.${chatPhoneN}`)
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

      // Forward message to business owner's phone
      await this.forwardToBusinessOwner(session.business_id, from, handoffName, text);
      return;
    }

    // Chat fallback: if message doesn't match any flow step and chat is enabled,
    // store as inbound chat message
    if (session.business_id && step === 'chat_start') {
      // Allow user to exit chat_start mode
      const chatExitMatch = /^(restart|start\s*over|end\s*chat|exit\s*chat|close\s*chat|stop\s*chat)$/i.test(text);
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
        return this.handleMessage(from, 'Hi', messageType, destinationPhone, session.business_id);
      }

      // This is a chat session — store message and acknowledge
      const caps = await getEnabledCapabilities(this.supabase, session.business_id);
      if (caps.includes('chat')) {
        // Get customer name
        const chatPhoneP = from.startsWith('+') ? from : `+${from}`;
        const chatPhoneN = from.startsWith('+') ? from.slice(1) : from;
        let customerName: string | null = null;
        const { data: profile } = await this.supabase
          .from('profiles')
          .select('first_name, last_name')
          .or(`phone.eq.${chatPhoneP},phone.eq.${chatPhoneN}`)
          .limit(1)
          .maybeSingle();
        if (profile?.first_name) {
          customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
        }

        // Upsert conversation record
        await this.supabase.from('chat_conversations').upsert({
          business_id: session.business_id,
          customer_phone: from,
          customer_name: customerName,
          status: 'open',
          last_message_at: new Date().toISOString(),
        }, { onConflict: 'business_id,customer_phone' });

        // Get conversation_id for linking
        const { data: chatConv } = await this.supabase
          .from('chat_conversations')
          .select('id')
          .eq('business_id', session.business_id)
          .eq('customer_phone', from)
          .maybeSingle();

        await this.supabase.from('chat_messages').insert({
          business_id: session.business_id,
          customer_phone: from,
          customer_name: customerName,
          direction: 'inbound',
          message_text: text,
          is_read: false,
          conversation_id: chatConv?.id || null,
          media_url: mediaUrl || null,
          media_type: mediaUrl ? (messageType || 'image') : null,
        });

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

        // Forward message to business owner's phone
        await this.forwardToBusinessOwner(session.business_id, from, customerName, text);

        // Only send acknowledgment on the first message in this chat session
        if (!session.session_data.chat_ack_sent) {
          await this.sendText(from, "Thanks for your message! A team member will respond shortly.\n\nType *end chat* anytime to return to the menu.");
          await this.supabase.from('bot_sessions').update({
            session_data: { ...session.session_data, chat_ack_sent: true },
          }).eq('id', session.id);
        }
        return;
      }
    }

    await this.flowExecutor.execute(from, text, session as unknown as BotSession, business, mediaUrl, messageType);
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack?.slice(0, 300)}` : String(err);
      logger.error('[BOT] handleMessage CRASH:', errMsg);
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

    // ── 1. Exact match (case-insensitive) — "CITADEL-OF-GRACE" ──
    if (/^[a-z0-9-]{2,30}$/.test(normalizedText)) {
      const { data } = await this.supabase
        .from('businesses')
        .select('id')
        .ilike('bot_code', normalizedText)
        .eq('status', 'active')
        .maybeSingle();
      if (data) return { businessId: data.id };
    }

    // ── 2. Spaces-to-hyphens — "citadel of grace" → "citadel-of-grace" ──
    const spacesToHyphens = normalizedText.replace(/\s+/g, '-');
    if (/^[a-z0-9-]{2,30}$/.test(spacesToHyphens) && spacesToHyphens !== normalizedText) {
      const { data } = await this.supabase
        .from('businesses')
        .select('id')
        .ilike('bot_code', spacesToHyphens)
        .eq('status', 'active')
        .maybeSingle();
      if (data) return { businessId: data.id };
    }

    // ── 3. Hyphenated token match ──
    const tokens = normalizedText.split(/\s+/);
    const hyphenated = tokens.filter(t => t.includes('-') && /^[a-z0-9-]{2,30}$/.test(t));
    for (const candidate of hyphenated) {
      const { data } = await this.supabase
        .from('businesses')
        .select('id')
        .ilike('bot_code', candidate)
        .eq('status', 'active')
        .maybeSingle();
      if (data) return { businessId: data.id };
    }

    // ── 4. Strip filler/pidgin words and join with hyphens ──
    const meaningful = tokens.filter(t => !FILLER_WORDS.has(t) && t.length > 0);
    if (meaningful.length > 0 && meaningful.length <= 6) {
      const candidate = meaningful.join('-').replace(/-+/g, '-').slice(0, 30);
      if (/^[a-z0-9-]{2,30}$/.test(candidate)) {
        const { data } = await this.supabase
          .from('businesses')
          .select('id')
          .ilike('bot_code', candidate)
          .eq('status', 'active')
          .maybeSingle();
        if (data) return { businessId: data.id };
      }
    }

    // Skip advanced matching if the input is just common greetings/filler
    const allFiller = tokens.every(t => FILLER_WORDS.has(t));
    if (allFiller) return { businessId: null };

    // ── Fetch candidate businesses for advanced matching (5-8) ──
    // Grab a broader set of active businesses for local matching algorithms
    const searchWords = meaningful.length > 0 ? meaningful : tokens;
    const nameFilters = searchWords.map(w => `name.ilike.%${w}%`).join(',');
    const codeFilters = searchWords.map(w => `bot_code.ilike.%${w}%`).join(',');

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
          .or(`name.ilike.%${word}%,bot_code.ilike.%${word}%`)
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
    // Check past bot_sessions (most reliable — covers all interaction types)
    const { data: pastSessions } = await this.supabase
      .from('bot_sessions')
      .select('business_id')
      .eq('whatsapp_number', phone)
      .not('business_id', 'is', null)
      .order('last_active_at', { ascending: false })
      .limit(10);

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

    // Also check bookings if we have a user profile
    if (userId) {
      const { data: recentBookings } = await this.supabase
        .from('bookings')
        .select('business_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (recentBookings) {
        for (const b of recentBookings) {
          if (b.business_id && !seen.has(b.business_id)) {
            seen.add(b.business_id);
            uniqueBusinessIds.push(b.business_id);
          }
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

    if (capabilities.length === 1) {
      return this.capabilityToFirstStep(capabilities[0]);
    }

    // Multiple capabilities — route to capability selection
    return 'select_capability';
  }

  private capabilityToFirstStep(cap: CapabilityId): string {
    switch (cap) {
      case 'scheduling': return 'select_service';
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
      const { data: upcoming } = await this.supabase
        .from('bookings')
        .select('id, date, time, party_size, reference_code, businesses (name)')
        .eq('user_id', session.user_id!)
        .in('status', ['confirmed', 'pending'])
        .gte('date', new Date().toISOString().split('T')[0])
        .order('date', { ascending: true })
        .limit(5);

      if (!upcoming || upcoming.length === 0) {
        await this.sendText(from, "You don't have any upcoming bookings. Send *Hi* to make a new one!");
        await this.deactivateSession(session.id);
        return;
      }

      const items = upcoming.map((r) => {
        const biz = r.businesses as unknown as { name: string } | null;
        const dateLabel = new Date(r.date + 'T00:00').toLocaleDateString('en-US', {
          weekday: 'short', day: 'numeric', month: 'short',
        });
        return {
          title: biz?.name || 'Business',
          description: `${dateLabel} at ${r.time} • ${r.party_size} guests`,
          postbackText: `booking_${r.id}`,
        };
      });

      await this.messageSender.sendList({
        to: from,
        title: 'Your Bookings',
        body: 'Select a booking to manage:',
        buttonLabel: 'View Bookings',
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
    }
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

    if (response === 'back_bookings') {
      await this.supabase.from('bot_sessions').update({ current_step: 'my_bookings' }).eq('id', session.id);
      await this.handleMyBookings(session, from, '');
      return;
    }

    if (response === 'cancel_booking') {
      await this.supabase
        .from('bookings')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'diner' })
        .eq('id', bookingId);

      await this.sendText(from, '✓ Booking cancelled.\n\nSend *Hi* to make a new booking or *my bookings* to manage others.');
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

  // ── Transaction Document Handler ──────────────────────────

  private async handleTransactionDocument(from: string, userId: string, type: 'history' | 'receipt' | 'annual'): Promise<void> {
    const labelMap = { history: 'transaction history', receipt: 'receipt', annual: 'annual statement' };
    const label = labelMap[type];
    await this.sendText(from, `Generating your ${label}... 📄`);

    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

      if (!baseUrl) {
        throw new Error('NEXT_PUBLIC_APP_URL or VERCEL_URL must be set');
      }

      const response = await fetch(`${baseUrl}/api/receipts/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-token': process.env.INTERNAL_API_TOKEN || '',
        },
        body: JSON.stringify({ userId, type, phone: from }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (response.status === 404) {
          await this.sendText(from, `No transactions found. Make a booking first, then come back for your ${label}!`);
          return;
        }
        logger.error('[BOT] Receipt API error:', response.status, body);
        await this.sendText(from, `Sorry, I couldn't generate your ${label} right now. Please try again later.`);
        return;
      }

      const { url, filename } = await response.json();

      await this.messageSender.sendDocument({
        to: from,
        documentUrl: url,
        filename,
        caption: type === 'history'
          ? 'Your transaction history'
          : type === 'annual'
            ? 'Your annual statement'
            : 'Your latest receipt',
      });
    } catch (err) {
      logger.error('[BOT] handleTransactionDocument error:', err);
      await this.sendText(from, `Sorry, I couldn't generate your ${label} right now. Please try again later.`);
    }
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
        await this.sendText(from, 'Quote declined. Thank you for considering!');
      }
      // Accept case: payment link is sent by the API route itself
    } catch (err) {
      logger.error('[BOT] Quote response error:', err);
      await this.sendText(from, 'Sorry, something went wrong. Please try again.');
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
            const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${phoneP},phone.eq.${phoneN}`).limit(1).maybeSingle();
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
            const { data: profile } = await this.supabase.from('profiles').select('id').or(`phone.eq.${phoneP},phone.eq.${phoneN}`).limit(1).maybeSingle();
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
              const caps = await getEnabledCapabilities(this.supabase, session.business_id);
              if (caps.includes('chat')) {
                const escPhoneP = from.startsWith('+') ? from : `+${from}`;
                const escPhoneN = from.startsWith('+') ? from.slice(1) : from;
                let escCustomerName: string | null = null;
                const { data: escProfile } = await this.supabase
                  .from('profiles')
                  .select('first_name, last_name')
                  .or(`phone.eq.${escPhoneP},phone.eq.${escPhoneN}`)
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
              const caps = await getEnabledCapabilities(this.supabase, session.business_id);
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
    const { data } = await this.supabase
      .from('bot_sessions')
      .select('*')
      .eq('whatsapp_number', phone)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    return (data as BotSession) || null;
  }

  private async deactivateSession(sessionId: string): Promise<void> {
    await this.supabase
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('id', sessionId);
  }

  private async sendText(to: string, text: string): Promise<void> {
    logger.debug('[BOT] sendText to:', to, 'text:', text.slice(0, 100));
    const result = await this.messageSender.sendText({ to, text });
    logger.debug('[BOT] sendText result:', JSON.stringify(result));
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
