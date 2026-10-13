import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ALL_FLOW_COPY_KEYS, BUTTON_TITLE_KEYS, LIST_TITLE_KEYS, PLACEHOLDER_SCHEMA, KEYS_WITH_COMMANDS, getFlowCopy } from '@/lib/bot/flows/flow-localization';
import { loadBusinessLanguages, getEffectiveLanguages } from '@/lib/bot/language-policy';
import { isSupportedLanguage } from '@/lib/bot/languages';
import { isBusinessEditableKey } from '@/lib/bot/translations';

/**
 * GET /api/translations
 *
 * List all translation overrides for the authenticated user's business.
 * Query params: businessId (required)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('businessId');
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  // Verify ownership
  const { data: business } = await supabase
    .from('businesses')
    .select('id, owner_id, subscription_tier')
    .eq('id', businessId)
    .single();
  if (!business || business.owner_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const serviceClient = createServiceClient();

  // Load business overrides
  const { data: overrides } = await serviceClient
    .from('bot_translation_overrides')
    .select('id, lang, key, value, updated_at')
    .eq('business_id', businessId);

  // Load platform overrides for reference
  const { data: platformOverrides } = await serviceClient
    .from('bot_translation_platform_overrides')
    .select('lang, key, value');

  // Load business's enabled languages
  const configuredLangs = await loadBusinessLanguages(serviceClient, businessId);
  const entitlement = getEffectiveLanguages(business.subscription_tier || 'free', configuredLangs);

  return NextResponse.json({
    overrides: overrides || [],
    platformOverrides: platformOverrides || [],
    allowedLanguages: entitlement.allowedLanguages,
    allKeys: ALL_FLOW_COPY_KEYS,
    editableKeys: ALL_FLOW_COPY_KEYS.filter(isBusinessEditableKey),
  });
}

/**
 * PUT /api/translations
 *
 * Upsert translation overrides for a business.
 * Body: { businessId: string, overrides: Array<{ lang, key, value }> }
 * To delete an override, send value as null or empty string.
 */
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { businessId, overrides } = body as {
    businessId: string;
    overrides: Array<{ lang: string; key: string; value: string | null }>;
  };

  if (!businessId || !Array.isArray(overrides)) {
    return NextResponse.json({ error: 'businessId and overrides[] required' }, { status: 400 });
  }

  if (overrides.length > 200) {
    return NextResponse.json({ error: 'Too many overrides (max 200)' }, { status: 400 });
  }

  // Verify ownership
  const { data: business } = await supabase
    .from('businesses')
    .select('id, owner_id, subscription_tier')
    .eq('id', businessId)
    .single();
  if (!business || business.owner_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const serviceClient = createServiceClient();

  // Load enabled languages for validation
  const configuredLangs = await loadBusinessLanguages(serviceClient, businessId);
  const entitlement = getEffectiveLanguages(business.subscription_tier || 'free', configuredLangs);

  // Validate each override
  const errors: string[] = [];
  const upserts: Array<{ lang: string; key: string; value: string }> = [];
  const deletes: Array<{ lang: string; key: string }> = [];

  // Pattern for command tokens like *Book Now*
  const commandTokenPattern = /\*[A-Za-z][A-Za-z ]*\*/g;

  for (const override of overrides) {
    // Delete if value is null or empty
    if (!override.value || override.value.trim() === '') {
      deletes.push({ lang: override.lang, key: override.key });
      continue;
    }

    const trimmedValue = override.value.trim();

    // Validate key is business-editable
    if (!isBusinessEditableKey(override.key)) {
      errors.push(`${override.key}: not editable by businesses`);
      continue;
    }

    // Reject values containing URLs, phone numbers, or 8+ digit runs
    const UNSAFE_VALUE_PATTERN = /https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}\/|(\+?\d[\d\s-]{7,}\d)|\d{8,}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(com|net|org|ng|gh|uk|ca|us|io|co|app|me|xyz|link|ly|info|biz)\b/i;
    if (UNSAFE_VALUE_PATTERN.test(trimmedValue)) {
      errors.push(`${override.key}: value must not contain URLs, phone numbers, or long digit sequences`);
      continue;
    }

    // Validate key exists
    if (!ALL_FLOW_COPY_KEYS.includes(override.key)) {
      errors.push(`Unknown key: ${override.key}`);
      continue;
    }

    // Validate lang is supported and allowed for this business
    if (!isSupportedLanguage(override.lang)) {
      errors.push(`Unsupported language: ${override.lang}`);
      continue;
    }
    if (!entitlement.allowedLanguages.includes(override.lang)) {
      errors.push(`Language ${override.lang} not enabled for this business`);
      continue;
    }

    // Validate WhatsApp button title length (max 20 chars)
    if (BUTTON_TITLE_KEYS.includes(override.key) && trimmedValue.length > 20) {
      errors.push(`${override.key}: button title exceeds 20 chars (${trimmedValue.length})`);
      continue;
    }

    // Validate WhatsApp list title length (max 24 chars)
    if (LIST_TITLE_KEYS.includes(override.key) && trimmedValue.length > 24) {
      errors.push(`${override.key}: list title exceeds 24 chars (${trimmedValue.length})`);
      continue;
    }

    // Validate placeholders: all required placeholders must be present, none added
    const requiredPlaceholders = PLACEHOLDER_SCHEMA.get(override.key);
    if (requiredPlaceholders) {
      const foundPlaceholders = [...trimmedValue.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
      for (const required of requiredPlaceholders) {
        if (!foundPlaceholders.includes(required)) {
          errors.push(`${override.key}: missing required placeholder {${required}}`);
        }
      }
      for (const found of foundPlaceholders) {
        if (!requiredPlaceholders.includes(found)) {
          errors.push(`${override.key}: unexpected placeholder {${found}}`);
        }
      }
    }

    // Validate command tokens preserved for keys that require them
    if (KEYS_WITH_COMMANDS.includes(override.key)) {
      const englishText = getFlowCopy('en', override.key);
      const englishCommands = [...englishText.matchAll(commandTokenPattern)].map(m => m[0]);
      for (const cmd of englishCommands) {
        if (!trimmedValue.includes(cmd)) {
          errors.push(`${override.key}: must preserve command token ${cmd}`);
        }
      }
    }

    upserts.push({ lang: override.lang, key: override.key, value: trimmedValue });
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: 'Validation failed', errors }, { status: 400 });
  }

  // Process deletes
  for (const del of deletes) {
    const { error: delError } = await serviceClient
      .from('bot_translation_overrides')
      .delete()
      .eq('business_id', businessId)
      .eq('lang', del.lang)
      .eq('key', del.key);
    if (delError) {
      return NextResponse.json({ error: 'Failed to delete override' }, { status: 500 });
    }
  }

  // Process upserts
  if (upserts.length > 0) {
    const rows = upserts.map(u => ({
      business_id: businessId,
      lang: u.lang,
      key: u.key,
      value: u.value,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    }));

    const { error: upsertError } = await serviceClient
      .from('bot_translation_overrides')
      .upsert(rows, { onConflict: 'business_id,lang,key' });

    if (upsertError) {
      return NextResponse.json({ error: 'Failed to save overrides' }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true, upserted: upserts.length, deleted: deletes.length });
}
