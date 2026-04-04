// ── Types ──────────────────────────────────────────────

export type BotIntent =
  | 'greeting'
  | 'help'
  | 'booking'
  | 'cancel'
  | 'status'
  | 'menu'
  | 'pricing'
  | 'hours'
  | 'location'
  | 'thanks';

interface IntentRule {
  intent: BotIntent;
  patterns: RegExp[];
  /** Step to navigate to, or null for info-only response */
  action: string | null;
  response: string | null;
}

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

// ── Free-text steps where we should NOT fire intents ───

const FREE_TEXT_STEPS = new Set([
  'collect_name',
  'collect_other_name',
  'collect_email',
  'special_requests',
  'review_text',
  'enter_amount',
  'collect_address',
]);

// ── Intent rules (scored by specificity) ───────────────

const INTENT_RULES: IntentRule[] = [
  {
    intent: 'cancel',
    patterns: [/\bcancel\s*(my\s*)?(booking|reservation)\b/i],
    action: 'bookings',
    response: null,
  },
  {
    intent: 'status',
    patterns: [
      /\b(my\s+booking|check\s+booking|booking\s+status|where'?s?\s+my\s+booking)\b/i,
      /^status$/i,
    ],
    action: 'bookings',
    response: null,
  },
  {
    intent: 'booking',
    patterns: [/\b(book|reserve|table|reservation|appointment|order|buy|ticket|pay|donate)\b/i],
    action: 'city_selection',
    response: "Let's get you started! 🎉",
  },
  {
    intent: 'help',
    patterns: [
      /^help$/i,
      /\b(what can you do|how does this work|options)\b/i,
    ],
    action: 'help',
    response: null,
  },
  {
    intent: 'greeting',
    patterns: [
      /^(hello|hi|hey|yo|howdy)$/i,
      /^good\s+(morning|afternoon|evening)$/i,
    ],
    action: 'restart',
    response: null,
  },
  {
    intent: 'menu',
    patterns: [/\b(menu|food|what do you serve|dishes)\b/i],
    action: null,
    response: 'You can check the menu once you select a restaurant. \ud83c\udf7d\ufe0f',
  },
  {
    intent: 'pricing',
    patterns: [/\b(price|cost|how much|deposit|fee|expensive|cheap)\b/i],
    action: null,
    response: 'Deposit amounts vary by restaurant. Most are free to book! \ud83d\udcb0',
  },
  {
    intent: 'hours',
    patterns: [/\b(hours|opening|closing|when are you open)\b/i],
    action: null,
    response: "Opening hours depend on the restaurant. Let's pick one first! \ud83d\udd50",
  },
  {
    intent: 'location',
    patterns: [/\b(where|address|directions|map|location)\b/i],
    action: null,
    response: "I'll send directions after you book! Let's get you a table first. \ud83d\udccd",
  },
  {
    intent: 'thanks',
    patterns: [
      /^(thanks|thank\s*you|cheers)$/i,
      /^(cool|great|okay|ok|nice),?\s*(thanks|thank\s*you|cheers)$/i,
    ],
    action: 'acknowledge',
    response: null,
  },
];

const THANKS_RESPONSES = [
  "You're welcome! \ud83d\ude0a",
  'Happy to help! \ud83c\udf7d\ufe0f',
  'Anytime! \ud83d\ude0a',
  'Glad I could help! \ud83d\ude4f',
];

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
  city_selection: 'Tap *Choose City* to pick where you\'d like to dine. \ud83c\udfd9\ufe0f',
  neighborhood_selection: 'Tap *Choose Area* to select a neighborhood. \ud83d\udccd',
  restaurant_selection: 'Tap *Choose Restaurant* to pick where to eat. \ud83c\udf7d\ufe0f',
  date_selection: 'Tap *Choose Date* to select when you\'d like to dine. \ud83d\udcc5',
  time_selection: 'Tap *Choose Time* to pick your preferred slot. \ud83d\udd50',
  party_size: 'Type a number (e.g. *4*) or tap a button for guest count. \ud83d\udc65',
  confirmation: 'Tap *Confirm* to book, *Add Request* for special requests, or *For Someone* to book for a friend. \u2705',
  special_requests: 'Tap a quick option or type your own request. \ud83d\udcdd',
  book_for_other: 'Tap *Myself* or *Someone else*. \ud83d\udc64',
  collect_name: 'Type your full name (e.g. *Ade Johnson*). \u270d\ufe0f',
  collect_other_name: "Type the guest's name. \u270d\ufe0f",
  collect_other_phone: "Type the guest's WhatsApp number or *skip*. \ud83d\udcf1",
  collect_email: 'Type your email or tap *Skip*. \ud83d\udce7',
  payment: "Tap *I've Paid* after completing payment. \ud83d\udcb3",
  my_bookings: 'Tap a booking to manage it, or send *Hi* to make a new one.',
  modify_booking: 'Tap *Cancel*, *Change Date/Time*, or *Back*.',
  review_text: 'Type your comment or tap *No thanks* to skip. \u270d\ufe0f',
  // Flow engine steps
  select_service: 'Tap *Choose* to select a service. 📌',
  select_date: 'Tap *Choose Date* to select when. 📅',
  select_time: 'Tap *Choose Time* to pick your slot. 🕐',
  select_quantity: 'Type a number or tap a button. 👥',
  select_category: 'Tap to select a payment category. 📋',
  enter_amount: 'Type the amount. \ud83d\udcb0',
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
};

