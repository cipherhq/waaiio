// ── Types ──────────────────────────────────────────────

/** @deprecated Intents are now handled via bot_keywords table */
export type BotIntent =
  | 'greeting'
  | 'help'
  | 'booking'
  | 'cancel'
  | 'escalate'
  | 'status'
  | 'history'
  | 'receipt'
  | 'menu'
  | 'pricing'
  | 'hours'
  | 'location'
  | 'thanks'
  | 'checkin';

/** @deprecated Use unified keyword system instead */
export interface IntentResult {
  intent: BotIntent;
  action: string | null;
  response: string | null;
}

export interface AbuseResult {
  timeout: boolean;
  warn: boolean;
  message: string;
}

interface AbuseRecord {
  gibberishCount: number;
  profanityCount: number;
  lastGibberish: number;
  lastProfanity: number;
  cooldownUntil: number;
}

// NOTE: Intent rules (INTENT_RULES) have been migrated to the bot_keywords table
// as system-scope keywords. See migration 041_unified_bot_keywords.sql.

// ── Profanity word list (moderate filter) ──────────────

const PROFANITY_SET = new Set([
  // English profanity
  'fuck', 'shit', 'bitch', 'bastard', 'cunt', 'whore', 'asshole', 'dick',
  'motherfucker', 'cocksucker', 'bullshit', 'piss', 'slut', 'wanker',
  'twat', 'prick', 'arse', 'arsehole', 'bollocks', 'tosser', 'shithead',
  'dumbass', 'dipshit', 'jackass', 'fuckoff', 'stfu', 'gtfo',
  // Nigerian pidgin / Yoruba / Igbo slang
  'mumu', 'oloshi', 'werey', 'ode', 'ashawo', 'oponu', 'oloriburuku',
  'agbaya', 'ewu', 'efulefu', 'anuofia', 'olofofo', 'yeye', 'omo ale',
  'oshisco', 'oniranu', 'were', 'alakori', 'alagbere', 'oku', 'gorimapa',
  'ashewo', 'mugu',
]);

// L33t-speak & censored patterns
const LEET_PATTERNS: Array<[RegExp, string]> = [
  [/f[\W_]*[u\u00fc*]+[\W_]*[ck]+/gi, 'fuck'],
  [/sh[\W_]*[i1!]+[\W_]*t/gi, 'shit'],
  [/b[\W_]*[i1!]+[\W_]*t[\W_]*ch/gi, 'bitch'],
  [/a[\W_]*s[\W_]*s/gi, 'ass'],
  [/d[\W_]*[i1!]+[\W_]*ck/gi, 'dick'],
  [/c[\W_]*[u\u00fc]+[\W_]*nt/gi, 'cunt'],
];

// ── Contextual help per step ────────────────────────────

