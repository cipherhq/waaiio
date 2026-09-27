import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

// This setting is controlled by Admin and must reflect changes without a redeploy.
// Prevent Next.js from prerendering/caching a stale announcement payload.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

/**
 * GET /api/site-announcement
 *
 * Public endpoint — returns the current site announcement config.
 * Fail-safe: any error returns { enabled: false } so the public site
 * is never broken by a config read failure.
 *
 * This is purely informational and has NO effect on WhatsApp,
 * payments, bookings, or any runtime capability.
 */
export async function GET() {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'site_announcement')
      .single();

    if (error || !data) {
      return NextResponse.json({ enabled: false }, { headers: NO_STORE_HEADERS });
    }

    const config = data.value as Record<string, unknown>;

    return NextResponse.json({
      enabled: !!config.enabled,
      type: config.type || 'general',
      headline: config.headline || '',
      message: config.message || '',
      target_date: config.target_date || null,
      cta_text: config.cta_text || null,
      cta_link: config.cta_link || null,
      style: config.style || 'brand',
    }, {
      headers: NO_STORE_HEADERS,
    });
  } catch {
    // Fail-safe: never take down the public site
    return NextResponse.json({ enabled: false }, { headers: NO_STORE_HEADERS });
  }
}
