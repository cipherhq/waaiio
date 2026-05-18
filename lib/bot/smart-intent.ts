/**
 * Smart Intent Parser — extracts structured data from natural language
 * messages including Pidgin English, Yoruba, Hausa, Igbo, and Twi.
 *
 * No external API needed — pure regex-based entity extraction.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyWithLLM } from './llm-intent';
import { logClassification } from './classification-logger';
import { isFeatureEnabledServer, FLAGS } from '@/lib/posthog/flags';

// ── Types ────────────────────────────────────────────────

export interface SmartParseResult {
  understood: boolean;
  intent: 'booking' | 'ordering' | 'payment' | 'ticketing' | null;
  serviceKeywords: string[];
  date: string | null;          // YYYY-MM-DD
  timePreference: 'morning' | 'afternoon' | 'evening' | null;
  specificTime: string | null;  // HH:MM
  quantity: number | null;
  amount: number | null;        // Extracted amount (e.g., 5000 from "pay tithe 5000")
  variantKeywords: string[];    // Size/variant hints (e.g., "large", "medium", "small")
}

// ── Intent patterns ──────────────────────────────────────

const BOOKING_PATTERNS = [
  // English
  /\b(book|reserve|appointment|schedule|check[\s-]*in|register)\b/i,
  // Service-specific (implies booking across industries)
  /\b(barb|haircut|cut\s*hair|trim|shave|braid|perm|manicure|pedicure|massage|facial|consult|checkup|check[\s-]*up)\b/i,
  /\b(room|lodge|hotel|stay|check[\s-]*in|parking|park\s*my\s*car)\b/i,
  /\b(viewing|inspect|tour)\b.*\b(house|flat|apartment|property)\b/i,
  /\b(gym|workout|exercise|fitness|train)\b/i,
  /\b(vet|veterinary|my\s*dog|my\s*cat|my\s*pet)\b/i,
  /\b(tattoo|ink|piercing)\b/i,
  /\b(photo|shoot|portrait|session)\b/i,
  /\b(lesson|tutor|class|learn)\b/i,
  /\b(desk|cowork|workspace)\b/i,
  // Pidgin — universal
  /\b(wan|want|need)\b.*\b(barb|cut|trim|book|see|visit|come|do|lodge|stay|park|fix|wash|clean)\b/i,
  /\b(abeg|pls|please|biko|jowo)\b.*\b(book|barb|cut|help|fix|reserve|lodge|register|wash)\b/i,
  /\b(make\s*i|lemme|let\s*me)\b.*\b(book|come|see|barb|cut|lodge|register|check[\s-]*in)\b/i,
  /\bi\s+wan\b/i,
  // Pidgin — industry-specific
  /\b(i\s*wan|abeg)\b.*\b(lodge|sleep|stay|rest)\b/i,        // hotel
  /\b(i\s*wan|abeg)\b.*\b(wash|clean|iron)\b.*\b(cloth|car)\b/i, // laundry / car wash
  /\b(i\s*wan|abeg)\b.*\b(see\s*doctor|go\s*hospital|treat)\b/i, // clinic
  /\b(i\s*wan|abeg)\b.*\b(learn|teach|school)\b/i,            // tutor
  /\b(i\s*wan|abeg)\b.*\b(gym|exercise|work\s*out)\b/i,       // gym
  /\b(i\s*wan|abeg)\b.*\b(tattoo|ink|pierce)\b/i,             // tattoo
];

const ORDERING_PATTERNS = [
  // English
  /\b(order|buy|purchase|deliver|delivery|send|ship)\b/i,
  /\b(chop|eat|food|hungry|menu)\b/i,
  /\b(drug|medicine|refill|prescription)\b/i,                   // pharmacy
  // Pidgin — food
  /\b(wan|want)\b.*\b(chop|eat|order|buy|food)\b/i,
  /\b(abeg|pls|biko)\b.*\b(order|buy|bring|send|deliver)\b/i,
  /\b(i\s*wan|make\s*i)\b.*\b(chop|eat|order|buy)\b/i,
  /\b(bring\s*food|send\s*food|bring\s*am)\b/i,
  /\b(wetin\s*una\s*dey\s*sell|wetin\s*dey\s*menu)\b/i,        // "what do you sell?"
  // Pidgin — pharmacy / shop
  /\b(i\s*wan|abeg)\b.*\b(buy|get|collect)\b.*\b(drug|medicine|paracetamol)\b/i,
  /\b(i\s*wan|abeg)\b.*\b(buy|order|get)\b/i,
];

const PAYMENT_PATTERNS = [
  // English — general
  /\b(pay|dues|fee|levy|bill|invoice|renew|subscription)\b/i,
  // Church-specific
  /\b(tithe|offering|donate|donation)\b/i,
  /\b(sow\s*seed|sow\s*a?\s*seed|first\s*fruit|thanksgiving\s*offering)\b/i,
  /\b(building\s*fund|project\s*fund|welfare|harvest\s*seed|covenant\s*seed)\b/i,
  // Mosque-specific
  /\b(zakat|sadaqah|sadaka|fitrah|fidyah|kaffara|waqf|lillah|infaq)\b/i,
  // School-specific
  /\b(school\s*fee|tuition|pta\s*levy|exam\s*fee|registration\s*fee)\b/i,
  // Government / utility
  /\b(tax|fine|license|permit|renewal|utility)\b/i,
  // Pidgin — universal payment
  /\b(wan|want)\b.*\b(pay|give|donate|sow|settle|clear)\b/i,
  /\b(abeg|pls|biko|jowo)\b.*\b(pay|tithe|offering|seed|donate|give|settle)\b/i,
  /\b(i\s*wan|make\s*i)\b.*\b(pay|tithe|offering|seed|give|sow|donate|settle|clear)\b/i,
  // Pidgin — specific
  /\b(i\s*wan|abeg)\b.*\b(pay\s*school|pay\s*fee|settle\s*bill)\b/i,
  /\b(i\s*wan|abeg)\b.*\b(renew|subscribe)\b/i,
];

const TICKETING_PATTERNS = [
  // English
  /\b(ticket|event|show|concert|movie|film|cinema|gig|festival)\b/i,
  /\b(bus|train|flight|ride|transport)\b.*\b(ticket|book)\b/i,
  // Pidgin
  /\b(wan|want)\b.*\b(ticket|attend|go\s*to|see\s*show|watch)\b/i,
  /\b(i\s*wan|abeg|make\s*i)\b.*\b(ticket|go|attend|watch|see\s*movie)\b/i,
  /\b(abeg)\b.*\b(ticket|movie|show|film|concert)\b/i,
];

// ── Date extraction ──────────────────────────────────────

function extractDate(text: string): string | null {
  const lower = text.toLowerCase();
  const now = new Date();

  // "today" / "2day"
  if (/\b(today|2day|todey)\b/.test(lower)) {
    return now.toISOString().split('T')[0];
  }

  // "tomorrow" / pidgin & slang
  if (/\b(tomorrow|2moro|2morrow|tmrw|tmr|2mr|2mrw)\b/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }

  // "day after tomorrow"
  if (/\b(day after tomorrow)\b/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return d.toISOString().split('T')[0];
  }

  // Day names: "monday", "next friday", "this saturday", "coming wednesday"
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayMatch = lower.match(
    /\b(next\s+)?(this\s+)?(coming\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  );
  if (dayMatch) {
    const targetDay = days.indexOf(dayMatch[4]);
    const currentDay = now.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    if (dayMatch[1]) daysUntil += 7; // "next X"
    const d = new Date(now);
    d.setDate(d.getDate() + daysUntil);
    return d.toISOString().split('T')[0];
  }

  // "next week" → next monday
  if (/\bnext\s*week\b/.test(lower)) {
    const currentDay = now.getDay();
    const daysUntilMonday = ((1 - currentDay + 7) % 7) || 7;
    const d = new Date(now);
    d.setDate(d.getDate() + daysUntilMonday + 7);
    return d.toISOString().split('T')[0];
  }

  // ISO date: "2026-04-10"
  const isoMatch = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  return null;
}

// ── Time extraction ──────────────────────────────────────

function extractTime(text: string): { specific: string | null; preference: 'morning' | 'afternoon' | 'evening' | null } {
  const lower = text.toLowerCase();

  // Specific: "3pm", "3:30pm", "3:00 pm"
  const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const minutes = timeMatch[2] || '00';
    const period = timeMatch[3].replace(/\./g, '');
    if (period === 'pm' && hours < 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
    return { specific: `${hours.toString().padStart(2, '0')}:${minutes}`, preference: null };
  }

  // 24h: "15:00"
  const time24 = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (time24) {
    return { specific: `${time24[1].padStart(2, '0')}:${time24[2]}`, preference: null };
  }

  // "by 3" / "at 3" / "around 3" (assume PM if 1-7)
  const byMatch = lower.match(/\b(?:by|at|around|for)\s+(\d{1,2})(?:\s*o'?clock)?\b(?!\s*(?:people|person|guest|pax|am|pm))/);
  if (byMatch) {
    let h = parseInt(byMatch[1]);
    if (h >= 1 && h <= 7) h += 12; // assume PM
    if (h >= 8 && h <= 23) {
      return { specific: `${h.toString().padStart(2, '0')}:00`, preference: null };
    }
  }

  // Preferences
  if (/\b(morning|for\s+morning|morn)\b/.test(lower)) {
    return { specific: null, preference: 'morning' };
  }
  if (/\b(afternoon|for\s+afternoon)\b/.test(lower)) {
    return { specific: null, preference: 'afternoon' };
  }
  if (/\b(evening|night|for\s+evening|for\s+night)\b/.test(lower)) {
    return { specific: null, preference: 'evening' };
  }

  return { specific: null, preference: null };
}

// ── Quantity extraction ──────────────────────────────────

function extractQuantity(text: string): number | null {
  const lower = text.toLowerCase();

  // "for 3 people/guests/pax"
  const numMatch = lower.match(/\b(?:for\s+)?(\d+)\s*(?:people|person|persons|guests?|pax|of\s+us)\b/);
  if (numMatch) return Math.min(parseInt(numMatch[1]), 20);

  // Pidgin: "we dey 4" / "we are 4" / "we be 4"
  const pidginMatch = lower.match(/\bwe\s+(?:dey|are|be)\s+(\d+)\b/);
  if (pidginMatch) return Math.min(parseInt(pidginMatch[1]), 20);

  // Word numbers: "for two", "for three"
  const wordNums: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const wordMatch = lower.match(
    /\bfor\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/,
  );
  if (wordMatch && wordNums[wordMatch[1]]) return wordNums[wordMatch[1]];

  return null;
}

// ── Amount extraction ──────────────────────────────────

function extractAmount(text: string): number | null {
  const lower = text.toLowerCase().replace(/,/g, '');

  // "pay 5000", "tithe 10000", "give 500", "donate 2000"
  const amountMatch = lower.match(/\b(?:pay|tithe|offering|give|donate|sow|send|transfer)\s+(?:of\s+)?[\u20a6\u00a3$]?\s*(\d+(?:\.\d{1,2})?)\b/);
  if (amountMatch) return parseFloat(amountMatch[1]);

  // "5000 tithe", "10000 offering", "$500"
  const prefixMatch = lower.match(/[\u20a6\u00a3$]\s*(\d+(?:\.\d{1,2})?)/);
  if (prefixMatch) return parseFloat(prefixMatch[1]);

  // "5000 naira", "500 dollars"
  const currMatch = lower.match(/(\d+(?:\.\d{1,2})?)\s*(?:naira|cedis?|dollars?|pounds?|usd|ngn|ghs|gbp|cad)\b/);
  if (currMatch) return parseFloat(currMatch[1]);

  return null;
}

// ── Variant keyword extraction ──────────────────────────

function extractVariantKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const variants: string[] = [];

  // Size keywords
  const sizeMatch = lower.match(/\b(small|medium|large|x-?large|xl|xxl|xs|extra[\s-]?large|extra[\s-]?small|regular|mini|big|tall|grande|venti)\b/gi);
  if (sizeMatch) variants.push(...sizeMatch.map(s => s.toLowerCase()));

  // Color keywords
  const colorMatch = lower.match(/\b(red|blue|green|black|white|pink|yellow|purple|orange|brown|grey|gray|gold|silver)\b/gi);
  if (colorMatch) variants.push(...colorMatch.map(s => s.toLowerCase()));

  // Spice/flavor
  const flavorMatch = lower.match(/\b(mild|spicy|hot|extra[\s-]?hot|sweet|sour|plain|original|classic)\b/gi);
  if (flavorMatch) variants.push(...flavorMatch.map(s => s.toLowerCase()));

  return [...new Set(variants)];
}

// ── Service keyword extraction ───────────────────────────

function extractServiceKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const keywords: string[] = [];

  const servicePatterns: Array<{ pattern: RegExp; keywords: string[] }> = [
    // ── Barbershop / Salon ──
    { pattern: /\b(barb|haircut|cut\s*hair|trim|shape[\s-]*up|fade|low[\s-]*cut)\b/, keywords: ['haircut', 'hair', 'cut', 'trim', 'barb', 'fade'] },
    { pattern: /\b(braid|braids|cornrow|weave|wig|locs|dreadlocks?|twist)\b/, keywords: ['braid', 'cornrow', 'weave', 'wig', 'locs'] },
    { pattern: /\b(shave|beard|goatee)\b/, keywords: ['shave', 'beard'] },
    { pattern: /\b(manicure|nails?|pedicure|gel|acrylic)\b/, keywords: ['manicure', 'pedicure', 'nail'] },
    { pattern: /\b(grooming|groom)\b/, keywords: ['grooming', 'groom'] },
    { pattern: /\b(wax|waxing)\b/, keywords: ['wax'] },
    { pattern: /\b(lash|lashes|eyelash)\b/, keywords: ['lash', 'eyelash'] },
    { pattern: /\b(makeup|make[\s-]*up)\b/, keywords: ['makeup'] },
    { pattern: /\b(relaxer|perm|texturizer)\b/, keywords: ['relaxer', 'perm'] },
    { pattern: /\b(hair\s*color|dye|highlight|tint)\b/, keywords: ['color', 'dye', 'highlight'] },

    // ── Spa / Wellness ──
    { pattern: /\b(massage|spa|relax|body\s*work)\b/, keywords: ['massage', 'spa', 'relax'] },
    { pattern: /\b(facial|skin\s*care|face\s*treatment)\b/, keywords: ['facial', 'skin'] },
    { pattern: /\b(sauna|steam|jacuzzi|hot\s*tub)\b/, keywords: ['sauna', 'steam'] },
    { pattern: /\b(body\s*scrub|exfoliat)\b/, keywords: ['body scrub', 'scrub'] },

    // ── Health / Medical ──
    { pattern: /\b(consult|consultation|checkup|check[\s-]*up|see\s*doctor)\b/, keywords: ['consult', 'checkup', 'consultation'] },
    { pattern: /\b(dental|tooth|teeth|dentist|cleaning)\b/, keywords: ['dental', 'teeth', 'cleaning'] },
    { pattern: /\b(eye\s*test|optician|glasses|vision)\b/, keywords: ['eye test', 'vision'] },
    { pattern: /\b(physio|therapy|rehab)\b/, keywords: ['physiotherapy', 'therapy'] },
    { pattern: /\b(x[\s-]*ray|scan|lab\s*test|blood\s*test)\b/, keywords: ['x-ray', 'scan', 'lab test'] },

    // ── Veterinary ──
    { pattern: /\b(vet|veterinary|animal)\b/, keywords: ['vet', 'veterinary'] },
    { pattern: /\b(my\s*dog|my\s*cat|my\s*pet|puppy|kitten)\b/, keywords: ['pet', 'dog', 'cat'] },
    { pattern: /\b(vaccination|deworm|neuter|spay)\b/, keywords: ['vaccination', 'deworm'] },
    { pattern: /\b(pet\s*grooming)\b/, keywords: ['pet grooming', 'grooming'] },

    // ── Gym / Fitness ──
    { pattern: /\b(gym|workout|exercise|fitness|train|personal\s*train)\b/, keywords: ['gym', 'fitness', 'workout', 'training'] },
    { pattern: /\b(yoga|pilates|aerobics|zumba|spin|crossfit)\b/, keywords: ['yoga', 'pilates', 'aerobics', 'class'] },
    { pattern: /\b(membership|monthly\s*plan)\b/, keywords: ['membership', 'plan'] },

    // ── Tattoo / Body Art ──
    { pattern: /\b(tattoo|ink|tat)\b/, keywords: ['tattoo', 'ink'] },
    { pattern: /\b(piercing|pierce|ear\s*pierce|nose\s*ring)\b/, keywords: ['piercing'] },

    // ── Laundry / Dry Cleaning ──
    { pattern: /\b(laundry|dry[\s-]*clean|wash\s*cloth|iron|press)\b/, keywords: ['laundry', 'dry clean', 'wash', 'iron'] },
    { pattern: /\b(wash\s*my\s*cloth|clean\s*my\s*cloth|iron\s*my)\b/, keywords: ['laundry', 'wash', 'iron'] },

    // ── Car Wash / Auto ──
    { pattern: /\b(car[\s-]*wash|wash\s*car|wash\s*my\s*car|detailing|detail|polish)\b/, keywords: ['car wash', 'detailing', 'wash'] },
    { pattern: /\b(interior\s*clean|exterior\s*wash|full\s*wash)\b/, keywords: ['interior', 'exterior', 'full wash'] },

    // ── Photography ──
    { pattern: /\b(photo|photography|shoot|portrait|headshot)\b/, keywords: ['photo', 'portrait', 'shoot'] },
    { pattern: /\b(wedding\s*shoot|pre[\s-]*wedding|engagement\s*photo)\b/, keywords: ['wedding', 'pre-wedding'] },
    { pattern: /\b(passport\s*photo|id\s*photo)\b/, keywords: ['passport', 'id photo'] },

    // ── Tutoring / Education ──
    { pattern: /\b(tutor|lesson|class|learn|teach)\b/, keywords: ['tutor', 'lesson', 'class'] },
    { pattern: /\b(math|english|science|physics|chemistry)\b/, keywords: ['math', 'english', 'science'] },
    { pattern: /\b(music\s*lesson|piano|guitar|drum)\b/, keywords: ['music', 'piano', 'guitar'] },

    // ── Hotel / Accommodation ──
    { pattern: /\b(room|lodge|hotel|stay|overnight|check[\s-]*in|suite)\b/, keywords: ['room', 'lodge', 'suite', 'stay'] },
    { pattern: /\b(standard\s*room|deluxe|single\s*room|double\s*room)\b/, keywords: ['standard', 'deluxe', 'single', 'double'] },
    { pattern: /\b(i\s*wan\s*lodge|wan\s*sleep|wan\s*stay)\b/, keywords: ['room', 'lodge', 'stay'] },

    // ── Coworking ──
    { pattern: /\b(desk|cowork|workspace|hot[\s-]*desk|meeting\s*room|office)\b/, keywords: ['desk', 'coworking', 'workspace', 'meeting room'] },

    // ── Real Estate ──
    { pattern: /\b(viewing|view\s*house|inspect|property|house|flat|apartment|land)\b/, keywords: ['viewing', 'property', 'house', 'apartment'] },
    { pattern: /\b(rent|buy\s*house|lease)\b/, keywords: ['rent', 'buy', 'lease'] },

    // ── Restaurant / Food (for ordering flow) ──
    { pattern: /\b(jollof|fried\s*rice|amala|pounded\s*yam|egusi|suya|shawarma|pepper\s*soup)\b/, keywords: ['jollof', 'rice', 'amala', 'suya', 'shawarma'] },
    { pattern: /\b(breakfast|lunch|dinner|brunch)\b/, keywords: ['breakfast', 'lunch', 'dinner'] },
    { pattern: /\b(small\s*chops|grill|bbq|asun|nkwobi)\b/, keywords: ['small chops', 'grill', 'asun'] },
    { pattern: /\b(coffee|tea|juice|smoothie|drink)\b/, keywords: ['coffee', 'tea', 'drink'] },
    { pattern: /\b(cake|pastry|bread|chin[\s-]*chin|puff[\s-]*puff)\b/, keywords: ['cake', 'pastry', 'bread'] },

    // ── Pharmacy ──
    { pattern: /\b(drug|medicine|medication|prescription|refill)\b/, keywords: ['drug', 'medicine', 'prescription'] },
    { pattern: /\b(paracetamol|ibuprofen|vitamin|supplement)\b/, keywords: ['paracetamol', 'vitamin'] },

    // ── Transport / Taxi / Logistics ──
    { pattern: /\b(ride|cab|taxi|uber|bolt|drop)\b/, keywords: ['ride', 'taxi', 'cab'] },
    { pattern: /\b(deliver|delivery|ship|shipping|dispatch|courier)\b/, keywords: ['delivery', 'shipping', 'courier'] },
    { pattern: /\b(send\s*package|pick[\s-]*up|drop[\s-]*off)\b/, keywords: ['pickup', 'dropoff', 'package'] },

    // ── Events / Tickets ──
    { pattern: /\b(ticket|vip|regular|gate|general\s*admission)\b/, keywords: ['ticket', 'vip', 'regular'] },
    { pattern: /\b(concert|show|party|owanbe|owambe|festival)\b/, keywords: ['concert', 'show', 'party', 'festival'] },
    { pattern: /\b(movie|film|cinema|nollywood)\b/, keywords: ['movie', 'film', 'cinema'] },

    // ── Car Park ──
    { pattern: /\b(parking|park\s*my\s*car|car\s*park|lot)\b/, keywords: ['parking', 'park'] },

    // ── Travel ──
    { pattern: /\b(travel|trip|tour|vacation|holiday|visa)\b/, keywords: ['travel', 'trip', 'tour', 'visa'] },
    { pattern: /\b(flight|fly|airline|bus\s*ticket|train\s*ticket)\b/, keywords: ['flight', 'bus', 'train'] },

    // ── Church / Faith ──
    { pattern: /\b(tithe|tith)\b/, keywords: ['tithe'] },
    { pattern: /\b(offering|offerin)\b/, keywords: ['offering'] },
    { pattern: /\b(sow\s*seed|seed\s*sowing|covenant\s*seed|harvest\s*seed|seed)\b/, keywords: ['seed', 'offering', 'donation'] },
    { pattern: /\b(first\s*fruit)\b/, keywords: ['first fruit', 'offering'] },
    { pattern: /\b(thanksgiving|thanks\s*giving)\b/, keywords: ['thanksgiving', 'offering'] },
    { pattern: /\b(building\s*fund|project\s*fund|church\s*project)\b/, keywords: ['building fund', 'project', 'fund'] },
    { pattern: /\b(welfare|benevolence)\b/, keywords: ['welfare'] },
    { pattern: /\b(donation|donate)\b/, keywords: ['donation', 'donate'] },

    // ── Mosque / Islamic ──
    { pattern: /\b(zakat|zakah)\b/, keywords: ['zakat'] },
    { pattern: /\b(sadaqah|sadaqa|sadaka)\b/, keywords: ['sadaqah', 'donation'] },
    { pattern: /\b(fitrah|fitra|zakat[\s-]*al[\s-]*fitr)\b/, keywords: ['fitrah', 'zakat'] },
    { pattern: /\b(fidyah|fidya)\b/, keywords: ['fidyah'] },
    { pattern: /\b(kaffara|kaffarah)\b/, keywords: ['kaffara'] },
    { pattern: /\b(waqf|lillah|infaq)\b/, keywords: ['waqf', 'donation'] },

    // ── School ──
    { pattern: /\b(school\s*fee|tuition|school\s*levy|pta\s*levy|pta\s*dues)\b/, keywords: ['school fee', 'tuition', 'fee'] },
    { pattern: /\b(exam\s*fee|registration\s*fee|form\s*fee)\b/, keywords: ['exam fee', 'registration', 'fee'] },

    // ── Government ──
    { pattern: /\b(tax|fine|license|permit|renewal|levy)\b/, keywords: ['tax', 'fine', 'license', 'permit'] },
    { pattern: /\b(vehicle\s*license|driver'?s?\s*license|business\s*permit)\b/, keywords: ['vehicle license', 'license', 'permit'] },

    // ── Insurance ──
    { pattern: /\b(insurance|policy|premium|cover|hmo)\b/, keywords: ['insurance', 'policy', 'premium', 'hmo'] },

    // ── Crowdfunding / NGO ──
    { pattern: /\b(fundrais|crowd[\s-]*fund|campaign|cause|charity)\b/, keywords: ['fundraise', 'campaign', 'charity'] },
    { pattern: /\b(support|contribute|pledge)\b/, keywords: ['support', 'contribute', 'pledge'] },
  ];

  for (const sp of servicePatterns) {
    if (sp.pattern.test(lower)) {
      keywords.push(...sp.keywords);
    }
  }

  return [...new Set(keywords)]; // deduplicate
}

// ── Main parser ──────────────────────────────────────────

export function parseSmartIntent(text: string): SmartParseResult {
  const result: SmartParseResult = {
    understood: false,
    intent: null,
    serviceKeywords: [],
    date: null,
    timePreference: null,
    specificTime: null,
    quantity: null,
  };

  // Detect intent
  if (BOOKING_PATTERNS.some(p => p.test(text))) result.intent = 'booking';
  else if (ORDERING_PATTERNS.some(p => p.test(text))) result.intent = 'ordering';
  else if (PAYMENT_PATTERNS.some(p => p.test(text))) result.intent = 'payment';
  else if (TICKETING_PATTERNS.some(p => p.test(text))) result.intent = 'ticketing';

  // Extract entities
  result.serviceKeywords = extractServiceKeywords(text);
  result.date = extractDate(text);
  const timeResult = extractTime(text);
  result.specificTime = timeResult.specific;
  result.timePreference = timeResult.preference;
  result.quantity = extractQuantity(text);
  result.amount = extractAmount(text);
  result.variantKeywords = extractVariantKeywords(text);

  // Mark understood if anything useful extracted
  result.understood = !!(
    result.intent ||
    result.date ||
    result.specificTime ||
    result.timePreference ||
    result.serviceKeywords.length > 0 ||
    result.quantity ||
    result.amount
  );

  return result;
}

// ── Hybrid intent: regex first, LLM fallback ───────────

export async function parseSmartIntentHybrid(
  text: string,
  businessCategory: string | null,
  supabase: SupabaseClient,
  businessId: string | null,
): Promise<SmartParseResult & { language?: string; llmUsed?: boolean }> {
  // Step 1: Try regex
  const regexResult = parseSmartIntent(text);

  // Check if LLM is enabled via feature flag (defaults to true if PostHog not configured)
  const llmEnabled = businessId
    ? await isFeatureEnabledServer(FLAGS.LLM_INTENT_ENABLED, businessId).catch(() => true)
    : true;

  // Step 2: If regex found a confident intent with service keywords, use it
  if (regexResult.intent && regexResult.serviceKeywords.length > 0) {
    logClassification(supabase, {
      businessId,
      businessCategory,
      userMessage: text,
      detectedIntent: regexResult.intent,
      detectedFlow: regexResult.intent,
      entities: { serviceKeywords: regexResult.serviceKeywords, date: regexResult.date, time: regexResult.specificTime },
      confidence: 1.0,
      language: null,
      regexAttempted: true,
      regexMatched: true,
      llmUsed: false,
      latencyMs: null,
      model: null,
    });
    return regexResult;
  }

  // Step 3: Fall back to LLM (if enabled)
  if (!llmEnabled) return regexResult;

  try {
    const start = Date.now();
    const llmResult = await classifyWithLLM(text, businessCategory);
    const latency = Date.now() - start;

    // Track AI usage (non-blocking)
    if (supabase && businessId) {
      Promise.resolve(supabase.rpc('increment_ai_usage', { p_business_id: businessId, p_call_type: 'intent' })).catch(() => {});
    }

    // Only use LLM result if confidence is reasonable
    if (llmResult.confidence < 0.3) {
      logClassification(supabase, {
        businessId,
        businessCategory,
        userMessage: text,
        detectedIntent: llmResult.flow,
        detectedFlow: llmResult.flow,
        entities: llmResult.entities,
        confidence: llmResult.confidence,
        language: llmResult.language,
        regexAttempted: true,
        regexMatched: !!regexResult.intent,
        llmUsed: true,
        latencyMs: latency,
        model: 'claude-haiku-4-5-20251001',
      });
      // Low confidence — return whatever regex found (possibly empty)
      return regexResult;
    }

    const merged: SmartParseResult = {
      understood: true,
      intent: llmResult.flow,
      serviceKeywords: llmResult.entities.serviceKeywords.length > 0
        ? llmResult.entities.serviceKeywords
        : regexResult.serviceKeywords,
      date: llmResult.entities.date || regexResult.date,
      timePreference: (llmResult.entities.timePreference as SmartParseResult['timePreference']) || regexResult.timePreference,
      specificTime: regexResult.specificTime,
      quantity: llmResult.entities.quantity || regexResult.quantity,
    };

    logClassification(supabase, {
      businessId,
      businessCategory,
      userMessage: text,
      detectedIntent: llmResult.flow,
      detectedFlow: llmResult.flow,
      entities: llmResult.entities,
      confidence: llmResult.confidence,
      language: llmResult.language,
      regexAttempted: true,
      regexMatched: !!regexResult.intent,
      llmUsed: true,
      latencyMs: latency,
      model: 'claude-haiku-4-5-20251001',
    });

    return { ...merged, language: llmResult.language, llmUsed: true };
  } catch {
    // LLM failed — return regex result
    return regexResult;
  }
}

// ── Service matcher ──────────────────────────────────────

type ServiceMatch = { id: string; name: string; price: number; duration_minutes: number | null; deposit_amount: number | null; billing_type: string | null; recurring_interval: string | null };

export async function matchServiceFromKeywords(
  supabase: SupabaseClient,
  businessId: string,
  keywords: string[],
): Promise<ServiceMatch | null> {
  const result = await matchServicesFromKeywords(supabase, businessId, keywords);
  // Only return a single match if unambiguous (1 result)
  return result.length === 1 ? result[0] : null;
}

/** Returns ALL matching services — used for disambiguation when multiple match */
export async function matchServicesFromKeywords(
  supabase: SupabaseClient,
  businessId: string,
  keywords: string[],
): Promise<ServiceMatch[]> {
  if (keywords.length === 0) return [];

  const { data: services } = await supabase
    .from('services')
    .select('id, name, price, duration_minutes, deposit_amount, billing_type, recurring_interval')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .order('sort_order');

  if (!services || services.length === 0) return [];

  // Score each service
  const scored: Array<{ service: (typeof services)[0]; score: number }> = [];

  for (const service of services) {
    const name = service.name.toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (name === kwLower) {
        score += 10; // exact match
      } else if (name.includes(kwLower)) {
        score += 5; // substring match
      } else if (kwLower.includes(name)) {
        score += 3; // reverse substring
      } else {
        const nameWords = name.split(/\s+/);
        for (const nw of nameWords) {
          if (nw === kwLower || kwLower.includes(nw) || nw.includes(kwLower)) {
            score += 2;
          }
        }
      }
    }

    if (score >= 2) scored.push({ service, score });
  }

  if (scored.length === 0) return [];

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0].score;

  // Return all services that tied for the top score
  return scored.filter(s => s.score === topScore).map(s => s.service);
}

