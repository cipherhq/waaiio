import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/launch/regions
 *
 * Public endpoint — returns active shared Waaiio WhatsApp numbers
 * grouped by country. Used by the launch countdown page to show
 * the correct regional number without hard-coding.
 *
 * Reuses whatsapp_channels (shared, active) joined with countries
 * for display names and flags.
 */
export async function GET() {
  try {
    const supabase = createServiceClient();

    const [{ data: channels }, { data: countries }] = await Promise.all([
      supabase
        .from('whatsapp_channels')
        .select('phone_number, country_code')
        .eq('channel_type', 'shared')
        .eq('is_active', true)
        .order('country_code'),
      supabase
        .from('countries')
        .select('code, name, flag')
        .eq('is_active', true)
        .order('name'),
    ]);

    if (!channels || channels.length === 0) {
      return NextResponse.json({ regions: [] });
    }

    const countryMap = new Map((countries || []).map(c => [c.code, c]));

    // Group by country, pick one number per country (first active shared)
    const seen = new Map<string, { phone: string; code: string; name: string; flag: string }>();
    for (const ch of channels) {
      if (!seen.has(ch.country_code)) {
        const country = countryMap.get(ch.country_code);
        seen.set(ch.country_code, {
          phone: ch.phone_number,
          code: ch.country_code,
          name: country?.name || ch.country_code,
          flag: country?.flag || '',
        });
      }
    }

    return NextResponse.json(
      { regions: Array.from(seen.values()) },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  } catch {
    return NextResponse.json({ regions: [] });
  }
}
