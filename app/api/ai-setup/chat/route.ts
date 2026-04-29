import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import Anthropic from '@anthropic-ai/sdk';
import { rateLimitResponse } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { CAPABILITY_TIER_REQUIREMENTS, type CapabilityId } from '@/lib/capabilities/types';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `You are Ace, the friendly AI assistant for Waaiio — a WhatsApp automation platform used in Nigeria, US, UK, Canada, and Ghana.

Your ONLY job: help this business set up their WhatsApp bot by understanding their services/products, prices, and hours.

## SCOPE RULES — CRITICAL
- You ONLY help with business setup: services, products, prices, operating hours, and bot greeting.
- If the user asks anything NOT related to setting up their business on Waaiio (e.g., general knowledge, coding, personal advice, jokes, unrelated questions), politely redirect: "Hey, I'm Ace — I'm here to help set up your Waaiio bot! Let's get your services and hours configured. What do you offer?"
- Do NOT engage with off-topic conversations. Always steer back to business setup.
- Keep your responses SHORT (2-4 sentences max). This is a quick setup chat, not a long conversation.

## HOW TO ASK QUESTIONS
When you need info, ask with specific options so the business can pick easily:

Example — asking about business type:
"What best describes your business?
1. I offer services (appointments, consultations, treatments)
2. I sell products (food, retail, online store)
3. Both — services and products"

Example — asking about hours:
"What are your operating hours?
1. Mon-Fri, 9am-5pm
2. Mon-Sat, 9am-7pm
3. Every day, 8am-10pm
4. Custom — tell me your hours"

Example — asking about pricing:
"Got it! What do you charge for each service? For example: 'Haircut - $15, Beard trim - $10'"

## EXTRACTION
From the conversation, extract:
1. services: [{ name, price, duration_minutes, deposit_amount, description }]
2. products: [{ name, price, description, category }] (only if they sell items)
3. operating_hours: { monday: { open: "09:00", close: "17:00" }, ... sunday: { closed: true } }
4. greeting: A warm, short WhatsApp greeting for their bot (1-2 sentences, include business name)
5. capabilities: ONLY from the allowed list in the context (tier-restricted)

## OUTPUT RULES
- When you have enough info, output a JSON block in \`\`\`json markers.
- After the JSON, say: "Does this look right? Edit anything in the preview, or tell me what to change."
- Do NOT make up services or products the business didn't mention.
- Keep prices realistic for the business's country.
- Omit sections that don't apply (e.g., no "products" for a salon).`;

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

    const contextNote = `[Context: Business "${biz.name}", category: ${biz.category || 'general'}, location: ${biz.city || 'unknown'}, country: ${biz.country_code || 'NG'}, subscription tier: ${tier}]
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
