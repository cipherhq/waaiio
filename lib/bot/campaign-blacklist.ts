/**
 * Blacklisted keywords that cannot be used for campaigns.
 * These overlap with system intents, escape words, or common bot commands.
 */
export const CAMPAIGN_BLACKLISTED_KEYWORDS: string[] = [
  // Greetings
  'hi', 'hello', 'hey', 'yo', 'howdy', 'sup',
  // Help / support
  'help', 'support',
  // Booking / scheduling
  'book', 'appointment', 'schedule', 'reserve',
  // Orders
  'order', 'buy', 'purchase',
  // Status / history
  'status', 'track', 'history',
  // Receipts / invoices
  'receipt', 'invoice',
  // Menu / services
  'menu', 'services',
  // Pricing
  'price', 'cost',
  // Hours / location
  'hours', 'open', 'location', 'address',
  // Gratitude
  'thanks', 'thank',
  // Check-in
  'checkin',
  // Escalation
  'escalate', 'human', 'agent',
  // Escape / cancel words
  'cancel', 'exit', 'quit', 'stop', 'end',
  // Restart / navigation
  'restart', 'start', 'back', 'home', 'options',
];

/**
 * Check if a keyword is blacklisted for campaign use (case-insensitive).
 */
export function isCampaignKeywordBlacklisted(keyword: string): boolean {
  return CAMPAIGN_BLACKLISTED_KEYWORDS.includes(keyword.toLowerCase().trim());
}
