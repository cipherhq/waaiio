import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/messaging/topup-history?business_id=...
 *
 * Returns the last 20 messaging credit top-up purchases for a business.
 * Authenticated via RLS — only the business owner can read their purchases.
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

    // RLS enforces ownership — mtp_owner_select policy checks businesses.owner_id = auth.uid()
    const { data: purchases, error } = await supabase
      .from('messaging_topup_purchases')
      .select('id, package_amount_minor, currency_code, gateway, status, created_at, completed_at, refunded_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch purchase history' }, { status: 500 });
    }

    return NextResponse.json({ purchases: purchases || [] });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
