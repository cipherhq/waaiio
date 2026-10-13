import { NextResponse, type NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import {
  ALL_FLOW_COPY_KEYS,
  BUTTON_TITLE_KEYS,
  LIST_TITLE_KEYS,
  PLACEHOLDER_SCHEMA,
  KEYS_WITH_COMMANDS,
  getFlowCopy,
} from '@/lib/bot/flows/flow-localization';
import { invalidatePlatformOverridesCache } from '@/lib/bot/translations';
import { isSupportedLanguage } from '@/lib/bot/languages';

export const dynamic = 'force-dynamic';

/** Pattern for command tokens like *Book Now* */
const COMMAND_TOKEN_PATTERN = /\*[A-Za-z][A-Za-z ]*\*/g;

// ---------------------------------------------------------------------------
// Validation helpers (same rules as business translations route)
// ---------------------------------------------------------------------------

interface ValidatedOverride {
  lang: string;
  key: string;
  value: string;
}

interface ValidationResult {
  upserts: ValidatedOverride[];
  errors: string[];
}

function validateOverrides(
  overrides: Array<{ lang: string; key: string; value: string }>,
): ValidationResult {
  const errors: string[] = [];
  const upserts: ValidatedOverride[] = [];

  for (const override of overrides) {
    const trimmedValue = override.value?.trim();
    if (!trimmedValue) {
      errors.push(`Empty value for key ${override.key} (lang: ${override.lang})`);
      continue;
    }

    // Validate key exists in canonical corpus
    if (!ALL_FLOW_COPY_KEYS.includes(override.key)) {
      errors.push(`Unknown key: ${override.key}`);
      continue;
    }

    // Validate lang is a supported language
    if (!isSupportedLanguage(override.lang)) {
      errors.push(`Unsupported language: ${override.lang}`);
      continue;
    }

    // Validate WhatsApp button title length (max 20 chars)
    if (BUTTON_TITLE_KEYS.includes(override.key) && trimmedValue.length > 20) {
      errors.push(
        `${override.key}: button title exceeds 20 chars (${trimmedValue.length})`,
      );
      continue;
    }

    // Validate WhatsApp list title length (max 24 chars)
    if (LIST_TITLE_KEYS.includes(override.key) && trimmedValue.length > 24) {
      errors.push(
        `${override.key}: list title exceeds 24 chars (${trimmedValue.length})`,
      );
      continue;
    }

    // Validate placeholders: all required must be present, no unexpected ones
    const requiredPlaceholders = PLACEHOLDER_SCHEMA.get(override.key);
    if (requiredPlaceholders) {
      const foundPlaceholders = [...trimmedValue.matchAll(/\{(\w+)\}/g)].map(
        (m) => m[1],
      );
      let placeholderError = false;
      for (const required of requiredPlaceholders) {
        if (!foundPlaceholders.includes(required)) {
          errors.push(
            `${override.key}: missing required placeholder {${required}}`,
          );
          placeholderError = true;
        }
      }
      for (const found of foundPlaceholders) {
        if (!requiredPlaceholders.includes(found)) {
          errors.push(
            `${override.key}: unexpected placeholder {${found}}`,
          );
          placeholderError = true;
        }
      }
      if (placeholderError) continue;
    }

    // Validate command tokens preserved for keys that require them
    if (KEYS_WITH_COMMANDS.includes(override.key)) {
      const englishText = getFlowCopy('en', override.key);
      const englishCommands = [...englishText.matchAll(COMMAND_TOKEN_PATTERN)].map(
        (m) => m[0],
      );
      let commandError = false;
      for (const cmd of englishCommands) {
        if (!trimmedValue.includes(cmd)) {
          errors.push(
            `${override.key}: must preserve command token ${cmd}`,
          );
          commandError = true;
        }
      }
      if (commandError) continue;
    }

    upserts.push({ lang: override.lang, key: override.key, value: trimmedValue });
  }

  return { upserts, errors };
}

function getRequestIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  );
}

// ---------------------------------------------------------------------------
// GET /api/admin/translations — list all platform overrides
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const supabase = createServiceClient();

  const { data: overrides, error } = await supabase
    .from('bot_translation_platform_overrides')
    .select('id, lang, key, value, updated_by, updated_at')
    .order('lang')
    .order('key');

  if (error) {
    console.error('[ADMIN_TRANSLATIONS] GET failed:', error.message);
    return NextResponse.json(
      { error: 'Failed to load platform overrides' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    overrides: overrides || [],
    allKeys: ALL_FLOW_COPY_KEYS,
  });
}

