import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import {
  EMPTY_SITE_ANNOUNCEMENT,
  validateSiteAnnouncementConfig,
  type SiteAnnouncementConfig,
  type SiteAnnouncementStyle,
  type SiteAnnouncementType,
} from '@/shared/site-announcement';

export const dynamic = 'force-dynamic';

function optionalString(value: unknown, field: string): { value: string | null; error?: string } {
  if (value === null || value === undefined || value === '') return { value: null };
  if (typeof value !== 'string') return { value: null, error: `${field} must be a string` };
  return { value };
}

function requiredString(value: unknown, field: string): { value: string; error?: string } {
  if (value === undefined || value === null) return { value: '' };
  if (typeof value !== 'string') return { value: '', error: `${field} must be a string` };
  return { value };
}

function parseConfig(body: Record<string, unknown>): { config?: SiteAnnouncementConfig; error?: string } {
  if (typeof body.enabled !== 'boolean') {
    return { error: 'enabled must be a boolean' };
  }

  const headline = requiredString(body.headline, 'headline');
  if (headline.error) return { error: headline.error };

  const message = requiredString(body.message, 'message');
  if (message.error) return { error: message.error };

  const target = optionalString(body.target_date, 'target_date');
  if (target.error) return { error: target.error };

  const ctaText = optionalString(body.cta_text, 'cta_text');
  if (ctaText.error) return { error: ctaText.error };

  const ctaLink = optionalString(body.cta_link, 'cta_link');
  if (ctaLink.error) return { error: ctaLink.error };

  const config: SiteAnnouncementConfig = {
    ...EMPTY_SITE_ANNOUNCEMENT,
    enabled: body.enabled,
    type: (body.type || 'general') as SiteAnnouncementType,
    headline: headline.value,
    message: message.value,
    target_date: target.value,
    cta_text: ctaText.value,
    cta_link: ctaLink.value,
    style: (body.style || 'brand') as SiteAnnouncementStyle,
  };

  const errors = validateSiteAnnouncementConfig(config);
  if (errors.length > 0) {
    return { error: errors[0] };
  }

  return { config };
}

/**
 * GET /api/admin/site-announcement
 * Admin-only: read current announcement config.
 */
export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('platform_settings')
    .select('value, updated_at')
    .eq('key', 'site_announcement')
    .single();

  if (error || !data) {
    return NextResponse.json({ config: { enabled: false }, updated_at: null });
  }

  return NextResponse.json({ config: data.value, updated_at: data.updated_at });
}

/**
 * PUT /api/admin/site-announcement
 * Admin-only: update announcement config.
 *
 * This is purely informational — it does NOT disable WhatsApp,
 * payments, bookings, or any runtime capability. That is the
 * exclusive domain of the existing maintenance_mode setting.
 */
export async function PUT(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parseConfig(body);
  if (!parsed.config) {
    return NextResponse.json({ error: parsed.error || 'Invalid announcement config' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from('platform_settings')
    .update({
      value: parsed.config,
      updated_by: admin.userId,
      updated_at: new Date().toISOString(),
    })
    .eq('key', 'site_announcement');

  if (error) {
    return NextResponse.json({ error: 'Failed to update announcement' }, { status: 500 });
  }

  return NextResponse.json({ success: true, config: parsed.config });
}
