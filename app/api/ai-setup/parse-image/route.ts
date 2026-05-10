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

const IMAGE_PARSE_PROMPT = `Extract all products, services, or menu items with their prices from this image.

Return ONLY valid JSON in this exact format:
{
  "items": [
    { "name": "Item Name", "price": 1234, "description": "brief description if visible", "category": "category if visible" }
  ]
}

Rules:
- price must be a number (no currency symbols, no commas)
- If price shows a range (e.g., "$10-15"), use the lower price
- Include description only if clearly visible in the image
- Group by category if categories are shown
- If no items/prices are visible, return { "items": [] }
- Do NOT invent items — only extract what you can actually read
- Return ONLY the JSON, no explanation`;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const businessId = formData.get('business_id') as string | null;
  const itemType = (formData.get('type') as string) || 'products'; // 'products' or 'services'

  if (!file || !businessId) {
    return NextResponse.json({ error: 'Missing file or business_id' }, { status: 400 });
  }

  // Rate limit: 10 image parses per business per hour
  const rateLimited = rateLimitResponse(`ai-parse:${businessId}`, 10, 3600_000);
  if (rateLimited) return rateLimited;

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, country_code')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // Validate file
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    return NextResponse.json({ error: 'Only JPEG, PNG, WebP, and GIF images are allowed' }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'Image must be under 10MB' }, { status: 400 });
  }

  try {
    const anthropic = getClient();
    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString('base64');

    const mediaType = file.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

    const countryHint = biz.country_code === 'NG' ? 'Prices are likely in Nigerian Naira (NGN).'
      : biz.country_code === 'GH' ? 'Prices are likely in Ghana Cedis (GHS).'
      : biz.country_code === 'GB' ? 'Prices are likely in British Pounds (GBP).'
      : 'Prices may be in USD or local currency.';

    const typeHint = itemType === 'services'
      ? 'These are likely services (with durations). If you can estimate duration in minutes, add "duration_minutes" to each item.'
      : 'These are likely products for sale.';

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20241022',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          {
            type: 'text',
            text: `${IMAGE_PARSE_PROMPT}\n\n${countryHint}\n${typeHint}`,
          },
        ],
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';

    // Extract JSON from response (may be wrapped in ```json blocks)
    let parsed;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[1] : text);
    } catch {
      parsed = { items: [] };
    }

    const items = Array.isArray(parsed.items) ? parsed.items.filter(
      (item: { name?: string; price?: number }) => item.name && typeof item.price === 'number'
    ) : [];

    if (items.length === 0) {
      return NextResponse.json({
        items: [],
        type: itemType,
        message: 'Could not read the image clearly. Try uploading a clearer photo with visible text and prices, or add items manually.',
      });
    }

    return NextResponse.json({ items, type: itemType });
  } catch (error) {
    logger.error('[AI-SETUP] Image parse error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to parse image' }, { status: 500 });
  }
}
