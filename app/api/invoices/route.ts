import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrencyCode, type CountryCode } from '@/lib/constants';

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

    const { data: ownedBusiness } = await supabase.from('businesses').select('id').eq('id', business_id).eq('owner_id', user.id).maybeSingle();
    if (!ownedBusiness) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Compute financials server-side
    const subtotal = items.reduce((sum: number, item: { quantity: number; unit_price: number }) =>
      sum + (item.quantity || 1) * (item.unit_price || 0), 0);

    const taxRate = tax_rate || 0;
    const taxAmount = Math.round(subtotal * taxRate / 100 * 100) / 100;

    let discountAmount = 0;
    if (discount_type === 'percent' && discount_value) {
      discountAmount = Math.round(subtotal * discount_value / 100 * 100) / 100;
    } else if (discount_type === 'flat' && discount_value) {
      discountAmount = discount_value;
    }

    const totalAmount = Math.round((subtotal + taxAmount - discountAmount) * 100) / 100;

    // Resolve default currency from business country if not provided
    let resolvedCurrency = currency;
    if (!resolvedCurrency) {
      const { data: biz } = await supabase
        .from('businesses')
        .select('country_code')
        .eq('id', business_id)
        .single();
      resolvedCurrency = getCurrencyCode((biz?.country_code || 'NG') as CountryCode);
    }

    const { data: invoice, error } = await supabase
      .from('invoices')
      .insert({
        business_id,
        customer_profile_id: customer_profile_id || null,
        customer_name,
        customer_phone: customer_phone || null,
        customer_email: customer_email || null,
        customer_address: customer_address || null,
        subtotal,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        discount_type: discount_type || null,
        discount_value: discount_value || 0,
        discount_amount: discountAmount,
        total_amount: totalAmount,
        currency: resolvedCurrency,
        issue_date: issue_date || new Date().toISOString().split('T')[0],
        due_date: due_date || null,
        notes: notes || null,
        terms: terms || null,
        status: 'draft',
        is_recurring: is_recurring || false,
        recurring_frequency: is_recurring ? (recurring_frequency || 'monthly') : null,
        recurring_next_date: is_recurring ? (recurring_next_date || due_date || null) : null,
        recurring_end_date: is_recurring && recurring_end_date ? recurring_end_date : null,
      })
      .select('id, reference_code')
      .single();

    if (error || !invoice) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Insert line items
    const itemRows = items.map((item: { description: string; quantity: number; unit_price: number }, i: number) => ({
      invoice_id: invoice.id,
      description: item.description,
      quantity: item.quantity || 1,
      unit_price: item.unit_price || 0,
      amount: Math.round((item.quantity || 1) * (item.unit_price || 0) * 100) / 100,
      sort_order: i,
    }));

    await supabase.from('invoice_items').insert(itemRows);

    return NextResponse.json(invoice, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
