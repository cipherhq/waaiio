import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import Anthropic from '@anthropic-ai/sdk';
import { rateLimitResponse } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `You are a friendly business setup assistant for Waaiio, a WhatsApp automation platform used in Nigeria, US, UK, Canada, and Ghana.

Your job: understand what this business does and help them set up their WhatsApp bot.

From the conversation, extract:
1. services: [{ name, price, duration_minutes, deposit_amount, description }]
   - price as number (in the business's local currency)
   - duration_minutes as number (estimate if not given: haircuts ~30, consultations ~60, etc.)
   - deposit_amount: 0 unless business mentions a deposit
2. products: [{ name, price, description, category }] (only for businesses that sell physical items)
3. operating_hours: { monday: { open: "09:00", close: "17:00" }, tuesday: ..., sunday: { closed: true } }
4. greeting: A warm, short WhatsApp greeting message for their bot (1-2 sentences, include business name)
5. capabilities: Which Waaiio features they need from: ["scheduling", "ordering", "payment", "feedback", "chat"]

RULES:
- Be conversational, warm, and brief. This is a chat, not an essay.
- Ask follow-up questions if you need: prices, hours, or what services they offer.
- When you have enough info to suggest a setup, include a JSON block in your response wrapped in \`\`\`json markers.
- The JSON block should have the structure: { "services": [...], "products": [...], "operating_hours": {...}, "greeting": "...", "capabilities": [...] }
- Omit sections that don't apply (e.g., no "products" for a salon).
- After outputting the JSON, add: "Does this look right? You can edit anything before confirming."
- If the user says something is wrong, adjust and output updated JSON.
- Keep prices realistic for the business's country.
- Do NOT make up services the business didn't mention. Only extract what they tell you.`;

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
    .select('id, name, category, country_code, city')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

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

    const contextNote = `[Context: Business "${biz.name}", category: ${biz.category || 'general'}, location: ${biz.city || 'unknown'}, country: ${biz.country_code || 'NG'}]`;

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

    return NextResponse.json({
      reply: text,
      suggestion,
    });
  } catch (error) {
    logger.error('[AI-SETUP] Chat error:', (error as Error).message);
    return NextResponse.json({ error: 'AI service unavailable' }, { status: 500 });
  }
}
