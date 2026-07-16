/**
 * Business Knowledge Service — answers customer questions using verified DB records.
 *
 * Handles business-specific factual questions that global-queries.ts doesn't cover:
 * hours, prices, delivery, FAQs, payment methods, policies.
 *
 * All answers are grounded in database data — never hallucinated.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';

interface BusinessKnowledge {
  name: string;
  description: string | null;
  category: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  countryCode: CountryCode;
  operatingHours: Record<string, { open: string; close: string; closed?: boolean }> | null;
  isOpenNow: boolean;
  closingTime: string | null;
  openingTime: string | null;
  services: Array<{ name: string; price: number; duration?: number }>;
  products: Array<{ name: string; price: number; inStock?: boolean }>;
  paymentMethods: string[];
  supportsDelivery: boolean;
  deliveryArea: string | null;
  depositRequired: boolean;
  depositAmount: number | null;
  cancellationPolicy: string | null;
  faqs: Array<{ question: string; answer: string }>;
}

// ── Temporary question detection ────────────────────────

const HOURS_PATTERNS = [
  /\b(what\s+time|when\s+do\s+you|are\s+you\s+open|still\s+open)\b/i,
  /\b(hours?|open|close|closing|opening)\b/i,
];

const LOCATION_PATTERNS = [
  /\b(where|location|address|directions?|map)\b/i,
  /\b(how\s+to\s+get|find\s+you|situated)\b/i,
];

const PRICE_PATTERNS = [
  /\b(price|cost|how\s+much|pricing|rate|charge|fee)\b/i,
  /\b(expensive|cheap|afford)\b/i,
];

const PAYMENT_PATTERNS = [
  /\b(accept|payment\s+method|pay\s+with|card|transfer|cash|pos)\b/i,
];

const DELIVERY_PATTERNS = [
  /\b(deliver|delivery|ship|bring|come\s+to)\b/i,
];

const POLICY_PATTERNS = [
  /\b(deposit|cancel|refund|cancellation|policy)\b/i,
];

/** Detect if a message is a temporary informational question (not a flow action). */
export function isTemporaryQuestion(text: string): { type: string; query: string } | null {
  const lower = text.toLowerCase().trim();

  // Skip very short messages — likely flow input
  if (lower.length < 4) return null;

  // Hours/closing/opening — needs two signals to avoid false positives
  if (HOURS_PATTERNS[0].test(lower) ||
      (HOURS_PATTERNS[1].test(lower) && /\b(close|open|hours?|schedule|time)\b/i.test(lower))) {
    return { type: 'hours', query: lower };
  }

  // Location/address/directions
  if (LOCATION_PATTERNS.some(p => p.test(lower))) {
    return { type: 'location', query: lower };
  }

  // Prices — only pure questions, not purchase intent
  if (PRICE_PATTERNS.some(p => p.test(lower)) &&
      !/\b(pay|book|order|buy)\b/i.test(lower)) {
    return { type: 'pricing', query: lower };
  }

  // Payment methods
  if (PAYMENT_PATTERNS.some(p => p.test(lower))) {
    return { type: 'payment_methods', query: lower };
  }

  // Delivery — needs intent signal to avoid false positives
  if (DELIVERY_PATTERNS.some(p => p.test(lower)) &&
      /\b(do\s+you|can\s+you|is\s+there|available)\b/i.test(lower)) {
    return { type: 'delivery', query: lower };
  }

  // Deposit/cancellation
  if (POLICY_PATTERNS.some(p => p.test(lower))) {
    return { type: 'policy', query: lower };
  }

  return null;
}