// ---------------------------------------------------------------------------
// PUT /api/admin/translations — upsert platform overrides
// ---------------------------------------------------------------------------

/**
 * Body: { overrides: Array<{ lang: string; key: string; value: string }> }
 */
export async function PUT(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawOverrides = body.overrides;
  if (!Array.isArray(rawOverrides) || rawOverrides.length === 0) {
    return NextResponse.json(
      { error: 'overrides[] must be a non-empty array' },
      { status: 400 },
    );
  }

  // Validate
  const { upserts, errors } = validateOverrides(
    rawOverrides as Array<{ lang: string; key: string; value: string }>,
  );

  if (errors.length > 0) {
    return NextResponse.json(
      { error: 'Validation failed', errors },
      { status: 400 },
    );
  }

  if (upserts.length === 0) {
    return NextResponse.json(
      { error: 'No valid overrides to save' },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const rows = upserts.map((u) => ({
    lang: u.lang,
    key: u.key,
    value: u.value,
    updated_by: admin.userId,
    updated_at: now,
  }));

  const { error: upsertError } = await supabase
    .from('bot_translation_platform_overrides')
    .upsert(rows, { onConflict: 'lang,key' });

  if (upsertError) {
    console.error('[ADMIN_TRANSLATIONS] PUT failed:', upsertError.message);
    return NextResponse.json(
      { error: 'Failed to save platform overrides', detail: upsertError.message },
      { status: 500 },
    );
  }

  // Invalidate platform overrides cache so running bot instances pick up changes
  invalidatePlatformOverridesCache();

  // Audit log
  const { error: auditError } = await logAdminAudit({
    actorId: admin.userId,
    action: 'upsert_platform_translation_overrides',
    entityType: 'platform_translations',
    details: {
      count: upserts.length,
      keys: upserts.map((u) => `${u.lang}.${u.key}`),
    },
    ipAddress: getRequestIp(request),
  });
  if (auditError) {
    console.error('[ADMIN_TRANSLATIONS] Audit log failed for PUT:', auditError);
    // Overrides saved successfully — don't fail the request over audit
  }

  return NextResponse.json({ success: true, upserted: upserts.length });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/translations — remove specific platform override(s)
// ---------------------------------------------------------------------------

/**
 * Body: { keys: Array<{ lang: string; key: string }> }
 * OR:   { lang: string; key: string }  (single delete convenience)
 */
export async function DELETE(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Support single-delete { lang, key } or batch { keys: [{ lang, key }] }
  let targets: Array<{ lang: string; key: string }>;
  if (Array.isArray(body.keys)) {
    targets = body.keys as Array<{ lang: string; key: string }>;
  } else if (typeof body.lang === 'string' && typeof body.key === 'string') {
    targets = [{ lang: body.lang, key: body.key }];
  } else {
    return NextResponse.json(
      { error: 'Provide { lang, key } or { keys: [{ lang, key }] }' },
      { status: 400 },
    );
  }

  if (targets.length === 0) {
    return NextResponse.json({ error: 'No targets specified' }, { status: 400 });
  }

  // Validate each target's lang/key
  const errors: string[] = [];
  for (const t of targets) {
    if (!t.lang || !t.key) {
      errors.push('Each target must have lang and key');
    }
  }
  if (errors.length > 0) {
    return NextResponse.json({ error: 'Validation failed', errors }, { status: 400 });
  }

  const supabase = createServiceClient();
  let deleted = 0;

  for (const t of targets) {
    const { error: delError, count } = await supabase
      .from('bot_translation_platform_overrides')
      .delete({ count: 'exact' })
      .eq('lang', t.lang)
      .eq('key', t.key);

    if (delError) {
      console.error(
        `[ADMIN_TRANSLATIONS] DELETE failed for ${t.lang}.${t.key}:`,
        delError.message,
      );
      // Continue deleting remaining — partial success is acceptable
    } else {
      deleted += count ?? 0;
    }
  }

  // Invalidate platform overrides cache
  invalidatePlatformOverridesCache();

  // Audit log
  const { error: auditError } = await logAdminAudit({
    actorId: admin.userId,
    action: 'delete_platform_translation_overrides',
    entityType: 'platform_translations',
    details: {
      targets: targets.map((t) => `${t.lang}.${t.key}`),
      deleted,
    },
    ipAddress: getRequestIp(request),
  });
  if (auditError) {
    console.error('[ADMIN_TRANSLATIONS] Audit log failed for DELETE:', auditError);
  }

  return NextResponse.json({ success: true, deleted });
}
