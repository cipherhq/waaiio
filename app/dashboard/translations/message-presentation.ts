/**
 * Human-readable presentation metadata for business-editable bot message keys.
 *
 * This is a page-local helper for the Bot Text editor (#753 item 6).
 * It does NOT duplicate the localization engine — it provides display labels,
 * context descriptions, and placeholder explanations so nontechnical merchants
 * understand what each message does.
 *
 * Keys not listed here fall back to a formatted version of the raw key.
 */

export interface MessagePresentation {
  /** Human-readable name shown as the primary label. */
  label: string;
  /** Brief description of when/where this message appears. */
  context: string;
  /** Explanation of placeholder tokens, if any. */
  placeholders?: Record<string, string>;
  /** Character limit note (for WhatsApp button/list titles). */
  charLimit?: number;
  /** What the limit applies to (button title, list title). */
  charLimitType?: 'button' | 'list';
}

/**
 * Presentation data keyed by message key.
 * Only editable keys need entries — platform-only keys are not shown.
 */
export const MESSAGE_PRESENTATION: Record<string, MessagePresentation> = {
  // ── Menu ──────────────────────────────────────────────────────
  'menu.what_to_do': {
    label: 'Menu prompt',
    context: 'Shown when the customer first opens the menu.',
  },
  'menu.title': {
    label: 'Menu title',
    context: 'Title of the WhatsApp menu list.',
    charLimit: 24,
    charLimitType: 'list',
  },
  'menu.still_setting_up': {
    label: 'Business not ready',
    context: 'Shown when your business has no features enabled yet.',
  },
  'menu.how_can_help': {
    label: 'How can I help?',
    context: 'Greeting prompt when the menu is shown.',
  },
  'menu.no_promotions': {
    label: 'No promotions',
    context: 'Shown when there are no active promotions.',
  },
  'menu.no_waivers': {
    label: 'No waivers',
    context: 'Shown when there are no waivers available.',
  },
  'menu.what_next': {
    label: 'What next?',
    context: 'Prompt shown after completing an action.',
  },

  // ── Language picker ───────────────────────────────────────────
  'lang.picker_body': {
    label: 'Language picker text',
    context: 'Prompt asking the customer to choose their language.',
  },
  'lang.picker_button': {
    label: 'Language picker button',
    context: 'Button label for opening the language picker.',
    charLimit: 20,
    charLimitType: 'button',
  },
  'lang.picker_confirmed': {
    label: 'Language confirmed',
    context: 'Confirmation after the customer selects a language.',
    placeholders: { langName: 'The selected language name' },
  },

  // ── Greetings ─────────────────────────────────────────────────
  'greeting.chat_with_us': {
    label: 'Chat with us button',
    context: 'Button label to start a live chat.',
    charLimit: 20,
    charLimitType: 'button',
  },
  'greeting.cancel_hint': {
    label: 'Cancel hint',
    context: 'Subtle hint telling the customer how to cancel.',
  },
  'greeting.welcome_back': {
    label: 'Welcome back',
    context: 'Greeting for returning customers.',
  },
  'greeting.welcome_back_named': {
    label: 'Welcome back (with name)',
    context: 'Greeting for returning customers whose name is known.',
    placeholders: { name: "Customer's name" },
  },

  // ── Capability / menu option labels ───────────────────────────
  'cap.scheduling': {
    label: 'Services menu item',
    context: 'Menu option for browsing and booking your services.',
  },
  'cap.appointment': {
    label: 'Book Appointment',
    context: 'Menu option for booking an appointment.',
  },
  'cap.appointment.restaurant': {
    label: 'Book a Table',
    context: 'Menu option for restaurant table booking.',
  },
  'cap.appointment.event_services': {
    label: 'Book a Service (events)',
    context: 'Menu option for event service booking.',
  },
  'cap.appointment.photographer': {
    label: 'Book a Session (photography)',
    context: 'Menu option for photography session booking.',
  },
  'cap.appointment.gym': {
    label: 'Book a Session (gym)',
    context: 'Menu option for gym session booking.',
  },
  'cap.appointment.tutor': {
    label: 'Book a Session (tutoring)',
    context: 'Menu option for tutoring session booking.',
  },
  'cap.appointment.coworking': {
    label: 'Book a Space',
    context: 'Menu option for coworking space booking.',
  },
  'cap.appointment.car_wash': {
    label: 'Book a Wash',
    context: 'Menu option for car wash booking.',
  },
  'cap.giving': {
    label: 'Give',
    context: 'Menu option for giving / donations.',
  },
  'cap.payment': {
    label: 'Make Payment',
    context: 'Menu option for making a payment.',
  },
  'cap.ordering': {
    label: 'Place an Order',
    context: 'Menu option for placing an order.',
  },
  'cap.ticketing': {
    label: 'Buy Tickets',
    context: 'Menu option for buying event tickets.',
  },
  'cap.reservation': {
    label: 'Book a Stay',
    context: 'Menu option for booking accommodation.',
  },
  'cap.table_reservation': {
    label: 'Make a Reservation',
    context: 'Menu option for making a reservation.',
  },
  'cap.crowdfunding': {
    label: 'Support a Campaign',
    context: 'Menu option for campaign donations.',
  },
  'cap.reminders': {
    label: 'My Reminders',
    context: 'Menu option for viewing reminders.',
  },
  'cap.chat': {
    label: 'Chat with Us',
    context: 'Menu option to start live chat.',
  },
  'cap.waitlist': {
    label: 'Join Waitlist',
    context: 'Menu option to join a waitlist.',
  },
  'cap.queue': {
    label: 'Join Queue',
    context: 'Menu option to join a queue.',
  },
  'cap.loyalty': {
    label: 'My Rewards',
    context: 'Menu option for loyalty rewards.',
  },
  'cap.invoice': {
    label: 'My Invoices',
    context: 'Menu option for viewing invoices.',
  },
  'cap.waiver': {
    label: 'Sign Waiver',
    context: 'Menu option for signing a waiver.',
  },
  'cap.class_booking': {
    label: 'Book a Class',
    context: 'Menu option for class booking.',
  },
  'cap.promo_verification': {
    label: 'Instant Win',
    context: 'Menu option for promotion verification.',
  },
  'cap.my_account': {
    label: 'My Account',
    context: 'Menu option for the customer account section.',
  },
};

/**
 * Get the human-readable label for a message key.
 * Falls back to a formatted version of the raw key.
 */
export function getMessageLabel(key: string): string {
  const entry = MESSAGE_PRESENTATION[key];
  if (entry) return entry.label;
  // Format raw key: "cap.appointment.gym" -> "Appointment gym"
  const parts = key.split('.');
  // Drop the prefix (cap, menu, greeting, lang, etc.)
  const rest = parts.slice(1).join(' ').replace(/_/g, ' ');
  return rest.charAt(0).toUpperCase() + rest.slice(1) || key;
}

/**
 * Get the context description for a message key.
 */
export function getMessageContext(key: string): string {
  return MESSAGE_PRESENTATION[key]?.context || '';
}

/**
 * Get placeholder explanations for a message key.
 */
export function getPlaceholderHelp(key: string): Record<string, string> | undefined {
  return MESSAGE_PRESENTATION[key]?.placeholders;
}

/**
 * Get character limit info for a key, if applicable.
 */
export function getCharLimit(key: string): { limit: number; type: 'button' | 'list' } | undefined {
  const entry = MESSAGE_PRESENTATION[key];
  if (entry?.charLimit && entry?.charLimitType) {
    return { limit: entry.charLimit, type: entry.charLimitType };
  }
  return undefined;
}
