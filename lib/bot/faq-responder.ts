import type { SupabaseClient } from '@supabase/supabase-js';

interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  keywords: string[];
}

interface BusinessProfile {
  name: string;
  address: string;
  phone: string;
  operating_hours: Record<string, { open: string; close: string; closed?: boolean }>;
  metadata: Record<string, unknown>;
}

const BUILT_IN_PATTERNS: { keywords: string[]; field: keyof BusinessProfile | 'hours' }[] = [
  { keywords: ['hour', 'open', 'close', 'time', 'when', 'schedule'], field: 'hours' },
  { keywords: ['where', 'location', 'address', 'direction', 'find you'], field: 'address' },
  { keywords: ['phone', 'call', 'contact', 'reach', 'number'], field: 'phone' },
  { keywords: ['price', 'cost', 'how much', 'charge', 'fee', 'rate'], field: 'metadata' },
  { keywords: ['cancel', 'refund', 'reschedule', 'change booking'], field: 'metadata' },
  { keywords: ['pay', 'payment', 'card', 'transfer', 'cash'], field: 'metadata' },
];

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function formatOperatingHours(hours: Record<string, { open: string; close: string; closed?: boolean }>): string {
  if (!hours || Object.keys(hours).length === 0) return 'Operating hours not set.';

  const lines: string[] = [];
  for (const day of DAY_NAMES) {
    const h = hours[day];
    if (!h || h.closed) {
      lines.push(`${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`);
    } else {
      lines.push(`${day.charAt(0).toUpperCase() + day.slice(1)}: ${h.open} - ${h.close}`);
    }
  }
  return lines.join('\n');
}

/**
 * Try to answer a free-text message using FAQ entries and business profile data.
 * Returns the answer string or null if no match found.
 */
export async function tryFaqResponse(
  supabase: SupabaseClient,
  businessId: string,
  business: BusinessProfile,
  message: string,
): Promise<string | null> {
  const lower = message.toLowerCase().trim();

  // Skip very short or very long messages
  if (lower.length < 3 || lower.length > 300) return null;

  // 1. Check custom FAQ entries first
  const { data: faqs } = await supabase
    .from('business_faq')
    .select('id, question, answer, keywords')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .order('sort_order');

  if (faqs && faqs.length > 0) {
    for (const faq of faqs as FaqEntry[]) {
      // Check keyword match using word boundaries to avoid partial matches
      // (e.g. "book" inside "facebook", "cancel" inside "balance")
      const hasKeyword = faq.keywords.some(kw => {
        const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
      });
      // Check question similarity (simple word overlap)
      const qWords = faq.question.toLowerCase().split(/\s+/);
      const inputWords = lower.split(/\s+/);
      const overlap = qWords.filter(w => inputWords.includes(w) && w.length > 2).length;
      const similarity = overlap / Math.max(qWords.length, 1);

      if (hasKeyword || similarity > 0.4) {
        // Increment hit count
        await supabase
          .from('business_faq')
          .update({ hit_count: (faq as FaqEntry & { hit_count: number }).hit_count + 1 })
          .eq('id', faq.id);
        return faq.answer;
      }
    }
  }

  // 2. Check built-in patterns against business profile
  for (const pattern of BUILT_IN_PATTERNS) {
    const matches = pattern.keywords.some(kw => lower.includes(kw));
    if (!matches) continue;

    switch (pattern.field) {
      case 'hours':
        return `*${business.name} Hours:*\n\n${formatOperatingHours(business.operating_hours)}`;
      case 'address':
        return business.address
          ? `*Our Location:*\n${business.address}`
          : null;
      case 'phone':
        return business.phone
          ? `*Contact us:*\n📞 ${business.phone}`
          : null;
      case 'metadata': {
        // Check for cancellation policy
        if (lower.includes('cancel') || lower.includes('refund') || lower.includes('reschedule')) {
          const policy = business.metadata?.cancellation_policy as string;
          if (policy) return policy;
          return `You can cancel up to 4 hours before your booking. Send *Cancel* at any time to cancel your current session.`;
        }
        // Check for payment methods
        if (lower.includes('pay') || lower.includes('card') || lower.includes('transfer') || lower.includes('cash')) {
          return `We accept payments via card, bank transfer, and mobile money through our secure payment link. You'll receive a payment link after booking.`;
        }
        return null;
      }
    }
  }

  return null;
}
