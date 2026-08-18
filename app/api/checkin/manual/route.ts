import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * POST /api/checkin/manual
 * Authenticated — business owner manually adds an attendance entry.
 * Uses service client for insert (attendance_log has no INSERT policy for authenticated).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { business_id, customer_name, customer_phone, customer_email, notes } = body;

    // Input validation — mirrors public check-in route
    const trimmedName = customer_name?.trim() || '';
    if (!business_id || !trimmedName) {
      return NextResponse.json({ error: 'business_id and customer_name are required' }, { status: 400 });
    }
    if (trimmedName.length > 200) {
      return NextResponse.json({ error: 'Name must be 200 characters or less' }, { status: 400 });
    }
    const cleanPhone = customer_phone ? String(customer_phone).replace(/\D/g, '') : '';
    if (cleanPhone && (cleanPhone.length < 7 || cleanPhone.length > 20)) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
    }
    const trimmedEmail = customer_email?.trim() || '';
    if (trimmedEmail && (trimmedEmail.length > 320 || !trimmedEmail.includes('@'))) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }
    const trimmedNotes = notes?.trim() || '';
    if (trimmedNotes.length > 2000) {
      return NextResponse.json({ error: 'Notes must be 2000 characters or less' }, { status: 400 });
    }

    // Verify business ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Insert via service client (attendance_log has no INSERT policy for authenticated)
    const service = createServiceClient();
    const { error: insertError } = await service
      .from('attendance_log')
      .insert({
        business_id,
        customer_name: trimmedName,
        customer_phone: cleanPhone || null,
        customer_email: trimmedEmail || null,
        notes: trimmedNotes || null,
        source: 'manual',
      });

    if (insertError) {
      logger.error('[CHECKIN/MANUAL] Insert error:', insertError.message);
      return NextResponse.json({ error: 'Failed to record check-in' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[CHECKIN/MANUAL] POST error:', err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
