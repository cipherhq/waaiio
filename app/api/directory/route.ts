import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { searchMarketplace } from '@/lib/marketplace/search';

/**
 * GET /api/directory?country=US&category=barber&search=cuts
 *
 * Public API for the business directory.
 * Uses the unified marketplace search engine for filtering & ranking,
 * then enriches results with services, capabilities, events, and WhatsApp info.
 * Respects admin-configured featured/hidden lists from platform_settings.
 */
export async function GET(request: NextRequest) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'directory'), 60, 60_000);
  if (rateLimit) return rateLimit;
  const { searchParams } = new URL(request.url);
  const country = searchParams.get('country');
  const category = searchParams.get('category');
  const search = searchParams.get('search');

  const supabase = createServiceClient();

  // Step 1: Use unified marketplace search for filtering & ranking
  const results = await searchMarketplace(supabase, {
    category: category || undefined,
    query: search || undefined,
    country: country || undefined,
    limit: 50,
  });

  if (results.length === 0) {
    const response = NextResponse.json({ businesses: [] });
    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    return response;
  }

  const businessIds = results.map(r => r.businessId);

  // Step 2: Fetch directory settings + enrichment data in parallel
  const [
    { data: settingsData },
    { data: capRows },
    { data: serviceRows },
  ] = await Promise.all([
    supabase
      .from('platform_settings')
      .select('key, value')
      .in('key', ['directory_hidden', 'directory_featured']),
    supabase
      .from('business_capabilities')
      .select('business_id, capability')
      .in('business_id', businessIds)
      .eq('is_enabled', true),
    supabase
      .from('services')
      .select('id, name, price, duration_minutes, business_id')
      .in('business_id', businessIds),
  ]);

  // Apply directory visibility settings (featured/hidden)
  const settingsMap = new Map((settingsData || []).map(s => [s.key, s.value]));
  const hiddenIds = (settingsMap.get('directory_hidden') as string[]) || [];
  const featuredIds = (settingsMap.get('directory_featured') as string[]) || [];

  // Filter hidden, then sort: featured first, then by search rank
  const visible = results.filter(r => !hiddenIds.includes(r.businessId));
  const featured = visible.filter(r => featuredIds.includes(r.businessId));
  const rest = visible.filter(r => !featuredIds.includes(r.businessId));
  const sorted = [...featured, ...rest];

  // Build capability map
  const capMap = new Map<string, string[]>();
  for (const row of (capRows || [])) {
    const existing = capMap.get(row.business_id) || [];
    existing.push(row.capability);
    capMap.set(row.business_id, existing);
  }

  // Build service map
  const serviceMap = new Map<string, Array<{ id: string; name: string; price: number; duration_minutes: number }>>();
  for (const row of (serviceRows || [])) {
    const existing = serviceMap.get(row.business_id) || [];
    existing.push({ id: row.id, name: row.name, price: row.price, duration_minutes: row.duration_minutes });
    serviceMap.set(row.business_id, existing);
  }

  // Step 3: Fetch events for ticketing businesses
  const ticketingBizIds = sorted
    .filter(r => (capMap.get(r.businessId) || []).includes('ticketing'))
    .map(r => r.businessId);

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

  // Step 4: Fetch WhatsApp phone numbers for dedicated/transfer/coexist businesses
  // We need wa_method which is not in MarketplaceResult, so fetch from DB
  const { data: waMethodRows } = await supabase
    .from('businesses')
    .select('id, wa_method')
    .in('id', businessIds)
    .in('wa_method', ['dedicated', 'transfer', 'coexist']);

  const dedicatedBizIds = (waMethodRows || []).map(r => r.id);
  const waPhoneMap = new Map<string, string>();
  if (dedicatedBizIds.length > 0) {
    const { data: channels } = await supabase
      .from('whatsapp_channels')
      .select('business_id, phone_number')
      .in('business_id', dedicatedBizIds)
      .eq('is_active', true);

    for (const ch of (channels || [])) {
      if (ch.phone_number) waPhoneMap.set(ch.business_id, ch.phone_number);
    }
  }

  // Build wa_method map for the response
  const waMethodMap = new Map<string, string>();
  for (const row of (waMethodRows || [])) {
    waMethodMap.set(row.id, row.wa_method);
  }

  // Step 5: Compose enriched response
  const businesses = sorted.map(r => ({
    id: r.businessId,
    name: r.name,
    category: r.category,
    country_code: r.countryCode || null,
    city: r.city || '',
    address: r.address || '',
    bot_code: r.botCode || '',
    wa_method: waMethodMap.get(r.businessId) || null,
    slug: r.slug || '',
    wa_phone: waPhoneMap.get(r.businessId) || null,
    services: serviceMap.get(r.businessId) || [],
    capabilities: capMap.get(r.businessId) || [],
    events: eventMap.get(r.businessId) || [],
    is_featured: featuredIds.includes(r.businessId),
    // Marketplace search enrichment
    shortDescription: r.shortDescription,
    isOpenNow: r.isOpenNow,
    priceBand: r.priceBand,
    supportsDelivery: r.supportsDelivery,
    matchReasons: r.matchReasons,
  }));

  const response = NextResponse.json({ businesses });
  response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  return response;
}
