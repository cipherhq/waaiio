import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

/**
 * Helper to get the reseller record for the current user.
 * Returns null if the user is not a reseller.
 */
async function getReseller(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data, error } = await supabase
    .from('resellers')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error('[RESELLER_ACCOUNTS] Reseller lookup error:', error.message);
    return null;
  }
  return data;
}

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const reseller = await getReseller(supabase, user.id);
    if (!reseller) return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });

    const { data: businesses, error, count } = await supabase
      .from('businesses')
      .select('id, name, category, status, subscription_tier, created_at, slug, country_code, email', { count: 'exact' })
      .eq('reseller_id', reseller.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[RESELLER_ACCOUNTS] List error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch sub-accounts' }, { status: 500 });
    }

    return NextResponse.json({ accounts: businesses || [], count: count ?? 0 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const reseller = await getReseller(supabase, user.id);
    if (!reseller) return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });

    if (reseller.status !== 'active') {
      return NextResponse.json({ error: 'Reseller account is suspended' }, { status: 403 });
    }

    // Check sub-account limit
    const { count: currentCount } = await supabase
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('reseller_id', reseller.id);

    if ((currentCount ?? 0) >= reseller.max_sub_accounts) {
      return NextResponse.json(
        { error: `Sub-account limit reached (${reseller.max_sub_accounts})` },
        { status: 400 },
      );
    }

    const body = await request.json();
    const { name, category, email, country_code, subscription_tier, phone, flow_type } = body as {
      name: string;
      category: string;
      email: string;
      country_code: string;
      subscription_tier?: string;
      phone?: string;
      flow_type?: string;
    };

    if (!name || !category || !email || !country_code) {
      return NextResponse.json(
        { error: 'Missing required fields: name, category, email, country_code' },
        { status: 400 },
      );
    }

    // Default flow_type to 'booking' — the most common type
    const resolvedFlowType = flow_type || 'booking';
    const resolvedTier = subscription_tier || 'free';

    // Generate a slug from name
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);

    const { data: business, error: createError } = await supabase
      .from('businesses')
      .insert({
        name,
        category,
        email,
        country_code,
        subscription_tier: resolvedTier,
        phone: phone || null,
        flow_type: resolvedFlowType,
        reseller_id: reseller.id,
        owner_id: user.id,
        slug,
        status: 'active',
      })
      .select()
      .single();

    if (createError) {
      if (createError.code === '23505') {
        return NextResponse.json({ error: 'A business with this slug already exists' }, { status: 409 });
      }
      logger.error('[RESELLER_ACCOUNTS] Create error:', createError.message);
      return NextResponse.json({ error: 'Failed to create sub-account' }, { status: 500 });
    }

    return NextResponse.json({ business }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
