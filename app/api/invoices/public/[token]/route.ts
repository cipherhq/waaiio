import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { PRICING_TIERS, type SubscriptionTier } from '@/lib/constants';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const rl = rateLimitResponse(getRateLimitKey(_request, 'public-invoice'), 30, 60_000);
  if (rl) return rl;

  try {
    const { token } = await params;
    const supabase = createServiceClient();

    const { data: invoice } = await supabase
      .from('invoices')
      .select(`
        id, reference_code, customer_name, customer_phone, customer_email, customer_address,
        status, subtotal, tax_rate, tax_amount, discount_type, discount_value, discount_amount,
        total_amount, amount_paid, currency, issue_date, due_date, notes, terms,
        paid_at, created_at, business_id,
        invoice_items(id, description, quantity, unit_price, amount, sort_order)
      `)
      .eq('token', token)
      .single();

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    // Check token expiry
    if ((invoice as Record<string, unknown>).token_expires_at) {
      const expiresAt = new Date((invoice as Record<string, unknown>).token_expires_at as string);
      if (expiresAt < new Date()) {
        return NextResponse.json({ error: 'This invoice link has expired' }, { status: 410 });
      }
    }

    // Fetch business name + tier (no sensitive data)
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, logo_url, subscription_tier')
      .eq('id', invoice.business_id)
      .single();

    // Mark as viewed on first view
    if (invoice.status === 'sent') {
      await supabase
        .from('invoices')
        .update({ status: 'viewed', viewed_at: new Date().toISOString() })
        .eq('id', invoice.id)
        .eq('status', 'sent');
    }

    // Sort items by sort_order
    const items = (invoice.invoice_items || []).sort(
      (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
    );

    return NextResponse.json({
      id: invoice.id,
      reference_code: invoice.reference_code,
      customer_name: invoice.customer_name,
      customer_email: invoice.customer_email,
      customer_address: invoice.customer_address,
      status: invoice.status === 'sent' ? 'viewed' : invoice.status, // reflect the update we just made
      subtotal: invoice.subtotal,
      tax_rate: invoice.tax_rate,
      tax_amount: invoice.tax_amount,
      discount_type: invoice.discount_type,
      discount_value: invoice.discount_value,
      discount_amount: invoice.discount_amount,
      total_amount: invoice.total_amount,
      amount_paid: invoice.amount_paid,
      currency: invoice.currency,
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      notes: invoice.notes,
      terms: invoice.terms,
      paid_at: invoice.paid_at,
      business_name: biz?.name || '',
      logo_url: biz?.logo_url || null,
      show_logo: (biz?.subscription_tier || 'free') !== 'free',
      whitelabel: PRICING_TIERS[(biz?.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true,
      items,
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
