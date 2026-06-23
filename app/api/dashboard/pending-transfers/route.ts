import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * GET /api/dashboard/pending-transfers?business_id=xxx&status=pending
 * List pending transfers for a business (owner-only).
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const businessId = request.nextUrl.searchParams.get('business_id');
    if (!businessId) {
      return NextResponse.json({ error: 'business_id is required' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Business not found or access denied' }, { status: 403 });
    }

    const status = request.nextUrl.searchParams.get('status') || 'pending';
    const service = createServiceClient();

    let query = service
      .from('pending_transfers')
      .select(
        'id, customer_phone, customer_name, expected_amount, currency, reference_code, ' +
        'proof_type, proof_text, proof_image_url, status, expires_at, created_at, ' +
        'booking_id, order_id, invoice_id',
      )
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    const { data: transfers, error } = await query;

    if (error) {
      logger.error('[PENDING_TRANSFERS] GET error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch transfers' }, { status: 500 });
    }

    return NextResponse.json({ transfers: transfers || [] });
  } catch (err) {
    logger.error('[PENDING_TRANSFERS] GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
