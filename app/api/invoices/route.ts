import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkTierLimit } from '@/lib/tier-limits';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('business_id');
    const status = searchParams.get('status');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50') || 50, 200);

    if (!businessId) {
      return NextResponse.json({ error: 'business_id required' }, { status: 400 });
    }

    const { data: business } = await supabase.from('businesses').select('id').eq('id', businessId).eq('owner_id', user.id).maybeSingle();
    if (!business) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    let query = supabase
      .from('invoices')
      .select('*, invoice_items(*)', { count: 'exact' })
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, count, error } = await query;

    if (error) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ invoices: data || [], total: count || 0 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const {
      business_id, customer_name, customer_phone, customer_email, customer_address,
      customer_profile_id, items, tax_rate, discount_type, discount_value,
      due_date, notes, terms, currency, issue_date,
      is_recurring, recurring_frequency, recurring_next_date, recurring_end_date,
    } = body;

    if (!business_id || !customer_name || !items?.length) {
      return NextResponse.json({ error: 'business_id, customer_name, and items are required' }, { status: 400 });
    }

    const { data: ownedBusiness } = await supabase.from('businesses').select('id, subscription_tier').eq('id', business_id).eq('owner_id', user.id).maybeSingle();
    if (!ownedBusiness) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // ── Tier limit check for invoices ──
    const tierResult = await checkTierLimit(
      supabase,
      business_id,
      'invoices',
      ownedBusiness.subscription_tier || 'free',
    );
    if (!tierResult.allowed) {
      return NextResponse.json(
        { error: `You've reached your monthly invoice limit (${tierResult.limit}). Upgrade your plan to create more invoices.` },
        { status: 429 },
      );
    }

    const { data: invoice, error } = await supabase.rpc('save_invoice_tax_980', {
      p_business_id: business_id, p_invoice_id: null, p_body: body,
    });
    if (error || !invoice) {
      return NextResponse.json({ error: 'Unable to save invoice. Check line prices, tax settings and discounts.' }, { status: 400 });
    }
    return NextResponse.json(invoice, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
