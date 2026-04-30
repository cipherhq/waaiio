import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import Anthropic from '@anthropic-ai/sdk';
import { rateLimitResponse } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { CAPABILITY_TIER_REQUIREMENTS, type CapabilityId } from '@/lib/capabilities/types';
import { checkAIFeature, incrementAIUsage } from '@/lib/bot/ai-tier-guard';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

// Category-specific guidance so AI understands what each business type actually does
const CATEGORY_CONTEXT: Record<string, string> = {
  church: `This is a CHURCH/FAITH-BASED organization. They do NOT sell services or products in the traditional sense.
What to ask about: service times (Sunday worship, midweek service, Bible study, prayer meeting), tithes & offerings (payment collection), events (conferences, retreats, concerts), departments/groups.
Use "services" for their SERVICE TIMES (e.g., "Sunday Worship" at 9am, "Bible Study" on Wednesday at 6pm). Price should be 0 for service times.
Use "payment" capability for tithes, offerings, and donations. Ask what payment types they accept (tithes, offerings, seeds, building fund, etc.).
Greeting example: "Welcome to [Church Name]! How can we help you today? 🙏"`,

  mosque: `This is a MOSQUE/ISLAMIC CENTER. They do NOT sell services or products.
What to ask about: prayer times (Jummah, daily salah), Zakat/Sadaqah collection, Islamic classes, events (Ramadan, Eid), community programs.
Use "services" for their gathering times (e.g., "Jummah Prayer" on Friday). Price should be 0.
Use "payment" capability for Zakat, Sadaqah, and donations.`,

  ngo: `This is an NGO/NON-PROFIT. They don't sell products — they run programs and accept donations.
What to ask about: programs/initiatives they run, donation types, volunteer activities, events.
Use "services" for their programs. Price can be 0 for free programs or a registration fee.
Use "payment" capability for donations and fundraising.`,

  restaurant: `This is a RESTAURANT/FOOD BUSINESS. They serve food and drinks.
What to ask about: menu items with prices, dine-in/takeout/delivery, operating hours, specials.
Use "products" for menu items (each dish with price). Use "ordering" capability.`,

  food_delivery: `This is a FOOD DELIVERY business. They sell food for delivery/pickup.
What to ask about: menu items with prices, delivery areas, operating hours.
Use "products" for menu items. Use "ordering" capability.`,

  barber: `This is a BARBERSHOP. They offer grooming services by appointment.
What to ask about: haircut styles and prices, beard services, duration per service, walk-ins vs appointments.
Use "services" for each service with price and duration. Use "scheduling" capability.`,

  salon: `This is a HAIR SALON/BEAUTY SALON. They offer beauty services by appointment.
What to ask about: services (hair, nails, lashes, facials, etc.) with prices, service duration, stylists.
Use "services" with price and duration. Use "scheduling" capability.`,

  spa: `This is a SPA/WELLNESS center. They offer relaxation and beauty treatments.
What to ask about: treatments (massage, facial, body scrub, etc.) with prices and duration.
Use "services" with price and duration. Use "scheduling" capability.`,

  gym: `This is a GYM/FITNESS center. They offer memberships and classes.
What to ask about: membership plans, class schedules, personal training rates.
Use "services" for membership plans and classes. Use "scheduling" capability.`,

  clinic: `This is a MEDICAL CLINIC/HEALTH facility. They offer health services.
What to ask about: consultation types, specialist services, appointment duration, fees.
Use "services" for each consultation/treatment type. Use "scheduling" capability.`,

  school: `This is a SCHOOL/EDUCATIONAL institution. They offer courses and programs.
What to ask about: programs/courses, tuition/fees, class schedules, terms/semesters.
Use "services" for courses/programs with fees. Use "payment" capability for tuition.`,

  shop: `This is a RETAIL SHOP. They sell physical products.
What to ask about: product categories, items with prices, delivery options.
Use "products" for their inventory. Use "ordering" capability.`,

  instagram_vendor: `This is an ONLINE VENDOR (Instagram/social media seller). They sell products online.
What to ask about: what they sell, prices, delivery options, payment methods.
Use "products" for their items. Use "ordering" capability.`,

  events: `This is an EVENTS business. They organize events and sell tickets.
What to ask about: upcoming events, ticket types and prices, venue details.
Use "services" for event types they organize. Use "ticketing" capability.`,

  hotel: `This is a HOTEL/ACCOMMODATION business. They offer rooms and stays.
What to ask about: room types, nightly rates, amenities, check-in/check-out times.
Use "services" for room types with nightly rates. Use "scheduling" or "reservation" capability.`,

  shortlet: `This is a SHORTLET/VACATION RENTAL. They rent out properties.
What to ask about: property types, nightly/weekly rates, amenities, house rules.
Use "services" for property listings with rates. Use "reservation" capability.`,

  consultant: `This is a CONSULTING/PROFESSIONAL services business.
What to ask about: consultation types, hourly/session rates, duration, specializations.
Use "services" for each consultation type with rate and duration. Use "scheduling" capability.`,

  logistics: `This is a LOGISTICS/DELIVERY business. They move goods.
What to ask about: delivery types (same-day, express, standard), pricing by distance/weight, coverage areas.
Use "services" for delivery options with pricing. Use "ordering" capability.`,

  car_wash: `This is a CAR WASH business. They clean vehicles.
What to ask about: wash packages (basic, premium, detail), prices, add-ons.
Use "services" for wash packages with prices. Use "scheduling" capability.`,

  laundry: `This is a LAUNDRY/DRY CLEANING business.
What to ask about: service types (wash & fold, dry clean, iron), pricing per item or kg, turnaround time.
Use "services" for each service type. Use "scheduling" or "ordering" capability.`,
};

