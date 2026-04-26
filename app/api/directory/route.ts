import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/directory?country=US&category=barber&search=cuts
 *
 * Public API for the business directory.
 * Returns active businesses with their services and capabilities.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const country = searchParams.get('country');
  const category = searchParams.get('category');
  const search = searchParams.get('search');

  const supabase = createServiceClient();

  let query = supabase
    .from('businesses')
    .select(`
      id, name, category, country_code, city, address, bot_code, wa_method, slug,
      services:services(id, name, price, duration_minutes)
    `)
    .eq('status', 'active')
    .order('name', { ascending: true })
    .limit(100);

  if (country) query = query.eq('country_code', country);
  if (category) query = query.eq('category', category);
  if (search) query = query.ilike('name', `%${search}%`);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: 'Failed to load directory' }, { status: 500 });
  }

  // Get capabilities for each business
  const businessIds = (data || []).map(b => b.id);
  const { data: capRows } = await supabase
    .from('business_capabilities')
    .select('business_id, capability')
    .in('business_id', businessIds)
    .eq('is_enabled', true);

  const capMap = new Map<string, string[]>();
  for (const row of (capRows || [])) {
    const existing = capMap.get(row.business_id) || [];
    existing.push(row.capability);
    capMap.set(row.business_id, existing);
  }

  const businesses = (data || []).map(b => ({
    ...b,
    capabilities: capMap.get(b.id) || [],
  }));

  return NextResponse.json({ businesses });
}
