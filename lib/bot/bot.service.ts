import { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { StandaloneService } from './standalone.service';
import { BotIntelligenceService } from './bot-intelligence';
import { FlowExecutor } from './flows/executor';
import { getLocale, type BusinessCategoryKey, type FlowType, type CountryCode } from '@/lib/constants';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import type { CapabilityId } from '@/lib/capabilities/types';
import { parseSmartIntent, matchServiceFromKeywords, buildAcknowledgment } from './smart-intent';

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
  ): Promise<void> {
    try {
    const text = messageText.trim();
    console.log('[BOT] handleMessage from:', from, 'text:', text, 'type:', messageType, 'dest:', destinationPhone);

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

    // Detect "my bookings" keyword
    const isBookingsQuery = /^(my bookings|bookings|reservations|my reservations|my orders|orders)$/i.test(text);

    let session = await this.getActiveSession(from);

    if (isBookingsQuery) {
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }
      const phone = from.startsWith('+') ? from : `+${from}`;
      const { data: profile } = await this.supabase.from('profiles').select('id').eq('phone', phone).single();
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

    // Check for "switch <keyword>" command — lets testers swap between businesses
    const switchMatch = text.match(/^switch\s+(.+)$/i);
    if (switchMatch) {
      const keyword = switchMatch[1].trim().toLowerCase();
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }

      // Search by category, name, or bot_code
      const { data: matches } = await this.supabase
        .from('businesses')
        .select('id, name, bot_code, category, flow_type')
        .or(`category.ilike.%${keyword}%,name.ilike.%${keyword}%,bot_code.ilike.%${keyword}%`)
        .eq('status', 'active')
        .limit(1);

      if (matches && matches.length > 0) {
        const biz = matches[0];
        // Treat as if user sent the bot_code — trigger a fresh session
        await this.handleMessage(from, biz.bot_code || 'Hi', messageType, destinationPhone, biz.id);
        return;
      }

      await this.sendText(from, `No business found matching "${keyword}". Try: switch restaurant, switch spa, switch church, switch shop, etc.`);
      return;
    }

    // Check for restart keywords (skip on free-text steps)
    const currentStep = session?.current_step || '';
    const isFreeTextStep = ['collect_name', 'collect_other_name', 'collect_email', 'special_requests', 'review_text', 'enter_amount', 'collect_address'].includes(currentStep);
    const detectedRestart = !isFreeTextStep ? this.intelligence.detectIntent(text, currentStep) : null;

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

    const isRestart = !isFreeTextStep && (
      /^(start|restart)$/i.test(text) ||
      detectedRestart?.intent === 'greeting' ||
      detectedRestart?.intent === 'booking' ||
      isBotCodeRestart
    );

    if (!session || isRestart) {
      console.log('[BOT] New/restart session. hasSession:', !!session, 'isRestart:', isRestart);
      if (session) {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      }

      // Determine standalone business
      let businessId: string | null = preResolvedBusinessId || null;
      console.log('[BOT] preResolvedBusinessId:', preResolvedBusinessId);

      // Fallback: lookup by destination phone
      if (!businessId && destinationPhone) {
        const { data: biz } = await this.supabase
          .from('businesses')
          .select('id')
          .eq('whatsapp_phone_number_id', destinationPhone)
          .single();
        businessId = biz?.id || null;
        console.log('[BOT] destPhone lookup:', destinationPhone, '→', businessId);
      }

      // Bot code routing
      if (!businessId) {
        businessId = await this.detectBotCode(text);
        console.log('[BOT] detectBotCode("' + text + '") →', businessId);
      }

      // Link to existing user
      const phone = from.startsWith('+') ? from : `+${from}`;
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('id')
        .eq('phone', phone)
        .single();

      // Returning customer: check past history if no business resolved yet
      if (!businessId) {
        businessId = await this.findReturningCustomerBusiness(from, profile?.id || null);
        if (businessId) console.log('[BOT] returning customer → business:', businessId);
      }

      // Load business info
      let business: BusinessRecord | null = null;
      if (businessId) {
        const { data: biz } = await this.supabase
          .from('businesses')
          .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, country_code')
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
        console.error('[BOT] Session insert failed:', sessionError?.message, sessionError?.code, sessionError?.details);
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
            console.error('[BOT] Smart intent parse error (non-fatal):', err);
          }
        }

        // Delegate to flow executor for the first step prompt
        await this.flowExecutor.execute(from, '', session as unknown as BotSession, business);
        return;
      }

      // Marketplace greeting — no business found from bot code or past history
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

      await this.sendText(from, 'Send a *business code* to connect to a business.\n\nOr type *switch* followed by a name, e.g.:\n_switch Bukka Hut_\n_switch spa_');
      return;
    }

    // Check session expiry — auto-restart instead of blocking
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      // Re-process this message as a fresh session instead of asking for "Hi"
      return this.handleMessage(from, messageText, messageType, destinationPhone, preResolvedBusinessId);
    }

    // Intent detection
    const step = session.current_step;
    const detectedIntent = this.intelligence.detectIntent(text, step);

    if (detectedIntent) {
      this.intelligence.resetAbuse(from);

      if (detectedIntent.action === 'bookings') {
        await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
        const phone = from.startsWith('+') ? from : `+${from}`;
        const { data: profile } = await this.supabase.from('profiles').select('id').eq('phone', phone).single();
        if (!profile?.id) {
          await this.sendText(from, "I don't have an account for this number. Send *Hi* to get started!");
          return;
        }
        const { data: newSession } = await this.supabase.from('bot_sessions').insert({
          whatsapp_number: from, user_id: profile.id, business_id: null,
          current_step: 'my_bookings', session_data: {}, is_active: true,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }).select().single();
        if (!newSession) { await this.sendText(from, 'Something went wrong.'); return; }
        await this.handleMyBookings(newSession as BotSession, from, '');
        return;
      }

      if (detectedIntent.action === 'queue_checkin') {
        // Check if business has queue capability
        if (session.business_id) {
          const caps = await getEnabledCapabilities(this.supabase, session.business_id);
          if (caps.includes('queue')) {
            await this.supabase.from('bot_sessions').update({
              current_step: 'queue_start',
              session_data: { ...session.session_data, active_capability: 'queue' },
            }).eq('id', session.id);
            session.current_step = 'queue_start';
            session.session_data.active_capability = 'queue';
            let business: BusinessRecord | null = null;
            const { data: biz } = await this.supabase
              .from('businesses')
              .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, country_code')
              .eq('id', session.business_id)
              .single();
            business = biz as BusinessRecord | null;
            await this.flowExecutor.execute(from, '', session as unknown as BotSession, business);
            return;
          }
        }
        // No queue capability — treat as regular message
        await this.sendText(from, "This business doesn't have queue check-in enabled.");
        return;
      }

      if (detectedIntent.action === 'help') {
        const isStandalone = !!session.business_id;
        const businessName = session.session_data.business_name as string | undefined;
        let alias: string | null = null;
        if (isStandalone && session.business_id) {
          alias = await this.standaloneService.getBotAlias(session.business_id);
        }
        await this.sendText(from, this.intelligence.getHelpText(isStandalone, businessName, alias || undefined));
        const helpNudge = this.intelligence.getContextualHelp(step);
        await this.sendText(from, `📍 You're currently at: *${step.replace(/_/g, ' ')}*\n${helpNudge}`);
        return;
      }

      if (detectedIntent.action === 'acknowledge') {
        await this.sendText(from, detectedIntent.response!);
        return;
      }

      if (detectedIntent.action === null && detectedIntent.response) {
        await this.sendText(from, detectedIntent.response);
        const nudge = this.intelligence.getContextualHelp(step);
        await this.sendText(from, nudge);
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

    // Delegate to flow executor for all flow steps
    let business: BusinessRecord | null = null;
    if (session.business_id) {
      const { data: biz } = await this.supabase
        .from('businesses')
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, country_code')
        .eq('id', session.business_id)
        .single();
      business = biz as BusinessRecord | null;
    }

    // Chat fallback: if message doesn't match any flow step and chat is enabled,
    // store as inbound chat message
    if (session.business_id && step === 'chat_start') {
      // This is a chat session — store message and acknowledge
      const caps = await getEnabledCapabilities(this.supabase, session.business_id);
      if (caps.includes('chat')) {
        // Get customer name
        const phone = from.startsWith('+') ? from : `+${from}`;
        let customerName: string | null = null;
        const { data: profile } = await this.supabase
          .from('profiles')
          .select('first_name, last_name')
          .eq('phone', phone)
          .maybeSingle();
        if (profile?.first_name) {
          customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
        }

        await this.supabase.from('chat_messages').insert({
          business_id: session.business_id,
          customer_phone: from,
          customer_name: customerName,
          direction: 'inbound',
          message_text: text,
          is_read: false,
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

        await this.sendText(from, "Thanks for your message! A team member will respond shortly.");
        return;
      }
    }

    await this.flowExecutor.execute(from, text, session as unknown as BotSession, business);
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack?.slice(0, 300)}` : String(err);
      console.error('[BOT] handleMessage CRASH:', errMsg);
      try { await this.sendText(from, 'Sorry, something went wrong. Please try again.'); } catch (_) { /* ignore */ }
    }
  }

  // ── Bot code detection ────────────────────────────────

  private async detectBotCode(text: string): Promise<string | null> {
    const normalizedText = text.toLowerCase().trim();

    const FILLER_WORDS = new Set([
      'hi', 'hello', 'hey', 'yo', 'sup', 'hiya', 'howdy',
      'good', 'morning', 'afternoon', 'evening', 'night',
      'book', 'booking', 'reserve', 'reservation', 'table', 'order',
      'i', 'want', 'need', 'would', 'like', 'to', 'a', 'at', 'the', 'for',
      'please', 'pls', 'plz', 'thanks', 'thank', 'you',
      'can', 'me', 'my', 'get', 'make', 'help', 'pay', 'buy', 'ticket',
    ]);

    // Exact match (case-insensitive)
    if (/^[a-z0-9-]{2,30}$/.test(normalizedText)) {
      const { data } = await this.supabase
        .from('businesses')
        .select('id')
        .ilike('bot_code', normalizedText)
        .eq('status', 'active')
        .maybeSingle();
      if (data) return data.id;
    }

    // Hyphenated token match
    const tokens = normalizedText.split(/\s+/);
    const hyphenated = tokens.filter(t => t.includes('-') && /^[a-z0-9-]{2,30}$/.test(t));
    for (const candidate of hyphenated) {
      const { data } = await this.supabase
        .from('businesses')
        .select('id')
        .ilike('bot_code', candidate)
        .eq('status', 'active')
        .maybeSingle();
      if (data) return data.id;
    }

    // Strip filler words
    const meaningful = tokens.filter(t => !FILLER_WORDS.has(t) && t.length > 0);
    if (meaningful.length > 0 && meaningful.length <= 5) {
      const candidate = meaningful.join('-').replace(/-+/g, '-').slice(0, 30);
      if (/^[a-z0-9-]{2,30}$/.test(candidate)) {
        const { data } = await this.supabase
          .from('businesses')
          .select('id')
          .ilike('bot_code', candidate)
          .eq('status', 'active')
          .maybeSingle();
        if (data) return data.id;
      }
    }

    return null;
  }

  /**
   * Look up a returning customer's most recent business from past sessions, bookings, and orders.
   * If they've only interacted with one business, auto-route there.
   * If multiple, return the most recent one (they can always "switch" to another).
   */
  private async findReturningCustomerBusiness(phone: string, userId: string | null): Promise<string | null> {
    // Check past bot_sessions (most reliable — covers all interaction types)
    const { data: pastSessions } = await this.supabase
      .from('bot_sessions')
      .select('business_id')
      .eq('whatsapp_number', phone)
      .not('business_id', 'is', null)
      .order('last_active_at', { ascending: false })
      .limit(10);

    if (pastSessions && pastSessions.length > 0) {
      // Get unique business IDs, ordered by most recent
      const seen = new Set<string>();
      const uniqueBusinessIds: string[] = [];
      for (const s of pastSessions) {
        if (s.business_id && !seen.has(s.business_id)) {
          seen.add(s.business_id);
          uniqueBusinessIds.push(s.business_id);
        }
      }

      if (uniqueBusinessIds.length === 1) {
        // Single business — auto-route
        const { data: biz } = await this.supabase
          .from('businesses')
          .select('id')
          .eq('id', uniqueBusinessIds[0])
          .eq('status', 'active')
          .maybeSingle();
        if (biz) return biz.id;
      }

      if (uniqueBusinessIds.length > 1) {
        // Multiple businesses — return the most recent active one
        for (const bid of uniqueBusinessIds) {
          const { data: biz } = await this.supabase
            .from('businesses')
            .select('id')
            .eq('id', bid)
            .eq('status', 'active')
            .maybeSingle();
          if (biz) return biz.id;
        }
      }
    }

    // Fallback: check bookings if we have a user profile
    if (userId) {
      const { data: recentBooking } = await this.supabase
        .from('bookings')
        .select('business_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recentBooking?.business_id) {
        const { data: biz } = await this.supabase
          .from('businesses')
          .select('id')
          .eq('id', recentBooking.business_id)
          .eq('status', 'active')
          .maybeSingle();
        if (biz) return biz.id;
      }
    }

    return null;
  }

  private getFirstStep(flowType: FlowType): string {
    switch (flowType) {
      case 'scheduling': return 'select_service';
      case 'payment': return 'select_category';
      case 'ordering': return 'browse_catalog';
      case 'ticketing': return 'select_event';
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
      case 'loyalty': return 'select_service'; // loyalty is post-completion
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

    await this.sendText(from, 'Please tap one of the options above.');
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
    console.log('[BOT] sendText to:', to, 'text:', text.slice(0, 100));
    const result = await this.messageSender.sendText({ to, text });
    console.log('[BOT] sendText result:', JSON.stringify(result));
  }
}