// ── Product matching (for ordering flow) ────────────────

type ProductMatch = { id: string; name: string; price: number; has_variants: boolean };

export async function matchProductsFromKeywords(
  supabase: SupabaseClient,
  businessId: string,
  keywords: string[],
): Promise<ProductMatch[]> {
  if (keywords.length === 0) return [];

  const { data: products } = await supabase
    .from('products')
    .select('id, name, price, has_variants')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('sort_order')
    .limit(100);

  if (!products || products.length === 0) return [];

  const scored: Array<{ product: (typeof products)[0]; score: number }> = [];

  for (const product of products) {
    const name = product.name.toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (name === kwLower) {
        score += 10;
      } else if (name.includes(kwLower)) {
        score += 5;
      } else if (kwLower.includes(name)) {
        score += 3;
      } else {
        const nameWords = name.split(/\s+/);
        for (const nw of nameWords) {
          if (nw === kwLower || kwLower.includes(nw) || nw.includes(kwLower)) {
            score += 2;
          }
        }
      }
    }

    if (score >= 2) scored.push({ product, score });
  }

  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0].score;
  return scored.filter(s => s.score === topScore).map(s => s.product);
}

// ── Smart acknowledgment builder ─────────────────────────

export function buildAcknowledgment(
  parsed: SmartParseResult,
  matchedServiceName: string | null,
  countryLocale: string = 'en-US',
): string | null {
  const parts: string[] = [];

  if (matchedServiceName) parts.push(`*${matchedServiceName}*`);

  if (parsed.date) {
    const dateLabel = new Date(parsed.date + 'T00:00').toLocaleDateString(countryLocale, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
    parts.push(`on *${dateLabel}*`);
  }

  if (parsed.timePreference) {
    parts.push(`in the *${parsed.timePreference}*`);
  } else if (parsed.specificTime) {
    const [h, m] = parsed.specificTime.split(':');
    const hour = parseInt(h);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    parts.push(`at *${h12}:${m} ${ampm}*`);
  }

  if (parsed.quantity && parsed.quantity > 1) {
    if (parsed.intent === 'ticketing') {
      parts.push(`*${parsed.quantity} tickets*`);
    } else {
      parts.push(`for *${parsed.quantity} people*`);
    }
  }

  if (parsed.amount) {
    parts.push(`of *${parsed.amount.toLocaleString()}*`);
  }

  if (parts.length === 0) return null;

  const verb = parsed.intent === 'payment' ? 'Processing' : 'Looking up';
  return `Got it! ${verb} ${parts.join(' ')} for you... ✨`;
}
