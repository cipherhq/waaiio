import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

const VALID_TYPES = ['launch_countdown', 'maintenance_notice', 'general'] as const;
const VALID_STYLES = ['brand', 'warning', 'info'] as const;

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

  const body = await request.json();

  // Validate required fields
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
  }

  if (body.type && !VALID_TYPES.includes(body.type)) {
    return NextResponse.json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 });
  }

  if (body.style && !VALID_STYLES.includes(body.style)) {
    return NextResponse.json({ error: `style must be one of: ${VALID_STYLES.join(', ')}` }, { status: 400 });
  }

  // Validate CTA link if provided (must be relative or https)
  if (body.cta_link && typeof body.cta_link === 'string') {
    if (!body.cta_link.startsWith('/') && !body.cta_link.startsWith('https://')) {
      return NextResponse.json({ error: 'cta_link must start with / or https://' }, { status: 400 });
    }
    if (body.cta_link.startsWith('//')) {
      return NextResponse.json({ error: 'Invalid cta_link' }, { status: 400 });
    }
  }

  const config = {
    enabled: body.enabled,
    type: body.type || 'general',
    headline: (body.headline || '').slice(0, 200),
    message: (body.message || '').slice(0, 500),
    target_date: body.target_date || null,
    cta_text: body.cta_text ? String(body.cta_text).slice(0, 50) : null,
    cta_link: body.cta_link || null,
    style: body.style || 'brand',
  };

  const supabase = createServiceClient();
  const { error } = await supabase
    .from('platform_settings')
    .update({
      value: config,
      updated_by: admin.userId,
      updated_at: new Date().toISOString(),
    })
    .eq('key', 'site_announcement');

  if (error) {
    return NextResponse.json({ error: 'Failed to update announcement' }, { status: 500 });
  }

  return NextResponse.json({ success: true, config });
}
