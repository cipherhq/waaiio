import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/directory?country=US&category=barber&search=cuts
 *
 * Public API for the business directory.
 * Returns active businesses with their services and capabilities.
 * Respects admin-configured featured/hidden lists from platform_settings.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const country = searchParams.get('country');
  const category = searchParams.get('category');
  const search = searchParams.get('search');

  const supabase = createServiceClient();

  // Fetch businesses and directory settings in parallel
  let query = supabase
    .from('businesses')
    .select(`
      id, name, category, country_code, city, address, wa_method, slug,
      services:services(id, name, price, duration_minutes)
    `)
    .eq('status', 'active')
    .order('name', { ascending: true })
    .limit(100);

  if (country) query = query.eq('country_code', country);
  if (category) query = query.eq('category', category);
  if (search) {
    const safeSearch = search.replace(/[%_\\]/g, '\\$&');
    query = query.ilike('name', `%${safeSearch}%`);
  }

  const [{ data, error }, { data: settingsData }] = await Promise.all([
    query,
    supabase.from('platform_settings').select('key, value').in('key', ['directory_hidden', 'directory_featured']),
  ]);

  if (error) {
    return NextResponse.json({ error: 'Failed to load directory' }, { status: 500 });
  }

  // Apply directory visibility settings
  const settingsMap = new Map((settingsData || []).map(s => [s.key, s.value]));
  const hiddenIds = (settingsMap.get('directory_hidden') as string[]) || [];
  const featuredIds = (settingsMap.get('directory_featured') as string[]) || [];

  const visible = (data || []).filter(b => !hiddenIds.includes(b.id));
  const featured = visible.filter(b => featuredIds.includes(b.id));
  const rest = visible.filter(b => !featuredIds.includes(b.id));
  const sorted = [...featured, ...rest];

  // Get capabilities for visible businesses
  const businessIds = sorted.map(b => b.id);
  const { data: capRows } = businessIds.length > 0
    ? await supabase
        .from('business_capabilities')
        .select('business_id, capability')
        .in('business_id', businessIds)
        .eq('is_enabled', true)
    : { data: [] };

  const capMap = new Map<string, string[]>();
  for (const row of (capRows || [])) {
    const existing = capMap.get(row.business_id) || [];
    existing.push(row.capability);
    capMap.set(row.business_id, existing);
  }

  // Fetch published events for ticketing businesses
  const ticketingBizIds = sorted.filter(b => (capMap.get(b.id) || []).includes('ticketing')).map(b => b.id);
  const { data: eventRows } = ticketingBizIds.length > 0
    ? await supabase
        .from('events')
        .select('id, name, slug, date, business_id')
        .in('business_id', ticketingBizIds)
        .eq('status', 'published')
        .gte('date', new Date().toISOString().split('T')[0])
        .order('date', { ascending: true })
    : { data: [] };

  const eventMap = new Map<string, Array<{ id: string; name: string; slug: string; date: string }>>();
  for (const e of (eventRows || [])) {
    const existing = eventMap.get(e.business_id) || [];
    existing.push({ id: e.id, name: e.name, slug: e.slug, date: e.date });
    eventMap.set(e.business_id, existing);
  }

  const businesses = sorted.map(b => ({
    ...b,
    capabilities: capMap.get(b.id) || [],
    events: eventMap.get(b.id) || [],
    is_featured: featuredIds.includes(b.id),
  }));

  const response = NextResponse.json({ businesses });
  response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  return response;
}
