import { SupabaseClient } from '@supabase/supabase-js';
import { GupshupService } from '@/lib/channels/gupshup';
import { StandaloneService } from './standalone.service';
import { BotIntelligenceService } from './bot-intelligence';
import { FlowExecutor } from './flows/executor';
import type { BusinessCategoryKey, FlowType, CountryCode } from '@/lib/constants';

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
    private readonly gupshupService: GupshupService,
    private readonly standaloneService: StandaloneService,
    private readonly intelligence: BotIntelligenceService,
  ) {
    this.flowExecutor = new FlowExecutor(supabase, gupshupService, standaloneService, intelligence);
  }

  async handleMessage(
    from: string,
    messageText: string,
    messageType: string,
    destinationPhone?: string,
    preResolvedBusinessId?: string,
  ): Promise<void> {
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
      const { data: newSession } = await this.supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: null,
        current_step: 'my_bookings', session_data: {}, is_active: true,
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
    const isRestart = !isFreeTextStep && (
      /^(start|restart)$/i.test(text) ||
      (this.intelligence.detectIntent(text, 'greeting')?.intent === 'greeting')
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

      const firstStep = business ? this.getFirstStep(business.flow_type) : 'greeting';

      const { data: newSession, error: sessionError } = await this.supabase
        .from('bot_sessions')
        .insert({
          whatsapp_number: from,
          user_id: profile?.id || null,
          business_id: businessId,
          current_step: firstStep,
          session_data: businessId && business ? { business_id: businessId, business_name: business.name } : {},
          is_active: true,
        })
        .select()
        .single();

      if (sessionError || !newSession) {
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

        if (!tierInfo.isWhitelabel) greeting += '\n\n_Powered by Blowded_';

        if (!tierInfo.allowed) {
          await this.sendText(from, `Thank you for contacting ${business.name}! We're currently unable to accept new bookings via WhatsApp. Please contact us directly.`);
          await this.deactivateSession(session.id);
          return;
        }

        await this.sendText(from, greeting);

        // Delegate to flow executor for the first step prompt
        await this.flowExecutor.execute(from, '', session as unknown as BotSession, business);
        return;
      }

      // Marketplace greeting
      const phoneForLookup = from.startsWith('+') ? from : `+${from}`;
      const { data: returningProfile } = await this.supabase
        .from('profiles')
        .select('id, first_name')
        .eq('phone', phoneForLookup)
        .single();

      if (returningProfile?.first_name) {
        await this.sendText(from, `Welcome back, ${returningProfile.first_name}! 🍽️\n\nLet's find you a table!`);
      } else {
        await this.sendText(from, `Welcome to Blowded! 🍽️\n\nDiscover and book the best businesses in Nigeria.\n\nLet's get started!`);
      }

      // For marketplace, show city selection (scheduling flow first step isn't applicable without a business)
      await this.sendText(from, 'Send a business code to get started, or type *help* for options.');
      return;
    }

    // Check session expiry
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await this.supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      await this.sendText(from, 'Your session has expired. Send "Hi" to start again.');
      return;
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
        }).select().single();
        if (!newSession) { await this.sendText(from, 'Something went wrong.'); return; }
        await this.handleMyBookings(newSession as BotSession, from, '');
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

    await this.flowExecutor.execute(from, text, session as unknown as BotSession, business);
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

    // Exact match
    if (/^[a-z0-9-]{2,30}$/.test(normalizedText)) {
      const { data } = await this.supabase
        .from('businesses')
        .select('id')
        .eq('bot_code', normalizedText)
        .in('status', ['active', 'approved'])
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
        .eq('bot_code', candidate)
        .in('status', ['active', 'approved'])
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
          .eq('bot_code', candidate)
          .in('status', ['active', 'approved'])
          .maybeSingle();
        if (data) return data.id;
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

      await this.gupshupService.sendList({
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

      await this.gupshupService.sendButtons({
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
    const result = await this.gupshupService.sendText({ to, text });
    console.log('[BOT] sendText result:', JSON.stringify(result));
  }
}
