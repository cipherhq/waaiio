import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import Anthropic from '@anthropic-ai/sdk';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { checkAIFeature, incrementAIUsage } from '@/lib/bot/ai-tier-guard';
import { validateFileSignature } from '@/lib/security/validate-file';
import { sanitizeImage } from '@/lib/security/sanitize-image';
import {
  ACE_IMAGE_ALLOWED_MIME,
  ACE_IMAGE_MAX_EDGE,
  ACE_IMAGE_MAX_UPLOAD_BYTES,
  ACE_IMAGE_MODEL,
  buildAceImagePrompt,
  extractJsonObject,
  isAceImageMode,
  normalizeAceImageItems,
  type AceImageMode,
} from '@/lib/ai-setup/image-catalog';

// Sonnet vision calls on a full menu can take tens of seconds.
export const maxDuration = 60;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Bounded so a slow call (plus one retry) finishes inside maxDuration.
  if (!client) client = new Anthropic({ timeout: 50_000, maxRetries: 1 });
  return client;
}

/**
 * Ace image reading. Returns a PROPOSAL only — nothing is written here except
 * the Ace usage counter. The owner reviews and confirms via /api/ai-setup/apply.
 *
 * Order: auth → owner check → rate limit (business+user) → Ace quota →
 * real-bytes validation → re-encode → count usage → Sonnet → strict output
 * validation.
 *
 * Owner decision: each image counts toward the Ace allowance. A checked image
 * is counted before the model call, whether or not Ace finds any items.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid upload' }, { status: 400 });
  }

  const file = formData.get('file');
  const businessId = formData.get('business_id');
  const rawMode = formData.get('mode') ?? 'menu';

  if (!file || typeof file === 'string' || typeof businessId !== 'string' || !businessId) {
    return NextResponse.json({ error: 'Missing file or business_id' }, { status: 400 });
  }
  if (!isAceImageMode(rawMode)) {
    return NextResponse.json({ error: 'Invalid mode' }, { status: 400 });
  }
  const mode: AceImageMode = rawMode;

  // Verify ownership BEFORE consuming any rate-limit or quota budget
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, country_code, subscription_tier')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .maybeSingle();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // Rate limit: 10 image reads per business per user per hour
  const rateLimited = await rateLimitResponseAsync(`ai-parse:${businessId}:${user.id}`, 10, 3600_000);
  if (rateLimited) return rateLimited;

  const tier = (biz.subscription_tier || 'free') as string;
  const { allowed, reason } = await checkAIFeature(supabase, businessId, tier, 'ace_setup');
  if (!allowed) {
    return NextResponse.json(
      { error: reason || 'You have used all your Ace setup requests for this month. Upgrade your plan for more.' },
      { status: 403 },
    );
  }

  // Validate the real bytes — file.type is client-supplied
  if (!ACE_IMAGE_ALLOWED_MIME.includes(file.type)) {
    return NextResponse.json({ error: 'Only JPEG, PNG, WebP, and GIF images are allowed' }, { status: 400 });
  }
  if (file.size > ACE_IMAGE_MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Image must be under 4MB' }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!validateFileSignature(buffer, file.type)) {
    return NextResponse.json({ error: 'File content does not match its type. Please upload a real photo.' }, { status: 400 });
  }

  // Re-encode to a clean JPEG (strips metadata/payloads, bounds dimensions)
  let jpegBase64: string;
  try {
    const sanitized = await sanitizeImage(buffer, {
      maxWidth: ACE_IMAGE_MAX_EDGE,
      maxHeight: ACE_IMAGE_MAX_EDGE,
      format: 'jpeg',
      quality: 85,
    });
    jpegBase64 = sanitized.buffer.toString('base64');
  } catch {
    return NextResponse.json({ error: 'That file is not a readable image. Please try another photo.' }, { status: 400 });
  }

  // Owner decision: every checked image counts, even if nothing is read.
  await incrementAIUsage(supabase, businessId, 'ace_setup');

  let text: string;
  let truncated = false;
  try {
    // No tools: the model can only return text, which is validated below.
    const response = await getClient().messages.create({
      model: ACE_IMAGE_MODEL,
      max_tokens: 8000,
      system: buildAceImagePrompt(mode, biz.country_code),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
          { type: 'text', text: mode === 'product_photo'
            ? 'Suggest catalog details for the product in this photo. Respond with JSON only.'
            : 'Extract the catalog items from this image. Respond with JSON only.' },
        ],
      }],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    truncated = response.stop_reason === 'max_tokens';
  } catch (error) {
    logger.error('[AI-SETUP] Image parse error:', (error as Error).message);
    return NextResponse.json({ error: 'Ace could not read that image right now. Please try again.' }, { status: 502 });
  }

  if (truncated) {
    return NextResponse.json({
      items: [],
      mode,
      message: 'This menu is too long for one photo. Take separate photos of each page or section and upload them one at a time.',
    });
  }

  const items = normalizeAceImageItems(extractJsonObject(text), mode);

  if (items.length === 0) {
    return NextResponse.json({
      items: [],
      mode,
      message: mode === 'product_photo'
        ? 'Ace could not recognise a product in that photo. Try a clearer photo, or add the product manually.'
        : 'Could not read the image clearly. Try uploading a clearer photo with visible text and prices, or add items manually.',
    });
  }

  return NextResponse.json({ items, mode });
}
