import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { getCurrencyCode, type CountryCode } from '@/lib/constants';
import { checkTierLimit } from '@/lib/tier-limits';
import { logger } from '@/lib/logger';

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

    // ── Field-level validation ──
    const vErrors: Record<string, string> = {};

    if (!business_id || typeof business_id !== 'string') {
      vErrors.business_id = 'Business ID is required';
    } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(business_id)) {
      vErrors.business_id = 'Business ID must be a valid UUID';
    }
    if (!customer_name || typeof customer_name !== 'string' || !customer_name.trim()) {
      vErrors.customer_name = 'Customer name is required';
    } else if (customer_name.trim().length > 200) {
      vErrors.customer_name = 'Customer name must be 200 characters or less';
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      vErrors.items = 'At least one line item is required';
    } else if (items.length > 200) {
      vErrors.items = 'Maximum 200 line items per invoice';
    } else {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || typeof item !== 'object') {
          vErrors[`items[${i}]`] = 'Item must be an object';
          continue;
        }
        if (!item.description || typeof item.description !== 'string' || !item.description.trim()) {
          vErrors[`items[${i}].description`] = 'Description is required';
        } else if (item.description.trim().length > 2000) {
          vErrors[`items[${i}].description`] = 'Description must be 2000 characters or less';
        }
        if (item.quantity !== undefined && item.quantity !== null) {
          const qty = Number(item.quantity);
          if (isNaN(qty) || qty <= 0) {
            vErrors[`items[${i}].quantity`] = 'Quantity must be a positive number';
          }
        }
        if (item.unit_price !== undefined && item.unit_price !== null) {
          const up = Number(item.unit_price);
          if (isNaN(up) || up < 0) {
            vErrors[`items[${i}].unit_price`] = 'Unit price must be a non-negative number';
          }
        }
      }
    }
    if (due_date !== undefined && due_date !== null) {
      if (typeof due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due_date) || isNaN(new Date(due_date).getTime())) {
        vErrors.due_date = 'Due date must be a valid date (YYYY-MM-DD)';
      }
    }
    if (tax_rate !== undefined && tax_rate !== null) {
      const tr = Number(tax_rate);
      if (isNaN(tr) || tr < 0 || tr > 100) {
        vErrors.tax_rate = 'Tax rate must be between 0 and 100';
      }
    }
    if (discount_value !== undefined && discount_value !== null) {
      const dv = Number(discount_value);
      if (isNaN(dv) || dv < 0) {
        vErrors.discount_value = 'Discount value must be non-negative';
      }
      if (discount_type === 'percent' && dv > 100) {
        vErrors.discount_value = 'Percent discount cannot exceed 100%';
      }
    }

    if (is_recurring) {
      const validFreq = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
      if (recurring_frequency && !validFreq.includes(recurring_frequency)) {
        vErrors.recurring_frequency = `Must be one of: ${validFreq.join(', ')}`;
      }
    }

    if (Object.keys(vErrors).length > 0) {
      return NextResponse.json(
        { error: 'Validation failed', fields: vErrors },
        { status: 400 },
      );
    }

    const { data: ownedBusiness } = await supabase.from('businesses').select('id, subscription_tier').eq('id', business_id).eq('owner_id', user.id).maybeSingle();
    if (!ownedBusiness) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // ── Capability check: invoice ──
    const { data: invoiceCap } = await supabase
      .from('business_capabilities')
      .select('id')
      .eq('business_id', business_id)
      .eq('capability', 'invoice')
      .eq('is_enabled', true)
      .maybeSingle();
    if (!invoiceCap) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });

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

    if (totalAmount < 0) {
      return NextResponse.json({ error: 'Discount cannot exceed subtotal plus tax' }, { status: 400 });
    }

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

    // Create invoice + items atomically via RPC (single transaction).
    // If item insertion fails, the invoice is also rolled back — no orphaned records.
    const invoiceData = {
      business_id,
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
    };

    const itemRows = items.map((item: { description: string; quantity: number; unit_price: number }) => ({
      description: item.description,
      quantity: item.quantity || 1,
      unit_price: item.unit_price || 0,
      amount: Math.round((item.quantity || 1) * (item.unit_price || 0) * 100) / 100,
    }));

    // RPC is service-role-only (migration 264 revokes from authenticated)
    const serviceDb = createServiceClient();
    const { data: invoice, error } = await serviceDb.rpc('create_invoice_with_items', {
      p_invoice: invoiceData,
      p_items: itemRows,
    });

    if (error || !invoice) {
      logger.error('[INVOICES] Atomic creation failed:', error?.message);
      return NextResponse.json({ error: 'Failed to create invoice' }, { status: 500 });
    }

    return NextResponse.json(invoice, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