const SYSTEM_PROMPT = `You are Ace, the friendly AI assistant for Waaiio — a WhatsApp automation platform used in Nigeria, US, UK, Canada, and Ghana.

Your ONLY job: help this business set up their WhatsApp bot. You MUST understand what type of business this is (see category context below) and ask questions appropriate to that business type.

## SCOPE RULES — CRITICAL
- You ONLY help with business setup on Waaiio.
- If the user asks anything NOT related to setting up their business (e.g., general knowledge, coding, personal advice, jokes), politely redirect: "Hey, I'm Ace — I'm here to help set up your Waaiio bot! Let's get back to configuring your business."
- Do NOT engage with off-topic conversations. Always steer back to business setup.
- Keep your responses SHORT (2-4 sentences max). This is a quick setup chat.

## CATEGORY AWARENESS — CRITICAL
Read the category context carefully. A church is NOT a shop. A mosque is NOT a salon. Ask questions that make sense for THIS type of business:
- Faith-based (church, mosque): Ask about service times, payment/donation types, weekly schedule
- Service businesses (salon, barber, spa, clinic): Ask about services with prices and duration
- Retail/food (shop, restaurant, vendor): Ask about products/menu items with prices
- Events/entertainment: Ask about event types and ticket pricing
- Non-profit (NGO): Ask about programs and donation types

## HOW TO ASK QUESTIONS
Always give specific options relevant to the business type:

For a church: "What services/gatherings do you hold?
1. Sunday Worship only
2. Sunday + Midweek service
3. Multiple services (Sunday, Midweek, Prayer, Bible Study)
4. Tell me your full schedule"

For a salon: "What services do you offer? For example:
1. Hair styling, braiding, coloring
2. Nails (manicure, pedicure)
3. Full beauty (hair, nails, lashes, facials)
4. Tell me your full list with prices"

For a restaurant: "What's on your menu? You can:
1. List your dishes and prices
2. Upload a photo of your menu (use the upload below!)
3. Tell me your categories (starters, mains, drinks)"

## EXTRACTION
From the conversation, extract:
1. services: [{ name, price, duration_minutes, deposit_amount, description }] — for appointment/event-based items. Price can be 0 for free things like church services.
2. products: [{ name, price, description, category }] — for physical items sold (food, retail, etc.)
3. operating_hours: { monday: { open: "09:00", close: "17:00" }, ... sunday: { closed: true } }
4. greeting: A warm, short WhatsApp greeting appropriate to the business type
5. capabilities: ONLY from the allowed list in the context

## OUTPUT RULES
- When you have enough info, output a JSON block in \`\`\`json markers.
- After the JSON, say: "Does this look right? Edit anything in the preview, or tell me what to change."
- Do NOT make up items the business didn't mention.
- Keep prices realistic for the business's country.
- Omit sections that don't apply.`;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { business_id, message, conversation_history } = body as {
    business_id: string;
    message: string;
    conversation_history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  };

  if (!business_id || !message?.trim()) {
    return NextResponse.json({ error: 'Missing business_id or message' }, { status: 400 });
  }

  // Rate limit: 20 messages per business per hour
  const rateLimited = rateLimitResponse(`ai-setup:${business_id}`, 20, 3600_000);
  if (rateLimited) return rateLimited;

  // Verify ownership + get business context
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, category, country_code, city, subscription_tier')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // Determine which capabilities are allowed on this tier
  const tier = (biz.subscription_tier || 'free') as 'free' | 'growth' | 'business';

  // Check AI usage limits for Ace
  const { allowed, reason } = await checkAIFeature(supabase, business_id, tier, 'ace_setup');
  if (!allowed) {
    return NextResponse.json({ error: reason || 'AI setup limit reached. Upgrade your plan for more.' }, { status: 403 });
  }
  const tierRank: Record<string, number> = { free: 0, growth: 1, business: 2 };
  const allowedCapabilities = Object.entries(CAPABILITY_TIER_REQUIREMENTS)
    .filter(([, requiredTier]) => tierRank[tier] >= tierRank[requiredTier])
    .map(([capId]) => capId);

  try {
    const anthropic = getClient();

    // Build message history
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    if (conversation_history?.length) {
      for (const msg of conversation_history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: message });

    const categoryGuide = CATEGORY_CONTEXT[biz.category || ''] || `This is a "${biz.category || 'general'}" business. Ask what they offer (services, products, or both) and their prices.`;

    const contextNote = `[Context: Business "${biz.name}", category: ${biz.category || 'general'}, location: ${biz.city || 'unknown'}, country: ${biz.country_code || 'NG'}, subscription tier: ${tier}]

## CATEGORY GUIDE FOR THIS BUSINESS:
${categoryGuide}

[IMPORTANT — Tier restriction: This business is on the "${tier}" plan. ONLY suggest capabilities from this allowed list: ${JSON.stringify(allowedCapabilities)}. Do NOT suggest capabilities outside this list. If the business describes features that require a higher tier, mention they can upgrade to access those features.]`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: SYSTEM_PROMPT + '\n\n' + contextNote,
      messages,
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    // Try to extract JSON suggestion from the response
    let suggestion = null;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        suggestion = JSON.parse(jsonMatch[1]);
      } catch {
        // JSON parse failed — that's fine, AI is still asking questions
      }
    }

    // Enforce tier gating on capabilities — strip any the AI hallucinated
    if (suggestion?.capabilities) {
      suggestion.capabilities = (suggestion.capabilities as string[]).filter(
        (cap: string) => allowedCapabilities.includes(cap)
      );
    }

    // Track usage
    await incrementAIUsage(supabase, business_id, 'ace_setup');

    return NextResponse.json({
      reply: text,
      suggestion,
      allowed_capabilities: allowedCapabilities,
      tier,
    });
  } catch (error) {
    logger.error('[AI-SETUP] Chat error:', (error as Error).message);
    return NextResponse.json({ error: 'AI service unavailable' }, { status: 500 });
  }
}