/** Load business knowledge from database. */
export async function loadBusinessKnowledge(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BusinessKnowledge | null> {
  try {
    // Load business + services + products + FAQs in parallel
    const [bizResult, servicesResult, productsResult, faqResult] = await Promise.all([
      supabase
        .from('businesses')
        .select('name, description, category, address, phone, website, operating_hours, metadata, country_code')
        .eq('id', businessId)
        .maybeSingle(),
      supabase
        .from('services')
        .select('name, price, duration_minutes')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('sort_order')
        .limit(20),
      supabase
        .from('products')
        .select('name, price, stock_quantity, track_inventory')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('sort_order')
        .limit(20),
      supabase
        .from('business_faq')
        .select('question, answer')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('sort_order')
        .limit(20),
    ]);

    const biz = bizResult.data;
    if (!biz) return null;

    const hours = biz.operating_hours as Record<string, { open: string; close: string; closed?: boolean }> | null;

    // Calculate if open now
    let isOpenNow = true; // Default to open if no hours set
    let closingTime: string | null = null;
    let openingTime: string | null = null;

    if (hours && Object.keys(hours).length > 0) {
      const now = new Date();
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const today = dayNames[now.getDay()];
      const todayHours = hours[today];

      if (todayHours && !todayHours.closed) {
        openingTime = todayHours.open;
        closingTime = todayHours.close;
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const [openH, openM] = todayHours.open.split(':').map(Number);
        const [closeH, closeM] = todayHours.close.split(':').map(Number);
        const openMinutes = openH * 60 + openM;
        const closeMinutes = closeH * 60 + closeM;
        isOpenNow = currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
      } else {
        isOpenNow = false; // Closed today
      }
    }

    const metadata = (biz.metadata || {}) as Record<string, unknown>;
    const countryCode = (biz.country_code || 'NG') as CountryCode;

    return {
      name: biz.name,
      description: biz.description,
      category: biz.category,
      address: biz.address,
      phone: biz.phone,
      website: biz.website,
      countryCode,
      operatingHours: hours,
      isOpenNow,
      closingTime,
      openingTime,
      services: (servicesResult.data || []).map(s => ({
        name: s.name,
        price: s.price,
        duration: s.duration_minutes,
      })),
      products: (productsResult.data || []).map(p => ({
        name: p.name,
        price: p.price,
        inStock: p.track_inventory ? (p.stock_quantity || 0) > 0 : true,
      })),
      paymentMethods: (metadata.payment_methods as string[]) || ['card', 'transfer'],
      supportsDelivery: !!(metadata.supports_delivery),
      deliveryArea: (metadata.delivery_area as string) || null,
      depositRequired: !!(metadata.deposit_required),
      depositAmount: (metadata.deposit_amount as number) || null,
      cancellationPolicy: (metadata.cancellation_policy as string) || null,
      faqs: (faqResult.data || []),
    };
  } catch (err) {
    logger.error('[KNOWLEDGE] Failed to load business knowledge:', err);
    return null;
  }
}

/**
 * Answer a temporary question using verified business data.
 * Returns the answer string or null if no answer can be produced.
 */
export async function answerTemporaryQuestion(
  supabase: SupabaseClient,
  businessId: string,
  question: { type: string; query: string },
  businessName: string,
): Promise<string | null> {
  const knowledge = await loadBusinessKnowledge(supabase, businessId);
  if (!knowledge) return null;

  const cc = knowledge.countryCode;

  switch (question.type) {
    case 'hours': {
      if (!knowledge.operatingHours || Object.keys(knowledge.operatingHours).length === 0) {
        return `${businessName} hasn't set their operating hours yet. Please contact them directly.`;
      }
      if (knowledge.isOpenNow) {
        return `${businessName} is currently open${knowledge.closingTime ? ` and closes at ${knowledge.closingTime}` : ''}.`;
      }
      return `${businessName} is currently closed${knowledge.openingTime ? `. They open at ${knowledge.openingTime}` : ''}.`;
    }

    case 'location': {
      if (!knowledge.address) {
        return `${businessName} hasn't listed their address yet.`;
      }
      return `${businessName} is located at ${knowledge.address}.`;
    }

    case 'pricing': {
      if (knowledge.services.length > 0) {
        const top3 = knowledge.services.slice(0, 3);
        const lines = top3.map(s => `• ${s.name}: ${formatCurrency(s.price, cc)}`);
        return `Here are some prices at ${businessName}:\n${lines.join('\n')}`;
      }
      if (knowledge.products.length > 0) {
        const top3 = knowledge.products.slice(0, 3);
        const lines = top3.map(p => `• ${p.name}: ${formatCurrency(p.price, cc)}`);
        return `Here are some prices at ${businessName}:\n${lines.join('\n')}`;
      }
      return `${businessName} hasn't listed their prices yet. You can ask them directly.`;
    }

    case 'payment_methods': {
      const methods = knowledge.paymentMethods;
      if (methods.length === 0) return `Please ask ${businessName} about their accepted payment methods.`;
      return `${businessName} accepts: ${methods.join(', ')}.`;
    }

    case 'delivery': {
      if (knowledge.supportsDelivery) {
        return knowledge.deliveryArea
          ? `Yes, ${businessName} delivers to ${knowledge.deliveryArea}.`
          : `Yes, ${businessName} offers delivery.`;
      }
      return `${businessName} does not currently offer delivery.`;
    }

    case 'policy': {
      if (question.query.includes('deposit')) {
        if (knowledge.depositRequired) {
          return knowledge.depositAmount
            ? `${businessName} requires a deposit of ${formatCurrency(knowledge.depositAmount, cc)}.`
            : `${businessName} requires a deposit. Please ask for the exact amount.`;
        }
        return `${businessName} does not require a deposit.`;
      }
      if (knowledge.cancellationPolicy) {
        return `Cancellation policy: ${knowledge.cancellationPolicy}`;
      }
      return `Please contact ${businessName} for their cancellation policy.`;
    }

    default:
      return null;
  }
}
