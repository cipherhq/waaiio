import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/pay-link/[token] — Public endpoint, no auth.
 * Returns payment link details + business info for the public pay page.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  if (!token || token.length > 16) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('payment_links')
    .select(
      'id, title, amount, currency, description, is_active, business_id, uses_count, expires_at, max_uses, businesses!inner(name, logo_url, country_code, payment_gateway)',
    )
    .eq('token', token)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: 'Payment link not found' },
      { status: 404 },
    );
  }

  // Check expiry
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return NextResponse.json({ error: 'This payment link has expired' }, { status: 410 });
  }

  // Check max uses
  if (data.max_uses && (data.uses_count ?? 0) >= data.max_uses) {
    return NextResponse.json({ error: 'This payment link has reached its usage limit' }, { status: 410 });
  }

  const biz = data.businesses as unknown as {
    name: string;
    logo_url: string | null;
    country_code: string;
    payment_gateway: string;
  };

  return NextResponse.json({
    id: data.id,
    title: data.title,
    amount: data.amount,
    currency: data.currency,
    description: data.description,
    business_name: biz.name,
    logo_url: biz.logo_url,
    country_code: biz.country_code,
  });
}
