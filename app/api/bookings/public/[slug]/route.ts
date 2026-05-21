import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/bookings/public/[slug]
 * Fetch business info + active services by business slug.
 * Public endpoint — no auth required. Cached for 30s.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;

    if (!slug || typeof slug !== 'string') {
      return NextResponse.json({ error: 'Invalid slug' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Fetch business by slug
    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .select('id, name, slug, logo_url, description, address, operating_hours, country_code, metadata')
      .eq('slug', slug)
      .single();

    if (bizError || !business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Fetch active services for this business
    const { data: services } = await supabase
      .from('services')
      .select('id, name, description, price, deposit_amount, duration_minutes, buffer_minutes, max_capacity, image_url, metadata')
      .eq('business_id', business.id)
      .eq('is_active', true)
      .order('sort_order');

    const response = NextResponse.json({
      business: {
        id: business.id,
        name: business.name,
        slug: business.slug,
        logo_url: business.logo_url,
        description: business.description,
        address: business.address,
        operating_hours: business.operating_hours,
        country_code: business.country_code,
      },
      services: (services || []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        price: s.price,
        deposit_amount: s.deposit_amount,
        duration_minutes: s.duration_minutes,
        buffer_minutes: s.buffer_minutes,
        max_capacity: s.max_capacity,
        image_url: s.image_url,
        is_dropoff: (s.metadata as Record<string, unknown>)?.is_dropoff === true,
      })),
    });

    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    return response;
  } catch {
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