// ── Service ─────────────────────────────────────────────

export class BotIntelligenceService {
  private readonly abuseMap = new Map<string, AbuseRecord>();

  // ── 1A. Intent Detection ──────────────────────────────

  detectIntent(text: string, currentStep: string): IntentResult | null {
    // Don't fire intents on free-text input steps
    if (FREE_TEXT_STEPS.has(currentStep)) return null;

    const normalized = text.toLowerCase().trim();

    // Special case: bare numbers 1-5 in review_text step -> treat as rating
    if (currentStep === 'review_text' && /^[1-5]$/.test(normalized)) {
      return null; // let the handler deal with it
    }

    for (const rule of INTENT_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(normalized)) {
          let response = rule.response;
          if (rule.intent === 'thanks') {
            response = THANKS_RESPONSES[Math.floor(Math.random() * THANKS_RESPONSES.length)];
          }
          return { intent: rule.intent, action: rule.action, response };
        }
      }
    }

    return null;
  }

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
        message: "I'll be here when you're ready. Send *Hi* to start fresh. \ud83d\ude4f",
      };
    }

    if (record.gibberishCount >= 3) {
      return {
        timeout: false,
        warn: true,
        message: "I'm having trouble understanding. Try tapping the buttons, or type *help*. \ud83e\udd14",
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

    if (record.profanityCount >= 4) {
      record.cooldownUntil = now + 30 * 60 * 1000; // 30 min cooldown
      return {
        timeout: true,
        warn: false,
        message: "I'm going to take a short break. You can message again in 30 minutes. \ud83d\ude4f",
      };
    }

    if (record.profanityCount >= 2) {
      return {
        timeout: false,
        warn: true,
        message: "I want to help, but let's keep things friendly. What can I assist you with? \ud83d\ude4f",
      };
    }

    return {
      timeout: false,
      warn: false,
      message: "I understand you may be frustrated. I'm here to help you book a great dining experience. \ud83d\ude0a",
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
    const name = alias || 'SmrtRply Bot';
    const lines = [
      `*${name}* can help you with:`,
      '',
      '📋 *Book / Order / Pay* — get started',
      '📋 *My bookings* — view & manage',
      '❌ *Cancel booking* — cancel',
      '📍 *Location* — get directions',
      '💰 *Pricing* — learn about fees',
    ];

    if (!isStandalone) {
      lines.push('🔍 *Browse businesses* — explore options');
    }

    lines.push('', '\ud83d\udd04 Send *Hi* to start over anytime.');
    return lines.join('\n');
  }

  // ── 1E. Persona ───────────────────────────────────────

  getPersonaGreeting(alias: string | null, restaurantName: string): string {
    if (alias) {
      return `Hi! I'm ${alias}, your booking assistant at ${restaurantName}. \ud83c\udf7d\ufe0f How can I help?`;
    }
    return `Welcome to ${restaurantName}! \ud83c\udf7d\ufe0f\n\nLet's book you a table.`;
  }
}