const STEP_HELP: Record<string, string> = {
  greeting: "Send *Hi* to get started, or type *help* for options.",
  quick_rebook: 'Tap a restaurant to rebook, or *Browse New* to explore.',
  city_selection: 'Tap *Choose City* to pick where you\'d like to dine. 🏙️',
  neighborhood_selection: 'Tap *Choose Area* to select a neighborhood. 📍',
  restaurant_selection: 'Tap *Choose Restaurant* to pick where to eat. 🍽️',
  date_selection: 'Tap *Choose Date* to select when you\'d like to dine. 📅',
  time_selection: 'Tap *Choose Time* to pick your preferred slot. 🕐',
  party_size: 'Type a number (e.g. *4*) or tap a button for guest count. 👥',
  confirmation: 'Tap *Confirm* to book, *Add Request* for special requests, or *For Someone* to book for a friend. ✅',
  special_requests: 'Tap a quick option or type your own request. 📝',
  book_for_other: 'Tap *Myself* or *Someone else*. 👤',
  collect_name: 'Type your full name (e.g. *Ade Johnson*). ✍️',
  collect_other_name: "Type the guest's name. ✍️",
  collect_other_phone: "Type the guest's WhatsApp number or *skip*. 📱",
  collect_email: 'Type your email or tap *Skip*. 📧',
  payment: "Tap *I've Paid* after completing payment. 💳",
  my_bookings: 'Tap a booking to manage it, or send *Hi* to make a new one.',
  modify_booking: 'Tap *Cancel*, *Change Date/Time*, or *Back*.',
  review_text: 'Type your comment or tap *No thanks* to skip. ✍️',
  // Flow engine steps
  select_service: 'Tap *Choose* to select a service. 📌',
  select_date: 'Tap *Choose Date* to select when. 📅',
  select_time: 'Tap *Choose Time* to pick your slot. 🕐',
  select_quantity: 'Type a number or tap a button. 👥',
  select_category: 'Tap to select a payment category. 📋',
  enter_amount: 'Type the amount. 💰',
  confirm_amount: 'Tap *Confirm* or *Cancel*. ✅',
  browse_catalog: 'Tap *Browse* to see products. 🛍️',
  add_to_cart: 'Tap *Checkout* or *Add More*. 🛒',
  continue_or_checkout: 'Tap *Checkout* or *Add More*. 🛒',
  delivery_details: 'Tap *Delivery* or *Pickup*. 🚚',
  collect_address: 'Type your delivery address. 📍',
  select_event: 'Tap *View Events* to browse events. 🎪',
  ticket_confirmation: 'Tap *Confirm* or *Cancel*. 🎫',
  process_payment: 'Processing your payment... ⏳',
  process_order: 'Processing your order... ⏳',
  process_tickets: 'Processing your tickets... ⏳',
  create_booking: 'Creating your booking... ⏳',
  await_payment: "Tap *I've Paid* after paying. 💳",
  await_order_payment: "Tap *I've Paid* after paying. 💳",
  await_ticket_payment: "Tap *I've Paid* after paying. 💳",
  chat_handoff: 'You\'re connected to a human agent. Type *restart* to go back to the bot.',
  queue_start: 'Tap *Check In* to join the queue, or *Queue Status* to check your position.',
  queue_collect_name: 'Type your name for the queue entry.',
  queue_confirm_checkin: 'Your check-in is being processed...',
  queue_check_status: 'Checking your queue position...',
};

// ── Service ─────────────────────────────────────────────

export class BotIntelligenceService {
  private readonly abuseMap = new Map<string, AbuseRecord>();

  // ── 1A. Intent Detection ──────────────────────────────
  // REMOVED: detectIntent() — now handled by unified bot_keywords system.
  // See keyword-service.ts: loadUnifiedKeywords() + matchUnifiedKeyword()

  // ── 1B. Profanity Detection ───────────────────────────

  containsProfanity(text: string): boolean {
    // Normalize: collapse repeated chars ("fuuuck" -> "fuck")
    const collapsed = text.toLowerCase().replace(/(.)\1{2,}/g, '$1$1');

    // Whole-word check against profanity set
    const words = collapsed.split(/[\s,.!?;:]+/).filter(Boolean);
    for (const word of words) {
      // Strip non-alpha for matching but keep the word boundary logic
      const cleaned = word.replace(/[^a-z]/g, '');
      if (cleaned.length >= 3 && PROFANITY_SET.has(cleaned)) return true;
    }

    // L33t-speak / censored pattern check
    for (const [pattern] of LEET_PATTERNS) {
      if (pattern.test(collapsed)) return true;
    }

    return false;
  }

  // ── 1C. Abuse Tracking ────────────────────────────────

  isTimedOut(phone: string): { timedOut: boolean; remaining: number } {
    const record = this.abuseMap.get(phone);
    if (!record || !record.cooldownUntil) return { timedOut: false, remaining: 0 };

    const remaining = record.cooldownUntil - Date.now();
    if (remaining <= 0) {
      record.cooldownUntil = 0;
      return { timedOut: false, remaining: 0 };
    }

    return { timedOut: true, remaining: Math.ceil(remaining / 60000) };
  }

