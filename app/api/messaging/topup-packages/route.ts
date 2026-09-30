import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

interface TopUpPackage {
  amount_minor: number;
  label: string;
  description?: string;
}

/**
 * GET /api/messaging/topup-packages
 *
 * Returns available messaging credit top-up packages for the authenticated
 * user's business. Resolves packages from canonical versioned commercial config
 * using the business's country → currency authority.
 *
 * Query params:
 *   business_id (required) — the business to resolve packages for
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const businessId = request.nextUrl.searchParams.get('business_id');
    if (!businessId) {
      return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });
    }

    // Verify ownership via RLS
    const { data: business } = await supabase
      .from('businesses')
      .select('id, owner_id, country_code')
      .eq('id', businessId)
      .single();

    if (!business || business.owner_id !== user.id) {
      return NextResponse.json({ error: 'Business not found or not owned by you' }, { status: 403 });
    }

    if (!business.country_code) {
      return NextResponse.json({ error: 'Business country not configured' }, { status: 400 });
    }

    // Resolve currency from country
    const service = createServiceClient();
    const { data: countryRow } = await service
      .from('countries')
      .select('currency_code')
      .eq('code', business.country_code)
      .eq('is_active', true)
      .single();

    if (!countryRow?.currency_code) {
      return NextResponse.json({ error: 'Currency not available for this region' }, { status: 503 });
    }

    const currency = countryRow.currency_code as string;

    // Resolve packages from canonical config
    const { data: configRow } = await service
      .from('platform_settings')
      .select('value')
      .eq('key', 'messaging_topup_packages')
      .single();

    if (!configRow?.value) {
      return NextResponse.json({
        packages: [],
        currency,
        message: 'Top-up packages are not yet configured for this region.',
      });
    }

    const allPackages = configRow.value as Record<string, TopUpPackage[]>;
    const currencyPackages = allPackages[currency] || [];

    return NextResponse.json({
      packages: currencyPackages,
      currency,
      business_id: businessId,
    });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