  recordGibberish(phone: string): AbuseResult {
    this.pruneIfNeeded();
    const now = Date.now();
    let record = this.abuseMap.get(phone);

    if (!record) {
      record = { gibberishCount: 0, profanityCount: 0, lastGibberish: 0, lastProfanity: 0, cooldownUntil: 0 };
      this.abuseMap.set(phone, record);
    }

    // Reset count if 5 min gap
    if (now - record.lastGibberish > 5 * 60 * 1000) {
      record.gibberishCount = 0;
    }

    record.gibberishCount++;
    record.lastGibberish = now;

    if (record.gibberishCount >= 5) {
      record.cooldownUntil = now + 5 * 60 * 1000; // 5 min soft timeout
      return {
        timeout: true,
        warn: false,
        message: "I'll be here when you're ready. Send *Hi* to start fresh. 🙏",
      };
    }

    if (record.gibberishCount >= 3) {
      return {
        timeout: false,
        warn: true,
        message: "I'm having trouble understanding. Try tapping the buttons, or type *help*. 🤔",
      };
    }

    return { timeout: false, warn: false, message: '' };
  }

  recordProfanity(phone: string): AbuseResult {
    this.pruneIfNeeded();
    const now = Date.now();
    let record = this.abuseMap.get(phone);

    if (!record) {
      record = { gibberishCount: 0, profanityCount: 0, lastGibberish: 0, lastProfanity: 0, cooldownUntil: 0 };
      this.abuseMap.set(phone, record);
    }

    record.profanityCount++;
    record.lastProfanity = now;

    if (record.profanityCount >= 5) {
      record.cooldownUntil = now + 30 * 60 * 1000; // 30 min cooldown
      return {
        timeout: true,
        warn: false,
        message: "I'm going to take a short break. You can message again in 30 minutes. 🙏",
      };
    }

    if (record.profanityCount >= 3) {
      return {
        timeout: false,
        warn: true,
        message: "I want to help, but let's keep things friendly. What can I assist you with? 🙏",
      };
    }

    // First 1-2 offenses: don't block, just note it
    return {
      timeout: false,
      warn: false,
      message: '',
    };
  }

  resetAbuse(phone: string): void {
    this.abuseMap.delete(phone);
  }

  getCooldownRemaining(phone: string): number {
    const record = this.abuseMap.get(phone);
    if (!record || !record.cooldownUntil) return 0;
    return Math.max(0, Math.ceil((record.cooldownUntil - Date.now()) / 60000));
  }

  private pruneIfNeeded(): void {
    if (this.abuseMap.size <= 1000) return;
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.abuseMap.forEach((record, phone) => {
      if (record.lastGibberish < oneHourAgo && record.lastProfanity < oneHourAgo) {
        this.abuseMap.delete(phone);
      }
    });
  }

  // ── 1D. Contextual Help ───────────────────────────────

  getContextualHelp(currentStep: string): string {
    return STEP_HELP[currentStep] || "Type *help* to see what I can do, or send *Hi* to start over.";
  }

  getHelpText(isStandalone: boolean, restaurantName?: string, alias?: string): string {
    const name = alias || 'Waaiio Bot';
    const lines = [
      `*${name}* can help you with:`,
      '',
      '📋 *Book / Order / Pay* — get started',
      '📋 *My bookings* — view & manage',
      '📄 *My history* — download all past transactions',
      '🧾 *Receipt* — get your last receipt',
      '❌ *Cancel booking* — cancel',
      '📍 *Location* — get directions',
      '💰 *Pricing* — learn about fees',
      '🙋 *Talk to human* — speak with a team member',
    ];

    if (!isStandalone) {
      lines.push('🔍 *Browse businesses* — explore options');
    }

    lines.push('', '🔄 Send *Hi* to start over anytime.');
    return lines.join('\n');
  }

  // ── 1E. Persona ───────────────────────────────────────

  getPersonaGreeting(alias: string | null, businessName: string, categoryEmoji?: string): string {
    const emoji = categoryEmoji || '✨';
    if (alias) {
      return `Hi! I'm ${alias}, your assistant at ${businessName}. ${emoji} How can I help?`;
    }
    return `Welcome to ${businessName}! ${emoji} How can we serve you today?`;
  }
}
